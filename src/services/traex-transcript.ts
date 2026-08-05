/**
 * Reader for TRAE CLI (traex / traecli) per-session rollout JSONL.
 *
 * TRAE is a Codex-family CLI, but its terminal event is NOT byte-identical to
 * upstream Codex:
 *   - user input is a response_item role=user message, like Codex;
 *   - assistant response_item messages have no `phase` and are emitted many
 *     times during tool use, so none of them is a safe turn boundary;
 *   - event_msg `task_complete` is the durable end-of-turn marker and carries
 *     the final visible text in `last_agent_message` (which may be empty).
 *   - Directory layout differs: sessions live under
 *     ~/.trae/cli/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl
 *     (note the extra `cli/` level vs Codex's ~/.codex/sessions/...).
 *
 * This module therefore owns a small TRAE-specific incremental reader while
 * reusing the Codex queue event shape and history helpers.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  statSync,
} from 'node:fs';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import { join } from 'node:path';
import {
  splitCodexEventsByCutoff,
  extractLastCodexTurn,
  type CodexBridgeEvent,
  type CodexDrainResult,
  codexSessionIdFromRolloutPath,
} from './codex-transcript.js';
import { traeSessionsRoot } from './traex-paths.js';

export { splitCodexEventsByCutoff as splitTraexEventsByCutoff };
export { extractLastCodexTurn as extractLastTraexTurn };
export type { CodexBridgeEvent as TraexBridgeEvent, CodexDrainResult as TraexDrainResult };

const IS_LINUX = platform() === 'linux';

function joinInputText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as any).type === 'input_text') {
      const text = (block as any).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('');
}

function eventTimestampMs(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function abortErrorCode(reason: unknown): string {
  const normalized = (typeof reason === 'string' ? reason : 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'unknown';
  return `traex_turn_aborted:${normalized}`;
}

/** Incrementally drain complete TRAE rollout lines.
 *
 * `task_complete` is intentionally emitted even when last_agent_message is
 * missing/empty: a silent successful turn still has to release a durable
 * delivery. A non-newline-terminated tail is never parsed, so a process crash
 * halfway through the terminal JSON object cannot manufacture completion. */
export function drainTraexRollout(path: string, fromOffset: number): CodexDrainResult {
  if (!existsSync(path)) return { events: [], newOffset: 0, pendingTail: '' };
  let size: number;
  try { size = statSync(path).size; } catch { return { events: [], newOffset: fromOffset, pendingTail: '' }; }
  let start = fromOffset;
  if (size < start) start = 0;
  if (size === start) return { events: [], newOffset: start, pendingTail: '' };

  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  const completeText = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';
  const pendingTail = lastNl >= 0 ? text.slice(lastNl + 1) : text;
  const newOffset = start + Buffer.byteLength(completeText, 'utf8');
  const sourceSessionId = codexSessionIdFromRolloutPath(path);

  const events: CodexBridgeEvent[] = [];
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
    const payload = obj?.payload;
    if (!payload || typeof payload !== 'object') continue;
    const base = {
      uuid: `${path}:${lineStart}`,
      timestampMs: eventTimestampMs(obj.timestamp),
      ...(sourceSessionId ? { sourceSessionId } : {}),
    };
    if (obj.type === 'response_item'
      && payload.type === 'message'
      && payload.role === 'user') {
      const userText = joinInputText(payload.content);
      if (userText) events.push({ ...base, kind: 'user', text: userText });
      continue;
    }
    if (obj.type === 'event_msg'
      && payload.type === 'task_complete'
      && typeof payload.turn_id === 'string'
      && payload.turn_id.length > 0) {
      events.push({
        ...base,
        kind: 'assistant_final',
        text: typeof payload.last_agent_message === 'string' ? payload.last_agent_message : '',
      });
      continue;
    }
    // Observed cancellation records write `turn_aborted`
    // (turn_id, reason, completed_at, duration_ms) and no
    // task_complete. Side effects may already have happened, so the safe
    // durable outcome is ambiguous rather than failed/completed.
    if (obj.type === 'event_msg'
      && payload.type === 'turn_aborted'
      && typeof payload.turn_id === 'string'
      && payload.turn_id.length > 0) {
      events.push({
        ...base,
        kind: 'assistant_final',
        text: '',
        terminalStatus: 'ambiguous',
        terminalErrorCode: abortErrorCode(payload.reason),
      });
    }
  }
  return { events, newOffset, pendingTail };
}

