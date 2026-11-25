#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { KbEngine } from './core/engine.js';
import { loadConfig, writeConfig, findProjectRoot, DEFAULT_CONFIG } from './core/config.js';
import { summariseIssues } from './core/lint.js';
import { ADAPTERS, getAdapter } from './adapters/index.js';
import { applyArtifact } from './adapters/apply.js';
import { type AdapterContext, type HarnessId, type InstallOptions, type KbHookEvent } from './adapters/types.js';
import { type MemoryOp } from './core/types.js';
import { McpServer, serveStdio, readStdin } from './mcp/server.js';
import { KB_TOOLS, callKbTool } from './mcp/tools.js';
import { StatsStore } from './core/evolve.js';
import { tryGetAdapter } from './adapters/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------- helpers

function engine(cwd: string): KbEngine {
  return KbEngine.open({ cwd });
}

function projectRoot(cwd: string): string {
  return findProjectRoot(cwd);
}

function adapterContext(root: string): AdapterContext {
  const cfg = loadConfig(root);
  return {
    projectRoot: root,
    repoDir: path.resolve(HERE, '..'),
    nodeBin: process.execPath,
    cliEntry: path.resolve(HERE, 'cli.js'),
    kbRoot: cfg.kbRoot,
    dataDir: cfg.dataDir,
  };
}

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

function fail(message: string, code = 1): never {
  process.stderr.write(`kb: ${message}\n`);
  process.exit(code);
}

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function option(args: string[], name: string): string | undefined {
  const all = optionAll(args, name);
  return all[0];
}

/** Every value given for a repeatable flag, in order. */
function optionAll(args: string[], name: string): string[] {
  const out: string[] = [];
  const pref = name + '=';
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === name && i + 1 < args.length) {
      out.push(args[i + 1]!);
      i++;
      continue;
    }
    if (a.startsWith(pref)) out.push(a.slice(pref.length));
  }
  return out;
}

/** Flags that stand alone (no value follows). Everything else consumes one. */
const BOOLEAN_FLAGS = new Set([
  '--fix',
  '--json',
  '--dry-run',
  '--force',
  '--apply',
  '--global',
  '--reset',
  '--help',
  '-h',
]);

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-')) {
      out.push(a);
      continue;
    }
    // `--flag=value` carries its own value; a bare unknown flag does not.
    if (!a.includes('=') && !BOOLEAN_FLAGS.has(a)) i++;
  }
  return out;
}

// ------------------------------------------------------------------ commands

function cmdInit(args: string[]): void {
  const root = projectRoot(process.cwd());
  const e = engine(root);
  e.init();
  const cfgFile = writeConfig(root, {
    kbRoot: e.cfg.kbRoot,
    dataDir: e.cfg.dataDir,
    maxPageBytes: e.cfg.maxPageBytes,
    targetPageBytes: e.cfg.targetPageBytes,
    maxDepth: e.cfg.maxDepth,
  });
  out(`Initialised knowledge base`);
  out(`  wiki:   ${e.cfg.kbRoot}`);
  out(`  data:   ${e.cfg.dataDir}`);
  out(`  config: ${cfgFile}`);
  if (flag(args, '--harness')) {
    const target = option(args, '--harness')!;
    cmdInstall([target]);
  }
}

