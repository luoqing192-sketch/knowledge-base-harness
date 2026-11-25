import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, readPage, liveFiles, type Sandbox } from './helpers.js';
import {
  clusterNarrowPages,
  findNarrowPages,
  planConsolidations,
  applyPlans,
  commonTitle,
  validateLlmPlans,
  planWithLlm,
} from '../src/core/curator.js';
import { findDecayingPages } from '../src/core/evolve.js';

let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
});

afterEach(() => {
  sb.cleanup();
});

/** Seed a numbered series, the classic "many narrow siblings" shape. */
function seedSeries(dir: string, prefix: string, n: number, body: (i: number) => string): void {
  for (let i = 1; i <= n; i++) {
    sb.engine.addManualConclusions([body(i)], `${dir}/${prefix}-${i}.md`);
  }
}

describe('narrow page detection', () => {
  it('finds small single-fact pages and ignores rich ones', () => {
    seedSeries('ess', 'pitfall', 3, (i) => `确认了：ESS 第 ${i} 个坑是 contextInit 没触发 (commit abc123${i})`);
    sb.engine.addManualConclusions(
      [
        '确认了：库存扣减必须走 updateStock (commit 111aaaa)',
        '确认了：批次号必须带日期 (commit 222bbbb)',
        '确认了：格口与 SKU 是唯一库存键 (commit 333cccc)',
        '确认了：盘点只放行未离库容器 (commit 444dddd)',
      ],
      'wes/stock.md',
    );

    const narrow = findNarrowPages(sb.engine.store);
    const paths = narrow.map((p) => p.path);
    expect(paths).toContain('ess/pitfall-1.md');
    expect(paths).not.toContain('wes/stock.md');
  });

  it('never proposes memory or archive pages', () => {
    seedSeries('_archive', 'old', 3, (i) => `确认了：旧结论 ${i} (commit aaa000${i})`);
    const narrow = findNarrowPages(sb.engine.store);
    expect(narrow.some((p) => p.path.startsWith('_archive/'))).toBe(false);
    expect(narrow.some((p) => p.path.startsWith('memory/'))).toBe(false);
  });

  it('flags filenames that are session artifacts', () => {
    seedSeries('notes', 'pr-1234-fix', 2, (i) => `确认了：PR 1234 的第 ${i} 处修复 (commit aaa000${i})`);
    const narrow = findNarrowPages(sb.engine.store);
    expect(narrow.some((p) => p.artifact)).toBe(true);
  });
});

describe('clustering', () => {
  it('groups a numbered series by its shared slug token', () => {
    seedSeries('ess', 'pitfall', 4, (i) => `确认了：ESS 第 ${i} 个坑 (commit abc123${i})`);
    const pages = findNarrowPages(sb.engine.store);
    const clusters = clusterNarrowPages(pages);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.sources).toHaveLength(4);
    expect(clusters[0]!.slug).toBe('pitfall');
  });

  it('groups by a shared specific tag', () => {
    sb.engine.addManualConclusions(['确认了：分组结论一 (commit aaa0001)'], 'x/a.md');
    sb.engine.addManualConclusions(['确认了：分组结论二 (commit aaa0002)'], 'x/b.md');
    sb.engine.addManualConclusions(['确认了：分组结论三 (commit aaa0003)'], 'x/c.md');
    for (const rel of ['x/a.md', 'x/b.md', 'x/c.md']) {
      const doc = sb.engine.store.read(rel)!;
      doc.frontmatter.tags = ['ipo-case'];
      sb.engine.store.write(rel, doc);
    }
    const pages = findNarrowPages(sb.engine.store);
    const clusters = clusterNarrowPages(pages);
    expect(clusters.some((c) => c.reason.includes('ipo-case'))).toBe(true);
  });

  it('leaves a lone page alone', () => {
    sb.engine.addManualConclusions(['确认了：孤零零一条 (commit aaa0001)'], 'x/only.md');
    const clusters = clusterNarrowPages(findNarrowPages(sb.engine.store));
    expect(clusters).toHaveLength(0);
  });

  it('respects minClusterSize', () => {
    seedSeries('ess', 'pitfall', 3, (i) => `确认了：ESS 第 ${i} 个坑 (commit abc123${i})`);
    const pages = findNarrowPages(sb.engine.store);
    expect(clusterNarrowPages(pages, { minClusterSize: 5 })).toHaveLength(0);
  });
});

