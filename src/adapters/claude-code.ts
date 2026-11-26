import path from 'node:path';
import {
  type AdapterContext,
  type HarnessAdapter,
  type InstallArtifact,
  type InstallOptions,
  type KbHookEvent,
  KB_MARKER,
  homeDir,
  hookCommand,
  obj,
  str,
} from './types.js';

/**
 * Claude Code.
 *
 * Verified against the documented hook contract:
 *  - settings: `.claude/settings.json` (project) or `~/.claude/settings.json`
 *  - hooks receive a JSON payload on stdin with `hook_event_name`, `cwd`,
 *    `session_id`, `transcript_path`, and (for prompts) `prompt`
 *  - `UserPromptSubmit` and `SessionStart` may print text on stdout, which is
 *    injected into the conversation as additional context
 *  - `Stop` / `SessionEnd` are fire-and-forget for our purposes; printing there
 *    is only useful for debugging
 *  - MCP servers: `.mcp.json` at the project root
 */
export const claudeCodeAdapter: HarnessAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  verified: true,
  capabilities: { hooks: true, mcp: true, rulesFile: 'CLAUDE.md', configScope: 'both' },

  artifacts(ctx: AdapterContext, opts: InstallOptions): InstallArtifact[] {
    const home = homeDir(opts);
    const global = opts.scope === 'global';
    // User-scope install: settings and MCP live under ~/.claude, and MCP goes in
    // through `claude mcp add --scope user` because ~/.claude.json is a large
    // state file the CLI itself rewrites.
    const base = opts.targetDir ?? (global ? path.join(home, '.claude') : path.join(ctx.projectRoot, '.claude'));
    const settingsPath = path.join(base, 'settings.json');

    // Codex and Claude both resolve  in hook commands inconsistently across
    // shells; an absolute node path is the only thing that works everywhere.
    const hook = (event: string) => ({
      type: 'command',
      command: hookCommand(ctx, 'claude-code', event),
      timeout: 30,
    });

    const settings = {
      hooks: {
        SessionStart: [{ matcher: 'startup|resume|clear', hooks: [hook('start')] }],
        UserPromptSubmit: [{ hooks: [hook('prompt')] }],
        Stop: [{ hooks: [hook('stop')] }],
        SessionEnd: [{ matcher: 'clear|logout|prompt_input_exit|other', hooks: [hook('end')] }],
      },
    };

    const out: InstallArtifact[] = [
      {
        path: settingsPath,
        strategy: 'json-merge',
        content: JSON.stringify(settings, null, 2),
        marker: KB_MARKER,
        note: 'Adds SessionStart / UserPromptSubmit / Stop / SessionEnd hooks.',
      },
    ];

    if (opts.withHooks !== false) {
      if (global) {
        out.push({
          path: 'claude mcp (user scope)',
          strategy: 'command',
          content: '',
          // Verified against claude 2.1.332: the server name comes immediately
          // after `add`, `-e` is variadic so each env var needs its own flag
          // *after* the name, and Windows paths must use forward slashes or
          // they lose their backslashes in the round trip.
          argv: [
            'claude',
            'mcp',
            'add',
            '--scope',
            'user',
            'kb',
            '-e',
            `KB_ROOT=${toForwardSlashes(ctx.kbRoot)}`,
            '-e',
            `KB_DATA_DIR=${toForwardSlashes(ctx.dataDir)}`,
            '--',
            ctx.nodeBin,
            toForwardSlashes(ctx.cliEntry),
            'mcp',
          ],
          note: 'Registers the kb MCP server for every project (`claude mcp list` to check).',
        });
      } else {
        out.push({
          path: path.join(ctx.projectRoot, '.mcp.json'),
          strategy: 'json-merge',
          content: JSON.stringify({ mcpServers: { kb: mcpEntry(ctx) } }, null, 2),
          marker: KB_MARKER,
          note: 'Registers the kb MCP server for in-session recall/notes.',
        });
      }
    }
    return out;
  },

  parsePayload(raw: unknown): KbHookEvent | null {
    const o = obj(raw);
    const name = str(o, 'hook_event_name') ?? str(o, 'event');
    const cwd = str(o, 'cwd') ?? process.cwd();
    const transcriptPath = str(o, 'transcript_path');
    const sessionId = str(o, 'session_id');

    switch (name) {
      case 'SessionStart':
        return { kind: 'start', harness: 'claude-code', cwd, transcriptPath, sessionId, raw };
      case 'UserPromptSubmit':
        return {
          kind: 'prompt',
          harness: 'claude-code',
          cwd,
          transcriptPath,
          sessionId,
          prompt: str(o, 'prompt') ?? '',
          raw,
        };
      case 'Stop':
        return { kind: 'stop', harness: 'claude-code', cwd, transcriptPath, sessionId, raw };
      case 'SessionEnd':
        return { kind: 'end', harness: 'claude-code', cwd, transcriptPath, sessionId, raw };
      default:
        return null;
    }
  },

  formatOutput(event, body): string {
    if (event.kind === 'prompt' || event.kind === 'start') {
      if (!body.context) return '';
      // additionalContext is the documented channel; plain stdout also works,
      // but the explicit form survives future changes to default behaviour.
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: event.kind === 'prompt' ? 'UserPromptSubmit' : 'SessionStart',
          additionalContext: body.context,
        },
      });
    }
    return '';
  },
};

export function mcpEntry(ctx: AdapterContext) {
  return {
    command: ctx.nodeBin,
    args: [ctx.cliEntry, 'mcp'],
    env: { KB_ROOT: ctx.kbRoot, KB_DATA_DIR: ctx.dataDir },
  };
}

/**
 * Windows paths survive `claude mcp add` only in forward-slash form; passing
 * backslashes through its arg parser strips them (`D:\a\b` → `D:ab`).
 */
export function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}
