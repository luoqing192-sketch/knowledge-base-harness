import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, readPage, liveFiles, type Sandbox } from './helpers.js';
import {
  demoteDetails,
  findDetailHeavyPages,
  auditReferences,
  referencePathFor,
  relativeLink,
  REFERENCES_DIR,
} from '../src/core/references.js';
import { recall } from '../src/core/recall.js';
import { findNarrowPages } from '../src/core/curator.js';
import { findDecayingPages } from '../src/core/evolve.js';

let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
});

afterEach(() => {
  sb.cleanup();
});

/** A page with a conclusion plus a long detail section. */
function seedHeavy(page = 'wes/rate-limit.md', lines = 12): void {
  sb.engine.addManualConclusions(
    ['确认了：这个报错的根因是信号量负数导致的 429 (commit abc1234)'],
    page,
  );
  const doc = sb.engine.store.read(page)!;
  doc.sections.push({
    heading: '细节',
    depth: 2,
    lines: Array.from(
      { length: lines },
      (_, i) =>
        `- 排查步骤 ${i + 1}：查看 semaphore.availablePermits 的实时值，确认 acquire 与 release 是否配对，对比上一版本 Semaphore 的初始 permits 配置`,
    ),
  });
  sb.engine.store.write(page, doc);
}

describe('paths and links', () => {
  it('flattens nested paths into the references folder', () => {
    expect(referencePathFor('wes/rate-limit.md')).toBe('references/wes__rate-limit.md');
    expect(referencePathFor('a/b/c.md')).toBe('references/a__b__c.md');
  });

  it('builds a working relative link from any depth', () => {
    expect(relativeLink('wes/rate-limit.md', 'references/wes__rate-limit.md')).toBe(
      '../references/wes__rate-limit.md',
    );
    expect(relativeLink('top.md', 'references/x.md')).toBe('references/x.md');
    expect(relativeLink('a/b/c.md', 'references/x.md')).toBe('../../references/x.md');
  });
});

describe('finding candidates', () => {
  it('reports pages whose detail section is above the threshold', () => {
    seedHeavy();
    const found = findDetailHeavyPages(sb.engine.store, { minDetailChars: 400 });
    expect(found).toHaveLength(1);
    expect(found[0]!.page).toBe('wes/rate-limit.md');
    expect(found[0]!.detailChars).toBeGreaterThan(400);
  });

  it('ignores a short detail section', () => {
    seedHeavy('wes/small.md', 1);
    expect(findDetailHeavyPages(sb.engine.store, { minDetailChars: 400 })).toHaveLength(0);
  });

  it('never proposes pages that are already references or archived', () => {
    seedHeavy('references/already.md', 12);
    seedHeavy('_archive/old.md', 12);
    const found = findDetailHeavyPages(sb.engine.store, { minDetailChars: 100 });
    expect(found.some((f) => f.page.startsWith('references/'))).toBe(false);
    expect(found.some((f) => f.page.startsWith('_archive/'))).toBe(false);
  });
});

describe('demoting', () => {
  it('moves the detail body and leaves a link', () => {
    seedHeavy();
    const before = sb.engine.store.bytesOf('wes/rate-limit.md');
    const res = demoteDetails(sb.engine.store, 'wes/rate-limit.md', { minDetailChars: 100 })!;

    expect(res.created).toBe(true);
    expect(res.bytesAfter).toBeLessThan(before);
    expect(res.linesMoved).toBeGreaterThan(0);

    const page = readPage(sb, 'wes/rate-limit.md');
    expect(page).not.toContain('排查步骤 3');
    expect(page).toContain('references/wes__rate-limit.md');
    // The conclusion stays put — that is the point of the split.
    expect(page).toContain('信号量负数导致的 429');
  });

  it('keeps the moved text verbatim in the reference page', () => {
    seedHeavy();
    demoteDetails(sb.engine.store, 'wes/rate-limit.md', { minDetailChars: 100 });
    const ref = readPage(sb, 'references/wes__rate-limit.md');
    for (let i = 1; i <= 12; i++) {
      expect(ref).toContain(`排查步骤 ${i}`);
    }
  });

  it('records derivedFrom so the direction is machine-readable', () => {
    seedHeavy();
    demoteDetails(sb.engine.store, 'wes/rate-limit.md', { minDetailChars: 100 });
    const doc = sb.engine.store.read('references/wes__rate-limit.md')!;
    expect(doc.frontmatter.derivedFrom).toBe('wes/rate-limit.md');
  });

  it('refuses to move a detail section below the threshold', () => {
    seedHeavy('wes/small.md', 1);
    expect(demoteDetails(sb.engine.store, 'wes/small.md', { minDetailChars: 400 })).toBeNull();
  });

  it('is idempotent: a second call does not move the pointer line', () => {
    seedHeavy();
    demoteDetails(sb.engine.store, 'wes/rate-limit.md', { minDetailChars: 100 });
    const pageAfterFirst = readPage(sb, 'wes/rate-limit.md');
    const again = demoteDetails(sb.engine.store, 'wes/rate-limit.md', { minDetailChars: 1, force: true });
    expect(again).toBeNull();
    expect(readPage(sb, 'wes/rate-limit.md')).toBe(pageAfterFirst);
  });

  it('appends to the existing reference page instead of creating a second one', () => {
    seedHeavy();
    demoteDetails(sb.engine.store, 'wes/rate-limit.md', { minDetailChars: 100 });

    // The page grows a new detail section later (a second investigation).
    const doc = sb.engine.store.read('wes/rate-limit.md')!;
    const detail = doc.sections.find((s) => s.heading === '细节')!;
    detail.lines = ['- 第二轮排查：把 permits 从 10 调到 20 之后不再出现负数，说明问题是单实例并发数超过上限'];
    sb.engine.store.write('wes/rate-limit.md', doc);

    const res = demoteDetails(sb.engine.store, 'wes/rate-limit.md', { minDetailChars: 10, force: true })!;
    expect(res.created).toBe(false);
    const ref = readPage(sb, 'references/wes__rate-limit.md');
    expect(ref).toContain('排查步骤 1');
    expect(ref).toContain('第二轮排查');
  });

  it('creates the references folder index', () => {
    seedHeavy();
    demoteDetails(sb.engine.store, 'wes/rate-limit.md', { minDetailChars: 100 });
    expect(fs.existsSync(path.join(sb.kbRoot, REFERENCES_DIR, 'index.md'))).toBe(true);
  });

  it('returns null for a page without a detail section', () => {
    sb.engine.addManualConclusions(['确认了：没有细节段的页面 (commit abc1234)'], 'x/plain.md');
    expect(demoteDetails(sb.engine.store, 'x/plain.md')).toBeNull();
  });
});

