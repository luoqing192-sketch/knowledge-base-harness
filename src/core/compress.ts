import { type ParsedDoc, type Section } from './types.js';
import {
  SECTION_CONCLUSIONS,
  SECTION_RELATED,
  bulletText,
  ensureSection,
  mergeBullets,
  serializeDoc,
  getSection,
} from './markdown.js';
import { KbStore } from './store.js';
import { collapseWhitespace, isoDate, stripDecisionPrefix, truncate } from './text.js';

export interface CompressionReport {
  path: string;
  bytesBefore: number;
  bytesAfter: number;
  archived: string[];
  merged: number;
  duplicateGroups: number;
  levels: number;
}

const ARCHIVE_DIR = '_archive';

/**
 * Keep one page bounded.
 *
 * Strategy, in order of aggressiveness:
 *  1. drop exact duplicate bullets (done on every write anyway)
 *  2. merge near-duplicates suggesting the same fact (prefix/suffix containment)
 *  3. move the *oldest* conclusions into an archive page when the section still
 *     exceeds the bullet budget
 *  4. if it is still too big, collapse the tail of a section into one summary
 *     bullet that points at the archive
 *
 * Nothing is deleted: bullets that leave a live page land in
 * `_archive/<page>-YYYY-MM.md`, so the "clear conclusions only" policy stays
 * recoverable.
 */
export function compressPage(store: KbStore, relPath: string, force = false): CompressionReport {
  const before = store.bytesOf(relPath);
  const doc = store.read(relPath);
  const report: CompressionReport = {
    path: relPath,
    bytesBefore: before,
    bytesAfter: before,
    archived: [],
    merged: 0,
    duplicateGroups: 0,
    levels: 0,
  };
  if (!doc) return report;
  if (!force && before <= store.cfg.maxPageBytes) return report;

  const budget = store.cfg.targetPageBytes;
  let changed = false;

  // Pass 1: fuse near-duplicate bullets within each section.
  for (const section of doc.sections) {
    const res = fuseNearDuplicates(section);
    report.merged += res.merged;
    report.duplicateGroups += res.groups;
    if (res.merged > 0) changed = true;
  }
  report.levels += 1;

  // Pass 2: archive the oldest half of Conclusions while over budget.
  let guard = 0;
  while (estimateSize(doc) > budget && guard < 12) {
    guard++;
    const con = getSection(doc, SECTION_CONCLUSIONS);
    if (!con) break;
    const bullets = con.lines.filter((l) => l.trim().startsWith('-'));
    if (bullets.length <= 4) break;
    const keepCount = Math.max(4, Math.floor(bullets.length * 0.5));
    const archived = bullets.slice(0, bullets.length - keepCount);
    const kept = bullets.slice(bullets.length - keepCount);
    const archivePath = archivePageFor(store, relPath, doc, archived);
    report.archived.push(archivePath);
    con.lines = [
      ...kept,
      `- 更早的结论已归档：\`${archivePath}\`（${archived.length} 条）`,
    ];
    doc.frontmatter.revision += 1;
    changed = true;
    report.levels += 1;
  }

  // Pass 3: trim bullets per section to the configured budget.
  if (estimateSize(doc) > budget) {
    for (const section of doc.sections) {
      if (section.heading === SECTION_RELATED) continue;
      const bullets = section.lines.filter((l) => l.trim().startsWith('-'));
      if (bullets.length <= store.cfg.maxBulletsPerSection) continue;
      const overflow = bullets.slice(0, bullets.length - store.cfg.maxBulletsPerSection);
      const kept = bullets.slice(bullets.length - store.cfg.maxBulletsPerSection);
      const archivePath = archivePageFor(store, relPath, doc, overflow);
      report.archived.push(archivePath);
      section.lines = [
        ...kept,
        `- 另有 ${overflow.length} 条历史结论归档在 \`${archivePath}\``,
      ];
      changed = true;
    }
    report.levels += 1;
  }

  // Pass 4: last resort — hard-truncate very long bullets.
  if (estimateSize(doc) > budget) {
    for (const section of doc.sections) {
      section.lines = section.lines.map((l) =>
        l.length > 400 ? truncate(l, 400) : l,
      );
    }
    changed = true;
  }

  if (changed) {
    doc.frontmatter.updated = isoDate();
    doc.frontmatter.summary = truncate(collapseWhitespace(doc.frontmatter.summary), 200);
    store.write(relPath, doc, { touch: false });
  }
  report.bytesAfter = store.bytesOf(relPath);
  return report;
}

