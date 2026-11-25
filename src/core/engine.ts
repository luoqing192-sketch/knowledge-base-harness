import fs from 'node:fs';
import {
  type Conclusion,
  type CuratorReport,
  type HarnessId,
  type LintIssue,
  type MemoryOp,
  type MemoryResult,
  type MemoryTarget,
  type RecallHit,
  type SessionState,
  type UpsertSummary,
} from './types.js';
import { KbConfig, loadConfig } from './config.js';
import { KbStore } from './store.js';
import { SessionStore } from './session.js';
import { MemoryStore } from './memory.js';
import { recall, renderRecall } from './recall.js';
import { distillTranscript, extractExplicitNotes, judgeConclusion } from './distill.js';
import { applyRoutedConclusions, routeConclusions, type RoutedConclusion } from './router.js';import { compressAll, compressPage } from './compress.js';

import { readTranscript, findLatestTranscript } from './transcript.js';
import { lintKb, summariseIssues } from './lint.js';
import {
  applyPlans,
  planConsolidations,
  planWithLlm,
  renderCuratorReport,
  type CompleteFn,
} from './curator.js';
import {
  DEFAULT_DEMOTE,
  auditReferences,
  demoteDetails,
  findDetailHeavyPages,
  type DemoteResult,
} from './references.js';
import {
  StatsStore,
  evolveAfterSession,
  findDecayingPages,
  recordRecall,
  renderEvolutionReport,
  type EvolutionReport,
} from './evolve.js';
import { isoNow, truncate } from './text.js';

export interface EngineOptions {
  cwd: string;
  config?: Partial<KbConfig>;
}

export interface PromptResult {
  sessionId: string;
  hits: RecallHit[];
  context: string;
  /** Set when a memory store is nearly full, e.g. `MEMORY.md 3900/4000`. */
  memoryWarning: string;
}

export interface EndResult {
  sessionId: string;
  concluded: Conclusion[];
  dropped: Array<{ text: string; reason: string }>;
  summary: UpsertSummary | null;
  report: string;
  lintErrors: number;
  evolution: EvolutionReport | null;
}

/**
 * One place where every harness hook lands.
 *
 * Harness adapters are responsible only for translating their own event shape
 * into these four calls; all behaviour lives here so the six integrations cannot
 * drift apart.
 */
export class KbEngine {
  readonly store: KbStore;
  readonly sessions: SessionStore;
  readonly stats: StatsStore;
  readonly memory: MemoryStore;

  constructor(readonly cfg: KbConfig) {
    this.store = new KbStore(cfg);
    this.sessions = new SessionStore(this.store);
    this.stats = new StatsStore(cfg.dataDir);
    this.memory = new MemoryStore(this.store);
  }

  static open(opts: EngineOptions): KbEngine {
    const cfg = loadConfig(opts.cwd, opts.config ?? {});
    return new KbEngine(cfg);
  }

  /** Bootstrap the folder structure (idempotent). */
  init(): void {
    this.store.ensureLayout();
    this.memory.ensureLayout();
  }

  // -------------------------------------------------------------- lifecycle

  startSession(harness: HarnessId, cwd: string, transcriptPath?: string): SessionState {
    this.init();
    return this.sessions.mutate(() => {
      const activeId = this.sessions.activeId();
      if (activeId) {
        const existing = this.sessions.load(activeId);
        if (existing && existing.status === 'active' && existing.harness === harness) {
          return existing;
        }
        // A different harness took over without a clean stop.
        if (existing && existing.status === 'active') {
          existing.status = 'ended';
          existing.endedAt = isoNow();
          this.sessions.save(existing);
        }
      }
      return this.sessions.create(harness, cwd, transcriptPath);
    });
  }

