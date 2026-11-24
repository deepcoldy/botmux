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
import { doubaoSessionRoots, doubaoContentWithCaptureId } from '../adapters/cli/doubao.js';
import { boundSubjectForTransport, subjectFromArgsString } from './cot-subject.js';
import { wholeInputHash, type CodexPendingTurn } from './codex-bridge-queue.js';

const SESSION_ID_RE = /^\d{10,24}$/;
const ASSIGNMENT_FILE = 'assignment.md';
const TRAJECTORY_FILE = 'trajectory.jsonl';

/** A turn heading: `## [2026-11-02T05:40:07.661657173Z] 需求`. */
const SECTION_HEADING_RE = /^## \[([^\]]+)\]\s*需求\s*$/;

export interface DoubaoBridgeDrainState {
  /** Durable export mode: raw terminal rows may belong to a retired turn. */
  exportOnly?: true;
  /** Byte frontier in assignment.md (start of the next unparsed byte). */
  assignmentOffset: number;
  /** Byte frontier in trajectory.jsonl. */
  trajectoryOffset: number;
  /** A resume baseline retained an unfinished historical row. Its completion
   *  belongs to history too, even if it lands alongside the next live prompt. */
  skipTrajectoryTail?: true;
  /** A request row of an input the attribution queue is waiting for, whose
   *  assignment section was not parsed yet: the trajectory frontier waits at
   *  it (bounded in time) instead of passing its answer as ownerless. Owner
   *  identity is optional only for state captured before it was recorded. */
  parkedUserRow?: { offset: number; sinceMs: number; turnId?: string; dispatchAttempt?: number };
  /** This session's trajectory opens requests with a row carrying the request
   *  text (seen at least once). Only then is a section that arrives without
   *  its row held back briefly for that row. */
  userRowsMatch?: true;
  /** A complete section held back (with the trajectory frontier) waiting for
   *  its request row, bounded in time. */
  sectionRowWait?: { assignmentOffset: number; sinceMs: number };
  /** Digests of request texts already started in this attach (bounded). A
   *  later row repeating one of them is not a new request to wait for. */
  startedRequests?: string[];
}

/** Drain context understood by the doubao driver (beyond the shared fields). */
export interface DoubaoBridgeDrainContext {
  state?: unknown;
  /** Started, unterminated turns in the attribution queue, measured by the
   *  worker at drain time. See StructuredBridgeDrainContext.openTurns. */
  openTurns?: number;
  /** See StructuredBridgeDrainContext.ownsNativeInput. */
  ownsNativeInput?: (text: string) => boolean;
  /** See StructuredBridgeDrainContext.ownsNativeInputByFingerprint. */
  ownsNativeInputByFingerprint?: (text: string) => boolean;
  /** See StructuredBridgeDrainContext.nativeInputOwner. */
  nativeInputOwner?: (text: string, requireCompleteInput: boolean) =>
    { turnId: string; dispatchAttempt?: number } | undefined;
  /** Clock for the bounded wait at a parked request row. */
  nowMs?: number;
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

/** assignment.md of a bound session's main agent — the per-turn log Doubao
 *  appends a user request to once it actually sends it. Same agent choice as
 *  doubaoSystemDirForSession, keyed on assignment.md so a receipt baseline can
 *  be taken before the agent has written any trajectory row. */
export function doubaoAssignmentPathForSession(
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
      const assignment = join(agentsDir, agent, 'system', ASSIGNMENT_FILE);
      if (existsSync(assignment)) candidates.push(assignment);
    }
  }
  if (candidates.length <= 1) return candidates[0];
  for (const assignment of candidates) {
    try {
      if (/^- Role:\s*main\s*$/m.test(readFileSync(assignment, 'utf8'))) return assignment;
    } catch { /* keep scanning */ }
  }
  return candidates.sort((a, b) => safeMtimeMs(b) - safeMtimeMs(a))[0];
}

/** Byte size of a native log, 0 when it does not exist yet (Doubao creates it
 *  lazily), undefined when it cannot be read and is no baseline. */
export function doubaoLogSize(path: string): number | undefined {
  try { return statSync(path).size; } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 0 : undefined;
  }
}

/** Whether a request section appended to assignment.md at or after
 *  `fromOffset` carries exactly `content` (whitespace-insensitive). This is the
 *  submit receipt: Doubao writes the section when the request leaves its own
 *  send queue, so an Enter it parked behind running work has no receipt yet.
 *  Only bytes past the pre-write size count — an older identical request in
 *  history is never mistaken for this one. */
