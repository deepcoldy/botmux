/**
 * Reader for Pi agent's per-session JSONL transcript.
 *
 * Pi stores sessions under:
 *   ~/.pi/agent/sessions/<workspace-encoded>/<timestamp>_<sessionId>.jsonl
 *
 * Bridge contract (same as Codex/Grok/CoCo): emit only
 *   - `user`            — a real user prompt (`message.role === "user"`).
 *   - `assistant_final` — an assistant record carrying a TERMINAL `stopReason`.
 *
 * ## Turn boundary (verified on pi 0.80.6; `@earendil-works/pi-ai` StopReason
 * union = `"stop" | "length" | "toolUse" | "error" | "aborted"`):
 *   - `toolUse`  — mid-turn (the model is calling a tool); never a boundary. In
 *                  real transcripts toolCall content always pairs with
 *                  stopReason:"toolUse" (255/255).
 *   - `stop`     — normal completion → `completed`, but terminal ONLY when the
 *                  message has NO tool calls. A `stop`+toolCall enters the
 *                  agent-loop's tool branch (`executeToolCalls`) and keeps
 *                  looping unless the batch returns `terminate:true`, so the
 *                  real final comes later — emitting here would publish a
 *                  premature final and orphan the true one.
 *   - `length`   — output hit the model's max-output cap → `completed`, terminal
 *                  ONLY without tool calls (a `length`+toolCall is mid-turn: Pi
 *                  runs failToolCallsFromTruncatedMessage (terminate:false) and
 *                  keeps looping).
 *   - `error`    — API/provider error (e.g. "Cancelled by backend") → `failed`.
 *                  The record's `errorMessage` is classified via the shared
 *                  Codex-family classifier (gateway/connection/auth/…) and a
 *                  redacted summary is carried on the event; without an
 *                  errorMessage the code stays `pi_turn_error`. Hard terminal
 *                  (turn_end→return) regardless of content, so it always emits.
 *   - `aborted`  — user interrupt (Esc) → `ambiguous` (`pi_turn_aborted`). Hard
 *                  terminal. `ambiguous` (not `failed`) because Esc may land
 *                  after a tool side effect already ran — same audit semantic as
 *                  Codex/TraeX `turn_aborted`. Verified: Pi persists an
 *                  `assistant` record with `stopReason:"aborted"` +
 *                  `errorMessage:"Operation aborted"` and empty content.
 *
 * A terminal event is emitted even when its visible text is EMPTY (error/aborted
 * turns): keyed to Pi's stopReason, not to whether the model produced a closing
 * paragraph — otherwise under type-ahead the collecting turn never closes and
 * CodexBridgeQueue's head wedges. `terminalStatus`/`terminalErrorCode` are best-
 * effort attribution metadata: Pi does NOT set `reliableTurnTerminal` (see
 * pi.ts — it holds no session fd and a custom-terminate turn has no on-disk
 * boundary), so these are not treated as durable-delivery receipts.
 *
 * Accepted gap: a custom tool returning `terminate:true` ends the agent right
 * after its toolResult with the last assistant record being `toolUse` (and
 * `terminate` is not persisted — re-verified on pi 0.84.2: SessionManager
 * writes no terminate field, and the newer `pending`/`deferred` StopReasons
 * are provider-stream states that never reach the session JSONL). We do not
 * synthesize a boundary; with pi in STRUCTURED_BRIDGE_LIFECYCLE_BLOCKING_CLI_IDS
 * such a turn keeps the session projected busy until the next ordinary user
 * turn HOL-drops the unclosed collecting head (botmux ships no such tool).
 *
 * ## Type-ahead shape
 * Pi's Message Queue is an active-turn STEER (TUI shows "Steering: …" +
 * "Alt+Up to edit all queued messages"): a message submitted while a turn is
 * running is pulled into that SAME turn, which emits one merged final
 * (transcript: user1 → toolUse/toolResult… → user2 → assistant_final). The
 * queued user event is written at DEQUEUE time (its timestamp matches the
 * unblocking toolResult, not the submit), so CodexBridgeQueue's HOL-block-drop
 * + dequeue-time markTimeMs override attribute the single final to the newest
 * matching turn — identical to Codex/Grok. Non-steered turns stay strictly
 * interleaved (user → assistant_final → user → assistant_final).
 */