  /**
   * Recall for a user prompt.
   *
   * The injected context is built in two tiers, the way Hermes structures it:
   *  1. **always-on memory** — small, hand-curated, injected on every prompt;
   *  2. **on-demand recall** — pages matched against this prompt.
   *
   * Also records the prompt on the session so the end-of-session pass knows what
   * the user actually cared about.
   */
  onPrompt(harness: HarnessId, prompt: string, cwd: string): PromptResult {
    this.init();
    const text = prompt.trim();
    const session = this.sessions.mutate(() =>
      this.sessions.ensureActive(harness, cwd),
    );

    const memoryBlock = this.cfg.injectMemory ? this.memoryBlock() : '';

    if (text.length < this.cfg.minPromptCharsForRecall) {
      return { sessionId: session.id, hits: [], context: memoryBlock, memoryWarning: '' };
    }

    const notes = extractExplicitNotes(text);
    if (notes.length > 0) {
      this.sessions.mutate(() => {
        for (const n of notes) {
          session.notes.push({
            text: n.text,
            source: 'note',
            confidence: n.confidence,
            at: isoNow(),
            ...(n.evidence ? { evidence: n.evidence } : {}),
          });
        }
        this.sessions.save(session);
      });
    }

    const hits = recall(this.store, text, { limit: 5 });
    const recallBlock = renderRecall(hits, { maxChars: 3500 });
    const context = [memoryBlock, recallBlock].filter((b) => b !== '').join('\n\n');

    if (hits.length > 0) {
      recordRecall(this.stats, hits);
      this.stats.save();
    }

    this.sessions.mutate(() => {
      session.prompts.push({ at: isoNow(), text: truncate(text, 500), hitPaths: hits.map((h) => h.path) });
      this.sessions.save(session);
    });

    return {
      sessionId: session.id,
      hits,
      context,
      memoryWarning: this.memoryWarning(),
    };
  }

  /** Always-on memory text, with a usage line the agent can act on. */
  private memoryBlock(): string {
    const usage = this.memory.usage();
    const body = this.memory.renderForPrompt();
    if (body === '') return '';
    const warning = usage.pressure >= this.cfg.memoryPressureThreshold
      ? '\n\n> Memory is nearly full — prune stale entries with `kb memory remove --target memory --old "<text>"` before adding more.'
      : '';
    return body + warning;
  }

  private memoryWarning(): string {
    const usage = this.memory.usage();
    if (usage.pressure < this.cfg.memoryPressureThreshold) return '';
    const full =
      usage.memory.used / usage.memory.limit >= this.cfg.memoryPressureThreshold
        ? `MEMORY.md ${usage.memory.used}/${usage.memory.limit}`
        : '';
    const userFull =
      usage.user.used / usage.user.limit >= this.cfg.memoryPressureThreshold
        ? `USER.md ${usage.user.used}/${usage.user.limit}`
        : '';
    return [full, userFull].filter(Boolean).join(', ');
  }

  /** Read or write the always-injected memory stores. */
  applyMemory(target: MemoryTarget, ops: MemoryOp[]): MemoryResult {
    this.init();
    return this.memory.apply(target, ops);
  }

  memoryView(target: MemoryTarget) {
    return this.memory.read(target);
  }

  /** Forget the active session marker without distilling (e.g. /clear). */
  dropSession(): void {
    this.sessions.mutate(() => {
      const id = this.sessions.activeId();
      if (!id) return;
      const state = this.sessions.load(id);
      if (state) {
        state.status = 'ended';
        state.endedAt = isoNow();
        this.sessions.save(state);
      }
      this.sessions.clearActive();
    });
  }

