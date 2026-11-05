/**
 * The failure card's「重试」button: re-deliver the original message of a
 * logical turn whose ordinary recovery ended failed.
 *
 * Permission is decided by the card handler (original sender while still
 * allowed to talk, or a bot operator — see recoveryRetryPermitted); this module
 * owns the at-most-once dispatch:
 *
 *  - the record is pinned by logical turn id, never by `lastFailedTurn` (which
 *    a later failure — e.g. a type-ahead follow-up — overwrites);
 *  - a durable `attempting` mark lands before any side effect, so a double
 *    click, a redelivered callback or a crash mid-dispatch cannot submit the
 *    same message twice; it is rolled back only when the worker provably
 *    refused the input;
 *  - the message runs as the ORIGINAL sender (frozen at admission), marked as a
 *    failed-turn recovery like the admin recovery primitive, and inherits the
 *    original turn's reply destination so the answer lands where the question
 *    was asked;
 *  - the content is the original envelope plus one line telling the model the
 *    turn may have half-run (buildRecoveryRetryContent).
 */
import { randomUUID } from 'node:crypto';
import type { TrustedCaller } from '../types.js';
import type { DaemonSession } from './types.js';
import * as sessionStore from '../services/session-store.js';
import {
  buildRecoveryRetryContent,
  RECOVERY_RETRY_TURN_PREFIX,
  recoveryRetryPermitted,
  userMessageExcerpt,
  type OrdinaryRecoveryNoticeRecord,
} from '../services/ordinary-recovery-notice.js';
import { localeForBot, t } from '../i18n/index.js';
import { canOperate, canTalk } from '../im/lark/event-dispatcher.js';
import { logger } from '../utils/logger.js';
import { pickTurnReplyTarget } from './reply-target.js';
import { hasProtectedSessionMutationOwnership } from './session-mutation-guard.js';
import {
  buildOrdinaryRecoveryNoticeCard,
  forkWorker,
  prepareFailedTurnRecoveryIdentity,
  sendWorkerInput,
  updateOrdinaryRecoveryNotice,
} from './worker-pool.js';
import { persistStreamCardState, rememberLastCliInput } from './session-manager.js';

export type OrdinaryRecoveryRetryError =
  | 'missing'
  | 'no_input'
  | 'already_retried'
  | 'session_unavailable'
  | 'submit_failed';

export type OrdinaryRecoveryRetryResult =
  | { ok: true; turnId: string; record: OrdinaryRecoveryNoticeRecord }
  | { ok: false; error: OrdinaryRecoveryRetryError };

export function findOrdinaryRecoveryNotice(
  ds: DaemonSession,
  logicalTurnId: string | undefined,
): OrdinaryRecoveryNoticeRecord | undefined {
  if (!logicalTurnId) return undefined;
  return ds.session.ordinaryRecoveryNotices?.find(entry => entry.logicalTurnId === logicalTurnId);
}

