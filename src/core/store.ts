import fs from 'node:fs';
import path from 'node:path';
import {
  type DocMeta,
  type ParsedDoc,
} from './types.js';
import { KbConfig, dataPaths } from './config.js';
import {
  ensureDir,
  isInside,
  listDir,
  moveFile,
  readIfExists,
  sizeOf,
  statOrNull,
  toPosix,
  walkFiles,
  writeAtomic,
} from './fsx.js';
import { parseDoc, serializeDoc, SECTION_CONCLUSIONS, ensureSection, mergeBullets, sortSections } from './markdown.js';
import { collapseWhitespace, isoDate, slugify, truncate } from './text.js';

export interface IndexEntry {
  path: string;
  mtimeMs: number;
  size: number;
  meta: DocMeta;
}

export interface KbIndex {
  version: 1;
  builtAt: string;
  root: string;
  entries: Record<string, IndexEntry>;
}

const INDEX_VERSION = 1;

export class KbStore {
  readonly cfg: KbConfig;
  readonly paths: ReturnType<typeof dataPaths>;

  constructor(cfg: KbConfig) {
    this.cfg = cfg;
    this.paths = dataPaths(cfg);
  }

  /** Absolute path for a KB-relative page path (posix style). */
  abs(relPath: string): string {
    const clean = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
    const abs = path.resolve(this.cfg.kbRoot, clean);
    if (!isInside(this.cfg.kbRoot, abs) && abs !== path.resolve(this.cfg.kbRoot)) {
      throw new Error(`kb: path escapes the knowledge root: ${relPath}`);
    }
    return abs;
  }

  rel(absPath: string): string {
    return toPosix(path.relative(this.cfg.kbRoot, absPath));
  }

  /** KB-relative path of the always-injected memory folder, or '' if outside. */
  memoryRelDir(): string {
    const dir = this.cfg.memoryDir;
    if (!dir) return '';
    const rel = toPosix(path.relative(this.cfg.kbRoot, dir));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return '';
    return rel === '.' ? '' : rel;
  }

  exists(relPath: string): boolean {
    return statOrNull(this.abs(relPath))?.isFile() === true;
  }

  read(relPath: string): ParsedDoc | null {
    const raw = readIfExists(this.abs(relPath));
    if (raw === null) return null;
    return parseDoc(raw, { relPath });
  }

  /** Raw markdown of a page, or null when it does not exist. */
  raw(relPath: string): string | null {
    return readIfExists(this.abs(relPath));
  }

  write(relPath: string, doc: ParsedDoc, opts: { touch?: boolean } = {}): void {
    if (opts.touch !== false) {
      doc.frontmatter.updated = isoDate();
    }
    doc.frontmatter.level = this.depthOf(relPath);
    doc.frontmatter.id = doc.frontmatter.id || slugify(relPath.replace(/\.md$/i, ''));
    sortSections(doc);
    const text = serializeDoc(doc);
    writeAtomic(this.abs(relPath), text, path.join(this.cfg.dataDir, 'tmp'));
  }

  depthOf(relPath: string): number {
    const segs = relPath.split('/').filter(Boolean);
    return segs.length <= 1 ? 0 : segs.length - 1;
  }

  /** Create the KB skeleton (root index) when missing. */
  ensureLayout(): void {
    ensureDir(this.cfg.kbRoot);
    ensureDir(this.cfg.dataDir);
    ensureDir(path.join(this.cfg.dataDir, 'tmp'));
    ensureDir(this.paths.sessionsDir);
    ensureDir(this.paths.stateDir);
    ensureDir(this.paths.quarantineDir);
    if (!this.exists('index.md')) {
      this.write(
        'index.md',
        {
          frontmatter: {
            id: 'index',
            title: 'Knowledge Base',
            summary: 'Wiki root. Every folder below is a topic area; each page states conclusions only.',
            tags: ['wiki'],
            level: 0,
            parent: '-',
            created: isoDate(),
            updated: isoDate(),
            revision: 1,
            confidence: 'high',
          },
          titleLine: '# Knowledge Base',
          preamble: [
            'Personal knowledge base maintained by knowlege-base-harness. Structure is strictly hierarchical:',
            'each folder holds an `index.md` linking its children, and leaf pages hold settled conclusions only.',
          ],
          sections: [],
        },
        { touch: false },
      );
    }
  }

  // ---------------------------------------------------------------- scanning

  /** Scan every .md file under the KB root and detect illegal entries. */
  scan(): { files: string[]; illegal: string[] } {
    const files: string[] = [];
    const illegal: string[] = [];
    const root = this.cfg.kbRoot;
    if (!statOrNull(root)?.isDirectory()) return { files, illegal };
    for (const abs of walkFiles(root, { skipHidden: true })) {
      const rel = toPosix(path.relative(root, abs));
      if (!rel.toLowerCase().endsWith('.md')) {
        illegal.push(rel);
        continue;
      }
      files.push(rel);
    }
    return { files, illegal };
  }

