import type { DaemonSession } from './types.js';
import { groupIdleCloseMs, parseGroupIdleClose, type GroupIdleCloseSettings } from './group-idle-close.js';
import { hasProtectedSessionMutationOwnership } from './session-mutation-guard.js';
import { tryWithBotTurnMutation } from './bot-turn-mutation-gate.js';
import type { BackgroundClose } from './daemon-background-close.js';

export function isGroupIdleCloseCandidate(
  ds: DaemonSession,
  settings: GroupIdleCloseSettings | undefined,
  now: number,
): boolean {
  if (!settings?.enabled) return false;
  try { settings = parseGroupIdleClose(settings); }
  catch { return false; }
  if (ds.session.status !== 'active' || ds.chatType !== 'group') return false;
  if (ds.session.locked || ds.adoptedFrom || ds.session.adoptedFrom) return false;
  if (hasProtectedSessionMutationOwnership(ds)
    || ds.pendingRepo || ds.pendingRepoCommitInFlight || ds.worktreeCreating
    || ds.pendingRawInput || ds.pendingFollowUpInput || ds.pendingFollowUps?.length
    || ds.cascadeInFlight || ds.cascadeDeferred?.length
    || ds.tuiPromptCardId || ds.tuiPromptOptions?.length || ds.tuiPromptProcessing
    || ds.agentAttention || ds.usageLimit || ds.finalOutputDeliveriesInFlight?.size) return false;
  const live = ds.worker && !ds.worker.killed;
  if (live) {
    if (ds.lastScreenStatus !== 'idle' || ds.workerReady !== true) return false;
  } else {
    // Suspended/restored sessions can expire too, but never an unknown busy
    // state or a session whose initial input has not reached a CLI yet.
    if (!ds.hasHistory || ds.workerPort != null
      || (ds.lastScreenStatus !== undefined && ds.lastScreenStatus !== 'idle')) return false;
  }
  // Persisted activity also covers input paths which update the durable row
  // before the runtime mirror. Never fall back to creation time on corrupt data.
  const persisted = Date.parse(ds.session.lastMessageAt ?? '');
  const last = Math.max(ds.lastMessageAt || 0, Number.isFinite(persisted) ? persisted : 0);
  return Number.isFinite(last) && last > 0 && now - last >= groupIdleCloseMs(settings);
}

/** Single-flight, with a fresh eligibility/config check after admission drains. */
export function createGroupIdleCloseSweeper(deps: {
  larkAppId: string;
  sessions: Map<string, DaemonSession>;
  getSettings(chatId: string): GroupIdleCloseSettings | undefined;
  isTransferring(ds: DaemonSession): boolean;
  close: BackgroundClose;
  now?: () => number;
  log(message: string): void;
}): () => Promise<void> {
  let running = false;
  const now = deps.now ?? Date.now;
  return async () => {
    if (running) return;
    running = true;
    try {
      for (const [key, ds] of [...deps.sessions]) {
        const eligible = () => ds.larkAppId === deps.larkAppId
          && deps.sessions.get(key) === ds
          && !deps.isTransferring(ds)
          && isGroupIdleCloseCandidate(ds, deps.getSettings(ds.chatId), now());
        if (!eligible()) continue;
        try {
          await tryWithBotTurnMutation(deps.larkAppId, 1_000, async () => {
            if (!eligible()) return;
            const result = await deps.close(ds.session.sessionId, 'group idle auto-close');
            if (result.ok && !result.alreadyClosed) {
              deps.log(`[group-idle-close] closed session ${ds.session.sessionId}`);
            }
          });
        } catch (error) {
          deps.log(`[group-idle-close] failed for ${ds.session.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally { running = false; }
  };
}
