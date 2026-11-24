import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { finalBridgeSendMarkerCoversOwnThread, type BridgeSendMarker } from '../services/bridge-fallback-gate.js';
import type { DaemonSession } from './types.js';
import { isHumanInboundTurnId, isSubstituteTurn } from './reply-target.js';
import { privateReplyEnabled } from './private-reply.js';
import { isTriggerFinalSuppressed } from './trigger-final-suppression.js';
import { managedAuxUiSuppressedFor, sessionUsesTurnTerminal } from './worker-pool.js';

const FINAL_SEND_MARKER_TAIL_BYTES = 64 * 1024;

/** Check whether this turn/attempt has already delivered an explicit final reply
 *  to its own conversation via `botmux send --response-kind final`. Only invoked
 *  after a turn exceeds its reminder threshold, so steady-state scans do no I/O. */
function hasExplicitFinalSendForTurn(
  session: DaemonSession,
  turnId: string,
  dispatchAttempt?: number,
): boolean {
  const sessionId = session.session?.sessionId;
  if (!sessionId) return false;
  const path = join(config.session.dataDir, 'turn-sends', `${sessionId}.jsonl`);
  if (!existsSync(path)) return false;
  const observation = session.replyExecutionStarts?.get(JSON.stringify([turnId, dispatchAttempt ?? null]));
  const minSentAtMs = observation && observation.workerGeneration === session.workerGeneration
    ? observation.startedAtMs
    : undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, FINAL_SEND_MARKER_TAIL_BYTES);
    if (length <= 0) return false;
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.subarray(0, read).toString('utf8').split('\n');
    if (size > length) lines.shift();
    const ownThread = {
      sessionId,
      chatId: session.chatId,
      rootMessageId: session.session.rootMessageId,
    };
    for (let i = lines.length - 1; i >= 0; i--) {
      const raw = lines[i]?.trim();
      if (!raw) continue;
      let marker: BridgeSendMarker;
      try { marker = JSON.parse(raw) as BridgeSendMarker; }
      catch { continue; }
      if (marker?.turnId !== turnId) continue;
      if (!finalBridgeSendMarkerCoversOwnThread(ownThread, marker)) continue;
      if (dispatchAttempt !== undefined) {
        if (marker.dispatchAttempt !== undefined) {
          if (marker.dispatchAttempt !== dispatchAttempt) continue;
        } else if (minSentAtMs === undefined || typeof marker.sentAtMs !== 'number' || marker.sentAtMs < minSentAtMs) {
          continue;
        }
      }
      if (minSentAtMs !== undefined && typeof marker.sentAtMs === 'number' && marker.sentAtMs < minSentAtMs) {
        continue;
      }
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/**
 * Preserve each exact turn's existing IM, silent, meeting, replay and
 * presentation boundaries. The predicate mirrors the per-turn auxiliary-card
 * gates used by the CLI progress notifier (`beginCliNotice` /
 * `cliNotices.allowed` in worker-pool): only a real human-inbound turn may
 * receive an auxiliary operational card. In particular, daemon-minted
 * maintenance turns (`auto-compact:…` passthrough writes) have their own
 * execution observations but must not produce "task still running" cards.
 */
export function canSendLongTaskReminder(
  session: DaemonSession,
  turnId: string,
  dispatchAttempt?: number,
): boolean {
  return isHumanInboundTurnId(turnId)
    && !session.chatId.startsWith('doc:')
    && !managedAuxUiSuppressedFor(session, turnId, dispatchAttempt)
    // Chat-scope substitute (分身) turns hide their streaming card per turn;
    // an operational reminder must not become that turn's only group output.
    && !isSubstituteTurn(session, turnId)
    // A group role configured for private replies keeps all turn output in
    // the requester DM; a topic card would leak the running task's title.
    && !privateReplyEnabled(session)
    // Trigger turns whose final result is isolated must not surface aux UI.
    && !isTriggerFinalSuppressed(session, turnId)
    // Adopted terminal sessions own no Lark turn surface.
    && !session.adoptedFrom
    && !session.session.adoptedFrom
    // Defense-in-depth for non-turn-terminal CLIs (e.g. Antigravity terminal
    // mode): once the screen is confirmed idle with no pending background tasks,
    // do not fire "still running" even if an execution clock was not retired yet.
    && !(session.lastScreenStatus === 'idle' && !session.backgroundTaskCount && !sessionUsesTurnTerminal(session))
    // Once this execution has already delivered an explicit final reply to its
    // own thread (`botmux send --response-kind final`), never send a reminder.
    && !hasExplicitFinalSendForTurn(session, turnId, dispatchAttempt);
}
