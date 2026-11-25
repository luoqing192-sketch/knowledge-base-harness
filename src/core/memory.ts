import path from 'node:path';
import {
  type DocFrontmatter,
  type MemoryOp,
  type MemoryResult,
  type MemoryTarget,
  type ParsedDoc,
} from './types.js';
import { KbStore } from './store.js';
import { ensureSection, serializeDoc, bulletText } from './markdown.js';
import {
  collapseWhitespace,
  isoDate,
  normalizeForCompare,
  slugify,
  stripDecisionPrefix,
  truncate,
} from './text.js';
import { resolveMemoryDir } from './config.js';

/**
 * Two-tier memory, modelled on how Hermes splits always-on memory from
 * on-demand skills.
 *
 * `memory/MEMORY.md` and `memory/USER.md` are small, hand-curated pages that are
 * injected into **every** prompt. Because they cost tokens on every turn they
 * have a hard character budget, and a write that would exceed it is refused
 * outright — the caller must free space in the same batch (Hermes does exactly
 * this; see `tools/memory_tool.py`).
 *
 * Nothing else about the wiki changes: these are still markdown pages inside the
 * tree, so they are versioned, diffable and lint-checked like everything else.
 * They are simply excluded from lexical recall because they are already present
 * in context.
 */

export const MEMORY_FILE = 'MEMORY.md';
export const USER_FILE = 'USER.md';
export const MEMORY_INDEX = 'index.md';

export const DEFAULT_MEMORY_LIMIT = 4000;
export const DEFAULT_USER_LIMIT = 2000;

export interface MemoryEntry {
  /** `## heading` this bullet lives under; '' for the preamble. */
  section: string;
  text: string;
}

export interface MemoryView {
  target: MemoryTarget;
  entries: MemoryEntry[];
  used: number;
  limit: number;
  relativePath: string;
}

export class MemoryStore {
  private readonly dir: string;

  constructor(private readonly store: KbStore) {
    this.dir = resolveMemoryDir(store.cfg);
  }

  get directory(): string {
    return this.dir;
  }

  relPath(target: MemoryTarget): string {
    return path.posix.join(
      path.relative(this.store.cfg.kbRoot, this.dir).split(path.sep).join('/'),
      target === 'user' ? USER_FILE : MEMORY_FILE,
    );
  }

  limitFor(target: MemoryTarget): number {
    return target === 'user'
      ? (this.store.cfg.userCharLimit ?? DEFAULT_USER_LIMIT)
      : (this.store.cfg.memoryCharLimit ?? DEFAULT_MEMORY_LIMIT);
  }

  /** Create the memory folder, its two pages and its index (idempotent). */
  ensureLayout(): void {
    const dirRel = path.relative(this.store.cfg.kbRoot, this.dir).split(path.sep).join('/');
    for (const target of ['memory', 'user'] as const) {
      const rel = this.relPath(target);
      if (this.store.exists(rel)) continue;
      this.store.write(
        rel,
        {
          frontmatter: this.frontmatterFor(target),
          titleLine: `# ${target === 'user' ? 'User profile' : 'Agent memory'}`,
          preamble: [
            target === 'user'
              ? 'Who the user is: role, global preferences, how they like to be talked to.'
              : 'Durable facts about this project and environment that apply to every session.',
            'Injected into every prompt — keep it small. Task procedures belong in a skill page, not here.',
          ],
          sections: [],
        },
        { touch: false },
      );
    }
    // The index keeps the folder a valid wiki folder (lint requires one).
    const indexRel = path.posix.join(dirRel, MEMORY_INDEX);
    if (!this.store.exists(indexRel)) {
      this.store.write(
        indexRel,
        {
          frontmatter: {
            id: 'memory',
            title: 'Memory',
            summary: 'Always-injected memory. Not searched — it is already in every prompt.',
            tags: ['memory', 'index'],
            level: this.store.depthOf(indexRel),
            parent: path.posix.basename(path.posix.dirname(indexRel)) === '.'
              ? '-'
              : slugify(path.posix.basename(path.posix.dirname(indexRel))),
            created: isoDate(),
            updated: isoDate(),
            revision: 1,
            confidence: 'high',
          },
          titleLine: '# Memory',
          preamble: [
            '`MEMORY.md` and `USER.md` are injected into every prompt. Everything else in this wiki is searched on demand.',
          ],
          sections: [
            {
              heading: '子页面',
              depth: 2,
              lines: [`- [${MEMORY_FILE}](${MEMORY_FILE})`, `- [${USER_FILE}](${USER_FILE})`],
            },
          ],
        },
        { touch: false },
      );
    }
  }

