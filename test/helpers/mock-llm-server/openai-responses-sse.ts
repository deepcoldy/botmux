import type { ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { SseEvent } from './types.js';

export function createResponseId(): string {
  return `resp_mock_${randomBytes(12).toString('hex')}`;
}

export function createItemId(): string {
  return `item_mock_${randomBytes(12).toString('hex')}`;
}

/**
 * Generate SSE events matching OpenAI Responses API for Codex CLI.
 */
export function buildOpenAiResponsesTextEvents(opts: {
  model?: string;
  text: string;
}): SseEvent[] {
  const model = opts.model ?? 'gpt-6-astra';
  const respId = createResponseId();
  const itemId = createItemId();

  return [
    {
      data: JSON.stringify({
        type: 'response.created',
        response: {
          id: respId,
          object: 'response',
          status: 'in_progress',
          model,
          output: [],
        },
      }),
    },
    {
      data: JSON.stringify({
        type: 'response.in_progress',
        response: {
          id: respId,
          object: 'response',
          status: 'in_progress',
          model,
        },
      }),
    },
    {
      data: JSON.stringify({
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: itemId,
          type: 'message',
          role: 'assistant',
          content: [],
        },
      }),
    },
    {
      data: JSON.stringify({
        type: 'response.content_part.added',
        output_index: 0,
        content_index: 0,
        part: {
          type: 'text',
          text: '',
        },
      }),
    },
    {
      data: JSON.stringify({
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        delta: opts.text,
      }),
    },
    {
      data: JSON.stringify({
        type: 'response.output_text.done',
        output_index: 0,
        content_index: 0,
        text: opts.text,
      }),
    },
    {
      data: JSON.stringify({
        type: 'response.content_part.done',
        output_index: 0,
        content_index: 0,
        part: {
          type: 'text',
          text: opts.text,
        },
      }),
    },
    {
      data: JSON.stringify({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: itemId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'text',
              text: opts.text,
            },
          ],
        },
      }),
    },
    {
      data: JSON.stringify({
        type: 'response.completed',
        response: {
          id: respId,
          object: 'response',
          status: 'completed',
          model,
          output: [
            {
              id: itemId,
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'text',
                  text: opts.text,
                },
              ],
            },
          ],
        },
      }),
    },
  ];
}

/**
 * Pipe SSE events for Responses API to ServerResponse.
 */
export async function streamResponsesEvents(
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

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (!res.writableEnded) {
    res.end();
  }
}
