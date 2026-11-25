import fs from 'node:fs';
import path from 'node:path';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * A transport-agnostic MCP server.
 *
 * Deliberately dependency-free: the same handler object serves the stdio
 * transport used by Claude Code / Codex / Qoder / Trae, and can be adapted to
 * SSE or a plain HTTP handler by another transport module.
 */
export class McpServer {
  constructor(
    private readonly tools: ToolDefinition[],
    private readonly call: (name: string, args: Record<string, unknown>) => Promise<ToolResult> | ToolResult,
    readonly info: { name: string; version: string } = { name: 'kb', version: '0.1.0' },
  ) {}

  async handle(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null;
    try {
      switch (req.method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: String(
                (req.params?.['protocolVersion'] as string | undefined) ?? '2024-11-05',
              ),
              capabilities: { tools: { listChanged: false } },
              serverInfo: this.info,
            },
          };
        case 'notifications/initialized':
        case 'initialized':
          return null; // notification: no response
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: this.tools } };
        case 'tools/call': {
          const name = String(req.params?.['name'] ?? '');
          const args = (req.params?.['arguments'] ?? {}) as Record<string, unknown>;
          const tool = this.tools.find((t) => t.name === name);
          if (!tool) {
            return error(id, -32602, `unknown tool: ${name}`);
          }
          const result = await this.call(name, args);
          return { jsonrpc: '2.0', id, result };
        }
        default:
          if (req.id === undefined || req.id === null) return null;
          return error(id, -32601, `method not found: ${req.method}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (req.id === undefined || req.id === null) return null;
      return error(id, -32603, message);
    }
  }
}

function error(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Serve MCP over stdio: one JSON object per line (newline-delimited). */
export async function serveStdio(server: McpServer): Promise<void> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      process.stdout.write(JSON.stringify(error(null, -32700, 'parse error')) + '\n');
      continue;
    }
    const res = await server.handle(req);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  }
}

export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function parentOf(p: string): string {
  return path.dirname(p);
}
