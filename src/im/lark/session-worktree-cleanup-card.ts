/**
 * The session-closed card's「清理 worktree」button (#698): its wording, and the
 * click handler. The click answers at once with the same closed card saying
 * "checking…" (button gone, so it cannot be pressed twice), then runs the checks
 * and the removal after the ACK and patches the result into that card. A
 * refusal keeps the button so the user can fix the cause and press it again.
 */
import { t, type Locale } from '../../i18n/index.js';
import type { ClosedCardWorktreeCleanup } from './card-builder.js';
import type {
  SessionWorktreeBlockReason,
  SessionWorktreeCleanupOutcome,
} from '../../core/session-worktree-cleanup.js';
import type { Session } from '../../types.js';

/** Callback action of the closed card's「清理 worktree」button. Lives here, with
 *  no runtime imports from the card modules, so card-builder and the sensitive
 *  action registry can both import it without an import cycle. */
export const CLEANUP_SESSION_WORKTREE_ACTION = 'cleanup_session_worktree';

/** What the closed card's worktree section shows; absent → the default offer. */
export type ClosedCardCleanupState =
  | { phase: 'running' }
  | { phase: 'result'; outcome: SessionWorktreeCleanupOutcome };

function reasonLine(reason: SessionWorktreeBlockReason, loc: Locale): string {
  switch (reason.kind) {
    case 'uncommitted': return t('card.worktree_cleanup.reason_uncommitted', { n: String(reason.count) }, loc);
    case 'unpushed': return t('card.worktree_cleanup.reason_unpushed', { n: String(reason.count) }, loc);
    case 'sessions': return t('card.worktree_cleanup.reason_sessions', { n: String(reason.count) }, loc);
    case 'processes': return t('card.worktree_cleanup.reason_processes', { n: String(reason.count) }, loc);
    case 'sessions_unknown': return t('card.worktree_cleanup.reason_sessions_unknown', { error: reason.error }, loc);
    case 'processes_unknown': return t('card.worktree_cleanup.reason_processes_unknown', { error: reason.error }, loc);
    case 'status_unknown': return t('card.worktree_cleanup.reason_status_unknown', { error: reason.error }, loc);
  }
}

function outcomeNote(outcome: SessionWorktreeCleanupOutcome, loc: Locale): string {
  switch (outcome.status) {
    case 'removed': return t('card.worktree_cleanup.removed', { path: outcome.dir, branch: outcome.branch }, loc);
    case 'blocked': return [
      t('card.worktree_cleanup.blocked', { path: outcome.dir }, loc),
      ...outcome.reasons.map(reason => `- ${reasonLine(reason, loc)}`),
      t('card.worktree_cleanup.retry_hint', undefined, loc),
    ].join('\n');
    case 'gone': return t('card.worktree_cleanup.gone', { path: outcome.dir }, loc);
    case 'not_botmux': return t('card.worktree_cleanup.not_botmux', undefined, loc);
    case 'session_active': return t('card.worktree_cleanup.session_active', undefined, loc);
    case 'session_missing': return t('card.worktree_cleanup.session_missing', undefined, loc);
    case 'failed': return t('card.worktree_cleanup.failed', { path: outcome.dir, error: outcome.error }, loc);
  }
}

/**
 * The closed card's worktree section for one state. `offered` says whether the
 * session's working dir is a botmux-created worktree (only consulted for the
 * default state); undefined → no section, the legacy card.
 */
export function closedCardWorktreeSection(
  state: ClosedCardCleanupState | undefined,
  offered: boolean,
  loc: Locale,
): ClosedCardWorktreeCleanup | undefined {
  if (!state) return offered ? { note: t('card.worktree_cleanup.offer', undefined, loc), button: true } : undefined;
  if (state.phase === 'running') return { note: t('card.worktree_cleanup.running', undefined, loc), button: false };
  const retryable = state.outcome.status === 'blocked' || state.outcome.status === 'failed';
  return { note: outcomeNote(state.outcome, loc), button: retryable };
}

export interface SessionWorktreeCleanupActionDeps {
  canOperate: (larkAppId: string, chatId: string | undefined, openId: string | undefined) => boolean;
  getSession: (sessionId: string) => Session | undefined;
  buildCard: (session: Session, state: ClosedCardCleanupState) => string;
  cleanup: (sessionId: string, larkAppId: string) => Promise<SessionWorktreeCleanupOutcome>;
  updateCard: (messageId: string, card: string) => Promise<unknown>;
  sendToOperator: (openId: string, card: string) => Promise<unknown>;
  log?: (message: string) => void;
  locale: Locale;
}

type Toast = { toast: { type: 'info' | 'warning' | 'error'; content: string } };

export async function handleSessionWorktreeCleanupAction(
  input: { larkAppId?: string; operatorOpenId?: string; sessionId: unknown; cardMessageId?: string },
  deps: SessionWorktreeCleanupActionDeps,
): Promise<Toast | { card: { type: 'raw'; data: unknown }; afterAck: () => Promise<void> }> {
  const { larkAppId, operatorOpenId, cardMessageId } = input;
  const loc = deps.locale;
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
  if (!larkAppId || !operatorOpenId || !sessionId) {
    return { toast: { type: 'warning', content: t('card.worktree_cleanup.expired', undefined, loc) } };
  }
  const session = deps.getSession(sessionId);
  if (!session || (session.larkAppId && session.larkAppId !== larkAppId)) {
    return { toast: { type: 'warning', content: t('card.worktree_cleanup.session_missing', undefined, loc) } };
  }
  if (!deps.canOperate(larkAppId, session.chatId, operatorOpenId)) {
    return { toast: { type: 'error', content: t('card.worktree_cleanup.no_permission', undefined, loc) } };
  }
  if (session.status !== 'closed') {
    return { toast: { type: 'warning', content: t('card.worktree_cleanup.session_active', undefined, loc) } };
  }
  return {
    card: { type: 'raw', data: JSON.parse(deps.buildCard(session, { phase: 'running' })) },
    afterAck: async () => {
      const outcome = await deps.cleanup(sessionId, larkAppId);
      const card = deps.buildCard(deps.getSession(sessionId) ?? session, { phase: 'result', outcome });
      if (cardMessageId) {
        try {
          await deps.updateCard(cardMessageId, card);
          return;
        } catch (err) {
          // A closed card delivered ephemerally (flat groups, privateCard)
          // cannot be patched; the operator must still see what happened.
          deps.log?.(`[worktree-cleanup] could not update the clicked card, sending the result privately: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await deps.sendToOperator(operatorOpenId, card);
    },
  };
}
