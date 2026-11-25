import fs from 'node:fs';
import path from 'node:path';
import { readIfExists } from './fsx.js';

export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  at?: string;
}

export interface TranscriptSummary {
  messages: TranscriptMessage[];
  /** True when the transcript was truncated by maxChars. */
  truncated: boolean;
  source: string;
}

/**
 * Read a harness transcript.
 *
 * Formats we know about:
 *  - Claude Code: `~/.claude/projects/<slug>/<session>.jsonl`, one JSON object
 *    per line with `type: "user" | "assistant"` and a `message.content` array.
 *  - Codex: `~/.codex/sessions/<date>/rollout-*.jsonl` with `payload` events.
 *  - Everything else (Qoder / Trae / WorkBuddy / dsh): either a `.jsonl` with
 *    `{role, content}` or a plain `.md`/`.txt` chat export.
 *
 * Unrecognised lines are skipped rather than throwing: a half-parsed transcript
 * still yields useful conclusions, and a crash here would block a session end.
 */
export function readTranscript(file: string, opts: { maxChars?: number } = {}): TranscriptSummary {
  const maxChars = opts.maxChars ?? 400_000;
  const raw = readIfExists(file);
  if (raw === null) return { messages: [], truncated: false, source: file };

  const isJsonl = file.toLowerCase().endsWith('.jsonl') || file.toLowerCase().endsWith('.json');
  let messages: TranscriptMessage[];
  if (isJsonl) {
    messages = parseJsonl(raw);
    if (messages.length === 0) messages = parseMarkdown(raw);
  } else {
    messages = parseMarkdown(raw);
  }

  let truncated = false;
  let total = messages.reduce((n, m) => n + m.text.length, 0);
  if (total > maxChars) {
    truncated = true;
    // Keep the tail: the end of a session holds the settled decisions.
    const kept: TranscriptMessage[] = [];
    let budget = maxChars;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.text.length > budget) {
        if (kept.length === 0) kept.unshift({ ...m, text: m.text.slice(-budget) });
        break;
      }
      kept.unshift(m);
      budget -= m.text.length;
      if (budget <= 0) break;
    }
    messages = kept;
  }
  return { messages, truncated, source: file };
}

function parseJsonl(raw: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed[0] !== '{') continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const msg = extractMessage(obj);
    if (msg) out.push(msg);
  }
  return out;
}

function extractMessage(obj: Record<string, unknown>): TranscriptMessage | null {
  // Claude Code shape.
  if (typeof obj['type'] === 'string') {
    const type = obj['type'] as string;
    if (type === 'user' || type === 'assistant') {
      const inner = obj['message'] as Record<string, unknown> | undefined;
      const text = contentToText(inner?.['content'] ?? obj['content']);
      if (text.trim() === '') return null;
      const ts = typeof obj['timestamp'] === 'string' ? (obj['timestamp'] as string) : undefined;
      return { role: type, text, at: ts };
    }
    if (type === 'summary' || type === 'system') return null;
  }
  // Codex rollout shape: {type:'response_item', payload:{type:'message', role, content:[...]}}
  const payload = obj['payload'] as Record<string, unknown> | undefined;
  if (payload) {
    const ptype = payload['type'] as string | undefined;
    const role = payload['role'] as string | undefined;
    if (role && (ptype === 'message' || ptype === 'response_item' || ptype === undefined)) {
      const text = contentToText(payload['content']);
      if (text.trim() === '') return null;
      return { role: normaliseRole(role), text };
    }
  }
  // Generic shape.
  const role = obj['role'] as string | undefined;
  if (role) {
    const text = contentToText(obj['content'] ?? obj['text'] ?? obj['message']);
    if (text.trim() === '') return null;
    return { role: normaliseRole(role), text };
  }
  return null;
}

function normaliseRole(role: string): 'user' | 'assistant' | 'system' {
  const r = role.toLowerCase();
  if (r === 'user' || r === 'human') return 'user';
  if (r === 'system' || r === 'developer') return 'system';
  return 'assistant';
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
        continue;
      }
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        const t = b['type'] as string | undefined;
        if (t === 'text' && typeof b['text'] === 'string') parts.push(b['text'] as string);
        else if (t === 'input_text' && typeof b['text'] === 'string') parts.push(b['text'] as string);
        else if (t === 'thinking') continue;
        else if (t === 'tool_use' || t === 'tool_result') continue;
        else if (typeof b['content'] === 'string') parts.push(b['content'] as string);
      }
    }
    return parts.join('\n');
  }
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (typeof c['text'] === 'string') return c['text'] as string;
    if (Array.isArray(c['content'])) return contentToText(c['content']);
  }
  return '';
}

/** `## User` / `## Assistant` style chat exports. */
function parseMarkdown(raw: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  let role: 'user' | 'assistant' | 'system' = 'system';
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    buf = [];
    if (text !== '') out.push({ role, text });
  };
  for (const line of raw.split(/\r?\n/)) {
    const h = /^#{1,3}\s*(user|assistant|human|ai|system|用户|助手|我|claude|codex)\s*:?\s*$/i.exec(line.trim());
    if (h) {
      flush();
      role = normaliseRole(h[1]!);
      continue;
    }
    buf.push(line);
  }
  flush();
  if (out.length === 0 && raw.trim() !== '') {
    out.push({ role: 'user', text: raw });
  }
  return out;
}

/** Locate the newest transcript under a harness's well-known directory. */
export function findLatestTranscript(harness: string, cwd: string): string | null {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'];
  if (!home) return null;
  if (harness === 'claude-code') {
    if (process.env['KB_CLAUDE_TRANSCRIPT']) return process.env['KB_CLAUDE_TRANSCRIPT'];
    return newestFileRecursive(path.join(home, '.claude', 'projects', slugOfCwd(cwd)), ['.jsonl']);
  }
  if (harness === 'codex') {
    if (process.env['KB_CODEX_TRANSCRIPT']) return process.env['KB_CODEX_TRANSCRIPT'];
    return newestFileRecursive(path.join(home, '.codex', 'sessions'), ['.jsonl']);
  }
  return null;
}

export function slugOfCwd(cwd: string): string {
  return cwd.replace(/[/\\:]/g, '-');
}

function newestFileRecursive(dir: string, exts: string[], depth = 4): string | null {
  const best: { file: string; mtime: number } = { file: '', mtime: -1 };
  const visit = (d: string, level: number) => {
    if (level > depth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) visit(abs, level + 1);
      else if (e.isFile() && exts.includes(path.extname(e.name).toLowerCase())) {
        try {
          const st = fs.statSync(abs);
          if (st.mtimeMs > best.mtime) {
            best.file = abs;
            best.mtime = st.mtimeMs;
          }
        } catch {
          /* ignore */
        }
      }
    }
  };
  visit(dir, 0);
  return best.file === '' ? null : best.file;
}
