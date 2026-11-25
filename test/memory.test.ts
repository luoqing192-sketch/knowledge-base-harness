import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, readPage, listMarkdown, topicFiles, type Sandbox } from './helpers.js';
import { MemoryStore, MEMORY_FILE, USER_FILE } from '../src/core/memory.js';
import { callKbTool } from '../src/mcp/tools.js';

let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
});

afterEach(() => {
  sb.cleanup();
});

describe('memory layout', () => {
  it('creates MEMORY.md, USER.md and a folder index', () => {
    expect(listMarkdown(sb)).toContain(`memory/${MEMORY_FILE}`);
    expect(listMarkdown(sb)).toContain(`memory/${USER_FILE}`);
    expect(listMarkdown(sb)).toContain('memory/index.md');
  });

  it('keeps memory out of recall so context is not spent twice', () => {
    const e = sb.engine;
    e.applyMemory('memory', [
      { action: 'add', content: '本地 WES 启动必须设置 MOCK_ESS=on，否则连不上 ESS 的 9000 端口' },
    ]);
    const hits = e.recallQuery('MOCK_ESS 怎么设置', 5).hits;
    expect(hits.every((h) => !h.path.startsWith('memory/'))).toBe(true);
  });

  it('injects memory into every prompt even when recall finds nothing', () => {
    sb.engine.applyMemory('user', [{ action: 'add', content: '用户是 WES/ESS 方向的开发者，偏好中文回复' }]);
    const res = sb.engine.onPrompt('claude-code', '量子纠缠退相干时间是多少', sb.root);
    expect(res.hits).toHaveLength(0);
    expect(res.context).toContain('偏好中文回复');
    expect(res.context).toContain('Long-term memory');
  });

  it('puts memory above recall in the injected block', () => {
    const e = sb.engine;
    e.applyMemory('memory', [{ action: 'add', content: '仓库根目录固定是 D:\\luoqing_proj' }]);
    e.addManualConclusions(['确认了：库存扣减必须走 updateStock 唯一入口 (commit abc1234)']);
    const res = e.onPrompt('claude-code', '库存扣减怎么改', sb.root);
    expect(res.context.indexOf('Long-term memory')).toBeLessThan(res.context.indexOf('Knowledge base hits'));
  });
});

describe('memory operations', () => {
  it('adds, patches and removes entries', () => {
    const mem: MemoryStore = sb.engine.memory;
    expect(mem.apply('memory', [{ action: 'add', content: '项目根目录是 D:\\luoqing_proj', section: '环境' }]).ok).toBe(true);

    let view = mem.read('memory');
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]!.section).toBe('环境');

    expect(mem.apply('memory', [{ action: 'patch', old_text: 'D:\\luoqing_proj', content: 'D:\\proj' }]).ok).toBe(true);
    view = mem.read('memory');
    expect(view.entries[0]!.text).toContain('D:\\proj');

    expect(mem.apply('memory', [{ action: 'remove', old_text: 'D:\\proj' }]).ok).toBe(true);
    expect(mem.read('memory').entries).toHaveLength(0);
  });

  it('treats a repeated add as a no-op, not a duplicate', () => {
    const mem = sb.engine.memory;
    mem.apply('memory', [{ action: 'add', content: '统一用中文沟通' }]);
    const second = mem.apply('memory', [{ action: 'add', content: '统一用中文沟通' }]);
    expect(second.ok).toBe(true);
    expect(second.entries).toHaveLength(1);
  });

  it('refuses an ambiguous patch instead of guessing', () => {
    const mem = sb.engine.memory;
    mem.apply('memory', [
      { action: 'add', content: '端口 9102 是 WES', section: '端口' },
      { action: 'add', content: '端口 9102 也可能被占用', section: '端口' },
    ]);
    const res = mem.apply('memory', [{ action: 'patch', old_text: '9102', content: '9103' }]);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('matches 2 entries');
  });

  it('rejects a batch that exceeds the budget and reports current state', () => {
    const mem = sb.engine.memory;
    const long = 'x'.repeat(4100);
    const res = mem.apply('memory', [{ action: 'add', content: long }]);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('over budget');
    // Nothing was written.
    expect(mem.read('memory').entries).toHaveLength(0);
  });

  it('allows a batch that frees space and adds in one call', () => {
    const mem = sb.engine.memory;
    const entry = 'y'.repeat(2000);
    mem.apply('memory', [{ action: 'add', content: entry, section: 'big' }]);
    const before = mem.read('memory').used;

    const res = mem.apply('memory', [
      { action: 'remove', old_text: entry },
      { action: 'add', content: 'z'.repeat(2000), section: 'big' },
    ]);
    expect(res.ok).toBe(true);
    expect(res.used).toBeLessThanOrEqual(res.limit);
    expect(Math.abs(res.used - before)).toBeLessThan(50);
    const texts = mem.read('memory').entries.map((e) => e.text);
    expect(texts.some((t) => t.startsWith('zzz'))).toBe(true);
    expect(texts.some((t) => t.startsWith('yyy'))).toBe(false);
  });

  it('warns when a store is nearly full', () => {
    const mem = sb.engine.memory;
    mem.apply('memory', [{ action: 'add', content: 'q'.repeat(3600) }]);
    const res = sb.engine.onPrompt('claude-code', '随便问一句', sb.root);
    expect(res.memoryWarning).toContain('MEMORY.md');
    expect(res.context).toContain('nearly full');
  });

  it('reports usage for both stores', () => {
    const usage = sb.engine.memory.usage();
    expect(usage.memory.limit).toBe(4000);
    expect(usage.user.limit).toBe(2000);
    // Fresh pages carry only their heading/description boilerplate.
    expect(usage.pressure).toBeLessThan(0.2);
    expect(usage.memory.used).toBeGreaterThanOrEqual(0);
  });
});

