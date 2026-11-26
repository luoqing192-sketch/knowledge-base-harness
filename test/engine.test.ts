import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { KbEngine } from '../src/core/engine.js';
import { recall, renderRecall, extractSnippets } from '../src/core/recall.js';
import { lintKb } from '../src/core/lint.js';
import { USER_PROMPT } from './fixtures.js';
import { listMarkdown, readPage, sandbox, topicFiles, type Sandbox } from './helpers.js';

let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
});

afterEach(() => {
  sb.cleanup();
});

function seed(): void {
  // Two topic folders, each with a hub index and a leaf page.
  const e = sb.engine;
  e.addManualConclusions(
    ['库存扣减必须走 updateStock 唯一入口，不能直接改表，否则事件溯源对不上 (src/persist/StockRepo.java)'],
    undefined,
  );
  e.addManualConclusions(
    ['机器人调度按 businessType 与 taskPriority 两级排队，PROCESSING 任务不可被抢占 (commit 4e871a50bb)'],
    undefined,
  );
  e.store.syncFolderIndex('');
}

describe('wiki structure', () => {
  it('starts with a root index plus the memory folder', () => {
    expect(topicFiles(sb)).toEqual(['index.md']);
    expect(listMarkdown(sb)).toContain('memory/MEMORY.md');
    expect(listMarkdown(sb)).toContain('memory/USER.md');
  });

  it('creates leaf pages with a parent index link', () => {
    seed();
    const files = topicFiles(sb);
    expect(files).toContain('index.md');
    expect(files.length).toBeGreaterThan(1);
    const rootIndex = readPage(sb, 'index.md');
    for (const f of files) {
      if (f === 'index.md') continue;
      const name = path.posix.basename(f, '.md');
      expect(rootIndex.includes(name)).toBe(true);
    }
  });

  it('keeps every page within the depth limit', () => {
    seed();
    for (const rel of listMarkdown(sb)) {
      expect(rel.split('/').length - 1).toBeLessThanOrEqual(sb.engine.cfg.maxDepth);
    }
  });

  it('lints clean after seeding', () => {
    seed();
    const issues = lintKb(sb.engine.store);
    const errors = issues.filter((i) => i.level === 'error');
    expect(errors).toEqual([]);
  });
});

describe('recall', () => {
  it('finds the page for a Chinese question', () => {
    seed();
    const hits = recall(sb.engine.store, USER_PROMPT, { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.snippets.join(' ')).toContain('updateStock');
  });

  it('returns nothing for an unrelated question', () => {
    seed();
    const hits = recall(sb.engine.store, '量子纠缠退相干时间', { limit: 5 });
    expect(hits).toHaveLength(0);
  });

  it('renders a bounded context block', () => {
    seed();
    const hits = recall(sb.engine.store, USER_PROMPT, { limit: 5 });
    const text = renderRecall(hits, { maxChars: 500 });
    expect(text.length).toBeLessThanOrEqual(700);
    expect(text).toContain('Knowledge base hits');
  });

  it('records recall statistics', () => {
    seed();
    sb.engine.onPrompt('claude-code', USER_PROMPT, sb.root);
    const stats = sb.engine.stats.load();
    expect(Object.keys(stats.pages).length).toBeGreaterThan(0);
  });
});

describe('extractSnippets', () => {
  // The index text starts with the bare title, which is a substring of the
  // conclusion bullet below it. The shorter one used to win by arriving first,
  // so the injected context lost the actual fact.
  it('keeps the longer wording when the title duplicates the conclusion', () => {
    const pageText = [
      'SSO 网关的超时是 30 秒',
      '确认了：SSO 网关的超时是 30 秒，超过会返回 504 (commit abc1234)',
      '## 结论',
      '- 确认了：SSO 网关的超时是 30 秒，超过会返回 504 (commit abc1234)',
    ].join('\n');
    const snippets = extractSnippets(pageText, ['sso']);
    expect(snippets).toHaveLength(1);
    expect(snippets[0]).toContain('超过会返回 504');
  });
});

describe('knowledge folder hygiene', () => {
  it('refuses to let non-markdown files stay', () => {
    fs.writeFileSync(path.join(sb.kbRoot, 'scratch.txt'), 'temporary');
    fs.mkdirSync(path.join(sb.kbRoot, 'nested'));
    fs.writeFileSync(path.join(sb.kbRoot, 'nested', 'cache.json'), '{}');

    const issues = lintKb(sb.engine.store);
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('non-markdown-file');

    const { fixed } = sb.engine.doctor(true);
    expect(fixed.length).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(path.join(sb.kbRoot, 'scratch.txt'))).toBe(false);
    expect(fs.existsSync(path.join(sb.kbRoot, 'nested', 'cache.json'))).toBe(false);
    // Quarantine is inside the data dir, not the wiki.
    const quarantined = fs.readdirSync(path.join(sb.dataDir, 'quarantine'));
    expect(quarantined.length).toBe(2);
  });

  it('writes temp files outside the knowledge folder', () => {
    seed();
    const stray = fs
      .readdirSync(sb.kbRoot, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && !d.name.endsWith('.md'));
    expect(stray).toEqual([]);
  });
});

