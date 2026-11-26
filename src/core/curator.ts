import fs from 'node:fs';
import path from 'node:path';
import {
  type Conclusion,
  type DocFrontmatter,
  type ParsedDoc,
  type ConsolidationPlan,
  type AppliedConsolidation,
  type CuratorReport,
} from './types.js';
import { KbStore, dedupeTags } from './store.js';
import {
  SECTION_CONCLUSIONS,
  bulletText,
  ensureSection,
  mergeBullets,
} from './markdown.js';
import { collapseWhitespace, isoDate, slugify, tokenize, truncate } from './text.js';

/**
 * Curator: consolidate narrow sibling pages into an umbrella page.
 *
 * This follows the shape Hermes uses for its skill curator — "one broad umbrella
 * with labeled sections beats many narrow siblings" — with two differences that
 * come from running without a model on the hot path:
 *
 *  - **Clustering is deterministic** (shared folder + shared tag / shared slug
 *    token / session-artifact name). The LLM planner exists as an opt-in seam
 *    that only the CLI can reach, never a hook.
 *  - **Dry run by default.** Every plan is printed with its sources and
 *    projected size; nothing is written until `--apply`.
 *
 * Safety invariants, mirroring the ones Hermes enforces:
 *  - never delete: absorbed pages move to `_archive/`, full text kept
 *  - every archive records `absorbedInto` so the direction is machine-readable
 *  - an umbrella is never created over an existing path
 *  - a cluster smaller than `minClusterSize` is left alone
 *  - the merged page must fit in `targetPageBytes`; otherwise the cluster is
 *    reported as skipped rather than silently truncated
 */

const ARCHIVE_DIR = '_archive';

const GENERIC_TAGS = new Set([
  'archive', 'index', 'memory', 'playbook', 'auto-promoted', 'wiki', 'consolidated',
]);

/** Filenames that are almost certainly an accident of a session, not a topic. */
const ARTIFACT_NAME = [
  /(^|-)(pr|mr|issue|bug|fix|tmp|temp|untitled)(-|$)/i,
  /(^|-)\d{3,}(-|$)/,
  /[0-9a-f]{7,}/i,
  /^p[0-9a-z]{6,}$/i, // our own hashed slug for a non-latin title
];

export interface NarrowPage {
  path: string;
  dir: string;
  title: string;
  tags: string[];
  conclusions: string[];
  bytes: number;
  /** True when the filename carries a session artifact rather than a topic. */
  artifact: boolean;
  /** True when the page is a memory page; those are never consolidated. */
  isMemory: boolean;
}

export interface Cluster {
  dir: string;
  sources: NarrowPage[];
  /** Why these pages were grouped, shown in the plan. */
  reason: string;
  /** Slug proposed for the umbrella page. */
  slug: string;
}

export interface CuratorOptions {
  /** Minimum pages in a cluster before consolidation is proposed. */
  minClusterSize?: number;
  /** A page with more conclusions than this is not "narrow". */
  maxConclusionsPerPage?: number;
  /** A page larger than this fraction of maxPageBytes is not "narrow". */
  narrowBytesRatio?: number;
}

export const DEFAULT_CURATOR: Required<CuratorOptions> = {
  minClusterSize: 3,
  maxConclusionsPerPage: 3,
  narrowBytesRatio: 0.35,
};

