/**
 * Worker pool — manages forking, killing, and lifecycle of worker processes.
 * Extracted from daemon.ts for modularity.
 */
import { fork, execSync, type ChildProcess, type ForkOptions } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, readdirSync, mkdirSync, existsSync, realpathSync, unlinkSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { fileURLToPath } from 'node:url';
import { ensureSkills, ensureAskSkill, ensurePluginSkills, ensureWhiteboardSkill, removeGlobalBotmuxSkills } from '../skills/installer.js';
import { whiteboardEnabled } from '../services/whiteboard-store.js';
import { installHook } from '../adapters/hook-installer.js';
import { hookCommandFor } from '../adapters/hook-command.js';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { readGlobalConfig } from '../global-config.js';
import * as sessionStore from '../services/session-store.js';
import { persistStreamCardState, rememberLastCliInput } from './session-manager.js';
import { fallbackTurnId } from './reply-target.js';
import { updateMessage, deleteMessage, sendEphemeralCard, sendUserMessage, addReaction, removeReaction, MessageWithdrawnError } from '../im/lark/client.js';
import { buildStreamingCard, buildPrivateSnapshotCard, buildSessionCard, buildTuiPromptCard, buildTuiPromptResolvedCard, buildRelayedFrozenCard, getCliDisplayName } from '../im/lark/card-builder.js';
import { loadFrozenCards, saveFrozenCards } from '../services/frozen-card-store.js';
import { logger } from '../utils/logger.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import { botLocale, localeForBot, t as tr } from '../i18n/index.js';
import { claudeJsonlPathForSession } from '../adapters/cli/claude-code.js';
import { findUniqueClaudeSessionByCwd } from './session-discovery.js';
import { buildMarkdownCard, buildContextualReplyCard } from '../im/lark/md-card.js';
import { replyToDocComment, chunkCommentText, unsubscribeDocFile } from '../im/lark/doc-comment.js';
import { listDocSubscriptionsForSession, removeDocSubscription } from '../services/doc-subs-store.js';
import { TmuxBackend } from '../adapters/backend/tmux-backend.js';
import { HerdrBackend } from '../adapters/backend/herdr-backend.js';
import { isSuspendableBackendType, getSessionPersistentBackendType, persistentSessionName, killPersistentSession } from './persistent-backend.js';
import { getBot, getAllBots, resolveBrandLabel } from '../bot-registry.js';
import { normalizeBrand } from '../im/lark/lark-hosts.js';
import { dashboardEventBus } from './dashboard-events.js';
import { composeRowFromActive, composeRowFromClosed } from './dashboard-rows.js';
import { publishAttentionPatch } from './session-activity.js';
import { knownBotOpenIdsFromCrossRef, type BotMentionEntry } from '../utils/bot-routing.js';
import { emitSessionLifecycleHook, emitSessionStateTransitionHook } from '../services/session-lifecycle-hooks.js';
import { anchorUsageForDaemonSession, recordOwnershipForDaemonSession, recordUsageForDaemonSession, reconcileUsageForDaemonSession } from '../services/usage-ledger.js';
import type { CliId } from '../adapters/cli/types.js';
import { prepareSessionSkillPrompt } from './skills/session-runtime.js';
import { prepareSkillDelivery } from './skills/delivery.js';
import type { DaemonToWorker, WorkerToDaemon, Session, DisplayMode } from '../types.js';
import { sessionKey, sessionAnchorId, type DaemonSession } from './types.js';
import { DONE_REACTION_EMOJI_TYPE } from './pending-response.js';
import { buildTerminalUrl } from './terminal-url.js';
import { prependBotmuxBin } from './botmux-wrapper.js';
import { usageLimitStateKey, type CliUsageLimitState } from '../utils/cli-usage-limit.js';

type WindowsForkOptions = ForkOptions & { windowsHide?: boolean };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_SIGTERM_BACKSTOP_MS = 2_000;
const WORKER_SIGKILL_BACKSTOP_MS = 7_000;

// ─── Callbacks set by daemon at startup ─────────────────────────────────────

export interface WorkerPoolCallbacks {
  sessionReply: (rootId: string, content: string, msgType?: string, larkAppId?: string, turnId?: string) => Promise<string>;
  getSessionWorkingDir: (ds?: DaemonSession) => string;
  getActiveCount: () => number;
  /** Close a stale session (message withdrawn, etc.) */
  closeSession: (ds: DaemonSession) => void;
  /** Turn boundary signal used by goal watchdog to inspect unreported tasks. */
  onSessionIdleOrExit?: (ds: DaemonSession, reason: 'idle' | 'limited' | 'exit') => void;
}

let callbacks: WorkerPoolCallbacks | undefined;

/**
 * Initialise worker-pool callbacks. Must be called once before forkWorker().
 */
export function initWorkerPool(cb: WorkerPoolCallbacks): void {
  callbacks = cb;
}

function requireCallbacks(): WorkerPoolCallbacks {
  if (!callbacks) throw new Error('WorkerPool not initialised — call initWorkerPool() first');
  return callbacks;
}

// ─── Active session registry (daemon-owned, accessor for IPC) ───────────────
// The activeSessions Map physically lives in daemon.ts. To let the dashboard
// IPC server (and other modules) read it without reaching back into daemon, the
// daemon registers its Map here at boot. Helpers below return a snapshot or
// linear-scan by sessionId.
let activeSessionsRegistry: Map<string, DaemonSession> | undefined;

export function setActiveSessionsRegistry(m: Map<string, DaemonSession>): void {
  activeSessionsRegistry = m;
}

export function listActiveSessions(): DaemonSession[] {
  return activeSessionsRegistry ? [...activeSessionsRegistry.values()] : [];
}

/** Linear-scan lookup of the active-sessions Map by `Session.sessionId`.
 *  The Map's actual key is `sessionKey(rootId, larkAppId)` (composite), so we
 *  cannot use Map.get here. */
export function findActiveBySessionId(sessionId: string): DaemonSession | undefined {
  if (!activeSessionsRegistry) return undefined;
  for (const s of activeSessionsRegistry.values()) if (s.session.sessionId === sessionId) return s;
  return undefined;
}

/** Direct access to the active-sessions Map. Reserved for callers that need
 *  to mutate (e.g. resumeSession reactivating a closed record); read-only
 *  callers should prefer listActiveSessions / findActiveBySessionId. */
export function getActiveSessionsRegistry(): Map<string, DaemonSession> | undefined {
  return activeSessionsRegistry;
}

// ─── "Real relayable session" predicate ─────────────────────────────────────

/**
 * True iff this DaemonSession represents a real CLI-backed conversation
 * that's safe to migrate via /relay. Returns false for daemon-command
 * scratch placeholders (the `worker:null + hasHistory:false` records that
 * daemon.ts creates for /help, an unfinished picker /relay, etc.) — those
 * have no CLI history, no tmux, and migrating them yields an empty shell
 * in the target chat with a fake "已就绪" M1.
 *
 * Why not just `!!ds.worker || ds.hasHistory`:
 *   - `ds.worker` is runtime-only; null after daemon restart until
 *     forkWorker re-attaches.
 *   - `ds.hasHistory` is a runtime field too — restoreActiveSessions sets
 *     it `true` UNCONDITIONALLY for any persisted non-adopt session
 *     (session-manager.ts:618). A scratch that survived a restart comes
 *     back with hasHistory:true, defeating the guard.
 *
 * Use persisted markers instead: `ds.session.cliId` and
 * `ds.session.lastCliInput` are written ONLY after a real worker started
 * the CLI (worker-pool's fork path stamps cliId; rememberLastCliInput
 * writes lastCliInput on every input). Daemon-command scratches never set
 * either, so the predicate survives restart and is robust across paths.
 *
 * Apply at every relay surface that consumes a candidate `ds`:
 *   - relay-picker.ts collectRelayPickerEntries (don't list scratches)
 *   - card-handler.ts relay_confirm preflight (don't M1 + transferSession a scratch)
 *   - this file's transferSession depth defense (catch any caller that bypassed both upstream guards)
 *   - command-handler.ts /relay --create leader guard
 */
export function isRelayableRealSession(ds: DaemonSession): boolean {
  if (ds.worker) return true;
  if (ds.session.cliId) return true;
  if (ds.session.lastCliInput) return true;
  return false;
}

// Per-bot opt-out: when true, botmux never posts/patches the live streaming
// session card. Read fresh from the in-memory registry so a dashboard toggle
// takes effect without a daemon restart. The `/card` command can override it
// per-session via `ds.streamingCardForced` (manually summon a live card).
function streamingCardDisabled(ds: DaemonSession): boolean {
  if (ds.streamingCardForced) return false;
  try {
    const cfg = getBot(ds.larkAppId).config;
    return cfg.disableStreamingCard === true
      || (!!ds.chatId && !!cfg.noCardChats?.includes(ds.chatId));
  } catch { return false; }
}

function silentTurnReactions(ds: DaemonSession): boolean {
  try {
    return getBot(ds.larkAppId).config.silentTurnReactions === true;
  } catch { return false; }
}