  /**
   * End the session: distil, route, write, compress, lint.
   *
   * `transcriptPath` may be given explicitly by a harness Stop hook; otherwise
   * the recorded path is used, then a harness-specific discovery fallback.
   */
  endSession(opts: {
    harness?: HarnessId;
    cwd: string;
    transcriptPath?: string;
    extraConclusions?: string[];
    dryRun?: boolean;
    /** Set false to skip the promotion/decay pass (used by tests and dry runs). */
    evolve?: boolean;
    /** Set false to skip demoting heavy detail into reference pages. */
    demote?: boolean;
  }): EndResult {
    this.init();
    const state = this.sessions.mutate(() => {
      const id = this.sessions.activeId();
      let s = id ? this.sessions.load(id) : null;
      if (!s || s.status !== 'active') {
        s = this.sessions.latestActiveOrRecent();
      }
      return s;
    });

    const sessionId = state?.id ?? 'none';
    const harness = opts.harness ?? state?.harness ?? 'generic';
    const transcript = resolveTranscript(opts.transcriptPath, state, harness, opts.cwd);

    const candidates: Conclusion[] = [];
    const dropped: EndResult['dropped'] = [];

    if (state) {
      candidates.push(...state.notes);
      for (const prompt of state.prompts) {
        const notes = extractExplicitNotes(prompt.text);
        for (const n of notes) {
          candidates.push({
            text: n.text,
            source: 'note',
            confidence: n.confidence,
            at: prompt.at,
            ...(n.evidence ? { evidence: n.evidence } : {}),
          });
        }
      }
    }

    if (transcript) {
      const parsed = readTranscript(transcript);
      const distilled = distillTranscript(parsed.messages);
      for (const d of distilled) {
        candidates.push({
          text: d.text,
          source: d.source,
          confidence: d.confidence,
          at: isoNow(),
          ...(d.evidence ? { evidence: d.evidence } : {}),
        });
      }
    }

    for (const extra of opts.extraConclusions ?? []) {
      // Caller-supplied conclusions get the same scrutiny as distilled ones; an
      // agent that says "maybe X" must not be able to write X into the wiki.
      const verdict = judgeConclusion(extra);
      if (!verdict.accepted) {
        dropped.push({ text: extra, reason: verdict.reason });
        continue;
      }
      candidates.push({ text: extra, source: 'agent', confidence: verdict.confidence, at: isoNow() });
    }

    const accepted: Conclusion[] = [];
    const seen = new Set<string>();
    const rank: Record<Conclusion['confidence'], number> = { low: 0, medium: 1, high: 2 };
    const floor = rank[this.cfg.minConclusionConfidence];
    for (const c of candidates) {
      const key = c.text.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seen.has(key)) continue;
      seen.add(key);
      if (rank[c.confidence] < floor) {
        dropped.push({ text: c.text, reason: `confidence ${c.confidence} below threshold` });
        continue;
      }
      accepted.push(c);
    }

    let summary: UpsertSummary | null = null;
    let evolution: EvolutionReport | null = null;
    let demoted: DemoteResult[] = [];
    if (!opts.dryRun && accepted.length > 0) {
      const routed: RoutedConclusion[] = routeConclusions(this.store, accepted);
      summary = applyRoutedConclusions(this.store, routed);
      for (const r of summary.results) {
        if (state && !state.touched.includes(r.path)) {
          this.sessions.mutate(() => {
            if (!state.touched.includes(r.path)) state.touched.push(r.path);
          });
        }
        this.stats.bump(r.path, 'writes');
        for (const s of r.superseded) {
          this.stats.bump(r.path, 'contradictions');
          void s;
        }
      }
      // Keep the pages this session touched readable: a page that grew a long
      // detail section hands it to a reference page, staying lossless and
      // leaving the evidence in the index.
      if (opts.demote !== false) {
        demoted = this.demoteOverflowingPages([...new Set(summary.pagesTouched)]);
      }
      if (opts.evolve !== false) {
        evolution = evolveAfterSession(this.store, this.stats);
      }
      this.stats.save();
    } else if (opts.dryRun) {
      const routed = routeConclusions(this.store, accepted);
      for (const r of routed) {
        dropped.push({ text: r.conclusion.text, reason: `would write to ${r.matchedPath ?? '(new page)'}` });
      }
    }

    const lint = lintKb(this.store);
    const { errors } = summariseIssues(lint);

    if (state) {
      this.sessions.mutate(() => {
        state.status = 'ended';
        state.endedAt = isoNow();
        this.sessions.save(state);
        this.sessions.clearActive();
      });
    }

    const report = renderEndReport({
      sessionId,
      accepted,
      dropped: dropped.filter((d) => !d.reason.startsWith('would write')),
      summary,
      lint,
    }) + (evolution ? '\n' + renderEvolutionReport(evolution) : '') +
      (demoted.length > 0
        ? '\n' + demoted.map((d) => `  demoted ${d.page} detail → ${d.reference} (${d.bytesBefore}B → ${d.bytesAfter}B)`).join('\n')
        : '');