function cmdInstall(args: string[]): void {
  const pos = positionals(args);
  const root = projectRoot(process.cwd());
  const ctx = adapterContext(root);
  const targets = pos.length > 0 ? pos : ADAPTERS.map((a) => a.id);
  const e = engine(root);
  e.init();

  // `--global` installs into user-level config so every project sees the same
  // wiki. `--scope` wins when both are given, because it is the more specific
  // instruction.
  const explicitScope = option(args, '--scope');
  const global = flag(args, '--global') || explicitScope === 'global';
  const scope: InstallOptions['scope'] =
    explicitScope === 'project' || explicitScope === 'global'
      ? explicitScope
      : global
        ? 'global'
        : undefined;

  if (global) {
    out(`Installing for the current user (global config). Wiki: ${e.cfg.kbRoot}`);
    out('Every project will read this same knowledge base.');
  }

  let installed = 0;
  for (const id of targets) {
    const adapter = getAdapter(id);
    out(`\n${adapter.displayName} (${adapter.id})${adapter.verified ? '' : ' — convention paths, verify before relying on it'}`);
    if (!adapter.capabilities.hooks) out('  hooks: not supported, instructions file only');
    if (!adapter.capabilities.mcp) out('  mcp: not supported');
    if (adapter.capabilities.configScope === 'global' && scope !== 'project') {
      out('  config scope: global only (a project-level config file is ignored by this harness)');
    }
    const installOpts: InstallOptions = scope ? { scope } : {};
    for (const artifact of adapter.artifacts(ctx, installOpts)) {
      const applied = applyArtifact(artifact);
      installed++;
      const flagText = applied.action === 'unchanged' ? '(already current)' : `(${applied.action})`;
      const shown = path.isAbsolute(applied.path) && !applied.path.startsWith(root)
        ? applied.path
        : path.relative(root, applied.path);
      out(`  ${applied.action === 'unchanged' ? '=' : '+'} ${shown} ${flagText}`);
      if (applied.note) out(`      ${applied.note}`);
    }
  }
  out(`\n${installed} artifact(s) processed. Knowledge base: ${e.cfg.kbRoot}`);
  out('Reminder: harness hook payloads differ by version — run `kb hook <harness> <event>` by hand once to confirm.');
}

function cmdRecall(args: string[]): void {
  const pos = positionals(args);
  const query = pos.join(' ').trim();
  if (query === '') fail('usage: kb recall "<question>"');
  const e = engine(process.cwd());
  const { hits, context } = e.recallQuery(query, Number(option(args, '--limit') ?? 5));
  if (flag(args, '--json')) {
    out(JSON.stringify(hits, null, 2));
    return;
  }
  if (hits.length === 0) {
    out('No matching pages.');
    return;
  }
  out(context);
}

function cmdNote(args: string[]): void {
  const pos = positionals(args);
  const note = pos.join(' ').trim();
  if (note === '') fail('usage: kb note "<one-sentence conclusion>" [--page <path>] [--supersedes "<old text>"]');
  const e = engine(process.cwd());
  const page = option(args, '--page');
  const supersedes = option(args, '--supersedes');
  const summary = e.addManualConclusions([note], page, supersedes);
  if (summary.results.length === 0) {
    out('Rejected: the note does not state a settled fact (hedged, a question, or too vague).');
    process.exitCode = 2;
    return;
  }
  for (const r of summary.results) {
    out(
      `${r.created ? 'created' : 'updated'} ${r.path} (+${r.addedLines}, ${r.mergedLines} duplicate, ${r.bytesAfter}B)` +
        (r.superseded.length > 0 ? `, superseded ${r.superseded.length}` : ''),
    );
  }
}

