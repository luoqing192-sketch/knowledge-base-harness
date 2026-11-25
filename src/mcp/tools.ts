import { KbEngine } from '../core/engine.js';
import { type ToolDefinition, textResult, type ToolResult } from './server.js';
import { renderRecall } from '../core/recall.js';
import { type MemoryOp, type MemoryTarget } from '../core/types.js';

const MEMORY_DESCRIPTION = `Read or update the always-injected memory.

Two stores, each with a hard character budget:
  - \`memory\` (MEMORY.md) — durable facts about this project that apply to every
    session: environment quirks, standing conventions, tool behaviour.
  - \`user\` (USER.md) — who the user is: role, expertise, how they want to be
    spoken to.

Write here ONLY what must be present in every future conversation. Task
procedures belong in a wiki page via kb_note; progress logs and TODOs belong
nowhere in memory.

Operations apply as one atomic batch against the final size, so "remove two
stale entries and add one" is a single call. If a batch overflows, the response
reports current entries and usage — retry with a batch that frees space.`;

export const KB_TOOLS: ToolDefinition[] = [
  {
    name: 'kb_query',
    description:
      'Search the personal knowledge base for pages relevant to a question. Call this before answering anything project-specific.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question or topic, in natural language.' },
        limit: { type: 'number', description: 'Max pages to return (default 5).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kb_read',
    description: 'Read one knowledge base page by its path (as returned by kb_query).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Page path, e.g. "wes/task-cancel.md".' } },
      required: ['path'],
    },
  },
  {
    name: 'kb_note',
    description:
      'Record ONE settled conclusion into the wiki. Only call this when the fact is decided, verified, or reproduced — never for guesses, TODOs or open questions. Say which earlier conclusion this supersedes if you are revising one.',
    inputSchema: {
      type: 'object',
      properties: {
        conclusion: { type: 'string', description: 'One sentence stating the settled fact.' },
        evidence: {
          type: 'string',
          description: 'Supporting reference: commit sha, file path, ticket id, date.',
        },
        target: {
          type: 'string',
          description: 'Optional page path (relative to the wiki root) to write into.',
        },
        supersedes: {
          type: 'string',
          description:
            'Exact text of an earlier conclusion this one replaces. It is struck through, not deleted.',
        },
      },
      required: ['conclusion'],
    },
  },
  {
    name: 'kb_memory',
    description: MEMORY_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['memory', 'user'] },
        operations: {
          type: 'array',
          description: 'Applied as one atomic batch.',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['add', 'patch', 'remove'] },
              content: { type: 'string' },
              old_text: { type: 'string', description: 'Exact existing text to patch or remove.' },
              section: { type: 'string', description: 'Section heading for add (derived if omitted).' },
            },
            required: ['action'],
          },
        },
      },
      required: ['target', 'operations'],
    },
  },
  {
    name: 'kb_tree',
    description: 'Show the wiki tree (folder structure with summaries) to orient within the knowledge base.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export async function callKbTool(
  engine: KbEngine,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case 'kb_query': {
      const query = String(args['query'] ?? '');
      const limit = typeof args['limit'] === 'number' ? args['limit'] : 5;
      const hits = engine.recallQuery(query, limit).hits;
      if (hits.length === 0) return textResult('No matching pages. The knowledge base has nothing on this yet.');
      return textResult(renderRecall(hits, { maxChars: 6000 }));
    }
    case 'kb_read': {
      const rel = String(args['path'] ?? '');
      const raw = engine.store.raw(rel);
      if (raw === null) return textResult(`No page at ${rel}`, true);
      return textResult(raw);
    }
    case 'kb_note': {
      const conclusion = String(args['conclusion'] ?? '').trim();
      if (conclusion === '') return textResult('conclusion is required', true);
      const evidence = typeof args['evidence'] === 'string' ? args['evidence'] : undefined;
      const target = typeof args['target'] === 'string' ? args['target'] : undefined;
      const supersedes = typeof args['supersedes'] === 'string' ? args['supersedes'] : undefined;

      const summary = engine.addManualConclusions(
        [evidence ? `${conclusion} (${evidence})` : conclusion],
        target,
        supersedes,
      );
      if (summary.results.length === 0) {
        return textResult(
          'Rejected: this does not read as a settled fact (question, hedge, or too vague). State what was decided and, if possible, the evidence.',
        );
      }
      const lines = summary.results.map(
        (r) =>
          `Recorded in ${r.path} (+${r.addedLines} new, ${r.mergedLines} duplicate)${r.superseded.length > 0 ? `, superseded ${r.superseded.length} older conclusion(s)` : ''}.`,
      );
      return textResult(lines.join('\n'));
    }
    case 'kb_memory': {
      const target = String(args['target'] ?? '') as MemoryTarget;
      if (target !== 'memory' && target !== 'user') {
        return textResult('target must be "memory" or "user"', true);
      }
      const rawOps = args['operations'];
      if (!Array.isArray(rawOps) || rawOps.length === 0) {
        // A read is a useful default when no operations are supplied.
        const view = engine.memoryView(target);
        return textResult(renderMemoryView(view));
      }
      const ops: MemoryOp[] = rawOps.map((o) => {
        const op = (o ?? {}) as Record<string, unknown>;
        return {
          action: String(op['action'] ?? '') as MemoryOp['action'],
          content: typeof op['content'] === 'string' ? op['content'] : undefined,
          old_text: typeof op['old_text'] === 'string' ? op['old_text'] : undefined,
          section: typeof op['section'] === 'string' ? op['section'] : undefined,
        };
      });
      const result = engine.applyMemory(target, ops);
      if (!result.ok) {
        // Return current state so the caller can retry with a correct batch.
        return textResult(`Rejected: ${result.error}\n\n${renderMemoryView(result)}`, true);
      }
      return textResult(
        `Applied ${result.applied} operation(s). ${result.used}/${result.limit} chars used.\n\n${renderMemoryView(result)}`,
      );
    }
    case 'kb_tree':
      return textResult(engine.tree() || '(empty knowledge base)');
    default:
      return textResult(`unknown tool ${name}`, true);
  }
}

function renderMemoryView(view: {
  target: MemoryTarget;
  entries: Array<{ section: string; text: string }>;
  used: number;
  limit: number;
}): string {
  const header = `${view.target === 'user' ? 'USER.md' : 'MEMORY.md'} — ${view.used}/${view.limit} chars`;
  if (view.entries.length === 0) return `${header}\n(empty)`;
  const lines = [header];
  let current = '';
  for (const entry of view.entries) {
    if (entry.section !== current) {
      current = entry.section;
      lines.push(`\n## ${current}`);
    }
    lines.push(`- ${entry.text}`);
  }
  return lines.join('\n');
}
