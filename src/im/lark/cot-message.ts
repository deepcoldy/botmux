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
 *   1. First update → POST create (chat-addressed; placement mirrors
 *      sessionReply's reply-target routing — thread targets create with
 *      `origin_message_id` + `reply_in_thread` so the bubble lands INSIDE the
 *      topic, see {@link cotPlacement}) → `{cot_id, message_id}` → push
 *      RUN_STARTED + REASONING_START prologue.
 *   2. Subsequent updates → PUT AG-UI events. The worker sends the FULL
 *      cumulative ENTRY LIST (thinking paragraphs + tool calls/results in
 *      transcript order, append-only); this module pushes each unseen entry
 *      as its own node — thinking as a reasoning message (START/CONTENT/END
 *      with a distinct messageId), tool calls as TOOL_CALL_START/ARGS/END,
 *      tool output as TOOL_CALL_RESULT. The client does not render
 *      TOOL_CALL_ARGS (verified by live A/B: sending full args and sending
 *      none render identically), so the command line / file path travels in
 *      TOOL_CALL_START.title — see {@link toolTitleSubject}. Single
 *      in-flight PUT per session, latest-wins.
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
import { fallbackTurnId, frozenReplyContextForTurn } from '../../core/reply-target.js';
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
  /** toolCallId → highlight language, resolved when the CALL is seen (a
   *  tool_result entry has no tool name) and consumed by its result. */
  resultLanguages?: Map<string, string>;
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
        // Annotate BEFORE terminating. Order is forced by the API, not a
        // preference: once a CoT is completed every later append is rejected
        // with "COT already in terminal state" (verified against the live
        // endpoint), so a note added after the complete would silently never
        // render. Best-effort — a failed note must still fall through to the
        // complete below, since an un-terminated bubble spins on「执行中」
        // forever, which is strictly worse than an unannotated one.
        //
        // The note ends in RUN_FINISHED, which already auto-completes the CoT
        // server-side (verified: a later append is refused as terminal), so
        // the complete below is redundant on the happy path. It is kept
        // deliberately: it is idempotent, it is the ONLY terminator when the
        // note fails, and dropping it would rewrite pre-existing assertions
        // for a saving on a fire-and-forget startup path that blocks nothing.
        try {
          await c.request({
            method: 'PUT',
            url: '/open-apis/im/v1/message_cot',
            data: {
              cot_id: rec.cotId,
              message_id: rec.messageId,
              events: interruptedNoticeEvents(rec.larkAppId),
            },
            timeout: COT_REQUEST_TIMEOUT_MS,
          } as any);
        } catch (err) {
          logger.warn(`[cot] orphan notice ${rec.cotId}: ${err instanceof Error ? err.message : String(err)}`);
        }
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

/**
 * Terminal batch for a bubble the daemon is abandoning mid-turn: a visible
 *「因重启中断」node followed by RUN_FINISHED(interrupted).
 *
 * Shared by both abandonment paths so they render identically:
 *   - graceful shutdown (still holds the in-memory state), and
 *   - the next generation's orphan sweep (only has the marker file).
 *
 * Callers MUST send this BEFORE terminating the CoT. Completing first is
 * irreversible: a later append is rejected with "COT already in terminal
 * state" (verified against the live endpoint), so the note would silently
 * never appear.
 */
function interruptedNoticeEvents(larkAppId: string, lastReasoningId?: string): CotEvent[] {
  const mid = `reasoning-interrupted-${lastReasoningId ?? 'orphan'}`;
  return [
    ev('REASONING_MESSAGE_START', { messageId: mid, role: 'reasoning' }),
    ev('REASONING_MESSAGE_CONTENT', { messageId: mid, delta: t('cot.interrupted', {}, localeForBot(larkAppId)) }),
    ev('REASONING_MESSAGE_END', { messageId: mid }),
    ev('RUN_FINISHED', { threadId: 'cot-interrupted', runId: mid, status: 'interrupted' }),
  ];
}