function cmdMemory(args: string[]): void {
  const pos = positionals(args);
  const e = engine(process.cwd());
  const target = (option(args, '--target') ?? pos[0] ?? 'memory') as 'memory' | 'user';
  if (target !== 'memory' && target !== 'user') {
    fail('usage: kb memory [memory|user] [--add "<text>"] [--remove "<text>"] [--patch "<old>=> <new>"]');
  }

  const adds = optionAll(args, '--add');
  const removes = optionAll(args, '--remove');
  const patches = optionAll(args, '--patch');

  if (adds.length === 0 && removes.length === 0 && patches.length === 0) {
    const view = e.memoryView(target);
    out(`${target === 'user' ? 'USER.md' : 'MEMORY.md'} — ${view.used}/${view.limit} chars`);
    if (view.entries.length === 0) {
      out('(empty)');
      return;
    }
    let current = '';
    for (const entry of view.entries) {
      if (entry.section !== current) {
        current = entry.section;
        out(`\n## ${current}`);
      }
      out(`- ${entry.text}`);
    }
    return;
  }

  // All CLI edits go in one batch so the budget is checked against the outcome.
  const ops: MemoryOp[] = [];
  for (const group of removes) {
    for (const piece of group.split('||').map((p) => p.trim()).filter(Boolean)) {
      ops.push({ action: 'remove', old_text: piece });
    }
  }
  for (const spec of patches) {
    const [oldText, newText] = spec.split('=>').map((p) => p.trim());
    if (!oldText || !newText) fail('--patch needs the form --patch "<old text>=> <new text>"');
    ops.push({ action: 'patch', old_text: oldText, content: newText });
  }
  for (const add of adds) ops.push({ action: 'add', content: add });

  const result = e.applyMemory(target, ops);
  if (!result.ok) {
    fail(result.error ?? 'memory update failed', 2);
  }
  out(`Applied ${result.applied} op(s). ${result.used}/${result.limit} chars used.`);
}

function cmdDoctor(args: string[]): void {
  const e = engine(process.cwd());
  const { issues, fixed } = e.doctor(flag(args, '--fix'));
  if (fixed.length > 0) {
    out(`quarantined ${fixed.length} item(s):`);
    for (const f of fixed) out(`  - ${f}`);
    out('');
  }
  const { errors, warnings } = summariseIssues(issues);
  if (issues.length === 0) {
    out('Knowledge base is clean.');
    return;
  }
  for (const issue of issues) {
    out(`${issue.level === 'error' ? 'ERROR' : 'warn '} [${issue.code}] ${issue.path}`);
    out(`      ${issue.message}`);
  }
  out(`\n${errors} error(s), ${warnings} warning(s).`);
  if (errors > 0) process.exitCode = 1;
}

function cmdCompress(args: string[]): void {
  const pos = positionals(args);
  const e = engine(process.cwd());
  if (pos.length > 0) {
    const results = e.compress(pos[0]);
    for (const r of results) out(`${r.path}: ${r.before}B → ${r.after}B`);
  } else {
    const results = e.compress();
    if (results.length === 0) {
      out('Nothing above the size budget.');
      return;
    }
    for (const r of results) out(`${r.path}: ${r.before}B → ${r.after}B`);
  }
}

function cmdEvolve(args: string[]): void {
  const e = engine(process.cwd());
  const min = option(args, '--min-occurrences');
  const cold = option(args, '--cold-after-days');
  const { text } = e.evolve({
    ...(min ? { minOccurrences: Number(min) } : {}),
    ...(cold ? { coldAfterDays: Number(cold) } : {}),
  });
  out(text);
}

/**
 * Move heavy `## 细节` sections into live reference pages.
 *
 * Unlike `_archive/`, a reference page stays indexed and keeps growing, so this
 * shrinks the page a reader must scroll without making the evidence unfindable.
 */
function cmdDemote(args: string[]): void {
  const e = engine(process.cwd());
  const pos = positionals(args);
  const min = option(args, '--min-chars');
  const { text } = e.demote({
    ...(pos[0] ? { page: pos[0] } : {}),
    apply: flag(args, '--apply'),
    ...(flag(args, '--force') ? { force: true } : {}),
    ...(min ? { minDetailChars: Number(min) } : {}),
  });
  out(text);
}

/**
 * Consolidate narrow pages into umbrella pages.
 *
 * Dry run unless `--apply`, because a wrong merge is worse than a long tail of
 * small pages: it buries a fact under an unrelated heading.
 */
function cmdCurate(args: string[]): Promise<void> {
  const e = engine(process.cwd());
  const min = option(args, '--min-size');
  const complete = option(args, '--complete');

  return e
    .curate({
      apply: flag(args, '--apply'),
      ...(min ? { minClusterSize: Number(min) } : {}),
      ...(complete ? { complete: shellCompleter(complete) } : {}),
    })
    .then(({ text }) => out(text));
}

