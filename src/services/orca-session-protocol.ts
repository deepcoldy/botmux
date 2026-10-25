import { createHash, randomUUID } from 'node:crypto';

export interface OrcaCursor { epoch: string; sequence: number }
export interface OrcaItem {
  itemId: string;
  revision: number;
  sequence: number;
  agentId?: string;
  turnScope?: { kind: string; turnItemId?: string };
  body: {
    kind: string;
    role?: string;
    blocks?: Array<{ type: string; text?: string }>;
    name?: string;
    title?: string;
    question?: string;
    text?: string;
    state?: string;
    outcome?: string;
    turnId?: string;
    userItemId?: string;
    resolution?: { state: string };
  };
}
export interface OrcaSubmission {
  clientMessageId: string;
  dispatchState: string;
  providerItemId: string | null;
  reason?: string | null;
  answeredInTurn?: { turnItemId: string } | null;
  queuedMessageId?: string;
}
export interface OrcaPage {
  sessionId: string;
  fence?: number;
  items: OrcaItem[];
  removedItemIds: string[];
  submissions: OrcaSubmission[];
  window: { nextCursor: OrcaCursor };
  liveCursor?: OrcaCursor;
  hasNewer: boolean;
  working?: boolean;
  queuedMessages?: Array<{ messageId: string; state: string; paused?: boolean }> | null;
  queuePause?: { reason: string } | null;
  latestTurn?: { itemId: string; turn: OrcaItem['body'] } | null;
}
export interface OrcaHistory { ok: boolean; page: OrcaPage }
export interface OrcaMutation {
  envelope: { sessionId: string; clientOperationId: string; expectedRuntimeFence: number; payloadFingerprint: string };
  [key: string]: unknown;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
}

/** Orca's public mutation fingerprint: stable field ordering, SHA-256, no runtime credentials. */
export function orcaMutation(method: string, sessionId: string, fence: number, fields: Record<string, unknown>): OrcaMutation {
  if (!Number.isSafeInteger(fence) || fence < 1) throw new Error('Orca did not provide a writable session fence');
  return {
    envelope: {
      sessionId, clientOperationId: orcaOperationId(), expectedRuntimeFence: fence,
      payloadFingerprint: createHash('sha256').update(canonical({ method, sessionId, fields })).digest('hex'),
    },
    ...fields,
  };
}

export function orcaOperationId(): string { return `${Date.now()}-${randomUUID().replaceAll('-', '')}`; }

export function orcaMessage(content: string): Record<string, unknown> {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text: content }] };
}

export function requireOrcaMutation<T>(result: { ok: boolean; value?: T; refusal?: { code?: string; message?: string } }): T {
  if (!result.ok || result.value === undefined) {
    throw new Error(`Orca refused the operation: ${result.refusal?.message || result.refusal?.code || 'unknown response'}`);
  }
  return result.value;
}