/**
 * Create-time placement, mirroring sessionReply's reply-target routing.
 *
 * `origin_message_id` alone only PARENTS the bubble (message.get shows
 * parent/root but no thread_id) — in a topic group it renders at CHAT level,
 * outside the topic. Landing inside requires `reply_in_thread: true` on the
 * create, same semantics as the ordinary reply API (verified empirically:
 * origin+flag → thread_id=omt_*, origin alone → none). So thread targets
 * (topic sessions, and chat-scope turns folded into a topic) set the flag on
 * their anchor; quote targets anchor without the flag; plain chat-scope turns
 * keep the old behavior — anchor to the triggering message when it is a real
 * Lark id (synthetic scheduler ids → bare chat-level bubble). The flag must
 * NEVER ride a plain-group anchor: reply_in_thread on a non-topic message
 * spawns a brand-new topic.
 *
 * Resolution goes through `frozenReplyContextForTurn × fallbackTurnId` — the
 * EXACT composition the streaming card uses (captureStreamingCardReplyTarget),
 * not the live `resolveSessionReplyTarget`. The two diverge on a busy session:
 * `replyTargets` is capped at 32 (REPLY_TARGETS_MAX) while `turnReplyContexts`
 * holds 256, so a turn registered at message-arrival can have its live entry
 * pruned before its first `thinking_update` creates the bubble — the frozen
 * context still says `{thread, om_fold}` where the live one has degraded to
 * `{plain}`. That would resurrect this very bug in the chat-scope fold-back
 * case. `fallbackTurnId` additionally covers entries with no turn context of
 * their own (`/cot show`), which then follow the session's current target.
 *
 * The `om_` shape check is a fuse, not decoration: `session.rootMessageId` is
 * NOT always a message id on a thread-scope session — a silent new-topic
 * schedule stores a virtual `schedule-run:<task>:<uuid>` anchor, chat-scope
 * keeps the chatId there as an audit seed, and `schedule add --topic
 * --root-msg-id <any string>` has no `om_` validation on the way in (the
 * cross-thread fire path at session-manager.ts:3255 anchors it verbatim
 * without ever probing it, so it does not self-heal). Feishu rejects a
 * non-`om_` origin, and a failed create disables thinking for the WHOLE turn —
 * strictly worse than a chat-level bubble. So degrade instead of throwing it
 * over the wire. (See the same constraint recorded in ask-card.ts:49.)
 */
function cotPlacement(ds: DaemonSession, state: CotState): { origin_message_id?: string; reply_in_thread?: boolean } {
  const target = frozenReplyContextForTurn(ds, fallbackTurnId(ds, state.turnId)).target;
  if (target.mode === 'thread' || target.mode === 'quote') {
    const anchor = target.rootMessageId;
    if (!anchor.startsWith('om_')) return {};
    return target.mode === 'thread'
      ? { origin_message_id: anchor, reply_in_thread: true }
      : { origin_message_id: anchor };
  }
  return state.turnId.startsWith('om_') ? { origin_message_id: state.turnId } : {};
}

