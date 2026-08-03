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
 *   - `error`    — API/provider error (e.g. "Cancelled by backend") → `failed`
 *                  (`pi_turn_error`). Hard terminal (turn_end→return) regardless
 *                  of content, so it always emits.
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
 * `terminate` is not persisted), so that turn has NO on-disk boundary. We do not
 * synthesize one; quiescence idle marks the session ready and the next ordinary
 * user turn HOL-drops the unclosed collecting head.
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
 *  - `error` → `failed` (`pi_turn_error`): an explicit provider error.
 *  - `aborted` → `ambiguous` (`pi_turn_aborted`): a user Esc can land AFTER a
 *    tool's side effect already completed, so we don't assert it "did not
 *    happen" — same audit semantic as Codex/TraeX `turn_aborted`.
 *  All non-`stop`/`length` map to `!== 'completed'`, so the pending turn is
 *  dropped and the type-ahead queue head is released, never wedged. */
function piTerminalOutcome(stopReason: PiTerminalStopReason): Pick<
  PiBridgeEvent,
  'terminalStatus' | 'terminalErrorCode'
> {
  switch (stopReason) {
    case 'stop':
    case 'length':
      return {};
    case 'error':
      return { terminalStatus: 'failed', terminalErrorCode: 'pi_turn_error' };
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

export function drainPiTranscript(path: string, fromOffset: number): PiDrainResult {
  if (!existsSync(path)) return { events: [], newOffset: 0, pendingTail: '' };
  let size: number;
  try { size = statSync(path).size; } catch { return { events: [], newOffset: fromOffset, pendingTail: '' }; }
  let start = fromOffset;
  if (size < start) start = 0;
  if (size === start) return { events: [], newOffset: start, pendingTail: '' };

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
    if (obj?.type !== 'message' || !obj.message || typeof obj.message !== 'object') continue;
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    const timestampMs = Number.isFinite(ts) ? ts : Date.now();
    const role = obj.message.role;

    if (role === 'user') {
      const content = joinTextContent(obj.message.content);
      if (!content) continue;
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
    //   - `error`/`aborted` are HARD terminals: Pi's agent loop does
    //     turn_end→agent_end→return regardless of content, so they MUST emit
    //     even empty, or the collecting head never closes.
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
    // deliberately do NOT try to synthesize one — quiescence idle still marks
    // the session ready, and the next ordinary user turn HOL-drops the
    // unclosed collecting head. (botmux ships no such tool.)
    const isHardTerminal = stopReason === 'error' || stopReason === 'aborted';
    const isTextTerminal = (stopReason === 'stop' || stopReason === 'length')
      && !hasToolCall(obj.message.content);
    if (!isHardTerminal && !isTextTerminal) continue;

    events.push({
      uuid: `${path}:${lineStart}`,
      timestampMs,
      kind: 'assistant_final',
      text: joinTextContent(obj.message.content),
      sourceSessionId: sessionId,
      ...piTerminalOutcome(stopReason as PiTerminalStopReason),
    });
  }

  return { events, newOffset, pendingTail };
}
