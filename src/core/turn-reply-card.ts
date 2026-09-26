import { join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { config } from '../config.js';
import { sandboxEnabled } from '../adapters/backend/sandbox.js';
import { getBot } from '../bot-registry.js';
import { normalizeUsageDisplay } from '../bot-registry.js';
import { getSessionUsageSnapshot } from './cost-calculator.js';
import { resolvePricingConfig } from '../services/model-pricing.js';
import { localeForBot } from '../i18n/index.js';
import { logger } from '../utils/logger.js';
import { getAskSnapshot, invalidateReplyCardAsks } from './ask-broker.js';
import { MessageWithdrawnError, updateMessage, uploadFile } from '../im/lark/client.js';
import { buildTurnReplyCard, publicReplyCardActivity, publicReplyCardTools, replyCardPresentation } from '../im/lark/turn-reply-card.js';
import {
  normalizeReplyCardMode, TurnReplyCardStore,
  type TurnReplyCardMode, type TurnReplyCardEvent, type TurnReplyCardKey,
} from '../services/turn-reply-card.js';
import { isSubstituteTurn } from './reply-target.js';
import { isSilentScheduledTurn } from './silent-schedule-turns.js';
import { privateReplyEnabled } from './private-reply.js';
import { isDocNativeSession, larkTransportEnabled, sessionAnchorId, type DaemonSession } from './types.js';

export type ReplyCardSender = (content: string, msgType: string, uuid: string) => Promise<string>;
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
  return (ds.session.sandbox ?? ds.initConfig?.sandbox ?? cfg.sandbox) === true
    || ds.initConfig?.sandbox === true
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
  const cli = ds.session.cliId ?? cfg.cliId;
  const existing = new TurnReplyCardStore(config.session.dataDir).read(replyCardKey(ds, turnId));
  let mode: TurnReplyCardMode = existing?.mode ?? normalizeReplyCardMode(cfg.replyCardMode);
  if (!turnId.startsWith('om_') || !ds.chatId.startsWith('oc_') || !['claude-code', 'codex'].includes(cli)
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
    });
    mode = record.mode;
  }
  snapshot.set(turnId, mode);
  if (snapshot.size > 512) snapshot.delete(snapshot.keys().next().value!);
  return mode;
}

export async function updateTurnReplyCard(
  ds: DaemonSession, turnId: string, event: TurnReplyCardEvent, send: ReplyCardSender,
  options: { dispatchAttempt?: number; owns?: () => boolean; forceVisible?: boolean } = {},
) {
  const mode = replyCardModeFor(ds, turnId);
  if (mode === 'legacy') return undefined;
  const key = replyCardKey(ds, turnId, options.dispatchAttempt);
  const store = new TurnReplyCardStore(config.session.dataDir);
  const session = ds.session;
  const beforeEffect = () => {
    if (ds.session !== session || session.status === 'closed' || options.owns?.() === false
      || getBot(ds.larkAppId).config.apiOnly || isSilentScheduledTurn(ds, turnId)) {
      throw new Error('Reply-card turn no longer owns delivery');
    }
  };
  beforeEffect();
  if (event.kind === 'terminal' && !event.disconnected) invalidateReplyCardAsks(key, 'Turn finished');
  await store.prepare(key, { mode, chatId: ds.chatId, rootId: sessionAnchorId(ds) });
  const cfg = getBot(ds.larkAppId).config;
  let usage;
  if (normalizeUsageDisplay(cfg) === 'streaming') {
    try {
      usage = getSessionUsageSnapshot({
        cliId: ds.session.cliId ?? cfg.cliId, sessionId: ds.session.sessionId,
        cliSessionId: ds.session.cliSessionId, cwd: ds.workingDir ?? ds.session.workingDir,
        larkAppId: ds.larkAppId, fresh: event.kind === 'final' || event.kind === 'terminal',
        pricing: resolvePricingConfig(cfg.pricing),
      });
    } catch { /* missing native usage is omitted */ }
  }
  const transport = {
    usage,
    beforeEffect, send: (body, uuid) => send(body, 'interactive', uuid), patch: (messageId, card) => updateMessage(ds.larkAppId, messageId, card),
    isWithdrawn: error => error instanceof MessageWithdrawnError,
    forceVisible: options.forceVisible || ds.cotForced,
    render: (record: import('../services/turn-reply-card.js').TurnReplyCardRecord) => {
      const cfg = getBot(ds.larkAppId).config;
      const presentation = replyCardPresentation(cfg, ds.chatId);
      return buildTurnReplyCard(record, {
        ...presentation, locale: localeForBot(ds.larkAppId), workingDir: ds.workingDir,
        showProcess: options.forceVisible || ds.cotForced || presentation.showProcess,
        showLiveUsage: normalizeUsageDisplay(cfg) === 'streaming',
        canStop: presentation.canStop && ds.initConfig?.codexRpcInput !== true,
      });
    },
    sendOverflow: async (text: string, uuid: string) => {
      const file = join(store.directory, `${store.id(key)}-reply.md`);
      atomicWriteFileSync(file, text, { mode: 0o600, followTargetSymlink: false });
      const fileKey = await uploadFile(ds.larkAppId, file);
      beforeEffect();
      return send(JSON.stringify({ file_key: fileKey }), 'file', uuid);
    },
  } satisfies import('../services/turn-reply-card.js').TurnReplyCardTransport;
  for (let attempt = 0; ; attempt++) {
    try { return await store.update(key, event, transport); }
    catch (error) {
      if (attempt >= 2 || error instanceof MessageWithdrawnError || store.read(key)?.withdrawn) throw error;
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
    kind: 'tools', tools: visible ? publicReplyCardTools(next.msg.entries, true) : [],
    activity: visible ? publicReplyCardActivity(next.msg.entries) : [],
  }, next.send, { dispatchAttempt, owns: next.owns }).then(() => undefined);
  let running = toolFlushes.get(ds);
  if (!running) { running = new Map(); toolFlushes.set(ds, running); }
  running.set(key, work);
  try { await work; } finally { if (running.get(key) === work) running.delete(key); }
}

