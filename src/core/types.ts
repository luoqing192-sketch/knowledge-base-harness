/**
 * Core domain types for knowlege-base-harness.
 *
 * The knowledge base itself is *only* markdown files laid out as a wiki tree.
 * Everything else (session logs, caches, locks, quarantined junk) lives in the
 * data directory, never inside the KB root.
 */

export type HarnessId =
  | 'claude-code'
  | 'codex'
  | 'qoder'
  | 'workbuddy'
  | 'trae'
  | 'dsh'
  | 'generic';

export type Confidence = 'high' | 'medium' | 'low';

/** Frontmatter carried by every page in the KB. */
export interface DocFrontmatter {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  /** 1-based depth below the KB root. depth 0 = root index. */
  level: number;
  /** Slug of the parent folder, "-" for the root page. */
  parent: string;
  created: string;
  updated: string;
  revision: number;
  confidence: Confidence;
  /**
   * Set on an archived page when a consolidation folded it into an umbrella.
   * Makes the direction machine-readable instead of living only in prose.
   */
  absorbedInto?: string;
  /**
   * Set on a reference page: the wiki page whose long form it holds. The reverse
   * of `absorbedInto`, and likewise machine-readable so an orphaned reference can
   * be detected instead of discovered by accident.
   */
  derivedFrom?: string;
}

export interface Section {
  /** Heading text without the leading ## markers. */
  heading: string;
  /** Heading depth (2 for `##`, 3 for `###`). */
  depth: number;
  /** Body lines belonging to this heading, without the heading itself. */
  lines: string[];
}

export interface ParsedDoc {
  frontmatter: DocFrontmatter;
  /** `# Title` line if present (kept verbatim so hand edits survive). */
  titleLine: string | null;
  /** Preamble between the H1 and the first `##` section. */
  preamble: string[];
  sections: Section[];
}

export interface DocMeta {
  /** Path relative to the KB root, always posix style (`a/b/c.md`). */
  path: string;
  /** Absolute path on disk. */
  absolute: string;
  frontmatter: DocFrontmatter;
  headings: string[];
  /** Cached plain text used for lexical scoring. */
  text: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface RecallHit {
  path: string;
  title: string;
  summary: string;
  tags: string[];
  score: number;
  /** Best matching excerpt(s), already trimmed for context injection. */
  snippets: string[];
  /** True when the page is a folder index rather than a leaf topic page. */
  isIndex: boolean;
}

export interface Conclusion {
  /** One-sentence statement of the conclusion. */
  text: string;
  /** Where it came from: explicit note, transcript distillation, or agent call. */
  source: 'note' | 'transcript' | 'agent' | 'manual';
  confidence: Confidence;
  /** Optional citation, e.g. commit sha, ticket id, file path. */
  evidence?: string;
  /** ISO timestamp. */
  at: string;
  /** Optional tags inferred from the statement. */
  tags?: string[];
  /**
   * Exact text of an earlier conclusion this one replaces. Declared by the agent
   * rather than inferred, which is how a revision is distinguished from a new
   * fact that merely looks similar.
   */
  supersedes?: string;
}

export interface SessionState {
  id: string;
  harness: HarnessId;
  startedAt: string;
  endedAt?: string;
  cwd: string;
  transcriptPath?: string;
  prompts: Array<{ at: string; text: string; hitPaths: string[] }>;
  notes: Conclusion[];
  /** Docs touched by this session, used for the end-of-session report. */
  touched: string[];
  status: 'active' | 'ended';
}

export interface RecallOptions {
  limit?: number;
  cwd?: string;
  /** Include folder index pages in results. */
  includeIndex?: boolean;
  /** Include `_archive` pages (off by default: they are historical). */
  includeArchive?: boolean;
  minScore?: number;
}

export interface UpsertRequest {
  /** Target page path (relative to KB) or a folder slug when creating anew. */
  path?: string;
  title?: string;
  summary?: string;
  tags?: string[];
  conclusions: string[];
  confidence?: Confidence;
  evidence?: string;
  source?: Conclusion['source'];
}

export interface UpsertResult {
  path: string;
  created: boolean;
  addedLines: number;
  mergedLines: number;
  compressed: boolean;
  bytesBefore: number;
  bytesAfter: number;
  revision: number;
  /** Conclusions that replaced an older, contradictory bullet on the page. */
  superseded: Array<{ old: string; replacement: string }>;
}

export interface UpsertSummary {
  results: UpsertResult[];
  skipped: Array<{ text: string; reason: string }>;
  pagesTouched: string[];
}

export interface LintIssue {
  level: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
}

export interface GuardResult {
  ok: boolean;
  issues: LintIssue[];
}

// ------------------------------------------------------------------- memory

/** `memory` = durable project facts, `user` = the user's own profile. */
export type MemoryTarget = 'memory' | 'user';

export interface MemoryOp {
  action: 'add' | 'patch' | 'remove';
  content?: string;
  /** Exact (normalised) text to find for `patch` / `remove`. */
  old_text?: string;
  /** Which `## section` an `add` lands in; derived from content when omitted. */
  section?: string;
}

export interface MemoryEntry {
  section: string;
  text: string;
}

export interface MemoryResult {
  ok: boolean;
  target: MemoryTarget;
  used: number;
  limit: number;
  entries: MemoryEntry[];
  applied: number;
  error?: string;
}

// ------------------------------------------------------------------ curator

export interface ConsolidationPlan {
  /** Path of the umbrella page to create. */
  umbrella: string;
  title: string;
  /** Pages that will be absorbed (and archived, never deleted). */
  sources: string[];
  reason: string;
  projectedBytes: number;
}

export interface AppliedConsolidation {
  umbrella: string;
  archived: Array<{ from: string; to: string }>;
  bullets: number;
}

export interface CuratorReport {
  considered: number;
  plans: ConsolidationPlan[];
  skipped: Array<{ sources: string[]; reason: string }>;
  applied: AppliedConsolidation[];
}