import { existsSync, statSync, openSync, readSync, closeSync, readdirSync, readlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { codexTaskFailureCode, safeFailureSummary } from './codex-transcript.js';
import {
  PI_TURN_BOUNDARY_CUSTOM_TYPE,
  PI_TURN_BOUNDARY_STOP_REASON_ERROR,
} from '../adapters/cli/pi-turn-boundary-extension.js';

const PI_SESSIONS_ROOT = join(homedir(), '.pi', 'agent', 'sessions');
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IS_LINUX = platform() === 'linux';

export interface PiBridgeEvent {
  uuid: string;
  timestampMs: number;
  kind: 'user' | 'assistant_final';
  text: string;
  /** Best-effort terminal outcome carried by an `assistant_final` (attribution
   *  metadata, NOT a durable receipt — Pi has no reliableTurnTerminal). Undefined
   *  on a `stop`/`length` completion (keeps the historical completed default and
   *  lets the empty-final fallback fire); `failed` for `error`, `ambiguous` for
   *  `aborted`. */
  terminalStatus?: 'completed' | 'failed' | 'ambiguous';
  terminalErrorCode?: string;
  /** Safe, bounded user-facing detail extracted from the record's
   *  `errorMessage` (redacted through safeFailureSummary). Raw provider errors
   *  stay in the session JSONL / Web terminal. */
  terminalErrorSummary?: string;
  sourceSessionId?: string;
}

/** Assistant stopReason values that can CLOSE a turn (subject to the no-tool-call
 *  gate for stop/length — see drainPiTranscript). `toolUse` is never terminal. */
type PiTerminalStopReason = 'stop' | 'length' | 'error' | 'aborted';

/** Map Pi's terminal stopReason to best-effort attribution metadata carried on
 *  the assistant_final. NOT a durable-delivery receipt (Pi has no
 *  reliableTurnTerminal — see pi.ts); the worker uses these only for
 *  CodexBridgeQueue emit ordering / dedup.
 *  - `stop`/`length` → real answers → completed (undefined status keeps the
 *    historical default + lets the empty-final fallback fire).
 *  - `error` → `failed`: an explicit provider error. When the record carries
 *    an `errorMessage` (e.g. "upstream stream error: rpc error: code = 1 desc
 *    = Cancelled by backend" from the model gateway), classify it through the
 *    shared Codex-family classifier so the failure card names the real cause
 *    (gateway/connection/auth/…) and carries a redacted summary instead of
 *    the opaque "no error summary" fallback. Without an errorMessage the code
 *    stays `pi_turn_error`.
 *  - `aborted` → `ambiguous` (`pi_turn_aborted`): a user Esc can land AFTER a
 *    tool's side effect already completed, so we don't assert it "did not
 *    happen" — same audit semantic as Codex/TraeX `turn_aborted`.
 *  All non-`stop`/`length` map to `!== 'completed'`, so the pending turn is
 *  dropped and the type-ahead queue head is released, never wedged. */
function piTerminalOutcome(
  stopReason: PiTerminalStopReason,
  errorMessage?: string,
): Pick<PiBridgeEvent, 'terminalStatus' | 'terminalErrorCode' | 'terminalErrorSummary'> {
  switch (stopReason) {
    case 'stop':
    case 'length':
      return {};
    case 'error': {
      if (!errorMessage) {
        return { terminalStatus: 'failed', terminalErrorCode: 'pi_turn_error' };
      }
      const summary = safeFailureSummary(errorMessage);
      return {
        terminalStatus: 'failed',
        terminalErrorCode: codexTaskFailureCode(errorMessage),
        ...(summary ? { terminalErrorSummary: summary } : {}),
      };
    }
    case 'aborted':
      return { terminalStatus: 'ambiguous', terminalErrorCode: 'pi_turn_aborted' };
  }
}

export interface PiDrainResult {
  events: PiBridgeEvent[];
  newOffset: number;
  pendingTail: string;
}

function piSessionsDirForCwd(cwd: string): string {
  const normalized = cwd === '/' ? '--root--' : cwd.replace(/\//g, '--');
  return join(PI_SESSIONS_ROOT, normalized);
}

function piSessionIdFromPath(path: string): string | undefined {
  const m = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path);
  return m ? m[1] : undefined;
}

function matchPiTranscriptPath(target: string): { path: string; cliSessionId: string } | undefined {
  if (!target.endsWith('.jsonl')) return undefined;
  if (!target.includes('/.pi/agent/sessions/')) return undefined;
  const sid = piSessionIdFromPath(target);
  if (!sid) return undefined;
  return { path: target, cliSessionId: sid };
}

function joinTextContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if ((item as any).type === 'text' && typeof (item as any).text === 'string') {
      parts.push((item as any).text);
    }
  }
  return parts.join('\n').trim();
}