describe('memory via MCP', () => {
  it('writes and reads through the kb_memory tool', async () => {
    const res = await callKbTool(sb.engine, 'kb_memory', {
      target: 'memory',
      operations: [{ action: 'add', content: 'ESS 起来后必须调 restartController 才有 contextInit', section: 'ESS' }],
    });
    expect(res.content[0]!.text).toContain('Applied 1 operation');
    expect(res.content[0]!.text).toContain('restartController');
  });

  it('returns the current state when a write is rejected', async () => {
    const res = await callKbTool(sb.engine, 'kb_memory', {
      target: 'memory',
      operations: [{ action: 'add', content: 'w'.repeat(5000) }],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('over budget');
  });

  it('acts as a read when no operations are given', async () => {
    sb.engine.applyMemory('user', [{ action: 'add', content: '偏好中文' }]);
    const res = await callKbTool(sb.engine, 'kb_memory', { target: 'user', operations: [] });
    expect(res.content[0]!.text).toContain('偏好中文');
    expect(res.content[0]!.text).toContain('USER.md');
  });

  it('rejects an unknown target', async () => {
    const res = await callKbTool(sb.engine, 'kb_memory', { target: 'other', operations: [] });
    expect(res.isError).toBe(true);
  });
});

describe('agent-declared supersession', () => {
  it('strikes through the declared predecessor', () => {
    const e = sb.engine;
    e.addManualConclusions(['确认了：缓存前缀必须带租户标识 (commit c0fc856bbb)'], 'topics/cache.md');
    e.addManualConclusions(
      ['确认了：缓存前缀改为按 environmentCode 拼接 (commit d1ab123abc)'],
      'topics/cache.md',
      '缓存前缀必须带租户标识',
    );
    const text = readPage(sb, 'topics/cache.md');
    expect(text).toContain('~~');
    expect(text).toContain('已被取代');
    expect(text).toContain('environmentCode');
  });

  it('does not need the heuristic when supersedes is declared', () => {
    const e = sb.engine;
    e.addManualConclusions(['确认了：部署脚本用 bash 写'], 'ops/deploy.md');
    // Nothing about these two sentences looks like a revision, but the agent
    // said it is one.
    e.addManualConclusions(['确认了：部署脚本用 python 写'], 'ops/deploy.md', '部署脚本用 bash 写');
    const text = readPage(sb, 'ops/deploy.md');
    expect(text).toMatch(/~~.*bash/);
    expect(text).toContain('python');
  });

  it('accepts supersedes through the MCP tool', async () => {
    const e = sb.engine;
    e.addManualConclusions(['确认了：分播查重基准用 sowedSkuList'], 'topics/sowing.md');
    const res = await callKbTool(e, 'kb_note', {
      conclusion: '确认了：分播查重基准用 pickSkuList',
      target: 'topics/sowing.md',
      supersedes: '分播查重基准用 sowedSkuList',
    });
    expect(res.content[0]!.text).toContain('superseded 1');
  });
});

describe('memory folder stays inside the wiki rules', () => {
  it('keeps every memory file markdown', () => {
    const stray = fs
      .readdirSync(path.join(sb.kbRoot, 'memory'), { withFileTypes: true })
      .filter((d) => d.isFile() && !d.name.endsWith('.md'));
    expect(stray).toEqual([]);
  });

  it('lints clean', () => {
    const issues = sb.engine.doctor(false).issues;
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('does not let topic pages leak into the memory folder', () => {
    sb.engine.addManualConclusions(['确认了：这是一个普通页面 (commit abc1234)']);
    expect(topicFiles(sb).some((f) => f.startsWith('memory/'))).toBe(false);
  });
});