  private frontmatterFor(target: MemoryTarget): DocFrontmatter {
    return {
      id: target === 'user' ? 'user-memory' : 'agent-memory',
      title: target === 'user' ? 'User profile' : 'Agent memory',
      summary:
        target === 'user'
          ? 'Identity, role and global preferences of the user.'
          : 'Durable project and environment facts.',
      tags: ['memory'],
      level: this.store.depthOf(this.relPath(target)),
      parent: 'memory',
      created: isoDate(),
      updated: isoDate(),
      revision: 1,
      confidence: 'high',
    };
  }

  read(target: MemoryTarget): MemoryView {
    const rel = this.relPath(target);
    const doc = this.store.read(rel);
    const limit = this.limitFor(target);
    if (!doc) return { target, entries: [], used: 0, limit, relativePath: rel };
    return {
      target,
      entries: entriesOf(doc),
      used: bodyLength(doc),
      limit,
      relativePath: rel,
    };
  }

  /** Render both stores for prompt injection. */
  renderForPrompt(): string {
    const blocks: string[] = [];
    for (const target of ['user', 'memory'] as const) {
      const view = this.read(target);
      if (view.entries.length === 0) continue;
      const title = target === 'user' ? 'User profile' : 'Agent memory';
      blocks.push(`### ${title} (${view.used}/${view.limit} chars)`);
      for (const entry of view.entries) {
        blocks.push(`- ${entry.text}`);
      }
    }
    if (blocks.length === 0) return '';
    return ['## Long-term memory (always injected)', ...blocks].join('\n');
  }

  /** How full the stores are — used for the "nearly full" nudge. */
  usage(): { memory: MemoryView; user: MemoryView; pressure: number } {
    const memory = this.read('memory');
    const user = this.read('user');
    const pressure = Math.max(
      memory.limit > 0 ? memory.used / memory.limit : 0,
      user.limit > 0 ? user.used / user.limit : 0,
    );
    return { memory, user, pressure };
  }

  /**
   * Apply a batch of operations atomically.
   *
   * The whole batch is validated against the final size, so "free space then
   * add" works in one call — which is the only way to grow a full store.
   */
  apply(target: MemoryTarget, ops: MemoryOp[]): MemoryResult {
    const rel = this.relPath(target);
    const limit = this.limitFor(target);
    const doc = this.store.read(rel);
    if (!doc) {
      return {
        ok: false,
        target,
        used: 0,
        limit,
        entries: [],
        applied: 0,
        error: `memory page missing: ${rel} (run kb init)`,
      };
    }

    const original = serializeDoc(doc);
    const working = cloneDoc(doc);
    let applied = 0;

    for (const op of ops) {
      const result = applyOp(working, op);
      if (!result.ok) {
        return {
          ok: false,
          target,
          used: bodyLength(originalDoc(doc)),
          limit,
          entries: entriesOf(doc),
          applied,
          error: result.error,
        };
      }
      applied++;
    }

    const used = bodyLength(working);
    if (used > limit) {
      return {
        ok: false,
        target,
        used,
        limit,
        entries: entriesOf(working),
        applied,
        error: `over budget: ${used} > ${limit} chars. Remove or shorten entries in the same batch.`,
      };
    }

    const next = serializeDoc(working);
    if (next !== original) {
      working.frontmatter.updated = isoDate();
      working.frontmatter.revision += 1;
      this.store.write(rel, working, { touch: false });
    }
    return { ok: true, target, used, limit, entries: entriesOf(working), applied };
  }
}

interface OpResult {
  ok: boolean;
  error?: string;
}