/** A disconnected worker does not prove a surviving tmux task completed.
 * Close the visible activity indicator with an honest unknown state, without
 * creating a message in a quiet/recovered session. */
export async function settleTurnReplyCards(ds: DaemonSession): Promise<void> {
  const store = new TurnReplyCardStore(config.session.dataDir);
  for (const [turnId, mode] of modes.get(ds) ?? []) {
    if (mode === 'legacy') continue;
    const record = store.read(replyCardKey(ds, turnId));
    if (!record?.messageId || ['completed', 'failed', 'cancelled', 'ambiguous'].includes(record.phase)) continue;
    await settleDisconnectedReplyCard(store, record);
  }
  ds.replyCardRunningTurnId = undefined;
}

async function settleDisconnectedReplyCard(store: TurnReplyCardStore, record: import('../services/turn-reply-card.js').TurnReplyCardRecord): Promise<void> {
  // Resumable asks have already been restored by the broker at startup.
  const orphanAskIds = (record.asks ?? []).filter(entry => !entry.result && !getAskSnapshot(entry.ask.askId))
    .map(entry => entry.ask.askId);
  await store.update(record, { kind: 'terminal', phase: 'ambiguous', disconnected: true, orphanAskIds }, {
    beforeEffect: () => {
      if (getBot(record.larkAppId).config.apiOnly) throw new Error('Reply-card transport disabled');
    },
    send: async () => { throw new Error('Recovery may only update an existing reply card'); },
    patch: (id, card) => updateMessage(record.larkAppId, id, card),
    isWithdrawn: error => error instanceof MessageWithdrawnError,
    render: state => buildTurnReplyCard({ ...state, finalCard: state.finalDelivered ? state.finalCard : undefined }, {
      ...replyCardPresentation(getBot(record.larkAppId).config, record.chatId),
      locale: localeForBot(record.larkAppId), canStop: false,
    }),
  });
}

/** Like the CoT orphan sweep: recover only this bot's previously visible cards. */
export async function sweepInterruptedReplyCards(larkAppId: string): Promise<void> {
  const store = new TurnReplyCardStore(config.session.dataDir);
  if (!existsSync(store.directory)) return;
  for (const file of readdirSync(store.directory)) {
    if (!/^[0-9a-f]{32}\.json$/.test(file)) continue;
    try {
      const key = JSON.parse(readFileSync(join(store.directory, file), 'utf8')) as TurnReplyCardKey;
      if (key.larkAppId !== larkAppId) continue;
      const record = store.read(key);
      if (!record?.messageId || (record.updatedAtMs ?? record.createdAtMs) >= processStartedAtMs || record.withdrawn || ['completed', 'failed', 'cancelled'].includes(record.phase)) continue;
      await settleDisconnectedReplyCard(store, record);
    } catch (error) {
      logger.warn(`[reply-card] recovery: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
