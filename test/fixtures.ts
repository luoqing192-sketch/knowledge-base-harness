export const USER_PROMPT = '库存扣减到底应该怎么改才不会和事件溯源对不上？';

export const CLAUDE_CODE_SESSION_START = {
  hook_event_name: 'SessionStart',
  source: 'startup',
  session_id: 'abc-123',
  transcript_path: 'C:/tmp/transcript.jsonl',
  cwd: 'C:/proj',
};

export const CLAUDE_CODE_PROMPT = {
  hook_event_name: 'UserPromptSubmit',
  session_id: 'abc-123',
  transcript_path: 'C:/tmp/transcript.jsonl',
  cwd: 'C:/proj',
  prompt: USER_PROMPT,
};

export const CLAUDE_CODE_STOP = {
  hook_event_name: 'Stop',
  session_id: 'abc-123',
  transcript_path: 'C:/tmp/transcript.jsonl',
  cwd: 'C:/proj',
};

export const CODEX_TURN_COMPLETE = { type: 'agent-turn-complete', cwd: 'C:/proj' };

export const GENERIC_PROMPT = {
  kind: 'prompt',
  cwd: 'C:/proj',
  prompt: 'WES 为什么要设置 MOCK_ESS',
  sessionId: 's-1',
  transcriptPath: 'C:/tmp/t.jsonl',
};

/** A Claude Code transcript excerpt with a settled conclusion and a guess. */
export const CLAUDE_TRANSCRIPT = [
  {
    type: 'user',
    timestamp: '2026-11-20T10:00:00Z',
    message: { role: 'user', content: [{ type: 'text', text: '为什么本地起不来？' }] },
  },
  {
    type: 'assistant',
    timestamp: '2026-11-20T10:00:05Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hidden' },
        { type: 'text', text: '我先查一下配置。可能是 ESS 地址没配。' },
      ],
    },
  },
  {
    type: 'user',
    timestamp: '2026-11-20T10:01:00Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '确认了，本地没有 ESS 时必须设置 MOCK_ESS=on，否则 wes-core 启动时连不上 9000 端口',
        },
      ],
    },
  },
  {
    type: 'tool_result',
    timestamp: '2026-11-20T10:01:05Z',
    message: { content: 'irrelevant' },
  },
]
  .map((o) => JSON.stringify(o))
  .join('\n');

/** A Codex rollout excerpt. */
export const CODEX_TRANSCRIPT = [
  {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '菜单为什么空的' }],
    },
  },
  {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '确认根因是权限树 key 写成了 menu.* 而接口校验的是 WES.* (issue 621)' }],
    },
  },
]
  .map((o) => JSON.stringify(o))
  .join('\n');
