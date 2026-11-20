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

/** Persist only the routing fields, never the bridge journal's content preview.
 * A sandboxed direct writer may fail to cross the host boundary: delivery has
 * already succeeded, so fail closed without throwing and inviting a duplicate
 * send. In particular, never fall back to the CLI-writable turn-sends journal. */
export function recordCrossChatFollowThreadBinding(
  dataDir: string,
  sessionId: string,
  marker: BridgeSendMarker,
): void {
  if (marker.deliveryKind !== 'detoured_send' || !marker.crossChatFollowThread || !marker.targetChatId) return;
  if (!marker.messageId && !marker.targetRootMessageId) return;
  const record: BridgeSendMarker = {
    sentAtMs: marker.sentAtMs,
    sessionId,
    deliveryKind: 'detoured_send',
    ...(marker.messageId ? { messageId: marker.messageId } : {}),
    targetChatId: marker.targetChatId,
    ...(marker.targetRootMessageId ? { targetRootMessageId: marker.targetRootMessageId } : {}),
    crossChatFollowThread: marker.crossChatFollowThread,
  };
  try {
    mkdirSync(crossChatFollowThreadDir(dataDir), { recursive: true });
    appendFileSync(crossChatFollowThreadPath(dataDir, sessionId), `${JSON.stringify(record)}\n`);
  } catch {
    // The provider effect is already complete. A missing binding only disables
    // follow-up routing; it must never turn into a user-facing send failure.
  }
}
