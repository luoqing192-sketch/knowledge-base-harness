/**
 * End-to-end demo: drives the real CLI the way harnesses do — through hooks.
 *
 *   node scripts/demo.mjs
 *
 * Creates a throwaway project under the OS temp dir so nothing in the repo is
 * touched, then prints the resulting wiki.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'dist', 'cli.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-demo-'));
const kbRoot = path.join(root, 'knowledge');

function run(args, input) {
  const res = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    input: input ?? '',
    encoding: 'utf8',
    env: { ...process.env, KB_HOOK_VERBOSE: '1' },
  });
  if (res.status !== 0 && res.status !== null) {
    process.stderr.write(res.stderr);
  }
  return (res.stdout ?? '').trim();
}

function step(title) {
  console.log(`\n\x1b[1m▌ ${title}\x1b[0m`);
}

step('init');
console.log(run(['init']));

step('install (claude-code + codex)');
console.log(run(['install', 'claude-code', 'codex']));

step('session 1: a settled decision, via the Stop hook');
run(['hook', 'claude-code', 'start'], JSON.stringify({ hook_event_name: 'SessionStart', cwd: root }));
console.log(
  run(
    ['hook', 'claude-code', 'stop'],
    JSON.stringify({
      hook_event_name: 'Stop',
      cwd: root,
      // In a real session the transcript path comes from the payload; here we
      // pass conclusions directly through the CLI to keep the demo hermetic.
    }),
  ),
);
console.log(
  run(['note', '确认了：缓存前缀必须带租户标识，否则多租户环境会互相污染 (commit c0fc856bbb)']),
);

step('session 2: recall, then a revised decision (supersession)');
console.log(run(['recall', '缓存前缀多租户']));
console.log(run(['note', '确认了：缓存前缀改为按 environmentCode 拼接，不再使用租户标识 (commit d1ab123abc)']));

step('session 3: the same procedure on two pages (promotion)');
run(['note', '部署插件时必须先核对 plugin.properties 的 plugin.version 再 loadPlugin，否则报版本不匹配', '--page', 'ops/deploy-plugin.md']);
run(['note', '部署插件时必须先核对 plugin.properties 的 plugin.version 再 loadPlugin，否则报版本不匹配', '--page', 'ops/deploy-plugin-rollback.md']);
console.log(run(['evolve']));

step('session 4: a flood of one-fact pages, then consolidation');
for (let i = 1; i <= 4; i++) {
  run([
    'note',
    `确认了：ESS 重启后第 ${i} 个坑是 contextInit 必须手动触发 (commit abc123${i})`,
    '--page',
    `ess/pitfall-${i}.md`,
  ]);
}
console.log(run(['curate']));
console.log('\n(applying)');
console.log(run(['curate', '--apply']));

step('session 5: one page grows a long investigation log (demote)');
const rateLimit = path.join(kbRoot, 'wes', 'rate-limit.md');
fs.mkdirSync(path.dirname(rateLimit), { recursive: true });
fs.writeFileSync(
  rateLimit,
  [
    '---',
    'id: rate-limit',
    'title: 429 的根因是信号量负数',
    'summary: 429 的根因是信号量负数',
    'tags: [wes]',
    'level: 1',
    'parent: wes',
    'created: "2026-01-01"',
    'updated: "2026-01-01"',
    'revision: 1',
    'confidence: high',
    '---',
    '',
    '# 429 的根因是信号量负数',
    '',
    '## 结论',
    '',
    '- 429 的根因是信号量负数 (commit abc1234)',
    '',
    '## 细节',
    '',
    ...Array.from(
      { length: 10 },
      (_, i) =>
        `- 排查记录 ${i + 1}：查看 semaphore.availablePermits 的实时值，确认 acquire 与 release 是否配对，对比上一版本 Semaphore 的初始 permits 配置`,
    ),
    '',
  ].join('\n'),
);
run(['doctor', '--fix']);
console.log(run(['demote']));
console.log('\n(applying)');
console.log(run(['demote', '--apply']));

step('stats');
console.log(run(['stats']));

step('doctor');
console.log(run(['doctor']));

step('tree');
console.log(run(['tree']));

step('the wiki on disk');
const walk = (dir, prefix = '') => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      console.log(`  ${rel}/`);
      walk(path.join(dir, e.name), rel);
    } else {
      console.log(`  ${rel}`);
    }
  }
};
walk(kbRoot);

step('sample page');
const sample = fs
  .readdirSync(kbRoot, { recursive: true })
  .map((p) => String(p))
  .find((p) => p.endsWith('.md') && !p.endsWith('index.md') && !p.includes('_archive'));
if (sample) {
  console.log(`\x1b[2m--- ${sample} ---\x1b[0m`);
  console.log(fs.readFileSync(path.join(kbRoot, sample), 'utf8'));
}

console.log(`\n\x1b[2mwiki: ${kbRoot}\x1b[0m`);
console.log(`\x1b[2m(data dir holds sessions/state/quarantine: ${path.join(root, '.kb')})\x1b[0m`);
