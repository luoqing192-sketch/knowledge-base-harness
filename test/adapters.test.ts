import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ADAPTERS, getAdapter } from '../src/adapters/index.js';
import { applyArtifact, hasMarker, removeArtifact } from '../src/adapters/apply.js';
import { type AdapterContext } from '../src/adapters/types.js';
import { sandbox, type Sandbox } from './helpers.js';
import {
  CLAUDE_CODE_PROMPT,
  CLAUDE_CODE_SESSION_START,
  CLAUDE_CODE_STOP,
  CODEX_TURN_COMPLETE,
  GENERIC_PROMPT,
} from './fixtures.js';

let sb: Sandbox;
let ctx: AdapterContext;

beforeEach(() => {
  sb = sandbox();
  ctx = {
    projectRoot: sb.root,
    repoDir: path.join(sb.root, 'repo'),
    nodeBin: process.execPath,
    cliEntry: path.join(sb.root, 'repo', 'dist', 'cli.js'),
    kbRoot: sb.kbRoot,
    dataDir: sb.dataDir,
  };
});

afterEach(() => {
  sb.cleanup();
});

describe('adapter registry', () => {
  it('exposes every harness the task requires', () => {
    const ids = ADAPTERS.map((a) => a.id);
    for (const expected of ['claude-code', 'codex', 'qoder', 'workbuddy', 'trae', 'dsh']) {
      expect(ids).toContain(expected);
    }
  });

  it('rejects unknown harnesses with a helpful message', () => {
    expect(() => getAdapter('nope')).toThrow(/unknown harness/);
  });
});

