import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { compressPage } from '../src/core/compress.js';
import { findSupersession, findPromotionCandidates, recordAdoption, StatsStore, evolveAfterSession, findDecayingPages } from '../src/core/evolve.js';
import { readPage, sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;

beforeEach(() => {
  sb = sandbox({ maxPageBytes: 2000, targetPageBytes: 1200, maxBulletsPerSection: 12 });
});

afterEach(() => {
  sb.cleanup();
});

describe('compression', () => {
  it('archives the oldest conclusions instead of deleting them', () => {
    const e = sb.engine;
    const bullets: string[] = [];
    for (let i = 0; i < 40; i++) {
      bullets.push(`- 第 ${i} 条结论：库存扣减在格口 ${i} 上必须带批次号，否则回滚会串批 (commit ${(0xabcdef0 + i).toString(16)})`);
    }
    e.addManualConclusions([bullets[0]!], undefined);
    const page = e.store.scan().files.find((f) => f !== 'index.md' && !f.startsWith('memory/'))!;
    const doc = e.store.read(page)!;
    doc.sections[0]!.lines = bullets;
    e.store.write(page, doc);

    expect(e.store.bytesOf(page)).toBeGreaterThan(2000);
    const report = compressPage(e.store, page);
    expect(report.bytesAfter).toBeLessThan(report.bytesBefore);
    expect(report.archived.length).toBeGreaterThan(0);

    const after = readPage(sb, page);
    expect(after).toContain('归档');
    // Archived text must still exist somewhere in the wiki.
    const archiveRel = report.archived[0]!;
    const archive = readPage(sb, archiveRel);
    expect(archive).toContain('第 0 条结论');
  });

  it('fuses near-duplicate bullets', () => {
    const e = sb.engine;
    e.addManualConclusions(['确认了缓存前缀必须带租户标识，否则多租户互相污染'], undefined);
    const page = e.store.scan().files.find((f) => f !== 'index.md' && !f.startsWith('memory/'))!;
    const doc = e.store.read(page)!;
    doc.sections[0]!.lines.push('- 缓存前缀必须带租户标识');
    e.store.write(page, doc);

    compressPage(e.store, page, true);
    const bullets = (e.store.read(page)!.sections[0]?.lines ?? []).filter((l) => l.startsWith('- '));
    expect(bullets).toHaveLength(1);
    expect(bullets[0]).toContain('多租户互相污染');
  });

  it('compressAll only touches pages over budget', () => {
    const e = sb.engine;
    e.addManualConclusions(['确认了：F629 是位号不是站点号'], undefined);
    const report = e.compress();
    expect(report).toEqual([]);
  });
});

describe('supersession', () => {
  it('detects a revised decision with the same subject', () => {
    expect(
      findSupersession(
        '库存扣减改为按订单维度结算',
        '库存扣减改为按 SKU 维度结算',
      ),
    ).toBe(true);
  });

  it('does not fire for unrelated statements', () => {
    expect(findSupersession('机器人调度用 SIPP 算法', '库存扣减改为按订单维度结算')).toBe(false);
  });

  it('strikes through the old bullet when writing the new one', () => {
    const e = sb.engine;
    e.addManualConclusions(['确认了：分播查重基准改为 sowedSkuList (commit c0fc856bbb)'], 'topics/sowing.md');
    e.addManualConclusions(['确认了：分播查重基准改为 pickSkuList (commit d1ab123abc)'], 'topics/sowing.md');

    const text = readPage(sb, 'topics/sowing.md');
    expect(text).toContain('~~');
    expect(text).toContain('sowedSkuList');
    expect(text).toContain('pickSkuList');
    expect(text).toContain('已被取代');
  });
});

describe('promotion', () => {
  it('promotes a repeated procedure into a playbook and backlinks it', () => {
    const e = sb.engine;
    const procedure = '部署插件时必须先核对 plugin.properties 里的 plugin.version 再调用 loadPlugin，否则报版本不匹配';
    e.addManualConclusions([procedure], 'ops/deploy-plugin.md');
    e.addManualConclusions([procedure], 'ops/deploy-plugin-rollback.md');

    const candidates = findPromotionCandidates(e.store, 2);
    expect(candidates.length).toBeGreaterThan(0);

    const report = evolveAfterSession(e.store, e.stats);
    expect(report.promotions.length).toBeGreaterThan(0);
    const playbook = report.promotions[0]!.page;
    expect(playbook.startsWith('playbooks/')).toBe(true);

    const text = readPage(sb, playbook);
    expect(text).toContain('plugin.version');
    expect(fs.existsSync(path.join(sb.kbRoot, 'playbooks', 'index.md'))).toBe(true);

    const source = readPage(sb, 'ops/deploy-plugin.md');
    expect(source).toContain('相关');
  });

  it('does not promote a fact that appears once', () => {
    const e = sb.engine;
    e.addManualConclusions(['确认了：新版 SDK 把超时默认值改成 30 秒 (commit abc1234)'], 'notes/sdk.md');
    expect(findPromotionCandidates(e.store, 2)).toEqual([]);
  });
});

describe('decay', () => {
  it('reports cold pages without deleting them', () => {
    const e = sb.engine;
    e.addManualConclusions(['确认了：这个页面没人用，但内容是真的 (commit abc1234)'], 'dead/old.md');
    const stats = new StatsStore(e.cfg.dataDir);
    const decaying = findDecayingPages(e.store, stats, { coldAfterDays: 0 });
    expect(decaying.some((d) => d.page === 'dead/old.md')).toBe(true);

    const before = readPage(sb, 'dead/old.md');
    evolveAfterSession(e.store, stats, { coldAfterDays: 0 });
    expect(readPage(sb, 'dead/old.md')).toBe(before);
  });

  it('does not flag a page that keeps getting adopted', () => {
    const e = sb.engine;
    e.addManualConclusions(['确认了：热页面 (commit abc1234)'], 'hot/page.md');
    const stats = new StatsStore(e.cfg.dataDir);
    recordAdoption(stats, ['hot/page.md', 'hot/page.md', 'hot/page.md']);
    stats.save();
    const decaying = findDecayingPages(e.store, stats, { coldAfterDays: 0 });
    expect(decaying.some((d) => d.page === 'hot/page.md')).toBe(false);
  });
});
