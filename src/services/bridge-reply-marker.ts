import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildBridgeSendMarkerContent,
  type BridgeSendMarker,
} from './bridge-fallback-gate.js';

export interface RecordBridgeReplyMarkerInput {
  dataDir: string;
  /** The worker session whose turn produced the visible delivery. */
  sessionId: string;
  sentAtMs: number;
  messageId?: string;
  deliveryId?: string;
  deliveryKind: NonNullable<BridgeSendMarker['deliveryKind']>;
  content: string;
  responseKind?: BridgeSendMarker['responseKind'];
  turnId?: string;
  dispatchAttempt?: number;
  terminalCarrier?: BridgeSendMarker['terminalCarrier'];
  replyCardResponseKind?: BridgeSendMarker['replyCardResponseKind'];
  terminalIndependent?: true;
  targetChatId?: string;
  targetRootMessageId?: string;
  targetSessionId?: string;
  dispatchRootId?: string;
}

/**
 * Append one successful, user-visible CLI delivery to the owning worker's
 * bridge journal. Callers deliberately invoke this only after the provider or
 * dispatch relay has acknowledged the delivery. The file is per source
 * session; destination overrides are metadata, never the attribution key.
 */
export function recordBridgeReplyMarker(input: RecordBridgeReplyMarkerInput): BridgeSendMarker {
  const marker: BridgeSendMarker = {
    sentAtMs: input.sentAtMs,
    sessionId: input.sessionId,
    deliveryKind: input.deliveryKind,
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
    ...(input.responseKind ? { responseKind: input.responseKind } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.dispatchAttempt !== undefined ? { dispatchAttempt: input.dispatchAttempt } : {}),
    ...(input.terminalCarrier ? { terminalCarrier: input.terminalCarrier } : {}),
    ...(input.replyCardResponseKind ? { replyCardResponseKind: input.replyCardResponseKind } : {}),
    ...(input.terminalIndependent ? { terminalIndependent: true } : {}),
    ...(input.targetChatId ? { targetChatId: input.targetChatId } : {}),
    ...(input.targetRootMessageId ? { targetRootMessageId: input.targetRootMessageId } : {}),
    ...(input.targetSessionId ? { targetSessionId: input.targetSessionId } : {}),
    ...(input.dispatchRootId ? { dispatchRootId: input.dispatchRootId } : {}),
    ...buildBridgeSendMarkerContent(input.content),
  };
  const markerDir = join(input.dataDir, 'turn-sends');
  if (!existsSync(markerDir)) mkdirSync(markerDir, { recursive: true });
  appendFileSync(join(markerDir, `${input.sessionId}.jsonl`), `${JSON.stringify(marker)}\n`);
  return marker;
}
