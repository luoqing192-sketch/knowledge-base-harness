import path from 'node:path';
import { type Conclusion, type Confidence, type UpsertResult, type UpsertSummary } from './types.js';
import { KbStore } from './store.js';
import { recall } from './recall.js';
import { compressPage } from './compress.js';
import {
  SECTION_CONCLUSIONS,
  SECTION_DETAILS,
  bulletText,
  ensureSection,
  mergeBullets,
} from './markdown.js';
import { collapseWhitespace, isoDate, slugify, stripDecisionPrefix, tokenize, truncate } from './text.js';
import { isNoise, judgeConclusion, isAccepted } from './distill.js';
import { findSupersession, supersedeBullet } from './evolve.js';

/** A conclusion plus where it wants to live. */
export interface RoutedConclusion {
  conclusion: Conclusion;
  /** Target folder relative to the KB root ('' = root). */
  folder: string;
  score: number;
  matchedPath?: string;
}

export interface UpsertOptions {
  /** Force every conclusion into this page. */
  targetPath?: string;
  /** Folder to create new pages in when no page matches. */
  defaultFolder?: string;
  /** Minimum recall score to reuse an existing page rather than create one. */
  reuseThreshold?: number;
  minConfidence?: Confidence;
}

const REUSE_THRESHOLD = 1.2;

/**
 * Route each conclusion into the wiki.
 *
 * Existing-page reuse is preferred: a knowledge base degrades into thousands of
 * one-bullet pages if every session invents a new file. A page is reused only
 * when recall gives a strong hit AND the hit is a leaf page (indices are hubs,
 * not homes for facts).
 */
export function routeConclusions(
  store: KbStore,
  conclusions: Conclusion[],
  opts: UpsertOptions = {},
): RoutedConclusion[] {
  const routed: RoutedConclusion[] = [];
  const threshold = opts.reuseThreshold ?? REUSE_THRESHOLD;
  const minConfidence = opts.minConfidence ?? store.cfg.minConclusionConfidence;

  for (const conclusion of conclusions) {
    const text = collapseWhitespace(conclusion.text);
    if (text.length < store.cfg.minConclusionChars) continue;
    if (isNoise(text)) continue;
    const verdict = judgeConclusion(text, {
      explicit: conclusion.source === 'manual' || conclusion.source === 'agent',
    });
    if (!verdict.accepted) continue;
    const merged = mergeConfidence(verdict.confidence, conclusion.confidence);
    if (!isAccepted({ ...verdict, confidence: merged }, minConfidence)) {
      continue;
    }

    if (opts.targetPath) {
      routed.push({ conclusion: { ...conclusion, text }, folder: dirOf(opts.targetPath), score: Infinity, matchedPath: opts.targetPath });
      continue;
    }

    const hits = recall(store, text, { limit: 4, includeIndex: false, minScore: 0.4 });
    const best = hits[0];
    if (best && best.score >= threshold) {
      routed.push({
        conclusion: { ...conclusion, text },
        folder: dirOf(best.path),
        score: best.score,
        matchedPath: best.path,
      });
      continue;
    }

    const folder = inferFolder(store, text, conclusion.tags ?? [], opts.defaultFolder);
    routed.push({ conclusion: { ...conclusion, text }, folder, score: best?.score ?? 0 });
  }
  return routed;
}

function mergeConfidence(a: Confidence, b: Confidence): Confidence {
  const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
  return rank[a] <= rank[b] ? a : b;
}

function dirOf(relPath: string): string {
  const d = path.posix.dirname(relPath);
  return d === '.' ? '' : d;
}

/**
 * Choose the destination folder for a new page.
 *
 * Preference order: an explicit default folder, then the deepest existing
 * folder whose name appears in the text, then the root.
 */
export function inferFolder(
  store: KbStore,
  text: string,
  tags: string[],
  defaultFolder?: string,
): string {
  if (defaultFolder) return defaultFolder.replace(/^\/|\/$/g, '');

  const index = store.loadIndex();
  const folders = new Map<string, number>();
  for (const rel of Object.keys(index.entries)) {
    const segs = rel.split('/');
    for (let i = 1; i < segs.length; i++) {
      const folder = segs.slice(0, i).join('/');
      if (folder.startsWith('_archive')) continue;
      folders.set(folder, Math.max(folders.get(folder) ?? 0, i));
    }
  }
  if (folders.size === 0) return '';

  const tokens = new Set([...tokenize(text), ...tags.flatMap((t) => tokenize(t))]);
  let bestFolder = '';
  let bestScore = 0;
  for (const folder of folders.keys()) {
    const leaf = slugify(folder.split('/').pop()!);
    const score = [...tokens].filter((t) => t.includes(leaf) || leaf.includes(t)).length;
    if (score > bestScore) {
      bestScore = score;
      bestFolder = folder;
    }
  }
  if (bestFolder !== '' && bestScore >= 2) {
    const depth = bestFolder.split('/').length;
    if (depth <= store.cfg.maxDepth) return bestFolder;
  }
  return '';
}

