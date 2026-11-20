import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BridgeSendMarker } from './bridge-fallback-gate.js';
import type { TurnSendKind, TurnSendLedger, TurnSendLedgerKey } from './turn-send-ledger.js';

const DIRECTORY = '.dashboard-secret.cross-chat-follow-thread';

/** Host-authoritative follow bindings. This directory is included in
 * hostAuthorityPaths so sandboxed CLIs cannot read, forge, or reopen it through
 * a deeper user grant. Host CLI / host relay writers do not need daemon IPC. */
export function crossChatFollowThreadDir(dataDir: string): string {
  return join(dataDir, DIRECTORY);
}

export function crossChatFollowThreadPath(dataDir: string, sessionId: string): string {
  return join(crossChatFollowThreadDir(dataDir), `${sessionId}.jsonl`);
}

export function effectiveCrossChatFollowThreadMode(input: {
  targetChatId: string;
  sourceChatId: string;
  noFollowThread: boolean;
}): BridgeSendMarker['crossChatFollowThread'] {
  return input.targetChatId !== input.sourceChatId ? (input.noFollowThread ? 'off' : 'at') : undefined;
}

/** Backfill a missing at binding after a replayed provider success. Existing
 * records for the same root are authoritative, including an off tombstone:
 * replay never re-enables follow or duplicates the original delivery. */
export function ensureCrossChatFollowThreadAtBinding(input: {
  dataDir: string;
  sessionId: string;
  sentAtMs: number;
  messageId: string;
  targetChatId: string;
  targetRootMessageId?: string;
  followThreadEpoch?: string;
}): boolean {
  const canonicalRoot = input.targetRootMessageId ?? input.messageId;
  try {
    const filePath = crossChatFollowThreadPath(input.dataDir, input.sessionId);
    if (existsSync(filePath)) {
      for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        let record: BridgeSendMarker;
        try { record = JSON.parse(line) as BridgeSendMarker; } catch { continue; }
        if (record.sessionId === input.sessionId
          && record.deliveryKind === 'detoured_send'
          && record.targetChatId === input.targetChatId
          && record.followThreadEpoch === input.followThreadEpoch
          && (record.messageId === canonicalRoot || record.targetRootMessageId === canonicalRoot)) {
          return true;
        }
      }
    }
    return recordCrossChatFollowThreadBinding(input.dataDir, input.sessionId, {
      sentAtMs: input.sentAtMs,
      deliveryKind: 'detoured_send',
      messageId: input.messageId,
      targetChatId: input.targetChatId,
      ...(input.targetRootMessageId ? { targetRootMessageId: input.targetRootMessageId } : {}),
      crossChatFollowThread: 'at',
      followThreadEpoch: input.followThreadEpoch,
    });
  } catch {
    return false;
  }
}

/** Replay validation is the first side-effect boundary for a changed request.
 * Only after it succeeds may an off tombstone be persisted; a conflict must
 * leave the previous at binding untouched. */
export async function replayOrThrowThenPersistOff(
  ledger: TurnSendLedger,
  key: TurnSendLedgerKey,
  kind: TurnSendKind,
  renderedContent: string,
  off?: {
    dataDir: string;
    sessionId: string;
    targetChatId: string;
    targetRootMessageId: string;
    followThreadEpoch?: string;
  },
): Promise<{ messageId: string; replayed: boolean } | undefined> {
  const replay = await ledger.replayOrThrow(key, kind, renderedContent);
  if (off) {
    const persisted = recordCrossChatFollowThreadBinding(off.dataDir, off.sessionId, {
      sentAtMs: Date.now(), deliveryKind: 'detoured_send', targetChatId: off.targetChatId,
      targetRootMessageId: off.targetRootMessageId, crossChatFollowThread: 'off',
      followThreadEpoch: off.followThreadEpoch,
    });
    if (!persisted) throw new Error('无法持久化 --no-follow-thread，已中止发送（未向飞书投递）');
  }
  return replay;
}

/** Persist only the routing fields, never the bridge journal's content preview.
 * Returns false when a sandboxed direct writer cannot cross the host boundary.
 * Post-delivery callers ignore that result so a provider success is not repeated;
 * pre-provider off tombstones must instead abort before any external effect.
 * Never fall back to the CLI-writable turn-sends journal. */
export function recordCrossChatFollowThreadBinding(
  dataDir: string,
  sessionId: string,
  marker: BridgeSendMarker,
): boolean {
  if (marker.deliveryKind !== 'detoured_send' || !marker.crossChatFollowThread || !marker.targetChatId) return true;
  if (!marker.messageId && !marker.targetRootMessageId) return true;
  const record: BridgeSendMarker = {
    sentAtMs: marker.sentAtMs,
    sessionId,
    deliveryKind: 'detoured_send',
    ...(marker.messageId ? { messageId: marker.messageId } : {}),
    targetChatId: marker.targetChatId,
    ...(marker.targetRootMessageId ? { targetRootMessageId: marker.targetRootMessageId } : {}),
    crossChatFollowThread: marker.crossChatFollowThread,
    ...(marker.followThreadEpoch ? { followThreadEpoch: marker.followThreadEpoch } : {}),
  };
  try {
    mkdirSync(crossChatFollowThreadDir(dataDir), { recursive: true });
    appendFileSync(crossChatFollowThreadPath(dataDir, sessionId), `${JSON.stringify(record)}\n`);
    return true;
  } catch {
    // The provider effect is already complete. A missing binding only disables
    // follow-up routing; it must never turn into a user-facing send failure.
    return false;
  }
}
