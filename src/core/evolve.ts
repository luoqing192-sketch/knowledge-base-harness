import fs from 'node:fs';
import path from 'node:path';
import { type ParsedDoc, type RecallHit } from './types.js';
import { KbStore } from './store.js';
import { readIfExists, ensureDir, writeAtomic } from './fsx.js';
import {
  SECTION_CONCLUSIONS,
  SECTION_DETAILS,
  SECTION_RELATED,
  bulletText,
  ensureSection,
  mergeBullets,
} from './markdown.js';
import { collapseWhitespace, isoDate, normalizeForCompare, slugify, stripDecisionPrefix, tokenize, truncate } from './text.js';

/**
 * Self-evolution layer.
 *
 * Borrowed from the way Hermes lets an agent grow its own capability set: a
 * session should leave the knowledge base *stronger than it found it*, not just
 * longer. Four mechanisms, all deterministic and auditable:
 *
 *  1. **Usage stats** — every recall/write is counted per page. Pages that are
 *     recalled and then produce accepted conclusions gain weight; pages never
 *     recalled decay and become prune candidates.
 *  2. **Promotion** — a fact that repeats across sessions in the same shape is
 *     no longer a fact but a procedure: it is promoted into
 *     `playbooks/<theme>.md` as an ordered, reusable recipe (the analogue of a
 *     self-written skill).
 *  3. **Supersession** — a new conclusion that contradicts a stored one does
 *     not silently overwrite it. The old bullet is struck through with a date
 *     and a pointer to the replacement, so the history of *why* a belief
 *     changed stays in the page.
 *  4. **Decay** — stale, low-weight cards are reported (never auto-deleted) so
 *     `kb evolve` can propose archives.
 */

export interface PageStats {
  recalls: number;
  adopted: number;
  writes: number;
  contradictions: number;
  lastRecall?: string;
  lastWrite?: string;
}

export interface StatsFile {
  version: 1;
  pages: Record<string, PageStats>;
}

export class StatsStore {
  private file: string;
  private cache: StatsFile | null = null;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'state', 'stats.json');
  }

  load(): StatsFile {
    if (this.cache) return this.cache;
    const raw = readIfExists(this.file);
    if (!raw) {
      this.cache = { version: 1, pages: {} };
      return this.cache;
    }
    try {
      const parsed = JSON.parse(raw) as StatsFile;
      this.cache = parsed.version === 1 ? parsed : { version: 1, pages: {} };
    } catch {
      this.cache = { version: 1, pages: {} };
    }
    return this.cache;
  }

  save(): void {
    if (!this.cache) return;
    ensureDir(path.dirname(this.file));
    writeAtomic(this.file, JSON.stringify(this.cache, null, 2));
  }

  page(rel: string): PageStats {
    const stats = this.load();
    return (stats.pages[rel] ??= { recalls: 0, adopted: 0, writes: 0, contradictions: 0 });
  }

  bump(rel: string, field: keyof PageStats, amount = 1): void {
    const p = this.page(rel);
    if (field === 'lastRecall' || field === 'lastWrite') return;
    p[field] = (p[field] ?? 0) + amount;
    if (field === 'recalls') p.lastRecall = isoDate();
    if (field === 'writes') p.lastWrite = isoDate();
  }
}

export interface EvolutionReport {
  promotions: Array<{ theme: string; page: string; occurrences: number }>;
  superseded: Array<{ page: string; old: string; replacement: string }>;
  decay: Array<{ page: string; daysSinceRecall: number; weight: number }>;
  stats: { pages: number; recalls: number; writes: number };
}

/** Score a page's usefulness; higher means the agent keeps coming back to it. */
export function pageWeight(stats: PageStats): number {
  return stats.adopted * 3 + stats.recalls * 0.5 + stats.writes - stats.contradictions * 0.5;
}

export function recordRecall(stats: StatsStore, hits: RecallHit[]): void {
  for (const hit of hits) stats.bump(hit.path, 'recalls');
}

export function recordAdoption(stats: StatsStore, paths: string[]): void {
  for (const p of paths) {
    stats.bump(p, 'adopted');
    stats.bump(p, 'writes');
  }
}

// ------------------------------------------------------------- supersession

/**
 * Detect that `incoming` replaces `existing`: same subject, different verdict.
 *
 * The signal we trust is a *shared subject clause* plus a *conflicting
 * decision clause*. "库存扣减改为按订单维度" vs "库存扣减改为按 SKU 维度" share
 * "库存扣减改为" and conflict after it. Two unrelated sentences share nothing.
 */