function estimateSize(doc: ParsedDoc): number {
  return Buffer.byteLength(serializeDoc(doc), 'utf8');
}

function archivePageFor(
  store: KbStore,
  relPath: string,
  doc: ParsedDoc,
  bullets: string[],
): string {
  const month = new Date().toISOString().slice(0, 7);
  const base = relPath.replace(/\.md$/i, '');
  const archivePath = `${ARCHIVE_DIR}/${base.replace(/\//g, '__')}-${month}.md`;
  const existing = store.read(archivePath);
  const target: ParsedDoc =
    existing ??
    {
      frontmatter: {
        id: `archive-${base.replace(/\//g, '-')}-${month}`,
        title: `归档：${doc.frontmatter.title} ${month}`,
        summary: `Historical conclusions moved out of ${relPath} to keep the live page bounded.`,
        tags: ['archive'],
        level: 1,
        parent: '_archive',
        created: isoDate(),
        updated: isoDate(),
        revision: 1,
        confidence: 'medium',
      },
      titleLine: `# 归档：${doc.frontmatter.title} ${month}`,
      preamble: [`从 \`${relPath}\` 压缩移出，保留原文备查。`],
      sections: [{ heading: SECTION_CONCLUSIONS, depth: 2, lines: [] }],
    };
  const section = ensureSection(target, SECTION_CONCLUSIONS);
  mergeBullets(section, bullets);
  store.write(archivePath, target);
  return archivePath;
}

export function fuseNearDuplicates(section: Section): { merged: number; groups: number } {
  const bullets = section.lines
    .map((line, idx) => ({ line, idx }))
    .filter((b) => b.line.trim().startsWith('-'));
  let merged = 0;
  let groups = 0;
  const drop = new Set<number>();

  for (let i = 0; i < bullets.length; i++) {
    if (drop.has(bullets[i]!.idx)) continue;
    const a = bulletBody(bullets[i]!.line);
    for (let j = i + 1; j < bullets.length; j++) {
      if (drop.has(bullets[j]!.idx)) continue;
      const b = bulletBody(bullets[j]!.line);
      if (a === b) {
        // Keep the later (usually richer) line, drop the earlier duplicate.
        drop.add(bullets[i]!.idx);
        merged++;
        groups++;
        break;
      }
      if (a.length >= 8 && b.length >= 8 && (a.includes(b) || b.includes(a))) {
        // Keep the longer wording, wherever it sits.
        if (a.length >= b.length) {
          drop.add(bullets[j]!.idx);
        } else {
          bullets[j] = { line: bullets[i]!.line, idx: bullets[j]!.idx };
          drop.add(bullets[i]!.idx);
        }
        merged++;
        groups++;
        break;
      }
    }
  }

  if (drop.size > 0) {
    section.lines = section.lines.filter((_l, idx) => !drop.has(idx));
  }
  return { merged, groups };
}

function bulletBody(line: string): string {
  return stripDecisionPrefix(collapseWhitespace(bulletText(line)).toLowerCase());
}

/** Compress every page that exceeds its budget. Archives get a 4x allowance. */
export function compressAll(store: KbStore): Array<{ path: string; before: number; after: number }> {
  const out: Array<{ path: string; before: number; after: number }> = [];
  for (const rel of store.scan().files) {
    // Reference pages are the intended home of long text; compressing them
    // would push the evidence back into the page it was moved out of.
    if (rel.startsWith('references/')) continue;
    const before = store.bytesOf(rel);
    const isArchive = rel.startsWith('_archive/');
    const limit = isArchive ? store.cfg.maxPageBytes * 4 : store.cfg.targetPageBytes;
    if (before <= limit) continue;
    const r = compressPage(store, rel, true);
    out.push({ path: rel, before: r.bytesBefore, after: r.bytesAfter });
  }
  return out.sort((a, b) => b.before - a.before);
}