export function doubaoAssignmentHasInputSince(path: string, fromOffset: number, content: string): boolean {
  const wanted = content.replace(/\s+/g, ' ').trim();
  if (!wanted) return false;
  try {
    const size = statSync(path).size;
    // A rewritten (shorter) log has no stable frontier. Historical sections
    // cannot prove this submit: fail closed instead of replaying old content.
    if (size < fromOffset) return false;
    const start = fromOffset;
    if (size <= start) return false;
    const window = readJsonlWindow(path, start, size);
    return parseAssignmentSections(path, window.completeText + window.pendingTail, start)
      .some(section => !section.incomplete
        && section.event?.text.replace(/\s+/g, ' ').trim() === wanted);
  } catch { return false; }
}

/** Account-level artifact workspace selected by an exact, unique bound
 * native session ID. This includes artifacts from other sessions in the same
 * account; it is not a per-session filesystem boundary. */
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

export interface DoubaoExportFrontier {
  sessionId: string;
  assignmentHash: string;
  queries: string[];
  index: number;
}

/** Export has no message ids. Only a complete, unchanged assignment history
 * plus the exact attributed section can prove an occurrence (including repeats).
 * Never use prefix matching or select the last non-empty exported response. */
export function doubaoExportFrontier(path: string, turn: CodexPendingTurn): DoubaoExportFrontier | undefined {
  const proof = turn.nativeUserProof;
  const sessionId = /[/\\]\.sessions[/\\](\d{10,24})[/\\]agents[/\\]/.exec(path)?.[1];
  if (!sessionId || !proof || !turn.wholeInputHash) return;
  const assignment = join(dirname(path), ASSIGNMENT_FILE);
  try {
    if (statSync(assignment).size > 4 * 1024 * 1024) return;
    const bytes = readFileSync(assignment);
    if (bytes.length > 4 * 1024 * 1024 || bytes.at(-1) !== 10) return;
    // Parse the bytes whose digest we revalidate, not a second file read.
    const sections = parseAssignmentSections(assignment, bytes.toString('utf8'), 0);
    if (sections.length === 0 || sections.some(section => section.incomplete || !section.event)) return;
    const index = sections.findIndex(section => section.event!.uuid === proof.uuid);
    const user = sections[index]?.event;
    // The first write appends the adapter's capture block AFTER the queue mark.
    // Keep raw native proof/query equality; tolerate only an exact round-trip
    // through that same adapter, never arbitrary suffixes or prefix matching.
    const capture = user && /\n\n<botmux_routing>\nbotmux_input_id: ([a-f0-9]{32})\n<\/botmux_routing>$/.exec(user.text);
    const markedInput = capture ? user!.text.slice(0, capture.index) : undefined;
    const matchesMark = user && (wholeInputHash(user.text) === turn.wholeInputHash
      || capture && markedInput !== undefined
      && doubaoContentWithCaptureId(markedInput, capture[1]!) === user.text
      && wholeInputHash(markedInput) === turn.wholeInputHash);
    if (!user || user.timestampMs !== proof.timestampMs
      || createHash('sha256').update(user.text).digest('hex') !== proof.hash
      || !matchesMark) return;
    return {
      sessionId, index, queries: sections.map(section => section.event!.text),
      assignmentHash: createHash('sha256').update(bytes).digest('hex')
    };
  } catch { return; }
}

export function doubaoExportAnswer(frontier: DoubaoExportFrontier, exported: unknown): string | undefined {
  if (!Array.isArray(exported) || exported.length !== frontier.queries.length) return;
  for (let i = 0; i < exported.length; i++) {
    const row = exported[i];
    if (!row || typeof row.query !== 'string' || typeof row.response !== 'string'
      || wholeInputHash(row.query) !== wholeInputHash(frontier.queries[i]!)) return;
  }
  const response = exported[frontier.index]?.response;
  return typeof response === 'string' && response.trim() ? response : undefined;
}

/** One parsed trajectory row: a bridge event, or the whitespace-normalised
 *  text of a `role:user` row (a request boundary, never emitted itself). */
interface ParsedTrajectoryEvent {
  event?: CodexBridgeEvent;
  userRow?: string;
  start: number;
}

/** How long a request row of an input botmux is waiting for may hold the
 *  trajectory frontier until its assignment section is parsed. */
const PARKED_USER_ROW_MAX_MS = 120_000;
/** How long a section that arrived without its request row is held back,
 *  in a session whose requests do get such rows, before pairing by K. */
