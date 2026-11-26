import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLockSync } from '../utils/file-lock.js';
import {
  buildBridgeSendMarkerContent,
  type BridgeSendMarker,
} from './bridge-fallback-gate.js';
import { recordCrossChatFollowThreadBinding } from './cross-chat-follow-thread-store.js';

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
  crossChatFollowThread?: BridgeSendMarker['crossChatFollowThread'];
  followThreadEpoch?: BridgeSendMarker['followThreadEpoch'];
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
    ...(input.crossChatFollowThread ? { crossChatFollowThread: input.crossChatFollowThread } : {}),
    ...(input.followThreadEpoch ? { followThreadEpoch: input.followThreadEpoch } : {}),
    ...buildBridgeSendMarkerContent(input.content),
  };
  const markerDir = join(input.dataDir, 'turn-sends');
  if (!existsSync(markerDir)) mkdirSync(markerDir, { recursive: true });
  appendFileSync(join(markerDir, `${input.sessionId}.jsonl`), `${JSON.stringify(marker)}\n`);
  recordCrossChatFollowThreadBinding(input.dataDir, input.sessionId, marker);
  return marker;
}

/** Serialize a marker existence check with its subsequent append, including
 *  replay paths where PID advancement is forbidden or the PID lock failed. */
export function withBridgeReplyMarkerLock<T>(dataDir: string, sessionId: string, fn: () => T): T {
  const directory = join(dataDir, 'turn-sends');
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  return withFileLockSync(join(directory, `${sessionId}.jsonl`), fn);
}

/** Exact delivery identity used by replay/recovery before appending a marker.
 * The caller normally holds the PID-marker lock, so the check and subsequent
 * append serialize with other senders of the same turn. */
export function hasBridgeReplyMarker(input: {
  dataDir: string;
  sessionId: string;
  turnId: string | undefined;
  messageId: string | undefined;
  responseKind?: BridgeSendMarker['responseKind'];
}): boolean {
  if (!input.turnId || !input.messageId) return false;
  const path = join(input.dataDir, 'turn-sends', `${input.sessionId}.jsonl`);
  if (!existsSync(path)) return false;
  try {
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const marker = JSON.parse(line) as BridgeSendMarker;
        if (typeof marker.sentAtMs !== 'number') continue;
        if (marker.turnId === input.turnId && marker.messageId === input.messageId
          && (input.responseKind === undefined || marker.responseKind === input.responseKind)) return true;
      } catch { /* skip malformed lines, matching the worker reader */ }
    }
  } catch { /* an unreadable journal cannot prove prior publication */ }
  return false;
}
