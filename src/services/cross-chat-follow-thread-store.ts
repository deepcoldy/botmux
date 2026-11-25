import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BridgeSendMarker } from './bridge-fallback-gate.js';
import { withFileLockSync } from '../utils/file-lock.js';

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
  sourceTurnId?: string;
}): boolean {
  const canonicalRoot = input.targetRootMessageId ?? input.messageId;
  const filePath = crossChatFollowThreadPath(input.dataDir, input.sessionId);
  try {
    mkdirSync(crossChatFollowThreadDir(input.dataDir), { recursive: true });
    return withFileLockSync(filePath, () => {
      let latest: BridgeSendMarker | undefined;
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
            latest = record;
          }
        }
      }
      if (latest) {
        // The append order is authoritative for one canonical root. Never
        // revive a later off tombstone, replace an already-attributed binding,
        // or let an old receipt overwrite a newer send into the same root.
        if (latest.crossChatFollowThread !== 'at'
          || latest.sourceTurnId
          || !input.sourceTurnId
          || latest.messageId !== input.messageId) {
          return true;
        }
        // A legacy/replayed `at` for this exact provider receipt may be safely
        // enriched after upgrade. Append instead of rewriting the journal so a
        // crash cannot destroy the older routing record. Preserve the original
        // delivery timestamp and routing tuple: replay time is not send time,
        // and promoting it would let an older session outrank a later real send
        // to the same followed root.
        return appendCrossChatFollowThreadBindingUnlocked(input.dataDir, input.sessionId, {
          sentAtMs: latest.sentAtMs,
          deliveryKind: 'detoured_send',
          messageId: latest.messageId,
          targetChatId: latest.targetChatId,
          ...(latest.targetRootMessageId ? { targetRootMessageId: latest.targetRootMessageId } : {}),
          crossChatFollowThread: 'at',
          followThreadEpoch: latest.followThreadEpoch,
          turnId: input.sourceTurnId,
        });
      }
      return appendCrossChatFollowThreadBindingUnlocked(input.dataDir, input.sessionId, {
        sentAtMs: input.sentAtMs,
        deliveryKind: 'detoured_send',
        messageId: input.messageId,
        targetChatId: input.targetChatId,
        ...(input.targetRootMessageId ? { targetRootMessageId: input.targetRootMessageId } : {}),
        crossChatFollowThread: 'at',
        followThreadEpoch: input.followThreadEpoch,
        turnId: input.sourceTurnId,
      });
    });
  } catch {
    return false;
  }
}

export function persistCrossChatFollowThreadOffBeforeProvider(input: {
  dataDir: string;
  sessionId: string;
  targetChatId: string;
  targetRootMessageId: string;
  followThreadEpoch?: string;
}): void {
  const persisted = recordCrossChatFollowThreadBinding(input.dataDir, input.sessionId, {
    sentAtMs: Date.now(), deliveryKind: 'detoured_send', targetChatId: input.targetChatId,
    targetRootMessageId: input.targetRootMessageId, crossChatFollowThread: 'off',
    followThreadEpoch: input.followThreadEpoch,
  });
  if (!persisted) throw new Error('无法持久化 --no-follow-thread，已中止发送（未向飞书投递）');
}

/** Persist only the routing fields, never the bridge journal's content preview.
 * Returns false when a sandboxed direct writer cannot cross the host boundary.
 * Post-delivery callers ignore that result so a provider success is not repeated;
 * pre-provider off tombstones must instead abort before any external effect.
 * Never fall back to the CLI-writable turn-sends journal. */
function appendCrossChatFollowThreadBindingUnlocked(
  dataDir: string,
  sessionId: string,
  marker: BridgeSendMarker,
): boolean {
  const record: BridgeSendMarker = {
    sentAtMs: marker.sentAtMs,
    sessionId,
    deliveryKind: 'detoured_send',
    ...(marker.messageId ? { messageId: marker.messageId } : {}),
    targetChatId: marker.targetChatId!,
    ...(marker.targetRootMessageId ? { targetRootMessageId: marker.targetRootMessageId } : {}),
    crossChatFollowThread: marker.crossChatFollowThread!,
    ...(marker.followThreadEpoch ? { followThreadEpoch: marker.followThreadEpoch } : {}),
    ...(marker.turnId ? { sourceTurnId: marker.turnId } : {}),
  };
  appendFileSync(crossChatFollowThreadPath(dataDir, sessionId), `${JSON.stringify(record)}\n`);
  return true;
}

export function recordCrossChatFollowThreadBinding(
  dataDir: string,
  sessionId: string,
  marker: BridgeSendMarker,
): boolean {
  if (marker.deliveryKind !== 'detoured_send' || !marker.crossChatFollowThread || !marker.targetChatId) return true;
  if (!marker.messageId && !marker.targetRootMessageId) return true;
  const filePath = crossChatFollowThreadPath(dataDir, sessionId);
  try {
    mkdirSync(crossChatFollowThreadDir(dataDir), { recursive: true });
    return withFileLockSync(filePath, () => appendCrossChatFollowThreadBindingUnlocked(dataDir, sessionId, marker));
  } catch {
    // The provider effect is already complete. A missing binding only disables
    // follow-up routing; it must never turn into a user-facing send failure.
    return false;
  }
}
