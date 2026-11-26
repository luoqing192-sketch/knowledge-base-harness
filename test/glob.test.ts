import { describe, expect, it } from 'vitest';
import { matchGlob, matchAnyGlob } from '../src/core/glob.js';

describe('matchGlob', () => {
  it('matches a bare filename at any depth', () => {
    expect(matchGlob('*.md', 'a/b/c.md')).toBe(true);
    expect(matchGlob('webpack.config.js', 'config/webpack.config.js')).toBe(true);
  });

  it('keeps a single star inside one path segment', () => {
    expect(matchGlob('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matchGlob('src/*.ts', 'src/deep/a.ts')).toBe(false);
  });

  it('lets ** span separators', () => {
    expect(matchGlob('src/**', 'src/a/b/c.ts')).toBe(true);
    expect(matchGlob('src/**/*.ts', 'src/a/b/c.ts')).toBe(true);
    // `**/` must also match zero segments.
    expect(matchGlob('src/**/*.ts', 'src/c.ts')).toBe(true);
  });

  it('anchors a leading slash to the root', () => {
    expect(matchGlob('/src/a.ts', 'src/a.ts')).toBe(true);
    expect(matchGlob('/src/a.ts', 'pkg/src/a.ts')).toBe(false);
  });

  it('matches multiple patterns with matchAnyGlob', () => {
    expect(matchAnyGlob(['docs/**', 'src/api/**'], 'src/api/x.ts')).toBe(true);
    expect(matchAnyGlob(['docs/**', 'src/api/**'], 'src/core/x.ts')).toBe(false);
  });

  it('treats regex metacharacters literally', () => {
    expect(matchGlob('a.b/c.md', 'aXb/c.md')).toBe(false);
    expect(matchGlob('a.b/c.md', 'a.b/c.md')).toBe(true);
  });

  it('normalises Windows separators and leading ./', () => {
    expect(matchGlob('src/**', 'src\\a\\b.ts')).toBe(true);
    expect(matchGlob('./src/a.ts', 'src/a.ts')).toBe(true);
  });
});