/**
 * A model hook the CLI can point at any command, e.g.
 *   kb curate --complete "llm -m sonnet"
 * The command receives the prompt on stdin and must print JSON on stdout.
 * Deliberately CLI-only: hooks never call out to the network.
 */
function shellCompleter(command: string): (prompt: string) => Promise<string> {
  return (prompt: string) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => {
        stdout += c.toString('utf8');
      });
      child.stderr.on('data', (c: Buffer) => {
        stderr += c.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`${command} exited ${code}: ${stderr.slice(0, 300)}`));
      });
      child.stdin.on('error', () => {
        /* the child may exit before reading stdin; the close handler reports it */
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
}

function cmdTree(): void {
  const e = engine(process.cwd());
  out(e.tree());
}

function cmdStats(): void {
  const e = engine(process.cwd());
  const stats = new StatsStore(e.cfg.dataDir).load();
  const rows = Object.entries(stats.pages)
    .sort((a, b) => b[1].recalls - a[1].recalls)
    .slice(0, 20);
  if (rows.length === 0) {
    out('No recall statistics yet.');
    return;
  }
  out('page                                  recalls  adopted  writes  last');
  for (const [rel, s] of rows) {
    out(
      `${rel.padEnd(36).slice(0, 36)}  ${String(s.recalls).padStart(7)}  ${String(s.adopted).padStart(7)}  ${String(s.writes).padStart(6)}  ${s.lastRecall ?? '-'}`,
    );
  }
}

function cmdSummary(args: string[]): void {
  const e = engine(process.cwd());
  const dry = flag(args, '--dry-run');
  const result = e.endSession({ cwd: process.cwd(), dryRun: dry });
  out(result.report);
  if (dry) out('\n(dry run: nothing was written)');
}

function cmdHook(args: string[]): Promise<void> {
  const pos = positionals(args);
  const harnessId = (pos[0] ?? '') as HarnessId;
  const eventName = pos[1];
  const adapter = tryGetAdapter(harnessId);
  // Unknown harness or event: stay silent rather than break a session.
  if (!adapter || !eventName) return Promise.resolve();

  return (async () => {
    let payload: unknown = {};
    try {
      const raw = await readStdin();
      if (raw.trim() !== '') payload = JSON.parse(raw);
    } catch {
      payload = {};
    }
    const event = adapter.parsePayload(payload) ?? fallbackEvent(adapter.id, eventName);
    if (!event) return;

    try {
      const e = engine(event.cwd);
      switch (event.kind) {
        case 'start': {
          e.startSession(event.harness, event.cwd, event.transcriptPath);
          break;
        }
        case 'prompt': {
          const res = e.onPrompt(event.harness, event.prompt ?? '', event.cwd);
          const text = adapter.formatOutput(event, { context: res.context });
          if (text) process.stdout.write(text + '\n');
          break;
        }
        case 'note': {
          if (event.note) e.addManualConclusions([event.note]);
          break;
        }
        case 'stop':
        case 'end': {
          // Both mean "session over"; endSession is idempotent because it marks
          // the session ended and clears the active marker.
          const res = e.endSession({
            harness: event.harness,
            cwd: event.cwd,
            ...(event.transcriptPath ? { transcriptPath: event.transcriptPath } : {}),
          });
          if (process.env['KB_HOOK_VERBOSE'] === '1') out(res.report);
          break;
        }
      }
    } catch (err) {
      // A failing hook must never break the user's session.
      if (process.env['KB_HOOK_VERBOSE'] === '1') {
        process.stderr.write(`kb hook error: ${err instanceof Error ? err.stack : String(err)}\n`);
      }
    }
  })();
}

function fallbackEvent(harness: HarnessId, eventName: string): KbHookEvent {
  const kind: KbHookEvent['kind'] =
    eventName === 'start' ? 'start' : eventName === 'prompt' ? 'prompt' : eventName === 'end' ? 'end' : 'stop';
  return { kind, harness, cwd: process.cwd(), raw: {} };
}

function cmdMcp(): void {
  const e = engine(process.cwd());
  const server = new McpServer(KB_TOOLS, (name, args) => callKbTool(e, name, args));
  void serveStdio(server);
}

function cmdConfig(args: string[]): void {
  const root = projectRoot(process.cwd());
  if (flag(args, '--reset')) {
    fs.rmSync(path.join(root, 'kb.config.json'), { force: true });
    out('Removed kb.config.json');
    return;
  }
  const cfg = loadConfig(root);
  out(JSON.stringify({ ...DEFAULT_CONFIG, kbRoot: cfg.kbRoot, dataDir: cfg.dataDir }, null, 2));
}

function cmdHelp(): void {
  out(HELP);
}

// ---------------------------------------------------------------------- main

const HELP = `kb — personal markdown wiki maintained by agent-harness plugins

usage: kb <command> [options]

  init                 Create the wiki root, runtime dir and kb.config.json
  install [harness…]   Install hook/MCP/rules integration for harnesses
                       (claude-code, codex, qoder, workbuddy, trae, dsh, generic)
  recall "<query>"     Search the wiki (--json, --limit N)
  note "<fact>"        Record one settled conclusion
                       (--page <path> | --supersedes "<old text>")
  memory [memory|user] Show the always-injected memory
                       (--add "<text>" | --remove "<text>" | --patch "<old>= > <new>")
  summary              Distil the session that just ended (--dry-run)
  compress [page]      Compress pages over the size budget
  evolve               Promotion / supersession / decay pass (--min-occurrences, --cold-after-days)
  curate [--apply]     Consolidate narrow pages into umbrella pages (dry run by default)
                       (--min-size N | --complete "<cmd reading stdin, printing JSON>")
  demote [page]        Move heavy detail sections into a live reference page
                       (--apply, --force, --min-chars N)
  stats                Recall statistics per page
  tree                 Print the wiki tree
  doctor [--fix]       Lint the wiki; --fix quarantines stray files and rebuilds indices
  config [--reset]     Show resolved configuration
  mcp                  Run the MCP server on stdio
  hook <h> <event>     Internal: receive a harness hook (reads JSON on stdin)

Conventions:
  the wiki folder only ever contains .md files, one folder level per topic,
  each folder has its own index.md, and leaf pages hold settled conclusions.
  Sessions, caches, locks and quarantined files live in the data dir.
`;

function main(): void {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'help';
  const args = argv.slice(1);

  switch (cmd) {
    case 'init':
      return cmdInit(args);
    case 'install':
      return cmdInstall(args);
    case 'recall':
    case 'search':
      return cmdRecall(args);
    case 'note':
    case 'add':
      return cmdNote(args);
    case 'memory':
      return cmdMemory(args);
    case 'summary':
    case 'stop':
    case 'end':
      return cmdSummary(args);
    case 'compress':
      return cmdCompress(args);
    case 'evolve':
      return cmdEvolve(args);
    case 'curate': {
      cmdCurate(args).catch((err: unknown) => {
        fail(err instanceof Error ? err.message : String(err));
      });
      return;
    }
    case 'demote':
      return cmdDemote(args);
    case 'stats':
      return cmdStats();
    case 'tree':
    case 'ls':
      return cmdTree();
    case 'doctor':
    case 'lint':
      return cmdDoctor(args);
    case 'config':
      return cmdConfig(args);
    case 'mcp':
      return cmdMcp();
    case 'hook': {
      // Hooks are async (stdin); keep the process alive until they finish.
      cmdHook(args).catch(() => {
        /* never surface a hook failure to the harness */
      });
      return;
    }
    case 'help':
    case '--help':
    case '-h':
    default:
      return cmdHelp();
  }
}

main();
