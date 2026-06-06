/**
 * Idle session auto-suspender — scans active sessions and kills workers
 * (and their tmux sessions) when the user hasn't sent a message for too long.
 *
 * Two tiers:
 *   1. Light sleep (30 min) — kill worker + tmux, session can resume on next msg
 *   2. Deep sleep (4 h)   — same action, different notification
 *
 * Both tiers use killWorker() which sends {type:'close'} to the worker;
 * the worker's close handler destroys the tmux session before exiting.
 * On the next user message, handleThreadReply sees ds.worker === null and
 * re-forks with resume=true → new tmux + claude --resume from JSONL.
 */

import type { DaemonSession } from './types.js';
import { killWorker } from './worker-pool.js';
import { logger } from '../utils/logger.js';

const LIGHT_SLEEP_MS = 30 * 60 * 1000;   // 30 minutes
const DEEP_SLEEP_MS = 4 * 60 * 60 * 1000; // 4 hours
const SCAN_INTERVAL_MS = 60 * 1000;        // scan every minute

interface SuspendState {
  tier: 'none' | 'light' | 'deep';
  /** Avoid re-sending notifications every scan cycle. */
  notified: boolean;
}

const stateMap = new Map<string, SuspendState>();

function stateKey(sessionId: string): string {
  return sessionId;
}

export function startIdleSuspender(
  activeSessions: Map<string, DaemonSession>,
  sendNotification: (ds: DaemonSession, tier: 'light' | 'deep') => void,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    const now = Date.now();

    for (const ds of activeSessions.values()) {
      const sid = ds.session.sessionId;
      const lastMsg = ds.lastMessageAt;

      // Skip sessions that can't be evaluated
      if (!lastMsg) continue;
      if (ds.pendingRepo) continue;

      const idleMs = now - lastMsg;
      const key = stateKey(sid);
      let st = stateMap.get(key);

      if (!st) {
        st = { tier: 'none', notified: false };
        stateMap.set(key, st);
      }

      // Determine target tier
      let targetTier: 'none' | 'light' | 'deep' = 'none';
      if (idleMs > DEEP_SLEEP_MS) targetTier = 'deep';
      else if (idleMs > LIGHT_SLEEP_MS) targetTier = 'light';

      // Transition back to active — user came back
      if (targetTier === 'none') {
        if (st.tier !== 'none') {
          logger.info(`[idle-suspender] ${sid.substring(0, 8)} woke up (was ${st.tier})`);
        }
        st.tier = 'none';
        st.notified = false;
        continue;
      }

      // Already at or above this tier — skip
      if (st.tier !== 'none' && st.tier !== targetTier) {
        // Upgrading from light → deep, update state but don't re-kill
        st.tier = targetTier;
        st.notified = false; // allow deep notification
      }
      if (st.tier === targetTier && (st.notified || ds.worker === null || ds.worker?.killed)) {
        continue;
      }

      // Execute suspend
      if (ds.worker && !ds.worker.killed) {
        killWorker(ds);
        st.tier = targetTier;
        st.notified = true;
        logger.info(
          `[idle-suspender] ${targetTier} sleep: ${sid.substring(0, 8)} ` +
          `(idle ${Math.round(idleMs / 60000)}m, larkAppId=${ds.larkAppId})`,
        );
        sendNotification(ds, targetTier);
      } else {
        // Worker already dead (e.g. after daemon restart with quiet mode),
        // still mark tier so we notify if needed
        st.tier = targetTier;
      }
    }
  }, SCAN_INTERVAL_MS);

  timer.unref?.();
  return timer;
}

/** Forget suspend state for a session (call when session is closed/removed). */
export function forgetSuspendState(sessionId: string): void {
  stateMap.delete(stateKey(sessionId));
}

/** Reset suspend state when user sends a new message (session is active again). */
export function markSessionActive(sessionId: string): void {
  const st = stateMap.get(stateKey(sessionId));
  if (st) {
    st.tier = 'none';
    st.notified = false;
  }
}
