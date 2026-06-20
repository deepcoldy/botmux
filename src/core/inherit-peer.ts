/**
 * Decide whether a newly created session can reuse a sibling's `workingDir`
 * and skip the repo-selection card.
 *
 * Layer 1 — same-anchor cross-bot peer
 *   Another bot already pinned a workingDir at exactly this anchor (thread →
 *   root, chat → chatId). Covers 同根 thread reply / 同群 chat-scope reply
 *   collaboration: A bot is already running, B bot gets pulled in via
 *   @mention, B inherits A's workingDir without bouncing the user through
 *   another card. Same-bot is excluded — that path is handled elsewhere
 *   (sessions resume from their own state).
 *
 * Note on what's intentionally NOT covered:
 *   普通群 + scope=thread + same-chat chat-scope sibling. Used to fall through
 *   here so a user manually creating a 话题 in 普通群 reused the outer
 *   chat-scope's workingDir. We removed that — the user's intent on a manual
 *   topic is "isolate the context", and silently inheriting overrides it.
 *   See docs/superpowers/specs/2026-05-10-force-topic-mode-design.md.
 */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import * as sessionStore from '../services/session-store.js';
import { logger } from '../utils/logger.js';
import { expandHomePath } from '../utils/working-dir.js';

export interface InheritOptions {
  scope: 'thread' | 'chat';
  anchor: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  selfAppId: string;
}

export interface InheritedPeer {
  sessionId: string;
  larkAppId?: string;
  workingDir: string;
}

function resolvePeerWorkingDir(workingDir: string): string {
  return resolve(expandHomePath(workingDir));
}

function isValidPeerWorkingDir(workingDir: string): boolean {
  try {
    return statSync(resolvePeerWorkingDir(workingDir)).isDirectory();
  } catch {
    return false;
  }
}

export function findInheritablePeer(opts: InheritOptions): InheritedPeer | null {
  const { scope, anchor, chatId, selfAppId } = opts;
  const sameAnchorPeers = scope === 'thread'
    ? sessionStore.findActiveSessionsByRoot(anchor)
    : sessionStore.findActiveChatScopeSessionsByChat(chatId);
  for (const peer of sameAnchorPeers) {
    if (peer.larkAppId === selfAppId || !peer.workingDir) continue;
    if (isValidPeerWorkingDir(peer.workingDir)) {
      return { sessionId: peer.sessionId, larkAppId: peer.larkAppId, workingDir: peer.workingDir };
    }
    logger.warn(
      `[inherit-peer] ignored inherited peer workingDir from session ${peer.sessionId.substring(0, 8)} ` +
      `(app=${peer.larkAppId ?? 'unknown'}): ${resolvePeerWorkingDir(peer.workingDir)} is missing or not a directory`,
    );
  }
  return null;
}
