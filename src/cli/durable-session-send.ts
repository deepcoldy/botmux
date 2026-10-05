import type { DurableLarkOutboxTarget } from '../services/durable-lark-outbox.js';

export interface DurableSessionSendInput {
  sessionId: string;
  turnId: string;
  target: DurableLarkOutboxTarget;
  content: string;
  msgType: string;
  providerUuid: string;
  hookContext?: Record<string, unknown>;
}

export interface DurableSessionSendDeps {
  post(
    sessionId: string,
    route: 'durable-send',
    payload: Record<string, unknown>,
  ): Promise<Response>;
}

type DurableSessionSendResponse = {
  ok?: boolean;
  kind?: string;
  messageId?: string;
  error?: string;
};

/** Route one already-rendered Session message through the owning daemon. */
export async function dispatchDurableSessionMessage(
  deps: DurableSessionSendDeps,
  input: DurableSessionSendInput,
): Promise<string> {
  const response = await deps.post(input.sessionId, 'durable-send', {
    turnId: input.turnId,
    target: input.target,
    content: input.content,
    msgType: input.msgType,
    providerUuid: input.providerUuid,
    ...(input.hookContext ? { hookContext: input.hookContext } : {}),
  });
  const body = await response.json().catch(() => ({})) as DurableSessionSendResponse;
  if (response.ok && body.ok === true && body.kind === 'delivered'
      && typeof body.messageId === 'string' && body.messageId.startsWith('om_')) {
    return body.messageId;
  }
  const detail = typeof body.error === 'string' && body.error.trim()
    ? body.error.trim()
    : `HTTP ${response.status}`;
  if (body.kind === 'ambiguous') {
    throw new Error(`durable Session send is ambiguous: ${detail}`);
  }
  throw new Error(`durable Session send failed: ${detail}`);
}