function applyOp(doc: ParsedDoc, op: MemoryOp): OpResult {
  const action = op.action;

  if (action === 'add') {
    const content = collapseWhitespace(op.content ?? '');
    if (content === '') return { ok: false, error: 'add requires content' };
    const sectionName = op.section?.trim() || deriveSection(content);
    const section = ensureSection(doc, sectionName);
    const bullet = `- ${stripDecisionPrefix(content)}`;
    const duplicate = section.lines.some(
      (l) => l.trim().startsWith('-') && normalizeForCompare(bulletText(l)) === normalizeForCompare(stripDecisionPrefix(content)),
    );
    if (duplicate) return { ok: true }; // idempotent: same fact twice is not an error
    section.lines.push(bullet);
    return { ok: true };
  }

  if (action === 'patch') {
    const content = collapseWhitespace(op.content ?? '');
    const oldText = op.old_text ?? '';
    if (content === '' || oldText === '') return { ok: false, error: 'patch requires old_text and content' };
    const hits = locate(doc, oldText);
    if (hits.length === 0) return { ok: false, error: `old_text not found: ${truncate(oldText, 60)}` };
    if (hits.length > 1) {
      return {
        ok: false,
        error: `old_text matches ${hits.length} entries; make it more specific: ${truncate(oldText, 60)}`,
      };
    }
    const hit = hits[0]!;
    const line = hit.section.lines[hit.index]!;
    hit.section.lines[hit.index] = line.replace(oldText, content);
    return { ok: true };
  }

  if (action === 'remove') {
    const oldText = op.old_text ?? '';
    if (oldText === '') return { ok: false, error: 'remove requires old_text' };
    const hits = locate(doc, oldText);
    if (hits.length === 0) return { ok: false, error: `old_text not found: ${truncate(oldText, 60)}` };
    if (hits.length > 1) {
      return { ok: false, error: `old_text matches ${hits.length} entries; make it more specific` };
    }
    const hit = hits[0]!;
    hit.section.lines.splice(hit.index, 1);
    if (hit.section.lines.every((l) => l.trim() === '')) {
      doc.sections = doc.sections.filter((s) => s !== hit.section);
    }
    return { ok: true };
  }

  return { ok: false, error: `unknown action: ${String(action)}` };
}

function locate(doc: ParsedDoc, needle: string): Array<{ section: ParsedDoc['sections'][number]; index: number }> {
  const target = normalizeForCompare(needle);
  const hits: Array<{ section: ParsedDoc['sections'][number]; index: number }> = [];
  for (const section of doc.sections) {
    for (let i = 0; i < section.lines.length; i++) {
      const line = section.lines[i]!;
      const text = line.trim().startsWith('-') ? bulletText(line) : line;
      const hay = normalizeForCompare(text);
      if (hay.includes(target)) hits.push({ section, index: i });
    }
  }
  return hits;
}

function entriesOf(doc: ParsedDoc): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const section of doc.sections) {
    for (const line of section.lines) {
      if (!line.trim().startsWith('-')) continue;
      out.push({ section: section.heading, text: bulletText(line) });
    }
  }
  return out;
}

/**
 * Character budget covers the body only: front matter is bookkeeping and
 * should not compete with facts for room.
 */
function bodyLength(doc: ParsedDoc): number {
  let n = (doc.titleLine ?? '').length;
  n += doc.preamble.join('\n').length;
  for (const s of doc.sections) {
    n += s.heading.length + 2;
    n += s.lines.join('\n').length;
  }
  return n;
}

function originalDoc(doc: ParsedDoc): ParsedDoc {
  return doc;
}

function cloneDoc(doc: ParsedDoc): ParsedDoc {
  return {
    frontmatter: { ...doc.frontmatter, tags: [...doc.frontmatter.tags] },
    titleLine: doc.titleLine,
    preamble: [...doc.preamble],
    sections: doc.sections.map((s) => ({ heading: s.heading, depth: s.depth, lines: [...s.lines] })),
  };
}

/**
 * Pick a section for an added entry.
 *
 * Memory is small and read by a human, so sections should be few and stable
 * rather than one per sentence. These keyword buckets cover what actually shows
 * up (identity, how to talk to the user, environment quirks, conventions), and
 * anything unmatched falls into a single `其他` bucket instead of inventing a
 * new heading each time.
 */
const BUCKETS: Array<{ section: string; re: RegExp }> = [
  { section: '身份', re: /(开发者|工程师|架构师|岗位|角色|负责|我是|用户是|team|role|develop)/i },
  { section: '偏好', re: /(偏好|喜欢|希望|倾向|prefer|rather|like)/i },
  { section: '沟通', re: /(中文|英文|回复|沟通|语气|简洁|详细|concise|verbose|reply|language)/i },
  { section: '环境', re: /(端口|路径|目录|jdk|java|node|docker|wsl|环境|安装|配置|path|port|version|install)/i },
  { section: '约定', re: /(约定|规范|必须|禁止|统一|convention|always|never|must)/i },
  { section: '工具', re: /(命令|脚本|cli|工具|plugin|skill|mcp|tool)/i },
  { section: '教训', re: /(踩坑|坑|注意|教训|不要|冒烟|pitfall|gotcha|caveat)/i },
];

function deriveSection(content: string): string {
  const text = collapseWhitespace(stripDecisionPrefix(content));
  for (const bucket of BUCKETS) {
    if (bucket.re.test(text)) return bucket.section;
  }
  return '其他';
}
