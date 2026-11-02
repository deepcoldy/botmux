/**
 * The one user-visible notice for an ordinary-turn recovery that ended in
 * failure (retries exhausted, outcome unverifiable, hand-off interrupted …).
 *
 * Why this exists (10-31, oncall session ce4daf6f): the recovery stopped and
 * the group saw nothing for 24 hours. Two independent gaps produced that:
 *
 *  1. the coordinator only advances on the continuation's own terminal — that
 *     terminal was attributed to a synthesised local turn and silenced, so the
 *     state sat in `running` and never reached the exhaustion warning (fixed in
 *     ordinary-turn-recovery.ts: the lost-continuation idle check);
 *  2. every failure notice was fire-once: the Feishu API itself was failing DNS
 *     at the time, and both notices that *were* attempted were dropped after a
 *     single log line. Nothing re-sent them once Feishu came back.
 *
 * This module owns the second half: a notice record persisted on the session
 * (`Session.ordinaryRecoveryNotices`) per logical turn, delivered by a small
 * outbox that retries with backoff until Feishu accepts it (bounded to 24h),
 * survives daemon restarts, and never sends the same turn twice. The record
 * also carries what the card's「重试」button needs: the turn's original input
 * and who sent it.
 *
 * Pure policy + an outbox with injected I/O; the daemon wiring lives in
 * worker-pool.ts and the retry dispatch in core/ordinary-recovery-retry.ts.
 */
import { randomUUID } from 'node:crypto';
import type { TrustedCaller } from '../types.js';
import {
  ordinaryTurnRecoveryCauseCode,
  type OrdinaryTurnRecoveryState,
  type OrdinaryTurnRecoveryStatus,
} from './ordinary-turn-recovery.js';

/** A notice that cannot reach Feishu within this window is abandoned (logged):
 *  a card about a day-old message is noise, not help. Also the cut-off for a
 *  pre-upgrade stuck state whose failure is only detected after deployment. */
export const RECOVERY_NOTICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Delivery retry delays; the last value repeats until the window closes. */
export const RECOVERY_NOTICE_RETRY_DELAYS_MS: readonly number[] = [
  30_000, 60_000, 120_000, 300_000, 600_000,
];

/** Feishu de-duplicates a repeated message `uuid` for one hour only. After a
 *  send whose outcome is unknown (timeout, reset mid-request…) a retry is
 *  safe only inside that window; this margin stays clear of its edge. */
export const RECOVERY_NOTICE_UUID_WINDOW_MS = 55 * 60 * 1000;

/** Send failures that prove the request never reached Feishu: name
 *  resolution, a refused connection, or the local circuit breaker. These may
 *  be retried for the whole delivery window; anything else might have landed. */
export function recoveryNoticeSendNeverLanded(error: unknown): boolean {
  const parts = [
    (error as { code?: unknown })?.code,
    (error as { name?: unknown })?.name,
    error instanceof Error ? error.message : String(error),
  ];
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo|circuit open|CircuitOpen/i.test(parts.join(' '));
}

/** Notice records kept per session (newest win; pending ones are never evicted
 *  in favour of settled ones). */
export const MAX_RECOVERY_NOTICES = 5;

/** Turn-id prefix for a failure-card re-delivery. It deliberately stays inside
 *  the `bmx-recovery-` family so the worker treats it as an ordinary IM turn
 *  (receipt ACK, dedupe, delivery-failure reporting). */
export const RECOVERY_RETRY_TURN_PREFIX = 'bmx-recovery-retry-';

export function isRecoveryRetryTurnId(turnId: string | undefined): turnId is string {
  return !!turnId && turnId.startsWith(RECOVERY_RETRY_TURN_PREFIX);
}

export type RecoveryNoticeDeliveryState = 'pending' | 'delivered' | 'abandoned' | 'skipped';

