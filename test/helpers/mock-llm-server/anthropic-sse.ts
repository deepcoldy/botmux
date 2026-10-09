import type { ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { SseEvent } from './types.js';

export function createMessageId(): string {
  return `msg_mock_${randomBytes(12).toString('hex')}`;
}

export function createToolUseId(): string {
  return `toolu_mock_${randomBytes(12).toString('hex')}`;
}

/**
 * Generate standard Anthropic SSE events for calling a Bash command.
 */
export function buildAnthropicToolUseEvents(opts: {
  model?: string;
  command: string;
  toolName?: string;
  toolUseId?: string;
}): SseEvent[] {
  const model = opts.model ?? 'claude-3-7-sonnet-20250219';
  const toolName = opts.toolName ?? 'Bash';
  const toolUseId = opts.toolUseId ?? createToolUseId();
  const inputJson = JSON.stringify({ command: opts.command });

  return [
    {
      event: 'message_start',
      data: JSON.stringify({
        type: 'message_start',
        message: {
          id: createMessageId(),
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 150, output_tokens: 0 },
        },
      }),
    },
    {
      event: 'content_block_start',
      data: JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: toolUseId,
          name: toolName,
          input: {},
        },
      }),
    },
    {
      event: 'content_block_delta',
      data: JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: inputJson,
        },
      }),
    },
    {
      event: 'content_block_stop',
      data: JSON.stringify({
        type: 'content_block_stop',
        index: 0,
      }),
    },
    {
      event: 'message_delta',
      data: JSON.stringify({
        type: 'message_delta',
        delta: {
          stop_reason: 'tool_use',
          stop_sequence: null,
        },
        usage: { output_tokens: 25 },
      }),
    },
    {
      event: 'message_stop',
      data: JSON.stringify({
        type: 'message_stop',
      }),
    },
  ];
}

/**
 * Generate standard Anthropic SSE events for returning completed text.
 */
export function buildAnthropicTextEvents(opts: {
  model?: string;
  text: string;
}): SseEvent[] {
  const model = opts.model ?? 'claude-3-7-sonnet-20250219';

  return [
    {
      event: 'message_start',
      data: JSON.stringify({
        type: 'message_start',
        message: {
          id: createMessageId(),
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 200, output_tokens: 0 },
        },
      }),
    },
    {
      event: 'content_block_start',
      data: JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'text',
          text: '',
        },
      }),
    },
    {
      event: 'content_block_delta',
      data: JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: opts.text,
        },
      }),
    },
    {
      event: 'content_block_stop',
      data: JSON.stringify({
        type: 'content_block_stop',
        index: 0,
      }),
    },
    {
      event: 'message_delta',
      data: JSON.stringify({
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn',
          stop_sequence: null,
        },
        usage: { output_tokens: 15 },
      }),
    },
    {
      event: 'message_stop',
      data: JSON.stringify({
        type: 'message_stop',
      }),
    },
  ];
}

/**
 * Pipe SSE events to a Node.js ServerResponse with optional timing pacing.
 */
export async function streamSseEvents(
  res: ServerResponse,
  events: SseEvent[],
  delayMs = 0,
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  for (const evt of events) {
    if (res.destroyed || res.writableEnded) break;
    const prefix = evt.event ? `event: ${evt.event}\n` : '';
    res.write(`${prefix}data: ${evt.data}\n\n`);

    const sleep = evt.delayMs ?? delayMs;
    if (sleep > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleep));
    }
  }

  if (!res.writableEnded) {
    res.end();
  }
}