/**
 * Detect that `incoming` replaces `existing`.
 *
 * Two independent signals must agree, because a false positive would silently
 * strike through a still-true fact:
 *
 *  1. **Same subject** — the two statements talk about the same thing, measured
 *     by token overlap after boilerplate ("确认了", "note:") is removed.
 *  2. **A changed verdict** — the new statement carries a revision marker
 *     (改为 / 不再 / instead …), and each side holds at least one content token
 *     the other lacks.
 *
 * An agent that knows it is revising a fact should say so explicitly via
 * `kb_note { supersedes }`; this heuristic only catches the common case.
 */
export function findSupersession(incoming: string, existing: string): boolean {
  const rawA = normalizeForCompare(stripDecisionPrefix(incoming));
  const rawB = normalizeForCompare(stripDecisionPrefix(existing));
  if (rawA === rawB) return false;
  // One statement merely elaborating the other is duplicate suppression, not
  // a contradiction — the writer handles that on its own.
  if (rawA.includes(rawB) || rawB.includes(rawA)) return false;

  const a = stripEvidence(rawA);
  const b = stripEvidence(rawB);

  const markers = /(改为|改成|改用|换成|替换|不再|不是|禁止|取消|deprecated|instead|no longer|replaced)/;
  if (!markers.test(a) && !markers.test(b)) return false;

  // Same subject: either the two share a leading subject clause, or their whole
  // vocabulary overlaps heavily. Both are checked because a short rewrite
  // ("缓存前缀改为 X") shares few bigrams with the longer original.
  const sharedPrefix = commonPrefixLength(a, b);
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  const similarity = union === 0 ? 0 : inter / union;

  if (sharedPrefix < 4 && similarity < 0.4) return false;

  const distinctA = [...ta].filter((t) => !tb.has(t));
  const distinctB = [...tb].filter((t) => !ta.has(t));
  return distinctA.length > 0 && distinctB.length > 0;
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/** Evidence tails ("commit abc1234", dates) never change a verdict. */
function stripEvidence(s: string): string {
  return s
    .replace(/commit[0-9a-f]{6,}/g, '')
    .replace(/[0-9a-f]{7,40}/g, '')
    .replace(/\d{4}-\d{2}-\d{2}/g, '');
}

/**
 * Mark an old conclusion as superseded, keeping its text for the audit trail.
 *
 * `oldText` comes either from the agent declaring `supersedes` (usually a
 * fragment of the stored bullet) or from the heuristic (usually the whole
 * bullet). So matching is: exact first, then a unique containment match. An
 * ambiguous fragment is refused rather than striking through the wrong fact.
 */
export function supersedeBullet(
  doc: ParsedDoc,
  oldText: string,
  newText: string,
): { ok: boolean; matched?: string; reason?: string } {
  const section = doc.sections.find((s) => s.heading === SECTION_CONCLUSIONS);
  if (!section) return { ok: false, reason: 'page has no conclusions section' };

  const target = normalizeForCompare(bulletText(oldText));
  if (target === '') return { ok: false, reason: 'empty supersedes text' };

  const candidates = section.lines
    .map((line, index) => ({ line, index }))
    .filter((c) => c.line.trim().startsWith('-') && !c.line.includes('~~'));

  let hit = candidates.find((c) => normalizeForCompare(bulletText(c.line)) === target);
  if (!hit) {
    const contains = candidates.filter((c) => normalizeForCompare(bulletText(c.line)).includes(target));
    if (contains.length > 1) {
      return {
        ok: false,
        reason: `supersedes matches ${contains.length} conclusions; quote more of the old text`,
      };
    }
    hit = contains[0];
  }
  if (!hit) return { ok: false, reason: 'supersedes text not found on this page' };

  const old = bulletText(hit.line);
  section.lines[hit.index] = `- ~~${old}~~ (${isoDate()} 已被取代：${truncate(newText, 80)})`;
  return { ok: true, matched: old };
}

// --------------------------------------------------------------- promotion

export interface PromotionCandidate {
  theme: string;
  bullets: Array<{ page: string; text: string }>;
  occurrences: number;
}

/**
 * A pattern worth promoting is a *procedure*: a conclusion whose wording is
 * imperative and repeated on more than one page. Facts stay facts; only
 * repeatable how-to becomes a playbook.
 */
const PROCEDURAL = /(先|然后|接着|最后|步骤|流程|做法|执行|运行|调用|配置|部署|排查|复现|验证|命令|then|first|run|execute|configure|deploy|verify)/i;

export function findPromotionCandidates(
  store: KbStore,
  minOccurrences = 2,
): PromotionCandidate[] {
  const index = store.loadIndex();
  const groups = new Map<string, Array<{ page: string; text: string }>>();

  for (const entry of Object.values(index.entries)) {
    const rel = entry.path;
    if (rel.startsWith('playbooks/') || rel.startsWith('_archive/')) continue;
    const doc = store.read(rel);
    if (!doc) continue;
    const con = doc.sections.find((s) => s.heading === SECTION_CONCLUSIONS);
    if (!con) continue;
    for (const line of con.lines) {
      if (!line.trim().startsWith('-') || line.includes('~~')) continue;
      const text = bulletText(line);
      if (text.length < 20 || !PROCEDURAL.test(text)) continue;
      const key = themeKey(text);
      const list = groups.get(key) ?? [];
      list.push({ page: rel, text });
      groups.set(key, list);
    }
  }

  const out: PromotionCandidate[] = [];
  for (const [theme, bullets] of groups) {
    const pages = new Set(bullets.map((b) => b.page));
    if (bullets.length < minOccurrences || pages.size < 2) continue;
    out.push({ theme, bullets, occurrences: bullets.length });
  }
  return out.sort((a, b) => b.occurrences - a.occurrences);
}

/** Coarse topic key: the leading nouns/verbs of a bullet. */
function themeKey(text: string): string {
  const tokens = tokenize(text).filter((t) => t.length >= 2).slice(0, 4);
  return tokens.join('-') || slugify(text);
}

/** Write or refresh a playbook page for a promoted theme. */
export function promoteToPlaybook(
  store: KbStore,
  candidate: PromotionCandidate,
): string {
  const rel = `playbooks/${slugify(candidate.theme)}.md`;
  const existing = store.read(rel);
  const doc: ParsedDoc =
    existing ??
    {
      frontmatter: {
        id: `playbook-${slugify(candidate.theme)}`,
        title: `打法：${candidate.theme}`,
        summary: `自动沉淀的重复性做法，来源于 ${candidate.occurrences} 条跨页面结论。`,
        tags: ['playbook', 'auto-promoted'],
        level: 1,
        parent: 'playbooks',
        created: isoDate(),
        updated: isoDate(),
        revision: 1,
        confidence: 'medium',
      },
      titleLine: `# 打法：${candidate.theme}`,
      preamble: [
        '由 knowledge-base-harness 自动提升：同一做法在多个页面重复出现，说明它是可复用的流程而非单点事实。',
      ],
      sections: [
        { heading: SECTION_CONCLUSIONS, depth: 2, lines: [] },
        { heading: '来源', depth: 2, lines: [] },
      ],
    };

  const steps = ensureSection(doc, SECTION_CONCLUSIONS);
  mergeBullets(
    steps,
    candidate.bullets.map((b, i) => `${i + 1}. ${b.text}`),
  );

  const sources = ensureSection(doc, '来源');
  mergeBullets(
    sources,
    candidate.bullets.map((b) => `- \`${b.page}\` — ${truncate(b.text, 120)}`),
  );

  // Backlink: each source page records the playbook in its Related section.
  for (const bullet of candidate.bullets) {
    const src = store.read(bullet.page);
    if (!src) continue;
    const related = ensureSection(src, SECTION_RELATED);
    const link = `- [${doc.frontmatter.title}](${path.posix.relative(path.posix.dirname(bullet.page), rel)})`;
    const before = related.lines.length;
    mergeBullets(related, [link]);
    if (rel.length > 0 && related.lines.length !== before) store.write(bullet.page, src);
  }

  doc.frontmatter.revision += 1;
  store.write(rel, doc);
  store.syncParentIndex(rel);
  return rel;
}

// -------------------------------------------------------------------- decay

export interface DecayOptions {
  /** Days without recall before a page is considered cold. */
  coldAfterDays?: number;
  /** Pages below this weight are prune candidates once cold. */
  minWeight?: number;
}

export function findDecayingPages(
  store: KbStore,
  stats: StatsStore,
  opts: DecayOptions = {},
): Array<{ page: string; daysSinceRecall: number; weight: number }> {
  const coldAfter = opts.coldAfterDays ?? 120;
  const minWeight = opts.minWeight ?? 1.5;
  const now = Date.now();
  const out: Array<{ page: string; daysSinceRecall: number; weight: number }> = [];

  for (const rel of store.scan().files) {
    if (rel.startsWith('_archive/') || rel === 'index.md' || rel.endsWith('/index.md')) continue;
    // Reference and playbook pages are support structures for other pages, not
    // topics a reader navigates to; their coldness says nothing useful.
    if (rel.startsWith('references/') || rel.startsWith('playbooks/')) continue;
    const meta = store.read(rel);
    if (!meta) continue;
    if (meta.sections.length === 0) continue;
    if (meta.frontmatter.tags.includes('playbook')) continue;

    const s = stats.load().pages[rel];
    const weight = s ? pageWeight(s) : 0;
    if (weight >= minWeight) continue;

    const lastRef = s?.lastRecall ?? meta.frontmatter.updated;
    const days = Math.floor((now - Date.parse(lastRef)) / 86_400_000);
    if (days < coldAfter) continue;
    out.push({ page: rel, daysSinceRecall: days, weight });
  }
  return out.sort((a, b) => b.daysSinceRecall - a.daysSinceRecall);
}

// ---------------------------------------------------------------- evolution

/**
 * Run the full evolution pass after a session wrote its conclusions.
 * Idempotent: safe to run from a Stop hook on every session end.
 */
export function evolveAfterSession(
  store: KbStore,
  stats: StatsStore,
  opts: { promoteMinOccurrences?: number; coldAfterDays?: number } = {},
): EvolutionReport {
  const report: EvolutionReport = {
    promotions: [],
    superseded: [],
    decay: [],
    stats: { pages: 0, recalls: 0, writes: 0 },
  };

  const candidates = findPromotionCandidates(store, opts.promoteMinOccurrences ?? 2);
  for (const candidate of candidates) {
    const page = promoteToPlaybook(store, candidate);
    report.promotions.push({ theme: candidate.theme, page, occurrences: candidate.occurrences });
  }

  const file = stats.load();
  report.decay = findDecayingPages(store, stats, { coldAfterDays: opts.coldAfterDays });
  report.stats = {
    pages: Object.keys(file.pages).length,
    recalls: Object.values(file.pages).reduce((n, p) => n + p.recalls, 0),
    writes: Object.values(file.pages).reduce((n, p) => n + p.writes, 0),
  };
  stats.save();
  return report;
}

export function renderEvolutionReport(report: EvolutionReport): string {
  const lines: string[] = ['knowledge-base-harness: evolution pass'];
  if (report.promotions.length > 0) {
    lines.push(`  promoted ${report.promotions.length} playbook(s):`);
    for (const p of report.promotions) {
      lines.push(`    - ${p.page} (from ${p.occurrences} conclusions)`);
    }
  }
  if (report.superseded.length > 0) {
    lines.push(`  superseded ${report.superseded.length} stale conclusion(s):`);
    for (const s of report.superseded) lines.push(`    - ${s.page}: ${s.old} → ${s.replacement}`);
  }
  if (report.decay.length > 0) {
    lines.push(`  ${report.decay.length} page(s) decaying (prune candidates, nothing deleted):`);
    for (const d of report.decay.slice(0, 5)) {
      lines.push(`    - ${d.page} (${d.daysSinceRecall}d, weight ${d.weight})`);
    }
  }
  if (
    report.promotions.length === 0 &&
    report.decay.length === 0 &&
    report.superseded.length === 0
  ) {
    lines.push('  nothing to evolve');
  }
  return lines.join('\n');
}

export function statsPath(dataDir: string): string {
  return path.join(dataDir, 'state', 'stats.json');
}

export function ensureStatsFile(dataDir: string): void {
  const f = statsPath(dataDir);
  if (!fs.existsSync(f)) {
    ensureDir(path.dirname(f));
    writeAtomic(f, JSON.stringify({ version: 1, pages: {} }, null, 2));
  }
}

/** Detail bullets recorded alongside conclusions, used by compression audit. */
export function recordDetail(doc: ParsedDoc, evidence: string, text: string): void {
  const details = ensureSection(doc, SECTION_DETAILS);
  mergeBullets(details, [`- ${evidence} → ${truncate(collapseWhitespace(text), 140)}`]);
}

export function totalConclusions(store: KbStore): number {
  let n = 0;
  for (const rel of store.scan().files) {
    const doc = store.read(rel);
    if (!doc) continue;
    const con = doc.sections.find((s) => s.heading === SECTION_CONCLUSIONS);
    if (!con) continue;
    n += con.lines.filter((l) => l.trim().startsWith('-')).length;
  }
  return n;
}
