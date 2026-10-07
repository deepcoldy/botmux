import type { ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { SseEvent } from './types.js';

export function createChatCompletionId(): string {
  return `chatcmpl_mock_${randomBytes(12).toString('hex')}`;
}

export function createCallId(): string {
  return `call_mock_${randomBytes(12).toString('hex')}`;
}

/**
 * Generate standard OpenAI chat completion SSE events for tool call.
 */
export function buildOpenAiToolCallEvents(opts: {
  model?: string;
  command: string;
  functionName?: string;
}): SseEvent[] {
  const model = opts.model ?? 'gpt-4o';
  const id = createChatCompletionId();
  const callId = createCallId();
  const fnName = opts.functionName ?? 'bash';
  const args = JSON.stringify({ command: opts.command });
  const created = Math.floor(Date.now() / 1000);

  return [
    {
      data: JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: callId,
                  type: 'function',
                  function: {
                    name: fnName,
                    arguments: args,
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    },
    {
      data: JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      }),
    },
    {
      data: '[DONE]',
    },
  ];
}

/**
 * Generate standard OpenAI chat completion SSE events for plain text.
 */
export function buildOpenAiTextEvents(opts: {
  model?: string;
  text: string;
}): SseEvent[] {
  const model = opts.model ?? 'gpt-4o';
  const id = createChatCompletionId();
  const created = Math.floor(Date.now() / 1000);

  return [
    {
      data: JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: opts.text,
            },
            finish_reason: null,
          },
        ],
      }),
    },
    {
      data: JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      }),
    },
    {
      data: '[DONE]',
    },
  ];
}

/**
 * Pipe OpenAI SSE events to a Node.js ServerResponse.
 */
export async function streamOpenAiEvents(
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
    res.write(`data: ${evt.data}\n\n`);

    const sleep = evt.delayMs ?? delayMs;
    if (sleep > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleep));
    }
  }

  if (!res.writableEnded) {
    res.end();
  }
}
