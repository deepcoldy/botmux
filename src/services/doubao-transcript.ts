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
 * User prompts and final answers feed reply attribution. Public tool calls and
 * results also emit cosmetic 'cot' events for the execution timeline; they
 * never start or complete a turn. Private reasoning fields are not forwarded.
 *
 * The worker owns one numeric offset + one driver-state slot, so the two files
 * share a single monotonic cursor: trajectory.jsonl byte size at the time of the
 * last drain (trajectory is always >= assignment in write activity). Per-file
 * byte frontiers live in the drainer state.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readJsonlWindow } from './jsonl-cursor.js';
import { logger } from '../utils/logger.js';
import type { CodexBridgeEvent, CodexCotEntry } from './codex-transcript.js';
import { doubaoSessionRoots } from '../adapters/cli/doubao.js';
import { boundSubjectForTransport, subjectFromArgsString } from './cot-subject.js';

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
  /** A resume baseline retained an unfinished historical row. Its completion
   *  belongs to history too, even if it lands alongside the next live prompt. */
  skipTrajectoryTail?: true;
}

/** Drain context understood by the doubao driver (beyond the shared fields). */
export interface DoubaoBridgeDrainContext {
  state?: unknown;
  /** Started, unterminated turns in the attribution queue, measured by the
   *  worker at drain time. See StructuredBridgeDrainContext.openTurns. */
  openTurns?: number;
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

/** The native artifact workspace for this exact bound session, never a
 * guessed account root or a workspace belonging only to another session. */
export function doubaoWorkspaceForSession(sessionId: string | undefined,
  sessionRoots: readonly string[] = doubaoSessionRoots()): string | undefined {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return;
  const roots = sessionRoots.filter(root => {
    try { return statSync(join(root, sessionId)).isDirectory(); } catch { return false; }
  });
  return roots.length === 1 ? dirname(roots[0]!) : undefined;
}

function parseHeadingTimestamp(raw: string): number {
  // Keep millisecond precision: take the first three fractional digits so
  // `Date.parse` accepts it (it rejects 9-digit nanosecond fractions).
  const normalized = raw.replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : Date.now();
}

/** One parsed assignment.md turn section with its byte range. `event` is null
 *  for a whitespace-only body (no real prompt); `incomplete` marks a heading
 *  whose body has not been appended yet — the torn-write shape. */
interface ParsedAssignmentSection {
  start: number;
  end: number;
  event: CodexBridgeEvent | null;
  incomplete: boolean;
}

/** Split a complete (newline-terminated) assignment.md slice into turn bodies.
 *  Returns every section with the byte range it occupies. A body is only
 *  COMPLETE once the following heading is seen, a non-empty body line is
 *  present, or — for the last section — its prompt bytes exist; a bare heading
 *  at the window end is reported `incomplete` so the caller holds the offset at
 *  its start and re-parses the whole section once the body lands. */
function parseAssignmentSections(
  path: string,
  completeText: string,
  startOffset: number,
): ParsedAssignmentSection[] {
  const sections: ParsedAssignmentSection[] = [];
  let current: { start: number; headingTs: string; bodyLines: string[] } | undefined;

  const flush = (end: number): void => {
    if (!current) return;
    const text = current.bodyLines.join('').replace(/\n+$/, '');
    sections.push({
      start: current.start,
      end,
      event: text.trim()
        ? {
          uuid: `${path}:${current.start}`,
          timestampMs: parseHeadingTimestamp(current.headingTs),
          kind: 'user',
          text,
        }
        : null,
      incomplete: false,
    });
    current = undefined;
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
      flush(lineStart);
      current = { start: lineStart, headingTs: m[1]!, bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  if (current) {
    // doubao appends prompt body after the heading. A heading whose only
    // following bytes are blank lines at EOF is the torn half of a split
    // write: hold at the heading start and re-parse after the body lands.
    const bodyText = current.bodyLines.join('');
    if (bodyText.trim() === '') {
      sections.push({ start: current.start, end: byteCursor, event: null, incomplete: true });
    } else {
      flush(byteCursor);
    }
  }
  return sections;
}

/** Corroborate a live process marker against an exact previously attributed
 * native record. Markdown headings and user-authored envelope tags alone are
 * never proof of ownership. Legacy journals without proof fail closed. */
export function doubaoLiveUser(path: string,
  proof?: { uuid: string; hash: string; timestampMs: number }): (CodexBridgeEvent & { assignmentOffset: number }) | undefined {
  if (!proof || typeof proof.uuid !== 'string' || !/^[a-f0-9]{64}$/.test(proof.hash) || !Number.isFinite(proof.timestampMs)) return;
  const assignment = join(dirname(path), ASSIGNMENT_FILE);
  try {
    const size = statSync(assignment).size;
    if (size > 4 * 1024 * 1024) return;
    const window = readJsonlWindow(assignment, 0, size);
    if (window.pendingTail) return;
    const sections = parseAssignmentSections(assignment, window.completeText, 0);
    const latest = sections.at(-1);
    // An exact previously attributed native record also covers opening/solo
    // prompts, which intentionally have no message_location envelope.
    return latest?.event && !latest.incomplete
      && latest.event.uuid === proof.uuid
      && latest.event.timestampMs === proof.timestampMs
      && createHash('sha256').update(latest.event.text).digest('hex') === proof.hash
      ? { ...latest.event, assignmentOffset: window.newOffset } : undefined;
  } catch { return; }
}

interface ParsedTrajectoryEvent {
  event: CodexBridgeEvent;
  start: number;
}

function parseTrajectoryWindow(path: string, completeText: string, startOffset: number): ParsedTrajectoryEvent[] {
  const out: ParsedTrajectoryEvent[] = [];
  let lineStart = startOffset;
  for (const rawLine of completeText.split('\n')) {
    const line = `${rawLine}\n`;
    const start = lineStart;
    lineStart += Buffer.byteLength(line, 'utf8');
    if (rawLine.length === 0) continue;
    const event = parseTrajectoryLine(path, rawLine, start);
    if (event) out.push({ event, start });
  }
  return out;
}

function parseTrajectoryLine(path: string, line: string, lineStart: number): CodexBridgeEvent | null {
  let obj: any;
  try { obj = JSON.parse(line); } catch { return null; }
  const base = { uuid: `${path}:${lineStart}`, timestampMs: Date.now(), text: '' };
  if (obj?.role === 'tool') {
    if (typeof obj.tool_call_id !== 'string' || !obj.tool_call_id) return null;
    const result = typeof obj.content === 'string' ? obj.content : '';
    return { ...base, kind: 'cot', progressCursor: { jsonlPath: path, offset: lineStart }, cotEntries: [{
      kind: 'tool_result', id: obj.tool_call_id,
      result: result.length > 800 ? `${result.slice(0, 800)}…` : result,
    }] };
  }
  if (obj?.role !== 'assistant') return null;
  const content = typeof obj.content === 'string' ? obj.content : '';
  // Mid-turn narration: the model narrates a tool call on the same record.
  // CoCo keys this off finish_reason:'tool_calls'; doubao lacks finish_reason,
  // but the presence of a non-empty tool_calls array is the same edge.
  if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
    const cotEntries: CodexCotEntry[] = [];
    for (const call of obj.tool_calls) {
      if (typeof call?.id !== 'string' || !call.id
        || typeof call.function?.name !== 'string' || !call.function.name) continue;
      const input = call.function.arguments;
      const args = typeof input === 'string' ? input
        : input && typeof input === 'object' ? JSON.stringify(input) : '';
      const subject = boundSubjectForTransport(subjectFromArgsString(args));
      cotEntries.push({
        kind: 'tool_call', id: call.id, name: call.function.name,
        args: args.length > 600 ? `${args.slice(0, 600)}…` : args,
        ...(subject ? { subject } : {}),
      });
    }
    return cotEntries.length ? { ...base, kind: 'cot', progressCursor: { jsonlPath: path, offset: lineStart }, cotEntries } : null;
  }
  if (!content.trim()) return null;
  return { ...base, kind: 'assistant_final', text: content };
}

/** Incrementally drain BOTH native logs for a bound session.
 *  `path` is the trajectory.jsonl path (what locate resolves); assignment.md
 *  is its sibling.
 *
 *  Cross-file ordering: assignment.md appends the user section at SUBMIT time,
 *  trajectory.jsonl appends the terminal answer at COMPLETION time, and the
 *  shared 1s poll can observe both in one window — including the previous
 *  turn's final landing together with the next turn's prompt. The queue pairs
 *  an assistant_final onto whatever turn is collecting, so emitting the new
 *  user section before that final would start the new turn first, misattribute
 *  the old answer to it (and HOL-drop the old turn).
 *
 *  The boundary can NOT be inferred from the two files' increments: a turn
 *  can be retired WITHOUT any trajectory record (Esc interrupt — doubao writes
 *  nothing after `Stopped`), and on resume the reader attaches over
 *  assignment.md history whose turns the queue no longer holds. A counter
 *  derived from file bytes would over-count in both shapes forever. The worker
 *  therefore passes `ctx.openTurns`: the number of turns the attribution queue
 *  currently holds as STARTED with no terminal — the only component that knows
 *  the real turn lifecycle. With K = openTurns:
 *    1. the first K finals in the window close those previously-started turns
 *       and are emitted FIRST (before any prompt section that could steal them);
 *    2. remaining prompt→final pairs fully inside the window alternate
 *       user→final, so a sub-second turn pairs with zero extra ticks — simply
 *       reversing to finals-first would strand these;
 *    3. trailing prompt sections with no final in the window are emitted after
 *       the closing finals (they then start the next turns); any final beyond
 *       K + the paired prompts has no owner and is not emitted.
 *  When openTurns is omitted (standalone use) K = 0: every final must pair
 *  with a prompt in the same or a later window. */
export function drainDoubaoTranscript(
  path: string,
  fromOffset: number,
  ctx: DoubaoBridgeDrainContext = {},
): DoubaoDrainResult {
  const systemDir = dirname(path);
  const assignmentPath = join(systemDir, ASSIGNMENT_FILE);
  const prevState = (ctx.state as DoubaoBridgeDrainState | undefined)
    ?? { assignmentOffset: 0, trajectoryOffset: 0 };
  const openTurns = Math.max(0, Math.trunc(ctx.openTurns ?? 0));

  // ── assignment.md: user turns ────────────────────────────────────────────
  let assignmentOffset = prevState.assignmentOffset ?? 0;
  let parsedSections: ParsedAssignmentSection[] = [];
  let assignmentWindowEnd = assignmentOffset;
  try {
    if (existsSync(assignmentPath)) {
      const size = statSync(assignmentPath).size;
      if (size < assignmentOffset) assignmentOffset = 0;
      if (size > assignmentOffset) {
        const window = readJsonlWindow(assignmentPath, assignmentOffset, size);
        parsedSections = parseAssignmentSections(assignmentPath, window.completeText, assignmentOffset);
        assignmentWindowEnd = window.newOffset;
      }
    }
  } catch (err) {
    logger.warn(`[doubao-transcript] assignment drain failed for ${assignmentPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // A trailing heading with no body is a torn split write: park the frontier
  // at its heading start so the whole section re-parses after the body lands.
  const trailingIncomplete = parsedSections.length > 0 && parsedSections[parsedSections.length - 1]!.incomplete
    ? parsedSections[parsedSections.length - 1]!
    : null;
  const completeSections = trailingIncomplete ? parsedSections.slice(0, -1) : parsedSections;
  const userSections = completeSections.filter(s => s.event !== null);

  // ── trajectory.jsonl: ordered execution progress and final answers ───────
  let trajectoryOffset = prevState.trajectoryOffset ?? 0;
  let skipTrajectoryTail = prevState.skipTrajectoryTail === true;
  let pendingTail = '';
  let trajectoryEvents: ParsedTrajectoryEvent[] = [];
  try {
    if (existsSync(path)) {
      const size = statSync(path).size;
      if (size < trajectoryOffset) {
        trajectoryOffset = 0;
        skipTrajectoryTail = false;
      }
      if (size > trajectoryOffset) {
        const window = readJsonlWindow(path, trajectoryOffset, size);
        let start = trajectoryOffset;
        let text = window.completeText;
        if (skipTrajectoryTail && text) {
          const end = text.indexOf('\n') + 1;
          start += Buffer.byteLength(text.slice(0, end), 'utf8');
          text = text.slice(end);
          skipTrajectoryTail = false;
        }
        trajectoryEvents = parseTrajectoryWindow(path, text, start);
        trajectoryOffset = window.newOffset;
        pendingTail = window.pendingTail;
      }
    }
  } catch (err) {
    logger.warn(`[doubao-transcript] trajectory drain failed for ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── pair the two streams against queue-owned open turns ──────────────────
  const events: CodexBridgeEvent[] = [];
  let remainingOpen = openTurns;
  let nextUser = 0;
  let hasOwner = remainingOpen > 0;
  for (const { event, start } of trajectoryEvents) {
    if (!hasOwner && nextUser < userSections.length) {
      events.push(userSections[nextUser++]!.event!);
      hasOwner = true;
    }
    if (!hasOwner) {
      if (trailingIncomplete) {
        // The input heading already exists but its body has not flushed yet.
        // Re-read this segment once the fingerprint can establish its owner.
        trajectoryOffset = start;
        break;
      }
      continue; // Ownerless history/cosmetic rows cannot claim a later turn.
    }
    events.push(event);
    if (event.kind === 'assistant_final') {
      if (remainingOpen > 0) remainingOpen--;
      hasOwner = remainingOpen > 0;
    }
  }
  // A pending prompt may precede its first trajectory row by several polls.
  for (; nextUser < userSections.length; nextUser++) events.push(userSections[nextUser]!.event!);

  // Park assignment bytes at a torn trailing heading, if any; every complete
  // section above has been emitted and its bytes may be committed.
  if (trailingIncomplete) assignmentOffset = trailingIncomplete.start;
  else assignmentOffset = assignmentWindowEnd;

  return {
    events,
    // The shared cursor must advance whenever EITHER file grows. Trajectory
    // activity dominates, but a user-only append (turn just submitted) must not
    // be re-drained on the next tick either; take the max of the two frontiers.
    newOffset: Math.max(trajectoryOffset, fromOffset),
    pendingTail,
    state: { assignmentOffset, trajectoryOffset, ...(skipTrajectoryTail ? { skipTrajectoryTail: true } : {}) },
  };
}
