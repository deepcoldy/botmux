/**
 * Claim card for scheduled tasks that have no usable run-as identity.
 *
 * With trigger-user auth on, a scheduled turn runs as its creator (or, after a
 * claim, its claimant), re-checked against the bot's live access at every fire.
 * Tasks created before creators were recorded, by a bot turn or on the platform
 * have no such person; others have one who lost access. Their turns run with no
 * identity, so every identity-bound tool call is refused and an unattended task
 * stays stuck. Instead of a command nobody would know to type, the fire posts a
 * card into the task's chat (or bound topic) that says which task, why it needs
 * a claimant and what would run under the claimant's identity. Whoever clicks
 * "claim" — taken from the Lark-verified callback operator, never from the
 * button value or any model input — becomes the task's run-as identity in its
 * host authority record.
 *
 * Quiet by construction: one card per task (SQLite bookkeeping, survives
 * restarts). While unclaimed, later fires refresh that card in place; a
 * re-publication of the same turn (restore, identity-model replay) is not a
 * fire. A task that has an identity never gets a card.
 *
 * Every button requires the clicker to pass `canOperate` for the bot — the same
 * check a fire applies to the identity — and every accepted action is logged
 * with the task, the operator's union_id, the chat and the time.
 *
 * Everything with side effects is injected so the policy is testable without a
 * daemon; daemon.ts wires the real store, scheduler and Lark client.
 */
import { t, type Locale } from '../i18n/index.js';
import type { CardActionData } from '../im/lark/card-handler.js';
import {
  buildScheduleIdentityClaimCard,
  SCHEDULE_IDENTITY_CLAIM_ACTION,
  SCHEDULE_IDENTITY_RECLAIM_ACTION,
  SCHEDULE_IDENTITY_RERUN_ACTION,
  type ScheduleClaimCardTask,
} from '../im/lark/schedule-identity-claim-card.js';
import type {
  ScheduleAuthorityRecord,
  ScheduleClaimCardRecord,
  ScheduleIdentityGapReason,
} from '../services/schedule-authority-store.js';
import type { ScheduledTask, ScheduleRunAsClaim } from '../types.js';
import { parseScheduleRunAsClaim, scheduledTaskRunAs } from './schedule-run-as.js';
import type { ClaimTaskRunAsResult } from './scheduler.js';

/** Same shape the schedule mutation route accepts. */
const TASK_ID = /^[0-9a-z_]{1,50}$/;

export type ScheduledRunIdentity =
  | { ok: true; openId: string; unionId: string; source: 'claim' | 'creator' }
  | { ok: false; reason: ScheduleIdentityGapReason; lapsedOpenId?: string };

/**
 * The identity a scheduled run of `task` on bot `larkAppId` may act as, or why
 * there is none. The single decision behind both credential publication and
 * the claim card, so the two can never disagree about whether a task "has an
 * identity".
 */
export function resolveScheduledRunIdentity(
  task: ScheduledTask,
  larkAppId: string,
  canOperate: (openId: string, unionId: string) => boolean,
): ScheduledRunIdentity {
  const runAs = scheduledTaskRunAs(task, larkAppId);
  if (!runAs) return { ok: false, reason: 'no_creator' };
  // open_id is app-scoped: a creator recorded under another app, or by
  // union_id alone, gives this bot nobody to publish credentials for.
  if (runAs.larkAppId !== larkAppId || !runAs.openId) {
    return { ok: false, reason: runAs.source === 'claim' ? 'claimant_revoked' : 'no_creator' };
  }
  if (!canOperate(runAs.openId, runAs.unionId)) {
    return {
      ok: false,
      reason: runAs.source === 'claim' ? 'claimant_revoked' : 'creator_revoked',
      lapsedOpenId: runAs.openId,
    };
  }
  return { ok: true, openId: runAs.openId, unionId: runAs.unionId, source: runAs.source };
}

export type ClaimCardLocation =
  | { kind: 'thread'; rootMessageId: string }
  | { kind: 'chat'; chatId: string };

/**
 * Where the task's single card lives: inside the topic a task is bound to, so
 * the people who follow that topic see it; anywhere else (top level, a fresh
 * topic per run, follow-active, another chat of a multi-chat task) at the top
 * of the chat the fire ran in, which stays put across fires.
 */
export function claimCardLocation(input: {
  position: 'top-level' | 'topic' | 'new-topic' | 'task';
  task: Pick<ScheduledTask, 'chatId' | 'rootMessageId' | 'followActive'>;
  fireChatId: string;
}): ClaimCardLocation {
  const root = input.task.rootMessageId?.trim();
  if (input.position === 'topic' && root?.startsWith('om_')
    && input.task.followActive !== true && input.fireChatId === input.task.chatId) {
    return { kind: 'thread', rootMessageId: root };
  }
  return { kind: 'chat', chatId: input.fireChatId };
}