async function apiCreate(ds: DaemonSession, state: CotState): Promise<void> {
  const c = getBotClient(ds.larkAppId);
  const res = await c.request({
    method: 'POST',
    url: '/open-apis/im/v1/message_cot',
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: ds.chatId,
      ...cotPlacement(ds, state),
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

/** Longest tool subject rendered after the category label. The title is a
 *  single unwrapped line in the bubble, so this is a layout bound, not a
 *  data bound — much tighter than COT_TOOL_ARGS_MAX_CHARS (600), which sizes
 *  a payload that turned out never to be rendered at all. */
const COT_TOOL_TITLE_SUBJECT_MAX_CHARS = 80;

/** Built-in Feishu CoT icon + i18n label key for a CLI tool name. The label
 *  becomes the node's `title` (the bubble shows a readable category like
 *  「执行命令」 instead of `Bash ({"command":…})`; the concrete subject —
 *  command line, file path — is appended by {@link toolTitle}). Matches by
 *  lowercase substring so it works across Claude's Bash/Read/Grep and
 *  MCP-style names without a per-CLI table. */
function toolMeta(name: string): { icon: string; labelKey: string } {
  const n = name.toLowerCase();
  if (n.includes('bash') || n.includes('shell') || n.includes('command')) return { icon: 'bash', labelKey: 'cot.tool.bash' };
  if (n.includes('write') || n.includes('edit') || n.includes('patch')) return { icon: 'write', labelKey: 'cot.tool.write' };
  if (n.includes('read') || n.includes('notebook')) return { icon: 'read', labelKey: 'cot.tool.read' };
  if (n.includes('grep') || n.includes('glob') || n.includes('search') || n.includes('fetch')) return { icon: 'search', labelKey: 'cot.tool.search' };
  if (n.includes('task') || n.includes('todo') || n.includes('plan')) return { icon: 'task', labelKey: 'cot.tool.task' };
  return { icon: 'default', labelKey: 'cot.tool.default' };
}

/**
 * The one-line subject for a tool call, in two forms.
 *
 * `full` is the whole single-line subject; `display` is `full` bounded to the
 * title's layout limit. They are separate because truncation is a RENDERING
 * concern and must not feed logic: resolving the highlight language off the
 * display string silently loses the extension of any path longer than the
 * cap (an 86-char `.ts` path degrades to plaintext), which is a bug reported
 * against the first version of this change.
 *
 * Why the subject lives in the title at all: Feishu's CoT renderer does NOT
 * draw TOOL_CALL_ARGS. Verified by a live A/B in a real chat — a node sending
 * the full JSON args and a control node sending no args event whatsoever
 * render identically, and reshaping the payload (bare string, `{type:'code'}`
 * envelope) changes nothing. A second TOOL_CALL_RESULT on the same call is
 * dropped too, so the title is the only surviving carrier. The args event is
 * still sent — it costs nothing and a future client may render it.
 *
 * `args` is whatever the CLI produced: a JSON object string for Claude
 * (`{"command":…}` / `{"file_path":…}`), but Codex's dominant
 * `custom_tool_call` ships a raw non-JSON script string, which is used as-is.
 * Text that LOOKS like JSON but will not parse is treated as truncated: the
 * priority fields are recovered by regex where possible (the transcript layer
 * hard-cuts args at 600 chars, which mangles Write/Edit payloads whose
 * `content` dwarfs the path, yet leaves the leading `"file_path":"…"` intact),
 * and only a total miss yields ''. Every "no usable subject" path returns ''
 * so the caller keeps the bare category label — exactly the pre-change
 * rendering.
 */
interface ToolSubject { display: string; full: string }

/** Fields ordered by how well each identifies the call to a human reader.
 *  `command` covers Claude's Bash and Codex's local_shell_call action;
 *  `description`/`prompt` catch sub-agent and task-style calls that carry no
 *  path or command of their own. */
const COT_SUBJECT_FIELDS = [
  'command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'skill', 'subject',
  'description', 'prompt',
] as const;

function toolTitleSubject(args: string): ToolSubject {
  const none: ToolSubject = { display: '', full: '' };
  const raw = args.trim();
  if (raw.length === 0) return none;
  let subject = raw;
  if (raw.startsWith('{')) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
    if (parsed && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>;
      const pick = COT_SUBJECT_FIELDS
        .map(k => o[k])
        .find(v => (typeof v === 'string' && v.trim().length > 0) || Array.isArray(v));
      if (pick === undefined) return none;
      // local_shell_call renders `command` as ["bash","-lc","…"] — the last
      // element is the script; joining the argv would bury it in boilerplate.
      subject = Array.isArray(pick)
        ? String(pick[pick.length - 1] ?? '').trim()
        : String(pick).trim();
      if (subject.length === 0) return none;
    } else {
      // Truncated JSON: rendering the raw `{"command":` fragment is worse than
      // rendering nothing, but the leading fields usually survive the cut, so
      // recover one by regex before giving up.
      const recovered = recoverSubjectFromTruncatedJson(raw);
      if (recovered === undefined) return none;
      subject = recovered;
    }
  }
  // Multi-line scripts must collapse: the title is one unwrapped line.
  const full = subject.replace(/\s+/g, ' ').trim();
  if (full.length === 0) return none;
  const display = full.length > COT_TOOL_TITLE_SUBJECT_MAX_CHARS
    ? `${full.slice(0, COT_TOOL_TITLE_SUBJECT_MAX_CHARS)}…`
    : full;
  return { display, full };
}

/** Pull the first priority field out of JSON that was cut mid-payload. Only
 *  complete `"key":"value"` pairs match, so a value truncated mid-string is
 *  skipped rather than shown half-rendered. */
function recoverSubjectFromTruncatedJson(raw: string): string | undefined {
  for (const key of COT_SUBJECT_FIELDS) {
    const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (!m) continue;
    let value: string;
    try { value = JSON.parse(`"${m[1]}"`); } catch { continue; } // bad escape → skip
    if (value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** Category label plus the concrete subject when one can be extracted. */
function toolTitle(ds: DaemonSession, entry: { name: string; args: string }, labelKey: string, subject: string): string {
  const label = t(labelKey, { name: entry.name }, localeForBot(ds.larkAppId));
  return subject.length > 0 ? `${label} · ${subject}` : label;
}
/**
 * Syntax-highlighting language for a tool's output code block.
 *
 * Verified live: the renderer echoes `language` VERBATIM and performs no
 * auto-detection of its own — a made-up value renders as that literal string
 * in the block header, and unmistakably-Python content with no language set
 * still reads「plaintext」. So this must be a WHITELIST, never a passthrough
 * of the file extension: sending `mjs`/`yml`/`tsx` unmapped would print those
 * as the label. Anything unrecognised returns undefined → the field is
 * omitted → the block falls back to「plaintext」, i.e. today's rendering.
 */
const COT_EXT_LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift',
  php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml',
  html: 'html', css: 'css', scss: 'scss', sql: 'sql', md: 'markdown',
};

function resultLanguage(toolName: string | undefined, subject: string | undefined): string | undefined {
  if (!toolName) return undefined;
  const n = toolName.toLowerCase();
  // Shell output is shell-shaped regardless of what the command touched.
  // `exec` is matched as a WHOLE word, not a substring: `execute_sql` /
  // `execute_python` are ordinary tools whose output is not shell.
  if (n.includes('bash') || n.includes('shell') || n.includes('command') || /(^|[^a-z])exec([^a-z]|$)/.test(n)) return 'bash';
  // Search/fetch tools return matches or a rendered page — never the file the
  // subject names. Without this, a `.json` URL or a `readme\.md` grep pattern
  // would label prose or match-lists as that language. Mirrors the same family
  // that toolMeta groups under the search icon.
  if (n.includes('fetch') || n.includes('search') || n.includes('grep') || n.includes('glob')) return undefined;
  // File tools: the subject is the path, so the extension names the language.
  const ext = subject?.match(/\.([A-Za-z0-9]+)\s*$/)?.[1]?.toLowerCase();
  return ext ? COT_EXT_LANGUAGES[ext] : undefined;
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
    const subject = toolTitleSubject(entry.args);
    // A tool_result entry carries only {id, result} — no tool name — so the
    // language has to be resolved here, while the call's name and subject are
    // in hand, and remembered for the matching result. Detection uses the
    // UNTRUNCATED subject: a path longer than the title cap still ends in its
    // extension, which the display string has already lost to the ellipsis.
    const lang = resultLanguage(entry.name, subject.full);
    if (lang) {
      if (!state.resultLanguages) state.resultLanguages = new Map();
      state.resultLanguages.set(entry.id, lang);
    }
    return [
      ev('TOOL_CALL_START', {
        toolCallId: entry.id,
        icon: meta.icon,
        title: toolTitle(ds, entry, meta.labelKey, subject.display),
        toolCallName: entry.name,
        ...(state.lastReasoningId ? { parentMessageId: state.lastReasoningId } : {}),
      }),
      ...(entry.args.length > 0 ? [ev('TOOL_CALL_ARGS', { toolCallId: entry.id, delta: entry.args })] : []),
      ev('TOOL_CALL_END', { toolCallId: entry.id }),
    ];
  }
  if (entry.result.length === 0) return [];
  const language = state.resultLanguages?.get(entry.id);
  return [
    ev('TOOL_CALL_RESULT', {
      messageId: `tr-${entry.id}`,
      toolCallId: entry.id,
      role: 'tool',
      content: JSON.stringify({ type: 'code', ...(language ? { language } : {}), code: entry.result }),
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
 * Settle this session's live bubble as「因重启中断」during a GRACEFUL daemon
 * shutdown. Awaitable on purpose: shutdown must be able to hold its budget
 * open until the note is actually delivered, unlike {@link abortCotMessage}
 * (fire-and-forget, used on the worker-exit path where nothing awaits).
 *
 * Why this exists on top of the orphan sweep: the sweep is the NEXT
 * generation's fallback and can only reach bubbles whose marker survived. It
 * cannot annotate anything the current process still owns in memory before
 * the marker is consumed, and it is skipped entirely when the daemon is
 * SIGKILLed after this point. Annotating here covers the common path; the
 * sweep covers SIGKILL / power loss.
 *
 * Clears the orphan marker on success so the next generation does not
 * annotate the same bubble twice.
 */
export async function settleCotMessageForShutdown(ds: DaemonSession): Promise<void> {
  const state = states.get(ds);
  if (!state || state.settled || !state.cotId) return;
  // A turn that is already finishing owns its own terminal batch: `pump` may be
  // parked on an await with its `!state.settled` check already passed, so
  // claiming the turn here would put a SECOND RUN_FINISHED on the wire (caught
  // by the shutdown-vs-finalize race test). The pump also clears the orphan
  // marker, so nothing is left spinning — leave it alone.
  if (state.finishStatus) return;
  state.settled = true; // claim it: a concurrent abort/finalize must not double-send
  try {
    if (!state.disabled) {
      await apiAppend(ds, state, interruptedNoticeEvents(ds.larkAppId, state.lastReasoningId));
    } else {
      // A mid-turn failure already disabled pushes for this turn; appending
      // would fail too. Just terminate so it stops spinning.
      await apiComplete(ds, state, 'error');
    }
  } catch {
    // Notice failed — still terminate, for the same reason the sweep does:
    // an unannotated closed bubble beats one that spins forever.
    try { await apiComplete(ds, state, 'error'); } catch { /* best-effort */ }
  } finally {
    clearCotOrphanMarker(state);
  }
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