// Per-bot opt-in: the writable terminal link to embed directly in the streaming
// card body (token included). Returns undefined unless the bot enabled it AND
// the worker port/token are known. Exported for card-handler's re-renders so the
// link stays put across button-driven card updates.
export function writableTerminalLinkFor(ds: DaemonSession): string | undefined {
  try {
    if (getBot(ds.larkAppId).config.writableTerminalLinkInCard !== true) return undefined;
  } catch { return undefined; }
  if (!ds.workerPort || !ds.workerToken) return undefined;
  return buildTerminalUrl(ds, { write: true });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function tag(ds: DaemonSession): string {
  return ds.session.sessionId.substring(0, 8);
}

function sessionCliId(ds: DaemonSession, botCfg: { cliId: CliId }): CliId {
  return ds.session.cliId ?? botCfg.cliId;
}

function loadKnownBotOpenIdsForApp(larkAppId: string): Set<string> {
  const dataDir = config.session.dataDir;
  let crossRef: Record<string, string> = {};
  const crossRefPath = join(dataDir, `bot-openids-${larkAppId}.json`);
  if (existsSync(crossRefPath)) {
    const parsed = JSON.parse(readFileSync(crossRefPath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      crossRef = parsed as Record<string, string>;
    }
  }

  let botEntries: BotMentionEntry[] = [];
  const botInfoPath = join(dataDir, 'bots-info.json');
  if (existsSync(botInfoPath)) {
    const parsed = JSON.parse(readFileSync(botInfoPath, 'utf-8'));
    if (Array.isArray(parsed)) botEntries = parsed as BotMentionEntry[];
  }

  return knownBotOpenIdsFromCrossRef(crossRef, botEntries, larkAppId);
}

/** CLIs whose model→Lark delivery is the daemon's stdout-runner fallback card
 *  (NOT the model calling `botmux send`): mira (Web API runner) and mir (local
 *  mircli runner). They can't @-trigger a peer bot themselves, so for bot-to-bot
 *  handoffs the fallback card must carry the real <at> back to the dispatcher. */
function isRunnerDeliveryCli(cliId?: string): boolean {
  return cliId === 'mira' || cliId === 'mir';
}

function daemonCardFooterRecipientOpenId(ds: DaemonSession, effectiveCliId?: string): string | undefined {
  const owner = ds.session.ownerOpenId;
  if (!owner) {
    // Mira / Mir run through botmux's stdout-runner and cannot execute
    // `botmux send` to @-trigger a peer bot. For bot-to-bot handoffs, address
    // the daemon fallback card back to the original dispatcher so orchestration
    // resumes (the card's real <at> is what re-wakes the dispatching bot).
    if (isRunnerDeliveryCli(effectiveCliId) && ds.session.quoteTargetSenderIsBot && ds.session.creatorOpenId) {
      return ds.session.creatorOpenId;
    }
    return undefined;
  }
  try {
    if (loadKnownBotOpenIdsForApp(ds.larkAppId).has(owner)) {
      // `/repo`-primed dispatch records the dispatching bot as owner (unlike
      // the @-mention auto-create path, which nulls ownerOpenId for bot
      // senders). Same constraint for the stdout-runner CLIs (mira/mir): the
      // daemon fallback card is their only @-trigger channel, so address the
      // dispatcher bot here too.
      return isRunnerDeliveryCli(effectiveCliId) ? owner : undefined;
    }
    return owner;
  } catch {
    return owner;
  }
}

export function clearUsageLimitState(ds: DaemonSession): void {
  if (ds.usageLimitRetryTimer) {
    clearTimeout(ds.usageLimitRetryTimer);
    ds.usageLimitRetryTimer = undefined;
  }
  ds.usageLimit = undefined;
  persistStreamCardState(ds);
}

export function cardUsageLimit(ds: DaemonSession): CliUsageLimitState | undefined {
  return ds.lastScreenStatus === 'limited' ? ds.usageLimit : undefined;
}

function scheduleUsageLimitCardPatch(ds: DaemonSession): void {
  if (ds.lastScreenStatus !== 'limited') return;
  const port = ds.workerPort ?? ds.session.webPort;
  if (!ds.streamCardId || ds.streamCardId === CARD_POSTING_SENTINEL || !port) return;

  const bot = getBot(ds.larkAppId);
  const effectiveCliId = sessionCliId(ds, bot.config);
  const readUrl = buildTerminalUrl(ds);
  const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
  const cardJson = buildStreamingCard(
    ds.session.sessionId,
    sessionAnchorId(ds),
    readUrl,
    turnTitle,
    ds.lastScreenContent ?? '',
    'limited',
    effectiveCliId,
    ds.displayMode ?? 'hidden',
    ds.streamCardNonce,
    ds.currentImageKey,
    !!ds.adoptedFrom,
    false,
    localeForBot(ds.larkAppId),
    ds.usageLimit,
    writableTerminalLinkFor(ds),
  );
  scheduleCardPatch(ds, cardJson);
}

function armUsageLimitRetryTimer(ds: DaemonSession, previous?: CliUsageLimitState): void {
  if (!ds.usageLimit) return;

  if (ds.usageLimitRetryTimer) {
    clearTimeout(ds.usageLimitRetryTimer);
    ds.usageLimitRetryTimer = undefined;
  }

  if (ds.usageLimit.retryReady || ds.usageLimit.retryAtMs <= Date.now()) {
    const wasReady = !!previous?.retryReady;
    ds.usageLimit = { ...ds.usageLimit, retryReady: true };
    persistStreamCardState(ds);
    if (!wasReady) scheduleUsageLimitCardPatch(ds);
    return;
  }

  const key = usageLimitStateKey(ds.usageLimit);
  const delayMs = Math.max(0, ds.usageLimit.retryAtMs - Date.now());
  ds.usageLimitRetryTimer = setTimeout(() => {
    if (!ds.usageLimit || usageLimitStateKey(ds.usageLimit) !== key) return;
    ds.usageLimit = { ...ds.usageLimit, retryReady: true };
    persistStreamCardState(ds);
    scheduleUsageLimitCardPatch(ds);
  }, delayMs);
}

export function restoreUsageLimitRuntimeState(ds: DaemonSession): void {
  if (!ds.usageLimit) return;
  ds.lastScreenStatus = 'limited';
  armUsageLimitRetryTimer(ds);
}

function updateUsageLimitState(ds: DaemonSession, usageLimit?: CliUsageLimitState): void {
  if (!usageLimit) return;

  const previous = ds.usageLimit;
  // Screen updates repeat the same limit every tick while a session sits
  // blocked. Skip the persist + timer re-arm churn unless the limit changed.
  if (
    previous &&
    usageLimitStateKey(previous) === usageLimitStateKey(usageLimit) &&
    previous.retryReady === usageLimit.retryReady
  ) return;

  ds.usageLimit = usageLimit;
  persistStreamCardState(ds);
  armUsageLimitRetryTimer(ds, previous);
}

const WORKER_ERROR_MARKER = '[botmux-worker-error]';

function logWorkerStderr(t: string, line: string): void {
  if (!line) return;
  const taggedLine = `[${t}:err] ${line}`;
  if (line.includes(WORKER_ERROR_MARKER)) {
    logger.error(taggedLine);
    return;
  }
  logger.info(taggedLine);
}

// Sentinel value for streamCardId while a POST (new card) is in-flight.
// Prevents duplicate card POSTs when multiple screen_updates arrive before
// the first POST returns a real message_id.
export const CARD_POSTING_SENTINEL = '__posting__';

/**
 * Move the current streaming card into `frozenCards` without freezing it
 * cosmetically. The next successful card POST will sweep it via
 * `recallFrozenCards`. Used on paths that bypass the normal freeze step
 * (worker dead before a new turn, repo switch tearing down the session) so
 * we never delete the only visible card before its successor exists — if
 * fork / worker_ready / POST fails, the parked card stays in the thread.
 *
 * Lazy-loads `frozenCards` from disk if the in-memory Map is missing
 * (post daemon-restart, before any card-handler action has loaded it).
 * Without this, parking would synthesize an empty Map and the subsequent
 * `saveFrozenCards` would overwrite earlier turns' entries on disk —
 * stranding their cards in the thread with no way to recall them.
 *
 * No-op when there is no live card to park.
 */
export function parkStreamCard(ds: DaemonSession): void {
  if (!ds.streamCardId || ds.streamCardId === CARD_POSTING_SENTINEL) return;
  if (!ds.streamCardNonce) return;
  if (!ds.frozenCards) ds.frozenCards = loadFrozenCards(ds.session.sessionId);
  ds.frozenCards.set(ds.streamCardNonce, {
    messageId: ds.streamCardId,
    content: ds.lastScreenContent ?? '',
    title: ds.currentTurnTitle ?? '',
    displayMode: ds.displayMode ?? 'hidden',
    imageKey: ds.currentImageKey,
  });
  saveFrozenCards(ds.session.sessionId, ds.frozenCards);
}

/**
 * Delete previously-frozen streaming cards from Lark and clear the cache.
 * Called whenever a new streaming card becomes the active one — old turns'
 * cards just add visual clutter when scrolling thread history.
 *
 * Lazy-loads `frozenCards` from disk if the in-memory Map is missing
 * (post daemon-restart). Best-effort delete; failures (already withdrawn,
 * expired) are non-fatal.
 *
 * Skips any entry whose messageId matches `ds.streamCardId` — guards the
 * daemon-restart window where a turn was frozen (entry persisted to disk)
 * but a new card was never POSTed before the crash. After restart the same
 * messageId is the live `streamCardId` again, and recalling it would delete
 * the only card the user can see.
 */
export function recallFrozenCards(ds: DaemonSession): void {
  if (!ds.frozenCards) ds.frozenCards = loadFrozenCards(ds.session.sessionId);
  if (ds.frozenCards.size === 0) return;
  const activeId = ds.streamCardId && ds.streamCardId !== CARD_POSTING_SENTINEL
    ? ds.streamCardId
    : undefined;
  const targets: string[] = [];
  for (const [nonce, fc] of [...ds.frozenCards.entries()]) {
    if (activeId && fc.messageId === activeId) continue;
    targets.push(fc.messageId);
    ds.frozenCards.delete(nonce);
  }
  if (targets.length === 0) return;
  saveFrozenCards(ds.session.sessionId, ds.frozenCards);
  for (const messageId of targets) {
    deleteMessage(ds.larkAppId, messageId).catch(() => { /* best-effort */ });
  }
  logger.info(`[${tag(ds)}] Recalled ${targets.length} previous streaming card(s)`);
}

/**
 * Force-post a fresh streaming card for `ds`, bypassing the per-bot
 * `disableStreamingCard` opt-out. Backs the `/card` command: a user can
 * manually summon a live card in an otherwise-quiet session. Parks the current
 * card (if any) first so `recallFrozenCards` withdraws it once the fresh one
 * lands — the thread ends up with a single live card. Returns false when the
 * worker terminal isn't ready yet (no port), so the caller can surface a
 * friendly "not ready" message.
 *
 * Note: this does NOT itself flip `ds.streamingCardForced` — the caller sets
 * that so the card keeps live-patching afterwards even when the bot opted out.
 */
export async function postFreshStreamingCard(
  ds: DaemonSession,
  sessionReply: (rootId: string, content: string, msgType?: string, larkAppId?: string, turnId?: string) => Promise<string>,
): Promise<boolean> {
  const port = ds.workerPort ?? ds.session.webPort;
  if (!port) return false;
  const botCfg = getBot(ds.larkAppId).config;
  const effectiveCliId = sessionCliId(ds, botCfg);
  const readUrl = buildTerminalUrl(ds);
  const title = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
  const status = ds.lastScreenStatus ?? 'idle';

  // Park the current card (no-op when there's none) so the fresh one replaces
  // rather than duplicates it.
  parkStreamCard(ds);

  // Snapshot prior identity for rollback on POST failure (restore all three
  // together so a failed /card leaves no orphaned nonce/pending state).
  const prevCardId = ds.streamCardId;
  const prevNonce = ds.streamCardNonce;
  const prevPending = ds.streamCardPending;

  ds.streamCardNonce = randomBytes(4).toString('hex');
  const cardJson = buildStreamingCard(
    ds.session.sessionId,
    sessionAnchorId(ds),
    readUrl,
    title,
    ds.lastScreenContent ?? '',
    status,
    effectiveCliId,
    ds.displayMode ?? 'hidden',
    ds.streamCardNonce,
    ds.currentImageKey,
    !!ds.adoptedFrom,
    false,
    localeForBot(ds.larkAppId),
    cardUsageLimit(ds),
    writableTerminalLinkFor(ds),
  );
  ds.streamCardId = CARD_POSTING_SENTINEL;
  try {
    ds.streamCardId = await sessionReply(sessionAnchorId(ds), cardJson, 'interactive', ds.larkAppId, ds.currentReplyTarget?.turnId);
    // This card is now the live one for the current turn. Clear the new-turn
    // pending flag so the next screen_update PATCHes it instead of POSTing a
    // duplicate (the gate above only suppresses cards when disabled+unforced;
    // /card forces them on, so a stale pending flag would otherwise re-POST).
    ds.streamCardPending = false;
    persistStreamCardState(ds);
    recallFrozenCards(ds);
    logger.info(`[${tag(ds)}] Posted streaming card via /card`);
    return true;
  } catch (err) {
    ds.streamCardId = prevCardId;
    ds.streamCardNonce = prevNonce;
    ds.streamCardPending = prevPending;
    logger.warn(`[${tag(ds)}] /card POST failed: ${err}`);
    return false;
  }
}

/**
 * Audience for a private `/card`: the bot's `allowedUsers` (the canOperate set —
 * owner & co-owners), deduped, `ou_` only. Talk-only grants (`globalGrants` /
 * `chatGrants`) and a bare triggerer are intentionally NOT included: the private
 * card is owner-only. A grant-authorized user who runs `/card` therefore does
 * not receive a card (matches the "授权人不发" rule). Empty when the bot has no
 * `allowedUsers` (fully-open mode → no owner to send to).
 */
export function resolvePrivateCardAudience(ds: DaemonSession): string[] {
  const bot = getBot(ds.larkAppId);
  const set = new Set<string>();
  for (const u of bot.resolvedAllowedUsers) if (u.startsWith('ou_')) set.add(u);
  return [...set];
}

/**
 * Private `/card`: build a one-shot snapshot of the current terminal and send it
 * as an ephemeral (visible-to-one) card to each open_id in `audience`, one API
 * call each (concurrency-capped). Never posts a group-visible card and never
 * patches — privacy is the whole point, so there is deliberately no fallback.
 * Returns per-recipient counts so the caller can report progress without leaking
 * the audience list into the chat.
 */
export async function postPrivateSnapshotCard(
  ds: DaemonSession,
  audience: string[],
): Promise<{ sent: number; total: number; notReady: boolean }> {
  const port = ds.workerPort ?? ds.session.webPort;
  if (!port) return { sent: 0, total: audience.length, notReady: true };

  const botCfg = getBot(ds.larkAppId).config;
  const effectiveCliId = sessionCliId(ds, botCfg);
  const readUrl = buildTerminalUrl(ds);
  const title = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
  const status = ds.lastScreenStatus ?? 'idle';
  const cardJson = buildPrivateSnapshotCard(
    readUrl, title, status, effectiveCliId, ds.currentImageKey, ds.lastScreenContent ?? '',
    ds.session.sessionId, sessionAnchorId(ds), localeForBot(ds.larkAppId), cardUsageLimit(ds),
  );

  let sent = 0;
  // Cap concurrency: Feishu per-chat ~40 QPS, ephemeral total 50/s.
  const CONCURRENCY = 5;
  for (let i = 0; i < audience.length; i += CONCURRENCY) {
    const batch = audience.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (openId) => {
      try {
        await sendEphemeralCard(ds.larkAppId, ds.chatId, openId, cardJson);
        sent++;
      } catch (err) {
        logger.warn(`[${tag(ds)}] private /card ephemeral send to ${openId.substring(0, 8)}… failed: ${err}`);
      }
    }));
  }
  logger.info(`[${tag(ds)}] private /card: ephemeral sent ${sent}/${audience.length}`);
  return { sent, total: audience.length, notReady: false };
}

/**
 * Deliver the write-enabled session card (the "🔑 获取操作链接" card, which carries
 * a write-token terminal URL + manage buttons) privately to a single operator.
 *
 * Prefers an in-chat "visible-to-you" ephemeral card so the operator never has
 * to leave the conversation. Feishu's ephemeral API only works in plain `group`
 * chats — topic / thread groups reject with {@link LARK_CODE_EPHEMERAL_NOT_GROUP}
 * (18053) and p2p chats are unsupported — and chatType can't distinguish a topic
 * group from a regular one (both record 'group'), so we attempt ephemeral for any
 * non-p2p chat and fall back to a private DM on ANY failure. p2p chats skip the
 * doomed ephemeral attempt and DM directly (the DM lands in that same 1:1 chat).
 *
 * Both channels are private, so the DM fallback never leaks the write token —
 * unlike the private /card snapshot (which fails closed), here we fail OVER.
 *
 * Returns the channel actually used, or 'failed' if both errored.
 */
export async function deliverWriteLinkCard(
  ds: DaemonSession,
  operatorOpenId: string,
  cardJson: string,
): Promise<'ephemeral' | 'dm' | 'failed'> {
  const who = operatorOpenId.substring(0, 8);
  if (ds.chatType !== 'p2p') {
    try {
      await sendEphemeralCard(ds.larkAppId, ds.chatId, operatorOpenId, cardJson);
      logger.info(`[${tag(ds)}] write link delivered via ephemeral card to ${who}…`);
      return 'ephemeral';
    } catch (err) {
      // Expected in topic/thread groups (18053); any other error is also safe to
      // retry via DM since the DM is private too.
      logger.info(`[${tag(ds)}] ephemeral write-link card unavailable here (${err}); falling back to DM`);
    }
  }
  try {
    await sendUserMessage(ds.larkAppId, operatorOpenId, cardJson, 'interactive');
    logger.info(`[${tag(ds)}] write link delivered via DM to ${who}…`);
    return 'dm';
  } catch (err) {
    logger.warn(`[${tag(ds)}] failed to deliver write link (ephemeral + DM both failed): ${err}`);
    return 'failed';
  }
}

export interface WriteLinkOwnerDelivery {
  ok: boolean;
  error?: 'terminal_unavailable' | 'no_owner' | 'delivery_failed';
  delivered: number;
  total: number;
  channels: Array<'ephemeral' | 'dm' | 'failed'>;
}

/**
 * Build the write-enabled session card (writable terminal URL + manage buttons)
 * for `ds`, or null when the terminal isn't up yet (no worker port/token).
 * Shared by the owner-fanout ({@link deliverWriteLinkCardToOwners}, behind
 * `botmux term-link`) and the single-operator delivery
 * ({@link deliverWritableTerminalCardTo}, behind the `/term` slash command).
 */
function buildWritableTerminalCard(ds: DaemonSession): string | null {
  const port = ds.workerPort ?? ds.session.webPort;
  if (!port || !ds.workerToken) return null;
  const botCfg = getBot(ds.larkAppId).config;
  const effectiveCliId = sessionCliId(ds, botCfg);
  return buildSessionCard(
    ds.session.sessionId,
    sessionAnchorId(ds),
    buildTerminalUrl(ds, { write: true }),
    ds.session.title || getCliDisplayName(effectiveCliId),
    effectiveCliId,
    true,             // showManageButtons — write-link card includes restart & close
    !!ds.adoptedFrom, // adoptMode — disconnect, never close-the-CLI
    localeForBot(ds.larkAppId),
  );
}

/**
 * Build the write-enabled session card for `ds` and deliver it privately to the
 * bot's owner(s) — the payload behind the `botmux term-link` CLI command.
 *
 * Mirrors the in-chat "🔑 获取操作链接" button flow ({@link deliverWriteLinkCard}),
 * but fans out to the owner audience ({@link resolvePrivateCardAudience}) instead
 * of a single click-operator: a CLI caller has no Lark identity, so "deliver to
 * the owner(s)" is the closest equivalent of "deliver to the person who asked".
 * Each owner gets an in-chat visible-to-you ephemeral card, auto-falling back to
 * a private DM in topic / p2p chats. The write token therefore only ever rides
 * these private channels — it is never returned to the CLI caller / stdout.
 */
export async function deliverWriteLinkCardToOwners(ds: DaemonSession): Promise<WriteLinkOwnerDelivery> {
  const cardJson = buildWritableTerminalCard(ds);
  if (!cardJson) return { ok: false, error: 'terminal_unavailable', delivered: 0, total: 0, channels: [] };

  const audience = resolvePrivateCardAudience(ds);
  if (audience.length === 0) return { ok: false, error: 'no_owner', delivered: 0, total: 0, channels: [] };

  const channels: Array<'ephemeral' | 'dm' | 'failed'> = [];
  // Cap concurrency like postPrivateSnapshotCard (Feishu ephemeral ~50/s total).
  const CONCURRENCY = 5;
  for (let i = 0; i < audience.length; i += CONCURRENCY) {
    const batch = audience.slice(i, i + CONCURRENCY);
    channels.push(...await Promise.all(batch.map(openId => deliverWriteLinkCard(ds, openId, cardJson))));
  }
  const delivered = channels.filter(c => c !== 'failed').length;
  return {
    ok: delivered > 0,
    error: delivered > 0 ? undefined : 'delivery_failed',
    delivered,
    total: audience.length,
    channels,
  };
}

/**
 * Deliver the writable-terminal card privately to a single operator — the `/term`
 * slash command's payload (the owner who typed it; owner-gated in command-handler).
 * Same private ephemeral→DM channel as the "🔑 获取操作链接" card button. Returns
 * 'not_ready' when the terminal isn't up yet, else the channel actually used.
 */
export async function deliverWritableTerminalCardTo(
  ds: DaemonSession,
  operatorOpenId: string,
): Promise<'ephemeral' | 'dm' | 'failed' | 'not_ready'> {
  const cardJson = buildWritableTerminalCard(ds);
  if (!cardJson) return 'not_ready';
  return deliverWriteLinkCard(ds, operatorOpenId, cardJson);
}

/**
 * Deliver a status confirmation (restart / session-closed / resume) as a
 * "visible-to-the-operator-only" ephemeral message in a plain group; on failure
 * (topic groups reject with 18053) or in p2p, fall back to the normal visible
 * reply (`reply`). `content` is the card JSON when msgType==='interactive',
 * otherwise the plain text. Topic-group / p2p behavior is unchanged.
 *
 * IMPORTANT: ephemeral is only attempted for flat **chat-scope** sessions. The
 * ephemeral API (`ephemeral/v1/send`) takes a `chat_id` only — it has no
 * thread/root anchoring — so for a **thread-scope** session (a 话题 inside a
 * 普通群, or a 话题群 topic) an ephemeral card would escape the topic and land at
 * the group top-level. 话题群 happened to reject ephemeral with 18053 and fall
 * back to the in-thread reply, but a 话题 inside a 普通群 succeeds and leaks the
 * card out of the thread. So thread-scope sessions always take the visible
 * `reply()` path, which routes back into the thread (`reply_in_thread`).
 */
export async function deliverEphemeralOrReply(
  ds: DaemonSession,
  operatorOpenId: string | undefined,
  content: string,
  msgType: 'text' | 'interactive',
  reply: () => Promise<unknown>,
): Promise<void> {
  if (operatorOpenId && ds.chatType !== 'p2p' && ds.scope === 'chat') {
    try {
      // The ephemeral API is card-only (msg_type=text → 10003), so wrap a plain
      // confirmation line into a minimal markdown card.
      const cardJson = msgType === 'interactive' ? content : JSON.stringify({
        config: { wide_screen_mode: true },
        elements: [{ tag: 'markdown', content }],
      });
      await sendEphemeralCard(ds.larkAppId, ds.chatId, operatorOpenId, cardJson);
      return;
    } catch (err) {
      // Topic groups (18053) / other → not ephemeral-capable here; reply visibly.
      logger.info(`[${tag(ds)}] ephemeral confirmation unavailable here (${err}); sending visibly`);
    }
  }
  await reply();
}

// ─── Card PATCH serialization queue ─────────────────────────────────────────
// Only one PATCH in-flight at a time per session. New PATCHes queue on
// ds.pendingCardJson (latest wins). When the in-flight PATCH completes,
// the pending one is flushed. This prevents concurrent PATCHes to the
// same Feishu message — delivery order is unpredictable and a stale
// screen_update could overwrite a toggle result.