describe('planning', () => {
  it('produces an umbrella path and a readable title', () => {
    seedSeries('ops', 'plugin-step', 3, (i) => `确认了：插件部署第 ${i} 步要核对版本 (commit def456${i})`);
    const report = planConsolidations(sb.engine.store);
    expect(report.plans).toHaveLength(1);
    const plan = report.plans[0]!;
    expect(plan.umbrella).toMatch(/^ops\//);
    expect(plan.sources).toHaveLength(3);
    expect(plan.projectedBytes).toBeGreaterThan(0);
  });

  it('skips a cluster whose merged page would exceed the budget', () => {
    const big = 'x'.repeat(2400);
    seedSeries('huge', 'blob', 3, (i) => `确认了：第 ${i} 条 ${big} (commit aaa000${i})`);
    const report = planConsolidations(sb.engine.store, { maxConclusionsPerPage: 10 });
    expect(report.plans).toHaveLength(0);
    expect(report.skipped.length).toBeGreaterThan(0);
    expect(report.skipped[0]!.reason).toContain('targetPageBytes');
  });

  it('never reuses an existing umbrella path', () => {
    seedSeries('ops', 'plugin-step', 3, (i) => `确认了：第 ${i} 步 (commit def456${i})`);
    const first = planConsolidations(sb.engine.store).plans[0]!;
    // Simulate an unrelated page already sitting at that path.
    fs.writeFileSync(path.join(sb.kbRoot, first.umbrella), '---\ntitle: occupied\n---\n\n# occupied\n');
    const second = planConsolidations(sb.engine.store).plans[0]!;
    expect(second.umbrella).not.toBe(first.umbrella);
  });

  it('is a dry run: planning never touches disk', () => {
    seedSeries('ess', 'pitfall', 3, (i) => `确认了：第 ${i} 个坑 (commit abc123${i})`);
    const before = liveFiles(sb).length;
    planConsolidations(sb.engine.store);
    expect(liveFiles(sb)).toHaveLength(before);
  });
});

describe('applying', () => {
  it('archives the sources and builds one umbrella page', () => {
    seedSeries('ess', 'pitfall', 4, (i) => `确认了：ESS 第 ${i} 个坑是 contextInit (commit abc123${i})`);
    const report = planConsolidations(sb.engine.store);
    const applied = applyPlans(sb.engine.store, report.plans);
    expect(applied).toHaveLength(1);

    const umbrella = applied[0]!.umbrella;
    expect(sb.engine.store.exists(umbrella)).toBe(true);

    // Sources are gone from the live tree…
    for (const source of report.plans[0]!.sources) {
      expect(sb.engine.store.exists(source)).toBe(false);
    }
    // …but preserved verbatim in the archive.
    const archived = sb.engine.store.scan().files.filter((f) => f.startsWith('_archive/') && f !== '_archive/index.md');
    expect(archived.length).toBe(4);
    const archivedText = readPage(sb, archived[0]!);
    expect(archivedText).toContain('absorbedInto:');
    expect(archivedText).toContain(umbrella);

    const text = readPage(sb, umbrella);
    expect(text).toContain('第 1 个坑');
    expect(text).toContain('第 4 个坑');
    expect(text).toContain('## 来源');
  });

  it('rebuilds the folder indices after a merge', () => {
    seedSeries('ess', 'pitfall', 3, (i) => `确认了：第 ${i} 个坑 (commit abc123${i})`);
    applyPlans(sb.engine.store, planConsolidations(sb.engine.store).plans);
    const index = readPage(sb, 'ess/index.md');
    expect(index).toContain('pitfall');
    expect(index).not.toContain('pitfall-1');
  });

  it('lints clean after a merge', () => {
    seedSeries('ess', 'pitfall', 3, (i) => `确认了：第 ${i} 个坑 (commit abc123${i})`);
    applyPlans(sb.engine.store, planConsolidations(sb.engine.store).plans);
    const errors = sb.engine.doctor(false).issues.filter((i) => i.level === 'error');
    expect(errors).toEqual([]);
  });

  it('is idempotent: a second run has nothing left to merge', () => {
    seedSeries('ess', 'pitfall', 3, (i) => `确认了：第 ${i} 个坑 (commit abc123${i})`);
    applyPlans(sb.engine.store, planConsolidations(sb.engine.store).plans);
    const second = planConsolidations(sb.engine.store);
    expect(second.plans).toHaveLength(0);
  });

  it('skips a plan whose sources vanished', () => {
    seedSeries('ess', 'pitfall', 3, (i) => `确认了：第 ${i} 个坑 (commit abc123${i})`);
    const plans = planConsolidations(sb.engine.store).plans;
    fs.unlinkSync(sb.engine.store.abs(plans[0]!.sources[0]!));
    expect(applyPlans(sb.engine.store, plans)).toHaveLength(0);
  });

  it('keeps the deleted pages out of the decay report', () => {
    seedSeries('ess', 'pitfall', 3, (i) => `确认了：第 ${i} 个坑 (commit abc123${i})`);
    applyPlans(sb.engine.store, planConsolidations(sb.engine.store).plans);
    const decaying = findDecayingPages(sb.engine.store, sb.engine.stats, { coldAfterDays: 0 });
    expect(decaying.some((d) => d.page.includes('pitfall-1'))).toBe(false);
  });
});

describe('umbrella naming', () => {
  it('uses the titles\' longest common prefix', () => {
    const title = commonTitle([
      { title: '插件部署第 1 步必须核对版本', path: 'a', dir: '', tags: [], conclusions: [], bytes: 0, artifact: false, isMemory: false },
      { title: '插件部署第 2 步必须核对版本', path: 'b', dir: '', tags: [], conclusions: [], bytes: 0, artifact: false, isMemory: false },
    ]);
    expect(title).toBe('插件部署');
  });

  it('returns null when titles share nothing', () => {
    const title = commonTitle([
      { title: '完全不同的主题甲', path: 'a', dir: '', tags: [], conclusions: [], bytes: 0, artifact: false, isMemory: false },
      { title: '另一件事乙', path: 'b', dir: '', tags: [], conclusions: [], bytes: 0, artifact: false, isMemory: false },
    ]);
    expect(title).toBeNull();
  });
});

describe('model-proposed plans', () => {
  const page = (p: string, title = p) => ({
    path: p,
    dir: path.posix.dirname(p),
    title,
    tags: [],
    conclusions: ['x'],
    bytes: 100,
    artifact: false,
    isMemory: false,
  });

  it('accepts a valid proposal', () => {
    const { plans, rejected } = validateLlmPlans(
      sb.engine.store,
      { plans: [{ umbrella: 'a/merged.md', title: 'Merged', sources: ['a/one.md', 'a/two.md'] }] },
      [page('a/one.md'), page('a/two.md')],
    );
    expect(rejected).toHaveLength(0);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.umbrella).toBe('a/merged.md');
  });

  it('rejects invented source paths', () => {
    const { plans, rejected } = validateLlmPlans(
      sb.engine.store,
      { plans: [{ umbrella: 'a/m.md', title: 'M', sources: ['a/one.md', 'a/ghost.md'] }] },
      [page('a/one.md')],
    );
    expect(plans).toHaveLength(0);
    expect(rejected[0]!.reason).toContain('unknown source');
  });

  it('rejects a proposal that would overwrite an existing page', () => {
    seedSeries('a', 'x', 2, (i) => `确认了：第 ${i} 条 (commit aaa000${i})`);
    const { plans, rejected } = validateLlmPlans(
      sb.engine.store,
      { plans: [{ umbrella: 'a/x-1.md', title: 'M', sources: ['a/x-1.md', 'a/x-2.md'] }] },
      [page('a/x-1.md'), page('a/x-2.md')],
    );
    expect(plans).toHaveLength(0);
    expect(rejected[0]!.reason).toContain('already exists');
  });

  it('rejects a single-source merge', () => {
    const { rejected } = validateLlmPlans(
      sb.engine.store,
      { plans: [{ umbrella: 'a/m.md', title: 'M', sources: ['a/one.md'] }] },
      [page('a/one.md')],
    );
    expect(rejected[0]!.reason).toContain('at least 2 sources');
  });

  it('rejects absorbing archived pages', () => {
    const { rejected } = validateLlmPlans(
      sb.engine.store,
      { plans: [{ umbrella: 'm.md', title: 'M', sources: ['_archive/a.md', '_archive/b.md'] }] },
      [page('_archive/a.md'), page('_archive/b.md')],
    );
    expect(rejected[0]!.reason).toContain('archived');
  });

  it('survives a model that answers with prose', async () => {
    seedSeries('a', 'x', 2, (i) => `确认了：第 ${i} 条 (commit aaa000${i})`);
    const res = await planWithLlm(sb.engine.store, async () => 'Sure! I would merge those two pages.');
    expect(res.report.plans).toHaveLength(0);
    expect(res.rejected[0]!.reason).toContain('did not return JSON');
  });

  it('unwraps a fenced JSON answer', async () => {
    seedSeries('a', 'x', 2, (i) => `确认了：第 ${i} 条 (commit aaa000${i})`);
    const res = await planWithLlm(sb.engine.store, async () =>
      '```json\n{"plans":[{"umbrella":"a/x.md","title":"X","sources":["a/x-1.md","a/x-2.md"]}]}\n```',
    );
    expect(res.report.plans).toHaveLength(1);
  });
});

describe('engine integration', () => {
  it('curate is dry-run by default and writes with apply', async () => {
    seedSeries('ess', 'pitfall', 3, (i) => `确认了：第 ${i} 个坑 (commit abc123${i})`);
    const before = liveFiles(sb).length;

    const dry = await sb.engine.curate();
    expect(dry.report.plans.length).toBeGreaterThan(0);
    expect(dry.report.applied).toHaveLength(0);
    expect(liveFiles(sb)).toHaveLength(before);
    expect(dry.text).toContain('dry run');

    const wet = await sb.engine.curate({ apply: true });
    expect(wet.report.applied.length).toBeGreaterThan(0);
    expect(liveFiles(sb).length).toBeLessThan(before);
  });
});