/** Collect the pages a curator may consider. */
export function findNarrowPages(store: KbStore, opts: CuratorOptions = {}): NarrowPage[] {
  const cfg = { ...DEFAULT_CURATOR, ...opts };
  const memoryPrefix = store.memoryRelDir();
  const out: NarrowPage[] = [];
  const index = store.loadIndex();

  for (const rel of Object.keys(index.entries)) {
    const base = path.posix.basename(rel);
    const dir = path.posix.dirname(rel);
    const isMemory =
      memoryPrefix !== '' && (rel === memoryPrefix || rel.startsWith(memoryPrefix + '/'));
    if (base === 'index.md') continue;
    if (rel.startsWith(`${ARCHIVE_DIR}/`)) continue;
    if (rel.startsWith('playbooks/')) continue;
    // Reference pages hold long-form evidence for another page; merging them
    // would bury the evidence and break `derivedFrom`.
    if (rel.startsWith('references/')) continue;
    if (isMemory) continue;

    const doc = store.read(rel);
    if (!doc) continue;
    const conclusions = conclusionBullets(doc);
    const bytes = store.bytesOf(rel);

    if (conclusions.length > cfg.maxConclusionsPerPage) continue;
    if (bytes > store.cfg.maxPageBytes * cfg.narrowBytesRatio) continue;

    out.push({
      path: rel,
      dir: dir === '.' ? '' : dir,
      title: doc.frontmatter.title,
      tags: doc.frontmatter.tags,
      conclusions,
      bytes,
      artifact: isArtifactName(base),
      isMemory,
    });
  }
  return out;
}

function isArtifactName(basename: string): boolean {
  const slug = basename.replace(/\.md$/i, '');
  return ARTIFACT_NAME.some((re) => re.test(slug));
}

function conclusionBullets(doc: ParsedDoc): string[] {
  const con = doc.sections.find((s) => s.heading === SECTION_CONCLUSIONS);
  if (!con) return [];
  return con.lines.filter((l) => l.trim().startsWith('-')).map((l) => bulletText(l));
}

function slugTokens(relPath: string): string[] {
  const base = relPath.replace(/\.md$/i, '').split('/').pop() ?? '';
  return base
    .split(/[-_.]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t));
}

/** Group narrow pages into candidate umbrellas. */
export function clusterNarrowPages(pages: NarrowPage[], opts: CuratorOptions = {}): Cluster[] {
  const cfg = { ...DEFAULT_CURATOR, ...opts };
  const byDir = new Map<string, NarrowPage[]>();
  for (const page of pages) {
    const list = byDir.get(page.dir) ?? [];
    list.push(page);
    byDir.set(page.dir, list);
  }

  const clusters: Cluster[] = [];

  for (const [dir, group] of byDir) {
    const used = new Set<string>();

    // Rule 1 — session artifacts in one folder. Strongest signal: these names
    // were never meant to be topics. Needs only two members.
    const artifacts = group.filter((p) => p.artifact);
    if (artifacts.length >= Math.max(2, Math.min(cfg.minClusterSize, 2))) {
      const picked = artifacts.filter((p) => !used.has(p.path));
      if (picked.length >= 2) {
        picked.forEach((p) => used.add(p.path));
        clusters.push({
          dir,
          sources: picked,
          reason: `${picked.length} 个页面名带会话痕迹（PR/工单号/哈希），不是主题名`,
          slug: 'sessions',
        });
      }
    }

    // Rule 2 — shared specific tag.
    const byTag = new Map<string, NarrowPage[]>();
    for (const page of group) {
      if (used.has(page.path)) continue;
      for (const tag of page.tags) {
        if (GENERIC_TAGS.has(tag)) continue;
        const list = byTag.get(tag) ?? [];
        list.push(page);
        byTag.set(tag, list);
      }
    }
    for (const [tag, list] of byTag) {
      const picked = list.filter((p) => !used.has(p.path));
      if (picked.length < cfg.minClusterSize) continue;
      // Only take pages whose *only* non-generic tag is this one, so a page with
      // several homes is not stolen by whichever tag happens to be iterated.
      const clean = picked.filter((p) => p.tags.filter((t) => !GENERIC_TAGS.has(t)).length === 1);
      if (clean.length < cfg.minClusterSize) continue;
      clean.forEach((p) => used.add(p.path));
      clusters.push({
        dir,
        sources: clean.sort((a, b) => a.path.localeCompare(b.path)),
        reason: `${clean.length} 个页面共享标签 \`${tag}\``,
        slug: slugify(tag),
      });
    }

    // Rule 3 — slug token overlap.
    const remaining = group.filter((p) => !used.has(p.path));
    const taken = new Set<string>();
    for (const page of remaining) {
      if (taken.has(page.path)) continue;
      const tokens = new Set(slugTokens(page.path));
      const mates = remaining.filter((other) => {
        if (other.path === page.path || taken.has(other.path)) return false;
        return sharesTopic(tokens, slugTokens(other.path));
      });
      if (mates.length + 1 < cfg.minClusterSize) continue;
      const group2 = [page, ...mates];
      group2.forEach((p) => taken.add(p.path));
      const shared = sharedTokens(group2);
      clusters.push({
        dir,
        sources: group2.sort((a, b) => a.path.localeCompare(b.path)),
        reason: `${group2.length} 个页面文件名共有词 \`${shared.join(', ') || '—'}\``,
        slug: umbrellaSlug(shared),
      });
    }
  }

  return clusters.filter((c) => c.sources.length >= cfg.minClusterSize);
}