/**
 * Queue a card PATCH. If no PATCH is in-flight, sends immediately.
 * Otherwise stores the card JSON on `ds.pendingCardJson` (overwriting
 * any previously queued value — only the latest state matters).
 */
export function scheduleCardPatch(ds: DaemonSession, cardJson: string): void {
  // Bot opted out of the streaming card — never patch one into existence.
  if (streamingCardDisabled(ds)) return;
  ds.pendingCardJson = cardJson;
  // Capture the card ID now — by the time flushCardPatch runs, ds.streamCardId
  // may have been overwritten by a new turn's card (CARD_POSTING_SENTINEL).
  ds.pendingCardId = ds.streamCardId;
  if (ds.cardPatchInFlight) return;
  flushCardPatch(ds);
}

function flushCardPatch(ds: DaemonSession): void {
  const json = ds.pendingCardJson;
  const cardId = ds.pendingCardId;
  if (!json || !cardId || cardId === CARD_POSTING_SENTINEL) {
    ds.pendingCardJson = undefined;
    ds.pendingCardId = undefined;
    return;
  }
  ds.pendingCardJson = undefined;
  ds.pendingCardId = undefined;
  ds.cardPatchInFlight = true;
  updateMessage(ds.larkAppId, cardId, json)
    .catch(err => {
      if (err instanceof MessageWithdrawnError) {
        // Only clear streamCardId when the withdrawn message is still the
        // active one. With auto-recall a new turn may have advanced
        // ds.streamCardId past `cardId` while this PATCH was in flight (the
        // recall on the new POST deletes the previous card, which surfaces
        // here as MessageWithdrawnError). Clearing unconditionally would
        // forget the live new card and trigger a duplicate POST on the next
        // screen_update.
        if (ds.streamCardId === cardId) {
          logger.warn(`[${tag(ds)}] Stream card withdrawn, clearing reference`);
          ds.streamCardId = undefined;
          persistStreamCardState(ds);
        } else {
          logger.debug(`[${tag(ds)}] Stale card ${cardId.substring(0, 12)} withdrawn (current: ${ds.streamCardId?.substring(0, 12) ?? 'none'})`);
        }
        return;
      }
      logger.debug(`[${tag(ds)}] Failed to update streaming card: ${err}`);
    })
    .finally(() => {
      ds.cardPatchInFlight = false;
      if (ds.pendingCardJson) {
        flushCardPatch(ds);
      }
    });
}

// ─── Restart rate-limiting ──────────────────────────────────────────────────

export const restartCounts = new Map<string, { count: number; lastAt: number }>();

// ─── Skills installation ────────────────────────────────────────────────────

/** Track which CLI adapters have had skills installed this daemon lifecycle */
const skillsInstalledCliIds = new Set<string>();

/**
 * Ensure built-in skills are installed for a given CLI.
 * Synchronous and idempotent — runs once per CLI per daemon lifecycle.
 */