  /** Load or rebuild the index, re-parsing only files whose mtime/size changed. */
  loadIndex(force = false): KbIndex {
    const { files } = this.scan();
    const cached = force ? null : this.readIndexCache();
    const entries: Record<string, IndexEntry> = {};
    let dirty = cached === null;

    if (cached) {
      for (const [rel, entry] of Object.entries(cached.entries)) {
        if (!files.includes(rel)) {
          dirty = true;
          continue;
        }
        entries[rel] = entry;
      }
    }

    for (const rel of files) {
      const st = statOrNull(this.abs(rel));
      if (!st) continue;
      const prev = entries[rel];
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue;
      const doc = this.read(rel);
      if (!doc) continue;
      entries[rel] = {
        path: rel,
        mtimeMs: st.mtimeMs,
        size: st.size,
        meta: this.toMeta(rel, this.abs(rel), doc, st.size),
      };
      dirty = true;
    }

    const index: KbIndex = {
      version: INDEX_VERSION,
      builtAt: new Date().toISOString(),
      root: this.cfg.kbRoot,
      entries,
    };
    if (dirty || !cached) this.writeIndexCache(index);
    return index;
  }

  private toMeta(rel: string, abs: string, doc: ParsedDoc, size: number): DocMeta {
    const headings = doc.sections.map((s) => s.heading);
    const text = [
      doc.frontmatter.title,
      doc.frontmatter.summary,
      doc.frontmatter.tags.join(' '),
      doc.preamble.join('\n'),
      ...doc.sections.map((s) => `## ${s.heading}\n${s.lines.join('\n')}`),
    ].join('\n');
    return {
      path: rel,
      absolute: abs,
      frontmatter: doc.frontmatter,
      headings,
      text,
      sizeBytes: size,
      mtimeMs: statOrNull(abs)?.mtimeMs ?? 0,
    };
  }

