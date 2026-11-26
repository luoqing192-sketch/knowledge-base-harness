import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, type Sandbox } from './helpers.js';
import { renderIndex, recallByPath, tierHits, recall } from '../src/core/recall.js';
import { findPromotableMemory } from '../src/core/evolve.js';

let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
});

afterEach(() => {
  sb.cleanup();
});

/** Write a page with arbitrary front matter, then refresh the index. */
function page(rel: string, frontmatter: string, body = '## 结论\n\n- 占位结论，用于测试。\n'): void {
  const abs = path.join(sb.kbRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `---\n${frontmatter}\n---\n\n# 测试页\n\n${body}`);
  sb.engine.store.loadIndex(true);
}

describe('path-scoped recall', () => {
  it('finds a page by the file the agent opened, not by the prompt', () => {
    page(
      'api/handler-rules.md',
      'id: handler-rules\ntitle: API handler 约定\nsummary: 统一错误结构\npaths: ["src/api/**"]',
    );
    // The prompt never mentions "api"; only the file access does.
    const hits = recallByPath(sb.engine.store, path.join(sb.root, 'src/api/handler.ts'), { cwd: sb.root });
    expect(hits.map((h) => h.path)).toEqual(['api/handler-rules.md']);
  });

  it('ignores pages with no paths front matter', () => {
    page('plain.md', 'id: plain\ntitle: 普通页面\nsummary: 没有 paths');
    expect(recallByPath(sb.engine.store, path.join(sb.root, 'src/x.ts'), { cwd: sb.root })).toEqual([]);
  });

  it('does not match a file outside the project', () => {
    page('api/p.md', 'id: api-p\ntitle: API\nsummary: s\npaths: ["src/api/**"]');
    expect(recallByPath(sb.engine.store, '/elsewhere/other.ts', { cwd: sb.root })).toEqual([]);
  });

  it('prefers the more specific pattern', () => {
    page('a.md', 'id: a\ntitle: 宽\nsummary: s\npaths: ["src/**"]');
    page('b.md', 'id: b\ntitle: 窄\nsummary: s\npaths: ["src/api/**"]');
    const hits = recallByPath(sb.engine.store, path.join(sb.root, 'src/api/x.ts'), { cwd: sb.root });
    expect(hits[0]!.path).toBe('b.md');
  });
});

describe('tiered injection', () => {
  it('splits hits into excerpted and outline tiers', () => {
    const hits = Array.from({ length: 5 }, (_, i) => ({
      path: `p${i}.md`,
      title: `T${i}`,
      summary: `S${i}`,
      tags: [],
      score: 1,
      snippets: ['snip'],
      isIndex: false,
    }));
    const { detailed, outline } = tierHits(hits, 2);
    expect(detailed.map((h) => h.path)).toEqual(['p0.md', 'p1.md']);
    expect(outline.map((h) => h.path)).toEqual(['p2.md', 'p3.md', 'p4.md']);
  });

  it('renders an outline far cheaper than excerpts', () => {
    const hits = Array.from({ length: 4 }, (_, i) => ({
      path: `page-${i}.md`,
      title: `标题 ${i}`,
      summary: '摘要文字',
      tags: [],
      score: 1,
      snippets: ['一'.repeat(200)],
      isIndex: false,
    }));
    const outline = renderIndex(hits);
    expect(outline).toContain('page-0.md');
    expect(outline).not.toContain('一'.repeat(200));
    expect(outline.length).toBeLessThan(600);
  });

  it('omits the outline entirely when every hit is excerpted', () => {
    expect(renderIndex([])).toBe('');
  });
});

describe('memory promotion', () => {
  it('flags a procedural entry even when it is not long', () => {
    sb.engine.applyMemory('memory', [
      { action: 'add', content: '发布前先跑 npm test，然后 bump 版本号，最后打 tag 并推送' },
    ]);
    const found = findPromotableMemory(sb.engine.memory);
    expect(found.length).toBe(1);
    expect(found[0]!.reason).toContain('procedure');
  });

  it('flags a long factual entry', () => {
    sb.engine.applyMemory('memory', [
      { action: 'add', content: `环境说明：${'本地 WES 固定 9102，ESS 9000，Redis 与 MySQL 都在本机。'.repeat(3)}` },
    ]);
    const found = findPromotableMemory(sb.engine.memory);
    expect(found.length).toBe(1);
    expect(found[0]!.reason).toContain('chars');
  });

  it('leaves a short durable fact alone', () => {
    sb.engine.applyMemory('memory', [{ action: 'add', content: '本地 WES 固定用 9102' }]);
    expect(findPromotableMemory(sb.engine.memory)).toEqual([]);
  });

  it('moves the entry to a page and frees the budget on --apply', () => {
    const text = '排查上架异常要先看 ESS 的 container 状态，再对照 WES 的 putaway 记录，最后确认库位是否被锁';
    sb.engine.applyMemory('memory', [{ action: 'add', content: text }]);
    const before = sb.engine.memory.usage().memory.used;

    const applied = sb.engine.promoteMemory({ apply: true });
    expect(applied.promoted.length).toBe(1);
    expect(applied.promoted[0]!.page.endsWith('.md')).toBe(true);

    expect(sb.engine.memory.read('memory').entries.map((e) => e.text)).not.toContain(text);
    expect(sb.engine.memory.usage().memory.used).toBeLessThan(before);
    // The knowledge itself was not lost: it now lives on a page.
    expect(sb.engine.store.raw(applied.promoted[0]!.page)).toContain('排查上架异常');
  });

  it('does nothing on a dry run', () => {
    const text = '排查上架异常要先看 ESS 的 container 状态，再对照 WES 的 putaway 记录，最后确认库位是否被锁';
    sb.engine.applyMemory('memory', [{ action: 'add', content: text }]);
    const preview = sb.engine.promoteMemory();
    expect(preview.promoted).toEqual([]);
    expect(preview.text).toContain('would move');
    expect(sb.engine.memory.read('memory').entries.map((e) => e.text)).toContain(text);
  });
});

describe('mid-session flush', () => {
  it('settles pending notes without ending the session', () => {
    sb.engine.startSession('claude-code', sb.root);
    sb.engine.onPrompt('claude-code', 'kb: 库存扣减必须走 updateStock 唯一入口 (src/persist/StockRepo.java)', sb.root);

    const flushed = sb.engine.flushSession();
    expect(flushed.kept).toBe(1);
    expect(flushed.written?.pagesTouched.length).toBe(1);
    expect(sb.engine.sessions.activeId()).not.toBeNull();
  });

  it('does not re-settle the same notes at session end', () => {
    sb.engine.startSession('claude-code', sb.root);
    sb.engine.onPrompt('claude-code', 'kb: 库存扣减必须走 updateStock 唯一入口 (src/persist/StockRepo.java)', sb.root);
    sb.engine.flushSession();

    const end = sb.engine.endSession({ cwd: sb.root });
    expect(end.concluded).toHaveLength(0);
  });

  it('is a no-op with no active session', () => {
    expect(sb.engine.flushSession().text).toContain('no active session');
  });
});