/** Apply routed conclusions, collapsing to one write per page. */
export function applyRoutedConclusions(
  store: KbStore,
  routed: RoutedConclusion[],
  opts: { bulletsAsDetails?: boolean } = {},
): UpsertSummary {
  const byPage = new Map<string, Conclusion[]>();
  for (const r of routed) {
    const key = r.matchedPath ?? `<new>:${r.folder}`;
    const list = byPage.get(key) ?? [];
    list.push(r.conclusion);
    byPage.set(key, list);
  }

  const results: UpsertResult[] = [];
  const skipped: UpsertSummary['skipped'] = [];

  for (const [key, conclusions] of byPage) {
    const isNew = key.startsWith('<new>:');
    let relPath: string;
    let created = false;

    if (isNew) {
      const folder = key.slice('<new>:'.length);
      const first = conclusions[0]!;
      const title = deriveTitle(first.text);
      relPath = store.createPage(title, truncate(first.text, 180), first.tags ?? [], {
        parentDir: folder,
      });
      created = true;
    } else {
      relPath = key;
      // A caller-supplied target page may not exist yet; create it rather than
      // silently dropping the conclusion.
      if (!store.exists(relPath)) {
        const first = conclusions[0]!;
        store.createPage(deriveTitle(first.text), truncate(first.text, 180), first.tags ?? [], {
          parentDir: path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath),
          explicitName: path.posix.basename(relPath, '.md'),
        });
        created = true;
      }
    }

    const before = store.bytesOf(relPath);
    const doc = store.read(relPath);
    if (!doc) {
      for (const c of conclusions) skipped.push({ text: c.text, reason: 'page vanished' });
      continue;
    }

    const bullets = conclusions.map((c) => formatBullet(c));
    const section = ensureSection(doc, SECTION_CONCLUSIONS);

    // Supersession, two ways:
    //  - the agent declared it via `supersedes` (authoritative), or
    //  - the heuristic recognises a revised verdict on the same subject.
    // Either way the old bullet is struck through, never deleted.
    const superseded: Array<{ old: string; replacement: string }> = [];
    for (const incoming of conclusions) {
      if (incoming.supersedes) {
        const res = supersedeBullet(doc, incoming.supersedes, incoming.text);
        if (res.ok && res.matched) {
          superseded.push({ old: res.matched, replacement: incoming.text });
        } else if (res.reason) {
          skipped.push({ text: incoming.supersedes, reason: res.reason });
        }
        continue;
      }
      for (const line of section.lines) {
        if (!line.trim().startsWith('-') || line.includes('~~')) continue;
        const stored = bulletText(line);
        if (!findSupersession(incoming.text, stored)) continue;
        const res = supersedeBullet(doc, stored, incoming.text);
        if (res.ok && res.matched) superseded.push({ old: res.matched, replacement: incoming.text });
      }
    }

    const merge = mergeBullets(section, bullets);

    if (opts.bulletsAsDetails && conclusions.length > 0) {
      const details = ensureSection(doc, SECTION_DETAILS);
      mergeBullets(
        details,
        conclusions
          .filter((c) => c.evidence)
          .map((c) => `- ${c.evidence} → ${truncate(c.text, 140)}`),
      );
    }

    if (merge.added > 0 || superseded.length > 0) {
      doc.frontmatter.revision += 1;
      doc.frontmatter.updated = isoDate();
      if (created) doc.frontmatter.confidence = highestConfidence(conclusions);
      store.write(relPath, doc, { touch: false });
    }

    const compression = compressPage(store, relPath);
    results.push({
      path: relPath,
      created,
      addedLines: merge.added,
      mergedLines: merge.merged,
      compressed: compression.bytesAfter < compression.bytesBefore,
      bytesBefore: before,
      bytesAfter: store.bytesOf(relPath),
      revision: doc.frontmatter.revision,
      superseded,
    });
  }

  // Refresh index pages for every touched folder.
  const touched = new Set<string>();
  for (const r of results) {
    touched.add(r.path);
    store.syncParentIndex(r.path);
  }
  store.syncFolderIndex('');

  return { results, skipped, pagesTouched: [...touched] };
}

function formatBullet(c: Conclusion): string {
  const text = collapseWhitespace(c.text);
  const bits: string[] = [text.replace(/^[-*+]\s+/, '')];
  if (c.evidence && c.evidence !== 'inline') bits.push(`(${c.evidence})`);
  if (c.confidence !== 'high') bits.push(`_${c.confidence}_`);
  return `- ${bits.join(' ')}`;
}

/**
 * A page title from a conclusion: drop the decision prefix and any trailing
 * evidence parenthesis, then cut at the first clause boundary.
 */
function deriveTitle(text: string): string {
  const clean = collapseWhitespace(text)
    .replace(/\s*\((?=[^)]*(?:commit|issue|pr|mr|#|\d{4}-\d{2}-\d{2}))[^)]*\)\s*$/i, '')
    .replace(/\s*（[^）]*(?:commit|issue|pr|mr|#|\d{4}-\d{2}-\d{2})[^）]*）\s*$/i, '');
  const body = stripDecisionPrefix(clean);
  const cut = body.split(/[：:，,。.；;]/)[0] ?? body;
  const title = cut.length >= 4 ? cut : body;
  return truncate(title, 48);
}

function highestConfidence(cs: Conclusion[]): Confidence {
  const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
  let best: Confidence = 'low';
  for (const c of cs) if (rank[c.confidence] > rank[best]) best = c.confidence;
  return best;
}
