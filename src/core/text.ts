/** Text utilities: tokenisation for CJK+latin, normalisation, similarity. */

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;

export function hasCjk(s: string): boolean {
  return CJK.test(s);
}

const STOP_LATIN = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'of', 'to', 'in', 'on',
  'for', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that',
  'as', 'at', 'by', 'from', 'we', 'you', 'i', 'not', 'no', 'do', 'does', 'did',
]);

const STOP_CJK = new Set([
  '的', '了', '是', '在', '和', '与', '或', '也', '就', '都', '而', '及', '这',
  '那', '我', '你', '他', '它', '有', '没', '不', '很', '要', '会', '可以', '一个',
]);

/**
 * Tokenise mixed Chinese/English text.
 * - latin/digit runs: kept as words (length >= 2), minus stop words
 * - CJK runs: bigrams (and the unigram for single-char runs)
 */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  const lower = input.toLowerCase();
  const re = /([a-z0-9][a-z0-9_.+#-]*)|([㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) {
    const latin = m[1];
    const cjk = m[2];
    if (latin) {
      const t = latin.replace(/[._+#-]+$/g, '');
      if (t.length >= 2 && !STOP_LATIN.has(t)) out.push(t);
      else if (/^\d+$/.test(t) && t.length >= 1) out.push(t);
      continue;
    }
    if (cjk) {
      const chars = Array.from(cjk);
      if (chars.length === 1) {
        if (!STOP_CJK.has(chars[0]!)) out.push(chars[0]!);
        continue;
      }
      for (let i = 0; i < chars.length - 1; i++) {
        const bg = chars[i]! + chars[i + 1]!;
        out.push(bg);
      }
      for (const ch of chars) {
        if (!STOP_CJK.has(ch)) out.push(ch);
      }
    }
  }
  return out;
}

/** Aggressive normalisation used only for duplicate detection. */
export function normalizeForCompare(input: string): string {
  return input
    .toLowerCase()
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]+/g, '')
    .replace(/[`*_~#>|\-—–:：;,，。.、!！?？()（）[\]【】"'“”‘’/\\]/g, '');
}

export function jaccard(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function bigramContainment(needle: string, hay: string): number {
  const n = tokenize(needle);
  if (n.length === 0) return 0;
  const h = new Set(tokenize(hay));
  let hit = 0;
  for (const t of n) if (h.has(t)) hit++;
  return hit / n.length;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

export function collapseWhitespace(s: string): string {
  return s.replace(/[ \t　]+/g, ' ').replace(/\s+\n/g, '\n').trim();
}

/**
 * Drop the boilerplate that makes two statements of the same fact look
 * different: "确认了…", "结论：…", "note: …".
 */
export function stripDecisionPrefix(s: string): string {
  return s
    .replace(/^(?:确认了?|已确认|结论|决定|注意|note|confirmed|decided)\s*[:：,，]?\s*/i, '')
    .trim();
}

export function slugify(input: string): string {
  const ascii = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii.length > 0) return ascii.slice(0, 60);
  // Non-latin titles get a stable hash-derived slug.
  let h = 0;
  for (const ch of input) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return 'p' + h.toString(36);
}

export function isoDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function isoNow(d: Date = new Date()): string {
  return d.toISOString();
}
