import { attachOncallGroupButton, prepareNativeOncallCard, recordOncallGroupDelivery } from '../im/lark/oncall-group.js';
import { OncallGroupStore } from '../services/oncall-group-store.js';
import { join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { config } from '../config.js';
import { sandboxEnabled } from '../adapters/backend/sandbox.js';
import { sandboxBoolValue } from '../adapters/cli/sandbox-mode.js';
import { getBot } from '../bot-registry.js';
import { handleCotThinkingUpdate, finalizeCotMessage, hasCotMessageForTurn, prepareCotMessageBeforeReply } from '../im/lark/cot-message.js';
import { normalizeUsageDisplay } from '../bot-registry.js';
import { getSessionUsageSnapshot } from './cost-calculator.js';
import { withCardRuntimeIdentity } from './card-runtime-identity.js';
import { controllerForSession } from './session-controller.js';
import { resolvePricingConfig } from '../services/model-pricing.js';
import { localeForBot, t as tr } from '../i18n/index.js';
import { LocalAddressOutboundError, prepareLocalAddressContent, sanitizeLocalAddressText } from '../im/lark/local-address-policy.js';
import { localAddressContextForBot, replayVettedBody } from '../im/lark/local-address-context.js';
import { isLarkContentAuditError } from '../im/lark/content-audit.js';
import { sendWithContentAuditRedaction } from '../im/lark/content-audit-redaction.js';
import { logger } from '../utils/logger.js';
import { getAskSnapshot, invalidateReplyCardAsks } from './ask-broker.js';
import { getSession } from '../services/session-store.js';
import { MessageWithdrawnError, uploadFile, replyMessage, sendMessage } from '../im/lark/client.js';
import { observeAcknowledgedGroupPublication, patchPublishedGroupCard, readGroupContextAuthorOrigin } from '../services/group-context-publication.js';
import { buildTurnReplyCard, publicReplyCardActivity, publicReplyCardTools, replyCardPresentation } from '../im/lark/turn-reply-card.js';
import {
  normalizeReplyCardMode, replyCardIsTerminal, supportsUnifiedReplyCardCli, TurnReplyCardStore,
  type TurnReplyCardMode, type TurnReplyCardEvent, type TurnReplyCardKey,
} from '../services/turn-reply-card.js';
import { isSubstituteTurn } from './reply-target.js';
import { isSilentScheduledTurn } from './silent-schedule-turns.js';
import { privateReplyEnabled } from './private-reply.js';
import type { TurnResult, TurnDeliveryReceipt } from '../services/turn-result.js';
import { isDocNativeSession, larkTransportEnabled, sessionAnchorId, type DaemonSession } from './types.js';

/** Every native write, including overflow files, retains the record owner's gate. */
export type ReplyCardSender = (
  content: string, msgType: string, uuid: string, beforeWrite: () => void | Promise<void>,
) => Promise<string>;
const modes = new WeakMap<DaemonSession, Map<string, TurnReplyCardMode>>();
const processStartedAtMs = Date.now();

export function replyCardKey(ds: DaemonSession, turnId: string, dispatchAttempt?: number): TurnReplyCardKey {
  return { larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId, dispatchAttempt };
}

/** Shared by turn delivery and Ask admission; never reads or creates card records. */
export function replyCardSandboxBlocked(ds: DaemonSession): boolean {
  let cfg;
  try { cfg = getBot(ds.larkAppId).config; } catch { return true; }
  // The shared record directory (including lock/overflow files) is deliberately
  // outside the sandbox allow-list. Check before cached or persisted modes;
  // otherwise the daemon creates a card the sandboxed sender cannot update.
  // Live workers keep their frozen isolation state when bot settings change.
  // Tri-state with FROZEN PRECEDENCE preserved (the ?? chain): an explicit
  // false/'off' on the session or initConfig means this session was created
  // unsandboxed and must not retroactively block when the live bot toggle is
  // later turned on. Only when no frozen value exists do we fall back to the
  // live cfg. sandboxBoolValue accepts 'scratch' as well as oncall/true.
  const frozenSandbox = ds.session.sandbox ?? ds.initConfig?.sandbox ?? cfg.sandbox;
  return sandboxBoolValue(frozenSandbox)
    || sandboxBoolValue(ds.initConfig?.sandbox)
    || (ds.initConfig?.readIsolation ?? cfg.readIsolation) === true
    || sandboxEnabled();
}

/** Freeze display mode per accepted turn. Unsupported entry points keep their
 * established delivery contract, including sandbox, API-only, v3, adoption and VC. */
export function replyCardModeFor(ds: DaemonSession, turnId = ds.currentTurnId): TurnReplyCardMode {
  if (!turnId || privateReplyEnabled(ds.session) || replyCardSandboxBlocked(ds)) return 'legacy';
  let snapshot = modes.get(ds);
  if (!snapshot) { snapshot = new Map(); modes.set(ds, snapshot); }
  const prior = snapshot.get(turnId);
  if (prior) return prior;
  let cfg;
  try { cfg = getBot(ds.larkAppId).config; } catch { return 'legacy'; }
  const cli = ds.session.cliLaunchSnapshot?.cliId ?? ds.session.cliId ?? cfg.cliId;
  const existing = new TurnReplyCardStore(config.session.dataDir).read(replyCardKey(ds, turnId));
  let mode: TurnReplyCardMode = existing?.mode ?? normalizeReplyCardMode(cfg.replyCardMode);
  if (!turnId.startsWith('om_') || !ds.chatId.startsWith('oc_') || !supportsUnifiedReplyCardCli(cli)
    || !larkTransportEnabled({ chatId: ds.chatId, apiOnly: cfg.apiOnly })
    || isDocNativeSession(ds) || ds.session.vcMeetingReceiver || ds.session.deferredScheduleRun
    || ds.adoptedFrom || ds.session.adoptedFrom || ds.session.headless
    || ['riff', 'mojo'].includes(ds.session.backendType ?? ds.initConfig?.backendType ?? '')
    || isSubstituteTurn(ds, turnId) || isSilentScheduledTurn(ds, turnId)
    || ds.docCommentTurns?.has(turnId)) {
    mode = 'legacy';
  }
  if (mode !== 'legacy') {
    const record = new TurnReplyCardStore(config.session.dataDir).prepareSync(replyCardKey(ds, turnId), {
      mode, chatId: ds.chatId, rootId: sessionAnchorId(ds),
      nativeCot: cfg.replyCardNativeCot === true && (ds.cotForced === true || !cfg.noCotChats?.includes(ds.chatId)),
    });
    mode = record.mode;
  }
  snapshot.set(turnId, mode);
  if (snapshot.size > 512) snapshot.delete(snapshot.keys().next().value!);
  return mode;
}

/** Admission fixes the channel order. Enabling native CoT after an answer is
 * already visible applies next turn, instead of inserting thinking below it. */
function nativeThinkingOwner(ds: DaemonSession, owns?: () => boolean): () => boolean {
  const session = ds.session;
  const worker = ds.worker;
  const generation = ds.workerGeneration;
  const controller = controllerForSession(ds);
  const currentRuntime = () => controller?.currentRuntime() ?? session.sessionRuntimeContract?.session.activeRuntime;
  const runtime = currentRuntime();
  return () => ds.session === session && ds.worker === worker && ds.workerGeneration === generation
    && session.status !== 'closed'
    && currentRuntime()?.runtimeId === runtime?.runtimeId
    && currentRuntime()?.epoch === runtime?.epoch
    && owns?.() !== false;
}

export function updateReplyCardNativeThinking(ds: DaemonSession, msg: ToolsUpdate, owns?: () => boolean): void {
  const record = new TurnReplyCardStore(config.session.dataDir).read(replyCardKey(ds, msg.turnId, msg.dispatchAttempt))
    ?? new TurnReplyCardStore(config.session.dataDir).read(replyCardKey(ds, msg.turnId));
  if (record?.nativeCot && ((!record.nativeCotReady && !record.messageId) || hasCotMessageForTurn(ds, msg))) {
    handleCotThinkingUpdate(ds, { type: 'thinking_update', ...msg }, record.mode, nativeThinkingOwner(ds, owns));
  }
}

export function replyCardDispatchAttempt(ds: DaemonSession, turnId: string): number | undefined {
  if (ds.managedTurnOrigin?.turnId === turnId) return ds.managedTurnOrigin.dispatchAttempt;
  if (ds.turnDispatchAttemptHighWater?.turnId === turnId) return ds.turnDispatchAttemptHighWater.dispatchAttempt;
  if (ds.session.readonlyTaskContinuation?.currentTurnId === turnId) return ds.session.readonlyTaskContinuation.currentDispatchAttempt;
  return ds.lastThinkingUpdate?.turnId === turnId ? ds.lastThinkingUpdate.dispatchAttempt : undefined;
}

export async function prepareReplyCardNativeThinking(ds: DaemonSession, turnId: string, dispatchAttempt?: number, owns?: () => boolean): Promise<void> {
  const store = new TurnReplyCardStore(config.session.dataDir);
  const record = store.read(replyCardKey(ds, turnId, dispatchAttempt)) ?? store.read(replyCardKey(ds, turnId));
  const binding = { turnId, dispatchAttempt: dispatchAttempt ?? replyCardDispatchAttempt(ds, turnId) };
  if (record?.nativeCot && ((!record.nativeCotReady && !record.messageId) || hasCotMessageForTurn(ds, binding))) {
    await prepareCotMessageBeforeReply(ds, binding, nativeThinkingOwner(ds, owns));
  }
}

/**
 * 统一回复卡片的所有 PATCH 都走这里：卡片里一旦写进最终回复，之后每次重绘（终态、
 * 恢复、提问）都会再带上原文，被内容安全审计拒收时同样打码副本重发一次。
 */
export function patchReplyCardWithAuditRedaction(
  larkAppId: string, card: string, label: string, patch: (body: string) => Promise<void>,
): Promise<void> {
  return sendWithContentAuditRedaction({
    content: card, msgType: 'interactive', send: patch,
    note: tr('worker.final_output_content_audit_redacted_note', undefined, localeForBot(larkAppId)),
    log: line => logger.warn(`[reply-card] patch ${label} ${line}`),
  });
}

export async function updateTurnReplyCard(
  ds: DaemonSession, turnId: string, event: TurnReplyCardEvent, send: ReplyCardSender,
  options: {
    dispatchAttempt?: number; owns?: () => boolean; forceVisible?: boolean;
    onPublication?: (publication: {
      output: TurnResult['output'];
      receipt: Pick<TurnDeliveryReceipt, 'status' | 'messages' | 'reason'>;
    }) => void;
  } = {},
) {
  const mode = replyCardModeFor(ds, turnId);
  if (mode === 'legacy') return undefined;
  const key = replyCardKey(ds, turnId, options.dispatchAttempt);
  const acknowledged = new Map<string, 'primary' | 'attachment'>();
  const publication = (output: TurnResult['output'], status: TurnDeliveryReceipt['status'], reason?: string): void => {
    if (event.kind !== 'final') return;
    try {
      options.onPublication?.({
        output,
        receipt: { status, messages: [...acknowledged].map(([messageId, kind]) => ({ messageId, kind }))
          .sort((first, second) => first.kind === second.kind ? 0 : first.kind === 'primary' ? -1 : 1),
          ...(reason ? { reason } : {}) },
      });
    } catch {}
  };
  const store = new TurnReplyCardStore(config.session.dataDir);
  const session = ds.session;
  const chatId = ds.chatId;
  const anchor = sessionAnchorId(ds);
  const beforeEffect = () => {
    if (ds.session !== session || session.status === 'closed' || options.owns?.() === false
      || ds.larkAppId !== key.larkAppId || ds.session.sessionId !== key.sessionId
      || ds.chatId !== chatId || sessionAnchorId(ds) !== anchor
      || getBot(ds.larkAppId).config.apiOnly || isSilentScheduledTurn(ds, turnId)) {
      throw new Error('Reply-card turn no longer owns delivery');
    }
  };
  beforeEffect();
  if (event.kind === 'display_retired' || (event.kind === 'terminal' && !event.disconnected)) invalidateReplyCardAsks(key, 'Turn finished');
  await store.prepare(key, { mode, chatId: ds.chatId, rootId: sessionAnchorId(ds),
    nativeCot: store.read(replyCardKey(ds, turnId))?.nativeCot });
  const cfg = getBot(ds.larkAppId).config;
  const oncallEnabled = ds.chatType !== 'p2p' && ((cfg.oncallGroup?.enabled === true && cfg.oncallGroup.chatIds.includes(ds.chatId))
    || new OncallGroupStore(config.session.dataDir).getRequest({ appId: ds.larkAppId, sessionId: session.sessionId,
      chatId: ds.chatId, messageId: '', questionId: turnId, answer: '' })?.status === 'succeeded');
  const oncallTurn = oncallEnabled ? new OncallGroupStore(config.session.dataDir).registerTurn(ds.larkAppId, session.sessionId, turnId, { chatId: ds.chatId, rootId: anchor }) : undefined;
  const nativeOncallLink = oncallEnabled ? await prepareNativeOncallCard(ds.larkAppId, ds.chatId, turnId, session.sessionId) : undefined;
  const indexOncall = (messageId: string, body: string) => {
    if (!oncallEnabled || !messageId) return;
    recordOncallGroupDelivery(config.session.dataDir, { appId: ds.larkAppId, chatId: ds.chatId, messageId,
      sessionId: session.sessionId, rootId: sessionAnchorId(ds), questionId: turnId, turnNumber: oncallTurn, dispatchAttempt: key.dispatchAttempt,
      answer: event.kind === 'final' ? event.text : '', card: JSON.parse(body), nativeLink: nativeOncallLink });
  };
  const groupContextAuthorOrigin = event.kind === 'final' ? readGroupContextAuthorOrigin({
    appId: ds.larkAppId, chatId: ds.chatId, sessionId: session.sessionId, turnId,
    nativeSessionId: session.cliSessionId, cliId: session.cliLaunchSnapshot?.cliId ?? session.cliId ?? cfg.cliId,
    workerGeneration: session.workerGeneration,
  }) : undefined;
  let usage;
  if (normalizeUsageDisplay(cfg) === 'streaming') {
    try {
      usage = getSessionUsageSnapshot({
        cliId: ds.session.cliLaunchSnapshot?.cliId ?? ds.session.cliId ?? cfg.cliId, sessionId: ds.session.sessionId,
        cliSessionId: ds.session.cliSessionId, cwd: ds.workingDir ?? ds.session.workingDir,
        larkAppId: ds.larkAppId, fresh: event.kind === 'final' || event.kind === 'terminal',
        pricing: resolvePricingConfig(cfg.pricing),
      });
    } catch { /* missing native usage is omitted */ }
  }
  const transport = {
    usage: withCardRuntimeIdentity(ds, usage ?? { context: null, tokens: null }, ds.session.cliId ?? cfg.cliId),
    beforeEffect,
    beforeCreate: () => prepareReplyCardNativeThinking(ds, turnId, options.dispatchAttempt, options.owns),
    send: async (body, uuid) => {
      body = prepareLocalAddressContent(body, 'interactive', localAddressContextForBot(ds.larkAppId, ds.workingDir ?? ds.session.workingDir));
      const messageId = await send(body, 'interactive', uuid, beforeEffect);
      if (messageId) { acknowledged.set(messageId, 'primary'); indexOncall(messageId, body); }
      if (messageId && groupContextAuthorOrigin) await observeAcknowledgedGroupPublication(ds.larkAppId, {
        message_id: messageId, chat_id: ds.chatId, root_id: sessionAnchorId(ds), msg_type: 'interactive', body: { content: body },
      }, groupContextAuthorOrigin);
      return messageId;
    },
    patch: async (messageId, card) => {
      card = prepareLocalAddressContent(card, 'interactive', localAddressContextForBot(ds.larkAppId, ds.workingDir ?? ds.session.workingDir));
      await patchReplyCardWithAuditRedaction(ds.larkAppId, card, `${event.kind} turn=${turnId.substring(0, 8)}`,
        body => patchPublishedGroupCard(ds.larkAppId, ds.chatId, messageId, body, sessionAnchorId(ds),
          groupContextAuthorOrigin, beforeEffect));
      acknowledged.set(messageId, 'primary'); indexOncall(messageId, card);
    },
    isWithdrawn: error => error instanceof MessageWithdrawnError,
    forceVisible: options.forceVisible || ds.cotForced,
    render: (record: import('../services/turn-reply-card.js').TurnReplyCardRecord) => {
      const cfg = getBot(ds.larkAppId).config;
      const presentation = replyCardPresentation(cfg, ds.chatId);
      const raw = buildTurnReplyCard(record, {
        ...presentation, locale: localeForBot(ds.larkAppId), workingDir: ds.workingDir,
        showProcess: options.forceVisible || ds.cotForced || presentation.showProcess,
        showLiveUsage: normalizeUsageDisplay(cfg) === 'streaming',
        canStop: presentation.canStop && ds.initConfig?.codexRpcInput !== true,
      });
      return prepareLocalAddressContent(attachOncallGroupButton(raw, cfg.oncallGroup, ds.chatId, ds.chatType, {
        appId: ds.larkAppId, sessionId: session.sessionId, questionId: turnId,
        phase: record.finalCard || replyCardIsTerminal(record) ? 'final' : 'first', nativeLink: nativeOncallLink, messageId: record.messageId,
      }), 'interactive', localAddressContextForBot(ds.larkAppId, ds.workingDir ?? ds.session.workingDir));
    },
    sendOverflow: async (text: string, uuid: string) => {
      text = sanitizeLocalAddressText(text, localAddressContextForBot(ds.larkAppId, ds.workingDir ?? ds.session.workingDir));
      const file = join(store.directory, `${store.id(key)}-reply.md`);
      atomicWriteFileSync(file, text, { mode: 0o600, followTargetSymlink: false });
      const fileKey = await uploadFile(ds.larkAppId, file);
      beforeEffect();
      beforeEffect();
      const content = JSON.stringify({ file_key: fileKey });
      const messageId = await send(content, 'file', uuid, beforeEffect);
      if (messageId) acknowledged.set(messageId, 'attachment');
      if (messageId && groupContextAuthorOrigin) await observeAcknowledgedGroupPublication(ds.larkAppId, {
        message_id: messageId, chat_id: ds.chatId, root_id: sessionAnchorId(ds), msg_type: 'file', body: { content },
      }, groupContextAuthorOrigin);
      return messageId;
    },
  } satisfies import('../services/turn-reply-card.js').TurnReplyCardTransport;
  for (let attempt = 0; ; attempt++) {
    try {
      const delivered = await store.update(key, event, transport);
      const complete = event.kind === 'final' && event.source === 'bridge'
        && delivered.record.finalSource === 'bridge' && delivered.record.finalText === event.text
        && delivered.record.finalDelivered && !!delivered.messageId
        && acknowledged.get(delivered.messageId) === 'primary'
        && (!delivered.record.overflowMessageId || acknowledged.get(delivered.record.overflowMessageId) === 'attachment');
      if (complete) {
        publication({
          status: 'available', format: 'markdown', content: delivered.record.finalText!,
          source: 'transcript',
        }, 'delivered');
      } else {
        const reason = delivered.record.finalSource === 'explicit' ? 'explicit_publication_unproven' : 'publication_unproven';
        publication({ status: 'unavailable', reason },
          acknowledged.size ? 'partial' : 'unknown', reason);
      }
      return delivered;
    }
    catch (error) {
      publication({ status: 'unavailable', reason: 'delivery_unknown' },
        acknowledged.size ? 'partial' : 'unknown', 'delivery_unknown');
      // 内容安全审计拒收和本机跳转地址拒发都是确定性的（打码重发已在 transport 里做过一次），原样重试无用。
      if (attempt >= 2 || error instanceof MessageWithdrawnError || isLarkContentAuditError(error)
        || error instanceof LocalAddressOutboundError || store.read(key)?.withdrawn) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 800 : 2000));
      beforeEffect();
    }
  }
}