    return { sessionId, concluded: accepted, dropped, summary, report, lintErrors: errors, evolution };
  }

  // -------------------------------------------------------------- utilities

  recallQuery(query: string, limit = 6): { hits: RecallHit[]; context: string } {
    const hits = recall(this.store, query, { limit });
    if (hits.length > 0) {
      recordRecall(this.stats, hits);
      this.stats.save();
    }
    return { hits, context: renderRecall(hits) };
  }

  addManualConclusions(
    bullets: string[],
    targetPath?: string,
    supersedes?: string,
  ): UpsertSummary {
    const conclusions: Conclusion[] = bullets.map((b) => ({
      text: b,
      source: 'manual',
      confidence: 'high',
      at: isoNow(),
      ...(supersedes ? { supersedes } : {}),
    }));
    const routed = routeConclusions(this.store, conclusions, targetPath ? { targetPath } : {});
    return applyRoutedConclusions(this.store, routed);
  }

  compress(target?: string): Array<{ path: string; before: number; after: number }> {
    if (target) {
      const r = compressPage(this.store, target, true);
      return [{ path: r.path, before: r.bytesBefore, after: r.bytesAfter }];
    }
    return compressAll(this.store);
  }

  /**
   * Demote detail out of the pages this session touched.
   *
   * Scoped to touched pages rather than the whole wiki: demoting is lossless but
   * it rewrites two files, and a session should not quietly restructure pages it
   * never looked at. Archiving inside `compressPage` still only happens when a
   * page is over the hard limit.
   */
  private demoteOverflowingPages(pages: string[]): DemoteResult[] {
    const out: DemoteResult[] = [];
    for (const page of pages) {
      const res = demoteDetails(this.store, page);
      if (res) out.push(res);
    }
    return out;
  }

  doctor(fix = false): { issues: LintIssue[]; fixed: string[] } {
    const fixed: string[] = [];
    if (fix) {
      fixed.push(...this.store.quarantineIllegal());
      fixed.push(...this.store.pruneEmptyDirs());
      // Rebuild folder indices bottom-up.
      const dirs = new Set<string>(['']);
      for (const rel of this.store.scan().files) {
        const segs = rel.split('/');
        for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
      }
      for (const d of [...dirs].sort((a, b) => b.length - a.length)) this.store.syncFolderIndex(d);
    }
    return { issues: lintKb(this.store), fixed };
  }

  /**
   * Run a self-evolution pass on demand. Promotions are automatic; supersession
   * happens during writes; decay is only *reported* here — pruning a page is a
   * human decision that `kb doctor` never makes on its own.
   */
  evolve(opts: { minOccurrences?: number; coldAfterDays?: number } = {}): {
    report: EvolutionReport;
    text: string;
  } {
    const report = evolveAfterSession(this.store, this.stats, {
      promoteMinOccurrences: opts.minOccurrences,
      coldAfterDays: opts.coldAfterDays,
    });
    return { report, text: renderEvolutionReport(report) };
  }

  /** Pages that are cold and unused — candidates for manual archiving. */
  stalePages(days = 120): Array<{ page: string; daysSinceRecall: number; weight: number }> {
    return findDecayingPages(this.store, this.stats, { coldAfterDays: days });
  }

  /**
   * Demote a page's `## 细节` into a live reference page, leaving a link behind.
   *
   * Defaults to a dry run over every page above the threshold so `kb demote`
   * without arguments shows the work before doing it.
   */
  demote(opts: {
    page?: string;
    apply?: boolean;
    minDetailChars?: number;
    force?: boolean;
  } = {}): {
    candidates: Array<{ page: string; detailChars: number; bytes: number }>;
    results: DemoteResult[];
    text: string;
  } {
    this.init();
    const threshold = opts.minDetailChars ? { minDetailChars: opts.minDetailChars } : {};

    const candidates = opts.page
      ? findDetailHeavyPages(this.store, { ...threshold, force: true, minDetailChars: 1 }).filter(
          (c) => c.page === opts.page,
        )
      : findDetailHeavyPages(this.store, threshold);

    const results: DemoteResult[] = [];
    if (opts.apply) {
      const targets = opts.page ? [opts.page] : candidates.map((c) => c.page);
      for (const page of targets) {
        const res = demoteDetails(this.store, page, {
          ...threshold,
          ...(opts.force ? { force: true } : {}),
        });
        if (res) results.push(res);
      }
    }

    const lines: string[] = [`knowlege-base-harness: demote — ${candidates.length} page(s) with heavy details`];
    if (candidates.length === 0) {
      lines.push(`  nothing above minDetailChars=${opts.minDetailChars ?? DEFAULT_DEMOTE.minDetailChars}`);
    }
    for (const c of candidates) {
      lines.push(`  ${opts.apply ? 'moved' : 'would move'} ${c.page} (${c.detailChars} chars of detail, ${c.bytes}B page)`);
    }
    for (const r of results) {
      lines.push(`    → ${r.reference} (+${r.linesMoved} lines, ${r.bytesBefore}B → ${r.bytesAfter}B)`);
    }
    if (!opts.apply && candidates.length > 0) lines.push('  (dry run — re-run with --apply to write)');

    return { candidates, results, text: lines.join('\n') };
  }

  /** Reference pages whose source page no longer exists. */
  orphanReferences(): Array<{ reference: string; source: string | null; orphan: boolean }> {
    return auditReferences(this.store).filter((r) => r.orphan);
  }

  /**
   * Consolidate narrow sibling pages into umbrella pages.
   *
   * Dry run by default: the plan is what a human reviews before anything moves.
   * With `apply`, sources are archived (never deleted) and `absorbedInto` records
   * the direction. `complete` is an optional model hook; when supplied its plans
   * go through the same validation as the rule-based ones.
   */
  async curate(opts: {
    apply?: boolean;
    minClusterSize?: number;
    complete?: CompleteFn;
  } = {}): Promise<{
    report: CuratorReport;
    rejected: Array<{ reason: string; plan: unknown }>;
    text: string;
  }> {
    this.init();
    const curatorOpts = opts.minClusterSize ? { minClusterSize: opts.minClusterSize } : {};

    let report: CuratorReport;
    let rejected: Array<{ reason: string; plan: unknown }> = [];

    if (opts.complete) {
      const llm = await planWithLlm(this.store, opts.complete, curatorOpts);
      report = llm.report;
      rejected = llm.rejected;
    } else {
      report = planConsolidations(this.store, curatorOpts);
    }

    if (opts.apply && report.plans.length > 0) {
      report.applied = applyPlans(this.store, report.plans);
    }

    const text = [
      renderCuratorReport(report, Boolean(opts.apply)),
      ...rejected.map((r) => `  rejected model plan (${r.reason})`),
    ].join('\n');
    return { report, rejected, text };
  }

  tree(): string {
    const index = this.store.loadIndex();
    const entries = Object.keys(index.entries).sort();
    const lines: string[] = [];
    for (const rel of entries) {
      const depth = rel.split('/').length - 1;
      const meta = index.entries[rel]!.meta;
      lines.push(`${'  '.repeat(depth)}- ${rel}  — ${truncate(meta.frontmatter.summary, 70)}`);
    }
    return lines.join('\n');
  }
}

