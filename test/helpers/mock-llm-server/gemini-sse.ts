import type { ServerResponse } from 'node:http';

/**
 * Gemini API generateContent wire format (Antigravity with `modelProvider:
 * "gemini"`, GEMINI_API_KEY and GOOGLE_GEMINI_BASE_URL):
 * history in `contents[].parts[]`, a tool result as a `functionResponse` part
 * in the last user content, and one `GenerateContentResponse` per SSE event.
 */

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: unknown;
}

/** Gemini contents as the role/content messages the marker extractor reads. */
export function geminiMessages(contents: unknown): Array<{ role: string; content: Array<{ type: 'text'; text: string }> }> {
  if (!Array.isArray(contents)) return [];
  return contents.map((content: any) => ({
    role: content?.role === 'model' ? 'assistant' : 'user',
    content: (Array.isArray(content?.parts) ? content.parts : [])
      .filter((part: GeminiPart) => typeof part?.text === 'string')
      .map((part: GeminiPart) => ({ type: 'text' as const, text: part.text! })),
  }));
}

/** The request answers a tool call: its last content carries a functionResponse. */
export function isGeminiToolResult(contents: unknown): boolean {
  if (!Array.isArray(contents) || contents.length === 0) return false;
  const last = contents[contents.length - 1] as { parts?: GeminiPart[] };
  return Array.isArray(last?.parts) && last.parts.some((part) => part?.functionResponse !== undefined);
}

export function buildGeminiResponse(reply: { text: string } | { functionCall: { name: string; args: Record<string, unknown> } }) {
  const part: GeminiPart = 'text' in reply ? { text: reply.text } : { functionCall: reply.functionCall };
  return {
    candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  };
}

export async function streamGeminiEvents(res: ServerResponse, responses: unknown[], delayMs = 0): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  for (const response of responses) {
    if (res.destroyed || res.writableEnded) break;
    res.write(`data: ${JSON.stringify(response)}\r\n\r\n`);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (!res.writableEnded) res.end();
}
