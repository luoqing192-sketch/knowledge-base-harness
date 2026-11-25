/**
 * Minimal YAML front-matter parser/serializer.
 *
 * We deliberately avoid a YAML dependency: front matter here is a flat map of
 * scalars and string arrays, and hand edits from other tools must round-trip.
 */

export type YamlScalar = string | number | boolean;
export type YamlValue = YamlScalar | string[];
export type YamlMap = Record<string, YamlValue>;

const NUM = /^-?\d+(\.\d+)?$/;

function parseScalar(raw: string): YamlScalar {
  const s = raw.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (NUM.test(s)) return Number(s);
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    return unquote(s);
  }
  return s;
}

function unquote(s: string): string {
  const inner = s.slice(1, -1);
  if (s.startsWith("'")) return inner.replace(/''/g, "'");
  return inner.replace(/\\(["\\nrt])/g, (_m, c: string) => {
    switch (c) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      default:
        return c;
    }
  });
}

function parseInlineArray(raw: string): string[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === '') return [];
  const parts: string[] = [];
  let buf = '';
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ',') {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim() !== '') parts.push(buf);
  return parts.map((p) => String(parseScalar(p)));
}

export function parseYaml(input: string): YamlMap {
  const out: YamlMap = {};
  const lines = input.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const rest = m[2]!.trim();
    if (rest.startsWith('[')) {
      out[key] = parseInlineArray(rest);
      continue;
    }
    if (rest === '') {
      // Block sequence: following lines starting with "- ".
      const items: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        const item = /^\s*-\s+(.*)$/.exec(next);
        if (!item) break;
        items.push(String(parseScalar(item[1]!)));
        i++;
      }
      out[key] = items;
      continue;
    }
    out[key] = parseScalar(rest);
  }
  return out;
}

function needsQuote(s: string): boolean {
  return (
    s === '' ||
    /^\s|\s$/.test(s) ||
    /[:#\-[\]{}&*!|>'"%@`,]/.test(s) ||
    ['true', 'false', 'null', 'yes', 'no'].includes(s.toLowerCase()) ||
    NUM.test(s)
  );
}

function emitScalar(v: YamlScalar): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return needsQuote(v) ? JSON.stringify(v) : v;
}

const KEY_ORDER = [
  'id',
  'title',
  'summary',
  'tags',
  'level',
  'parent',
  'created',
  'updated',
  'revision',
  'confidence',
  'absorbedInto',
  'derivedFrom',
];

export function stringifyYaml(map: YamlMap): string {
  const keys = [
    ...KEY_ORDER.filter((k) => k in map),
    ...Object.keys(map).filter((k) => !KEY_ORDER.includes(k)).sort(),
  ];
  const lines: string[] = [];
  for (const key of keys) {
    const v = map[key]!;
    if (Array.isArray(v)) {
      if (v.length === 0) lines.push(`${key}: []`);
      else lines.push(`${key}: [${v.map((x) => emitScalar(x)).join(', ')}]`);
    } else {
      lines.push(`${key}: ${emitScalar(v)}`);
    }
  }
  return lines.join('\n');
}