/**
 * Pick the transcript to distil.
 *
 * Discovery is guarded: a transcript is only used when it starts after the
 * session did and, for cwd-scoped harnesses, was written under this project.
 * Without those checks a Stop hook happily distils an unrelated older session.
 */
function resolveTranscript(
  explicit: string | undefined,
  state: SessionState | null,
  harness: HarnessId,
  cwd: string,
): string | undefined {
  if (explicit) return explicit;
  if (state?.transcriptPath) return state.transcriptPath;
  const found = findLatestTranscript(harness, cwd);
  if (!found) return undefined;

  let st: import('node:fs').Stats;
  try {
    st = fs.statSync(found);
  } catch {
    return undefined;
  }
  if (state) {
    const started = Date.parse(state.startedAt);
    if (Number.isFinite(started) && st.mtimeMs < started) return undefined;
  }
  return found;
}

function renderEndReport(input: {
  sessionId: string;
  accepted: Conclusion[];
  dropped: Array<{ text: string; reason: string }>;
  summary: UpsertSummary | null;
  lint: LintIssue[];
}): string {
  const lines: string[] = [];
  const touch = input.summary?.pagesTouched ?? [];
  lines.push(`knowlege-base-harness: session ${input.sessionId} closed`);
  lines.push(`  conclusions kept: ${input.accepted.length}`);
  if (input.dropped.length > 0) lines.push(`  conclusions dropped: ${input.dropped.length}`);
  if (touch.length > 0) {
    lines.push('  pages updated:');
    for (const r of input.summary?.results ?? []) {
      const flag = r.created ? 'new' : 'edit';
      lines.push(
        `    - ${r.path} (${flag}, +${r.addedLines}${r.mergedLines ? `, ${r.mergedLines} dup` : ''}${r.compressed ? ', compressed' : ''}, ${r.bytesAfter}B)`,
      );
    }
  } else if (input.accepted.length === 0) {
    lines.push('  no settled conclusions — knowledge base untouched');
  }
  const { errors, warnings } = summariseIssues(input.lint);
  if (errors > 0 || warnings > 0) {
    lines.push(`  lint: ${errors} error(s), ${warnings} warning(s) — run \`kb doctor\``);
  }
  return lines.join('\n');
}
