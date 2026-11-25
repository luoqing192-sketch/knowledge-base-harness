import { type HarnessId } from '../core/types.js';

export type { HarnessId };

/** Normalised hook event, produced by every adapter from its own payload shape. */
export interface KbHookEvent {
  kind: 'start' | 'prompt' | 'stop' | 'end' | 'note';
  harness: HarnessId;
  cwd: string;
  prompt?: string;
  transcriptPath?: string;
  sessionId?: string;
  /** Free-form conclusion passed by an agent calling the note hook. */
  note?: string;
  raw: unknown;
}

export interface AdapterContext {
  /** Project root that will own the knowledge folder and the config. */
  projectRoot: string;
  /** Directory holding this package (used to build absolute hook commands). */
  repoDir: string;
  nodeBin: string;
  cliEntry: string;
  kbRoot: string;
  dataDir: string;
}

export type ArtifactStrategy = 'json-merge' | 'text-append' | 'toml-append' | 'write' | 'command';

export interface InstallArtifact {
  /** Absolute path of the file to create or patch. */
  path: string;
  strategy: ArtifactStrategy;
  /** JSON text for `json-merge`, snippet text otherwise. */
  content: string;
  /**
   * For `strategy: 'command'`: the argv to run. Used when the harness owns its
   * own config format and editing it by hand is riskier than asking its CLI
   * (Claude Code stores MCP servers in `~/.claude.json`, a large state file).
   */
  argv?: string[];
  /** Sentinel comment so repeated installs stay idempotent. */
  marker?: string;
  note?: string;
}

export interface AdapterCapabilities {
  /** Harness exposes lifecycle hooks we can shell out from. */
  hooks: boolean;
  /** Harness can consume an MCP server for in-session recall. */
  mcp: boolean;
  /** A rules/instructions file the harness always loads into context. */
  rulesFile: string | null;
  /**
   * Where this harness reads MCP/hook config. `global` means a project-level file
   * is ignored, so installing into the repo would silently do nothing.
   */
  configScope: 'project' | 'global' | 'both';
}

export interface HarnessAdapter {
  id: HarnessId;
  displayName: string;
  capabilities: AdapterCapabilities;
  /**
   * True when the config paths below were confirmed against the product's
   * documentation. False means "convention"; callers can override paths with
   * `--target` and should verify before relying on it.
   */
  verified: boolean;
  artifacts(ctx: AdapterContext, opts: InstallOptions): InstallArtifact[];
  /** Normalise a hook payload received on stdin. */
  parsePayload(raw: unknown): KbHookEvent | null;
  /** stdout for a hook invocation (already JSON-encoded when needed). */
  formatOutput(event: KbHookEvent, body: { context?: string; message?: string }): string;
}

export interface InstallOptions {
  /** Override the harness config directory. */
  targetDir?: string;
  /** Only write the artifacts relevant to this capability. */
  withHooks?: boolean;
  /**
   * Where the harness actually reads its config from.
   *
   * Some harnesses only read a *global* config file (Codex, for one, ignores a
   * project-level `.codex/config.toml` — verified against codex-cli 0.163.0).
   * For those, `project` is a lie that silently does nothing, so the adapter
   * declares it and install picks the global path by default.
   */
  scope?: 'project' | 'global';
  /** Home directory to resolve global paths under (tests inject a temp home). */
  home?: string;
}

export const KB_MARKER = 'knowlege-base-harness';

/** Absolute command line for `kb <args>` that works regardless of cwd. */
export function hookCommand(ctx: AdapterContext, harness: HarnessId, event: string): string {
  return `${quote(ctx.nodeBin)} ${quote(ctx.cliEntry)} hook ${harness} ${event}`;
}

export function quote(s: string): string {
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

export function mcpServerSpec(ctx: AdapterContext) {
  return {
    command: ctx.nodeBin,
    args: [ctx.cliEntry, 'mcp'],
    env: {
      KB_ROOT: ctx.kbRoot,
      KB_DATA_DIR: ctx.dataDir,
    },
  };
}

/** Resolve a `~`-style config path against an injected home (tests) or the real one. */
export function homeDir(opts: InstallOptions): string {
  if (opts.home) return opts.home;
  return process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
}

/** Extract a string field from an untrusted payload object. */
export function str(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

export function obj(obj: unknown): Record<string, unknown> {
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : {};
}