export interface OrdinaryRecoveryNoticeRecord {
  logicalTurnId: string;
  /** Epoch ms the recovery settled as failed (= notice created). */
  createdAt: number;
  recoveryStatus: OrdinaryTurnRecoveryStatus;
  /** Final recovery error code (may be a `recovery_*` code). */
  errorCode?: string;
  /** The provider failure behind it, when known (e.g. provider_server_error). */
  causeErrorCode?: string;
  continuations: number;
  /** Human who sent the original message — @-mentioned, may press retry. */
  initiatorOpenId?: string;
  /** Short excerpt of the original message, for "which message was this". */
  task?: string;
  /** Re-delivery material. Absent ⇒ the card offers no retry button. */
  retry?: { cliInput: string; trustedCaller: TrustedCaller };
  delivery: {
    state: RecoveryNoticeDeliveryState;
    attempts: number;
    /** Stable Feishu message uuid: a retried send after an unconfirmed one is
     *  de-duplicated by Feishu instead of posting a second card. */
    uuid: string;
    nextAttemptAt?: number;
    deliveredAt?: number;
    messageId?: string;
    lastError?: string;
    /** First failed send whose outcome is unknown (it may have landed). From
     *  then on retries stay inside Feishu's uuid de-duplication window. */
    uncertainSince?: number;
  };
  /** Set once the card's retry button re-delivered the message. */
  retried?: {
    byOpenId: string;
    at: number;
    turnId: string;
    state: 'attempting' | 'accepted';
  };
}

export interface RecoveryNoticeContext {
  now: number;
  /** Human sender of the logical turn, from admission or its reply registry. */
  initiatorOpenId?: string;
  /** Caller to re-deliver as; omitted ⇒ no retry button. */
  retryCaller?: TrustedCaller;
  /** Whether this CLI / turn kind supports the card re-delivery at all. */
  retrySupported: boolean;
  /** Admission time of the logical turn, when known (pre-upgrade fallback). */
  turnAdmittedAt?: number;
  uuid?: () => string;
}

/**
 * Whether a failure detected now is still worth a card. Fresh failures always
 * are. Only a pre-upgrade continuation (no `dispatchedAt`) that the new idle
 * check settles after deployment can be days old — it gets a card only when
 * the original turn is provably recent, never on a guess.
 */
export function recoveryFailureIsStale(
  state: OrdinaryTurnRecoveryState,
  context: { now: number; turnAdmittedAt?: number },
): boolean {
  if (state.continuationsStarted === 0 || state.dispatchedAt !== undefined) return false;
  if (state.status !== 'attention_required' || state.lastErrorCode !== 'recovery_outcome_unverified') return false;
  if (context.turnAdmittedAt === undefined || !Number.isFinite(context.turnAdmittedAt)) return true;
  return context.now - context.turnAdmittedAt > RECOVERY_NOTICE_MAX_AGE_MS;
}

/** Build the persisted notice record for a recovery that just settled failed. */
export function createOrdinaryRecoveryNotice(
  state: OrdinaryTurnRecoveryState,
  context: RecoveryNoticeContext,
): OrdinaryRecoveryNoticeRecord {
  const input = state.retryInputs?.[state.logicalTurnId];
  const causeErrorCode = ordinaryTurnRecoveryCauseCode(state);
  const stale = recoveryFailureIsStale(state, context);
  const task = input ? userMessageExcerpt(input.cliInput) : undefined;
  return {
    logicalTurnId: state.logicalTurnId,
    createdAt: context.now,
    recoveryStatus: state.status,
    ...(state.lastErrorCode ? { errorCode: state.lastErrorCode } : {}),
    ...(causeErrorCode ? { causeErrorCode } : {}),
    continuations: state.continuationsStarted,
    ...(context.initiatorOpenId ? { initiatorOpenId: context.initiatorOpenId } : {}),
    ...(task ? { task } : {}),
    ...(context.retrySupported && input && context.retryCaller
      ? { retry: { cliInput: input.cliInput, trustedCaller: { ...context.retryCaller } } }
      : {}),
    delivery: {
      state: stale ? 'skipped' : 'pending',
      attempts: 0,
      uuid: (context.uuid ?? randomUUID)(),
    },
  };
}

/**
 * Insert a notice unless this logical turn already has one — "one card per
 * turn" is decided here, by the persisted record, so neither a duplicate warn
 * nor a daemon restart can create a second one. Returns the list to persist
 * and whether the record is new.
 */