  private readIndexCache(): KbIndex | null {
    const raw = readIfExists(this.paths.indexFile);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as KbIndex;
      if (parsed.version !== INDEX_VERSION || parsed.root !== this.cfg.kbRoot) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private writeIndexCache(index: KbIndex): void {
    writeAtomic(this.paths.indexFile, JSON.stringify(index), path.join(this.cfg.dataDir, 'tmp'));
  }

  // ------------------------------------------------------------- guardrails

  /**
   * Move anything that is not a markdown page out of the knowledge folder and
   * into the quarantine directory. Returns the moved paths.
   */
  quarantineIllegal(): string[] {
    const { illegal } = this.scan();
    const moved: string[] = [];
    for (const rel of illegal) {
      const from = this.abs(rel);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const to = path.join(this.paths.quarantineDir, `${stamp}__${rel.replace(/[/\\]/g, '_')}`);
      moveFile(from, to);
      moved.push(rel);
    }
    return moved;
  }

  /** Remove directories under the KB root that hold no markdown at all. */
  pruneEmptyDirs(): string[] {
    const removed: string[] = [];
    const visit = (dir: string): boolean => {
      let keeps = false;
      for (const entry of listDir(dir)) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const childKept = visit(abs);
          if (childKept) keeps = true;
          else {
            try {
              fs.rmdirSync(abs);
              removed.push(this.rel(abs));
            } catch {
              keeps = true;
            }
          }
        } else {
          keeps = true;
        }
      }
      return keeps;
    };
    if (statOrNull(this.cfg.kbRoot)?.isDirectory()) visit(this.cfg.kbRoot);
    return removed;
  }

  // ------------------------------------------------------------------ pages

  /** Find the best page for a topic, or nothing. */
  resolvePage(hint: string): string | null {
    const direct = hint.endsWith('.md') ? hint : `${hint}.md`;
    if (this.exists(direct)) return direct;
    const slugged = `${slugify(hint)}.md`;
    if (this.exists(slugged)) return slugged;
    const sluggedIdx = `${slugify(hint)}/index.md`;
    if (this.exists(sluggedIdx)) return sluggedIdx;
    return null;
  }

  /** Ensure a folder has an index.md linking to its children. */
  syncFolderIndex(dirRel: string): void {
    const dirAbs = dirRel === '' ? this.cfg.kbRoot : this.abs(dirRel);
    if (!statOrNull(dirAbs)?.isDirectory()) return;
    const indexPath = dirRel === '' ? 'index.md' : `${dirRel}/index.md`;
    const children = listDir(dirAbs)
      .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'index.md')
      .map((e) => e.name.replace(/\.md$/i, ''))
      .sort();
    const folders = listDir(dirAbs)
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();

    const existing = this.read(indexPath);
    const isNew = existing === null;
    const doc: ParsedDoc = existing ?? {
      frontmatter: {
        id: dirRel === '' ? 'index' : slugify(dirRel),
        title: dirRel === '' ? 'Knowledge Base' : (dirRel.split('/').pop() ?? dirRel),
        summary: 'Folder index.',
        tags: ['index'],
        level: this.depthOf(indexPath),
        parent: dirRel === '' ? '-' : slugify(dirRel.split('/').slice(0, -1).join('/') || '-'),
        created: isoDate(),
        updated: isoDate(),
        revision: 1,
        confidence: 'high',
      },
      titleLine: `# ${dirRel === '' ? 'Knowledge Base' : (dirRel.split('/').pop() ?? dirRel)}`,
      preamble: [],
      sections: [],
    };

    const lines: string[] = [];
    for (const f of folders) {
      lines.push(`- [${f}](${encodeURIComponent(f)}/index.md)`);
    }
    for (const c of children) {
      lines.push(`- [${c}](${encodeURIComponent(c)}.md)`);
    }
    const section = ensureSection(doc, '子页面');
    section.lines = lines.length > 0 ? lines : ['_暂无子页面_'];

    if (isNew) {
      this.write(indexPath, doc, { touch: false });
    } else {
      const before = serializeDoc(doc);
      const prev = readIfExists(this.abs(indexPath));
      if (prev !== before) this.write(indexPath, doc);
    }
  }

  /** Rebuild the folder index of a page's parent. */
  syncParentIndex(relPath: string): void {
    const segs = relPath.split('/').filter(Boolean);
    const parentDir = segs.slice(0, -1).join('/');
    this.syncFolderIndex(parentDir);
  }

  /**
   * Create one leaf page for a topic, linked from its parent index.
   * Never overwrites an existing page.
   */
  createPage(
    title: string,
    summary: string,
    tags: string[],
    opts: { parentDir?: string; explicitName?: string } = {},
  ): string {
    const parentDir = (opts.parentDir ?? '').replace(/^\/|\/$/g, '');
    const maxDirSegs = Math.max(0, this.cfg.maxDepth);
    const dirSegs = parentDir === '' ? [] : parentDir.split('/');
    if (dirSegs.length > maxDirSegs) {
      throw new Error(`kb: refusing to create ${parentDir}: deeper than maxDepth=${maxDirSegs}`);
    }
    const baseSlug = opts.explicitName ?? slugify(title);
    let slug = baseSlug || `page-${Date.now().toString(36)}`;
    let rel = parentDir === '' ? `${slug}.md` : `${parentDir}/${slug}.md`;
    let n = 1;
    while (this.exists(rel)) {
      if (opts.explicitName) throw new Error(`kb: page already exists: ${rel}`);
      n++;
      slug = `${baseSlug}-${n}`;
      rel = parentDir === '' ? `${slug}.md` : `${parentDir}/${slug}.md`;
    }
    const doc: ParsedDoc = {
      frontmatter: {
        id: slug,
        title: truncate(collapseWhitespace(title), 100),
        summary: truncate(collapseWhitespace(summary), 200),
        tags: dedupeTags(tags),
        level: this.depthOf(rel),
        parent: parentDir === '' ? '-' : slugify(parentDir.split('/').pop()!),
        created: isoDate(),
        updated: isoDate(),
        revision: 1,
        confidence: 'medium',
      },
      titleLine: `# ${truncate(collapseWhitespace(title), 100)}`,
      preamble: summary ? [collapseWhitespace(summary)] : [],
      sections: [
        { heading: SECTION_CONCLUSIONS, depth: 2, lines: [] },
      ],
    };
    this.write(rel, doc, { touch: false });
    this.syncParentIndex(rel);
    return rel;
  }

  /** Append bullets to the Conclusions section, deduping existing lines. */
  appendConclusions(relPath: string, bullets: string[]): { added: number; merged: number } {
    const doc = this.read(relPath);
    if (!doc) throw new Error(`kb: page does not exist: ${relPath}`);
    const section = ensureSection(doc, SECTION_CONCLUSIONS);
    const result = mergeBullets(section, bullets);
    if (result.added > 0) {
      doc.frontmatter.revision += 1;
      this.write(relPath, doc);
    }
    return result;
  }

  bytesOf(relPath: string): number {
    const raw = readIfExists(this.abs(relPath));
    return raw === null ? 0 : sizeOf(raw);
  }
}

export function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const clean = t.trim().toLowerCase();
    if (clean === '' || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}
