import path from 'node:path';
import {
  type AdapterContext,
  type HarnessAdapter,
  type InstallArtifact,
  type InstallOptions,
  type KbHookEvent,
  KB_MARKER,
  homeDir,
  obj,
  str,
} from './types.js';

/**
 * OpenAI Codex CLI.
 *
 * Facts verified against codex-cli 0.163.0 on this machine:
 *  - Codex reads `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`).
 *  - It **ignores** a project-level `.codex/config.toml` for `mcp_servers`
 *    (`codex mcp list` shows nothing there), so installing into the repo alone
 *    is a no-op.
 *  - `notify` is a *top-level* key. TOML binds keys to the most recent table
 *    header, so placing it after `[mcp_servers.kb.env]` makes it
 *    `mcp_servers.kb.env.notify` and Codex fails to start.
 *  - There is no per-prompt hook, so recall happens through the MCP server.
 *
 * The AGENTS.md instruction block is the part that works everywhere; the TOML
 * is what makes the tool available at all.
 */
export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  displayName: 'OpenAI Codex CLI',
  verified: true,
  capabilities: { hooks: true, mcp: true, rulesFile: 'AGENTS.md', configScope: 'global' },

  artifacts(ctx: AdapterContext, opts: InstallOptions): InstallArtifact[] {
    // Resolution order, matching how Codex itself finds its config:
    //   explicit targetDir → this machine's CODEX_HOME → <home>/.codex
    // Codex ignores a project-level `.codex/config.toml` for mcp_servers, so
    // writing there would silently do nothing. `--scope project` is still
    // honoured when a caller insists.
    const envHome = process.env['CODEX_HOME']?.trim();
    const globalDir =
      !opts.home && envHome ? envHome : path.join(homeDir(opts), '.codex');
    const base =
      opts.targetDir ??
      (opts.scope === 'project' ? path.join(ctx.projectRoot, '.codex') : globalDir);
    const effective = path.join(base, 'config.toml');

    const toml = [
      `# >>> ${KB_MARKER} >>>`,
      `# Managed by knowledge-base-harness. Regenerate with: kb install codex`,
      '',
      // TOML attaches every following key to the most recent table header, so
      // top-level keys MUST come before the `[mcp_servers...]` tables. Putting
      // `notify` after them parses it as `mcp_servers.kb.env.notify` and Codex
      // refuses to start.
      `notify = [${tomlString(ctx.nodeBin)}, ${tomlString(ctx.cliEntry)}, "hook", "codex", "stop"]`,
      '',
      '[mcp_servers.kb]',
      `command = ${tomlString(ctx.nodeBin)}`,
      `args = [${tomlString(ctx.cliEntry)}, "mcp"]`,
      '',
      '[mcp_servers.kb.env]',
      `KB_ROOT = ${tomlString(ctx.kbRoot)}`,
      `KB_DATA_DIR = ${tomlString(ctx.dataDir)}`,
      `# <<< ${KB_MARKER} <<<`,
      '',
    ].join('\n');

    const out: InstallArtifact[] = [
      {
        path: effective,
        strategy: 'toml-append',
        content: toml,
        marker: KB_MARKER,
        note: `Registers the kb MCP server and a turn-completion notify command in ${effective}`,
      },
    ];

    out.push({
      path: path.join(ctx.projectRoot, 'AGENTS.md'),
      strategy: 'text-append',
      content: agentsBlock(ctx),
      marker: KB_MARKER,
      note: 'Instruction block telling the agent to consult the KB first.',
    });
    return out;
  },

  parsePayload(raw: unknown): KbHookEvent | null {
    // `notify` receives a JSON argument: {"type":"agent-turn-complete", ...}
    const o = obj(raw);
    const type = str(o, 'type');
    const cwd = str(o, 'cwd') ?? process.cwd();
    if (type === 'agent-turn-complete' || type === 'turn-complete') {
      return { kind: 'stop', harness: 'codex', cwd, raw };
    }
    if (type === 'session-start') {
      return { kind: 'start', harness: 'codex', cwd, raw };
    }
    // MCP / manual invocation shape.
    const kind = str(o, 'kind');
    if (kind === 'prompt' || kind === 'stop' || kind === 'end' || kind === 'start' || kind === 'note') {
      return {
        kind,
        harness: 'codex',
        cwd,
        prompt: str(o, 'prompt'),
        note: str(o, 'note'),
        raw,
      };
    }
    return null;
  },

  formatOutput(): string {
    // Codex does not inject hook stdout into the model context.
    return '';
  },
};

function tomlString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function agentsBlock(ctx: AdapterContext): string {
  return [
    `<!-- >>> ${KB_MARKER} >>> -->`,
    '## Knowledge base',
    '',
    `This project keeps a personal wiki under \`${ctx.kbRoot}\`, with an`,
    'always-injected memory folder at `memory/`.',
    '',
    '- **Before answering anything about this project**, query the wiki:',
    '  the `kb_query` MCP tool, or `kb recall "<question>"`.',
    '  Use `kb_index` first when you only need to know what exists — it lists',
    '  titles and summaries without paying for page bodies.',
    '- **Before editing a source file**, check whether the wiki has a page for it:',
    '  pages can scope themselves with `paths: ["src/api/**"]` front matter, and a',
    '  `kb_index` query on the file path surfaces them.',
    '- **When a conclusion is settled** (verified, decided, reproduced), record it',
    '  with `kb_note`. If it replaces an earlier conclusion, pass that exact text',
    '  as `supersedes` — the old line is struck through, never deleted.',
    '- **Durable facts that must be in every future conversation** (environment',
    '  quirks, standing conventions, how the user wants to be spoken to) belong in',
    '  `kb_memory`, target `memory` or `user`. Those stores are small and are',
    '  injected on every turn, so they have a hard character budget.',
    '- Task procedures and pitfalls belong in a wiki page, not in memory.',
    '- Never write transient notes, drafts, logs, TODOs or progress updates anywhere.',
    `<!-- <<< ${KB_MARKER} <<< -->`,
    '',
  ].join('\n');
}
