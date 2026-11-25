import { describe, expect, it } from 'vitest';
import {
  distillTranscript,
  extractExplicitNotes,
  isConfirmation,
  isNoise,
  judgeConclusion,
} from '../src/core/distill.js';

describe('conclusion gating', () => {
  it('accepts a decision backed by evidence', () => {
    const v = judgeConclusion('确认根因是 commit 4e871a50bb 里返仓未回传 SN，已修复');
    expect(v.accepted).toBe(true);
    expect(v.confidence).toBe('high');
  });

  it('rejects questions', () => {
    expect(judgeConclusion('要不要把缓存前缀改成租户维度？').accepted).toBe(false);
  });

  it('rejects hedged statements without evidence', () => {
    const v = judgeConclusion('这个问题可能是缓存没刷新导致的');
    expect(v.accepted).toBe(false);
    expect(v.reason).toContain('hedged');
  });

  it('accepts a hedged statement once evidence is attached', () => {
    const v = judgeConclusion('可能是缓存问题，实测把 ttl 设为 0 后 `cache.log` 不再报错');
    expect(v.accepted).toBe(true);
  });

  it('rejects open-ended openers', () => {
    expect(judgeConclusion('我们可以试试新的调度策略看看效果').accepted).toBe(false);
    expect(judgeConclusion('我觉得应该先重构一下这块').accepted).toBe(false);
  });

  it('rejects short fragments', () => {
    expect(judgeConclusion('好的').accepted).toBe(false);
  });

  it('rejects bare admonishment with no fact in it', () => {
    // "must" alone made this look like a decision before; it is generic advice.
    const v = judgeConclusion('这里必须注意一下安全问题，别乱改');
    expect(v.accepted).toBe(false);
    expect(v.reason).toContain('vague advice');
  });

  it('caps a rule-only statement at medium, never high', () => {
    const v = judgeConclusion('返仓入参必须回传 SN，否则 ESS 会拒收整单');
    expect(v.accepted).toBe(true);
    expect(v.confidence).toBe('medium');
  });

  it('lets a recorded outcome reach high without an explicit marker', () => {
    const v = judgeConclusion('改成按 orderNo 聚合之后性能从 8s 降到 200ms');
    expect(v.accepted).toBe(true);
    expect(v.confidence).toBe('high');
  });

  it('keeps a concrete short fact that carries a number', () => {
    const v = judgeConclusion('日志里报 429 说明信号量是负数');
    expect(v.accepted).toBe(true);
  });

  it('still rejects vague opinions that look declarative', () => {
    expect(judgeConclusion('这个方案也许可行吧').accepted).toBe(false);
    expect(judgeConclusion('等等我再确认下这个参数').accepted).toBe(false);
  });
});

describe('explicit notes', () => {
  it('extracts kb: and 结论: prefixes', () => {
    const notes = extractExplicitNotes('帮我看下这个问题\nkb: 需要开启 MOCK_ESS 才能本地启动 WES\n结论：F629 是位号不是站点号');
    expect(notes).toHaveLength(2);
    expect(notes[0]!.text).toContain('MOCK_ESS');
    expect(notes[1]!.source).toBe('note');
  });

  it('drops prefixed lines that are not conclusions', () => {
    const notes = extractExplicitNotes('kb: 可能是缓存问题吧');
    expect(notes).toHaveLength(0);
  });
});

describe('transcript distillation', () => {
  it('keeps settled user facts and drops assistant chatter', () => {
    const messages = [
      { role: 'user' as const, text: '为什么我的菜单是空的？' },
      { role: 'assistant' as const, text: '我先看一下配置。' },
      { role: 'user' as const, text: '确认了，菜单为空是因为权限树里的 key 写成了 menu.xxx' },
      { role: 'assistant' as const, text: '明白，我继续处理。' },
    ];
    const out = distillTranscript(messages);
    expect(out.some((c) => c.text.includes('权限树'))).toBe(true);
    expect(out.some((c) => c.text.includes('我先看一下'))).toBe(false);
  });

  it('never lets a low-confidence assistant line in', () => {
    const messages = [{ role: 'assistant' as const, text: '大约就是这样，你可以看看。' }];
    expect(distillTranscript(messages)).toHaveLength(0);
  });
});

describe('noise filter', () => {
  it('filters logs and stack traces', () => {
    expect(isNoise('[12:00:01] ERROR failed to connect')).toBe(true);
    expect(isNoise('    at com.foo.Bar.baz(Bar.java:12)')).toBe(true);
    expect(isNoise('$ mvn clean package')).toBe(true);
    expect(isNoise('结算是按订单维度而不是 SKU 维度')).toBe(false);
  });

  it('detects confirmation phrases', () => {
    expect(isConfirmation('对')).toBe(true);
    expect(isConfirmation('就这样')).toBe(true);
    expect(isConfirmation('那再改一下')).toBe(false);
  });
});
