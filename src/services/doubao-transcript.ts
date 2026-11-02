/**
 * Reader for Doubao CLI's per-turn native logs.
 *
 * Doubao (Bubble Tea TUI) keeps a session directory per decimal snowflake id:
 *   `<dataRoot>/agent_mode/<uid>/workspace/.sessions/<sessionId>/agents/<agentId>/system/`
 * Unlike codex/coco it splits the two sides of a turn across TWO files:
 *   - `assignment.md` — append-only log of what the USER submitted. Each turn is
 *     a section headed `## [<RFC3339 ts>] 需求`, body = the verbatim prompt
 *     (botmux's full envelope included), newest at the end.
 *   - `trajectory.jsonl` — assistant/tool records:
 *       {"role":"assistant","content":"…","tool_calls":[…]}  mid-turn
 *       {"role":"tool","content":"…","tool_call_id":"…"}
 *       {"role":"assistant","content":"…"}                    terminal answer
 *     There is no finish_reason / timestamp: a terminal assistant record is one
 *     with non-empty `content` and NO `tool_calls`. A record with tool_calls is
 *     mid-turn narration and must never close the pending turn early.
 *
 * The bridge fallback only needs the original user prompt and the final
 * assistant message, so this reader emits the same two event kinds as the CoCo
 * reader ('user' | 'assistant_final'). The worker's generic structured-bridge
 * driver does the rest (fingerprint attribution, type-ahead queue, emit).
 *
 * The worker owns one numeric offset + one driver-state slot, so the two files
 * share a single monotonic cursor: trajectory.jsonl byte size at the time of the
 * last drain (trajectory is always >= assignment in write activity). Per-file
 * byte frontiers live in the drainer state.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJsonlWindow } from './jsonl-cursor.js';
import { logger } from '../utils/logger.js';
import type { CodexBridgeEvent } from './codex-transcript.js';
import { doubaoSessionRoots } from '../adapters/cli/doubao.js';

const SESSION_ID_RE = /^\d{10,24}$/;
const ASSIGNMENT_FILE = 'assignment.md';
const TRAJECTORY_FILE = 'trajectory.jsonl';

/** A turn heading: `## [2026-11-02T05:40:07.661657173Z] 需求`. */
const SECTION_HEADING_RE = /^## \[([^\]]+)\]\s*需求\s*$/;

export interface DoubaoBridgeDrainState {
  /** Byte frontier in assignment.md (start of the next unparsed byte). */
  assignmentOffset: number;
  /** Byte frontier in trajectory.jsonl. */
  trajectoryOffset: number;
}

export interface DoubaoDrainResult {
  events: CodexBridgeEvent[];
  newOffset: number;
  pendingTail: string;
  state: DoubaoBridgeDrainState;
}

/** `<sessions>/<sessionId>` → the system dir of the session's MAIN agent.
 *  Doubao normally runs a single main agent; subagents live under their own
 *  session ids. We still pick Role: main explicitly and fall back to the most
 *  recently modified agent directory. */
export function doubaoSystemDirForSession(
  sessionId: string,
  roots: readonly string[] = doubaoSessionRoots(),
): string | undefined {
  if (!SESSION_ID_RE.test(sessionId)) return undefined;
  const candidates: string[] = [];
  for (const root of roots) {
    const agentsDir = join(root, sessionId, 'agents');
    let agents: string[];
    try { agents = readdirSync(agentsDir); } catch { continue; }
    for (const agent of agents) {
      const systemDir = join(agentsDir, agent, 'system');
      try {
        if (!statSync(systemDir).isDirectory()) continue;
        if (!existsSync(join(systemDir, TRAJECTORY_FILE))) continue;
      } catch { continue; }
      candidates.push(systemDir);
    }
  }
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  for (const dir of candidates) {
    try {
      const assignment = readFileSync(join(dir, ASSIGNMENT_FILE), 'utf8');
      if (/^- Role:\s*main\s*$/m.test(assignment)) return dir;
    } catch { /* keep scanning */ }
  }
  return candidates.sort((a, b) => {
    const ma = safeMtimeMs(join(b, TRAJECTORY_FILE)) - safeMtimeMs(join(a, TRAJECTORY_FILE));
    return ma;
  })[0];
}