/** True when an assistant message contains a tool call. Pi's agent loop keeps a
 *  turn RUNNING whenever the assistant message carries tool calls — including a
 *  `length` (token-cap) message, whose truncated calls it fails and then loops
 *  again (failToolCallsFromTruncatedMessage → terminate:false). Only a terminal
 *  stopReason on a message WITHOUT tool calls actually ends the turn. */
function hasToolCall(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((item) => item && typeof item === 'object' && (item as any).type === 'toolCall');
}

export function findPiTranscriptBySessionId(cliSessionId: string, cwd?: string): string | undefined {
  if (!cliSessionId || !SESSION_UUID_RE.test(cliSessionId)) return undefined;
  const suffix = `_${cliSessionId}.jsonl`;
  const roots = cwd ? [piSessionsDirForCwd(cwd), PI_SESSIONS_ROOT] : [PI_SESSIONS_ROOT];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const stack: string[] = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: string[];
      try { entries = readdirSync(dir); } catch { continue; }
      for (const name of entries) {
        const full = join(dir, name);
        let st: ReturnType<typeof statSync>;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) {
          stack.push(full);
        } else if (st.isFile() && name.endsWith(suffix)) {
          return full;
        }
      }
    }
  }
  return undefined;
}

export function findPiTranscriptByPid(pid: number): { path: string; cliSessionId: string } | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (IS_LINUX) {
    const fdDir = `/proc/${pid}/fd`;
    if (existsSync(fdDir)) {
      let entries: string[];
      try { entries = readdirSync(fdDir); } catch { return undefined; }
      for (const fd of entries) {
        let target: string;
        try { target = readlinkSync(join(fdDir, fd)); } catch { continue; }
        const hit = matchPiTranscriptPath(target);
        if (hit) return hit;
      }
      return undefined;
    }
  }
  let out: string;
  try {
    out = execSync(`lsof -p ${pid} -Fn`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return undefined;
  }
  for (const line of out.split('\n')) {
    if (!line.startsWith('n/')) continue;
    const target = line.slice(1);
    const hit = matchPiTranscriptPath(target);
    if (hit) return hit;
  }
  return undefined;
}

/** How long a held error may wait for its turn-boundary marker before the
 *  reader gives up and reports it anyway.
 *
 *  The marker can legitimately never arrive: Pi was SIGKILLed mid-retry, the
 *  extension failed to load, or the session predates it. Waiting forever would
 *  turn a real outage into silence — strictly worse than today's false alarms,
 *  because the user would never learn the turn died. So the hold is bounded.
 *
 *  Sized from the real distribution: across 231 local sessions, an error record
 *  that was followed by the same turn continuing saw the next record within
 *  18.8s at p50, 90.3s at p95 and 165.6s at the maximum. 300s clears that
 *  maximum with room to spare, so a recovering turn is never reported early;
 *  a genuinely dead turn is reported late rather than never. */
export const PI_TURN_BOUNDARY_TIMEOUT_MS = 300_000;

/** Per-transcript state that must survive across drain calls: a turn's records
 *  routinely straddle two reads (the poller fires every second, Pi appends
 *  whenever it likes). Keyed by transcript path and bounded, mirroring
 *  `traexPendingAgentCache`. */