describe('claude-code adapter', () => {
  it('installs hooks and an MCP server', () => {
    const artifacts = getAdapter('claude-code').artifacts(ctx, {});
    for (const a of artifacts) applyArtifact(a);

    const settings = JSON.parse(
      fs.readFileSync(path.join(sb.root, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(settings.hooks).sort()).toEqual(
      ['PostToolUse', 'PreCompact', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort(),
    );

    const mcp = JSON.parse(fs.readFileSync(path.join(sb.root, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(mcp.mcpServers.kb!.args).toEqual([ctx.cliEntry, 'mcp']);
  });

  it('never destroys a user hook entry on reinstall', () => {
    const settingsPath = path.join(sb.root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
        permissions: { allow: ['Bash(ls)'] },
      }),
    );

    for (const a of getAdapter('claude-code').artifacts(ctx, {})) applyArtifact(a);
    for (const a of getAdapter('claude-code').artifacts(ctx, {})) applyArtifact(a);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
      permissions: { allow: string[] };
    };
    const commands = settings.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toContain('echo mine');
    // Installed twice, but the kb hook appears exactly once.
    expect(commands.filter((c) => c.includes('knowledge-base-harness') || c.includes('cli.js')).length).toBe(1);
    expect(settings.permissions.allow).toEqual(['Bash(ls)']);
  });

  it('refuses to rewrite a settings file it cannot parse', () => {
    const settingsPath = path.join(sb.root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '// jsonc with comments\n{ "a": 1 }');
    const artifacts = getAdapter('claude-code').artifacts(ctx, {});
    const applied = applyArtifact(artifacts[0]!);
    expect(applied.action).toBe('unchanged');
    expect(fs.readFileSync(settingsPath, 'utf8')).toContain('jsonc with comments');
  });

  it('parses documented payload shapes', () => {
    const adapter = getAdapter('claude-code');
    expect(adapter.parsePayload(CLAUDE_CODE_SESSION_START)?.kind).toBe('start');
    const prompt = adapter.parsePayload(CLAUDE_CODE_PROMPT);
    expect(prompt?.kind).toBe('prompt');
    expect(prompt?.prompt).toContain('库存扣减');
    expect(adapter.parsePayload(CLAUDE_CODE_STOP)?.kind).toBe('stop');
    expect(adapter.parsePayload({ hook_event_name: 'PreToolUse' })).toBeNull();
  });

  it('emits additionalContext JSON for prompts', () => {
    const adapter = getAdapter('claude-code');
    const out = adapter.formatOutput(
      { kind: 'prompt', harness: 'claude-code', cwd: '.', raw: {} },
      { context: 'hello' },
    );
    const parsed = JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } };
    expect(parsed.hookSpecificOutput.additionalContext).toBe('hello');
  });
});

describe('codex adapter', () => {
  it('writes a TOML block wrapped in markers', () => {
    const artifacts = getAdapter('codex').artifacts(ctx, { home: sb.root });
    for (const a of artifacts) applyArtifact(a);
    const toml = fs.readFileSync(path.join(sb.root, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('[mcp_servers.kb]');
    expect(toml).toContain('>>> knowledge-base-harness >>>');
    // Codex reads the global config; the project-level file is ignored.
  });

  it('replaces rather than duplicates the marker block on reinstall', () => {
    for (let i = 0; i < 3; i++) {
      for (const a of getAdapter('codex').artifacts(ctx, { home: sb.root })) applyArtifact(a);
    }
    const toml = fs.readFileSync(path.join(sb.root, '.codex', 'config.toml'), 'utf8');
    expect(toml.match(/\[mcp_servers\.kb\]/g)).toHaveLength(1);
    const agents = fs.readFileSync(path.join(sb.root, 'AGENTS.md'), 'utf8');
    expect(agents.match(/## Knowledge base/g)).toHaveLength(1);
  });

  // TOML has no root-table escape: a key after any `[table]` header belongs to
  // that table. Codex reads `notify` as a string, so an appended block turned
  // our array into `notice.model_migrations.notify` and codex refused to start:
  //   invalid type: sequence, expected a string
  it('keeps top-level keys above every table header', () => {
    const configPath = path.join(sb.root, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'model = "gpt-6.1-terra"\n\ndisable_response_storage = true\n\n[notice]\nhide_world_writable_warning = true\n\n[notice.model_migrations]\n"gpt-5.6-sol" = "gpt-6-sol"\n');

    for (const a of getAdapter('codex').artifacts(ctx, { home: sb.root })) applyArtifact(a);

    const lines = fs.readFileSync(configPath, 'utf8').split('\n');
    const notifyLine = lines.findIndex((l) => l.startsWith('notify = ['));
    const firstHeader = lines.findIndex((l) => l.startsWith('['));
    expect(notifyLine).toBeGreaterThanOrEqual(0);
    expect(firstHeader).toBeGreaterThanOrEqual(0);
    expect(notifyLine).toBeLessThan(firstHeader);

    // The table block must sit at EOF: a trailing `[table]` header absorbs every
    // root-level key after it, which is how `disable_response_storage = true`
    // once ended up as `mcp_servers.kb.env.disable_response_storage`.
    const lastContent = lines.filter((l) => l.trim() !== '').at(-1);
    expect(lastContent).toBe('# <<< knowledge-base-harness-mcp <<<');
    const envHeader = lines.indexOf('[mcp_servers.kb.env]');
    const rootKey = lines.findIndex((l) => l.startsWith('disable_response_storage'));
    expect(rootKey).toBeGreaterThanOrEqual(0);
    expect(rootKey).toBeLessThan(envHeader);

    // User content survives, and a second run does not stack blocks.
    expect(lines.join('\n')).toContain('"gpt-5.6-sol" = "gpt-6-sol"');
    for (const a of getAdapter('codex').artifacts(ctx, { home: sb.root })) applyArtifact(a);
    const again = fs.readFileSync(configPath, 'utf8');
    expect(again).toBe(lines.join('\n'));
    expect(again.match(/>>> knowledge-base-harness >>>/g)).toHaveLength(1);
    expect(again.match(/^notify = \[/gm)).toHaveLength(1);
  });

  it('migrates the old single-block install, which was appended at EOF', () => {
    const configPath = path.join(sb.root, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // What v0.1.0 wrote: one block, appended after the user's tables.
    fs.writeFileSync(
      configPath,
      [
        'model = "gpt-6.1-terra"',
        '',
        '[notice.model_migrations]',
        '"gpt-5.6-sol" = "gpt-6-sol"',
        '',
        '# >>> knowledge-base-harness >>>',
        '# Managed by knowledge-base-harness. Regenerate with: kb install codex',
        '',
        'notify = ["old-node", "old-cli", "hook", "codex", "stop"]',
        '',
        '[mcp_servers.kb]',
        'command = "old-node"',
        'args = ["old-cli", "mcp"]',
        '',
        '[mcp_servers.kb.env]',
        'KB_ROOT = "old-kb"',
        'KB_DATA_DIR = "old-data"',
        '# <<< knowledge-base-harness <<<',
        '',
      ].join('\n'),
    );

    for (const a of getAdapter('codex').artifacts(ctx, { home: sb.root })) applyArtifact(a);

    const text = fs.readFileSync(configPath, 'utf8');
    expect(text).not.toContain('old-node');
    expect(text).not.toContain('old-kb');
    expect(text).toContain('"gpt-5.6-sol" = "gpt-6-sol"');
    const lines = text.split('\n');
    expect(lines.findIndex((l) => l.startsWith('notify = ['))).toBeLessThan(
      lines.findIndex((l) => l.startsWith('[')),
    );
    expect(lines.filter((l) => l.trim() !== '').at(-1)).toBe('# <<< knowledge-base-harness-mcp <<<');
  });

  it('parses turn-complete notifications', () => {
    expect(getAdapter('codex').parsePayload(CODEX_TURN_COMPLETE)?.kind).toBe('stop');
  });
});

describe('instruction-only adapters', () => {
  for (const id of ['workbuddy', 'trae'] as const) {
    it(`${id} writes rules and a hook manifest`, () => {
      const adapter = getAdapter(id);
      for (const a of adapter.artifacts(ctx, {})) applyArtifact(a);
      const rules = adapter.capabilities.rulesFile!;
      expect(hasMarker(path.join(sb.root, rules))).toBe(true);
      const manifest = path.join(sb.root, adapter.capabilities.mcp ? path.dirname(rules) : '.');
      expect(fs.existsSync(manifest)).toBe(true);
    });

    it(`${id} parses a generic prompt payload`, () => {
      const adapter = getAdapter(id);
      const event = adapter.parsePayload({ ...GENERIC_PROMPT, kind: 'prompt' });
      expect(event?.kind).toBe('prompt');
      expect(event?.harness).toBe(id);
    });
  }
});

describe('qoder adapter', () => {
  // Qoder CLI documents a hook contract of its own, so this adapter is no
  // longer "write a rules file and hope": it installs real hooks.
  it('installs hooks into .qoder/settings.json', () => {
    for (const a of getAdapter('qoder').artifacts(ctx, {})) applyArtifact(a);
    const settings = JSON.parse(
      fs.readFileSync(path.join(sb.root, '.qoder', 'settings.json'), 'utf8'),
    ) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(settings.hooks).sort()).toEqual(
      ['PreCompact', 'PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort(),
    );
  });

  it('registers MCP at the project-level .mcp.json', () => {
    for (const a of getAdapter('qoder').artifacts(ctx, {})) applyArtifact(a);
    const mcp = JSON.parse(fs.readFileSync(path.join(sb.root, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    expect(mcp.mcpServers.kb!.args).toEqual([ctx.cliEntry, 'mcp']);
  });

  it('parses the documented payload shapes', () => {
    const adapter = getAdapter('qoder');
    expect(adapter.parsePayload({ hook_event_name: 'SessionStart', cwd: '/' })?.kind).toBe('start');
    const prompt = adapter.parsePayload({ hook_event_name: 'UserPromptSubmit', prompt: '库存扣减在哪' });
    expect(prompt?.kind).toBe('prompt');
    expect(prompt?.prompt).toBe('库存扣减在哪');
    expect(adapter.parsePayload({ hook_event_name: 'PreCompact', trigger: 'auto' })?.kind).toBe('compact');
    expect(adapter.parsePayload({ hook_event_name: 'SessionEnd', reason: 'logout' })?.kind).toBe('end');
    expect(adapter.parsePayload({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toBeNull();
  });

  it('turns a PostToolUse file event into a file event', () => {
    const event = getAdapter('qoder').parsePayload({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'src/api/handler.ts' },
    });
    expect(event?.kind).toBe('file');
    expect(event?.filePath).toBe('src/api/handler.ts');
  });

  it('returns additionalContext for prompts and file events, but not for compaction', () => {
    const adapter = getAdapter('qoder');
    const promptOut = adapter.formatOutput(
      { kind: 'prompt', harness: 'qoder', cwd: '.', raw: {} },
      { context: 'ctx' },
    );
    expect(JSON.parse(promptOut).hookSpecificOutput.additionalContext).toBe('ctx');

    const fileOut = adapter.formatOutput(
      { kind: 'file', harness: 'qoder', cwd: '.', filePath: 'a.ts', raw: {} },
      { context: 'ctx' },
    );
    expect(JSON.parse(fileOut).hookSpecificOutput.hookEventName).toBe('PostToolUse');

    // PreCompact stdout means "instructions for the summary", so nothing may go out.
    expect(
      adapter.formatOutput({ kind: 'compact', harness: 'qoder', cwd: '.', raw: {} }, { context: 'ctx' }),
    ).toBe('');
  });
});

describe('dsh adapter', () => {
  it('generates shell hook wrappers', () => {
    for (const a of getAdapter('dsh').artifacts(ctx, {})) applyArtifact(a);
    for (const event of ['start', 'prompt', 'stop', 'end']) {
      const file = path.join(sb.root, '.dsh', 'hooks', `kb-${event}.sh`);
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toContain(`hook dsh ${event}`);
    }
  });
});

describe('artifact removal', () => {
  it('removes only the marker block', () => {
    const file = path.join(sb.root, 'NOTES.md');
    fs.writeFileSync(file, '# mine\n\nkeep me\n');
    const artifact = {
      path: file,
      strategy: 'text-append' as const,
      content: '<!-- >>> knowledge-base-harness >>> -->\nblock\n<!-- <<< knowledge-base-harness <<< -->\n',
      marker: 'knowledge-base-harness',
    };
    applyArtifact(artifact);
    expect(fs.readFileSync(file, 'utf8')).toContain('keep me');
    expect(removeArtifact(file)).toBe(true);
    const after = fs.readFileSync(file, 'utf8');
    expect(after).toContain('keep me');
    expect(after).not.toContain('knowledge-base-harness');
  });
});
