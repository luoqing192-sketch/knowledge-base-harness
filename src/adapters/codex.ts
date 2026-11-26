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
 *  - `notify` is a *top-level* key, and TOML cannot return to the root table:
 *    every key after a `[table]` header belongs to that table. Appending the
 *    block after `[notice.model_migrations]` made Codex read it as
 *    `notice.model_migrations.notify` — a sequence where a string was expected —
 *    and it refused to boot with "failed to load bootstrap configuration".
 *    Conversely, a block that *ends* with a table header absorbs whatever
 *    root-level keys follow it: that turned `disable_response_storage = true`
 *    into `mcp_servers.kb.env.disable_response_storage`.
 *    So the two halves are written separately: `notify` goes in a header-free
 *    block at the top of the file, the `[mcp_servers.kb]` tables go at the end.
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

    const notifyBlock = [
      `# >>> ${KB_MARKER} >>>`,
      `# Managed by knowledge-base-harness. Regenerate with: kb install codex`,
      '',
      // A table-free block that sits above every header in the file. TOML has
      // no root-table escape, so a top-level key can only exist before the
      // first `[...]`.
      `notify = [${tomlString(ctx.nodeBin)}, ${tomlString(ctx.cliEntry)}, "hook", "codex", "stop"]`,
      `# <<< ${KB_MARKER} <<<`,
      '',
    ].join('\n');

    // Tables must come *after* the user's root-level keys, and a block that
    // ends with a table header swallows everything after it — so this block is
    // appended at EOF, where nothing follows. It carries its own marker: one
    // marker cannot describe two separate positions in the file.
    const mcpBlock = [
      `# >>> ${KB_MARKER}-mcp >>>`,
      `# Managed by knowledge-base-harness. Regenerate with: kb install codex`,
      '',
      '[mcp_servers.kb]',
      `command = ${tomlString(ctx.nodeBin)}`,
      `args = [${tomlString(ctx.cliEntry)}, "mcp"]`,
      '',
      '[mcp_servers.kb.env]',
      `KB_ROOT = ${tomlString(ctx.kbRoot)}`,
      `KB_DATA_DIR = ${tomlString(ctx.dataDir)}`,
      `# <<< ${KB_MARKER}-mcp <<<`,
      '',
    ].join('\n');

    const out: InstallArtifact[] = [
      {
        path: effective,
        strategy: 'toml-root-insert',
        content: notifyBlock,
        marker: KB_MARKER,
        note: `Installs the turn-completion notify command at the top of ${effective}`,
      },
      {
        path: effective,
        strategy: 'toml-append',
        content: mcpBlock,
        marker: `${KB_MARKER}-mcp`,
        note: `Registers the kb MCP server in ${effective}`,
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