describe('reference pages stay live', () => {
  it('is indexed and recallable — unlike_archive', () => {
    seedHeavy();
    demoteDetails(sb.engine.store, 'wes/rate-limit.md', { minDetailChars: 100 });
    const hits = recall(sb.engine.store, 'semaphore availablePermits 配对', { limit: 5 });
    expect(hits.some((h) => h.path.startsWith('references/'))).toBe(true);
  });

  it('has a summary built from its body so recall can score it', () => {
    seedHeavy();
    demoteDetails(sb.engine.store, 'wes/rate-limit.md', { minDetailChars: 100 });
    const doc = sb.engine.store.read('references/wes__rate-limit.md')!;
    expect(doc.frontmatter.summary).toContain('排查步骤');
    expect(doc.frontmatter.summary.length).toBeLessThanOrEqual(200);
  });

  it('is still lint-clean', () => {
    seedHeavy();
    demoteDetails(sb.engine.store, 'wes/rate-limit.md', { minDetailChars: 100 });
    const errors = sb.engine.doctor(false).issues.filter((i) => i.level === 'error');
    expect(errors).toEqual([]);
  });

  it('does not add live "topic" pages when nothing is demoted', () => {
    seedHeavy('wes/small.md', 1);
    const before = liveFiles(sb).length;
    demoteDetails(sb.engine.store, 'wes/small.md', { minDetailChars: 400 });
    expect(liveFiles(sb)).toHaveLength(before);
  });
});

describe('auditing references', () => {
  it('reports a healthy reference with its source', () => {
    seedHeavy();
    demoteDetails(sb.engine.store, 'wes/rate-limit.md', { minDetailChars: 100 });
    const audit = auditReferences(sb.engine.store);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.source).toBe('wes/rate-limit.md');
    expect(audit[0]!.orphan).toBe(false);
  });

  it('flags a reference whose source was deleted', () => {
    seedHeavy();
    demoteDetails(sb.engine.store, 'wes/rate-limit.md', { minDetailChars: 100 });
    fs.unlinkSync(sb.engine.store.abs('wes/rate-limit.md'));
    const audit = auditReferences(sb.engine.store);
    expect(audit[0]!.orphan).toBe(true);
    expect(sb.engine.orphanReferences()).toHaveLength(1);
  });
});

describe('engine integration', () => {
  it('demote is a dry run by default', () => {
    seedHeavy();
    const before = readPage(sb, 'wes/rate-limit.md');
    const dry = sb.engine.demote({ minDetailChars: 100 });
    expect(dry.candidates).toHaveLength(1);
    expect(dry.results).toHaveLength(0);
    expect(dry.text).toContain('dry run');
    expect(readPage(sb, 'wes/rate-limit.md')).toBe(before);
  });

  it('demote --apply moves the detail', () => {
    seedHeavy();
    const wet = sb.engine.demote({ apply: true, minDetailChars: 100 });
    expect(wet.results).toHaveLength(1);
    expect(sb.engine.store.exists('references/wes__rate-limit.md')).toBe(true);
  });

  it('scopes to one page when asked', () => {
    seedHeavy('a/one.md');
    seedHeavy('b/two.md');
    const res = sb.engine.demote({ page: 'a/one.md', apply: true, minDetailChars: 100 });
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.page).toBe('a/one.md');
    expect(sb.engine.store.exists('references/b__two.md')).toBe(false);
  });
});

describe('reference pages are protected from the other maintenance passes', () => {
  it('is never proposed for consolidation', () => {
    seedHeavy('references/x__y.md', 12);
    seedHeavy('references/x__z.md', 12);
    seedHeavy('references/x__w.md', 12);
    const narrow = findNarrowPages(sb.engine.store);
    expect(narrow.some((p) => p.path.startsWith('references/'))).toBe(false);
  });

  it('is never compressed (it is the intended home of long text)', () => {
    seedHeavy();
    demoteDetails(sb.engine.store, 'wes/rate-limit.md', { minDetailChars: 100 });
    const before = sb.engine.store.bytesOf('references/wes__rate-limit.md');
    sb.engine.compress();
    expect(sb.engine.store.bytesOf('references/wes__rate-limit.md')).toBe(before);
  });

  it('is not counted as a decay candidate', () => {
    seedHeavy();
    demoteDetails(sb.engine.store, 'wes/rate-limit.md', { minDetailChars: 100 });
    const decaying = findDecayingPages(sb.engine.store, sb.engine.stats, { coldAfterDays: 0 });
    expect(decaying.some((d) => d.page.startsWith('references/'))).toBe(false);
  });
});
