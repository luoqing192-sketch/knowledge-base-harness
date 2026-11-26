/**
 * Minimal gitignore-style glob matching for `paths:` front matter.
 *
 * Deliberately tiny and dependency-free: the patterns a knowledge page declares
 * are hand-written routes ("src/api/**", "**\/*.test.ts"), not arbitrary regexes,
 * and a wrong match here only costs a few tokens of injected context.
 */

/**
 * Match one posix path against one glob.
 *
 * Supported: `*` (any run without `/`), `**` (any run including `/`), `?`,
 * and character classes are treated literally — nobody needs them for routing.
 * A pattern with no leading `**` or `/` also matches at any depth, so
 * `*.ts` behaves like `**\/*.ts` — the intuitive reading.
 */
export function matchGlob(pattern: string, filePath: string): boolean {
  const pat = normalise(pattern);
  if (pat === '') return false;
  const target = normalise(filePath);

  const anchored = pat.startsWith('/');
  const body = anchored ? pat.slice(1) : pat;
  const re = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${toRegex(body)}$`);
  if (re.test(target)) return true;
  // A bare filename matches by basename at any depth ("webpack.config.js").
  if (!body.includes('/')) {
    const base = target.slice(target.lastIndexOf('/') + 1);
    return new RegExp(`^${toRegex(body)}$`).test(base);
  }
  return false;
}

/** True when any of `patterns` matches. */
export function matchAnyGlob(patterns: readonly string[], filePath: string): boolean {
  for (const p of patterns) if (matchGlob(p, filePath)) return true;
  return false;
}

function normalise(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function toRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` swallows the separator so `a/**/b` matches `a/b` too.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
        continue;
      }
      out += '[^/]*';
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}
