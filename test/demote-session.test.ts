import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sandbox, readPage, type Sandbox } from './helpers.js';

let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
});

afterEach(() => {
  sb.cleanup();
});

/** Write a page that a session will then grow a long detail section on. */
function pageWithLongDetail(rel: string): void {
  sb.engine.addManualConclusions(['确认了：信号量负数导致 429 (commit abc1234)'], rel);
  const doc = sb.engine.store.read(rel)!;
  doc.sections.push({
    heading: '细节',
    depth: 2,
    lines: Array.from(
      { length: 12 },
      (_, i) => `- 排查记录 ${i + 1}：查看 availablePermits，确认 acquire/release 配对，对比历史初始值`,
    ),
  });
  sb.engine.store.write(rel, doc);
}

describe('session end demotes heavy detail automatically', () => {
  it('moves detail out of a page the session wrote to', () => {
    pageWithLongDetail('wes/rate-limit.md');
    const res = sb.engine.endSession({
      harness: 'claude-code',
      cwd: sb.root,
      extraConclusions: ['确认了：把 permits 调大之后不再出现负数 (commit def5678)'],
      evolve: false,
    });

    // The session wrote to whichever page recall picked; either way, if it was
    // this page, its detail must have been demoted.
    const touched = res.summary?.pagesTouched ?? [];
    const wasTouched = touched.includes('wes/rate-limit.md');
    if (wasTouched) {
      expect(res.report).toContain('demoted');
      expect(sb.engine.store.exists('references/wes__rate-limit.md')).toBe(true);
    } else {
      // Nothing was written to it, so nothing should have moved either.
      expect(sb.engine.store.exists('references/wes__rate-limit.md')).toBe(false);
    }
  });

  it('does not restructure pages the session never touched', () => {
    pageWithLongDetail('wes/rate-limit.md');
    sb.engine.endSession({
      harness: 'claude-code',
      cwd: sb.root,
      extraConclusions: ['确认了：EPC 网关的端口是 8443，和测试环境不同 (commit aaa1111)'],
      evolve: false,
    });
    expect(sb.engine.store.exists('references/wes__rate-limit.md')).toBe(false);
  });

  it('can be switched off', () => {
    pageWithLongDetail('wes/rate-limit.md');
    sb.engine.endSession({
      harness: 'claude-code',
      cwd: sb.root,
      extraConclusions: ['确认了：信号量负数仍是同一个问题 (commit abc1234)'],
      evolve: false,
      demote: false,
    });
    expect(sb.engine.store.exists('references/wes__rate-limit.md')).toBe(false);
  });

  it('leaves the page under the size budget', () => {
    pageWithLongDetail('wes/rate-limit.md');
    sb.engine.endSession({
      harness: 'claude-code',
      cwd: sb.root,
      extraConclusions: ['确认了：信号量负数仍是同一个问题 (commit abc1234)'],
      evolve: false,
    });
    if (sb.engine.store.exists('references/wes__rate-limit.md')) {
      expect(sb.engine.store.bytesOf('wes/rate-limit.md')).toBeLessThan(1500);
    }
  });

  it('still lints clean afterwards', () => {
    pageWithLongDetail('wes/rate-limit.md');
    sb.engine.endSession({
      harness: 'claude-code',
      cwd: sb.root,
      extraConclusions: ['确认了：信号量负数仍是同一个问题 (commit abc1234)'],
      evolve: false,
    });
    const errors = sb.engine.doctor(false).issues.filter((i) => i.level === 'error');
    expect(errors).toEqual([]);
  });
});

describe('demotion and recall together', () => {
  it('a reference page is found by the words that used to be in the topic page', () => {
    pageWithLongDetail('wes/rate-limit.md');
    sb.engine.demote({ page: 'wes/rate-limit.md', apply: true, minDetailChars: 100 });
    const hits = sb.engine.recallQuery('availablePermits acquire release 配对', 5).hits;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.path.startsWith('references/'))).toBe(true);
  });

  it('the topic page still answers the conclusion-level question', () => {
    pageWithLongDetail('wes/rate-limit.md');
    sb.engine.demote({ page: 'wes/rate-limit.md', apply: true, minDetailChars: 100 });
    const hits = sb.engine.recallQuery('429 信号量负数根因', 5).hits;
    expect(hits.some((h) => h.path === 'wes/rate-limit.md')).toBe(true);
  });
});