const SECTION_ROW_WAIT_MS = 3_000;
const STARTED_REQUESTS_KEPT = 32;
const requestDigest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32);

const normaliseRequestText = (text: string): string => text.replace(/\s+/g, ' ').trim();

function userRowText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
    ? (part as { text: string }).text : '')).join('\n');
}

/** Whether a `role:user` row opens the request whose section text is `request`.
 *  The row may wrap the request in extra context, never the other way round. */
function userRowOpens(row: string, request: string): boolean {
  return !!request && (row === request || row.includes(request));
}

function parseTrajectoryWindow(path: string, completeText: string, startOffset: number): ParsedTrajectoryEvent[] {
  const out: ParsedTrajectoryEvent[] = [];
  let lineStart = startOffset;
  for (const rawLine of completeText.split('\n')) {
    const line = `${rawLine}\n`;
    const start = lineStart;
    lineStart += Buffer.byteLength(line, 'utf8');
    if (rawLine.length === 0) continue;
    const parsed = parseTrajectoryLine(path, rawLine, start);
    if (parsed && 'userRow' in parsed) out.push({ userRow: parsed.userRow, start });
    else if (parsed) out.push({ event: parsed, start });
  }
  return out;
}

function parseTrajectoryLine(path: string, line: string, lineStart: number): CodexBridgeEvent | { userRow: string } | null {
  let obj: any;
  try { obj = JSON.parse(line); } catch { return null; }
  if (obj?.role === 'user') {
    const text = normaliseRequestText(userRowText(obj.content));
    return text ? { userRow: text } : null;
  }
  const base = { uuid: `${path}:${lineStart}`, timestampMs: Date.now(), text: '' };
  if (obj?.role === 'tool') {
    if (typeof obj.tool_call_id !== 'string' || !obj.tool_call_id || typeof obj.content !== 'string') return null;
    const result = obj.content;
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
 *  with a prompt in the same or a later window.
 *
 *  Request rows. When trajectory.jsonl opens a request with a `role:user` row
 *  carrying that request's text, the ordering question above has a direct
 *  answer inside the window that holds both: rows before the request's row
 *  belong to earlier work, rows after it to the request. That matters when no
 *  turn is open, e.g. a request Doubao held in its own send queue and sent
 *  right after other work ended with a content-only row — pairing "first
 *  ownerless row ↔ first pending section" would hand that row to the request.
 *  So a pending section whose own row is further on in the window starts at
 *  that row, and the ownerless rows before it stay unattributed; a section
 *  with no matching row in the window keeps the K-based pairing. A row only
 *  counts when its text contains the section's (a mid-turn user row of other
 *  text is never a boundary). The other order — the row of an input the queue
 *  is waiting for (`ctx.ownsNativeInput`) before its section — holds the
 *  trajectory frontier at that row, bounded in time, instead of letting the
 *  request's own answer pass as ownerless. */
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
        trajectoryEvents = parseTrajectoryWindow(path, text, start)
          .filter(row => !prevState.exportOnly || row.event?.kind !== 'assistant_final');
        trajectoryOffset = window.newOffset;
        pendingTail = window.pendingTail;
      }
    }
  } catch (err) {
    logger.warn(`[doubao-transcript] trajectory drain failed for ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── pair the two streams against queue-owned open turns ──────────────────
  const events: CodexBridgeEvent[] = [];
  const nowMs = ctx.nowMs ?? Date.now();
  const sectionText = (section: ParsedAssignmentSection) => normaliseRequestText(section.event!.text);
  const startedRequests = [...(prevState.startedRequests ?? [])];
  const noteStarted = (section: ParsedAssignmentSection) => {
    startedRequests.push(requestDigest(sectionText(section)));
    if (startedRequests.length > STARTED_REQUESTS_KEPT) startedRequests.shift();
  };

  // Assign every row to at most one section text. Exact matches win; otherwise
  // the longest containing request wins, so `继续执行测试` cannot be stolen by
  // the earlier `继续`. Rows and sections of the same text pair in occurrence
  // order. An already-started text gets one ambiguous-row hold: its first 1:1
  // row may be an old retry, while a row that was explicitly parked as the
  // queue's next input is positive evidence of a new occurrence.
  let orderedSections = [...userSections];
  let mappedRows: Array<number | undefined> = Array(orderedSections.length).fill(undefined);
  const ambiguousOldRowAt = new Map<number, number>();
  {
    const texts = orderedSections.map(sectionText);
    const rowsByText = new Map<string, number[]>();
    for (let j = 0; j < trajectoryEvents.length; j++) {
      const row = trajectoryEvents[j]!.userRow;
      if (row === undefined) continue;
      let text: string | undefined;
      for (const candidate of texts) {
        if (!userRowOpens(row, candidate)) continue;
        if (row === candidate) { text = candidate; break; }
        if (text === undefined || candidate.length > text.length) text = candidate;
      }
      if (text === undefined) continue;
      rowsByText.set(text, [...(rowsByText.get(text) ?? []), j]);
    }
    const nextOfText = new Map<string, number>();
    for (const [text, rows] of rowsByText) {
      const sectionCount = texts.filter(candidate => candidate === text).length;
      const firstSection = orderedSections.find(section => sectionText(section) === text)!;
      const hasParkedRow = rows.some(index => trajectoryEvents[index]!.start === prevState.parkedUserRow?.offset);
      const ambiguousOldRow = prevState.userRowsMatch === true
        && startedRequests.includes(requestDigest(text))
        && rows.length === 1 && sectionCount === 1 && !hasParkedRow;
      if (ambiguousOldRow) ambiguousOldRowAt.set(firstSection.start, rows[0]!);
      nextOfText.set(text, Math.max(ambiguousOldRow ? 1 : 0, rows.length - sectionCount));
    }
    for (let i = 0; i < orderedSections.length; i++) {
      const rows = rowsByText.get(texts[i]!);
      const k = nextOfText.get(texts[i]!) ?? 0;
      const at = rows?.[k];
      if (at === undefined) break;
      mappedRows[i] = at;
      nextOfText.set(texts[i]!, k + 1);
    }
  }

  // A parked row is the queue's next native request even if a later receipt
  // made its assignment section visible first. Once every section has a row,
  // restore native occurrence order before emitting to the FIFO attribution
  // queue. Partial mappings stay in file order and use the bounded wait below.
  const parkedSection = mappedRows.findIndex(index => index !== undefined
    && trajectoryEvents[index]!.start === prevState.parkedUserRow?.offset);
  if (parkedSection > 0 && mappedRows.every(index => index !== undefined)) {
    const order = [parkedSection, ...orderedSections.map((_, index) => index).filter(index => index !== parkedSection)];
    orderedSections = order.map(index => orderedSections[index]!);
    mappedRows = order.map(index => mappedRows[index]!);
  }
  const sectionRowAt: number[] = [];
  for (const at of mappedRows) {
    if (at === undefined || (sectionRowAt.length > 0 && at <= sectionRowAt.at(-1)!)) break;
    sectionRowAt.push(at);
  }

  const userRowsMatch = prevState.userRowsMatch === true || sectionRowAt.length > 0;
  let parkedUserRow: DoubaoBridgeDrainState['parkedUserRow'];
  let sectionRowWait: DoubaoBridgeDrainState['sectionRowWait'];
  let holdSectionsFrom: number | undefined;
  const holdForRequestRow = (sectionIndex: number, trajectoryStart?: number): boolean => {
    if (!userRowsMatch || sectionRowAt[sectionIndex] !== undefined) return false;
    const section = orderedSections[sectionIndex]!;
    const waitKey = section.start;
    const previous = prevState.sectionRowWait?.assignmentOffset === waitKey
      ? prevState.sectionRowWait : undefined;
    const sinceMs = previous?.sinceMs ?? nowMs;
    if (nowMs - sinceMs > SECTION_ROW_WAIT_MS) return false;
    sectionRowWait = { assignmentOffset: waitKey, sinceMs };
    holdSectionsFrom = sectionIndex;
    if (trajectoryStart !== undefined) trajectoryOffset = trajectoryStart;
    return true;
  };

  let remainingOpen = openTurns;
  let nextUser = 0;
  let hasOwner = remainingOpen > 0;
  for (let index = 0; index < trajectoryEvents.length; index++) {
    const { event, userRow, start } = trajectoryEvents[index]!;
    if (userRow !== undefined) {
      if (nextUser < orderedSections.length && sectionRowAt[nextUser] === index) {
        // A new request starts here; whatever ran before it is over.
        noteStarted(orderedSections[nextUser]!);
        events.push(orderedSections[nextUser++]!.event!);
        hasOwner = true;
        remainingOpen = 1;
        continue;
      }
      const ambiguousOldRow = nextUser < orderedSections.length
        && sectionRowAt[nextUser] === undefined
        && ambiguousOldRowAt.get(orderedSections[nextUser]!.start) === index;
      if (!hasOwner && ambiguousOldRow) {
        if (holdForRequestRow(nextUser, start)) break;
        // The ambiguous native occurrence never acquired positive evidence
        // within the bounded wait. Consume its section and events WITHOUT
        // starting the queue turn: its old final must not become the new reply.
        // The unstarted mark follows the ordinary pre-start timeout/notice.
        nextUser++;
        continue;
      }
      const alreadyParked = prevState.parkedUserRow?.offset === start;
      const completeOwner = ctx.nativeInputOwner?.(userRow, true);
      const fingerprintOwner = ctx.nativeInputOwner?.(userRow, false);
      const completeOwned = completeOwner !== undefined || ctx.ownsNativeInput?.(userRow) === true;
      const fingerprintOwned = (fingerprintOwner !== undefined || ctx.ownsNativeInputByFingerprint?.(userRow) === true)
        && !startedRequests.includes(requestDigest(userRow));
      if (!hasOwner && (alreadyParked || nextUser >= orderedSections.length)
        && (completeOwned || fingerprintOwned)) {
        const sinceMs = alreadyParked ? prevState.parkedUserRow!.sinceMs : nowMs;
        if (nowMs - sinceMs <= PARKED_USER_ROW_MAX_MS) {
          // The native row is already known to be the queue's next request.
          // Later sections for successors do not let us skip its answer.
          const owner = completeOwner ?? (fingerprintOwned ? fingerprintOwner : undefined)
            ?? (alreadyParked && prevState.parkedUserRow?.turnId ? {
              turnId: prevState.parkedUserRow.turnId,
              ...(prevState.parkedUserRow.dispatchAttempt !== undefined
                ? { dispatchAttempt: prevState.parkedUserRow.dispatchAttempt } : {}),
            } : undefined);
          parkedUserRow = { offset: start, sinceMs, ...(owner ?? {}) };
          trajectoryOffset = start;
          // Later receipts may already have written successor sections. Keep
          // those bytes too; consuming them now would let a successor start
          // ahead of the parked head and then mistake its own row for a new
          // row-first request on the next drain.
          if (nextUser < orderedSections.length) holdSectionsFrom = nextUser;
          break;
        }
        logger.warn(`[doubao-transcript] request row at ${path}:${start} found no assignment section in ${PARKED_USER_ROW_MAX_MS / 1000}s; reading on`);
      }
      continue;
    }
    if (!hasOwner && nextUser < orderedSections.length
      && !(sectionRowAt[nextUser] !== undefined && sectionRowAt[nextUser]! > index)) {
      if (holdForRequestRow(nextUser, start)) break;
      noteStarted(orderedSections[nextUser]!);
      events.push(orderedSections[nextUser++]!.event!);
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
    events.push(event!);
    if (event!.kind === 'assistant_final') {
      if (remainingOpen > 0) remainingOpen--;
      hasOwner = remainingOpen > 0;
    }
  }
  // A pending prompt may precede its first trajectory row by several polls.
  // Empty windows wait too: the next poll may begin with earlier work's final.
  if (holdSectionsFrom === undefined && nextUser < orderedSections.length) {
    holdForRequestRow(nextUser);
  }
  if (holdSectionsFrom === undefined) {
    for (; nextUser < orderedSections.length; nextUser++) {
      noteStarted(orderedSections[nextUser]!);
      events.push(orderedSections[nextUser]!.event!);
    }
  }

  // Park assignment bytes at a torn trailing heading, if any; every complete
  // section above has been emitted and its bytes may be committed. A section
  // held back for its request row is re-read from its own start.
  if (holdSectionsFrom !== undefined) assignmentOffset = orderedSections[holdSectionsFrom]!.start;
  else if (trailingIncomplete) assignmentOffset = trailingIncomplete.start;
  else assignmentOffset = assignmentWindowEnd;

  return {
    events,
    // The shared cursor must advance whenever EITHER file grows. Trajectory
    // activity dominates, but a user-only append (turn just submitted) must not
    // be re-drained on the next tick either; take the max of the two frontiers.
    newOffset: Math.max(trajectoryOffset, fromOffset),
    pendingTail,
    state: {
      ...(prevState.exportOnly ? { exportOnly: true } : {}),
      assignmentOffset,
      trajectoryOffset,
      ...(skipTrajectoryTail ? { skipTrajectoryTail: true } : {}),
      ...(parkedUserRow ? { parkedUserRow } : {}),
      ...(userRowsMatch ? { userRowsMatch: true } : {}),
      ...(sectionRowWait ? { sectionRowWait } : {}),
      ...(startedRequests.length > 0 ? { startedRequests } : {}),
    },
  };
}