export async function retryOrdinaryRecoveryNotice(
  ds: DaemonSession,
  logicalTurnId: string,
  operatorOpenId: string,
  now: () => number = Date.now,
): Promise<OrdinaryRecoveryRetryResult> {
  const record = findOrdinaryRecoveryNotice(ds, logicalTurnId);
  if (!record) return { ok: false, error: 'missing' };
  if (record.retried) return { ok: false, error: 'already_retried' };
  if (!record.retry) return { ok: false, error: 'no_input' };
  if (ds.session.status !== 'active'
    || ((!ds.worker || ds.worker.killed) && hasProtectedSessionMutationOwnership(ds))) {
    return { ok: false, error: 'session_unavailable' };
  }

  // No await until the durable `attempting` mark below has landed, so a
  // concurrent second press always finds it and stops above.
  const turnId = `${RECOVERY_RETRY_TURN_PREFIX}${randomUUID()}`;
  const caller: TrustedCaller = { ...record.retry.trustedCaller, senderType: 'user' };
  delete caller.source;
  const recoveredCaller: TrustedCaller = { ...caller, source: 'failed_turn_recovery' };
  const content = buildRecoveryRetryContent(record.retry.cliInput);
  const userPrompt = userMessageExcerpt(record.retry.cliInput, 2_000) ?? content;
  const previous = {
    active: ds.activeInteractiveTurn,
    reply: ds.currentReplyTarget,
    failedTurnRecovery: ds.session.failedTurnRecovery,
  };
  let marked = false;
  try {
    // Inherit the original turn's exact destination (thread / quote / sender)
    // so the answer and any follow-up card land where the question was asked.
    const priorReply = pickTurnReplyTarget(ds.session, logicalTurnId);
    const updatedAt = new Date(now()).toISOString();
    const context = ds.session.turnReplyContexts?.[logicalTurnId];
    if (context !== undefined) {
      ds.session.turnReplyContexts = { ...(ds.session.turnReplyContexts ?? {}), [turnId]: structuredClone(context) };
    }
    const target = ds.session.replyTargets?.[logicalTurnId];
    ds.session.replyTargets = {
      ...(ds.session.replyTargets ?? {}),
      [turnId]: {
        ...(target ? structuredClone(target) : {}),
        senderOpenId: caller.requestUserOpenId,
        participants: target?.participants ?? (caller.requestUserOpenId
          ? [{ openId: caller.requestUserOpenId, isBot: false }] : []),
        updatedAt,
      },
    };
    ds.session.failedTurnRecovery = { originalTurnId: logicalTurnId, turnId, caller: { ...caller } };
    ds.activeInteractiveTurn = { turnId, caller: recoveredCaller, userPrompt };
    ds.currentReplyTarget = {
      rootMessageId: priorReply?.rootMessageId ?? ds.session.rootMessageId,
      turnId,
      updatedAt,
    };
    ds.session.currentReplyTarget = { ...ds.currentReplyTarget };
    // Durable at-most-once fence before any side effect. A throw here aborts
    // before the worker sees anything.
    const fenced = updateOrdinaryRecoveryNotice(ds, logicalTurnId, entry => {
      entry.retried = { byOpenId: operatorOpenId, at: now(), turnId, state: 'attempting' };
    });
    if (!fenced?.retried) throw new Error('retry fence was not persisted');
    marked = true;
    await prepareFailedTurnRecoveryIdentity(ds, turnId);
    let rejected = false;
    // sendWorkerInput reports IPC failure as `false`; forkWorker only throws
    // before spawning (e.g. a deleted working directory). Either way nothing
    // reached the CLI. `deferDuringDeviceIsolation: false` makes a fork that
    // cannot be admitted right now (memory pressure, device activation) say so
    // synchronously instead of reporting `deferred` and failing later, after
    // this click was already recorded as accepted.
    const accepted = ds.worker && !ds.worker.killed
      ? sendWorkerInput(ds, { content }, turnId, { trustedCaller: recoveredCaller, atMostOnce: true })
      : forkWorker(ds, { content }, {
        resume: ds.hasHistory, turnId, trustedCaller: recoveredCaller, atMostOnce: true,
      }, {
        deferDuringDeviceIsolation: false,
        onAdmission: admission => { rejected = admission === 'rejected'; },
      });
    if (!accepted || rejected) throw new Error('worker refused the re-delivery');
    rememberLastCliInput(ds, userPrompt, { content }, turnId);
    const settled = updateOrdinaryRecoveryNotice(ds, logicalTurnId, entry => {
      if (entry.retried?.turnId === turnId) entry.retried.state = 'accepted';
    }) ?? findOrdinaryRecoveryNotice(ds, logicalTurnId) ?? record;
    return { ok: true, turnId, record: settled };
  } catch {
    // Nothing reached the CLI: restore the runtime routing and release the
    // fence so the button can be pressed again.
    ds.activeInteractiveTurn = previous.active;
    ds.currentReplyTarget = previous.reply;
    ds.session.currentReplyTarget = previous.reply ? { ...previous.reply } : undefined;
    ds.session.failedTurnRecovery = previous.failedTurnRecovery;
    if (marked) {
      try {
        updateOrdinaryRecoveryNotice(ds, logicalTurnId, entry => {
          if (entry.retried?.turnId === turnId) delete entry.retried;
        });
      } catch { /* the stored attempting fence fails closed (no second dispatch) */ }
    } else {
      try { sessionStore.updateSession(ds.session); } catch { /* routing rollback is best effort */ }
    }
    return { ok: false, error: 'submit_failed' };
  }
}