export interface ScheduleIdentityClaimDeps {
  getAuthority(appId: string, taskId: string): ScheduleAuthorityRecord | undefined;
  getCard(appId: string, taskId: string): ScheduleClaimCardRecord | undefined;
  putCard(record: Omit<ScheduleClaimCardRecord, 'createdAt' | 'updatedAt'>): void;
  claimRunAs(appId: string, taskId: string, claim: ScheduleRunAsClaim, expectedClaimedAt: string | null): ClaimTaskRunAsResult;
  /** Same entry as `/schedule run`; false when the task is already running. */
  runTaskNow(appId: string, taskId: string): boolean;
  canOperate(appId: string, chatId: string, openId: string, unionId: string): boolean;
  /** Lark-verified operator of a card callback (`resolveCardOperatorUnionId`). */
  resolveOperator(data: CardActionData, appId: string): Promise<{ openId?: string; unionId?: string }>;
  sendCard(appId: string, chatId: string, card: string): Promise<string>;
  replyCard(appId: string, rootMessageId: string, card: string): Promise<string>;
  updateCard(appId: string, messageId: string, card: string): Promise<void>;
  /** The message can no longer be written (past the edit window, withdrawn). */
  isCardGone(error: unknown): boolean;
  governedTools(appId: string): readonly string[];
  locale(appId: string): Locale;
  timeZone(): string;
  now(): Date;
  log: { info(message: string): void; warn(message: string): void };
}

export interface ScheduleIdentityGapInput {
  appId: string;
  task: ScheduledTask;
  /** The scheduled turn that found no identity. */
  turnId: string;
  fireChatId: string;
  location: ClaimCardLocation;
  gap: Extract<ScheduledRunIdentity, { ok: false }>;
}

function cardTask(task: ScheduledTask): ScheduleClaimCardTask {
  return {
    id: task.id,
    name: task.name,
    schedule: task.parsed?.display ?? task.schedule,
    prompt: task.prompt,
  };
}

function rawCard(card: Record<string, unknown>) {
  return { type: 'raw' as const, data: card };
}