function safeMtimeMs(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

/** Trajectory path used by `bridgeSpec.locate.bySessionId`. */
export function doubaoTrajectoryPathForSession(sessionId: string): string | undefined {
  const systemDir = doubaoSystemDirForSession(sessionId);
  return systemDir ? join(systemDir, TRAJECTORY_FILE) : undefined;
}

function parseHeadingTimestamp(raw: string): number {
  // Keep millisecond precision: take the first three fractional digits so
  // `Date.parse` accepts it (it rejects 9-digit nanosecond fractions).
  const normalized = raw.replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : Date.now();
}

/** Split a complete (newline-terminated) assignment.md slice into turn bodies.
 *  A body is emitted only once the following heading is seen (or EOF at a line
 *  boundary), so a half-appended prompt is never parsed. */
function parseAssignmentSections(
  path: string,
  completeText: string,
  startOffset: number,
): CodexBridgeEvent[] {
  const events: CodexBridgeEvent[] = [];
  let sectionStart = -1;       // byte offset of the current heading line
  let headingTs: string | undefined;
  let bodyLines: string[] = [];

  const flush = (): void => {
    if (sectionStart < 0 || bodyLines.length === 0) return;
    const text = bodyLines.join('').replace(/\n+$/, '');
    if (text.trim()) {
      events.push({
        uuid: `${path}:${sectionStart}`,
        timestampMs: parseHeadingTimestamp(headingTs!),
        kind: 'user',
        text,
      });
    }
  };

  let byteCursor = startOffset;
  for (const rawLine of completeText.split('\n')) {
    // split('\n') drops the terminating '\n'; reconstruct the line WITH it for
    // byte-accurate offsets.
    const line = `${rawLine}\n`;
    const lineStart = byteCursor;
    byteCursor += Buffer.byteLength(line, 'utf8');
    const m = SECTION_HEADING_RE.exec(rawLine);
    if (m) {
      flush();
      sectionStart = lineStart;
      headingTs = m[1];
      bodyLines = [];
      continue;
    }
    if (sectionStart >= 0) bodyLines.push(line);
  }
  // The slice ends exactly at a line boundary (completeText ends with '\n').
  // The last section is complete if its body was terminated by that newline —
  // doubao writes the whole prompt + trailing newline in one append before the
  // turn starts, so emitting it here is safe; a genuinely half-written last
  // line would lack its '\n' and never reach this parser.
  flush();
  return events;
}

function parseTrajectoryLine(path: string, line: string, lineStart: number): CodexBridgeEvent | null {
  let obj: any;
  try { obj = JSON.parse(line); } catch { return null; }
  if (obj?.role !== 'assistant') return null;
  const content = typeof obj.content === 'string' ? obj.content : '';
  // Mid-turn narration: the model narrates a tool call on the same record.
  // CoCo keys this off finish_reason:'tool_calls'; doubao lacks finish_reason,
  // but the presence of a non-empty tool_calls array is the same edge.
  if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) return null;
  if (!content.trim()) return null;
  return { uuid: `${path}:${lineStart}`, timestampMs: Date.now(), kind: 'assistant_final', text: content };
}

/** Incrementally drain BOTH native logs for a bound session.
 *  `path` is the trajectory.jsonl path (what locate resolves); assignment.md
 *  is its sibling. */
export function drainDoubaoTranscript(
  path: string,
  fromOffset: number,
  ctx: { state?: unknown } = {},
): DoubaoDrainResult {
  const systemDir = dirname(path);
  const assignmentPath = join(systemDir, ASSIGNMENT_FILE);
  const prevState = (ctx.state as DoubaoBridgeDrainState | undefined)
    ?? { assignmentOffset: 0, trajectoryOffset: 0 };

  // ── assignment.md: user turns ────────────────────────────────────────────
  const events: CodexBridgeEvent[] = [];
  let assignmentOffset = prevState.assignmentOffset ?? 0;
  try {
    if (existsSync(assignmentPath)) {
      const size = statSync(assignmentPath).size;
      if (size < assignmentOffset) assignmentOffset = 0;
      if (size > assignmentOffset) {
        const window = readJsonlWindow(assignmentPath, assignmentOffset, size);
        // assignment.md is markdown, but readJsonlWindow's byte-window / last
        // newline contract is exactly what a line-based reader needs.
        events.push(...parseAssignmentSections(assignmentPath, window.completeText, assignmentOffset));
        assignmentOffset = window.newOffset;
      }
    }
  } catch (err) {
    logger.warn(`[doubao-transcript] assignment drain failed for ${assignmentPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── trajectory.jsonl: final assistant answers ────────────────────────────
  let trajectoryOffset = prevState.trajectoryOffset ?? 0;
  let pendingTail = '';
  try {
    if (existsSync(path)) {
      const size = statSync(path).size;
      if (size < trajectoryOffset) trajectoryOffset = 0;
      if (size > trajectoryOffset) {
        const window = readJsonlWindow(path, trajectoryOffset, size);
        let lineStart = trajectoryOffset;
        for (const rawLine of window.completeText.split('\n')) {
          const line = `${rawLine}\n`;
          const start = lineStart;
          lineStart += Buffer.byteLength(line, 'utf8');
          if (rawLine.length === 0) continue;
          const event = parseTrajectoryLine(path, rawLine, start);
          if (event) events.push(event);
        }
        trajectoryOffset = window.newOffset;
        pendingTail = window.pendingTail;
      }
    }
  } catch (err) {
    logger.warn(`[doubao-transcript] trajectory drain failed for ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Emit user events before assistant events even when both landed in the same
  // drain window (the parser already orders them that way: assignment first).
  return {
    events,
    // The shared cursor must advance whenever EITHER file grows. Trajectory
    // activity dominates, but a user-only append (turn just submitted) must not
    // be re-drained on the next tick either; take the max of the two frontiers.
    newOffset: Math.max(trajectoryOffset, fromOffset),
    pendingTail,
    state: { assignmentOffset, trajectoryOffset },
  };
}