function normaliseInputText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Authoritative submit confirmation used by the adapter. Only a complete
 * role=user rollout record appended after `fromOffset` can match. */
export function traexRolloutHasUserInputSince(
  path: string,
  fromOffset: number,
  expectedText: string,
): boolean {
  const expected = normaliseInputText(expectedText);
  return drainTraexRollout(path, fromOffset).events.some(event =>
    event.kind === 'user' && normaliseInputText(event.text) === expected,
  );
}

// -- history.jsonl submit-confirmation (submit-time truth) ------------------
//
// TRAE writes ~/.trae/cli/history.jsonl at SUBMIT time — one JSON line
// {session_id, ts, text} per successful user submit, byte-identical to Codex's
// format. This is the correct submit-confirmation source: a type-ahead message
// parked while a turn runs is logged here immediately, whereas the per-session
// rollout only records it when the running turn dequeues it (which can exceed
// the worker's confirmation deadline → false "submission couldn't be confirmed"
// warning). Because history.jsonl is a single global file shared by every TRAE
// pane under one TRAE_HOME, a same-text line may be written by a concurrent
// sibling pane; callers pass an `acceptSid` ownership filter to skip a foreign
// pane's line. Mirrors the codex.ts writeInput verification path exactly.

export interface TraexHistoryMatch {
  found: boolean;
  cliSessionId?: string;
}

/** Optional ownership filter for a shared-history match: accept a same-text
 *  line only when its session id is one the owning pid actually holds open.
 *  Re-evaluated on every call so a lazily-opened owned rollout fd that appears
 *  AFTER its history line can still be accepted on a later poll. */
export type TraexHistorySidFilter = (cliSessionId: string | undefined) => boolean;

function readTraexHistorySid(parsed: unknown): string | undefined {
  return parsed && typeof parsed === 'object' && typeof (parsed as any).session_id === 'string'
    ? (parsed as any).session_id
    : undefined;
}

/** Scan the byte delta appended to history.jsonl since `fromByte` for a line
 *  whose decoded `text` exactly matches `expectedText` (newline-normalised).
 *  Never parses a non-newline-terminated tail, so a half-written line can't
 *  manufacture a false match — a later poll sees the completed entry. */
export function traexHistoryMatchDelta(
  path: string,
  fromByte: number,
  expectedText: string,
  acceptSid?: TraexHistorySidFilter,
): TraexHistoryMatch {
  if (!existsSync(path)) return { found: false };
  let size: number;
  try { size = statSync(path).size; } catch { return { found: false }; }
  if (size <= fromByte) return { found: false };
  const len = size - fromByte;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, len, fromByte); } finally { closeSync(fd); }
  const delta = buf.toString('utf8');
  // Drop a trailing partial line (no newline yet) — it may still be mid-write.
  const lines = delta.endsWith('\n') ? delta.split('\n') : delta.split('\n').slice(0, -1);
  const expected = normaliseInputText(expectedText);
  for (const line of lines) {
    if (line.length === 0) continue;
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (typeof parsed?.text !== 'string') continue;
    if (normaliseInputText(parsed.text) !== expected) continue;
    const cliSessionId = readTraexHistorySid(parsed);
    // Skip a same-text line owned by a DIFFERENT pane (shared-TRAE_HOME
    // collision). Keep scanning — the owned line may be later in this delta
    // or arrive on a later poll.
    if (acceptSid && !acceptSid(cliSessionId)) continue;
    return { found: true, cliSessionId };
  }
  return { found: false };
}

/** Current byte size of history.jsonl (0 when absent), captured before a paste
 *  so the confirmation scan only considers lines this submit appends. */
export function traexHistorySize(path: string): number {
  if (!path || !existsSync(path)) return 0;
  try { return statSync(path).size; } catch { return 0; }
}

