import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readTranscript, slugOfCwd } from '../src/core/transcript.js';
import { McpServer } from '../src/mcp/server.js';
import { KB_TOOLS, callKbTool } from '../src/mcp/tools.js';
import { KbEngine } from '../src/core/engine.js';
import { sandbox, type Sandbox } from './helpers.js';
import { CLAUDE_TRANSCRIPT, CODEX_TRANSCRIPT } from './fixtures.js';

let sb: Sandbox;
let dir: string;

beforeEach(() => {
  sb = sandbox();
  dir = fs.mkdtempSync(path.join(sb.root, 'transcripts-'));
});

afterEach(() => {
  sb.cleanup();
});

function write(name: string, content: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe('transcript readers', () => {
  it('parses a Claude Code jsonl transcript', () => {
    const file = write('cc.jsonl', CLAUDE_TRANSCRIPT);
    const { messages } = readTranscript(file);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[2]!.text).toContain('MOCK_ESS');
    // thinking blocks are dropped.
    expect(messages[1]!.text).not.toContain('hidden');
  });

  it('parses a Codex rollout transcript', () => {
    const file = write('codex.jsonl', CODEX_TRANSCRIPT);
    const { messages } = readTranscript(file);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.role).toBe('assistant');
    expect(messages[1]!.text).toContain('权限树');
  });

  it('falls back to markdown chat exports', () => {
    const file = write('chat.md', '## User\n本地为什么起不来\n\n## Assistant\n确认了：缺少 MOCK_ESS\n');
    const { messages } = readTranscript(file);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.text).toContain('MOCK_ESS');
  });

  it('keeps the tail when the transcript is too large', () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(
        JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `第 ${i} 条消息，内容尽量长一些用来撑大体积。` }] } }),
      );
    }
    const file = write('big.jsonl', lines.join('\n'));
    const { messages, truncated } = readTranscript(file, { maxChars: 500 });
    expect(truncated).toBe(true);
    expect(messages[messages.length - 1]!.text).toContain('第 199 条');
  });

  it('returns nothing for a missing file instead of throwing', () => {
    expect(readTranscript(path.join(dir, 'nope.jsonl')).messages).toEqual([]);
  });

  it('skips malformed lines', () => {
    const file = write('bad.jsonl', '{"type":"user","message":{"content":"ok"}}\nnot json\n{"broken":\n');
    const { messages } = readTranscript(file);
    expect(messages).toHaveLength(1);
  });

  it('derives the Claude Code project slug from a cwd', () => {
    // Claude Code names project dirs by replacing path separators with dashes.
    expect(slugOfCwd('D:\\luoqing_proj\\wes')).toBe('D--luoqing_proj-wes');
    expect(slugOfCwd('/home/me/proj')).toBe('-home-me-proj');
  });
});

describe('mcp server', () => {
  it('answers initialize and lists tools', async () => {
    const engine = sb.engine;
    const server = new McpServer(KB_TOOLS, (n, a) => callKbTool(engine, n, a));

    const init = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    expect((init?.result as { serverInfo: { name: string } }).serverInfo.name).toBe('kb');

    const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (list?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['kb_query', 'kb_read', 'kb_note', 'kb_tree']),
    );
  });

  it('writes a note and finds it again', async () => {
    const engine = sb.engine;
    const call = (name: string, args: Record<string, unknown>) => callKbTool(engine, name, args);

    const note = await call('kb_note', {
      conclusion: '确认了：ESS 起来后必须调用 /actor/restartController 才会有 contextInit',
      evidence: 'commit abc1234',
    });
    expect(note.content[0]!.text).toContain('Recorded');

    const query = await call('kb_query', { query: 'ESS contextInit 怎么初始化' });
    expect(query.content[0]!.text).toContain('restartController');

    const tree = await call('kb_tree', {});
    expect(tree.content[0]!.text).toContain('index.md');
  });

  it('rejects a hedged note', async () => {
    const res = await callKbTool(sb.engine, 'kb_note', { conclusion: '可能缓存没刷新吧' });
    expect(res.content[0]!.text.toLowerCase()).toContain('rejected');
  });

  it('returns a JSON-RPC error for unknown tools', async () => {
    const server = new McpServer(KB_TOOLS, (n, a) => callKbTool(sb.engine, n, a));
    const res = await server.handle({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    });
    expect(res?.error?.code).toBe(-32602);
  });

  it('ignores notifications', async () => {
    const engine: KbEngine = sb.engine;
    const server = new McpServer(KB_TOOLS, (n, a) => callKbTool(engine, n, a));
    const res = await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res).toBeNull();
  });
});