describe('session lifecycle', () => {
  it('creates a session on start and closes it on stop', () => {
    const e = sb.engine;
    const session = e.startSession('claude-code', sb.root);
    expect(session.status).toBe('active');
    expect(e.sessions.activeId()).toBe(session.id);

    const result = e.endSession({
      harness: 'claude-code',
      cwd: sb.root,
      extraConclusions: ['确认了：本地启动 WES 必须设置 MOCK_ESS=on，否则连不上 ESS'],
      evolve: false,
    });
    expect(result.concluded.length).toBe(1);
    expect(e.sessions.activeId()).toBeNull();

    const files = topicFiles(sb);
    const written = files.filter((f) => f !== 'index.md');
    expect(written.length).toBe(1);
    expect(readPage(sb, written[0]!)).toContain('MOCK_ESS');
  });

  it('leaves the KB untouched when the session settled nothing', () => {
    const e = sb.engine;
    e.startSession('codex', sb.root);
    const before = listMarkdown(sb).length;
    const result = e.endSession({
      harness: 'codex',
      cwd: sb.root,
      extraConclusions: ['可能要看看缓存吧'],
      evolve: false,
    });
    expect(result.concluded).toHaveLength(0);
    expect(listMarkdown(sb)).toHaveLength(before);
    expect(result.report).toContain('untouched');
  });

  it('does not write on a dry run', () => {
    const e = sb.engine;
    e.startSession('trae', sb.root);
    const before = listMarkdown(sb).length;
    const result = e.endSession({
      harness: 'trae',
      cwd: sb.root,
      extraConclusions: ['确认了：传输线到达报文里的 qrcode 大小写不敏感'],
      dryRun: true,
    });
    expect(result.summary).toBeNull();
    expect(listMarkdown(sb)).toHaveLength(before);
  });

  it('is idempotent when the stop hook fires twice', () => {
    const e = sb.engine;
    e.startSession('qoder', sb.root);
    const first = e.endSession({
      harness: 'qoder',
      cwd: sb.root,
      extraConclusions: ['确认了：F629 是位号而不是站点号，站点号走 stationCode'],
      evolve: false,
    });
    const before = readPage(sb, first.summary!.results[0]!.path);
    const second = e.endSession({
      harness: 'qoder',
      cwd: sb.root,
      extraConclusions: ['确认了：F629 是位号而不是站点号，站点号走 stationCode'],
      evolve: false,
    });
    expect(second.summary!.results[0]!.addedLines).toBe(0);
    expect(readPage(sb, first.summary!.results[0]!.path)).toBe(before);
  });
});
