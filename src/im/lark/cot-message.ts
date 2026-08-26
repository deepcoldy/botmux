/**
 * Native CoT (thinking process) message — Feishu `im.v1 message_cot` bridge.
 *
 * Feishu renders `message_cot` messages as the NATIVE thinking bubble
 * (fixed-height, scrolling, collapsible — the same UI Feishu's own AI uses),
 * driven by AG-UI protocol events. This is the ONLY thinking channel; if the
 * API fails (client < PC 7.70 / mobile 7.74 renders a plain post fallback,
 * tenants where the API is unavailable get errors), thinking is simply not
 * displayed for that turn — logged, never retried mid-turn.
 *
 * Lifecycle per turn, driven by the worker's `thinking_update` IPC:
 *
 *   1. First update → POST create (chat-addressed; `origin_message_id` set to
 *      the triggering message so the bubble lands inside the topic) →
 *      `{cot_id, message_id}` → push RUN_STARTED + REASONING_START prologue.
 *   2. Subsequent updates → PUT AG-UI events. The worker sends the FULL
 *      cumulative ENTRY LIST (thinking paragraphs + tool calls/results in
 *      transcript order, append-only); this module pushes each unseen entry
 *      as its own node — thinking as a reasoning message (START/CONTENT/END
 *      with a distinct messageId), tool calls as TOOL_CALL_START/ARGS/END,
 *      tool output as TOOL_CALL_RESULT. Single in-flight PUT per session,
 *      latest-wins.
 *   3. `turn_terminal` → final PUT: REASONING_END / RUN_FINISHED.
 *      RUN_FINISHED auto-completes the CoT server-side (verified: later
 *      appends fail with "COT already in terminal state"), so no separate
 *      complete call is needed; the explicit complete endpoint is kept as the
 *      error-path fallback so a failed terminal batch can't leave the bubble
 *      spinning forever.
 *
 * Strictly cosmetic: every network call catches its own errors and never
 * touches turn settlement.
 *
 * Opt-in per bot via `thinkingCard: true`.
 */
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBot, getBotClient } from '../../bot-registry.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { localeForBot, t } from '../../i18n/index.js';
import type { CotEntry, WorkerToDaemon } from '../../types.js';
import type { DaemonSession } from '../../core/types.js';

/** Bounds every CoT HTTP call so a hung endpoint can't pin the pump. */
const COT_REQUEST_TIMEOUT_MS = 15_000;

interface CotEvent {
  event_type: string;
  content: string;
  timestamp: number;
}

interface CotState {
  turnKey: string;
  turnId: string;
  /** create failed / a push failed → thinking display off for the turn. */
  disabled: boolean;
  settled: boolean;
  cotId?: string;
  messageId?: string;
  /** Entries already pushed, each as its own node. */
  sentCount: number;
  /** Latest full cumulative entry list awaiting push (latest-wins). */
  pendingEntries?: CotEntry[];
  /** messageId of the most recent reasoning node — parent for tool calls. */
  lastReasoningId?: string;
  pumping: boolean;
  /** Set when turn_terminal arrives; consumed by the pump's final flush. */
  finishStatus?: 'done' | 'interrupted';
}

const states = new WeakMap<DaemonSession, CotState>();

// ─── Orphan closure across daemon restarts ─────────────────────────────────
//
// CoT state is in-memory; a daemon restart mid-turn loses it, and the bubble
// created by the previous generation would spin on「执行中」forever (its
// turn_terminal lands in a process that no longer knows the cot_id). So every
// created bubble leaves a tiny marker file until it settles; the next daemon
// generation sweeps leftovers and closes them via the explicit complete
// endpoint. Strictly best-effort — marker IO must never break the pump.

function cotOrphanDir(): string {
  return join(config.session.dataDir, 'cot-orphans');
}

function recordCotOrphanMarker(ds: DaemonSession, state: CotState): void {
  try {
    mkdirSync(cotOrphanDir(), { recursive: true });
    writeFileSync(join(cotOrphanDir(), `${state.cotId}.json`), JSON.stringify({
      larkAppId: ds.larkAppId,
      cotId: state.cotId,
      messageId: state.messageId,
    }));
  } catch { /* cosmetic */ }
}

function clearCotOrphanMarker(state: CotState): void {
  if (!state.cotId) return;
  try { unlinkSync(join(cotOrphanDir(), `${state.cotId}.json`)); } catch { /* already gone */ }
}

