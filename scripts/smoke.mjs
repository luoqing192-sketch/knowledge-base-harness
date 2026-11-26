import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Smoke test the real CLI binary end to end, exactly as hooks invoke it.
 * Runs against a temp project so the repo is never touched.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'dist', 'cli.js');

if (!fs.existsSync(cli)) {
  console.error('build first: npm run build');
  process.exit(1);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-smoke-'));
let failures = 0;

function kb(args, input, opts = {}) {
  const res = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    input: input ?? '',
    encoding: 'utf8',
    // Never touch the developer's real Codex/dsh config during a smoke run.
    env: {
      ...process.env,
      KB_HOOK_VERBOSE: '1',
      CODEX_HOME: path.join(root, '.codex'),
      HOME: opts.home ?? root,
      USERPROFILE: opts.home ?? root,
    },
  });
  return { code: res.status, out: (res.stdout ?? '').trim(), err: (res.stderr ?? '').trim(), ...opts };
}

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`);
  }
}

console.log(`smoke: ${root}`);

// 1. init + install
const init = kb(['init']);
check('init creates the wiki root', fs.existsSync(path.join(root, 'knowledge', 'index.md')), init.err);
check('init writes config', fs.existsSync(path.join(root, 'kb.config.json')));

const install = kb(['install', 'claude-code', 'codex', 'trae', 'dsh']);
check('install writes claude settings', fs.existsSync(path.join(root, '.claude', 'settings.json')), install.err);
// Codex reads its global config; the sandbox's CODEX_HOME is that global dir.
check('install writes codex toml', fs.existsSync(path.join(root, '.codex', 'config.toml')));
check('install writes dsh hooks', fs.existsSync(path.join(root, '.dsh', 'hooks', 'kb-stop.sh')));

// 1b. global install lands in the user's home, not the project
const globalHome = path.join(root, 'home');
fs.mkdirSync(globalHome, { recursive: true });
// Snapshot the project config before the global install: an earlier step already
// installed into the project, so "does not touch" means "unchanged", not "absent".
const projectSnapshot = (() => {
  const out = {};
  for (const d of ['.trae', '.claude']) {
    const abs = path.join(root, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs, { recursive: true, withFileTypes: true })) {
      if (!f.isFile()) continue;
      const p = path.join(f.parentPath ?? f.path, f.name);
      out[p] = fs.statSync(p).mtimeMs;
    }
  }
  return out;
})();

const globalInstall = kb(['install', 'claude-code', 'trae', '--global'], '', { home: globalHome });
check(
  'global install writes user-level claude settings',
  fs.existsSync(path.join(globalHome, '.claude', 'settings.json')),
  globalInstall.out + globalInstall.err,
);
check(
  'global install writes user-level trae rules',
  fs.existsSync(path.join(globalHome, '.trae', 'rules', 'knowledge-base-harness.md')),
  globalInstall.out,
);
check(
  'global install leaves project config files untouched',
  Object.entries(projectSnapshot).every(([p, mtime]) => {
    try {
      return fs.statSync(p).mtimeMs === mtime;
    } catch {
      return false;
    }
  }),
  Object.keys(projectSnapshot).join(', '),
);

// 2. a prompt hook must inject memory even with an empty wiki, and recall once
//    something is in the wiki
const memWrite = kb(['memory', 'memory', '--add', '本地 WES 启动必须设置 MOCK_ESS=on，否则连不上 ESS 的 9000 端口']);
check('memory write succeeds', memWrite.code === 0, memWrite.err);

const start = kb(['hook', 'claude-code', 'start'], JSON.stringify({ hook_event_name: 'SessionStart', cwd: root }));
check('session start produces no output', start.out === '', start.out);

kb(['note', '确认了：本地启动 WES 必须设置 MOCK_ESS=on，否则连不上 ESS 的 9000 端口']);

const prompt = kb(
  ['hook', 'claude-code', 'prompt'],
  JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, prompt: '本地 WES 起不来怎么办，MOCK_ESS 要开吗' }),
);
let injected = '';
try {
  injected = JSON.parse(prompt.out).hookSpecificOutput.additionalContext;
} catch {
  injected = prompt.out;
}
check('prompt hook injects knowledge', injected.includes('MOCK_ESS'), prompt.out || prompt.err);
check('prompt hook injects always-on memory', injected.includes('Long-term memory'), injected.slice(0, 200));

// 2b. memory is injected even when recall finds nothing
const offTopic = kb(
  ['hook', 'claude-code', 'prompt'],
  JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, prompt: '量子纠缠退相干时间是多少' }),
);
const offText = offTopic.out.includes('additionalContext')
  ? JSON.parse(offTopic.out).hookSpecificOutput.additionalContext
  : offTopic.out;
check('memory injected with no recall hits', offText.includes('Long-term memory'), offText.slice(0, 200));
check('no recall block when nothing matches', !offText.includes('Knowledge base hits'), offText.slice(0, 200));

// 3. stop with nothing settled must not write
const filesBefore = fs.readdirSync(path.join(root, 'knowledge'), { recursive: true }).length;
const stop = kb(['hook', 'claude-code', 'stop'], JSON.stringify({ hook_event_name: 'Stop', cwd: root }));
const filesAfter = fs.readdirSync(path.join(root, 'knowledge'), { recursive: true }).length;
check('empty session leaves the wiki untouched', filesBefore === filesAfter, stop.err);

// 4. the wiki only ever contains markdown
const all = fs.readdirSync(path.join(root, 'knowledge'), { recursive: true, withFileTypes: true });
const strays = all.filter((d) => d.isFile() && !d.name.endsWith('.md'));
check('knowledge folder has no non-markdown files', strays.length === 0, strays.map((s) => s.name).join(', '));

// 5. doctor is clean
const doctor = kb(['doctor']);
check('doctor reports no errors', doctor.code === 0, doctor.out);

// 5b. curator is a dry run by default, then consolidates with --apply
for (let i = 1; i <= 3; i++) {
  kb(['note', `确认了：ESS 第 ${i} 个坑是 contextInit 没触发 (commit abc123${i})`, '--page', `ess/pitfall-${i}.md`]);
}
const liveBefore = fs.readdirSync(path.join(root, 'knowledge'), { recursive: true }).length;
const curateDry = kb(['curate']);
check('curate defaults to dry run', curateDry.out.includes('dry run'), curateDry.out || curateDry.err);
check(
  'dry run does not write',
  fs.readdirSync(path.join(root, 'knowledge'), { recursive: true }).length === liveBefore,
);
const curateWet = kb(['curate', '--apply']);
check('curate --apply merges', curateWet.out.includes('merged'), curateWet.out || curateWet.err);
check(
  'umbrella page exists',
  fs.existsSync(path.join(root, 'knowledge', 'ess', 'pitfall.md')),
);
check(
  'sources archived, not deleted',
  fs.existsSync(path.join(root, 'knowledge', '_archive')),
);
check('wikilinks intact after merge', kb(['doctor']).code === 0);

// 5c. demote: heavy details become a live reference page, not an archive
const rateLimit = path.join(root, 'knowledge', 'wes', 'rate-limit.md');
fs.mkdirSync(path.dirname(rateLimit), { recursive: true });
fs.writeFileSync(
  rateLimit,
  [
    '---',
    'id: rate-limit',
    'title: 信号量负数导致 429',
    'summary: 信号量负数导致 429',
    'tags: [wes]',
    'level: 1',
    'parent: wes',
    'created: "2026-01-01"',
    'updated: "2026-01-01"',
    'revision: 1',
    'confidence: high',
    '---',
    '',
    '# 信号量负数导致 429',
    '',
    '## 结论',
    '',
    '- 确认了：429 的根因是信号量负数 (commit abc1234)',
    '',
    '## 细节',
    '',
    ...Array.from(
      { length: 12 },
      (_, i) =>
        `- 排查记录 ${i + 1}：查看 semaphore.availablePermits 的实时值，确认 acquire 与 release 是否配对，对比上一版本 Semaphore 的初始 permits 配置`,
    ),
    '',
  ].join('\n'),
);

// Build the folder index this hand-written page needs.
kb(['doctor', '--fix']);

const demoteDry = kb(['demote', '--min-chars', '400']);
check('demote defaults to dry run', demoteDry.out.includes('dry run'), demoteDry.out || demoteDry.err);
check('dry run leaves the reference folder absent', !fs.existsSync(path.join(root, 'knowledge', 'references')));

const demoteWet = kb(['demote', '--apply', '--min-chars', '400']);
check('demote --apply writes a reference page', fs.existsSync(path.join(root, 'knowledge', 'references', 'wes__rate-limit.md')), demoteWet.err);
const shrunk = fs.readFileSync(rateLimit, 'utf8');
check('demoted page no longer holds the long body', !shrunk.includes('排查记录 3'));
check('demoted page links to the reference', shrunk.includes('references/wes__rate-limit.md'));

const refRecall = kb(['recall', 'availablePermits acquire release 配对']);
check('reference page is still recallable', refRecall.out.includes('references/'), refRecall.out || refRecall.err);
check('doctor clean after demote', kb(['doctor']).code === 0, kb(['doctor']).out);

// 6. mcp handshake
const mcp = spawnSync(process.execPath, [cli, 'mcp'], {
  cwd: root,
  input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n',
  encoding: 'utf8',
  timeout: 10_000,
});
check('mcp server answers initialize', (mcp.stdout ?? '').includes('"serverInfo"'), mcp.stderr ?? '');

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? '\nall good' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