export function upsertOrdinaryRecoveryNotice(
  list: readonly OrdinaryRecoveryNoticeRecord[] | undefined,
  record: OrdinaryRecoveryNoticeRecord,
): { list: OrdinaryRecoveryNoticeRecord[]; created: boolean } {
  const current = [...(list ?? [])];
  if (current.some(entry => entry.logicalTurnId === record.logicalTurnId)) {
    return { list: current, created: false };
  }
  current.push(record);
  while (current.length > MAX_RECOVERY_NOTICES) {
    const settled = current.findIndex(entry => entry.delivery.state !== 'pending');
    current.splice(settled >= 0 ? settled : 0, 1);
  }
  return { list: current, created: true };
}

export function recoveryNoticeRetryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(attempts - 1, 0), RECOVERY_NOTICE_RETRY_DELAYS_MS.length - 1);
  return RECOVERY_NOTICE_RETRY_DELAYS_MS[index]!;
}

export function recoveryNoticeExpired(record: OrdinaryRecoveryNoticeRecord, now: number): boolean {
  return now - record.createdAt > RECOVERY_NOTICE_MAX_AGE_MS;
}

/** i18n key for the human-readable cause, keyed by the provider error code.
 *  Codes are a closed set of constants (never provider text), so no raw error
 *  message, stack or internal address can reach the card through this. */
export function recoveryCauseI18nKey(code: string | undefined): string {
  if (!code) return 'card.recovery_failed.cause.unknown';
  if (code === 'provider_server_error') return 'card.recovery_failed.cause.provider_unreachable';
  if (code === 'provider_unexpected_eof') return 'card.recovery_failed.cause.provider_disconnected';
  if (code === 'provider_no_model_reply') return 'card.recovery_failed.cause.provider_no_reply';
  if (code === 'provider_rate_limited' || code.endsWith('_limited')) return 'card.recovery_failed.cause.quota';
  if (code === 'provider_authentication_failed' || code === 'provider_permission_denied') {
    return 'card.recovery_failed.cause.provider_auth';
  }
  if (code === 'provider_invalid_request') return 'card.recovery_failed.cause.provider_rejected';
  if (code.includes('capacity')) return 'card.recovery_failed.cause.capacity';
  if (code === 'recovery_outcome_unverified') return 'card.recovery_failed.cause.outcome_unverified';
  if (code === 'recovery_restart_unverified' || code === 'recovery_dispatch_interrupted') {
    return 'card.recovery_failed.cause.restart_interrupted';
  }
  if (code === 'recovery_enqueue_failed' || code === 'recovery_delivery_failed') {
    return 'card.recovery_failed.cause.enqueue_failed';
  }
  if (code === 'recovery_persist_failed') return 'card.recovery_failed.cause.persist_failed';
  if (code === 'recovery_disabled') return 'card.recovery_failed.cause.disabled';
  return 'card.recovery_failed.cause.unknown';
}