export interface OrdinaryRecoveryRetryClick {
  logicalTurnId: string | undefined;
  operatorOpenId: string | undefined;
  /** Lark-verified union of the clicker (team-member talk leg). */
  operatorUnionId?: string;
}

type CardActionReply = {
  toast: { type: 'success' | 'warning' | 'error' | 'info'; content: string };
  card?: { type: 'raw'; data: unknown };
};

/** Card callback for `retry_recovery_turn`: gate → dispatch → patch the card
 *  in place to「已由谁重试」. Deliberately NOT behind the generic canOperate
 *  card gate — the original sender (usually a talk-only member of an oncall
 *  group) must be able to press it; this is the gate instead. */
export async function handleOrdinaryRecoveryRetryClick(
  ds: DaemonSession,
  click: OrdinaryRecoveryRetryClick,
): Promise<CardActionReply> {
  const locale = localeForBot(ds.larkAppId);
  const warn = (key: string): CardActionReply => ({ toast: { type: 'warning', content: t(key, undefined, locale) } });
  const record = findOrdinaryRecoveryNotice(ds, click.logicalTurnId);
  if (!record || !click.logicalTurnId) return warn('card.action.retry_recovery_missing');
  const operatorOpenId = click.operatorOpenId;
  const operatorIsAdmin = canOperate(ds.larkAppId, ds.chatId, operatorOpenId);
  const operatorCanTalk = canTalk(
    ds.larkAppId, ds.chatId, operatorOpenId, undefined, click.operatorUnionId, ds.chatType,
  );
  if (!operatorOpenId || !recoveryRetryPermitted({
    operatorOpenId,
    initiatorOpenId: record.initiatorOpenId,
    operatorIsAdmin,
    operatorCanTalk,
  })) {
    logger.info(
      `[${ds.session.sessionId.slice(0, 8)}] retry_recovery_turn refused for ${operatorOpenId ?? 'unknown'} `
      + `(turn ${click.logicalTurnId.slice(0, 16)})`,
    );
    return warn('card.action.retry_recovery_denied');
  }
  if (record.retried) {
    return {
      ...warn('card.action.retry_recovery_already'),
      ...(record.retried.state === 'accepted'
        ? { card: { type: 'raw' as const, data: JSON.parse(buildOrdinaryRecoveryNoticeCard(ds, record)) } }
        : {}),
    };
  }
  if (!record.retry) return warn('card.action.retry_recovery_missing');
  // The message re-runs as its original sender: that person must still be
  // allowed to talk to the bot, whoever pressed the button.
  const sender = record.retry.trustedCaller;
  if (!canTalk(ds.larkAppId, ds.chatId, sender.requestUserOpenId, undefined,
    sender.requestUserUnionId, ds.chatType)) {
    return warn('card.action.retry_recovery_initiator_denied');
  }
  const result = await retryOrdinaryRecoveryNotice(ds, click.logicalTurnId, operatorOpenId);
  if (!result.ok) {
    logger.warn(
      `[${ds.session.sessionId.slice(0, 8)}] retry_recovery_turn for ${click.logicalTurnId.slice(0, 16)} `
      + `failed: ${result.error}`,
    );
    if (result.error === 'already_retried') return warn('card.action.retry_recovery_already');
    if (result.error === 'missing' || result.error === 'no_input') return warn('card.action.retry_recovery_missing');
    return warn('card.action.retry_recovery_unavailable');
  }
  logger.info(
    `[${ds.session.sessionId.slice(0, 8)}] retry_recovery_turn re-delivered ${click.logicalTurnId.slice(0, 16)} `
    + `as ${result.turnId.slice(0, 28)} (by ${operatorOpenId})`,
  );
  // Same live-card hand-off as the other retry buttons: the card shows work.
  ds.lastScreenStatus = 'working';
  ds.streamCardPending = true;
  ds.currentTurnTitle = (result.record.task || ds.currentTurnTitle || ds.session.title || '').substring(0, 50);
  ds.currentImageKey = undefined;
  try { persistStreamCardState(ds); } catch { /* card bookkeeping is best effort */ }
  return {
    toast: { type: 'success', content: t('card.action.retry_recovery_success', undefined, locale) },
    card: { type: 'raw', data: JSON.parse(buildOrdinaryRecoveryNoticeCard(ds, result.record)) },
  };
}