type ToolsUpdate = { turnId: string; dispatchAttempt?: number; entries: import('../types.js').CotEntry[] };
type PendingTools = { msg: ToolsUpdate; send: ReplyCardSender; owns: () => boolean; timer?: ReturnType<typeof setTimeout> };
const pendingTools = new WeakMap<DaemonSession, Map<string, PendingTools>>();
const toolFlushes = new WeakMap<DaemonSession, Map<string, Promise<void>>>();

export function queueTurnReplyTools(ds: DaemonSession, msg: ToolsUpdate, send: ReplyCardSender, owns: () => boolean): void {
  let pending = pendingTools.get(ds);
  if (!pending) { pending = new Map(); pendingTools.set(ds, pending); }
  const key = `${msg.turnId}:${msg.dispatchAttempt ?? ''}`;
  const existing = pending.get(key);
  if (existing) {
    existing.msg = msg;
    existing.send = send;
    existing.owns = owns;
    return;
  }
  const next: PendingTools = { msg, send, owns };
  pending.set(key, next);
  next.timer = setTimeout(() => {
    void flushTurnReplyTools(ds, msg.turnId, msg.dispatchAttempt).catch(error => {
      logger.warn(`[reply-card] tool update failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 1200);
  next.timer.unref();
}

export async function flushTurnReplyTools(ds: DaemonSession, turnId: string, dispatchAttempt?: number): Promise<void> {
  const key = `${turnId}:${dispatchAttempt ?? ''}`;
  const inflight = toolFlushes.get(ds)?.get(key);
  // The previous publisher reports its own error. A replacement worker's
  // pending snapshot must still flush when that older publisher loses ownership.
  if (inflight) await inflight.catch(() => undefined);
  const pending = pendingTools.get(ds);
  const next = pending?.get(key);
  if (!next) return;
  clearTimeout(next.timer);
  pending!.delete(key);
  const cfg = getBot(ds.larkAppId).config;
  const visible = ds.cotForced || replyCardPresentation(cfg, ds.chatId).showProcess;
  const work = updateTurnReplyCard(ds, turnId, {
    kind: 'tools', tools: visible ? publicReplyCardTools(next.msg.entries, cfg.thinkingCardToolResult !== false) : [],
    activity: visible ? publicReplyCardActivity(next.msg.entries) : [],
  }, next.send, { dispatchAttempt, owns: next.owns }).then(() => undefined);
  let running = toolFlushes.get(ds);
  if (!running) { running = new Map(); toolFlushes.set(ds, running); }
  running.set(key, work);
  try { await work; } finally { if (running.get(key) === work) running.delete(key); }
}

/** UI retirement never asserts native task failure or changes task settlement. */
export async function retireReplyCardDisplay(
  ds: DaemonSession, msg: { turnId: string; dispatchAttempt?: number; message: string },
  send: ReplyCardSender, owns: () => boolean,
): Promise<boolean> {
  if (replyCardModeFor(ds, msg.turnId) === 'legacy') {
    finalizeCotMessage(ds, msg.turnId, 'ambiguous', msg.dispatchAttempt);
    return false;
  }
  try {
    if (ds.replyCardRunningTurnId === msg.turnId) ds.replyCardRunningTurnId = undefined;
    await flushTurnReplyTools(ds, msg.turnId, msg.dispatchAttempt).catch(error => {
      // A failed cosmetic PATCH must not prevent persisting the terminal notice.
      logger.warn(`[reply-card] retirement tool flush: ${error.message}`);
    });
    const retired = await updateTurnReplyCard(ds, msg.turnId, { kind: 'display_retired', notice: msg.message }, send,
      { dispatchAttempt: msg.dispatchAttempt, owns });
    return retired !== undefined;
  } finally {
    const record = new TurnReplyCardStore(config.session.dataDir).read(replyCardKey(ds, msg.turnId, msg.dispatchAttempt));
    finalizeCotMessage(ds, msg.turnId, record?.finalDelivered && record.phase === 'completed' ? 'completed' : 'ambiguous', msg.dispatchAttempt);
  }
}

/** A confirmed merged input retires the old display, not the native task.
 * Only an already-admitted exact attempt may own a reply card here. */
export async function supersedeTurnReplyCard(
  ds: DaemonSession, msg: Pick<ToolsUpdate, 'turnId' | 'dispatchAttempt'>, send: ReplyCardSender, owns: () => boolean,
): Promise<void> {
  const store = new TurnReplyCardStore(config.session.dataDir);
  const record = store.read(replyCardKey(ds, msg.turnId, msg.dispatchAttempt));
  if (!record) return;
  // Flush an existing display before closing it. For an unshown turn, settle
  // first so buffered activity cannot create an otherwise empty old card.
  if (record.messageId || record.pendingCreate) {
    await flushTurnReplyTools(ds, msg.turnId, msg.dispatchAttempt).catch(error => {
      logger.warn(`[reply-card] superseded tool flush: ${error.message}`);
    });
  }
  const now = Date.now();
  await updateTurnReplyCard(ds, msg.turnId, {
    kind: 'terminal', phase: 'superseded', completedAtMs: now,
    ...(record.startedAtMs !== undefined ? { durationMs: Math.max(0, now - record.startedAtMs) } : {}),
  }, send, { dispatchAttempt: msg.dispatchAttempt, owns });
  if (owns() && ds.replyCardRunningTurnId === msg.turnId) ds.replyCardRunningTurnId = undefined;
}

/** A disconnected worker does not prove a surviving tmux task completed.
 * Close the visible activity indicator with an honest unknown state, without
 * creating a message in a quiet/recovered session. */
export async function settleTurnReplyCards(ds: DaemonSession): Promise<void> {
  const store = new TurnReplyCardStore(config.session.dataDir);
  for (const [turnId, mode] of modes.get(ds) ?? []) {
    if (mode === 'legacy') continue;
    const record = store.read(replyCardKey(ds, turnId));
    if (!record?.messageId || replyCardIsTerminal(record)) continue;
    await settleDisconnectedReplyCard(store, record, undefined, ds.workingDir ?? ds.session.workingDir);
  }
  ds.replyCardRunningTurnId = undefined;
}

async function settleDisconnectedReplyCard(store: TurnReplyCardStore, record: import('../services/turn-reply-card.js').TurnReplyCardRecord, beforeMs?: number, workingDir?: string): Promise<void> {
  // Resumable asks have already been restored by the broker at startup.
  const orphanAskIds = (record.asks ?? []).filter(entry => !entry.result && !getAskSnapshot(entry.ask.askId))
    .map(entry => entry.ask.askId);
  const beforeEffect = () => {
    if (getBot(record.larkAppId).config.apiOnly) throw new Error('Reply-card transport disabled');
  };
  // The record keeps the agent's raw text; a re-render is model output entering again.
  const localContext = localAddressContextForBot(record.larkAppId, workingDir);
  await store.update(record, { kind: 'recover', beforeMs, orphanAskIds }, {
    beforeEffect,
    send: async () => { throw new Error('Recovery may only update an existing reply card'); },
    // The persisted pendingPatch was vetted before this restart.
    patch: (id, card) => replayVettedBody(card, 'interactive', () => patchReplyCardWithAuditRedaction(record.larkAppId, card,
      `recover turn=${record.turnId.substring(0, 8)}`, body => patchPublishedGroupCard(record.larkAppId, record.chatId, id, body, record.rootId))),
    sendOverflow: async (text, uuid) => {
      text = sanitizeLocalAddressText(text, localContext);
      const file = join(store.directory, `${store.id(record)}-reply.md`);
      atomicWriteFileSync(file, text, { mode: 0o600, followTargetSymlink: false });
      beforeEffect();
      const fileKey = await uploadFile(record.larkAppId, file);
      beforeEffect();
      const content = JSON.stringify({ file_key: fileKey });
      return record.rootId && record.rootId !== record.chatId
        ? replyMessage(record.larkAppId, record.rootId, content, 'file', true, uuid, undefined, { beforeWrite: beforeEffect })
        : sendMessage(record.larkAppId, record.chatId, content, 'file', uuid, undefined, { beforeWrite: beforeEffect });
    },
    isWithdrawn: error => error instanceof MessageWithdrawnError,
    render: state => prepareLocalAddressContent(buildTurnReplyCard(state, {
      ...replyCardPresentation(getBot(record.larkAppId).config, record.chatId),
      locale: localeForBot(record.larkAppId), canStop: false,
    }), 'interactive', localContext),
  });
}

/** Like the CoT orphan sweep: recover only this bot's previously visible cards. */
/** Without the session row a re-render loses only workspace-relative paths;
 * the policy still replaces paths under known roots. */
function sessionWorkingDir(sessionId: string): string | undefined {
  try { return getSession(sessionId)?.workingDir; } catch { return undefined; }
}

export async function sweepInterruptedReplyCards(larkAppId: string): Promise<void> {
  const store = new TurnReplyCardStore(config.session.dataDir);
  if (!existsSync(store.directory)) return;
  for (const file of readdirSync(store.directory)) {
    if (!/^[0-9a-f]{32}\.json$/.test(file)) continue;
    try {
      const key = JSON.parse(readFileSync(join(store.directory, file), 'utf8')) as TurnReplyCardKey;
      if (key.larkAppId !== larkAppId) continue;
      const record = store.read(key);
      if (!record?.messageId || (record.updatedAtMs ?? record.createdAtMs) >= processStartedAtMs || record.withdrawn
        || (replyCardIsTerminal(record) && record.phase !== 'ambiguous' && !record.pendingPatch && !record.publishPending)) continue;
      await settleDisconnectedReplyCard(store, record, processStartedAtMs, sessionWorkingDir(record.sessionId));
    } catch (error) {
      logger.warn(`[reply-card] recovery: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
