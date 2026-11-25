import path from 'node:path';
import { type RecallHit, type RecallOptions } from './types.js';
import { KbStore, type KbIndex } from './store.js';
import { bigramContainment, collapseWhitespace, tokenize, truncate } from './text.js';
import { bulletText } from './markdown.js';

const SNIPPET_MAX = 220;

interface Scored {
  rel: string;
  score: number;
  snippets: string[];
}

/**
 * Lexical recall over the wiki tree.
 *
 * Scoring is intentionally boring and explainable: title/summary/tag hits
 * dominate, body hits add, a shallow-page bias keeps hub pages reachable, and
 * folder structure gives the parent a small boost so the tree stays coherent.
 */
export function recall(store: KbStore, query: string, opts: RecallOptions = {}): RecallHit[] {
  const q = collapseWhitespace(query);
  if (q.trim().length === 0) return [];
  const limit = opts.limit ?? 6;
  const minScore = opts.minScore ?? 0.01;
  const index = store.loadIndex();
  const qtokens = uniqueTokens(q);
  if (qtokens.length === 0) return [];
  const memoryPrefix = store.memoryRelDir();

  const scored: Scored[] = [];
  for (const entry of Object.values(index.entries)) {
    const rel = entry.path;
    const isIndex = path.posix.basename(rel) === 'index.md';
    const inArchive = rel.split('/').includes('_archive');
    if (inArchive && !opts.includeArchive) continue;
    if (isIndex && opts.includeIndex === false) continue;
    // Memory pages are injected into every prompt already; recalling them would
    // spend context twice on the same text.
    if (memoryPrefix !== '' && (rel === memoryPrefix || rel.startsWith(memoryPrefix + '/'))) continue;

    const meta = entry.meta;
    const titleScore = bigramContainment(q, meta.frontmatter.title) * 3.0;
    const summaryScore = bigramContainment(q, meta.frontmatter.summary) * 1.8;
    const tagScore = tagOverlap(qtokens, meta.frontmatter.tags) * 1.5;
    const headingScore = bigramContainment(q, meta.headings.join(' ')) * 1.2;
    const bodyScore = bigramContainment(q, meta.text) * 1.0;
    const exactBoost = meta.frontmatter.title.toLowerCase().includes(q.toLowerCase()) ? 2.0 : 0;
    const depthPenalty = Math.min(meta.frontmatter.level, 5) * 0.05;
    const indexPenalty = isIndex ? 0.25 : 0;

    const score =
      titleScore + summaryScore + tagScore + headingScore + bodyScore + exactBoost -
      depthPenalty - indexPenalty;

    if (score < minScore) continue;
    scored.push({ rel, score, snippets: extractSnippets(meta.text, qtokens) });
  }

  // A folder that scored well lifts its own index page a little.
  const boosted = new Map<string, number>();
  for (const s of scored) boosted.set(s.rel, s.score);
  for (const s of scored) {
    const parentDir = path.posix.dirname(s.rel);
    const parentIndex = parentDir === '.' ? 'index.md' : `${parentDir}/index.md`;
    if (boosted.has(parentIndex)) {
      boosted.set(parentIndex, boosted.get(parentIndex)! + s.score * 0.12);
    }
  }

  const hits: RecallHit[] = scored
    .map((s) => {
      const entry = index.entries[s.rel]!;
      return {
        path: s.rel,
        title: entry.meta.frontmatter.title,
        summary: entry.meta.frontmatter.summary,
        tags: entry.meta.frontmatter.tags,
        score: round(boosted.get(s.rel) ?? s.score),
        snippets: s.snippets,
        isIndex: path.posix.basename(s.rel) === 'index.md',
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return hits;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function uniqueTokens(s: string): string[] {
  return [...new Set(tokenize(s))];
}

function tagOverlap(qtokens: string[], tags: string[]): number {
  if (tags.length === 0) return 0;
  const flat = tags.join(' ').toLowerCase();
  let hit = 0;
  for (const t of qtokens) if (flat.includes(t)) hit++;
  return hit / Math.max(1, qtokens.length);
}

/** Pick the best lines from a page for the injected context. */
export function extractSnippets(text: string, qtokens: string[], max = 3): string[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const scored = lines
    .map((line, idx) => {
      const hitCount = qtokens.reduce((n, t) => (line.toLowerCase().includes(t) ? n + 1 : n), 0);
      const isBullet = line.startsWith('-');
      return { line, idx, score: hitCount + (isBullet ? 0.5 : 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .slice(0, max)
    .sort((a, b) => a.idx - b.idx);

  const picked = scored.map((x) => truncate(collapseWhitespace(bulletText(x.line)), SNIPPET_MAX));
  if (picked.length > 0) return dedupeSnippets(picked);
  // Nothing matched line-wise (match was in front matter): fall back to the
  // first few bullet lines so the agent still gets content.
  const bullets = lines.filter((l) => l.startsWith('- ')).slice(0, 2);
  return bullets.map((b) => truncate(collapseWhitespace(bulletText(b)), SNIPPET_MAX));
}

function dedupeSnippets(items: string[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (out.some((o) => o.includes(item) || item.includes(o))) continue;
    out.push(item);
  }
  return out;
}

/** Render hits as the context block injected into the agent session. */
export function renderRecall(hits: RecallHit[], opts: { maxChars?: number } = {}): string {
  const maxChars = opts.maxChars ?? 4000;
  if (hits.length === 0) return '';
  const parts: string[] = ['## Knowledge base hits (from knowlege-base-harness)', ''];
  let used = parts.join('\n').length;
  hits.forEach((hit, i) => {
    const block: string[] = [];
    block.push(`${i + 1}. ${hit.title} — \`${hit.path}\``);
    if (hit.tags.length > 0) block.push(`   tags: ${hit.tags.join(', ')}`);
    if (hit.snippets.length > 0) {
      for (const s of hit.snippets) block.push(`   - ${s}`);
    }
    const text = block.join('\n');
    if (used + text.length > maxChars) return;
    used += text.length + 1;
    parts.push(text);
  });
  parts.push('');
  parts.push('Read the full page with the kb tool before acting if a hit looks relevant.');
  return parts.join('\n');
}

export function indexStats(index: KbIndex): { pages: number; bytes: number } {
  let bytes = 0;
  const pages = Object.keys(index.entries).length;
  for (const e of Object.values(index.entries)) bytes += e.size;
  return { pages, bytes };
}