/**
 * Close CoT bubbles orphaned by a previous daemon generation. Call once at
 * startup after this daemon's bot is registered (needs its client).
 *
 * `selfLarkAppId` scoping is load-bearing: per-bot PM2 daemons share one
 * dataDir, so cot-orphans/ holds every bot's markers and daemons restart
 * concurrently. Each daemon may only consume ITS OWN markers — touching a
 * sibling's would delete the marker without being able to close the bubble
 * (its client isn't registered here), recreating the forever-spinning bubble
 * this mechanism exists to prevent. Unreadable/incomplete markers are the one
 * exception: no daemon could ever act on them, so they're swept as garbage.
 */
export async function sweepOrphanCotMessages(selfLarkAppId: string): Promise<void> {
  let files: string[];
  try { files = readdirSync(cotOrphanDir()); } catch { return; } // no dir → nothing pending
  for (const f of files) {
    const p = join(cotOrphanDir(), f);
    try {
      const rec = JSON.parse(readFileSync(p, 'utf8')) as { larkAppId?: string; cotId?: string; messageId?: string };
      if (rec.larkAppId && rec.cotId && rec.messageId) {
        if (rec.larkAppId !== selfLarkAppId) continue; // sibling daemon's marker — leave it
        const c = getBotClient(rec.larkAppId);
        await c.request({
          method: 'POST',
          url: `/open-apis/im/v1/message_cot/complete/${encodeURIComponent(rec.cotId)}`,
          params: { message_id: rec.messageId, reason: 'done' },
          timeout: COT_REQUEST_TIMEOUT_MS,
        } as any);
        logger.info(`[cot] orphan closed cot=${rec.cotId}`);
      }
    } catch (err) {
      // Already terminal / bot gone / transient — the marker is still consumed;
      // a bubble we can't close now won't become closable later.
      logger.warn(`[cot] orphan sweep ${f}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try { unlinkSync(p); } catch { /* best-effort */ }
  }
}

function turnKeyOf(msg: { turnId: string; dispatchAttempt?: number }): string {
  return `${msg.turnId}|${msg.dispatchAttempt ?? ''}`;
}

/** Effective per-session gate: bot-level master switch (`thinkingCard`,
 *  default ON — only explicit false disables) AND the chat not opted out via
 *  `/cot off` (`noCotChats`). Read fresh from the in-memory registry so
 *  `/cot` toggles apply from the next update without a daemon restart.
 *  `/cot show` (`ds.cotForced`) overrides both switches for one turn —
 *  apiOnly stays a hard block (such bots must not emit IM messages). */
export function cotEnabled(ds: DaemonSession): boolean {
  try {
    const cfg = getBot(ds.larkAppId).config;
    if (cfg.apiOnly === true) return false;
    if (ds.cotForced) return true;
    return cfg.thinkingCard !== false
      && !(ds.chatId && cfg.noCotChats?.includes(ds.chatId));
  } catch {
    return false;
  }
}

function ev(eventType: string, content: unknown): CotEvent {
  return { event_type: eventType, content: JSON.stringify(content), timestamp: Date.now() };
}

async function apiCreate(ds: DaemonSession, state: CotState): Promise<void> {
  const c = getBotClient(ds.larkAppId);
  const res = await c.request({
    method: 'POST',
    url: '/open-apis/im/v1/message_cot',
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: ds.chatId,
      // Placement: the bubble inherits the topic of the message it originates
      // from. Turn ids are the triggering Lark message ids for ordinary turns;
      // synthetic ids (scheduler etc.) are skipped → bubble lands at chat level.
      ...(state.turnId.startsWith('om_') ? { origin_message_id: state.turnId } : {}),
    },
    timeout: COT_REQUEST_TIMEOUT_MS,
  } as any);
  const cotId = res?.data?.cot_id;
  const messageId = res?.data?.message_id;
  if (typeof cotId !== 'string' || typeof messageId !== 'string' || !cotId || !messageId) {
    throw new Error(`CreateCOT missing ids: ${JSON.stringify(res?.data ?? res).slice(0, 200)}`);
  }
  state.cotId = cotId;
  state.messageId = messageId;
}

async function apiAppend(ds: DaemonSession, state: CotState, events: CotEvent[]): Promise<void> {
  if (events.length === 0) return;
  const c = getBotClient(ds.larkAppId);
  // PUT body caps events at 50 per call.
  for (let i = 0; i < events.length; i += 50) {
    await c.request({
      method: 'PUT',
      url: '/open-apis/im/v1/message_cot',
      data: { cot_id: state.cotId, message_id: state.messageId, events: events.slice(i, i + 50) },
      timeout: COT_REQUEST_TIMEOUT_MS,
    } as any);
  }
}

/** Best-effort error-path completion (normal completion rides RUN_FINISHED). */
async function apiComplete(ds: DaemonSession, state: CotState, reason: 'done' | 'error'): Promise<void> {
  const c = getBotClient(ds.larkAppId);
  await c.request({
    method: 'POST',
    url: `/open-apis/im/v1/message_cot/complete/${encodeURIComponent(state.cotId!)}`,
    params: { message_id: state.messageId!, reason },
    timeout: COT_REQUEST_TIMEOUT_MS,
  } as any);
}

/** One reasoning message (= one rendered node) per thinking entry. */
function reasoningId(state: CotState, index: number): string {
  return `reasoning-${state.turnId}-${index + 1}`;
}

/** Built-in Feishu CoT icon + i18n label key for a CLI tool name. The label
 *  becomes the node's `title` (the bubble shows a readable category like
 *  「执行命令」 instead of `Bash ({"command":…})`; the raw tool name and args
 *  stay in the expanded detail). Matches by lowercase substring so it works
 *  across Claude's Bash/Read/Grep and MCP-style names without a per-CLI
 *  table. */
function toolMeta(name: string): { icon: string; labelKey: string } {
  const n = name.toLowerCase();
  if (n.includes('bash') || n.includes('shell') || n.includes('command')) return { icon: 'bash', labelKey: 'cot.tool.bash' };
  if (n.includes('write') || n.includes('edit') || n.includes('patch')) return { icon: 'write', labelKey: 'cot.tool.write' };
  if (n.includes('read') || n.includes('notebook')) return { icon: 'read', labelKey: 'cot.tool.read' };
  if (n.includes('grep') || n.includes('glob') || n.includes('search') || n.includes('fetch')) return { icon: 'search', labelKey: 'cot.tool.search' };
  if (n.includes('task') || n.includes('todo') || n.includes('plan')) return { icon: 'task', labelKey: 'cot.tool.task' };
  return { icon: 'default', labelKey: 'cot.tool.default' };
}

/** AG-UI events for one CoT entry. Thinking → a complete reasoning message
 *  (its own node); tool_call → START(+ARGS)+END; tool_result → RESULT in
 *  code style (tool output is command/file content — monospace fits). */
function entryEvents(ds: DaemonSession, state: CotState, entry: CotEntry, index: number): CotEvent[] {
  if (entry.kind === 'thinking') {
    const mid = reasoningId(state, index);
    state.lastReasoningId = mid;
    return [
      ev('REASONING_MESSAGE_START', { messageId: mid, role: 'reasoning' }),
      ev('REASONING_MESSAGE_CONTENT', { messageId: mid, delta: entry.text }),
      ev('REASONING_MESSAGE_END', { messageId: mid }),
    ];
  }
  if (entry.kind === 'tool_call') {
    const meta = toolMeta(entry.name);
    return [
      ev('TOOL_CALL_START', {
        toolCallId: entry.id,
        icon: meta.icon,
        title: t(meta.labelKey, { name: entry.name }, localeForBot(ds.larkAppId)),
        toolCallName: entry.name,
        ...(state.lastReasoningId ? { parentMessageId: state.lastReasoningId } : {}),
      }),
      ...(entry.args.length > 0 ? [ev('TOOL_CALL_ARGS', { toolCallId: entry.id, delta: entry.args })] : []),
      ev('TOOL_CALL_END', { toolCallId: entry.id }),
    ];
  }
  if (entry.result.length === 0) return [];
  return [
    ev('TOOL_CALL_RESULT', {
      messageId: `tr-${entry.id}`,
      toolCallId: entry.id,
      role: 'tool',
      content: JSON.stringify({ type: 'code', code: entry.result }),
    }),
  ];
}

/**
 * Single-in-flight pump: creates the CoT entity on first run, then drains
 * pendingEntries — each unseen entry becomes its own node; when finishStatus
 * is set and all entries are drained, sends the terminal event batch
 * (RUN_FINISHED auto-completes).
 */
async function pump(ds: DaemonSession, state: CotState): Promise<void> {
  if (state.pumping) return;
  state.pumping = true;
  try {
    while (!state.disabled) {
      if (!state.cotId) {
        await apiCreate(ds, state);
        // Record the orphan marker the moment the bubble exists — before the
        // prologue append. If the prologue fails (or the daemon restarts
        // before the turn settles), the next generation can still close it;
        // recording it after the append would leave a markerless window where
        // a created-but-never-settled bubble spins forever.
        recordCotOrphanMarker(ds, state);
        await apiAppend(ds, state, [
          ev('RUN_STARTED', { threadId: ds.session.sessionId, runId: state.turnId }),
          ev('REASONING_START', { messageId: reasoningId(state, 0) }),
        ]);
        logger.info(`[cot] created cot=${state.cotId} msg=${state.messageId} turn=${state.turnId.substring(0, 12)}`);
      }
      const pending = state.pendingEntries;
      state.pendingEntries = undefined;
      if (pending && pending.length > state.sentCount) {
        // Entries are append-only (each transcript event arrives whole), so
        // everything past sentCount is new. Push each as a full node.
        const batch: CotEvent[] = [];
        for (let i = state.sentCount; i < pending.length; i++) {
          batch.push(...entryEvents(ds, state, pending[i], i));
        }
        await apiAppend(ds, state, batch);
        state.sentCount = pending.length;
        continue; // re-check for newer entries queued during the push
      }
      if (state.finishStatus && !state.settled) {
        await apiAppend(ds, state, [
          ev('REASONING_END', { messageId: state.lastReasoningId ?? reasoningId(state, 0) }),
          ev('RUN_FINISHED', { threadId: ds.session.sessionId, runId: state.turnId, status: state.finishStatus }),
        ]);
        state.settled = true;
        clearCotOrphanMarker(state);
        logger.info(`[cot] finished cot=${state.cotId} status=${state.finishStatus}`);
      }
      break;
    }
  } catch (err) {
    state.disabled = true;
    logger.warn(`[cot] disabled for turn ${state.turnId.substring(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
    // If the entity exists but the terminal batch failed, the bubble would
    // spin forever — close it out via the explicit complete endpoint.
    if (state.cotId && state.finishStatus && !state.settled) {
      state.settled = true;
      apiComplete(ds, state, 'error')
        .catch(() => { /* best-effort */ })
        .finally(() => clearCotOrphanMarker(state));
    }
  } finally {
    state.pumping = false;
    // Work queued while we were failing/finishing a batch above.
    if (!state.disabled && (state.pendingEntries !== undefined || (state.finishStatus && !state.settled))) {
      void pump(ds, state);
    }
  }
}

/**
 * Entry point for the worker's `thinking_update` IPC. Returns true while the
 * native CoT message owns this turn's thinking channel; false when CoT is
 * off or disabled for the turn (thinking is then simply not displayed).
 */
export function handleCotThinkingUpdate(
  ds: DaemonSession,
  msg: Extract<WorkerToDaemon, { type: 'thinking_update' }>,
): boolean {
  if (!cotEnabled(ds)) return false;
  const key = turnKeyOf(msg);
  let state = states.get(ds);
  if (state && state.turnKey !== key) state = undefined; // superseded turn
  if (state?.disabled) return false;
  if (state?.settled) return true; // late updates after terminal: swallow
  if (!state) {
    state = {
      turnKey: key,
      turnId: msg.turnId,
      disabled: false,
      settled: false,
      sentCount: 0,
      pumping: false,
    };
    states.set(ds, state);
  }
  state.pendingEntries = msg.entries;
  void pump(ds, state);
  return true;
}

/**
 * Best-effort close of the session's live bubble when its worker dies WITHOUT
 * a turn_terminal (crash / kill — the only path that calls finalize). Without
 * this the bubble spins until the next daemon restart's orphan sweep, and the
 * daemon may not restart for days. Idempotent; no-op when nothing is live.
 */
export function abortCotMessage(ds: DaemonSession): void {
  const state = states.get(ds);
  if (!state || state.settled) return;
  if (state.disabled) {
    if (state.cotId) {
      state.settled = true;
      apiComplete(ds, state, 'error')
        .catch(() => { /* best-effort */ })
        .finally(() => clearCotOrphanMarker(state));
    }
    return;
  }
  if (!state.finishStatus) {
    state.finishStatus = 'interrupted';
    void pump(ds, state);
  }
}

/**
 * Settle the turn's CoT message, if this module owns it. Returns true when
 * owned. Idempotent.
 */
export function finalizeCotMessage(
  ds: DaemonSession,
  turnId: string,
  status: 'completed' | 'failed' | 'cancelled' | 'ambiguous',
): boolean {
  const state = states.get(ds);
  if (!state || state.turnId !== turnId) return false;
  if (state.disabled) {
    // A mid-turn push failure left the bubble unfinished (disabled before
    // finishStatus was set). Close it here rather than letting it spin until
    // the next daemon restart's orphan sweep.
    if (state.cotId && !state.settled) {
      state.settled = true;
      apiComplete(ds, state, 'error')
        .catch(() => { /* best-effort */ })
        .finally(() => clearCotOrphanMarker(state));
    }
    return false;
  }
  if (!state.finishStatus) {
    state.finishStatus = status === 'completed' ? 'done' : 'interrupted';
    void pump(ds, state);
  }
  return true;
}
