import path from 'node:path';
import { type DocFrontmatter, type ParsedDoc } from './types.js';
import { KbStore, dedupeTags } from './store.js';
import {
  SECTION_DETAILS,
  SECTION_RELATED,
  ensureSection,
  mergeBullets,
  serializeDoc,
} from './markdown.js';
import { collapseWhitespace, isoDate, slugify, truncate } from './text.js';
import { readIfExists, sizeOf } from './fsx.js';

/**
 * Reference pages: live, recallable companions that hold the long form.
 *
 * A wiki page earns its value by staying short — a page you have to scroll is a
 * page nobody re-reads. But the long explanation is often the valuable part
 * (the reproduction, the log excerpt, the three failed attempts). Hermes solves
 * this by demoting detail into a skill's `references/` folder; the skill stays a
 * one-screen procedure and the evidence stays one hop away.
 *
 * Same move here, with one difference that matters: `_archive/` is *history*
 * (never searched, never updated again), while `references/` is *live* — it is
 * indexed, it is recalled, and it keeps growing. Archiving a detail would make
 * it unfindable; demoting it keeps it in the index.
 */

export const REFERENCES_DIR = 'references';

/** Reference page path for a source page, flattened like `_archive/`. */
export function referencePathFor(relPath: string): string {
  const flat = relPath.replace(/\.md$/i, '').replace(/\//g, '__');
  return `${REFERENCES_DIR}/${flat}.md`;
}

/** Markdown link target from one wiki page to another. */
export function relativeLink(fromRel: string, toRel: string): string {
  const fromDir = path.posix.dirname(fromRel);
  return path.posix.relative(fromDir === '.' ? '' : fromDir, toRel);
}

export interface DemoteResult {
  page: string;
  reference: string;
  linesMoved: number;
  bytesBefore: number;
  bytesAfter: number;
  created: boolean;
}

export interface DemoteOptions {
  /**
   * Only demote when the details section is at least this many characters. Below
   * it, a separate page costs more (an extra read) than it saves.
   */
  minDetailChars?: number;
  /** Force demotion even when the page is small. */
  force?: boolean;
}

export const DEFAULT_DEMOTE: Required<Omit<DemoteOptions, 'force'>> = {
  minDetailChars: 800,
};

/**
 * Move a page's `## 细节` body into a reference page, leaving a link behind.
 *
 * Rules:
 *  - conclusions are never moved — that is the whole point of the split
 *  - content moves verbatim, so nothing is lost or re-worded
 *  - demoting the same page again appends to its existing reference page
 *  - the pointer is a real markdown link, so `kb doctor` catches a broken one
 */
export function demoteDetails(
  store: KbStore,
  relPath: string,
  opts: DemoteOptions = {},
): DemoteResult | null {
  const cfg = { ...DEFAULT_DEMOTE, ...opts };
  const doc = store.read(relPath);
  if (!doc) return null;

  const section = doc.sections.find((s) => s.heading === SECTION_DETAILS);
  if (!section) return null;

  const body = section.lines.filter((l) => l.trim() !== '');
  const bodyChars = body.join('\n').length;
  if (bodyChars === 0) return null;
  // A pointer line from a previous demotion is not new content.
  const alreadyDemoted = body.length <= 2 && body.some((l) => l.includes(REFERENCES_DIR));
  if (alreadyDemoted) return null;
  if (!opts.force && bodyChars < cfg.minDetailChars) return null;

  // Keep a couple of plain lines inline so the reader knows what is behind the
  // link; evidence bullets are useless without their context.
  const keptInline = body.filter((l) => !l.trim().startsWith('-')).slice(0, 2);
  const moved = body.filter((l) => !keptInline.includes(l));

  const refPath = referencePathFor(relPath);
  const exists = store.exists(refPath);
  const refDoc = exists ? store.read(refPath) : null;

  const target: ParsedDoc = refDoc ?? {
    frontmatter: {
      id: slugify(refPath.replace(/\.md$/i, '')),
      title: `详细记录：${doc.frontmatter.title}`,
      summary: truncate(`\`${relPath}\` 的详细记录：原始记录、复现步骤与证据。`, 200),
      tags: ['reference'],
      level: store.depthOf(refPath),
      parent: REFERENCES_DIR,
      created: isoDate(),
      updated: isoDate(),
      revision: 1,
      confidence: doc.frontmatter.confidence,
      derivedFrom: relPath,
    },
    titleLine: `# 详细记录：${doc.frontmatter.title}`,
    preamble: [
      `从 \`${relPath}\` 降级下来的详细内容。与 \`_archive/\` 不同，这是一份**活文档**：会被检索、会继续追加。`,
    ],
    sections: [{ heading: '内容', depth: 2, lines: [] }],
  };

  const content = ensureSection(target, '内容');
  const bytesBefore = store.bytesOf(relPath);
  content.lines.push(...moved);
  target.frontmatter.updated = isoDate();
  target.frontmatter.revision += 1;
  store.write(refPath, target);
  refreshReferenceSummary(store, refPath);

  const link = relativeLink(relPath, refPath);
  section.lines = [
    ...keptInline,
    `- 详细记录（${moved.length} 行）见 [\`${refPath}\`](${link})`,
  ];
  const related = ensureSection(doc, SECTION_RELATED);
  mergeBullets(related, [`- [详细记录：${doc.frontmatter.title}](${link})`]);
  doc.frontmatter.updated = isoDate();
  doc.frontmatter.revision += 1;
  store.write(relPath, doc, { touch: false });

  store.syncFolderIndex(REFERENCES_DIR);
  const parentDir = path.posix.dirname(relPath);
  store.syncFolderIndex(parentDir === '.' ? '' : parentDir);

  return {
    page: relPath,
    reference: refPath,
    linesMoved: moved.length,
    bytesBefore,
    bytesAfter: store.bytesOf(relPath),
    created: !exists,
  };
}

/** Pages whose details section is big enough to be worth splitting out. */
export function findDetailHeavyPages(
  store: KbStore,
  opts: DemoteOptions = {},
): Array<{ page: string; detailChars: number; bytes: number }> {
  const cfg = { ...DEFAULT_DEMOTE, ...opts };
  const out: Array<{ page: string; detailChars: number; bytes: number }> = [];
  const memoryPrefix = store.memoryRelDir();

  for (const rel of store.scan().files) {
    if (rel === 'index.md' || rel.endsWith('/index.md')) continue;
    if (rel.startsWith(`${REFERENCES_DIR}/`)) continue;
    if (rel.startsWith('_archive/')) continue;
    if (memoryPrefix !== '' && rel.startsWith(`${memoryPrefix}/`)) continue;

    const doc = store.read(rel);
    if (!doc) continue;
    const section = doc.sections.find((s) => s.heading === SECTION_DETAILS);
    if (!section) continue;
    const chars = section.lines.join('\n').length;
    if (chars < cfg.minDetailChars) continue;
    out.push({ page: rel, detailChars: chars, bytes: store.bytesOf(rel) });
  }
  return out.sort((a, b) => b.detailChars - a.detailChars);
}

/** Every reference page, with its source and whether the link is dead. */
export function auditReferences(
  store: KbStore,
): Array<{ reference: string; source: string | null; orphan: boolean }> {
  const out: Array<{ reference: string; source: string | null; orphan: boolean }> = [];
  for (const rel of store.scan().files) {
    if (!rel.startsWith(`${REFERENCES_DIR}/`)) continue;
    if (rel === `${REFERENCES_DIR}/index.md`) continue;
    const doc = store.read(rel);
    // `derivedFrom` is authoritative; scanning links is only a fallback for pages
    // written before the field existed.
    const source = doc?.frontmatter.derivedFrom ?? findSourceByLink(store, rel);
    out.push({
      reference: rel,
      source,
      orphan: source === null || !store.exists(source),
    });
  }
  return out;
}

function findSourceByLink(store: KbStore, refRel: string): string | null {
  for (const candidate of store.scan().files) {
    if (candidate.startsWith(`${REFERENCES_DIR}/`) || candidate.startsWith('_archive/')) continue;
    if (!candidate.endsWith('.md') || candidate.endsWith('/index.md')) continue;
    const raw = readIfExists(store.abs(candidate));
    if (raw === null) continue;
    if (raw.includes(relativeLink(candidate, refRel))) return candidate;
  }
  return null;
}

/**
 * Give a reference page a summary so recall can match it without reading it.
 *
 * Long-form bodies are often all bullets (a checklist, a log), so the fallback
 * chain is: first plain line → first heading → first bullet → keep the generic
 * summary. A reference page with a stale summary is invisible to recall, which
 * defeats the purpose of keeping it in the index at all.
 */
export function refreshReferenceSummary(store: KbStore, refRel: string): void {
  const doc = store.read(refRel);
  if (!doc) return;
  const content = doc.sections.find((s) => s.heading === '内容');
  if (!content) return;

  const plain = content.lines.find((l) => {
    const t = l.trim();
    return t !== '' && !t.startsWith('#') && !t.startsWith('-');
  });
  const bullet = content.lines.find((l) => l.trim().startsWith('-'));
  const heading = content.lines.find((l) => /^#{3,6}\s/.test(l.trim()));

  const excerpt = plain ?? heading ?? bullet;
  if (!excerpt) return;

  const clean = collapseWhitespace(excerpt.replace(/^[-*+]\s+/, '').replace(/^#{3,6}\s+/, ''));
  if (clean === '') return;
  const title = doc.frontmatter.title.replace(/^详细记录：/, '');
  doc.frontmatter.summary = truncate(`${title}｜${clean}`, 200);
  doc.frontmatter.updated = isoDate();
  store.write(refRel, doc, { touch: false });
}

export function referenceFrontmatter(
  title: string,
  level: number,
  confidence: DocFrontmatter['confidence'],
): DocFrontmatter {
  return {
    id: slugify(title),
    title,
    summary: '',
    tags: dedupeTags(['reference']),
    level,
    parent: REFERENCES_DIR,
    created: isoDate(),
    updated: isoDate(),
    revision: 1,
    confidence,
  };
}

/** Serialised size of a page, used by callers that budget by bytes. */
export function bodySize(doc: ParsedDoc): number {
  return sizeOf(serializeDoc(doc));
}