export function createScheduleIdentityClaims(deps: ScheduleIdentityClaimDeps) {
  // One fire and one click for the same task must not interleave: both read
  // the card record and may write it, and a fire may be posting a new card.
  const chains = new Map<string, Promise<unknown>>();
  function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    chains.set(key, tail);
    void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    return run;
  }

  function common(appId: string, task: ScheduledTask) {
    return {
      task: cardTask(task),
      tools: deps.governedTools(appId),
      timeZone: deps.timeZone(),
      locale: deps.locale(appId),
    };
  }

  function pendingCard(
    appId: string,
    task: ScheduledTask,
    gap: Extract<ScheduledRunIdentity, { ok: false }>,
    lastFiredAt: string,
  ): Record<string, unknown> {
    const claim = parseScheduleRunAsClaim(task.runAsClaim);
    return buildScheduleIdentityClaimCard({
      state: 'pending',
      ...common(appId, task),
      reason: gap.reason,
      ...(gap.lapsedOpenId ? { lapsedOpenId: gap.lapsedOpenId } : {}),
      ...(claim ? { currentClaimedAt: claim.claimedAt } : {}),
      lastFiredAt,
    });
  }

  function claimedCard(appId: string, task: ScheduledTask, claim: ScheduleRunAsClaim): Record<string, unknown> {
    return buildScheduleIdentityClaimCard({
      state: 'claimed',
      ...common(appId, task),
      claim: { openId: claim.openId, claimedAt: claim.claimedAt },
    });
  }

  function identityOf(appId: string, chatId: string, task: ScheduledTask): ScheduledRunIdentity {
    return resolveScheduledRunIdentity(task, appId,
      (openId, unionId) => deps.canOperate(appId, chatId, openId, unionId));
  }

  /** The card as it should look for the task's current state, used to refresh
   *  a card that was clicked while out of date. */
  function currentCard(appId: string, chatId: string, task: ScheduledTask): Record<string, unknown> {
    const claim = parseScheduleRunAsClaim(task.runAsClaim);
    const identity = identityOf(appId, chatId, task);
    if (claim && identity.ok && identity.source === 'claim') return claimedCard(appId, task, claim);
    const record = deps.getCard(appId, task.id);
    const gap: Extract<ScheduledRunIdentity, { ok: false }> = identity.ok
      ? { ok: false, reason: record?.reason ?? 'no_creator' }
      : identity;
    return pendingCard(appId, task, gap, record?.lastFiredAt ?? task.lastRunAt ?? deps.now().toISOString());
  }

  function toast(appId: string, type: 'success' | 'info' | 'error', key: string, vars?: Record<string, string>) {
    return { type, content: t(key, vars, deps.locale(appId)) };
  }

  function goneResponse(appId: string, taskId: string) {
    return {
      toast: toast(appId, 'info', 'scheduler.claim.toast_gone'),
      card: rawCard(buildScheduleIdentityClaimCard({ state: 'gone', taskId, locale: deps.locale(appId) })),
    };
  }

  /** A scheduled turn of `task` found no usable identity: post the task's card,
   *  or refresh the pending one. A refresh that fails for any reason other than
   *  the card being gone is left for the next fire (no duplicate card); a
   *  failed post rejects, and the caller logs it. */
  function noteIdentityGap(input: ScheduleIdentityGapInput): Promise<void> {
    const { appId, task, turnId } = input;
    if (deps.governedTools(appId).length === 0) return Promise.resolve();
    return serialized(`${appId}:${task.id}`, async () => {
      const record = deps.getCard(appId, task.id);
      if (record?.lastTurnId === turnId) return;
      const firedAt = deps.now().toISOString();
      const card = JSON.stringify(pendingCard(appId, task, input.gap, firedAt));
      // Only a still-pending card is refreshed in place. A card showing a claim
      // whose claimant has since lost access is history; that lapse is news
      // and gets a card of its own.
      if (record?.status === 'pending') {
        try {
          await deps.updateCard(appId, record.messageId, card);
          deps.putCard({
            appId, taskId: task.id, messageId: record.messageId, chatId: record.chatId,
            status: 'pending', reason: input.gap.reason, lastTurnId: turnId, lastFiredAt: firedAt,
          });
          return;
        } catch (error) {
          if (!deps.isCardGone(error)) {
            deps.log.warn(`[schedule-claim] refresh failed task=${task.id} message=${record.messageId}: ${errorText(error)}`);
            return;
          }
        }
      }
      let messageId: string;
      let chatId = input.fireChatId;
      if (input.location.kind === 'thread') {
        try {
          messageId = await deps.replyCard(appId, input.location.rootMessageId, card);
        } catch (error) {
          if (!deps.isCardGone(error)) throw error;
          // The bound topic is gone; the chat is still the task's home.
          messageId = await deps.sendCard(appId, input.fireChatId, card);
        }
      } else {
        chatId = input.location.chatId;
        messageId = await deps.sendCard(appId, chatId, card);
      }
      deps.putCard({
        appId, taskId: task.id, messageId, chatId,
        status: 'pending', reason: input.gap.reason, lastTurnId: turnId, lastFiredAt: firedAt,
      });
      deps.log.info(`[schedule-claim] card posted task=${task.id} chat=${chatId} message=${messageId} reason=${input.gap.reason}`);
    });
  }

  async function handleCardAction(data: CardActionData, appId: string): Promise<any> {
    const value = data.action?.value ?? {};
    const action = value.action;
    const taskId = typeof value.task_id === 'string' && TASK_ID.test(value.task_id) ? value.task_id : undefined;
    if (!taskId || (action !== SCHEDULE_IDENTITY_CLAIM_ACTION
      && action !== SCHEDULE_IDENTITY_RECLAIM_ACTION && action !== SCHEDULE_IDENTITY_RERUN_ACTION)) {
      return { toast: toast(appId, 'error', 'scheduler.claim.toast_unsupported') };
    }
    const expectedClaimedAt = typeof value.claim_rev === 'string' && value.claim_rev ? value.claim_rev : null;
    // Identity comes only from the Lark-verified operator. action.value is
    // round-tripped card content and is never consulted for who clicked.
    const operator = await deps.resolveOperator(data, appId);
    if (!operator.openId || !operator.unionId) {
      return { toast: toast(appId, 'error', 'scheduler.claim.toast_identity_unverified') };
    }
    const { openId, unionId } = operator;
    return serialized(`${appId}:${taskId}`, () => applyCardAction(data, appId, action, taskId, expectedClaimedAt, openId, unionId))
      .catch(error => {
        deps.log.warn(`[schedule-claim] action=${action} task=${taskId} failed: ${errorText(error)}`);
        return { toast: toast(appId, 'error', 'scheduler.claim.toast_failed', { reason: errorText(error) }) };
      });
  }

  async function applyCardAction(
    data: CardActionData,
    appId: string,
    action: string,
    taskId: string,
    expectedClaimedAt: string | null,
    openId: string,
    unionId: string,
  ): Promise<any> {
    const authority = deps.getAuthority(appId, taskId);
    if (!authority || authority.state === 'revoked') return goneResponse(appId, taskId);
    if (authority.kind === 'delegated') return { toast: toast(appId, 'error', 'scheduler.claim.toast_unsupported') };
    const task = authority.task;
    const chatId = typeof data.context?.open_chat_id === 'string' ? data.context.open_chat_id : task.chatId;
    const audit = (outcome: string, extra = '') => deps.log.info(
      `[schedule-claim] action=${action} outcome=${outcome} task=${taskId} chat=${chatId} `
      + `operator_union=${unionId} operator_open=${openId}${extra} at=${deps.now().toISOString()}`,
    );
    if (!deps.canOperate(appId, chatId, openId, unionId)) {
      audit('denied');
      return { toast: toast(appId, 'error', 'scheduler.claim.toast_denied') };
    }
    const current = parseScheduleRunAsClaim(task.runAsClaim);
    if ((current?.claimedAt ?? null) !== expectedClaimedAt) {
      audit('stale');
      return { toast: toast(appId, 'info', 'scheduler.claim.toast_stale'), card: rawCard(currentCard(appId, chatId, task)) };
    }

    if (action === SCHEDULE_IDENTITY_RERUN_ACTION) {
      if (!task.enabled) return { toast: toast(appId, 'error', 'scheduler.claim.toast_rerun_disabled') };
      const queued = deps.runTaskNow(appId, taskId);
      audit(queued ? 'queued' : 'busy', ` run_as_union=${current?.unionId ?? 'none'}`);
      return { toast: queued ? toast(appId, 'success', 'scheduler.claim.toast_rerun_ok') : toast(appId, 'info', 'scheduler.claim.toast_rerun_busy') };
    }

    // A pending card for a task whose creator has meanwhile regained access
    // must not hand the task to someone else: that task has an identity.
    if (!current) {
      const identity = identityOf(appId, chatId, task);
      if (identity.ok) {
        audit('not_needed');
        return { toast: toast(appId, 'info', 'scheduler.claim.toast_stale'), card: rawCard(currentCard(appId, chatId, task)) };
      }
    }
    const claim: ScheduleRunAsClaim = { openId, unionId, larkAppId: appId, claimedAt: deps.now().toISOString() };
    const result = deps.claimRunAs(appId, taskId, claim, expectedClaimedAt);
    if (!result.ok) {
      if (result.error === 'not_found') return goneResponse(appId, taskId);
      const latest = deps.getAuthority(appId, taskId)?.task ?? task;
      audit(result.error);
      return {
        toast: toast(appId, 'info', result.error === 'already_claimant'
          ? 'scheduler.claim.toast_already_claimant' : 'scheduler.claim.toast_stale'),
        card: rawCard(currentCard(appId, chatId, latest)),
      };
    }
    audit('claimed', ` previous_union=${result.previous?.unionId ?? 'none'}`);
    const claimed = claimedCard(appId, result.task, claim);
    const clickedMessageId = data.context?.open_message_id ?? data.open_message_id;
    const record = deps.getCard(appId, taskId);
    const recordMessageId = record?.messageId ?? clickedMessageId;
    if (recordMessageId) {
      deps.putCard({
        appId, taskId, messageId: recordMessageId, chatId: record?.chatId ?? chatId,
        status: 'claimed', ...(record?.reason ? { reason: record.reason } : {}),
        ...(record?.lastTurnId ? { lastTurnId: record.lastTurnId } : {}),
        ...(record?.lastFiredAt ? { lastFiredAt: record.lastFiredAt } : {}),
      });
    }
    const otherCard = record && clickedMessageId && record.messageId !== clickedMessageId
      ? record.messageId : undefined;
    return {
      toast: toast(appId, 'success', current ? 'scheduler.claim.toast_reclaimed' : 'scheduler.claim.toast_claimed'),
      card: rawCard(claimed),
      // The clicked card updates from this response; the task's current card
      // (if a later fire posted a newer one) is patched after the ACK.
      ...(otherCard ? {
        afterAck: () => deps.updateCard(appId, otherCard, JSON.stringify(claimed)).catch(error =>
          deps.log.warn(`[schedule-claim] could not refresh card ${otherCard} for ${taskId}: ${errorText(error)}`)),
      } : {}),
    };
  }

  return { noteIdentityGap, handleCardAction };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
