import { describe, expect, it } from 'vitest';
import { parseDoc, serializeDoc, mergeBullets, ensureSection } from '../src/core/markdown.js';
import { parseYaml, stringifyYaml } from '../src/core/yaml.js';
import { tokenize, normalizeForCompare, slugify, bigramContainment } from '../src/core/text.js';

describe('yaml front matter', () => {
  it('round-trips scalars and arrays', () => {
    const map = { id: 'a', title: '标题: with colon', tags: ['x', 'y'], level: 2, revision: 3 };
    const text = stringifyYaml(map);
    const back = parseYaml(text);
    expect(back.title).toBe('标题: with colon');
    expect(back.tags).toEqual(['x', 'y']);
    expect(back.level).toBe(2);
  });

  it('parses block sequences', () => {
    const map = parseYaml('tags:\n  - a\n  - b\nnext: 1');
    expect(map.tags).toEqual(['a', 'b']);
    expect(map.next).toBe(1);
  });

  it('quotes values that would otherwise change type', () => {
    const text = stringifyYaml({ v: 'true', n: '1.5' });
    expect(parseYaml(text).v).toBe('true');
    expect(parseYaml(text).n).toBe('1.5');
  });
});

describe('markdown parsing', () => {
  const sample = [
    '---',
    'title: 测试页面',
    'tags: [a, b]',
    '---',
    '',
    '# 测试页面',
    '',
    '一段导语。',
    '',
    '## 结论',
    '',
    '- 第一点结论',
    '- 第二点结论',
    '',
    '## 细节',
    '',
    '更多内容',
    '',
  ].join('\n');

  it('extracts front matter, title, preamble and sections', () => {
    const doc = parseDoc(sample, { relPath: 'topics/test.md' });
    expect(doc.frontmatter.title).toBe('测试页面');
    expect(doc.frontmatter.tags).toEqual(['a', 'b']);
    expect(doc.titleLine).toBe('# 测试页面');
    expect(doc.preamble).toEqual(['一段导语。']);
    expect(doc.sections.map((s) => s.heading)).toEqual(['结论', '细节']);
    expect(doc.sections[0]!.lines.filter(Boolean)).toHaveLength(2);
  });

  it('derives title and summary when front matter is missing', () => {
    const doc = parseDoc('# 只有标题\n\n摘要句子。\n\n## 结论\n\n- x\n', { relPath: 'foo/bar.md' });
    expect(doc.frontmatter.title).toBe('只有标题');
    expect(doc.frontmatter.summary).toBe('摘要句子。');
    expect(doc.frontmatter.level).toBe(1);
  });

  it('serialises back into a stable shape', () => {
    const doc = parseDoc(sample, { relPath: 'topics/test.md' });
    const text = serializeDoc(doc);
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('## 结论');
    expect(text).toContain('- 第一点结论');
    // Round-trip must be idempotent.
    const again = serializeDoc(parseDoc(text, { relPath: 'topics/test.md' }));
    expect(again).toBe(text);
  });

  it('dedupes and merges bullets', () => {
    const doc = parseDoc(sample, { relPath: 'topics/test.md' });
    const section = ensureSection(doc, '结论');
    const result = mergeBullets(section, ['- 第一点结论', '- 全新的结论']);
    expect(result.merged).toBe(1);
    expect(result.added).toBe(1);
    const bullets = section.lines.filter((l) => l.startsWith('- '));
    expect(bullets).toHaveLength(3);
  });

  it('replaces a shorter near-duplicate with the longer text', () => {
    const doc = parseDoc('---\ntitle: t\n---\n\n## 结论\n\n- 缓存前缀必须带租户\n', { relPath: 'x.md' });
    const section = ensureSection(doc, '结论');
    const r = mergeBullets(section, ['- 缓存前缀必须带租户标识']);
    expect(r.merged).toBe(1);
    expect(section.lines.some((l) => l.includes('租户标识'))).toBe(true);
  });
});

describe('text utilities', () => {
  it('tokenises Chinese into bigrams and latin into words', () => {
    const tokens = tokenize('库存扣减 stock deduction');
    expect(tokens).toContain('库存');
    expect(tokens).toContain('stock');
    expect(tokens).toContain('deduction');
  });

  it('normalises punctuation and width for comparison', () => {
    expect(normalizeForCompare('ＡＢＣ，测试！')).toBe(normalizeForCompare('abc测试'));
  });

  it('produces stable ascii slugs and hashed slugs for CJK', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
    const cn = slugify('库存扣减');
    expect(cn).toMatch(/^p[0-9a-z]+$/);
    expect(slugify('库存扣减')).toBe(cn);
  });

  it('scores containment higher for closer text', () => {
    const near = bigramContainment('库存扣减', '库存扣减逻辑');
    const far = bigramContainment('库存扣减', '机器人调度');
    expect(near).toBeGreaterThan(far);
  });
});