export function ensureCliSkills(cliId: CliId, cliPathOverride?: string): void {
  const adapter = createCliAdapterSync(cliId, cliPathOverride);
  // botmux-whiteboard skill 跟随白板能力开关，且**每次 spawn 都重新评估**（不进
  // 下面 skillsInstalledCliIds 的一次性缓存）——这样运行时在 dashboard/CLI 切换白板
  // 开关，下一个会话即生效，无需重启 daemon。skill 落点与其它内置 skill 同目录
  // （plugin 模式下是 {pluginDir}/skills），spawn 时一并经 --plugin-dir 注入。
  const wbSkillsDir = adapter.pluginDir ? join(adapter.pluginDir, 'skills') : adapter.skillsDir;
  ensureWhiteboardSkill(cliId, wbSkillsDir, whiteboardEnabled());

  if (skillsInstalledCliIds.has(cliId)) return;
  if (adapter.pluginDir) {
    // 动态注入：skill 写进插件目录，spawn 时用 --plugin-dir 注入，仅本次会话可见。
    // 不再写全局 skillsDir。（全局 ~/.claude/skills 的历史残留清理改由
    // cleanupGlobalBotmuxSkillsOnce 在启动时独立于 cliId 执行。）
    ensurePluginSkills(cliId, adapter.pluginDir);
  } else {
    ensureSkills(cliId, adapter.skillsDir);
  }
  // askUserQuestion 接管策略：hook 优先 + 非 hook CLI 用 skill 兜底。
  // - asksViaHook=true（Claude/OpenCode）：通过 hook 拦截原生 AskUserQuestion，删掉
  //   botmux-ask skill，避免 skill 与 hook 双重弹卡。
  //   Claude 走 --settings 进程级注入；OpenCode 走 hookInstall 插件写文件。
  // - asksViaHook 未设（Codex/Cursor/尚未接 hook 的终端原生 CLI）：保留 botmux-ask
  //   skill 作兜底，让 agent 仍可用 `botmux ask` 把选择题引到飞书。
  if (adapter.hookInstall) {
    try { installHook(cliId, adapter.hookInstall, hookCommandFor(cliId)); }
    catch (err) { logger.warn(`[hook] install failed for ${cliId}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  // 命令式 hook 安装（CoCo 走 `coco plugin install`，纯写文件搞不定）。内部自带
  // try/catch，失败只 warn；与 hookInstall 互斥。
  if (adapter.ensureAskHook) {
    try { adapter.ensureAskHook(); }
    catch (err) { logger.warn(`[hook] ensureAskHook failed for ${cliId}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  // botmux-ask 落在与其它 skill 同一目录：plugin 模式下是 {pluginDir}/skills。
  const askSkillsDir = adapter.pluginDir ? join(adapter.pluginDir, 'skills') : adapter.skillsDir;
  ensureAskSkill(cliId, askSkillsDir, !adapter.asksViaHook);
  skillsInstalledCliIds.add(cliId);
}

// ─── Legacy MCP config cleanup ──────────────────────────────────────────────
//
// botmux used to register itself as an MCP server in each CLI's config so the
// CLI could call send_to_thread / get_thread_messages / list_bots.  Those
// tools have since been migrated to `botmux` subcommands + Skills.  The old
// MCP entry is now dead — if we leave it, the CLI will try to spawn a
// non-existent server on startup and users see scary errors.
//
// For each CLI, best-effort remove any `botmux` entry from its MCP config.
// Runs once per CLI per daemon lifecycle, same lifecycle as ensureCliSkills.

/** Track which CLI adapters have had legacy MCP config cleaned this daemon lifecycle */
const legacyMcpCleanedCliIds = new Set<string>();

/** Remove a key from a JSON config file at the given dotted path. Best-effort. */
function removeJsonKey(configPath: string, pathSegments: string[], keyToRemove: string): boolean {
  try {
    if (!existsSync(configPath)) return false;
    const raw = readFileSync(configPath, 'utf-8');
    const data = JSON.parse(raw);
    let node: any = data;
    for (const seg of pathSegments) {
      if (!node || typeof node !== 'object' || !(seg in node)) return false;
      node = node[seg];
    }
    if (!node || typeof node !== 'object' || !(keyToRemove in node)) return false;
    delete node[keyToRemove];
    // 原子写：这里改的是外部 CLI 自己的热配置文件（如 ~/.claude.json），
    // 裸写半截会弄坏 CLI 的状态。
    atomicWriteFileSync(configPath, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** Try running `<cli> mcp remove botmux`. Returns true if the command ran. */
function tryCliMcpRemove(binName: string): boolean {
  try {
    execSync(`${binName} mcp remove botmux`, { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove legacy `botmux` MCP server registration from the given CLI's config.
 * Idempotent — runs once per CLI per daemon lifecycle.  Best-effort: any
 * failure is swallowed; we never want to block worker startup.
 */
export function cleanupLegacyMcpConfig(cliId: CliId): void {
  if (legacyMcpCleanedCliIds.has(cliId)) return;
  legacyMcpCleanedCliIds.add(cliId);

  try {
    const home = homedir();
    switch (cliId) {
      case 'claude-code': {
        // ~/.claude.json → { mcpServers: { botmux } }
        if (removeJsonKey(join(home, '.claude.json'), ['mcpServers'], 'botmux')) {
          logger.info(`[legacy-mcp] Removed botmux entry from ~/.claude.json`);
        }
        break;
      }
      case 'aiden': {
        // ~/.aiden/.mcp.json or cwd/.mcp.json → { mcpServers: { botmux } }
        for (const p of [join(home, '.aiden', '.mcp.json'), join(process.cwd(), '.mcp.json')]) {
          if (removeJsonKey(p, ['mcpServers'], 'botmux')) {
            logger.info(`[legacy-mcp] Removed botmux entry from ${p}`);
          }
        }
        break;
      }
      case 'opencode':
      case 'mtr': {
        // ~/.config/opencode/{opencode,mtr}.json → { mcp: { botmux } } or { mcpServers: { botmux } }
        const file = cliId === 'mtr' ? 'mtr.json' : 'opencode.json';
        const p = join(home, '.config', 'opencode', file);
        const removed =
          removeJsonKey(p, ['mcp'], 'botmux') ||
          removeJsonKey(p, ['mcpServers'], 'botmux') ||
          removeJsonKey(p, ['mcp', 'servers'], 'botmux');
        if (removed) logger.info(`[legacy-mcp] Removed botmux entry from ${p}`);
        break;
      }
      case 'coco':
      case 'codex':
      case 'gemini': {
        // These CLIs managed MCP via their own subcommand.  Skip silently if
        // the binary isn't on PATH — nothing to clean then.
        if (tryCliMcpRemove(cliId)) {
          logger.info(`[legacy-mcp] Ran \`${cliId} mcp remove botmux\``);
        }
        break;
      }
    }
  } catch (err) {
    logger.debug(`[legacy-mcp] Cleanup for ${cliId} failed (ignored): ${err}`);
  }
}

/**
 * Ensure per-CLI environment is set up for this daemon lifecycle: install
 * built-in skills and clean up any legacy MCP server registration.
 * Both steps are idempotent and best-effort.
 */
export function ensureCliEnv(cliId: CliId, cliPathOverride?: string): void {
  cleanupGlobalBotmuxSkillsOnce();
  ensureCliSkills(cliId, cliPathOverride);
  cleanupLegacyMcpConfig(cliId);
}

let globalBotmuxSkillsCleaned = false;
/** One-time, CLI-independent cleanup of botmux skills that older versions
 *  installed into the global `~/.claude/skills`. Claude now injects skills via
 *  `--plugin-dir`, so any leftover `botmux-*` there leaks into the user's
 *  standalone `claude` regardless of which CLI THIS daemon's bot uses — so the
 *  cleanup must NOT be gated on `adapter.pluginDir` (which only fires for a
 *  Claude bot). Runs at daemon startup via ensureCliEnv. */
function cleanupGlobalBotmuxSkillsOnce(): void {
  if (globalBotmuxSkillsCleaned) return;
  globalBotmuxSkillsCleaned = true;
  removeGlobalBotmuxSkills('~/.claude/skills');
}

// ─── Claude Code folder-trust pre-acceptance ─────────────────────────────────
//
// A freshly spawned `claude` in a workingDir that has never been trusted blocks
// on the interactive "Do you trust the files in this folder?" dialog. botmux
// can't answer it — it then mistypes the user's first message into the dialog
// and the session breaks (surfaced as `tmux send-keys … failed`). There is no
// CLI flag to skip it (Claude only auto-skips trust in non-interactive `-p` /
// non-TTY mode, which botmux is not), so we pre-seed the acceptance.

/** Pre-accept Claude Code's per-project folder-trust dialog for `workingDir`.
 *  Claude keys trust off realpath(cwd) (its getcwd(3) is already realpath'd),
 *  so seed that path. Merge-safe + best-effort: only ADDS the flag, never
 *  clobbers other keys; any failure is swallowed so it can't block spawn. */
export function ensureClaudeFolderTrust(workingDir: string, stateJsonPath: string = join(homedir(), '.claude.json')): void {
  try {
    const configPath = stateJsonPath;
    let canonical: string;
    try { canonical = realpathSync(workingDir); } catch { canonical = workingDir; }

    let data: any = {};
    if (existsSync(configPath)) {
      try { data = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { return; }
    }
    if (!data || typeof data !== 'object') return;
    if (!data.projects || typeof data.projects !== 'object') data.projects = {};

    const entry = data.projects[canonical] && typeof data.projects[canonical] === 'object'
      ? data.projects[canonical]
      : (data.projects[canonical] = {});
    if (entry.hasTrustDialogAccepted === true) return; // already trusted — skip write

    entry.hasTrustDialogAccepted = true;
    // 原子写：~/.claude.json 是 Claude Code 的热状态文件，所有并发 claude
    // 实例都在读写，裸写半截会弄坏它们的状态。
    atomicWriteFileSync(configPath, JSON.stringify(data, null, 2));
    logger.info(`[claude-trust] Pre-accepted folder trust for ${canonical}`);
  } catch (err) {
    logger.debug(`[claude-trust] seed failed (ignored): ${err}`);
  }
}

// ─── Kill worker ────────────────────────────────────────────────────────────

export function killWorker(ds: DaemonSession): void {
  clearUsageLimitState(ds);
  if (!ds.worker || ds.worker.killed) {
    // No live worker to receive {type:'close'}, so its destroySession() — which
    // tears down the persistent backing session (tmux/herdr/zellij) — never
    // fires. Those sessions survive a worker exit BY DESIGN (idle-suspend /
    // lazy-restore keep the CLI alive for later resume), so /close on such a
    // session would leave an orphaned CLI running in tmux that still replies.
    // Destroy the backing session directly here so /close always terminates it.
    destroyOrphanedBackingSession(ds);
    return;
  }
  try {
    ds.worker.send({ type: 'close' } as DaemonToWorker);
  } catch { /* IPC already closed */ }
  const w = ds.worker;
  armWorkerKillBackstop(w, tag(ds));
  ds.worker = null;
  ds.workerPort = null;
  ds.workerToken = null;
}

/**
 * Tear down a persistent backing session (tmux/herdr/zellij) directly from the
 * daemon when there is no live worker to do it via the 'close' IPC. The session
 * name is deterministic from the session UUID, and each killSession() is a no-op
 * if the session is already gone.
 *
 * Adopt sessions are skipped: botmux never owned the user's pane (ownsSession is
 * false worker-side too), so killing it would violate the bridge invariant of
 * leaving the user's own CLI untouched.
 */
function destroyOrphanedBackingSession(ds: DaemonSession): void {
  if (ds.initConfig?.adoptMode || ds.adoptedFrom) return;
  reclaimParkedCrashDiagnostic(ds);
  const backendType = getSessionPersistentBackendType(ds);
  if (!backendType) return;
  try {
    killPersistentSession(backendType, persistentSessionName(backendType, ds.session.sessionId));
    logger.info(`[${tag(ds)}] killWorker: no live worker — destroyed orphaned ${backendType} backing session`);
  } catch (err) {
    logger.warn(`[${tag(ds)}] killWorker: failed to destroy orphaned ${backendType} backing session: ${err}`);
  }
}

/**
 * Reclaim a session's parked crash-diagnostic shell (`bmx-diag-<sid>`) and its
 * captured `.ansi` file. The worker normally tears these down itself (killCli /
 * suspend / next-message retry), but it CAN'T when it is hard-killed
 * (OOM/SIGKILL) while parked — then the daemon must do it, on the next refork
 * (forkWorker) or on close (destroyOrphanedBackingSession). Both ops are no-ops
 * when absent, so this is safe to call unconditionally for tmux sessions.
 */
function reclaimParkedCrashDiagnostic(ds: DaemonSession): void {
  if (getSessionPersistentBackendType(ds) !== 'tmux') return;
  try { TmuxBackend.killSession(TmuxBackend.diagnosticSessionName(ds.session.sessionId)); } catch { /* benign */ }
  try { unlinkSync(join(config.session.dataDir, 'crash-diagnostics', `${ds.session.sessionId}.ansi`)); } catch { /* absent — benign */ }
}

export function suspendWorker(ds: DaemonSession, reason = 'suspended_idle'): boolean {
  if (!ds.worker || ds.worker.killed) return false;
  if (!isSuspendableBackendType(ds.initConfig?.backendType)) return false;

  const w = ds.worker;
  try {
    w.send({ type: 'suspend' } as DaemonToWorker);
  } catch {
    try { w.kill('SIGTERM'); } catch { /* already gone */ }
  }
  armWorkerKillBackstop(w, tag(ds));

  ds.worker = null;
  ds.workerPort = null;
  ds.workerToken = null;
  ds.session.webPort = undefined;
  // The worker's suspend handler destroys the backing session + CLI (frees
  // memory), so there is no live CLI to reattach to: the next turn MUST
  // cold-resume from the on-disk transcript. forkWorker(resume=true) builds the
  // CLI's `--resume <cliSessionId>` args, so mark this session as having history
  // (the normal `claude_exit` path that sets this never fires on suspend —
  // process.exit(0) races it). Also persist `suspendedColdResume` so a daemon
  // restart treats a 'missing' backing session as a deliberate lazy-resume
  // rather than a zombie to close. See sweepIdleWorkers + restoreActiveSessions.
  ds.hasHistory = true;
  ds.session.suspendedColdResume = true;
  sessionStore.updateSessionPid(ds.session.sessionId, null);
  sessionStore.updateSession(ds.session);

  if (!ds.exitEventEmitted) {
    ds.exitEventEmitted = true;
    dashboardEventBus.publish({
      type: 'session.exited',
      body: { sessionId: ds.session.sessionId, reason },
    });
  }
  logger.info(`[${tag(ds)}] Worker + CLI suspended (${reason}); session stays active, cold-resumes from transcript on next message`);
  return true;
}

function armWorkerKillBackstop(w: ChildProcess, label: string): void {
  const sigterm = setTimeout(() => {
    if (w.exitCode === null && w.signalCode === null) {
      try { w.kill('SIGTERM'); } catch { /* already gone */ }
    }
  }, WORKER_SIGTERM_BACKSTOP_MS);
  const sigkill = setTimeout(() => {
    if (w.exitCode === null && w.signalCode === null) {
      logger.warn(`[${label}] worker did not exit after SIGTERM; escalating to SIGKILL`);
      try { w.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }, WORKER_SIGKILL_BACKSTOP_MS);
  sigterm.unref?.();
  sigkill.unref?.();
  w.once('exit', () => {
    clearTimeout(sigterm);
    clearTimeout(sigkill);
  });
}

// ─── Idempotent session close (dashboard IPC) ───────────────────────────────

/**
 * Idempotent close: kill worker if alive, mark Session status='closed' + closedAt,
 * publish session.exited (if a live worker was killed) and session.update
 * (if the persistence row transitioned to closed).
 *
 * Calling this on an unknown sessionId, an already-closed session, or a session
 * whose worker died asynchronously must still resolve with `{ ok: true }`.
 */
export async function closeSession(
  sessionId: string,
): Promise<{ ok: true; alreadyClosed: boolean }> {
  const ds = findActiveBySessionId(sessionId);
  let killedLive = false;
  // 会话关闭即可回收其崩溃重启计数；否则每个曾崩溃过的 session 会在 daemon
  // 生命周期内永久占位（restartCounts 此前无任何 delete）。
  restartCounts.delete(sessionId);
  if (ds) {
    // Usage ledger: flush the final delta before the worker goes away (a
    // crash/limited turn may never have reached an idle edge).
    recordUsageForDaemonSession(ds);
    killWorker(ds);
    // 文档订阅清理：会话关闭即退订其绑定的所有文档（飞书侧退订 + 删注册表），
    // 否则该文档之后的评论会变成「命中订阅但无活跃会话」而被丢弃。
    try {
      const anchor = sessionAnchorId(ds);
      const subs = listDocSubscriptionsForSession(config.session.dataDir, ds.larkAppId, anchor);
      for (const sub of subs) {
        await unsubscribeDocFile(ds.larkAppId, { fileToken: sub.fileToken, fileType: sub.fileType });
        removeDocSubscription(config.session.dataDir, ds.larkAppId, sub.fileToken);
      }
      if (subs.length) logger.info(`[doc-comment] session ${sessionId.slice(0, 8)} closed → unsubscribed ${subs.length} doc(s)`);
    } catch (err: any) {
      logger.warn(`[doc-comment] cleanup on close failed for ${sessionId.slice(0, 8)}: ${err?.message ?? err}`);
    }
    activeSessionsRegistry?.delete(sessionKey(sessionAnchorId(ds), ds.larkAppId));
    killedLive = true;
    if (!ds.exitEventEmitted) {
      ds.exitEventEmitted = true;
      dashboardEventBus.publish({
        type: 'session.exited',
        body: { sessionId, reason: 'dashboard_close' },
      });
      emitSessionLifecycleHook(ds, 'session.exit', { reason: 'dashboard_close' });
    }
  }

  // Persistence path — load → mark closed → save (delegated to sessionStore).
  const stored = sessionStore.getSession(sessionId);
  const wasOpen = !!stored && stored.status !== 'closed';
  if (wasOpen) {
    sessionStore.closeSession(sessionId);
    const after = sessionStore.getSession(sessionId);
    dashboardEventBus.publish({
      type: 'session.update',
      body: {
        sessionId,
        patch: {
          status: 'closed',
          closedAt: after?.closedAt ? Date.parse(after.closedAt) : Date.now(),
          tokenUsage: after ? composeRowFromClosed(after).tokenUsage : null,
        },
      },
    });
  }

  // alreadyClosed = nothing happened on either path.
  const alreadyClosed = !killedLive && !wasOpen;
  return { ok: true, alreadyClosed };
}

/**
 * Set an entry on an active-sessions Map, but if the key is already occupied
 * by a DIFFERENT DaemonSession, close that occupant first. Replaces bare
 * `activeSessions.set(key, ds)` at sites where a silent overwrite would leak
 * the prior entry's worker + leave its store row stuck in `status='active'`.
 *
 * The Map is passed explicitly so callers operate on the same instance they
 * already hold (restoreActiveSessions takes the daemon's Map as a parameter;
 * transferSession reaches it through `activeSessionsRegistry`). In production
 * both refer to the same object — the daemon registers its Map at boot — but
 * decoupling avoids module-state assumptions in tests.
 *
 * Canonical collision case: restoreActiveSessions at daemon boot iterating
 * two on-disk active sessions that resolve to the same chat-scope key (e.g.
 * a /relay command's scratch session + the real session that was transferred
 * into the same chat by a prior daemon run). Without this helper the later
 * iterated entry silently wins, the earlier one becomes a ghost-active.
 *
 * Setting the same `ds` at its own key is a no-op (no close).
 */
export async function setActiveSessionSafe(
  map: Map<string, DaemonSession>,
  key: string,
  ds: DaemonSession,
): Promise<void> {
  const prev = map.get(key);
  if (prev && prev !== ds) {
    logger.warn(
      `[setActiveSessionSafe] key already occupied by ${prev.session.sessionId.substring(0, 8)} ` +
      `(worker=${prev.worker ? 'live' : 'null'}); closing it before set`,
    );
    await closeSession(prev.session.sessionId);
  }
  map.set(key, ds);
}

// ─── Session transfer (cross-chat relay) ────────────────────────────────────

/**
 * Transfer an active session from its current chat to a new chat. The CLI
 * process keeps running inside its tmux session — only the routing fields
 * (chatId, rootMessageId, scope) and activeSessions key are rewritten. After
 * the rewrite, forkWorker spawns a new worker that re-attaches to the same
 * `bmx-<sessionId>` tmux, so the AI's transcript continues without break.
 *
 * Visible side effects:
 *   - Lark messages in the *source* chat remain where they were — we have no
 *     API to move them. Only the worker's *routing* moves; the AI's memory
 *     follows via the CLI's persistent jsonl on disk.
 *   - Cards posted by the prior worker stay in the source chat. We clear
 *     streamCardId/Nonce/imageKey so the new worker posts fresh cards in the
 *     target chat instead of trying to PATCH unreachable old ones.
 *
 * Pre-conditions (entry guards, all checked synchronously up-front — no
 * idle-wait loop; busy workers are refused immediately so the caller can
 * report a deterministic outcome and the user retries when the worker
 * quiets):
 *   - Session must be currently active (live worker + activeSessions entry)
 *   - Source must not be a pendingRepo placeholder (no CLI ever started)
 *   - Source must not be an adopted external-tmux session
 *   - Source worker must be in idle/limited (or already dead) — otherwise
 *     refuse with `worker_busy`
 *   - Target chat must not already host a real chat-scope session for the
 *     same bot (`target_chat_has_session`). Scratch (worker:null) occupants
 *     are NOT a conflict — they're command-time placeholders and we close
 *     them in-line to free the slot before continuing.
 *
 * Idempotent for `same_chat`: returns error without side effects when the
 * source chat equals the target chat.
 */
export async function transferSession(
  sessionId: string,
  targetChatId: string,
  targetRootMessageId: string,
  /**
   * Target chat type.
   *   'group' → topic groups are supported via `targetScope: 'thread'`;
   *             `/relay --create` builds the target by createGroupWithBots so
   *             it's a regular group by construction; the cross-daemon
   *             migrate-to-chat IPC inherits the same target.
   *   'p2p'   → the bot's DM. Flat DMs (p2pMode 'chat') land chat-scope on the
   *             chatId anchor; thread-mode DMs land thread-scope on a DM 话题
   *             root. The session's chatType flips with the move so post-relay
   *             inbound routing / picker labels / reply targeting treat it as
   *             a DM. Carried from the picker card's `target_chat_type`.
   * The runtime check just below catches raw-string casting at module
   * boundaries (mocks, HTTP body parses, future bypasses).
   */
  targetChatType: 'group' | 'p2p',
  /**
   * Target routing scope for the relayed session.
   *   'chat'   → anchor = chatId (flat top-level; `/relay --create`, migrate
   *              IPC, and普通群 flat-mode picker all use this — current behavior).
   *   'thread' → anchor = `targetRootMessageId` (a Lark 话题/thread); replies
   *              go reply_in_thread. Picker computes this via
   *              resolveRelayTargetRouting for 话题群 / new-topic / shared /
   *              线程内回复.
   */
  targetScope: 'thread' | 'chat',
  opts?: {
    /** @internal Override for tests — the real implementation forks a child
     *  process and tries to attach to tmux, neither of which is appropriate
     *  in a unit test environment. Defaults to module-level forkWorker. */
    forkWorkerImpl?: typeof forkWorker;
    /** @internal Override for tests — mirror of forkWorkerImpl for killWorker. */
    killWorkerImpl?: typeof killWorker;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Depth defense — unreachable per TS narrowing above, but guards against
  // raw-string casting at module boundaries (mocks, HTTP body parses, etc.).
  if ((targetChatType as string) !== 'group' && (targetChatType as string) !== 'p2p') {
    return { ok: false, error: 'target_chat_type_unsupported' };
  }
  const ds = findActiveBySessionId(sessionId);
  if (!ds) return { ok: false, error: 'session_not_active' };
  // Anchor-based identity. A thread-scope session in the SAME chat (different
  // root) is a legitimate cross-topic move, so we refuse only when the target
  // anchor equals the source anchor (relaying a session onto itself). Replaces
  // the old `targetChatId === ds.chatId → same_chat` check, which would have
  // blocked同群话题间搬运.
  const sourceAnchor = sessionAnchorId(ds);
  const targetAnchor = targetScope === 'chat' ? targetChatId : targetRootMessageId;
  if (targetAnchor === sourceAnchor) return { ok: false, error: 'same_anchor' };

  // pendingRepo: the user created a session via M0 but hasn't picked a repo
  // yet, so worker is null and the CLI has never run. Relaying produces an
  // empty new-chat session with no AI memory — refuse so the user finishes
  // setup in the original chat first.
  if (ds.pendingRepo) return { ok: false, error: 'not_started_yet' };

  // Depth defense: daemon-command scratch (worker:null + no persisted CLI
  // markers) must not be migrated. Upstream paths (picker filter, card-
  // handler confirm preflight, /relay --create leader guard) should already
  // refuse these — this catches any caller that bypassed all three (e.g.
  // a future code path, a direct dashboard IPC, a test reaching in
  // manually). Using `isRelayableRealSession` instead of `ds.hasHistory`
  // makes the predicate survive restoreActiveSessions which currently sets
  // hasHistory:true unconditionally (session-manager.ts:618).
  if (!isRelayableRealSession(ds)) return { ok: false, error: 'not_started_yet' };

  // Adopt sessions wrap a CLI process that botmux didn't spawn — the user
  // owns it inside their own tmux pane, so moving routing here would be
  // surprising and we don't control the tmux session's lifecycle. Refuse.
  if (ds.session.adoptedFrom) return { ok: false, error: 'adopt_not_relayable' };

  // Busy worker: refuse immediately rather than waiting. An idle-wait loop
  // (previously 60s) created an asymmetry with the peer-dispatch HTTP
  // timeout (5s) — peer's transferSession was still polling while the
  // leader had already abort+report 'busy', producing reports that
  // disagreed with reality. Cleaner contract: refuse on first miss, let
  // the user retry when the turn settles.
  const st = ds.lastScreenStatus;
  if (ds.worker && !ds.worker.killed && st !== 'idle' && st !== 'limited') {
    return { ok: false, error: 'worker_busy' };
  }

  // Existing-session guard: a session sharing the *target anchor* would
  // collide on sessionKey(targetAnchor, larkAppId) after the rewrite, and
  // Map.set would silently orphan the prior entry's worker. We split the
  // collision predicate two ways:
  //   - real session (worker !== null): refuse the transfer
  //   - scratch session (worker === null): a daemon-command placeholder
  //     (e.g. the /relay command itself created one when typed in this
  //     chat); the slot is logically free, but the placeholder lingers in
  //     the store with status='active'. Collect and close it so the post-
  //     transfer Map.set doesn't silently overwrite it (which leaves the
  //     scratch as a ghost-active on next daemon restart — exact bug we're
  //     fixing).
  // Anchor-based: chat-scope anchors on chatId, thread-scope on rootMessageId.
  // Only a session at the target anchor collides — same-chat other-topic
  // sessions have a different anchor and are fine (enables同群话题间搬运).
  const scratchesToClose: string[] = [];
  if (activeSessionsRegistry) {
    for (const existing of activeSessionsRegistry.values()) {
      if (existing === ds) continue;
      if (existing.larkAppId !== ds.larkAppId) continue;
      if (sessionAnchorId(existing) !== targetAnchor) continue;
      if (!existing.worker) {
        scratchesToClose.push(existing.session.sessionId);
        continue;
      }
      return { ok: false, error: 'target_chat_has_session' };
    }
  }
  for (const sid of scratchesToClose) {
    await closeSession(sid);
  }

  const fkw = opts?.forkWorkerImpl ?? forkWorker;
  const kw = opts?.killWorkerImpl ?? killWorker;

  const tagPrefix = sessionId.substring(0, 8);
  const oldAnchor = sessionAnchorId(ds);
  const oldChatId = ds.chatId;

  // Freeze the source-chat streaming card BEFORE we kill the worker (and
  // before we clear streamCardId below). The live card's action buttons
  // (close / toggle / get write link) carry `session_id` in their value, so
  // clicks AFTER relay still reach the now-relocated session — closing it,
  // toggling its display mode, etc. — with feedback landing on the NEW
  // card in the target chat. PATCH the source-chat card to an inert
  // snapshot so the user sees clearly it's historical, and so the buttons
  // are gone. Best-effort: on PATCH failure (card withdrawn, expired) we
  // log and continue; the relay itself must not depend on this.
  if (ds.streamCardId && ds.streamCardId !== CARD_POSTING_SENTINEL) {
    try {
      const cliId = (ds.session.cliId as CliId | undefined)
        ?? (() => { try { return getBot(ds.larkAppId).config.cliId; } catch { return undefined; } })();
      const frozenJson = buildRelayedFrozenCard(
        ds.currentTurnTitle || ds.session.title || '',
        cliId,
        ds.currentImageKey,
        localeForBot(ds.larkAppId),
      );
      await updateMessage(ds.larkAppId, ds.streamCardId, frozenJson);
    } catch (err) {
      logger.warn(`[${tagPrefix}] freeze source-chat card failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Detach worker — TmuxBackend.kill() does NOT destroy the tmux session, so
  // the CLI process and its rolling jsonl continue running.
  kw(ds);
  activeSessionsRegistry?.delete(sessionKey(oldAnchor, ds.larkAppId));

  // Rewrite routing fields per the requested target scope.
  //   chat-scope:   routes by chatId; `targetRootMessageId` (e.g. an M1 id) is
  //                 stored on rootMessageId but is purely audit/UX.
  //   thread-scope: routes by rootMessageId; `targetRootMessageId` IS the
  //                 routing anchor (the Lark 话题 root) — replies reply_in_thread
  //                 to it, and future inbound messages in that 话题 resolve to
  //                 the same anchor.
  ds.session.chatId = targetChatId;
  ds.session.rootMessageId = targetRootMessageId;
  ds.session.scope = targetScope;
  ds.session.chatType = targetChatType;
  ds.session.lastMessageAt = new Date().toISOString();
  // Card state was pinned to the source chat — clear so the new worker posts
  // a fresh card in the target chat instead of trying to PATCH a message that
  // lives in another chat entirely (the source card was just frozen above).
  ds.session.streamCardId = undefined;
  ds.session.streamCardNonce = undefined;
  ds.session.currentImageKey = undefined;

  // Mirror onto runtime DaemonSession.
  ds.chatId = targetChatId;
  ds.chatType = targetChatType;
  ds.scope = targetScope;
  ds.streamCardId = undefined;
  ds.streamCardNonce = undefined;
  ds.currentImageKey = undefined;

  sessionStore.updateSession(ds.session);

  const newAnchor = sessionAnchorId(ds);
  if (activeSessionsRegistry) {
    await setActiveSessionSafe(activeSessionsRegistry, sessionKey(newAnchor, ds.larkAppId), ds);
  }

  dashboardEventBus.publish({
    type: 'session.update',
    body: {
      sessionId,
      patch: {
        chatId: targetChatId,
        rootMessageId: targetRootMessageId,
        scope: targetScope,
        chatType: targetChatType,
      },
    },
  });

  // forkWorker with resume=true — TmuxBackend.spawn detects the surviving
  // `bmx-<sessionId>` session and re-attaches instead of creating a new one.
  fkw(ds, '', /*resume*/true);

  logger.info(
    `[${tagPrefix}] transferred ${oldChatId} → ${targetChatId} ` +
    `(anchor ${oldAnchor.substring(0, 8)} → ${newAnchor.substring(0, 8)})`,
  );
  return { ok: true };
}

// ─── Fork worker ────────────────────────────────────────────────────────────

export function forkWorker(ds: DaemonSession, prompt: string, resume = false): void {
  const cb = requireCallbacks();
  const bot = getBot(ds.larkAppId);
  const botCfg = bot.config;
  // 不变式：一旦真正起 CLI，会话就不再是「待办池(queued)」parked 态。无论由哪条
  // 路径触发（激活按钮 / 拖到进行中 / 群里来消息抢先起会话），都在此清掉 queued
  // 标记并落盘——否则重启后会被当 parked 恢复成 hasHistory:false 而丢掉真历史。
  if (ds.session.queued) {
    ds.session.queued = false;
    ds.session.queuedPrompt = undefined;
    sessionStore.updateSession(ds.session);
  }
  // worker.js lives in the same directory as daemon.js (src/)
  const workerPath = join(__dirname, '..', 'worker.js');
  const t = tag(ds);
  // A fork() whose cwd no longer exists emits an unhandled 'error' (spawn
  // ENOENT) that crashes the WHOLE daemon (→ pm2 crash-loop). Fall back to
  // home so a stale session workingDir can never take the daemon down.
  const rawCwd = cb.getSessionWorkingDir(ds);
  const cwd = rawCwd && existsSync(rawCwd) ? rawCwd : homedir();
  if (cwd !== rawCwd) logger.warn(`[${t}] workingDir "${rawCwd}" does not exist — falling back to ${cwd}`);

  // Materialise the resolved launch dir on the live session. getSessionWorkingDir()
  // falls back to the bot-default workingDir, but the usage ledger and dashboard read
  // `ds.workingDir ?? s.workingDir` RAW (without that fallback). A session that inherits
  // the bot-default workingDir — i.e. one never pinned via /repo or /cd — therefore leaves
  // ds.workingDir undefined, so getSessionTokenUsage() is handed cwd=undefined, cannot
  // locate the CLI transcript, and the session's token usage silently never records.
  // Pinning the resolved cwd here (it equals what the worker actually forked into) closes
  // that gap without touching the persisted session.workingDir "unset = follow default"
  // semantics: this is re-derived on every fork/restore.
  ds.workingDir = cwd;

  // Sandbox decision is RECORDED ON THE SESSION at creation and reused on
  // restore — so toggling the live bot flag never retroactively (un)sandboxes a
  // historical session. A brand-new session (resume=false) with no recorded
  // decision adopts the live bot flag; a restore (resume=true) with no recorded
  // decision predates the sandbox feature → stays NOT sandboxed.
  if (ds.session.sandbox === undefined) {
    if (!resume) {
      ds.session.sandbox = botCfg.sandbox === true;
      ds.session.sandboxHidePaths = botCfg.sandboxHidePaths ?? [];
    } else {
      ds.session.sandbox = false;
      ds.session.sandboxHidePaths = [];
    }
    sessionStore.updateSession(ds.session);
  }

  // Guard against double-fork: if a worker is already running, kill it first
  if (ds.worker && !ds.worker.killed) {
    logger.warn(`[${t}] Worker already running (pid: ${ds.worker.pid}), killing before re-fork`);
    try { ds.worker.send({ type: 'close' } as DaemonToWorker); } catch { /* ignore */ }
    try { ds.worker.kill(); } catch { /* ignore */ }
    ds.worker = null;
    ds.workerPort = null;
    ds.workerToken = null;
  }

  // Re-establishing a worker ends the cold-resume-suspended state: clear the
  // persisted marker so a future restart no longer treats this session's
  // backing as a deliberate-missing (a genuine later zombie must still close).
  if (ds.session.suspendedColdResume) {
    ds.session.suspendedColdResume = undefined;
    sessionStore.updateSession(ds.session);
  }

  // Re-establishing a worker also reclaims any crash-diagnostic shell a prior
  // worker left parked but couldn't clean (hard-killed while parked, daemon
  // still alive → next message reforks here). The fresh CLI spawns under the
  // real bmx-<sid>; without this, bmx-diag-<sid> + its .ansi file would leak.
  if (!ds.initConfig?.adoptMode && !ds.adoptedFrom) reclaimParkedCrashDiagnostic(ds);

  ensureCliEnv(botCfg.cliId, botCfg.cliPathOverride);
  // Claude Code blocks on the interactive folder-trust dialog the first time
  // it runs in an untrusted workingDir; pre-accept it so the spawn doesn't hang.
  // Seed CLI (Claude Code fork) has the same dialog — drive both off the
  // adapter's claude-family fields, writing to each variant's own .claude.json
  // (`~/.claude.json` for claude, `.claude-runtime/.claude.json` for seed).
  const familyAdapter = createCliAdapterSync(botCfg.cliId, botCfg.cliPathOverride);
  if (familyAdapter.claudeStateJsonPath) ensureClaudeFolderTrust(cwd, familyAdapter.claudeStateJsonPath);

  let skillPluginDir: string | undefined;
  let skillReadonlyRoots: string[] | undefined;
  if (!resume && prompt.trim().length > 0) {
    const preparedSkills = prepareSessionSkillPrompt({
      sessionId: ds.session.sessionId,
      cliId: botCfg.cliId,
      workingDir: cwd,
      prompt,
      botPolicy: botCfg.skills,
    });
    prompt = preparedSkills.prompt;
    const delivery = prepareSkillDelivery(familyAdapter, preparedSkills.manifest, preparedSkills.manifest?.delivery ?? 'auto');
    skillPluginDir = delivery.pluginDir;
    skillReadonlyRoots = delivery.readonlyRoots.length ? delivery.readonlyRoots : undefined;
    for (const diagnostic of delivery.diagnostics) logger.warn(`[${t}] skill delivery: ${diagnostic}`);
    if (delivery.fatal) {
      const reason = delivery.diagnostics.join(', ') || 'unknown';
      const message = tr('worker.skill_delivery_failed', { reason }, botLocale(botCfg));
      logger.warn(`[${t}] Skill delivery blocked session start: ${reason}`);
      void cb.sessionReply(sessionAnchorId(ds), message, undefined, ds.larkAppId, fallbackTurnId(ds, undefined))
        .catch((err) => logger.warn(`[${t}] Failed to notify skill delivery error: ${err?.message ?? err}`));
      void closeSession(ds.session.sessionId)
        .catch((err) => logger.warn(`[${t}] Failed to close skill delivery error session: ${err?.message ?? err}`));
      return;
    }
  }

  // Prepend ~/.botmux/bin to PATH so CLIs can call `botmux send` etc.
  // The wrapper script there is written by the daemon at startup.
  const botmuxBinDir = join(homedir(), '.botmux', 'bin');
  const pathWithBotmux = prependBotmuxBin(botmuxBinDir, process.env.PATH);

  const worker = fork(workerPath, [], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    cwd,
    env: {
      ...process.env,
      PATH: pathWithBotmux,
      CLAUDECODE: undefined,
      BOTMUX: '1',  // Marker so user scripts/skills can detect a botmux-spawned CLI
      SESSION_DATA_DIR: config.session.dataDir,
      BOTMUX_SESSION_ID: ds.session.sessionId,
      LARK_APP_ID: botCfg.larkAppId,
      LARK_APP_SECRET: botCfg.larkAppSecret,
    },
  } as WindowsForkOptions);

  // A fork-level failure (spawn ENOENT, etc.) emits 'error'; without a handler
  // the unhandled event crashes the daemon. Log and move on.
  worker.on('error', (err) => {
    logger.error(`[${t}] Worker fork error: ${(err as Error)?.message ?? err}`);
  });

  // Pipe worker stdout/stderr to daemon logger.
  // Both go through logger.info → daemon.log (not error.log). Worker stderr
  // is NOT necessarily an error: CLI adapters (claude, codex, etc.) write
  // progress, version banners, deprecation warnings, etc. there. The line
  // is still visible (tagged `:err`) for triage. Real worker faults arrive
  // separately via the IPC `Worker error` branch and stay as logger.error.
  worker.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n')) {
      const trimmed = line.trim();
      if (trimmed) logger.info(`[${t}:out] ${trimmed}`);
    }
  });
  worker.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n')) {
      logWorkerStderr(t, line.trim());
    }
  });

  // Send init config — use per-bot settings
  const initMsg: DaemonToWorker = {
    type: 'init',
    sessionId: ds.session.sessionId,
    chatId: ds.chatId,
    rootMessageId: sessionAnchorId(ds),
    workingDir: cwd,
    cliId: botCfg.cliId,
    cliPathOverride: botCfg.cliPathOverride,
    wrapperCli: botCfg.wrapperCli,
    model: botCfg.model,
    disableCliBypass: botCfg.disableCliBypass === true,
    // Startup commands run on every fresh spawn (incl. resume) so session-only
    // settings like `/effort ultracode` are re-established. Adopt sessions are
    // observed, not driven — forkAdoptWorker intentionally omits this.
    startupCommands: botCfg.startupCommands,
    // Per-bot env (bots.json `env`) — injected into the CLI process only (e.g.
    // ANTHROPIC_BASE_URL/AUTH_TOKEN for a GLM/3rd-party bot). Adopt sessions are
    // observed, not driven, so forkAdoptWorker intentionally omits it.
    env: botCfg.env,
    // Use the decision recorded on the session (above), NOT the live bot flag, so
    // historical sessions never get retroactively sandboxed on restart.
    sandbox: ds.session.sandbox === true,
    sandboxHidePaths: ds.session.sandboxHidePaths ?? [],
    backendType: botCfg.backendType ?? config.daemon.backendType,
    prompt,
    resume,
    cliSessionId: ds.session.cliSessionId,
    ownerOpenId: ds.ownerOpenId,
    webPort: ds.session.webPort,
    larkAppId: botCfg.larkAppId,
    larkAppSecret: botCfg.larkAppSecret,
    brand: normalizeBrand(botCfg.brand),
    botName: bot.botName,
    botOpenId: bot.botOpenId,
    locale: botLocale(botCfg),
    turnId: ds.currentReplyTarget?.turnId,
    skillPluginDir,
    skillReadonlyRoots,
  };
  worker.send(initMsg);
  ds.initConfig = initMsg;

  // Stamp cliId on the persisted session so the dashboard can show a CLI badge
  // even after the session is closed. Do this before installing worker handlers:
  // a fast worker can emit `ready` immediately after init, and card rendering
  // must see the session-level CLI identity rather than the bot default.
  if (ds.session.cliId !== botCfg.cliId) {
    ds.session.cliId = botCfg.cliId;
    sessionStore.updateSession(ds.session);
  }

  // Use shared handler for IPC messages and exit
  setupWorkerHandlers(ds, worker);

  ds.worker = worker;
  ds.spawnedAt = Date.now();
  ds.cliVersion = currentCliVersion;
  sessionStore.updateSessionPid(ds.session.sessionId, worker.pid ?? null);
  logger.info(`[${t}] Worker forked (pid: ${worker.pid}, active: ${cb.getActiveCount()})`);

  // Reset the exit-emit flag for the freshly spawned worker so a subsequent
  // exit publishes again (the previous lifecycle's flag would otherwise mask it).
  ds.exitEventEmitted = false;
  // Notify dashboard SSE subscribers a new session is live.
  dashboardEventBus.publish({
    type: 'session.spawned',
    body: { session: composeRowFromActive(ds) },
  });
  emitSessionLifecycleHook(ds, 'session.start', {
    reason: resume ? 'resume' : 'worker_spawn',
    pid: worker.pid ?? null,
  });
  // Usage ledger: fresh spawns anchor the baseline so pre-existing transcript
  // history is never billed. Restores reconcile instead — an in-flight turn
  // may have completed inside tmux while the daemon was down, and that work
  // was submitted by botmux (anchoring would swallow it).
  if (resume) reconcileUsageForDaemonSession(ds);
  else anchorUsageForDaemonSession(ds);
  recordOwnershipForDaemonSession(ds);
}

// ─── Shared worker IPC handler ──────────────────────────────────────────────

function setupWorkerHandlers(ds: DaemonSession, worker: ChildProcess): void {
  const cb = requireCallbacks();
  const t = tag(ds);
  // Worker messages without a turn of their own (first streaming card, crash
  // notices) anchor to the session's current reply-target turn so a shared
  // fold-back topic keeps them in-thread instead of leaking top-level.
  const scopedReply = (content: string, msgType?: string, turnId?: string) =>
    cb.sessionReply(sessionAnchorId(ds), content, msgType, ds.larkAppId, fallbackTurnId(ds, turnId));
  const bot = getBot(ds.larkAppId);
  const botCfg = bot.config;
  const loc = botLocale(botCfg);

  // Adopt mode flags — computed once, used in all buildStreamingCard calls.
  // Bridge mode (the v3 default for /adopt) hides the legacy takeover button.
  const isAdopt = !!ds.adoptedFrom;
  const showTakeover = false;

  worker.on('message', async (msg: WorkerToDaemon) => {
    const effectiveCliId = sessionCliId(ds, botCfg);
    switch (msg.type) {
      case 'ready': {
        ds.workerPort = msg.port;
        ds.workerToken = msg.token;
        // Persist port so it can be reused after daemon restart
        ds.session.webPort = msg.port;
        sessionStore.updateSession(ds.session);
        const readOnlyUrl = buildTerminalUrl(ds);
        const writeUrl = buildTerminalUrl(ds, { write: true });
        logger.info(`[${t}] Worker ready, terminal at ${readOnlyUrl}`);
        if (ds.usageLimit) {
          ds.lastScreenStatus = 'limited';
          armUsageLimitRetryTimer(ds);
        }
        // Dashboard: surface the new xterm port so the live terminal link works.
        dashboardEventBus.publish({
          type: 'session.update',
          body: {
            sessionId: ds.session.sessionId,
            patch: { webPort: msg.port },
          },
        });

        // Bot opted out of the streaming card: the terminal is up and the
        // final answer will still arrive via `botmux send`; just don't post the
        // live status card. (workerPort/token above are still set so the web
        // terminal + dashboard keep working.)
        if (streamingCardDisabled(ds)) {
          logger.info(`[${t}] Streaming card disabled for this bot — skipping card post`);
          break;
        }

        // Restart recovery: stay silent in the group. The session was restored
        // after a daemon restart; don't auto-post/patch a streaming card here.
        // The owner gets a private DM summary instead, and the surviving card
        // (if any) is left untouched. The next real user turn clears this flag
        // (rememberLastCliInput) and the normal card flow resumes.
        if (ds.suppressRecoveryCard) {
          logger.info(`[${t}] Restored session — suppressing recovery streaming card (silent restart)`);
          break;
        }

        // If a previous streaming card survived (e.g. daemon restart), try to
        // PATCH it with the new "starting" state instead of POSTing a fresh card.
        // ds.streamCardPending forces a new card (e.g. mid-session repo switch
        // explicitly cleared streamCardId before re-fork — keep that behaviour).
        const restoredCardId =
          ds.streamCardId && ds.streamCardId !== CARD_POSTING_SENTINEL && !ds.streamCardPending
            ? ds.streamCardId
            : undefined;
        if (restoredCardId) {
          try {
            const initTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
            // Reuse persisted nonce so existing card buttons (toggle/etc) keep working.
            if (!ds.streamCardNonce) ds.streamCardNonce = randomBytes(4).toString('hex');
            // Prefer the last-known screen status when we have one — for /relay
            // resume the worker was idle/limited at transfer time and the
            // CLI didn't actually stop, so showing "starting" right after
            // the M1 "已接力" announcement is misleading. Fresh-spawn worker
            // and post-daemon-restart paths still see lastScreenStatus
            // undefined and fall back to 'starting' (unchanged behavior).
            const initStatus = ds.usageLimit ? 'limited' : (ds.lastScreenStatus ?? 'starting');
            const streamCardJson = buildStreamingCard(
              ds.session.sessionId,
              sessionAnchorId(ds),
              readOnlyUrl,
              initTitle,
              ds.lastScreenContent ?? '',
              initStatus,
              effectiveCliId,
              ds.displayMode ?? 'hidden',
              ds.streamCardNonce,
              ds.currentImageKey,
              isAdopt,
              showTakeover,
              loc,
              initStatus === 'limited' ? ds.usageLimit : undefined,
              writableTerminalLinkFor(ds),
            );
            await updateMessage(ds.larkAppId, restoredCardId, streamCardJson);
            persistStreamCardState(ds);
            // Re-sync worker's display mode (it starts fresh in 'hidden')
            if (ds.worker && ds.displayMode && ds.displayMode !== 'hidden') {
              ds.worker.send({ type: 'set_display_mode', mode: ds.displayMode } as DaemonToWorker);
            }
            // The restored card is now the active one — withdraw any cards
            // frozen before the daemon went down so they don't pile up in the
            // thread on each restart.
            recallFrozenCards(ds);
            logger.info(`[${t}] Reused existing streaming card ${restoredCardId.substring(0, 12)} after worker (re)start`);
            break;
          } catch (err) {
            // PATCH failed (withdrawn, expired, etc.) — fall through to POST a fresh card.
            logger.info(`[${t}] Failed to reuse existing streaming card (${err instanceof Error ? err.message : err}), posting new one`);
            ds.streamCardId = undefined;
            persistStreamCardState(ds);
          }
        }

        // Send streaming card to group thread (read-only link, will be PATCHed with live output)
        // Set sentinel BEFORE await so concurrent screen_update messages
        // (which can arrive while the POST is in-flight) don't POST a duplicate card.
        ds.streamCardId = CARD_POSTING_SENTINEL;
        try {
          ds.streamCardNonce = randomBytes(4).toString('hex');
          const initTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
          // See PATCH-branch comment above re: lastScreenStatus preference.
          // For relay (kill+fork with surviving tmux/CLI), this avoids the
          // jarring "启动中" right after the M1 "已接力" announcement.
          const initStatus = ds.usageLimit ? 'limited' : (ds.lastScreenStatus ?? 'starting');
          const streamCardJson = buildStreamingCard(
            ds.session.sessionId,
            sessionAnchorId(ds),
            readOnlyUrl,
            initTitle,
            // For /relay resume, ds.lastScreenContent is the cached pane
            // from before the kill+fork — using it avoids a blank flash
            // before the first screen_update lands. Fresh worker spawn
            // has lastScreenContent undefined → '' (unchanged).
            ds.lastScreenContent ?? '',
            initStatus,
            effectiveCliId,
            ds.displayMode ?? 'hidden',
            ds.streamCardNonce,
            ds.currentImageKey,
            isAdopt,
            showTakeover,
            loc,
            initStatus === 'limited' ? ds.usageLimit : undefined,
            writableTerminalLinkFor(ds),
          );
          ds.streamCardId = await scopedReply(streamCardJson, 'interactive', msg.turnId);
          // This card IS the current turn's live card — clear the new-turn flag
          // so subsequent screen_updates PATCH it (starting → working) instead of
          // POSTing a second card. Without this, a re-fork that happens while
          // streamCardPending is true (new turn + worker had exited) leaves the
          // flag set, the next screen_update takes the new-card POST branch, and
          // this "starting" card is orphaned (never entered frozenCards, so
          // recallFrozenCards can't withdraw it). Mirrors the screen_update POST
          // branch which clears the flag after posting.
          ds.streamCardPending = false;
          persistStreamCardState(ds);
          // Re-sync worker's display mode (it starts fresh in 'hidden')
          if (ds.worker && ds.displayMode && ds.displayMode !== 'hidden') {
            ds.worker.send({ type: 'set_display_mode', mode: ds.displayMode } as DaemonToWorker);
          }
          // New card is live — recall any cards frozen by previous turns.
          // Done after `streamCardId` is committed so we never delete the old
          // card without a successor visible to the user.
          recallFrozenCards(ds);
        } catch (err) {
          if (err instanceof MessageWithdrawnError) {
            logger.warn(`[${t}] Root message withdrawn, closing stale session`);
            killWorker(ds);
            cb.closeSession(ds);
            break;
          }
          logger.warn(`[${t}] Failed to send streaming card, falling back to static card: ${err}`);
          // Clear sentinel so screen_updates can create a streaming card later
          ds.streamCardId = undefined;
          persistStreamCardState(ds);
          // Fallback: send static session card
          try {
            const cardJson = buildSessionCard(
              ds.session.sessionId,
              sessionAnchorId(ds),
              readOnlyUrl,
              ds.session.title || getCliDisplayName(effectiveCliId),
              effectiveCliId,
              undefined,
              !!ds.adoptedFrom,
              loc,
            );
            await scopedReply(cardJson, 'interactive', msg.turnId);
          } catch (fallbackErr) {
            if (fallbackErr instanceof MessageWithdrawnError) {
              logger.warn(`[${t}] Root message withdrawn, closing stale session`);
              killWorker(ds);
              cb.closeSession(ds);
              break;
            }
            throw fallbackErr;
          }
        }

        break;
      }

      case 'prompt_ready': {
        logger.info(`[${t}] ${getCliDisplayName(effectiveCliId)} is ready for input`);
        // A live prompt means a (re)spawn reached a working CLI — clear the lazy
        // cold-resume marker set when we parked a crash diagnostic shell. The
        // common retry path respawns IN-PLACE (worker.ts case 'message'), not via
        // forkWorker, so without this the stale marker survives in the store and a
        // LATER genuine zombie (bmx-<sid> actually gone) would be kept active by
        // restore instead of being closed. If retry never reaches a prompt the
        // marker persists, preserving the cross-daemon-restart lazy-retry intent.
        if (ds.session.suspendedColdResume) {
          ds.session.suspendedColdResume = undefined;
          sessionStore.updateSession(ds.session);
        }
        if (ds.pendingRawInput && ds.worker && !ds.worker.killed) {
          const rawInput = ds.pendingRawInput;
          ds.pendingRawInput = undefined;
          // Input buffered while the repo card was pending rides on the SAME
          // IPC: worker message handlers run concurrently (async handlers
          // don't serialize), so a separate `message` IPC could write into
          // the PTY during raw_input's 200ms text→Enter beat. The worker
          // enqueues followUpContent only after the Enter landed.
          const followUp = ds.pendingFollowUpInput;
          ds.pendingFollowUpInput = undefined;
          ds.worker.send({
            type: 'raw_input',
            content: rawInput,
            followUpContent: followUp?.cliInput,
          } as DaemonToWorker);
          logger.info(`[${t}] Sent pending raw input after prompt_ready: ${rawInput.substring(0, 80)}${followUp ? ` (+follow-up ${followUp.cliInput.length} chars)` : ''}`);
          if (followUp) rememberLastCliInput(ds, followUp.userPrompt, followUp.cliInput);
        }
        break;
      }

      case 'cli_session_id': {
        ds.session.cliSessionId = msg.cliSessionId;
        sessionStore.updateSession(ds.session);
        // Usage ledger: publish ownership the moment the CLI-native session id
        // is known, so consumers exclude this session from native parsers
        // before its first positive-delta record exists.
        recordOwnershipForDaemonSession(ds);
        break;
      }

      case 'screen_update': {
        if (!ds.workerPort) break;
        const prevStatus = ds.lastScreenStatus;
        updateUsageLimitState(ds, msg.usageLimit);
        ds.lastScreenContent = msg.content;
        ds.lastScreenStatus = (msg.usageLimit ?? ds.usageLimit) ? 'limited' : msg.status;

        // Dashboard: publish a patch only when status truly transitioned, so
        // SSE clients reflect real state changes (starting → working → idle)
        // without flooding on every PTY tick. The screen analyzer is the
        // upstream debouncer — by the time we get here, status flips are
        // already coarse-grained.
        if (prevStatus !== ds.lastScreenStatus) {
          dashboardEventBus.publish({
            type: 'session.update',
            body: {
              sessionId: ds.session.sessionId,
              patch: {
                status: ds.lastScreenStatus,
                lastMessageAt: ds.lastMessageAt,
                tokenUsage: composeRowFromActive(ds).tokenUsage,
              },
            },
          });
          emitSessionStateTransitionHook(ds, prevStatus, ds.lastScreenStatus, {
            source: 'screen_update',
            content: msg.content,
          });
          // Usage ledger + turn reactions: idle/limited edges are turn
          // boundaries. Append the token delta, and flip this turn's pending ✋
          // reactions to ✅ (best-effort, never blocks the status pipeline).
          if (ds.lastScreenStatus === 'idle' || ds.lastScreenStatus === 'limited') {
            recordUsageForDaemonSession(ds);
            void finishTurnReactions(ds);
            callbacks?.onSessionIdleOrExit?.(ds, ds.lastScreenStatus === 'limited' ? 'limited' : 'idle');
          }
        }

        // Bot opted out of the streaming card — dashboard SSE above already got
        // the status patch; just don't touch any Lark card.
        if (streamingCardDisabled(ds)) break;

        // Restart recovery: a restored worker may emit screen updates as the CLI
        // redraws on resume. Stay silent (no post/patch) until the first real
        // user turn clears the flag. Dashboard SSE above still reflects status.
        if (ds.suppressRecoveryCard) break;

        const readUrl = buildTerminalUrl(ds);
        const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
        const mode: DisplayMode = ds.displayMode ?? 'hidden';

        if (ds.streamCardPending || !ds.streamCardId) {
          // If a POST is already in-flight, drop this update — it will be
          // picked up by subsequent screen_updates once the card ID lands.
          if (ds.streamCardId === CARD_POSTING_SENTINEL) break;

          // New turn — create a fresh card, old card freezes at its last state.
          // Generate new nonce so old card buttons are distinguishable.
          const isNewTurn = !!ds.streamCardPending;
          ds.streamCardNonce = randomBytes(4).toString('hex');
          // New turn → image_key from previous turn no longer valid
          if (isNewTurn) ds.currentImageKey = undefined;
          const cardJson = buildStreamingCard(
            ds.session.sessionId,
            sessionAnchorId(ds),
            readUrl,
            turnTitle,
            isNewTurn ? '' : msg.content,
            ds.lastScreenStatus,
            effectiveCliId,
            mode,
            ds.streamCardNonce,
            ds.currentImageKey,
            isAdopt,
            showTakeover,
            loc,
            cardUsageLimit(ds),
            writableTerminalLinkFor(ds),
          );
          // Mark POST in-flight so subsequent screen_updates are dropped,
          // not POSTed as duplicate cards.
          ds.streamCardPending = false;
          ds.streamCardId = CARD_POSTING_SENTINEL;
          scopedReply(cardJson, 'interactive', msg.turnId)
            .then(msgId => {
              ds.streamCardId = msgId;
              persistStreamCardState(ds);
              // New card live — recall any cards parked by previous turns
              // (user message, bot @mention, adopt-bridge new turn, etc.).
              // This is the main turn-to-turn POST path; without recall here,
              // every long session would leak old streaming cards into the
              // thread.
              recallFrozenCards(ds);
            })
            .catch(err => {
              if (err instanceof MessageWithdrawnError) {
                logger.warn(`[${t}] Root message withdrawn, closing stale session`);
                killWorker(ds);
                cb.closeSession(ds);
                return;
              }
              logger.debug(`[${t}] Failed to create streaming card: ${err}`);
              ds.streamCardId = undefined;
              persistStreamCardState(ds);
            });
        } else {
          // Same turn — PATCH only on status change. Image PATCHes go through
          // the screenshot_uploaded path; text is no longer a card body mode.
          const statusChanged = prevStatus !== ds.lastScreenStatus;
          if (!statusChanged) break;
          const cardJson = buildStreamingCard(
            ds.session.sessionId,
            sessionAnchorId(ds),
            readUrl,
            turnTitle,
            msg.content,
            ds.lastScreenStatus,
            effectiveCliId,
            mode,
            ds.streamCardNonce,
            ds.currentImageKey,
            isAdopt,
            showTakeover,
            loc,
            cardUsageLimit(ds),
            writableTerminalLinkFor(ds),
          );
          scheduleCardPatch(ds, cardJson);
        }
        break;
      }

      case 'screenshot_uploaded': {
        // Drop uploads that arrived during a new-turn handoff — the image_key may
        // reflect previous turn's content. Next 10s cycle picks up fresh content.
        if (ds.streamCardPending) break;
        ds.currentImageKey = msg.imageKey;
        const prevStatus = ds.lastScreenStatus;
        updateUsageLimitState(ds, msg.usageLimit);
        ds.lastScreenStatus = (msg.usageLimit ?? ds.usageLimit) ? 'limited' : msg.status;
        emitSessionStateTransitionHook(ds, prevStatus, ds.lastScreenStatus, {
          source: 'screenshot_uploaded',
          imageKey: msg.imageKey,
          content: ds.lastScreenContent ?? '',
        });
        persistStreamCardState(ds);
        if ((ds.displayMode ?? 'hidden') !== 'screenshot') break;
        if (!ds.streamCardId || ds.streamCardId === CARD_POSTING_SENTINEL || !ds.workerPort) break;
        const readUrl = buildTerminalUrl(ds);
        const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
        const cardJson = buildStreamingCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          readUrl,
          turnTitle,
          ds.lastScreenContent ?? '',
          ds.lastScreenStatus,
          effectiveCliId,
          'screenshot',
          ds.streamCardNonce,
          ds.currentImageKey,
          isAdopt,
          showTakeover,
          loc,
          cardUsageLimit(ds),
          writableTerminalLinkFor(ds),
        );
        scheduleCardPatch(ds, cardJson);
        break;
      }

      case 'tui_prompt': {
        // AI detected an interactive TUI prompt — post card to thread
        // Dedup: if a card is already posted for this session, skip
        if (ds.tuiPromptCardId) {
          logger.debug(`[${t}] TUI prompt card already posted, skipping duplicate`);
          break;
        }
        logger.info(`[${t}] TUI prompt detected: ${msg.description}${msg.multiSelect ? ' (multi-select)' : ''}`);
        ds.tuiPromptOptions = msg.options;
        ds.tuiPromptMultiSelect = msg.multiSelect;
        ds.tuiToggledIndices = [];
        emitSessionLifecycleHook(ds, 'session.requires_attention', {
          reason: 'tui_prompt',
          description: msg.description,
          optionsCount: msg.options.length,
          optionsPreview: msg.options.slice(0, 5).map(option => ({
            text: option.text,
            label: option.label,
            type: option.type,
            selected: option.selected,
          })),
          multiSelect: msg.multiSelect,
        });
        const prevTuiTurnTitle = ds.currentTurnTitle;
        ds.currentTurnTitle = msg.description;  // store for card PATCH on toggle
        if (prevTuiTurnTitle !== ds.currentTurnTitle) {
          dashboardEventBus.publish({
            type: 'session.update',
            body: {
              sessionId: ds.session.sessionId,
              patch: { title: ds.currentTurnTitle },
            },
          });
        }
        try {
          const cardJson = buildTuiPromptCard(
            sessionAnchorId(ds),
            ds.session.sessionId,
            msg.description,
            msg.options,
            msg.multiSelect,
            undefined,
            loc,
          );
          const cardMsgId = await scopedReply(cardJson, 'interactive', msg.turnId);
          ds.tuiPromptCardId = cardMsgId;
          publishAttentionPatch(ds);
        } catch (err) {
          logger.warn(`[${t}] Failed to post TUI prompt card: ${err}`);
        }
        break;
      }

      case 'tui_prompt_resolved': {
        // TUI prompt is no longer showing — update card if it exists
        logger.info(`[${t}] TUI prompt resolved${msg.selectedText ? `: ${msg.selectedText}` : ''}`);
        if (ds.tuiPromptCardId) {
          const resolvedCard = buildTuiPromptResolvedCard(msg.selectedText ?? tr('card.action.tui_done', undefined, loc), loc);
          updateMessage(ds.larkAppId, ds.tuiPromptCardId, resolvedCard).catch(err =>
            logger.debug(`[${t}] Failed to update TUI prompt card: ${err}`),
          );
          ds.tuiPromptCardId = undefined;
          ds.tuiPromptOptions = undefined;
          publishAttentionPatch(ds);
        }
        break;
      }

      case 'claude_exit': {
        logger.info(`[${t}] ${getCliDisplayName(effectiveCliId)} exited (code: ${msg.code}, signal: ${msg.signal})`);
        ds.hasHistory = true;

        // Do NOT auto-restart in adopt mode — there's nothing to restart
        if (ds.adoptedFrom) {
          logger.info(`[${t}] Adopted session ended`);
          // Freeze the streaming card
          if (ds.streamCardId && ds.workerPort) {
            const readUrl = buildTerminalUrl(ds);
            const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
            const frozenCard = buildStreamingCard(
              ds.session.sessionId, sessionAnchorId(ds), readUrl, turnTitle,
              ds.lastScreenContent ?? '', 'idle', effectiveCliId,
              ds.displayMode ?? 'hidden', ds.streamCardNonce, ds.currentImageKey,
              isAdopt, showTakeover, loc, undefined, writableTerminalLinkFor(ds),
            );
            scheduleCardPatch(ds, frozenCard);
          }
          killWorker(ds);
          // Skip the exit notice when the session was already closed via the
          // ⏏ card button — card-handler already posted "已断开，原 CLI 会话
          // 不受影响" right before killing us, so another exit message here
          // is just noise. Natural exits (user typed `exit`, CLI crashed)
          // leave status='active' and still get the notice.
          if (ds.session.status !== 'closed') {
            try {
              await scopedReply(tr('worker.adopted_session_exited', undefined, loc), 'text', undefined);
            } catch { /* best effort */ }
          }
          break;
        }

        // Rate-limit auto-restart to prevent crash loops
        const key = ds.session.sessionId;
        const rc = restartCounts.get(key) ?? { count: 0, lastAt: 0 };
        const now = Date.now();
        if (now - rc.lastAt > 60_000) rc.count = 0; // reset after 1 min
        rc.count++;
        rc.lastAt = now;
        restartCounts.set(key, rc);

        if (rc.count > 3) {
          logger.warn(`[${t}] ${getCliDisplayName(effectiveCliId)} crashed ${rc.count} times in 1 min, not auto-restarting`);
          const keepDiagnosticWorker = !!msg.canParkDiagnostic && !!ds.worker && !ds.worker.killed;
          // Freeze the last streaming card so it doesn't stay at "working" forever
          if (ds.streamCardId && ds.workerPort) {
            const readUrl = buildTerminalUrl(ds);
            const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
            const frozenCard = buildStreamingCard(
              ds.session.sessionId, sessionAnchorId(ds), readUrl, turnTitle,
              ds.lastScreenContent ?? '', 'idle', effectiveCliId,
              ds.displayMode ?? 'hidden', ds.streamCardNonce, ds.currentImageKey,
              isAdopt, showTakeover, loc, undefined, writableTerminalLinkFor(ds),
            );
            scheduleCardPatch(ds, frozenCard);
          }
          if (keepDiagnosticWorker) {
            // Ask the worker to park a lightweight tmux diagnostic shell under
            // bmx-diag-<sid> NOW (deferred from its exit so transient restarts
            // don't pay for it). Keep its web server alive so the existing
            // terminal URL can show the startup failure; the next user message
            // tells that same worker to destroy the diagnostic shell and retry.
            ds.worker!.send({ type: 'park_diagnostic' } as DaemonToWorker);
            restartCounts.delete(key);
            ds.lastScreenStatus = 'idle';
            // Survive a daemon restart: mark this as a lazy cold-resume so
            // restore keeps the session active (re-spawns the CLI on the next
            // message) instead of zombie-closing it when the real bmx-<sid> is
            // found missing. ds.hasHistory is already true (set at the top of
            // claude_exit); forkWorker clears suspendedColdResume on re-spawn.
            ds.session.suspendedColdResume = true;
            sessionStore.updateSession(ds.session);
          } else {
            // Non-tmux or failed diagnostic parking: keep the historical
            // cleanup path so we do not leave an unusable worker around.
            killWorker(ds);
          }
          const cliName = getCliDisplayName(effectiveCliId);
          const parts = [tr('worker.crash_loop_stopped', { cliName, count: rc.count }, loc)];
          if (keepDiagnosticWorker) {
            parts.push(tr('worker.crash_diagnostic_terminal', undefined, loc));
          }
          if (msg.logTail?.trim()) {
            parts.push(`${tr('worker.crash_recent_output', undefined, loc)}\n${msg.logTail.trim()}`);
          }
          try {
            await scopedReply(parts.join('\n\n'), 'text', undefined);
          } catch (replyErr) {
            if (replyErr instanceof MessageWithdrawnError) {
              logger.warn(`[${t}] Root message withdrawn, closing stale session`);
              cb.closeSession(ds);
            }
          }
          break;
        }

        // Auto-restart CLI within the same worker
        if (ds.worker && !ds.worker.killed) {
          logger.info(`[${t}] Auto-restarting ${getCliDisplayName(effectiveCliId)}...`);
          ds.worker.send({ type: 'restart' } as DaemonToWorker);
        }
        break;
      }

      case 'error': {
        logger.error(`[${t}] Worker error: ${msg.message}`);
        break;
      }

      case 'user_notify': {
        logger.warn(`[${t}] Worker user_notify: ${msg.message}`);
        emitSessionLifecycleHook(ds, 'session.requires_attention', {
          reason: 'user_notify',
          message: msg.message,
        });
        try {
          await scopedReply(msg.message, 'text', msg.turnId);
        } catch (err: any) {
          logger.error(`[${t}] Failed to deliver user_notify to Lark: ${err.message}`);
        }
        break;
      }

      case 'final_output': {
        // Adopt-bridge: worker harvested the assistant turn from Claude Code's
        // transcript JSONL and forwarded it to us. Dedup by lastUuid so a
        // re-drain after a noisy idle doesn't re-send the same answer.
        if (!msg.content || !msg.content.trim()) break;
        if (msg.lastUuid && ds.lastBridgeEmittedUuid === msg.lastUuid) {
          logger.debug(`[${t}] final_output deduped (uuid ${msg.lastUuid.substring(0, 8)})`);
          break;
        }
        // Worker pops the turn off its queue right after emit, so it will
        // NOT re-send this payload on its own. Daemon owns retry on
        // transient Lark failures.
        deliverFinalOutput(ds, msg, t, 0);
        break;
      }

      case 'adopt_preamble': {
        // Adopt-bridge: surface the last completed user/assistant exchange
        // from the adopted CLI session so the Lark thread has context to
        // continue from. Best-effort — failure here just means the user
        // won't see the preamble; adopt itself isn't blocked. Card chrome
        // matches the regular markdown-card path (schema 2.0 + footer) so
        // the assistant body renders with proper code blocks / tables /
        // lists instead of arriving as a wall of plain text.
        if (!ds.adoptedFrom) {
          logger.warn(`[${t}] Ignored adopt_preamble from non-adopt worker`);
          break;
        }
        if (!msg.userText.trim() && !msg.assistantText.trim()) break;
        const recipientOpenId = daemonCardFooterRecipientOpenId(ds, effectiveCliId);
        const cardJson = buildContextualReplyCard({
          title: tr('card.adopt_last_round', undefined, localeForBot(ds.larkAppId)),
          userText: msg.userText,
          assistantText: msg.assistantText,
          assistantLabel: getCliDisplayName(effectiveCliId),
          recipientOpenId,
          brand: resolveBrandLabel(ds.larkAppId),
          locale: localeForBot(ds.larkAppId),
        });
        scopedReply(cardJson, 'interactive', msg.turnId).catch((err: any) => {
          logger.warn(`[${t}] Failed to deliver adopt_preamble to Lark: ${err.message}`);
        });
        break;
      }
    }
  });

  worker.on('exit', (code) => {
    logger.info(`[${t}] Worker process exited (code: ${code})`);
    // Only clear ds.worker if it's still THIS worker — during takeover,
    // the old worker's exit fires AFTER the new worker has been assigned.
    if (ds.worker === worker) {
      ds.worker = null;
      ds.workerPort = null;
    }
    // Notify dashboard, but only once per session lifecycle. The
    // dashboard-driven `closeSession()` path also publishes; whichever
    // fires first wins, the other's emit is suppressed.
    if (!ds.exitEventEmitted) {
      ds.exitEventEmitted = true;
      dashboardEventBus.publish({
        type: 'session.exited',
        body: {
          sessionId: ds.session.sessionId,
          reason: code === 0 ? 'graceful' : `exit_code_${code}`,
        },
      });
      emitSessionLifecycleHook(ds, 'session.exit', {
        reason: code === 0 ? 'graceful' : `exit_code_${code}`,
        code,
      });
    }
    callbacks?.onSessionIdleOrExit?.(ds, 'exit');
  });
}

// ─── Bridge final-output delivery (with retry) ──────────────────────────────

const FINAL_OUTPUT_RETRY_BACKOFF_MS = [0, 5000, 15000];  // immediate, +5s, +15s

/**
 * Turn-end half of the two-phase turn reactions (auto-on for card-off sessions,
 * i.e. streaming card disabled). The 冲! "received" reactions are added per-message at the daemon
 * acceptance point (`noteTurnReceived`); when the worker next returns to idle we
 * flip every pending ✋ on this session to ✅ DONE and clear the list. When
 * silentTurnReactions is enabled after a ✋ has already landed, we only remove
 * that received reaction and do not add DONE. Binding the start to the message
 * (not a status edge) means type-ahead / busy-batched messages each get their
 * own reaction and all settle together here.
 *
 * Every Feishu call is best-effort — a failure only means a missing emoji, so it
 * must never throw into the status pipeline (callers invoke as `void`).
 */
async function finishTurnReactions(ds: DaemonSession): Promise<void> {
  const list = ds.pendingAckReactions;
  if (!list || list.length === 0) return;
  // Detach the batch first so a second idle edge can't double-flip it.
  ds.pendingAckReactions = [];
  const silent = silentTurnReactions(ds);
  for (const ack of list) {
    if (ack.reactionId) {
      try {
        await removeReaction(ds.larkAppId, ack.messageId, ack.reactionId);
      } catch (err: any) {
        logger.debug(`[reaction] failed to remove received reaction ${ack.reactionId}: ${err?.message ?? err}`);
      }
    }
    if (silent) continue;
    try {
      await addReaction(ds.larkAppId, ack.messageId, DONE_REACTION_EMOJI_TYPE);
    } catch (err: any) {
      logger.debug(`[reaction] failed to add done reaction to ${ack.messageId}: ${err?.message ?? err}`);
    }
  }
}

/** Deliver a bridge `final_output` to Lark. The worker emits each turn
 *  exactly once (it pops the turn off its queue at emit time), so the
 *  daemon owns retries on transient failures. After 3 attempts we log
 *  and give up — the user's answer is lost; better than leaking memory
 *  via an unbounded retry loop. */
function deliverFinalOutput(
  ds: DaemonSession,
  msg: Extract<WorkerToDaemon, { type: 'final_output' }>,
  t: string,
  attempt: number,
): void {
  const cb = requireCallbacks();
  const effectiveCliId = ds.session.cliId ?? getBot(ds.larkAppId).config.cliId;
  const scopedReply = (content: string, msgType?: string, turnId?: string) =>
    cb.sessionReply(sessionAnchorId(ds), content, msgType, ds.larkAppId, fallbackTurnId(ds, turnId));
  setTimeout(async () => {
    // Guard: if the user closed the session (or it was torn down for any
    // other reason) between attempts, don't post a stale final answer to
    // a closed thread.
    if (ds.session.status === 'closed') {
      logger.info(`[${t}] Bridge final_output abandoned — session closed (turn ${msg.turnId.substring(0, 8)})`);
      return;
    }
    try {
      // 文档评论入口分流：本轮若来自飞书文档评论（/subscribe-lark-doc），把正文
      // 发表为文档评论（而非飞书卡片），状态卡/占位卡仍留在飞书会话起点。
      const docTurn = ds.docCommentTurns?.get(msg.turnId);
      if (docTurn) {
        // 嵌套回复到用户那条评论 thread（已挂在其下，无需再 ↪ 前缀）。这是兜底路径
        // （模型没显式 botmux send），默认 @ 回原评论人，仅首块加。
        const chunks = chunkCommentText(msg.content);
        for (let i = 0; i < chunks.length; i++) {
          await replyToDocComment(ds.larkAppId, { fileToken: docTurn.fileToken, fileType: docTurn.fileType }, docTurn.commentId, chunks[i], i === 0 ? docTurn.replyToOpenId : undefined);
        }
        ds.docCommentTurns?.delete(msg.turnId);
        ds.lastBridgeEmittedUuid = msg.lastUuid;
        logger.info(`[${t}] doc-comment final_output → posted ${chunks.length} comment(s) on file=${docTurn.fileToken.slice(0, 12)} (turn ${msg.turnId.substring(0, 8)})`);
        return;
      }

      // Wrap the model's reply in the same card chrome `botmux send` uses
      // (schema 2.0 + footer with botmux link + 发送给 owner) so a turn
      // delivered via this fallback path looks identical in the Lark thread
      // to one the model sent itself. Markdown rendering, tables, code
      // blocks all flow through the shared `buildCardBodyElements`.
      //
      // Local-turn variants (kind = 'local-turn' / 'local-turn-headless')
      // also surface the user-side prompt synced from the adopted pane;
      // they use the contextual card so the user prompt sits in a
      // blockquote and only the assistant body goes through full markdown
      // rendering.
      const recipientOpenId = daemonCardFooterRecipientOpenId(ds, effectiveCliId);
      const cardJson = msg.kind === 'local-turn' || msg.kind === 'local-turn-headless'
        ? buildContextualReplyCard({
            title: msg.kind === 'local-turn-headless'
              ? tr('card.local_turn_resumed', undefined, localeForBot(ds.larkAppId))
              : tr('card.local_turn', undefined, localeForBot(ds.larkAppId)),
            userText: msg.kind === 'local-turn' ? msg.userText ?? '' : undefined,
            assistantText: msg.content,
            assistantLabel: getCliDisplayName(effectiveCliId),
            recipientOpenId,
            brand: resolveBrandLabel(ds.larkAppId),
            locale: localeForBot(ds.larkAppId),
          })
        : buildMarkdownCard(msg.content, recipientOpenId, resolveBrandLabel(ds.larkAppId), localeForBot(ds.larkAppId));

      // Always deliver the answer as a fresh message — never PATCH a card in
      // place. message.patch is silent (no Feishu notification / unread), which
      // used to swallow the answer; a brand-new message always pings.
      await scopedReply(cardJson, 'interactive', msg.turnId);
      ds.lastBridgeEmittedUuid = msg.lastUuid;
      logger.info(`[${t}] Bridge final_output forwarded (turn ${msg.turnId.substring(0, 8)}, ${msg.content.length} chars, kind=${msg.kind ?? 'bridge'}, attempt ${attempt + 1})`);
    } catch (err: any) {
      if (err instanceof MessageWithdrawnError) {
        // Root message gone — no point retrying. Mark as emitted so any
        // duplicate IPC is correctly deduped, and tear the session down.
        ds.lastBridgeEmittedUuid = msg.lastUuid;
        logger.warn(`[${t}] Root message withdrawn while forwarding final_output, closing session`);
        cb.closeSession(ds);
        return;
      }
      const next = attempt + 1;
      if (next >= FINAL_OUTPUT_RETRY_BACKOFF_MS.length) {
        logger.error(`[${t}] Bridge final_output gave up after ${next} attempts (turn ${msg.turnId.substring(0, 8)}): ${err.message}`);
        // Don't commit the dedup marker — leave room for any future
        // retransmit (e.g. daemon restart that re-fires the IPC).
        return;
      }
      logger.warn(`[${t}] Bridge final_output attempt ${next} failed (${err.message}); retrying in ${FINAL_OUTPUT_RETRY_BACKOFF_MS[next]}ms`);
      deliverFinalOutput(ds, msg, t, next);
    }
  }, FINAL_OUTPUT_RETRY_BACKOFF_MS[attempt] ?? 0);
}


/** Test-only alias so the retry pipeline can be exercised without a real
 *  fork. Intentionally underscored to discourage non-test callers. */
export const __testOnly_deliverFinalOutput = deliverFinalOutput;
export const __testOnly_setupWorkerHandlers = setupWorkerHandlers;
export const __testOnly_finishTurnReactions = finishTurnReactions;

// ─── Fork adopt worker ──────────────────────────────────────────────────────

export function forkAdoptWorker(ds: DaemonSession, opts?: { restoredFromMetadata?: boolean }): void {
  const cb = requireCallbacks();
  const workerPath = join(__dirname, '..', 'worker.js');
  const t = tag(ds);
  const adopted = ds.adoptedFrom;
  if (!adopted) throw new Error('forkAdoptWorker called without adoptedFrom');

  const bot = getBot(ds.larkAppId);
  const botCfg = bot.config;

  // Guard against double-fork
  if (ds.worker && !ds.worker.killed) {
    logger.warn(`[${t}] Worker already running, killing before adopt-fork`);
    try { ds.worker.send({ type: 'close' } as DaemonToWorker); } catch {}
    try { ds.worker.kill(); } catch {}
    ds.worker = null;
    ds.workerPort = null;
    ds.workerToken = null;
  }

  // No ensureCliSkills — adopt mode attaches to an existing CLI session

  // Fall back to home if the adopted cwd is gone — a missing fork cwd emits an
  // unhandled 'error' (spawn ENOENT) that would crash the daemon.
  const rawAdoptCwd = adopted.cwd ?? ds.workingDir ?? process.cwd();
  const adoptCwd = rawAdoptCwd && existsSync(rawAdoptCwd) ? rawAdoptCwd : homedir();
  if (adoptCwd !== rawAdoptCwd) logger.warn(`[${t}] adopt cwd "${rawAdoptCwd}" does not exist — falling back to ${adoptCwd}`);
  const worker = fork(workerPath, [], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    cwd: adoptCwd,
    env: {
      ...process.env,
      CLAUDECODE: undefined,
      BOTMUX: '1',
      LARK_APP_ID: botCfg.larkAppId,
      LARK_APP_SECRET: botCfg.larkAppSecret,
    },
  } as WindowsForkOptions);

  // A fork-level failure emits 'error'; without a handler it crashes the daemon.
  worker.on('error', (err) => {
    logger.error(`[${t}] Adopt worker fork error: ${(err as Error)?.message ?? err}`);
  });

  // Pipe worker stdout/stderr — both go through logger.info (→ daemon.log,
  // not error.log). See forkWorker for the rationale.
  worker.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n')) {
      const trimmed = line.trim();
      if (trimmed) logger.info(`[${t}:out] ${trimmed}`);
    }
  });
  worker.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n')) {
      logWorkerStderr(t, line.trim());
    }
  });

  // Bridge mode is gated per-CLI:
  //   - claude-code: needs sessionId to compute jsonl path. PID + cwd let
  //     the worker follow Claude's `/clear` / `/resume` rotations.
  //   - codex: worker resolves the rollout path either from cliSessionId
  //     (passed below when known) or by reading the Codex pid's open fds
  //     in /proc — so we always pass the pid for codex adopt.
  //   - traex: same rollout strategy as codex (byte-identical JSONL format),
  //     only the directory layout (~/.trae/cli/sessions) and finders differ.
  //   - coco: events.jsonl path is `~/.cache/coco/sessions/<sid>/events.jsonl`,
  //     deterministic from cliSessionId. PID is the fallback when discovery
  //     missed (events.jsonl isn't held open continuously, so worker may need
  //     to re-probe via session.log / traces.jsonl fds).
  //   - mtr: worker tails MTR's sqlite transcript, resolving by native sid
  //     when discovery has one or by adopted cwd as a fallback.
  //   - cursor: worker maps the adopt pid → its open store.db fd → chatId →
  //     the append-only agent-transcript JSONL, then harvests final replies
  //     from there (cursor-agent never calls `botmux send`).
  // Other CLIs fall back to legacy screen-capture only.
  const adoptedCliId = adopted.cliId ?? 'claude-code';
  if (adopted.source === 'herdr' && adoptedCliId === 'claude-code' && !adopted.sessionId) {
    const claudeMeta = findUniqueClaudeSessionByCwd(adopted.cwd);
    if (claudeMeta?.sessionId) {
      adopted.sessionId = claudeMeta.sessionId;
      if (ds.session.adoptedFrom) ds.session.adoptedFrom.sessionId = claudeMeta.sessionId;
      sessionStore.updateSession(ds.session);
      logger.info(`[${t}] Resolved Claude session for adopted herdr target by cwd`);
    } else {
      logger.warn(`[${t}] Cannot resolve unique Claude session for adopted herdr target; final replies may be unavailable`);
    }
  }
  const hasCliPid = typeof adopted.originalCliPid === 'number';
  const bridgeJsonlPath =
    adoptedCliId === 'claude-code' && adopted.sessionId
      ? claudeJsonlPathForSession(adopted.sessionId, adopted.cwd)
      : undefined;
  // cursor: worker resolves the agent-transcript JSONL from the adopt pid's
  // open store.db fd (chatId), or from cliSessionId (= chatId) when discovery
  // captured it — so adopt must forward the pid + cwd like the other
  // transcript-backed CLIs.
  const isStructuredBridge = adoptedCliId === 'codex' || adoptedCliId === 'traex' || adoptedCliId === 'coco' || adoptedCliId === 'mtr' || adoptedCliId === 'cursor';
  const adoptBackendType = adopted.source === 'herdr' ? 'herdr' : adopted.zellijPaneId ? 'zellij' : 'tmux';

  const initMsg: DaemonToWorker = {
    type: 'init',
    sessionId: ds.session.sessionId,
    chatId: ds.chatId,
    rootMessageId: sessionAnchorId(ds),
    workingDir: adopted.cwd,
    cliId: adoptedCliId,
    cliSessionId: isStructuredBridge ? adopted.sessionId : undefined,
    model: botCfg.model,
    disableCliBypass: botCfg.disableCliBypass === true,
    prompt: '',
    resume: false,
    ownerOpenId: ds.ownerOpenId,
    webPort: ds.session.webPort,
    larkAppId: botCfg.larkAppId,
    larkAppSecret: botCfg.larkAppSecret,
    brand: normalizeBrand(botCfg.brand),
    botName: bot.botName,
    botOpenId: bot.botOpenId,
    locale: botLocale(botCfg),
    // Zellij adopt targets carry zellijSession+zellijPaneId (observe via
    // dump-screen / drive via action); tmux carries tmuxTarget (pipe-pane).
    // The worker's adopt branch picks the backend from whichever is present.
    backendType: adoptBackendType,
    adoptMode: true,
    adoptSource: adopted.source ?? adoptBackendType,
    adoptTmuxTarget: adopted.tmuxTarget,
    adoptHerdrSessionName: adopted.herdrSessionName,
    adoptHerdrTarget: adopted.herdrTarget,
    adoptHerdrPaneId: adopted.herdrPaneId,
    adoptZellijSession: adopted.zellijSession,
    adoptZellijPaneId: adopted.zellijPaneId,
    adoptPaneCols: adopted.paneCols,
    adoptPaneRows: adopted.paneRows,
    bridgeJsonlPath,
    // PID + cwd: claude uses for `~/.claude/sessions/<pid>.json` resolver;
    // codex uses for `/proc/<pid>/fd` rollout discovery (works even if
    // session-discovery couldn't probe sessionId up-front). zellij adopt ALSO
    // needs the pid unconditionally: ZellijObserveBackend's liveness watches
    // the CLI pid (process.kill(pid,0)) so the worker onExit's when a user-typed
    // CLI exits back to a shell — without it, aiden/gemini/opencode/hermes would
    // fall back to pane-only liveness and keep routing input into the shell.
    adoptCliPid: hasCliPid && (adoptedCliId === 'claude-code' || isStructuredBridge || !!adopted.zellijPaneId) ? adopted.originalCliPid : undefined,
    adoptCwd: hasCliPid && (adoptedCliId === 'claude-code' || isStructuredBridge || !!adopted.zellijPaneId) ? adopted.cwd : undefined,
    // Restored-from-metadata: this fork is recreating an /adopt session after
    // a daemon restart, NOT a fresh /adopt command. The Lark thread already
    // has every prior turn pushed as cards, so the worker should skip the
    // "📜 /adopt 前最后一轮" preamble (it would surface a stale turn from
    // whichever jsonl was current at the original /adopt time, which may be
    // way out of date if the user has /clear'd since).
    adoptRestoredFromMetadata: opts?.restoredFromMetadata === true ? true : undefined,
  };
  worker.send(initMsg);
  ds.initConfig = initMsg;
  // Stamp cliId on the persisted session so the dashboard can show a CLI badge
  // even after the session is closed. Adopt sessions inherit the adopted CLI's id.
  // Do this before installing worker handlers: a fast worker can emit `ready`
  // immediately after init, and card rendering must use the adopted CLI identity.
  const adoptedCliIdTyped = adoptedCliId as CliId;
  if (ds.session.cliId !== adoptedCliIdTyped) {
    ds.session.cliId = adoptedCliIdTyped;
    sessionStore.updateSession(ds.session);
  }

  // Use shared handler
  setupWorkerHandlers(ds, worker);

  ds.worker = worker;
  ds.spawnedAt = Date.now();
  ds.cliVersion = '';
  // Persist the bridge worker's pid, exactly like forkWorker. Without it the
  // session row keeps pid=null, so `botmux list` (and killStalePids) judge an
  // adopt session by "process dead AND no bmx-<id> tmux" — but adopt attaches to
  // the user's OWN tmux/zellij pane, never a bmx-* session, so the heuristic
  // always reported it unrecoverable and auto-pruned it to "closed" right after
  // /adopt. Storing the worker pid (botmux's bridge, NOT the user's CLI) makes
  // liveness consistent with normal sessions and leaves the user's CLI alone.
  sessionStore.updateSessionPid(ds.session.sessionId, worker.pid ?? null);
  logger.info(`[${t}] Adopt worker forked (pid: ${worker.pid}, target: ${adopted.tmuxTarget ?? `${adopted.zellijSession}/${adopted.zellijPaneId}`})`);

  ds.exitEventEmitted = false;
  dashboardEventBus.publish({
    type: 'session.spawned',
    body: { session: composeRowFromActive(ds) },
  });
  emitSessionLifecycleHook(ds, 'session.start', {
    reason: opts?.restoredFromMetadata ? 'adopt_restore' : 'adopt',
    pid: worker.pid ?? null,
    adoptedFrom: adopted.tmuxTarget,
  });
  // Adopted CLIs come with pre-botmux history — anchor it out of the ledger.
  anchorUsageForDaemonSession(ds);
  recordOwnershipForDaemonSession(ds);
}

// ─── Reap orphan workers ────────────────────────────────────────────────────

/** A live process, reduced to what orphan detection needs. */
export interface ProcSnapshot {
  pid: number;
  ppid: number;
  /** Full command line (argv joined by spaces). */
  cmd: string;
}

/**
 * Enumerate live processes as {pid, ppid, cmd}. Linux reads `/proc` directly
 * (the rest of the worker code already relies on /proc); other POSIX shells out
 * to `ps`. Returns `[]` on Windows or on any failure — callers then reap
 * nothing, so "can't tell" can never escalate into a wrong kill.
 */
export function listProcesses(): ProcSnapshot[] {
  if (process.platform === 'win32') return [];
  try {
    if (process.platform === 'linux') {
      const procs: ProcSnapshot[] = [];
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        try {
          // /proc/<pid>/stat = "<pid> (comm) <state> <ppid> ...". `comm` can
          // contain spaces and ')', so read ppid from after the LAST ')'.
          const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
          const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          const ppid = Number(after[1]); // after = [state, ppid, ...]
          const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim();
          if (Number.isFinite(ppid)) procs.push({ pid, ppid, cmd });
        } catch { /* exited mid-scan / unreadable — skip */ }
      }
      return procs;
    }
    // macOS / other POSIX. `-ww` defeats command-column truncation.
    const raw = execSync('ps -axww -o pid=,ppid=,command=', { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
    const procs: ProcSnapshot[] = [];
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
    }
    return procs;
  } catch {
    return [];
  }
}

/**
 * Reap worker processes orphaned by a previous daemon that died WITHOUT running
 * its graceful shutdown — SIGKILL, OOM, or an uncaught crash. The shutdown()
 * path in daemon.ts already SIGKILLs stragglers on SIGTERM, but a hard kill
 * skips it entirely: the workers get re-parented to init (ppid==1), and because
 * a fresh worker's pid overwrites `session.pid`, killStalePids can never reach
 * them again. Each leaks ~0.5 GB and they pile up across restarts (observed:
 * 22 orphans / 3.3 GB on a dev box; daemon.ts records a prior 841-orphan /
 * ~65 GB incident).
 *
 * Identification is deliberately conservative — a process is reaped only if it
 * BOTH:
 *   1. has ppid==1 — its forking daemon is gone. A live daemon's workers are
 *      parented to that daemon, so this never touches a running worker, even
 *      under the one-daemon-per-bot layout or when several daemons start at
 *      once; and
 *   2. references THIS install's worker script in its command line — so we
 *      never touch another botmux install or an unrelated `worker.js`.
 *
 * Process listing and the kill syscall are injectable for tests. Returns the
 * number of orphans actually reaped.
 */
export function reapOrphanWorkers(opts: {
  procs?: ProcSnapshot[];
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  workerPath?: string;
} = {}): number {
  if (process.platform === 'win32') return 0;
  const procs = opts.procs ?? listProcesses();
  const kill = opts.kill ?? ((pid, signal) => { process.kill(pid, signal); });
  const workerPath = opts.workerPath ?? join(__dirname, '..', 'worker.js');

  let reaped = 0;
  for (const p of procs) {
    if (p.ppid !== 1) continue;                 // parent still alive → not an orphan
    if (!p.cmd.includes(workerPath)) continue;  // not OUR worker script
    try {
      // SIGKILL, not SIGTERM: an orphan can be wedged in a sync code path (the
      // very failure mode that produced it) where SIGTERM is lost. It holds no
      // active session and no IPC channel, so there is nothing to flush.
      kill(p.pid, 'SIGKILL');
      reaped++;
      logger.info(`Reaped orphan worker pid=${p.pid} (forking daemon gone)`);
    } catch { /* already exited, or another daemon won the race — fine */ }
  }
  if (reaped > 0) {
    logger.warn(`Reaped ${reaped} orphan worker(s) leaked by a previous daemon that didn't shut down cleanly.`);
  }
  return reaped;
}

// ─── Kill stale PIDs ────────────────────────────────────────────────────────

export function killStalePids(activeSessions_: Session[]): void {
  for (const session of activeSessions_) {
    if (!session.pid) continue;
    try {
      // Check if process exists (signal 0 doesn't kill, just checks)
      process.kill(session.pid, 0);
      // Process exists — kill its process group
      logger.info(`Killing stale CLI process (pid: ${session.pid}, session: ${session.sessionId})`);
      try {
        process.kill(-session.pid, 'SIGTERM');
      } catch {
        try { process.kill(session.pid, 'SIGTERM'); } catch { /* already gone */ }
      }
    } catch {
      // Process doesn't exist, nothing to clean up
    }
  }

  cleanupPersistentBackendSessions('tmux', activeSessions_);
  cleanupPersistentBackendSessions('herdr', activeSessions_);
}

function cleanupPersistentBackendSessions(backendType: 'tmux' | 'herdr', activeSessions_: Session[]): void {
  const anyBackend = getAllBots().some(b => (b.config.backendType ?? config.daemon.backendType) === backendType)
    || config.daemon.backendType === backendType;
  if (!anyBackend) return;

  const backend = backendType === 'tmux' ? TmuxBackend : HerdrBackend;
  const multiBot = getAllBots().length > 1;
  const cliIdFile = join(config.session.dataDir, backendType === 'tmux' ? 'last-cli-id' : `last-cli-id-${backendType}`);
  let lastCliId: string | undefined;
  try { lastCliId = readFileSync(cliIdFile, 'utf-8').trim(); } catch { /* first run */ }
  const currentCliId = config.daemon.cliId;

  if (!multiBot && lastCliId && lastCliId !== currentCliId) {
    logger.info(`CLI_ID changed (${lastCliId} → ${currentCliId}), killing all ${backendType} sessions`);
    for (const name of backend.listBotmuxSessions()) {
      backend.killSession(name);
    }
  } else {
    const activeNames = new Set(
      activeSessions_.map(s => backend.sessionName(s.sessionId)),
    );
    const ownedNames = new Set(
      sessionStore.listSessions().map(s => backend.sessionName(s.sessionId)),
    );
    for (const name of backend.listBotmuxSessions()) {
      if (ownedNames.has(name) && !activeNames.has(name)) {
        logger.info(`Killing orphaned ${backendType} session: ${name}`);
        backend.killSession(name);
      }
    }
    for (const session of activeSessions_) {
      const sessionCliId = session.cliId;
      if (!sessionCliId || !session.larkAppId) continue;
      let botCliId: CliId | undefined;
      try { botCliId = getBot(session.larkAppId).config.cliId; } catch { continue; }
      if (botCliId && sessionCliId !== botCliId) {
        const name = backend.sessionName(session.sessionId);
        logger.info(`CLI mismatch for ${session.sessionId.substring(0, 8)} (session=${sessionCliId}, bot=${botCliId}), killing ${backendType} ${name}`);
        backend.killSession(name);
      }
    }
  }

  try {
    mkdirSync(config.session.dataDir, { recursive: true });
    atomicWriteFileSync(cliIdFile, currentCliId);
  } catch (err) {
    logger.warn(`Failed to write ${cliIdFile}: ${err}`);
  }
}

// ─── CLI version (shared with daemon) ─────────────────────────────────────

/** Current CLI version, kept in sync by daemon via setCurrentCliVersion(). */
let currentCliVersion = 'unknown';

export function setCurrentCliVersion(v: string): void {
  currentCliVersion = v;
}

export function getCurrentCliVersion(): string {
  return currentCliVersion;
}