/** i18n key for "how far did automatic recovery get". */
export function recoveryOutcomeI18nKey(record: Pick<OrdinaryRecoveryNoticeRecord, 'errorCode' | 'recoveryStatus' | 'continuations'>): string {
  if (record.errorCode === 'recovery_outcome_unverified') return 'card.recovery_failed.outcome.unverified';
  if (record.errorCode === 'recovery_queued_unrecovered') return 'card.recovery_failed.outcome.queued';
  if (record.errorCode === 'recovery_restart_unverified' || record.errorCode === 'recovery_dispatch_interrupted') {
    return 'card.recovery_failed.outcome.interrupted';
  }
  if (record.errorCode === 'recovery_enqueue_failed' || record.errorCode === 'recovery_delivery_failed') {
    return 'card.recovery_failed.outcome.not_submitted';
  }
  if (record.recoveryStatus === 'exhausted') return 'card.recovery_failed.outcome.exhausted';
  return record.continuations > 0
    ? 'card.recovery_failed.outcome.stopped'
    : 'card.recovery_failed.outcome.not_started';
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The user's own words from a botmux CLI envelope (`<user_message>`), for the
 *  card's "which message" line. Falls back to the tag-stripped input. */
export function userMessageExcerpt(cliInput: string, maxChars = 80): string | undefined {
  const blocks = [...cliInput.matchAll(/<user_message\b[^>]*>([\s\S]*?)<\/user_message>/gi)];
  const raw = blocks.length > 0
    ? blocks.map(match => match[1]).join(' ')
    : stripRetryPrefix(cliInput).replace(/<[^>]+>/g, ' ');
  const text = decodeXmlEntities(raw).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** First line of a re-delivered message. Model-facing, like the recovery
 *  prompt: says why the message arrives again and bounds the side-effect risk
 *  (the original turn may have half-run before the outage). */
export const RECOVERY_RETRY_PREFIX = '[BOTMUX_RETRY] 下面这条消息上一轮因外部故障中断，现由发起人或管理员重新投递。'
  + '上一轮可能已经执行了一部分：请先核对会话和工作区现场，尽量避免重复已完成的外部操作；无法判断时停下来请求人工决策。';

function stripRetryPrefix(content: string): string {
  return content.startsWith(RECOVERY_RETRY_PREFIX)
    ? content.slice(RECOVERY_RETRY_PREFIX.length).replace(/^\s+/, '')
    : content;
}

/** The exact content a retry delivers: the original input, prefixed once
 *  (a retry of a retry does not stack prefixes). */
export function buildRecoveryRetryContent(cliInput: string): string {
  return `${RECOVERY_RETRY_PREFIX}\n\n${stripRetryPrefix(cliInput)}`;
}

/** Who sent the logical turn, and the caller a re-delivery runs as. Admission
 *  froze the daemon-authenticated caller; turns without one fall back to the
 *  turn's own reply registry entry, which proves a human only when that sender
 *  is listed as a non-bot participant (the same rule as failedTurnCaller). A
 *  scheduled fire names its run-as identity for the @-mention but offers no
 *  caller (its retry is "run the task again", not a message re-delivery). */
export function recoveryNoticeInitiator(
  state: Pick<OrdinaryTurnRecoveryState, 'logicalTurnId' | 'retryInputs'>,
  context: {
    larkAppId: string;
    replyTarget?: { senderOpenId?: string; participants?: Array<{ openId?: string; isBot?: boolean }> };
  },
): { openId?: string; caller?: TrustedCaller } {
  const caller = state.retryInputs?.[state.logicalTurnId]?.trustedCaller;
  if (caller) {
    const openId = caller.requestUserOpenId;
    // An explicit foreign/bot caller is never replaced by reply metadata.
    if (!openId?.startsWith('ou_') || caller.requestLarkAppId !== context.larkAppId
      || caller.senderType === 'bot') return {};
    if (caller.source === 'schedule_creator') return { openId };
    if (caller.senderType === 'user') {
      const { source: _source, ...human } = caller;
      return { openId, caller: human };
    }
    // senderType absent = unknown: only the reply registry can prove a human.
  }
  const sender = context.replyTarget?.senderOpenId;
  if (sender?.startsWith('ou_')
    && context.replyTarget?.participants?.some(person => person.openId === sender && person.isBot === false)) {
    return { openId: sender, caller: { requestUserOpenId: sender, requestLarkAppId: context.larkAppId, senderType: 'user' } };
  }
  return {};
}

/**
 * The daemon's warn hook for a recovery that settled failed: persist exactly
 * one notice record for the logical turn and start its delivery. A second warn
 * for the same turn (duplicate terminal, restart reconciliation) finds the
 * record and does nothing. Returns the record when a new one was created.
 */
export function recordAndDeliverOrdinaryRecoveryNotice<TTimer>(input: {
  state: OrdinaryTurnRecoveryState;
  context: RecoveryNoticeContext;
  host: RecoveryNoticeHost;
  outbox: RecoveryNoticeOutbox<TTimer>;
  /** Store the new list on the session and persist it. A throw is logged by
   *  the caller's `log`; the record is still delivered from memory. */
  saveList: (list: OrdinaryRecoveryNoticeRecord[]) => void;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}): OrdinaryRecoveryNoticeRecord | undefined {
  const record = createOrdinaryRecoveryNotice(input.state, input.context);
  const { list, created } = upsertOrdinaryRecoveryNotice(input.host.list(), record);
  if (!created) return undefined;
  try {
    input.saveList(list);
  } catch (error) {
    input.log?.('error', `recovery notice ${record.logicalTurnId.slice(0, 16)}: persist failed: ${errorText(error)}`);
  }
  if (record.delivery.state === 'skipped') {
    input.log?.('info', `recovery of ${record.logicalTurnId.slice(0, 16)} settled failed `
      + `(${record.errorCode ?? record.recoveryStatus}) long after the turn; state updated without a card`);
    return record;
  }
  void input.outbox.deliver(input.host, record.logicalTurnId);
  return record;
}

/** Who may press the card's retry button: the original sender (while they may
 *  still talk to the bot) or a bot operator. Everyone else is refused. */
export function recoveryRetryPermitted(input: {
  operatorOpenId: string | undefined;
  initiatorOpenId: string | undefined;
  operatorIsAdmin: boolean;
  operatorCanTalk: boolean;
}): boolean {
  if (!input.operatorOpenId) return false;
  if (input.operatorIsAdmin) return true;
  return input.operatorOpenId === input.initiatorOpenId && input.operatorCanTalk;
}

// ─── Outbox ──────────────────────────────────────────────────────────────────

/** One session's view of its notice records. `update` must re-read the record
 *  from the live session (the session store refreshes nested objects on every
 *  write), apply the mutation, persist, and return the fresh record. */
export interface RecoveryNoticeHost {
  readonly key: string;
  list(): readonly OrdinaryRecoveryNoticeRecord[];
  update(
    logicalTurnId: string,
    mutate: (record: OrdinaryRecoveryNoticeRecord) => void,
  ): OrdinaryRecoveryNoticeRecord | undefined;
  /** Post the card; resolves with the Feishu message id, rejects on failure. */
  send(record: OrdinaryRecoveryNoticeRecord): Promise<string | undefined>;
  /** False while the session cannot post (closed / replaced); the record stays
   *  pending and the next attach resumes it. */
  canDeliver(): boolean;
}

export interface RecoveryNoticeOutboxDeps<TTimer = unknown> {
  schedule: (delayMs: number, run: () => void) => TTimer;
  cancel: (timer: TTimer) => void;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export class RecoveryNoticeOutbox<TTimer = unknown> {
  private readonly timers = new Map<string, TTimer>();
  private readonly inFlight = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: RecoveryNoticeOutboxDeps<TTimer>) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Attempt delivery of one pending record now. */
  deliver(host: RecoveryNoticeHost, logicalTurnId: string): Promise<void> {
    this.clearTimer(host.key, logicalTurnId);
    return this.attempt(host, logicalTurnId);
  }

  /** Re-arm every pending record of a (re)attached session at its persisted
   *  next-attempt time. Delivered / abandoned / skipped records are inert. An
   *  existing timer is replaced so it always runs against the latest host (a
   *  timer armed for a replaced session object would otherwise find it unable
   *  to deliver and stop). */
  resume(host: RecoveryNoticeHost): void {
    for (const record of host.list()) {
      if (record.delivery.state !== 'pending') continue;
      const key = this.keyOf(host.key, record.logicalTurnId);
      if (this.inFlight.has(key)) continue;
      this.clearTimer(host.key, record.logicalTurnId);
      const delayMs = Math.max(0, (record.delivery.nextAttemptAt ?? this.now()) - this.now());
      this.arm(host, record.logicalTurnId, delayMs);
    }
  }

  /** Drop timers of a session (close / dispose). Records stay persisted. */
  disposeHost(hostKey: string): void {
    for (const [key, timer] of this.timers) {
      if (!key.startsWith(`${hostKey}\u0000`)) continue;
      this.deps.cancel(timer);
      this.timers.delete(key);
    }
  }

  private keyOf(hostKey: string, logicalTurnId: string): string {
    return `${hostKey}\u0000${logicalTurnId}`;
  }

  private clearTimer(hostKey: string, logicalTurnId: string): void {
    const key = this.keyOf(hostKey, logicalTurnId);
    const timer = this.timers.get(key);
    if (timer !== undefined) this.deps.cancel(timer);
    this.timers.delete(key);
  }

  private arm(host: RecoveryNoticeHost, logicalTurnId: string, delayMs: number): void {
    const key = this.keyOf(host.key, logicalTurnId);
    this.timers.set(key, this.deps.schedule(delayMs, () => {
      this.timers.delete(key);
      void this.attempt(host, logicalTurnId);
    }));
  }

  private safeUpdate(
    host: RecoveryNoticeHost,
    logicalTurnId: string,
    mutate: (record: OrdinaryRecoveryNoticeRecord) => void,
  ): OrdinaryRecoveryNoticeRecord | undefined {
    try {
      return host.update(logicalTurnId, mutate);
    } catch (error) {
      this.deps.log?.('error', `recovery notice ${logicalTurnId.slice(0, 16)}: persist failed: ${errorText(error)}`);
      return undefined;
    }
  }

  private async attempt(host: RecoveryNoticeHost, logicalTurnId: string): Promise<void> {
    const key = this.keyOf(host.key, logicalTurnId);
    if (this.inFlight.has(key)) return;
    const record = host.list().find(entry => entry.logicalTurnId === logicalTurnId);
    if (!record || record.delivery.state !== 'pending') return;
    const now = this.now();
    if (recoveryNoticeExpired(record, now)) {
      this.safeUpdate(host, logicalTurnId, entry => {
        if (entry.delivery.state === 'pending') entry.delivery.state = 'abandoned';
      });
      this.deps.log?.('warn', `recovery notice ${logicalTurnId.slice(0, 16)} abandoned after `
        + `${record.delivery.attempts} attempt(s): delivery window closed`);
      return;
    }
    const uncertainSince = record.delivery.uncertainSince;
    if (uncertainSince !== undefined && now - uncertainSince > RECOVERY_NOTICE_UUID_WINDOW_MS) {
      // A retry now could post a second card next to one that already landed.
      this.safeUpdate(host, logicalTurnId, entry => {
        if (entry.delivery.state === 'pending') entry.delivery.state = 'abandoned';
      });
      this.deps.log?.('warn', `recovery notice ${logicalTurnId.slice(0, 16)} abandoned after `
        + `${record.delivery.attempts} attempt(s): an earlier send may have landed and Feishu's `
        + 'de-duplication window has closed');
      return;
    }
    if (!host.canDeliver()) return;
    this.inFlight.add(key);
    try {
      let messageId: string | undefined;
      try {
        messageId = await host.send(record);
      } catch (error) {
        const failedAt = this.now();
        const uncertain = !recoveryNoticeSendNeverLanded(error);
        const planDelay = (attempts: number, since: number | undefined): number => {
          const delay = recoveryNoticeRetryDelayMs(attempts);
          // Keep one last try inside the de-duplication window.
          if (since === undefined) return delay;
          const windowLeft = since + RECOVERY_NOTICE_UUID_WINDOW_MS - failedAt;
          return windowLeft > 0 ? Math.min(delay, windowLeft) : delay;
        };
        let delayMs = 0;
        this.safeUpdate(host, logicalTurnId, entry => {
          if (entry.delivery.state !== 'pending') return;
          entry.delivery.attempts += 1;
          entry.delivery.lastError = errorText(error);
          if (uncertain && entry.delivery.uncertainSince === undefined) entry.delivery.uncertainSince = failedAt;
          delayMs = planDelay(entry.delivery.attempts, entry.delivery.uncertainSince);
          entry.delivery.nextAttemptAt = failedAt + delayMs;
        });
        if (delayMs === 0) {
          delayMs = planDelay(record.delivery.attempts + 1, record.delivery.uncertainSince ?? (uncertain ? failedAt : undefined));
        }
        this.deps.log?.('warn', `recovery notice ${logicalTurnId.slice(0, 16)} not delivered `
          + `(${errorText(error)}); retrying in ${Math.round(delayMs / 1000)}s`);
        this.arm(host, logicalTurnId, delayMs);
        return;
      }
      const deliveredAt = this.now();
      this.safeUpdate(host, logicalTurnId, entry => {
        entry.delivery.state = 'delivered';
        entry.delivery.attempts += 1;
        entry.delivery.deliveredAt = deliveredAt;
        entry.delivery.nextAttemptAt = undefined;
        entry.delivery.lastError = undefined;
        if (messageId) entry.delivery.messageId = messageId;
      });
      this.deps.log?.('info', `recovery notice ${logicalTurnId.slice(0, 16)} delivered`);
    } finally {
      this.inFlight.delete(key);
    }
  }
}
