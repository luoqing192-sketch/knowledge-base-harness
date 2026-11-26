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
  mcpServerSpec,
  obj,
  str,
} from './types.js';

/**
 * Qoder (Alibaba's agentic coding platform: IDE, JetBrains plugin, CLI).
 *
 * Verified against the published docs (`docs.qoder.com/zh/cli/hooks`), which
 * describe a hook contract that is deliberately close to Claude Code's:
 *
 *  - Hooks live in `settings.json` under a `hooks` object, keyed by event name,
 *    each entry `{ matcher?, hooks: [{ type: 'command', command, timeout? }] }`.
 *  - stdin is JSON with `hook_event_name`, `cwd`, `session_id`,
 *    `transcript_path`, `permission_mode`.
 *  - `UserPromptSubmit` / `SessionStart` may return
 *    `{"hookSpecificOutput":{"additionalContext":"..."}}`; plain stdout is also
 *    injected.
 *  - `PostToolUse` (matcher = tool name) receives `tool_name` / `tool_input` /
 *    `tool_response` and accepts `hookSpecificOutput.additionalContext` too,
 *    which is how a page reaches the agent for a file it opened.
 *  - `PreCompact` runs before context compaction. Its stdout becomes
 *    instructions for the summary, so we do NOT print on that event — we only
 *    flush the session's conclusions before the details are lost.
 *  - MCP servers: `<project>/.mcp.json` (project scope) or `~/.qoder/settings.json`.
 *
 * Config layering, lowest to highest priority: user `~/.qoder/settings.json`,
 * project `<project>/.qoder/settings.json`, local
 * `<project>/.qoder/settings.local.json`. Hooks merged from several layers all
 * fire, so writing to the project file is additive rather than overriding.
 */
export const qoderAdapter: HarnessAdapter = {
  id: 'qoder',
  displayName: 'Qoder',
  verified: true,
  capabilities: { hooks: true, mcp: true, rulesFile: '.qoder/rules/knowledge-base.md', configScope: 'both' },

  artifacts(ctx: AdapterContext, opts: InstallOptions): InstallArtifact[] {
    const home = homeDir(opts);
    const global = opts.scope === 'global';
    const base = opts.targetDir ?? (global ? path.join(home, '.qoder') : path.join(ctx.projectRoot, '.qoder'));
    const settingsPath = path.join(base, 'settings.json');

    const hook = (event: string) => ({
      type: 'command',
      command: hookCommand(ctx, 'qoder', event),
      timeout: 30,
    });

    const settings: Record<string, unknown> = {
      hooks: {
        SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [hook('start')] }],
        UserPromptSubmit: [{ hooks: [hook('prompt')] }],
        // Path-scoped knowledge: pages with `paths:` front matter are pushed the
        // moment the agent reads or writes a matching file, without waiting for
        // the prompt to mention it.
        PostToolUse: [{ matcher: 'Read|Write|Edit|MultiEdit', hooks: [hook('file')] }],
        // Compaction is where a long session loses detail, so flush first.
        PreCompact: [{ hooks: [hook('compact')] }],
        Stop: [{ hooks: [hook('stop')] }],
        SessionEnd: [{ matcher: 'clear|logout|prompt_input_exit|other', hooks: [hook('end')] }],
      },
    };
    // MCP server location follows the install scope, per the documented mapping:
    // user → `~/.qoder/settings.json`, project → `<project>/.mcp.json`. Writing a
    // project file during a global install would leak into whatever repo happens
    // to be the cwd.
    if (global) settings['mcpServers'] = { kb: mcpServerSpec(ctx) };

    const out: InstallArtifact[] = [
      {
        path: settingsPath,
        strategy: 'json-merge',
        content: JSON.stringify(settings, null, 2),
        marker: KB_MARKER,
        note: global
          ? 'Adds six hooks and the kb MCP server (user scope).'
          : 'Adds SessionStart / UserPromptSubmit / PostToolUse / PreCompact / Stop / SessionEnd hooks.',
      },
    ];

    if (!global) {
      out.push({
        path: path.join(ctx.projectRoot, '.mcp.json'),
        strategy: 'json-merge',
        content: JSON.stringify({ mcpServers: { kb: mcpServerSpec(ctx) } }, null, 2),
        marker: KB_MARKER,
        note: 'Registers the kb MCP server (project scope: ${project}/.mcp.json).',
      });
    }

    out.push({
      path: global
        ? path.join(base, 'rules', 'knowledge-base.md')
        : path.join(ctx.projectRoot, '.qoder', 'rules', 'knowledge-base.md'),
      strategy: 'text-append',
      content: rulesBlock(ctx),
      marker: KB_MARKER,
      note: 'Rule file: always-on, loaded at session start.',
    });
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
        return { kind: 'start', harness: 'qoder', cwd, transcriptPath, sessionId, raw };
      case 'UserPromptSubmit':
        return {
          kind: 'prompt',
          harness: 'qoder',
          cwd,
          transcriptPath,
          sessionId,
          prompt: str(o, 'prompt') ?? '',
          raw,
        };
      case 'PostToolUse': {
        const filePath = toolFilePath(o);
        if (!filePath) return null;
        return { kind: 'file', harness: 'qoder', cwd, transcriptPath, sessionId, filePath, raw };
      }
      case 'PreCompact':
        // Flush conclusions now; compaction is about to discard the detail.
        return { kind: 'compact', harness: 'qoder', cwd, transcriptPath, sessionId, raw };
      case 'Stop':
        return { kind: 'stop', harness: 'qoder', cwd, transcriptPath, sessionId, raw };
      case 'SessionEnd':
        return { kind: 'end', harness: 'qoder', cwd, transcriptPath, sessionId, raw };
      default:
        return null;
    }
  },

  formatOutput(event, body): string {
    // PreCompact is the one event where stdout means "instructions for the
    // summary", not "context to inject". Printing a knowledge dump there would
    // end up inside the compaction prompt.
    if (event.kind === 'compact') return '';
    if (event.kind === 'prompt' || event.kind === 'start' || event.kind === 'file') {
      if (!body.context) return '';
      if (event.kind === 'file') {
        return JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: body.context },
        });
      }
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

/** Pull the touched path out of a PostToolUse payload, if the tool took one. */
function toolFilePath(o: Record<string, unknown>): string | undefined {
  const input = obj(o['tool_input']);
  return (
    str(input, 'file_path') ??
    str(input, 'path') ??
    str(input, 'notebook_path') ??
    str(o, 'file_path')
  );
}

function rulesBlock(ctx: AdapterContext): string {
  return [
    `<!-- >>> ${KB_MARKER} >>> -->`,
    '# Personal knowledge base',
    '',
    `A markdown wiki lives at \`${ctx.kbRoot}\`, maintained by ${KB_MARKER}.`,
    'Long-term memory is injected into every turn; topic pages are recalled',
    'automatically and are also reachable through the `kb` MCP tools.',
    '',
    '- **Before answering anything about this project**, prefer the injected',
    '  knowledge base hits. If none cover the question, call `kb_query`.',
    '- **When a conclusion is settled** (verified, decided, reproduced), record it',
    '  with `kb_note`. Pass `supersedes` with the exact old text when revising, so',
    '  the old line is struck through instead of silently replaced.',
    '- **Durable facts that must hold in every conversation** go to `kb_memory`',
    '  (`memory` for the project, `user` for the person). That store is small and',
    '  has a hard character budget — procedures belong on a page instead.',
    '- Never write drafts, logs, TODOs or progress notes anywhere in the wiki.',
    `<!-- <<< ${KB_MARKER} <<< -->`,
    '',
  ].join('\n');
}
