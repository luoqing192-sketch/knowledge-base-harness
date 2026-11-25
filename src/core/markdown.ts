import {
  type Confidence,
  type DocFrontmatter,
  type ParsedDoc,
  type Section,
} from './types.js';
import { parseYaml, stringifyYaml } from './yaml.js';
import { collapseWhitespace, normalizeForCompare, slugify, truncate } from './text.js';

export const FM_DELIM = '---';

export const SECTION_CONCLUSIONS = '结论';
export const SECTION_DETAILS = '细节';
export const SECTION_OPEN = '待确认';
export const SECTION_RELATED = '相关';

const RESERVED_SECTIONS: string[] = [
  SECTION_CONCLUSIONS,
  SECTION_DETAILS,
  SECTION_OPEN,
  SECTION_RELATED,
];

export interface ParseOptions {
  /** Path relative to the KB root, used to synthesise missing fields. */
  relPath?: string;
}

export function parseDoc(source: string, opts: ParseOptions = {}): ParsedDoc {
  const text = source.replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  let frontmatter: Record<string, unknown> = {};
  let bodyStart = 0;
  if (lines[0]?.trim() === FM_DELIM) {
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]!.trim() === FM_DELIM) {
        end = i;
        break;
      }
    }
    if (end > 0) {
      frontmatter = parseYaml(lines.slice(1, end).join('\n')) as Record<string, unknown>;
      bodyStart = end + 1;
    }
  }

  let titleLine: string | null = null;
  let cursor = bodyStart;
  while (cursor < lines.length) {
    const l = lines[cursor]!;
    if (l.trim() === '') {
      cursor++;
      continue;
    }
    const h1 = /^#\s+(.*)$/.exec(l);
    if (h1) {
      titleLine = l;
      cursor++;
    }
    break;
  }

  const preamble: string[] = [];
  const sections: Section[] = [];
  let current: Section | null = null;
  for (let i = cursor; i < lines.length; i++) {
    const line = lines[i]!;
    const h = /^(#{2,6})\s+(.*)$/.exec(line);
    if (h) {
      current = { heading: h[2]!.trim(), depth: h[1]!.length, lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }

  const fm = normaliseFrontmatter(frontmatter, titleLine, sections, preamble, opts);
  return { frontmatter: fm, titleLine, preamble: trimBlank(preamble), sections };
}

function normaliseFrontmatter(
  raw: Record<string, unknown>,
  titleLine: string | null,
  sections: Section[],
  preamble: string[],
  opts: ParseOptions,
): DocFrontmatter {
  const relPath = opts.relPath ?? 'index.md';
  const headingTitle = titleLine ? titleLine.replace(/^#\s+/, '').trim() : '';
  const title = asString(raw['title']) || headingTitle || derivedTitle(relPath);
  const tags = asStringArray(raw['tags']);
  const summary =
    asString(raw['summary']) ||
    extractSummary(preamble, sections) ||
    truncate(title, 60);
  const now = new Date().toISOString().slice(0, 10);

  return {
    id: asString(raw['id']) || slugify(relPath.replace(/\.md$/i, '')),
    title,
    summary: truncate(collapseWhitespace(summary), 200),
    tags,
    level: asNumber(raw['level']) ?? depthOf(relPath),
    parent: asString(raw['parent']) || parentSlug(relPath),
    created: asString(raw['created']) || now,
    updated: asString(raw['updated']) || now,
    revision: asNumber(raw['revision']) ?? 1,
    confidence: asConfidence(raw['confidence']),
    ...(asString(raw['absorbedInto']) ? { absorbedInto: asString(raw['absorbedInto']) } : {}),
    ...(asString(raw['derivedFrom']) ? { derivedFrom: asString(raw['derivedFrom']) } : {}),
  };
}

function derivedTitle(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath;
  if (base === 'index.md') {
    const segs = relPath.split('/');
    const dir = segs.length > 1 ? segs[segs.length - 2]! : 'index';
    return dir === '.' ? 'Knowledge Base' : dir;
  }
  return base.replace(/\.md$/i, '');
}

export function depthOf(relPath: string): number {
  const segs = relPath.split('/').filter(Boolean);
  if (segs.length <= 1) return 0;
  // index.md counts as the folder it names.
  return segs.length - 1;
}

export function parentSlug(relPath: string): string {
  const segs = relPath.split('/').filter(Boolean);
  if (segs.length <= 1) return '-';
  return slugify(segs[segs.length - 2]!);
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim() !== '') {
    return v
      .split(/[,，]/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

function asConfidence(v: unknown): Confidence {
  const s = asString(v).toLowerCase();
  if (s === 'high' || s === 'medium' || s === 'low') return s;
  return 'medium';
}

export function extractSummary(preamble: string[], sections: Section[]): string {
  for (const raw of preamble) {
    const line = raw.trim();
    if (line === '' || line.startsWith('>')) continue;
    if (/^[-*]\s/.test(line)) continue;
    if (/^\[.*\]\(.*\)$/.test(line)) continue;
    return truncate(collapseWhitespace(line), 160);
  }
  const con = sections.find((s) => s.heading === SECTION_CONCLUSIONS);
  if (con) {
    for (const raw of con.lines) {
      const line = raw.trim();
      if (line.startsWith('-')) return truncate(collapseWhitespace(bulletText(line)), 160);
    }
  }
  return '';
}

export function bulletText(line: string): string {
  return line.replace(/^\s*[-*+]\s+/, '').trim();
}

function trimBlank(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === '') start++;
  while (end > start && lines[end - 1]!.trim() === '') end--;
  return lines.slice(start, end);
}

export function serializeDoc(doc: ParsedDoc): string {
  const fm = frontmatterToMap(doc.frontmatter);
  const parts: string[] = [FM_DELIM, stringifyYaml(fm), FM_DELIM, ''];

  const title = doc.titleLine ?? `# ${doc.frontmatter.title}`;
  parts.push(title.trim(), '');

  const preamble = trimBlank(doc.preamble);
  if (preamble.length > 0) {
    parts.push(...preamble, '');
  }

  for (const section of doc.sections) {
    const body = trimBlank(section.lines);
    if (body.length === 0) continue;
    parts.push(`${'#'.repeat(section.depth)} ${section.heading}`, '', ...body, '');
  }

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
}

export function frontmatterToMap(fm: DocFrontmatter): Record<string, string | number | string[]> {
  return {
    id: fm.id,
    title: fm.title,
    summary: fm.summary,
    tags: fm.tags,
    level: fm.level,
    parent: fm.parent,
    created: fm.created,
    updated: fm.updated,
    revision: fm.revision,
    confidence: fm.confidence,
    ...(fm.absorbedInto ? { absorbedInto: fm.absorbedInto } : {}),
    ...(fm.derivedFrom ? { derivedFrom: fm.derivedFrom } : {}),
  };
}

export function getSection(doc: ParsedDoc, heading: string): Section | undefined {
  return doc.sections.find((s) => s.heading === heading);
}

export function ensureSection(doc: ParsedDoc, heading: string, depth = 2): Section {
  const existing = getSection(doc, heading);
  if (existing) return existing;
  const section: Section = { heading, depth, lines: [] };
  doc.sections.push(section);
  return section;
}

export function hasSection(doc: ParsedDoc, heading: string): boolean {
  return doc.sections.some((s) => s.heading === heading);
}

/** Bullet-level dedupe inside one section, returning inserted vs merged counts. */
export function mergeBullets(
  section: Section,
  newBullets: string[],
): { added: number; merged: number } {
  let added = 0;
  let merged = 0;
  const existing = section.lines
    .filter((l) => l.trim().startsWith('-'))
    .map((l) => normalizeForCompare(bulletText(l)));

  // New bullets go after the existing ones with no blank lines in between.
  while (section.lines.length > 0 && section.lines[section.lines.length - 1]!.trim() === '') {
    section.lines.pop();
  }

  for (const bullet of newBullets) {
    const norm = normalizeForCompare(bullet.replace(/^\s*[-*+]\s+/, ''));
    if (norm.length === 0) continue;
    const dup = existing.some((e) => e === norm);
    if (dup) {
      merged++;
      continue;
    }
    // Near-duplicate: one contains the other and both are short.
    const near = existing.findIndex(
      (e) => e.length > 0 && norm.length > 0 && (e.includes(norm) || norm.includes(e)) &&
        Math.abs(e.length - norm.length) <= 8,
    );
    if (near >= 0) {
      const targetLine = section.lines.findIndex(
        (l) => normalizeForCompare(bulletText(l)) === existing[near],
      );
      if (targetLine >= 0 && bullet.length > bulletText(section.lines[targetLine]!).length) {
        section.lines[targetLine] = bullet;
        existing[near] = norm;
      }
      merged++;
      continue;
    }
    if (section.lines.length === 0) section.lines.push(bullet);
    else section.lines.push(bullet);
    existing.push(norm);
    added++;
  }
  return { added, merged };
}

export function isReservedSection(heading: string): boolean {
  return RESERVED_SECTIONS.includes(heading);
}

export function sortSections(doc: ParsedDoc): void {
  const rank = (h: string) => {
    const i = RESERVED_SECTIONS.indexOf(h);
    return i === -1 ? RESERVED_SECTIONS.length : i;
  };
  doc.sections.sort((a, b) => rank(a.heading) - rank(b.heading));
}

export function wordsOf(doc: ParsedDoc): number {
  let n = doc.preamble.join(' ').length;
  for (const s of doc.sections) n += s.heading.length + s.lines.join(' ').length;
  return n;
}