interface PiPendingTurnState {
  /** Newest `stopReason:"error"` record of the turn currently in flight, held
   *  until we learn whether the turn recovered or really failed.
   *  `heldSinceMs` is the drain clock at which the hold started (set on the
   *  first drain that observes it, not on the record's own timestamp). */
  error?: {
    uuid: string;
    timestampMs: number;
    text: string;
    errorMessage?: string;
    heldSinceMs?: number;
  };
  /** Sticky: set once ANY turn-boundary marker is seen on this transcript.
   *  Proves the boundary extension is live for this session, after which the
   *  marker — not a user record — owns the release decision. See the
   *  `role === 'user'` branch for why that matters (steer). */
  markerSeen?: boolean;
}

const piPendingTurnCache = new Map<string, PiPendingTurnState>();
const PI_PENDING_TURN_CACHE_MAX = 512;

function piPendingTurnState(path: string): PiPendingTurnState {
  let state = piPendingTurnCache.get(path);
  if (!state) {
    state = {};
    piPendingTurnCache.set(path, state);
    if (piPendingTurnCache.size > PI_PENDING_TURN_CACHE_MAX) {
      const oldest = piPendingTurnCache.keys().next().value;
      if (oldest !== undefined) piPendingTurnCache.delete(oldest);
    }
  }
  return state;
}

/** Drop held state for a transcript. Exported so tests can assert a clean slate
 *  without reaching into module internals. */
export function resetPiPendingTurnState(path?: string): void {
  if (path === undefined) piPendingTurnCache.clear();
  else piPendingTurnCache.delete(path);
}

/** True when a session record is the turn-boundary marker appended by
 *  `pi-turn-boundary-extension`. Kept structural (not a cast) because the file
 *  is written by another process and may predate the extension. */
function piTurnBoundaryStopReason(obj: any): { present: boolean; lastStopReason?: string } {
  if (obj?.type !== 'custom' || obj.customType !== PI_TURN_BOUNDARY_CUSTOM_TYPE) {
    return { present: false };
  }
  const raw = obj.data?.lastStopReason;
  return { present: true, lastStopReason: typeof raw === 'string' ? raw : undefined };
}

/** Turn a held error into the turn's failure event and clear the hold. The one
 *  place that shape is built, so the three release paths (boundary marker, new
 *  user turn, timeout backstop) cannot drift apart. Returns [] when nothing is
 *  held, so callers can splat it unconditionally. */
function flushHeldPiError(
  state: PiPendingTurnState,
  sessionId: string | undefined,
): PiBridgeEvent[] {
  const held = state.error;
  if (!held) return [];
  state.error = undefined;
  return [{
    uuid: held.uuid,
    timestampMs: held.timestampMs,
    kind: 'assistant_final',
    text: held.text,
    sourceSessionId: sessionId,
    ...piTerminalOutcome('error', held.errorMessage),
  }];
}

/** Emit a held error whose boundary marker never arrived within
 *  `PI_TURN_BOUNDARY_TIMEOUT_MS`. Called on EVERY drain — including the
 *  no-new-bytes early return, which is precisely the shape of the case this
 *  guards (Pi died mid-turn, so the file stops growing and the marker will
 *  never be written). Anchored on the drain clock rather than the record's own
 *  timestamp so a transcript replayed from an old file cannot fire it. */
function flushPiPendingError(
  path: string,
  sessionId: string | undefined,
  nowMs: number,
): PiBridgeEvent[] {
  const state = piPendingTurnCache.get(path);
  const held = state?.error;
  if (!state || !held) return [];
  if (held.heldSinceMs === undefined) {
    held.heldSinceMs = nowMs;
    return [];
  }
  if (nowMs - held.heldSinceMs < PI_TURN_BOUNDARY_TIMEOUT_MS) return [];
  return flushHeldPiError(state, sessionId);
}

