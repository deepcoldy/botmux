import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BridgeSendMarker } from './bridge-fallback-gate.js';

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