/**
 * Two filenames share a topic when they share at least one distinctive token
 * (`pitfall-1` / `pitfall-2` both carry `pitfall`), or two short ones. Requiring
 * two tokens everywhere would miss the most common case: a numbered series.
 */
function sharesTopic(a: Set<string>, b: string[]): boolean {
  const shared = b.filter((t) => a.has(t));
  if (shared.length >= 2) return true;
  return shared.some((t) => t.length >= 4);
}

/** Umbrella filename from the shared tokens: prefer the longest one. */
function umbrellaSlug(shared: string[]): string {
  if (shared.length === 0) return 'consolidated';
  const best = [...shared].sort((a, b) => b.length - a.length)[0]!;
  return slugify(best);
}

/**
 * A readable umbrella title from the sources' own titles.
 *
 * The narrow pages in a cluster usually repeat one prefix ("ESS 重启后第 N 个坑…"),
 * so the longest common prefix of the titles is a better name than the filename
 * token. Falls back to null when nothing is shared.
 */
export function commonTitle(pages: NarrowPage[]): string | null {
  const titles = pages.map((p) => collapseWhitespace(p.title)).filter((t) => t !== '');
  if (titles.length === 0) return null;

  let prefix = titles[0]!;
  for (const title of titles.slice(1)) {
    let i = 0;
    const max = Math.min(prefix.length, title.length);
    while (i < max && prefix[i] === title[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length < 4) return null;
  }
  // Trim a dangling clause boundary so "…第 " does not survive.
  const cleaned = prefix.replace(/[\s，,：:、]+$/, '').replace(/第$/, '').trim();
  if (cleaned.length < 4) return null;
  // A prefix that is the whole of one title is not a shared topic.
  if (titles.some((t) => t === cleaned)) return null;
  return truncate(cleaned, 40);
}

function sharedTokens(pages: NarrowPage[]): string[] {
  if (pages.length === 0) return [];
  let shared = new Set(slugTokens(pages[0]!.path));
  for (const page of pages.slice(1)) {
    const tokens = new Set(slugTokens(page.path));
    shared = new Set([...shared].filter((t) => tokens.has(t)));
  }
  return [...shared].filter((t) => t.length >= 3);
}

/** Turn a cluster into a concrete plan, or a skip reason. */
export function planCluster(store: KbStore, cluster: Cluster): ConsolidationPlan | { skip: string } {
  const dirPart = cluster.dir === '' ? '' : `${cluster.dir}/`;
  let slug = cluster.slug || 'consolidated';
  let umbrella = `${dirPart}${slug}.md`;
  let n = 1;
  while (store.exists(umbrella)) {
    n++;
    umbrella = `${dirPart}${slug}-${n}.md`;
    if (n > 20) return { skip: 'could not find a free umbrella filename' };
  }

  const projected =
    cluster.sources.reduce((sum, s) => sum + s.conclusions.join('').length + 40, 0) + 600;
  if (projected > store.cfg.targetPageBytes) {
    return {
      skip: `合并后约 ${projected} 字节，超过 targetPageBytes=${store.cfg.targetPageBytes}`,
    };
  }
  if (cluster.sources.every((s) => s.conclusions.length === 0)) {
    return { skip: 'these pages have no conclusions to merge' };
  }

  // Title: derive it from what the sources are actually about rather than from
  // the filename token, so the umbrella reads like a topic.
  const sharedWords = sharedTokens(cluster.sources);
  const tagWords = cluster.reason.match(/`([^`]+)`/)?.[1]?.split(',').map((s) => s.trim()) ?? [];
  const title =
    cluster.slug === 'sessions'
      ? `零散会话结论（${cluster.dir || '根目录'}）`
      : commonTitle(cluster.sources) ?? tagWords[0] ?? sharedWords[0] ?? cluster.slug;

  return { umbrella, sources: cluster.sources.map((s) => s.path), title, reason: cluster.reason, projectedBytes: projected };
}

export function planConsolidations(store: KbStore, opts: CuratorOptions = {}): CuratorReport {
  const pages = findNarrowPages(store, opts);
  const clusters = clusterNarrowPages(pages, opts);
  const plans: ConsolidationPlan[] = [];
  const skipped: Array<{ sources: string[]; reason: string }> = [];

  for (const cluster of clusters) {
    const planned = planCluster(store, cluster);
    if ('skip' in planned) {
      skipped.push({ sources: cluster.sources.map((s) => s.path), reason: planned.skip });
      continue;
    }
    plans.push(planned);
  }

  return {
    considered: pages.length,
    plans,
    skipped,
    applied: [],
  };
}

/** Write a plan: archive the sources, create the umbrella, rebuild indices. */
export function applyConsolidation(store: KbStore, plan: ConsolidationPlan): AppliedConsolidation {
  const month = new Date().toISOString().slice(0, 7);
  const archived: Array<{ from: string; to: string }> = [];
  const bullets: string[] = [];
  const tags = new Set<string>();
  let confidence: DocFrontmatter['confidence'] = 'low';

  for (const source of plan.sources) {
    const doc = store.read(source);
    if (!doc) continue;

    const sourceName = source.replace(/\.md$/i, '').split('/').pop() ?? source;
    doc.frontmatter.tags.forEach((t) => tags.add(t));
    if (doc.frontmatter.confidence === 'high') confidence = 'high';
    else if (doc.frontmatter.confidence === 'medium' && confidence !== 'high') confidence = 'medium';

    for (const bullet of conclusionBullets(doc)) {
      bullets.push(`- ${bullet}（来自 ${sourceName}）`);
    }

    const archivePath = `${ARCHIVE_DIR}/${source.replace(/\//g, '__').replace(/\.md$/i, '')}-${month}.md`;
    doc.frontmatter.absorbedInto = plan.umbrella;
    doc.frontmatter.tags = dedupeTags([...doc.frontmatter.tags, 'archive']);
    doc.frontmatter.summary = `已并入 ${plan.umbrella}：${doc.frontmatter.summary}`;
    store.write(archivePath, doc);
    fs.unlinkSync(store.abs(source));
    archived.push({ from: source, to: archivePath });
  }

  const umbrella: ParsedDoc = {
    frontmatter: {
      id: slugify(plan.umbrella.replace(/\.md$/i, '')),
      title: plan.title,
      summary: truncate(`由 kb curate 合并 ${archived.length} 个窄页面而成：${plan.reason}`, 200),
      tags: dedupeTags([...tags, 'consolidated']),
      level: store.depthOf(plan.umbrella),
      parent: path.posix.dirname(plan.umbrella) === '.' ? '-' : slugify(path.posix.dirname(plan.umbrella).split('/').pop()!),
      created: isoDate(),
      updated: isoDate(),
      revision: 1,
      confidence,
    },
    titleLine: `# ${plan.title}`,
    preamble: [
      `由 kb curate 合并 ${archived.length} 个窄页面而成。原文完整保留在 \`${ARCHIVE_DIR}/\`，通过 \`absorbedInto\` 指回本页。`,
    ],
    sections: [
      { heading: SECTION_CONCLUSIONS, depth: 2, lines: [] },
      { heading: '来源', depth: 2, lines: [] },
    ],
  };

  mergeBullets(ensureSection(umbrella, SECTION_CONCLUSIONS), bullets);
  mergeBullets(
    ensureSection(umbrella, '来源'),
    archived.map((a) => `- \`${a.to}\` — 原 \`${a.from}\``),
  );

  store.write(plan.umbrella, umbrella);

  // Indices: the umbrella folder, the archive folder, and the root.
  const dir = path.posix.dirname(plan.umbrella);
  store.syncFolderIndex(dir === '.' ? '' : dir);
  store.syncFolderIndex(ARCHIVE_DIR);
  store.pruneEmptyDirs();
  store.syncFolderIndex('');

  return { umbrella: plan.umbrella, archived, bullets: bullets.length };
}

export function applyPlans(store: KbStore, plans: ConsolidationPlan[]): AppliedConsolidation[] {
  const applied: AppliedConsolidation[] = [];
  for (const plan of plans) {
    // A later plan may target a page an earlier plan already absorbed.
    if (plan.sources.some((s) => !store.exists(s))) continue;
    if (store.exists(plan.umbrella)) continue;
    applied.push(applyConsolidation(store, plan));
  }
  return applied;
}

export function renderCuratorReport(report: CuratorReport, applied: boolean): string {
  const lines: string[] = [];
  lines.push(`knowledge-base-harness: curator — ${report.considered} narrow page(s) considered`);
  if (report.plans.length === 0) {
    lines.push('  nothing worth consolidating');
  }
  for (const plan of report.plans) {
    lines.push(`  ${applied ? 'merged' : 'would merge'} → ${plan.umbrella}  (${plan.title})`);
    lines.push(`    reason: ${plan.reason}`);
    for (const source of plan.sources) lines.push(`      - ${source}`);
    lines.push(`    projected: ~${plan.projectedBytes} bytes`);
  }
  for (const skip of report.skipped) {
    lines.push(`  skipped ${skip.sources.join(', ')}: ${skip.reason}`);
  }
  if (!applied && report.plans.length > 0) {
    lines.push('  (dry run — re-run with --apply to write)');
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ LLM seam

/**
 * A plan produced by a model, validated against the wiki before use.
 *
 * The model only *proposes*: every source must exist, the umbrella must not
 * already exist, and the merged text must fit the budget. Anything that fails
 * validation is dropped with the reason attached — the model's output is never
 * trusted directly.
 */
export interface LlmPlan {
  umbrella: string;
  title: string;
  sources: string[];
  reason?: string;
}

export type CompleteFn = (prompt: string) => Promise<string>;

export function buildCuratorPrompt(pages: NarrowPage[]): string {
  const listing = pages
    .map((p) => `- ${p.path} | title: ${p.title} | tags: ${p.tags.join(',')}\n  ${p.conclusions.slice(0, 3).join('\n  ')}`)
    .join('\n');
  return [
    'You are consolidating a personal markdown wiki.',
    'Rule: one broad umbrella page with labeled sections beats many narrow siblings.',
    'Propose umbrellas ONLY for pages that share a real topic. Never merge unrelated facts.',
    'Every source path must come from the list below. Do not invent paths.',
    '',
    `Answer with JSON only: {"plans":[{"umbrella":"<dir>/<slug>.md","title":"...","sources":["..."],"reason":"..."}]}`,
    'Return an empty plans array when nothing should be merged.',
    '',
    'Pages:',
    listing,
  ].join('\n');
}

export function validateLlmPlans(
  store: KbStore,
  raw: unknown,
  pages: NarrowPage[],
): { plans: ConsolidationPlan[]; rejected: Array<{ reason: string; plan: unknown }> } {
  const plans: ConsolidationPlan[] = [];
  const rejected: Array<{ reason: string; plan: unknown }> = [];
  const known = new Set(pages.map((p) => p.path));

  const list =
    raw && typeof raw === 'object' && Array.isArray((raw as { plans?: unknown }).plans)
      ? ((raw as { plans: unknown[] }).plans)
      : [];

  for (const item of list) {
    if (!item || typeof item !== 'object') {
      rejected.push({ reason: 'not an object', plan: item });
      continue;
    }
    const candidate = item as Partial<LlmPlan>;
    const umbrella = typeof candidate.umbrella === 'string' ? candidate.umbrella.trim() : '';
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
    const sources = Array.isArray(candidate.sources)
      ? candidate.sources.filter((s): s is string => typeof s === 'string')
      : [];

    if (umbrella === '' || !/\.md$/i.test(umbrella)) {
      rejected.push({ reason: 'umbrella must be a .md path', plan: item });
      continue;
    }
    if (store.exists(umbrella)) {
      rejected.push({ reason: `umbrella already exists: ${umbrella}`, plan: item });
      continue;
    }
    if (sources.length < 2) {
      rejected.push({ reason: 'needs at least 2 sources', plan: item });
      continue;
    }
    const unknown = sources.filter((s) => !known.has(s));
    if (unknown.length > 0) {
      rejected.push({ reason: `unknown source(s): ${unknown.join(', ')}`, plan: item });
      continue;
    }
    if (sources.some((s) => s.split('/').includes(ARCHIVE_DIR))) {
      rejected.push({ reason: 'refusing to absorb archived pages', plan: item });
      continue;
    }
    const projected = sources.reduce((n, s) => n + (pages.find((p) => p.path === s)?.conclusions.join('').length ?? 0) + 40, 0) + 600;
    if (projected > store.cfg.targetPageBytes) {
      rejected.push({ reason: `projected ${projected} bytes exceeds targetPageBytes`, plan: item });
      continue;
    }

    plans.push({
      umbrella,
      title: title || path.posix.basename(umbrella, '.md'),
      sources,
      reason: typeof candidate.reason === 'string' ? candidate.reason : 'proposed by model',
      projectedBytes: projected,
    });
  }
  return { plans, rejected };
}

export async function planWithLlm(
  store: KbStore,
  complete: CompleteFn,
  opts: CuratorOptions = {},
): Promise<{ report: CuratorReport; rejected: Array<{ reason: string; plan: unknown }> }> {
  const pages = findNarrowPages(store, opts);
  if (pages.length < 2) {
    return { report: { considered: pages.length, plans: [], skipped: [], applied: [] }, rejected: [] };
  }
  const prompt = buildCuratorPrompt(pages);
  const answer = await complete(prompt);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(answer));
  } catch {
    return {
      report: { considered: pages.length, plans: [], skipped: [], applied: [] },
      rejected: [{ reason: 'model did not return JSON', plan: answer.slice(0, 400) }],
    };
  }
  const { plans, rejected } = validateLlmPlans(store, parsed, pages);
  return {
    report: { considered: pages.length, plans, skipped: [], applied: [] },
    rejected,
  };
}

function stripCodeFence(s: string): string {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  return (fence?.[1] ?? s).trim();
}

/** Facts a prospective umbrella would need, used by the CLI display. */
export function umbrellaPreview(store: KbStore, plan: ConsolidationPlan): string[] {
  const lines: string[] = [];
  for (const source of plan.sources) {
    const doc = store.read(source);
    if (!doc) continue;
    for (const bullet of conclusionBullets(doc).slice(0, 2)) {
      lines.push(`  · ${truncate(collapseWhitespace(bullet), 100)}`);
    }
  }
  return lines;
}

/** Keywords an umbrella is likely about, used for rule-based naming. */
export function dominantTokens(pages: NarrowPage[]): string[] {
  const counts = new Map<string, number>();
  for (const page of pages) {
    for (const token of new Set(tokenize(`${page.title} ${page.tags.join(' ')}`))) {
      if (token.length < 2) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t);
}

export type { Conclusion };