export function drainPiTranscript(
  path: string,
  fromOffset: number,
  /** Injectable clock for the held-error timeout. Tests pass a fixed value;
   *  production uses wall clock. */
  nowMs: number = Date.now(),
): PiDrainResult {
  if (!existsSync(path)) return { events: [], newOffset: 0, pendingTail: '' };
  let size: number;
  try { size = statSync(path).size; } catch { return { events: [], newOffset: fromOffset, pendingTail: '' }; }
  let start = fromOffset;
  if (size < start) start = 0;
  if (size === start) {
    return {
      events: flushPiPendingError(path, piSessionIdFromPath(path), nowMs),
      newOffset: start,
      pendingTail: '',
    };
  }

  const len = size - start;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }

  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  const completeText = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';
  const pendingTail = lastNl >= 0 ? text.slice(lastNl + 1) : text;
  const newOffset = start + Buffer.byteLength(completeText, 'utf8');

  const sessionId = piSessionIdFromPath(path);
  const events: PiBridgeEvent[] = [];
  const pending = piPendingTurnState(path);
  let cursor = start;
  for (const line of completeText.split('\n')) {
    if (line.length === 0) {
      cursor += 1;
      continue;
    }
    const lineStart = cursor;
    cursor += Buffer.byteLength(line, 'utf8') + 1;

    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    // Turn-boundary marker (our extension). Written on Pi's `agent_settled`,
    // i.e. once no automatic retry / compaction retry / queued continuation
    // remains — so it is ordered AFTER every assistant record of the turn it
    // closes. This is the ONLY place a held error becomes a user-visible
    // failure: `lastStopReason === 'error'` means the turn really ended that
    // way; anything else means Pi recovered and the held error is dropped.
    const boundary = piTurnBoundaryStopReason(obj);
    if (boundary.present) {
      // One marker proves the extension is live here; from now on the marker
      // (or the backstop) resolves holds, never a bare user record. Set before
      // the branch below so the session_start announcement counts too.
      pending.markerSeen = true;
      // A declaration marker (`lastStopReason: null`, written on session_start
      // — including EVERY resume, which re-fires session_start) carries no
      // verdict. It must NEVER be read as "this turn settled cleanly", or a
      // second declaration after a mid-turn crash would silently drop a held
      // error. Only a marker that actually closes a turn resolves the hold.
      if (boundary.lastStopReason === undefined) continue;
      if (boundary.lastStopReason === PI_TURN_BOUNDARY_STOP_REASON_ERROR) {
        events.push(...flushHeldPiError(pending, sessionId));
      } else {
        pending.error = undefined;
      }
      continue;
    }

    if (obj?.type !== 'message' || !obj.message || typeof obj.message !== 'object') continue;
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    const timestampMs = Number.isFinite(ts) ? ts : Date.now();
    const role = obj.message.role;

    if (role === 'user') {
      const content = joinTextContent(obj.message.content);
      if (!content) continue;
      // A user record can mean two very different things, and only one of them
      // ends the held error's turn:
      //
      //   • A genuinely NEW turn — the previous turn's last word was an error,
      //     so it really did fail and must be reported before this turn's
      //     events. Without this the failure is swallowed when the NEXT turn's
      //     terminal clears the hold. Measured on real transcripts: 104 error
      //     records are immediately followed by a new user record.
      //   • A STEER — input submitted while the turn was still running. Pi's
      //     retry entry point re-reads the steering queue at the TOP of the
      //     loop ("Check for steering messages at start", agent-loop.ts), so a
      //     message that lands during the retry backoff (2s/4s/8s, up to 14s
      //     per turn) writes its user record BETWEEN the error and its retry.
      //     Flushing there posts a failure card for a turn that then succeeds —
      //     exactly the false alarm this whole mechanism removes.
      //
      // We cannot tell them apart from the user record alone. But we do not
      // have to: when the boundary extension is loaded the marker resolves
      // every held error on its own, so this release is pure downside there —
      // it can only mis-fire on a steer. It earns its keep ONLY on transcripts
      // that will never produce a marker (adopt sessions, a compiled binary,
      // sessions predating the extension), where it is the sole timely signal
      // and the alternative is waiting out the 300s backstop.
      //
      // `markerSeen` is sticky per transcript: one marker proves the extension
      // is live for this session, and from then on the boundary owns the
      // decision. Before the first marker we keep releasing, so a
      // marker-less session still reports its failures promptly.
      if (!pending.markerSeen) events.push(...flushHeldPiError(pending, sessionId));
      events.push({
        uuid: `${path}:${lineStart}`,
        timestampMs,
        kind: 'user',
        text: content,
        sourceSessionId: sessionId,
      });
      continue;
    }

    // Only assistant records can close a turn. `toolResult` / `bashExecution`
    // and any other role are mid-turn plumbing and never a boundary.
    if (role !== 'assistant') continue;

    const stopReason =
      typeof obj.stopReason === 'string'
        ? obj.stopReason
        : typeof obj.message.stopReason === 'string'
          ? obj.message.stopReason
          : undefined;

    // `toolUse` (and any missing/unknown reason) is mid-turn — the model is
    // still working; wait for the terminal record.
    //   - `aborted` is a HARD terminal: Pi's agent loop does
    //     turn_end→agent_end→return regardless of content, so it MUST emit
    //     even empty, or the collecting head never closes.
    //   - `error` is NOT a turn terminal on its own. Pi is an agent loop and
    //     `stopReason` describes ONE model request: on a transient provider
    //     failure Pi retries inside the SAME turn (agent-session.ts strips the
    //     record from LLM context while deliberately keeping it in the session
    //     file). Measured over 231 real local sessions, 229/339 error records
    //     were followed by that same turn continuing. Treating one as terminal
    //     posted a "gateway failure" card — and @mentioned a human — for turns
    //     that then succeeded. So an error record is HELD: it closes the turn
    //     only once the turn-boundary marker says the turn really settled that
    //     way (see the `custom` branch above and `flushPiPendingError`).
    //   - `stop`/`length` end the turn ONLY when the message has NO tool calls.
    //     Both can carry tool calls mid-turn: agent-loop runs the batch and
    //     keeps looping unless it terminates (`length` → failToolCallsFrom-
    //     TruncatedMessage → terminate:false always; `stop` → executeToolCalls,
    //     loops when the batch doesn't set terminate:true). Emitting on a
    //     tool-carrying stop/length would publish a premature final + fireIdle,
    //     then the real later final would arrive unmatched — breaking type-ahead
    //     attribution. So gate both on "no tool call".
    // Accepted limitation (why we don't claim reliableTurnTerminal): a custom
    // tool returning terminate:true ends the agent right after its toolResult;
    // the last assistant record is `toolUse` (not a terminal stopReason) and
    // `terminate` is NOT persisted, so that turn has no on-disk end marker. We
    // deliberately do NOT try to synthesize one — with pi lifecycle-blocking
    // the started turn keeps the session projected busy until the next
    // ordinary user turn HOL-drops the unclosed collecting head. (botmux
    // ships no such tool.)
    const isHardTerminal = stopReason === 'aborted';
    const isTextTerminal = (stopReason === 'stop' || stopReason === 'length')
      && !hasToolCall(obj.message.content);

    // Provider error detail (verified on pi 0.84.2: lives on `message`, next to
    // stopReason; accept a top-level fallback mirroring the stopReason read).
    const errorMessage =
      typeof obj.message.errorMessage === 'string'
        ? obj.message.errorMessage
        : typeof obj.errorMessage === 'string'
          ? obj.errorMessage
          : undefined;

    if (stopReason === 'error') {
      // Hold the newest error of this turn. If the turn recovers, the later
      // `stop`/`length` terminal drops it; if the turn really failed, the
      // boundary marker flushes exactly this one as the turn's failure. Any
      // partial text stays attached so a failed turn can still show what the
      // model managed to say.
      pending.error = {
        uuid: `${path}:${lineStart}`,
        timestampMs,
        text: joinTextContent(obj.message.content),
        errorMessage,
      };
      continue;
    }

    if (!isHardTerminal && !isTextTerminal) continue;

    // A real terminal supersedes any held error: the turn moved past it.
    pending.error = undefined;

    events.push({
      uuid: `${path}:${lineStart}`,
      timestampMs,
      kind: 'assistant_final',
      text: joinTextContent(obj.message.content),
      sourceSessionId: sessionId,
      ...piTerminalOutcome(stopReason as PiTerminalStopReason, errorMessage),
    });
  }

  // A held error whose boundary marker is overdue is reported anyway, so a Pi
  // that died mid-retry still surfaces its failure instead of going silent.
  events.push(...flushPiPendingError(path, sessionId, nowMs));

  return { events, newOffset, pendingTail };
}
