import { createHash } from 'node:crypto';
import type { DurableLarkOutboxTarget } from '../services/durable-lark-outbox.js';

export function durablePrimaryFinalProviderUuid(input: {
  larkAppId: string;
  scope: 'thread' | 'chat';
  anchor: string;
  turnId: string;
}): string {
  return `dps_${createHash('sha256').update(JSON.stringify([
    input.larkAppId,
    input.scope,
    input.anchor,
    input.turnId,
    'final',
  ])).digest('hex').slice(0, 32)}`;
}

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
  /** 测试 seam；生产默认按固定退避等待 owning daemon 恢复。 */
  sleep?(ms: number): Promise<void>;
}

type DurableSessionSendResponse = {
  ok?: boolean;
  kind?: string;
  messageId?: string;
  error?: string;
};

const DURABLE_SESSION_SEND_RETRY_DELAYS_MS = [0, 1_000, 5_000] as const;

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Route one already-rendered Session message through the owning daemon. */
export async function dispatchDurableSessionMessage(
  deps: DurableSessionSendDeps,
  input: DurableSessionSendInput,
): Promise<string> {
  const payload = {
    turnId: input.turnId,
    target: input.target,
    content: input.content,
    msgType: input.msgType,
    providerUuid: input.providerUuid,
    ...(input.hookContext ? { hookContext: input.hookContext } : {}),
  };
  let lastError = 'owning daemon did not return a response';
  for (let attempt = 0; attempt < DURABLE_SESSION_SEND_RETRY_DELAYS_MS.length; attempt += 1) {
    const delayMs = DURABLE_SESSION_SEND_RETRY_DELAYS_MS[attempt];
    if (delayMs > 0) await (deps.sleep ?? sleep)(delayMs);
    let response: Response;
    try {
      response = await deps.post(input.sessionId, 'durable-send', payload);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt + 1 < DURABLE_SESSION_SEND_RETRY_DELAYS_MS.length) continue;
      break;
    }
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
    lastError = detail;
    if (!retryableStatus(response.status)
        || attempt + 1 >= DURABLE_SESSION_SEND_RETRY_DELAYS_MS.length) {
      break;
    }
  }
  throw new Error(`durable Session send failed: ${lastError}`);
}