function matchTraexRolloutPath(target: string): { path: string; cliSessionId: string } | undefined {
  if (!target.endsWith('.jsonl')) return undefined;
  // Accept both the default layout (~/.trae/cli/sessions/...) and any
  // TRAE_HOME override the user may have configured.
  if (!target.includes('/sessions/') && !target.includes('.trae')) {
    // Fast reject: the path has neither the sessions subdir nor the default
    // TRAE home marker. Avoid false positives against Codex rollouts which
    // share the same rollout-*.jsonl filename shape.
    if (!target.includes('/cli/sessions/')) return undefined;
  }
  const sid = codexSessionIdFromRolloutPath(target);
  if (!sid) return undefined;
  return { path: target, cliSessionId: sid };
}

/** Enumerate the file paths a pid holds open (Linux /proc, else lsof). Shared
 *  by findTraexRolloutByPid (single) and findTraexRolloutSetByPid (ownership
 *  set) so both derive from one source. Returns undefined when enumeration is
 *  unavailable — callers treat that as "cannot prove ownership". */
function traexProcessOpenTargets(pid: number): string[] | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (IS_LINUX) {
    const fdDir = `/proc/${pid}/fd`;
    if (!existsSync(fdDir)) return undefined;
    let entries: string[];
    try { entries = readdirSync(fdDir); } catch { return undefined; }
    const targets: string[] = [];
    for (const fd of entries) {
      try { targets.push(readlinkSync(join(fdDir, fd))); } catch { continue; }
    }
    return targets;
  }
  let out: string;
  try {
    out = execSync(`lsof -p ${pid} -Fn`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return undefined;
  }
  const targets: string[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('n/')) targets.push(line.slice(1));
  }
  return targets;
}

/** Find the rollout file an externally-running TRAE process has open.
 *  Same /proc/<pid>/fd strategy as findCodexRolloutByPid, but with a
 *  TRAE-specific path matcher so we never bind to a sibling Codex pane. */
export function findTraexRolloutByPid(pid: number): { path: string; cliSessionId: string } | undefined {
  const targets = traexProcessOpenTargets(pid);
  if (!targets) return undefined;
  for (const target of targets) {
    const hit = matchTraexRolloutPath(target);
    if (hit) return hit;
  }
  return undefined;
}

/** Lowercased set of TRAE session ids whose rollout the pid holds open. The
 *  ownership gate for a shared-history.jsonl submit match: only a sid this pid
 *  actually owns is safe to accept, so a concurrent sibling pane's identical
 *  text can't hand back a foreign session id. Empty Set = pid holds no TRAE
 *  rollout; undefined = fd enumeration unavailable (callers must treat undefined
 *  as "cannot prove ownership" — fail closed, do not bind). Mirrors
 *  findCodexRolloutSetByPid. */
export function findTraexRolloutSetByPid(pid: number): Set<string> | undefined {
  const targets = traexProcessOpenTargets(pid);
  if (!targets) return undefined;
  const set = new Set<string>();
  for (const target of targets) {
    const hit = matchTraexRolloutPath(target);
    if (hit) set.add(hit.cliSessionId.toLowerCase());
  }
  return set;
}

/** Pure ownership decision: is `cliSessionId` one of the rollouts the observed
 *  pid holds open? `ownedRollouts` is the lowercased sid set from
 *  findTraexRolloutSetByPid (undefined when fd enumeration was unavailable).
 *  FAIL CLOSED — a missing set or a non-member id returns false so the caller
 *  never binds the bridge (or persists a resume id) it can't prove the pid owns.
 *  Extracted so the exact predicate the worker's persist/attach gates use is
 *  unit-testable without a live pid. Mirrors codexHistorySidIsOwned. */
export function traexHistorySidIsOwned(
  cliSessionId: string,
  ownedRollouts: Set<string> | undefined,
): boolean {
  if (!ownedRollouts) return false;
  return ownedRollouts.has(cliSessionId.toLowerCase());
}


/** Locate the rollout file for a given TRAE session UUID. Filename shape is
 *  identical to Codex: `rollout-<ts>-<sid>.jsonl`, so a suffix match over the
 *  TRAE sessions tree is unambiguous. */
export function findTraexRolloutBySessionId(cliSessionId: string): string | undefined {
  const sessionsRoot = traeSessionsRoot();
  if (!cliSessionId || !existsSync(sessionsRoot)) return undefined;
  const suffix = `-${cliSessionId}.jsonl`;
  const stack: string[] = [sessionsRoot];
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
  return undefined;
}
