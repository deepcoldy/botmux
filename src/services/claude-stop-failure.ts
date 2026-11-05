/**
 * Claude Code `StopFailure` hook: structured evidence that a turn ended on an
 * API error.
 *
 * When a turn hits a terminal API error — "API Error: Connection lost
 * mid-response.", a 5xx after Claude's own retries, an auth failure — Claude
 * Code ends it through a path that runs `StopFailure` hooks and never `Stop`
 * hooks. Verified on Claude Code 2.1.296 against a local API that drops the
 * stream after one complete content block: the TUI rendered the error,
 * `StopFailure` fired with `error:"server_error"`, `Stop` did not, and the
 * transcript gained the API-error record plus `system/turn_duration`.
 *
 * Botmux settles Claude turns from that transcript. When the bridge has lost
 * the running turn (it reads a transcript Claude no longer writes, or another
 * edge already closed the turn), the failure settles nothing: no automatic
 * continuation, no failure card, and the chat waits on a stopped task. The
 * hook closes that gap as a fallback only — the worker gives the transcript a
 * grace period to surface the failure; if it did not, the worker settles the
 * turn that was running (so the daemon continues or reports it like any other
 * failed turn), or, when no open turn is left to settle, posts a plain notice.
 * An isolated session whose turn capability was already revoked reaches the
 * worker through its relay outbox instead, notify-only (see the last section).
 *
 * `error` is the same field Claude writes on the transcript's API-error
 * record, so the outcome reuses the transcript classifier: both paths turn
 * one failure into the same terminal.
 *
 * The decision logic is pure; only the relay-outbox helpers at the end touch
 * the file system.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync, constants as fsConstants, fstatSync, openSync, readdirSync, readSync, renameSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  classifyClaudeTerminalEvent, eventTimeMs, type ClaudeTerminalOutcome, type TranscriptEvent,
} from './claude-transcript.js';

/** How long the transcript path gets to settle the failed turn before the
 *  hook settles it. Claude writes the API-error record before it runs the
 *  hook and `turn_duration` right after it; the watcher reads both within a
 *  poll tick or two, so this only delays the fallback case. */
export const CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS = 5_000;

export interface ClaudeStopFailureReport {
  /** Claude's machine error type: `server_error`, `overloaded`, `rate_limit`,
   *  `authentication_failed`, `invalid_request`, … */
  error: string;
  /** The rendered error line (`API Error: …`). */
  lastAssistantMessage?: string;
  errorDetails?: string;
  /** Claude-native session id of the CLI that ran the hook. */
  cliSessionId?: string;
  /** Transcript the CLI that ran the hook writes. */
  transcriptPath?: string;
  /** `CLAUDE_PID` of the CLI that ran the hook. */
  claudePid?: number;
  /** Set when a sub-agent's query loop failed (Claude puts the sub-agent's id
   *  on every hook it runs). */
  agentId?: string;
  agentType?: string;
}

const MAX_ERROR_LENGTH = 64;
const MAX_TEXT_LENGTH = 2_000;
const MAX_ID_LENGTH = 128;
const MAX_PATH_LENGTH = 4_096;

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function buildReport(fields: {
  error: unknown;
  lastAssistantMessage: unknown;
  errorDetails: unknown;
  cliSessionId: unknown;
  transcriptPath: unknown;
  claudePid: unknown;
  agentId: unknown;
  agentType: unknown;
}): ClaudeStopFailureReport | undefined {
  const error = boundedString(fields.error, MAX_ERROR_LENGTH);
  if (!error) return undefined;
  const report: ClaudeStopFailureReport = { error };
  const lastAssistantMessage = boundedString(fields.lastAssistantMessage, MAX_TEXT_LENGTH);
  if (lastAssistantMessage) report.lastAssistantMessage = lastAssistantMessage;
  const errorDetails = boundedString(fields.errorDetails, MAX_TEXT_LENGTH);
  if (errorDetails) report.errorDetails = errorDetails;
  const cliSessionId = boundedString(fields.cliSessionId, MAX_ID_LENGTH);
  if (cliSessionId) report.cliSessionId = cliSessionId;
  const transcriptPath = boundedString(fields.transcriptPath, MAX_PATH_LENGTH);
  if (transcriptPath) report.transcriptPath = transcriptPath;
  const claudePid = positiveInt(fields.claudePid);
  if (claudePid !== undefined) report.claudePid = claudePid;
  const agentId = boundedString(fields.agentId, MAX_ID_LENGTH);
  if (agentId) report.agentId = agentId;
  const agentType = boundedString(fields.agentType, MAX_ID_LENGTH);
  if (agentType) report.agentType = agentType;
  return report;
}

/** Parse the JSON Claude writes to a `StopFailure` hook's stdin. `claudePid`
 *  is the hook's inherited `CLAUDE_PID`. Anything that is not a StopFailure
 *  payload with an error type yields undefined. */
export function parseClaudeStopFailureHookInput(
  payloadText: string,
  claudePid?: string,
): ClaudeStopFailureReport | undefined {
  let payload: unknown;
  try { payload = JSON.parse(payloadText); } catch { return undefined; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const p = payload as Record<string, unknown>;
  if (p.hook_event_name !== undefined && p.hook_event_name !== 'StopFailure') return undefined;
  return buildReport({
    error: p.error,
    lastAssistantMessage: p.last_assistant_message,
    // Claude passes `error_details` through as-is; only its text form is kept.
    errorDetails: typeof p.error_details === 'string' ? p.error_details : undefined,
    cliSessionId: p.session_id,
    transcriptPath: p.transcript_path,
    claudePid,
    agentId: p.agent_id,
    agentType: p.agent_type,
  });
}

/** Re-validate a report that crossed the daemon IPC boundary. */
export function normalizeClaudeStopFailureReport(value: unknown): ClaudeStopFailureReport | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  return buildReport({
    error: v.error,
    lastAssistantMessage: v.lastAssistantMessage,
    errorDetails: v.errorDetails,
    cliSessionId: v.cliSessionId,
    transcriptPath: v.transcriptPath,
    claudePid: v.claudePid,
    agentId: v.agentId,
    agentType: v.agentType,
  });
}

/** The terminal the transcript path would derive from the same failure. */
export function classifyClaudeStopFailure(report: ClaudeStopFailureReport): ClaudeTerminalOutcome | undefined {
  return classifyClaudeTerminalEvent({
    type: 'assistant',
    isApiErrorMessage: true,
    error: report.error,
    // The transcript record of an overload carries HTTP 529; the hook payload
    // carries no status, only the error type.
    ...(report.error.toLowerCase() === 'overloaded' ? { apiErrorStatus: 529 } : {}),
    message: {
      role: 'assistant',
      content: report.lastAssistantMessage ? [{ type: 'text', text: report.lastAssistantMessage }] : [],
    },
  });
}

export interface ClaudeStopFailureOwner {
  /** PID of the Claude process this worker drives, when resolved. */
  cliPid?: number;
  /** Claude session ids known to belong to that process. */
  cliSessionIds: ReadonlySet<string>;
  /** Transcript the bridge reads. */
  transcriptPath?: string;
}

/**
 * Whether the report came from the Claude process this worker drives.
 *
 * A `claude -p` the agent runs from its own Bash tool inherits the session's
 * `BOTMUX_*` env and reads the same settings, so its API errors reach this
 * worker too. Its `CLAUDE_PID`, session id and transcript are all its own.
 * Any one matching identifier is accepted: a sandboxed CLI reports a
 * namespace-local pid, and the session id rotates on `/clear`.
 */
export function claudeStopFailureBelongsToOwner(
  report: ClaudeStopFailureReport,
  owner: ClaudeStopFailureOwner,
): boolean {
  if (report.claudePid !== undefined && report.claudePid === owner.cliPid) return true;
  if (report.cliSessionId !== undefined && owner.cliSessionIds.has(report.cliSessionId)) return true;
  return report.transcriptPath !== undefined && report.transcriptPath === owner.transcriptPath;
}

// ─── Transcript corroboration ────────────────────────────────────────────────
//
// `StopFailure` does not only fire for the main conversation. Claude Code runs
// background forks from the main context after a turn (`extract_memories`,
// `prompt_suggestion`, …: `skipTranscript` query loops) and a failure there
// runs the same hook with the main session's `session_id` and
// `transcript_path`, usually without an `agent_id`. Nothing of it reaches the
// transcript and the conversation carries on. Measured on 2.1.318: six such
// reports 21–41s after normal `end_turn`s of an already completed turn, no
// API-error record anywhere.
//
// What a real main-chain failure always leaves is its terminal record. Every
// 2.1.318 `StopFailure` call site yields the record first and then runs the
// hook with that same message: the API-error record itself, and the synthetic
// terminals built the same way (`malformed_tool_use_exhausted`,
// `empty_completion`, `prompt_too_long` / `image_error`,
// `autocompact_thrashing`) — all `type:"assistant"`, `isApiErrorMessage:true`,
// `apiError:<kind>`, and an `error` field that is the hook's `error` (the hook
// says `unknown` when the record has none). So when the hook names the
// transcript the bridge reads, the report only counts once the bridge has read
// a matching non-sidechain record.

/** How far a record's own timestamp may precede the report. Claude creates
 *  the record, writes it and only then starts the hook, so a real report
 *  normally lands within a second of its record (measured on this fleet:
 *  0.4–0.7s). The bound leaves room for a slow hook start, and stays short so
 *  a record whose own hook got lost cannot back a later background failure. */
export const CLAUDE_STOP_FAILURE_RECORD_MAX_LEAD_MS = 30_000;
/** Same, for `invalid_request`: a prompt-too-long / autocompact terminal can
 *  surface after Claude tried, and failed, to compact, and an image error
 *  surfaces the record of the request that failed before that attempt. */
export const CLAUDE_STOP_FAILURE_COMPACT_RECORD_MAX_LEAD_MS = 5 * 60_000;
/** How far a record's timestamp may follow the report's arrival. The record is
 *  created before the hook starts; this only absorbs timestamp rounding and
 *  the worker's view of arrival. Kept short so the next real failure's record
 *  is not claimed by a background report that came just before it. */
export const CLAUDE_STOP_FAILURE_RECORD_MAX_LAG_MS = 3_000;
/** Extra time, after the grace period, for a transcript write that lost the
 *  race against the hook to reach the bridge. */
export const CLAUDE_STOP_FAILURE_CORROBORATION_EXTRA_MS = 10_000;
const MAX_OBSERVED_RECORDS = 32;
const DIAGNOSTIC_FIELD_MAX = 200;

interface ObservedTerminalRecord {
  path: string;
  uuid?: string;
  error: string;
  atMs: number;
  used: boolean;
}

/** Main-chain terminal records the bridge read, for {@link handleClaudeStopFailureReport}
 *  to match reports against. Each record backs one report at most. */
export class ClaudeStopFailureTranscriptEvidence {
  private records: ObservedTerminalRecord[] = [];

  /** Feed every batch of events the bridge read from `path`. */
  observe(events: readonly TranscriptEvent[], path: string): void {
    for (const ev of events) {
      if (!ev || typeof ev !== 'object' || ev.isSidechain === true || ev.isApiErrorMessage !== true) continue;
      const role = ev.message?.role ?? ev.type;
      if (role !== 'assistant') continue;
      const atMs = eventTimeMs(ev);
      if (atMs === undefined) continue;
      // The same file can be read twice (a path that is primary again while
      // still listed as a retired secondary path).
      const uuid = typeof ev.uuid === 'string' && ev.uuid ? ev.uuid : undefined;
      if (uuid && this.records.some(r => r.uuid === uuid && r.path === path)) continue;
      const error = (typeof ev.error === 'string' && ev.error.trim() ? ev.error.trim() : 'unknown').slice(0, MAX_ERROR_LENGTH);
      this.records.push({ path, ...(uuid ? { uuid } : {}), error, atMs, used: false });
    }
    if (this.records.length > MAX_OBSERVED_RECORDS) {
      // Keep the newest unused records: used ones back nothing any more.
      this.records.sort((a, b) => (Number(b.used) - Number(a.used)) || (a.atMs - b.atMs));
      this.records.splice(0, this.records.length - MAX_OBSERVED_RECORDS);
    }
  }

  /** Claim the record a report that arrived at `arrivedAtMs` stands for: the
   *  unused one of the same error and transcript closest to the arrival. */
  take(report: ClaudeStopFailureReport, arrivedAtMs: number): boolean {
    const path = report.transcriptPath;
    if (!path) return false;
    const maxLeadMs = report.error === 'invalid_request'
      ? CLAUDE_STOP_FAILURE_COMPACT_RECORD_MAX_LEAD_MS
      : CLAUDE_STOP_FAILURE_RECORD_MAX_LEAD_MS;
    let found: ObservedTerminalRecord | undefined;
    for (const r of this.records) {
      if (r.used || r.path !== path || r.error !== report.error) continue;
      if (r.atMs < arrivedAtMs - maxLeadMs || r.atMs > arrivedAtMs + CLAUDE_STOP_FAILURE_RECORD_MAX_LAG_MS) continue;
      if (!found || Math.abs(r.atMs - arrivedAtMs) < Math.abs(found.atMs - arrivedAtMs)) found = r;
    }
    if (!found) return false;
    found.used = true;
    return true;
  }
}

function diagnosticText(value: string | undefined): string {
  if (!value) return '-';
  const flat = value.replace(/\s+/g, ' ');
  return JSON.stringify(flat.length > DIAGNOSTIC_FIELD_MAX ? `${flat.slice(0, DIAGNOSTIC_FIELD_MAX)}…` : flat);
}

/** One bounded line for a report that is dropped without telling the chat. */
export function describeClaudeStopFailureReport(report: ClaudeStopFailureReport): string {
  return `error=${diagnosticText(report.error)} agent_id=${diagnosticText(report.agentId)} `
    + `agent_type=${diagnosticText(report.agentType)} error_details=${diagnosticText(report.errorDetails)} `
    + `last_assistant_message=${diagnosticText(report.lastAssistantMessage)}`;
}

export type ClaudeStopFailureFallback =
  | {
    action: 'skip';
    /** `rate_limited`: usage limits stay with the structured limit path.
     *  `surfaced`: a failed terminal or failure notice went out around the
     *  report (normally the transcript path settling this turn). */
    reason: 'unclassified' | 'rate_limited' | 'surfaced';
  }
  /** The turn is still open: settle it, so the daemon continues or reports it. */
  | { action: 'emit'; status: 'failed' | 'ambiguous'; errorCode: string; retryable: boolean }
  /** No open turn to settle safely — the turn was already closed (e.g. as
   *  completed by an earlier edge while the CLI kept working), none was
   *  running, the claim named another turn, or the CLI already moved on to
   *  the next input. Tell the chat the work stopped. */
  | { action: 'notify'; errorCode: string };

/**
 * Decide, once the grace period is over, how the failure reaches the chat.
 *
 * The invariant is that every API error that ends a turn of the driven CLI
 * surfaces somewhere. The transcript path normally does it (a failed terminal,
 * or a local-turn notice), and then nothing more is sent.
 */
export function decideClaudeStopFailureFallback(input: {
  outcome: ClaudeTerminalOutcome | undefined;
  /** The open turn the failure may settle; undefined when there is none to settle. */
  turnId: string | undefined;
  /** That turn already has a terminal. */
  settled: boolean;
  /** The CLI is back at its prompt. When it is busy again, Claude has
   *  already started the next queued input, and the turn this worker calls
   *  active may be that one rather than the one that failed. */
  cliIdle: boolean;
  /** A failed terminal or failure notice went out around the report. */
  surfaced: boolean;
}): ClaudeStopFailureFallback {
  const { outcome } = input;
  if (!outcome || outcome.status === 'completed') return { action: 'skip', reason: 'unclassified' };
  if (outcome.status === 'rate_limited') return { action: 'skip', reason: 'rate_limited' };
  if (input.surfaced) return { action: 'skip', reason: 'surfaced' };
  if (input.turnId && !input.settled && input.cliIdle) {
    return { action: 'emit', status: outcome.status, errorCode: outcome.errorCode, retryable: outcome.retryable };
  }
  return { action: 'notify', errorCode: outcome.errorCode };
}

/** The worker state and effects one StopFailure report is handled against. */
export interface ClaudeStopFailureContext<TTimer = unknown> {
  owner: ClaudeStopFailureOwner;
  /** The turn this worker believes is running when the report arrives. */
  activeTurn: { turnId?: string; dispatchAttempt?: number };
  schedule: (delayMs: number, run: () => void) => TTimer;
  /** Read transcript bytes the watcher has not consumed yet; a transcript
   *  that is merely behind then settles the turn itself. */
  catchUp: () => void;
  /** Status of the terminal already emitted for the turn; undefined while it
   *  has none. */
  settledStatus: (turnId: string, dispatchAttempt?: number) => string | undefined;
  /** The CLI is back at its prompt. */
  cliIdle: () => boolean;
  /** This worker ran or queued the turn recently (a reply target it can vouch for). */
  isKnownTurn: (turnId: string) => boolean;
  /** When the worker last emitted a failed/ambiguous terminal or a failure
   *  notice. */
  lastFailureSurfacedAtMs: () => number | undefined;
  /** Main-chain terminal records the bridge read (see
   *  {@link ClaudeStopFailureTranscriptEvidence}). */
  transcriptEvidence: { take: (report: ClaudeStopFailureReport, arrivedAtMs: number) => boolean };
  /** Reserve the one notice a closed turn may get; false when it already had it. */
  claimTurnNotice: (turnId: string, dispatchAttempt?: number) => boolean;
  now: () => number;
  emit: (
    turnId: string,
    status: 'failed' | 'ambiguous',
    errorCode: string,
    dispatchAttempt: number | undefined,
    retryable: boolean,
  ) => void;
  /** Plain chat notice; `replyTurnId` picks the reply target. */
  notify: (errorCode: string, replyTurnId: string | undefined) => void;
  log: (line: string) => void;
}

/**
 * Handle one StopFailure report from the driven CLI: freeze the turn it ended,
 * and after the grace period settle that turn or tell the chat, unless the
 * transcript path already surfaced the failure.
 *
 * Claude does not wait for StopFailure hooks: it ends the turn, writes
 * `turn_duration` and may start the next queued input while the hook client
 * is still starting up. So the transcript can surface the failure on either
 * side of the report, and the turn the reporter (or this worker) calls active
 * may already be that next input. The turn is frozen on arrival; it is only
 * settled if it still has no terminal and the CLI is idle at the end of the
 * grace period, i.e. nothing started after the failure. `claimedTurn` is the
 * reporter's view (the active-turn marker it read); one that names another
 * turn than the worker's is never settled — the same exact-tuple rule as the
 * turn-idle report. Whatever cannot be settled safely is reported as a notice,
 * replying to the claimed turn only if this worker knows it.
 *
 * A report that names the transcript the bridge reads only counts once the
 * bridge read the failure's main-chain terminal record (see the corroboration
 * section above); one that names another transcript — the bridge lost the
 * session, which is what this fallback is for — is taken as it is. A
 * sub-agent's report never reaches the chat: the parent gets that failure as
 * a tool result and carries on. A closed turn gets one notice at most.
 *
 * `notifyOnly` marks a report whose bytes the sandbox controls (the relay
 * outbox, see below): it may produce a notice, never a terminal.
 */
export function handleClaudeStopFailureReport<TTimer>(
  report: ClaudeStopFailureReport,
  claimedTurn: { turnId?: string; dispatchAttempt?: number },
  ctx: ClaudeStopFailureContext<TTimer>,
  opts: { notifyOnly?: boolean } = {},
): TTimer | undefined {
  if (!claudeStopFailureBelongsToOwner(report, ctx.owner)) {
    ctx.log(`Ignoring Claude StopFailure (${report.error}) from another Claude process `
      + `(pid=${report.claudePid ?? '?'} sid=${report.cliSessionId?.slice(0, 8) ?? '?'})`);
    return undefined;
  }
  if (report.agentId !== undefined) {
    ctx.log(`Claude StopFailure from sub-agent ${report.agentType ?? '?'}: not reported, the parent agent `
      + `receives it as a tool result (${describeClaudeStopFailureReport(report)})`);
    return undefined;
  }
  const arrivedAtMs = ctx.now();
  // Same transcript as the bridge: the failure is real only if its record is there.
  const needsRecord = report.transcriptPath !== undefined && report.transcriptPath === ctx.owner.transcriptPath;
  const active = ctx.activeTurn;
  const claimMatches = claimedTurn.turnId === undefined
    || (claimedTurn.turnId === active.turnId && claimedTurn.dispatchAttempt === active.dispatchAttempt);
  if (!claimMatches) {
    ctx.log(`Claude StopFailure (${report.error}) claims turn ${claimedTurn.turnId!.slice(0, 12)} but `
      + `the active turn is ${active.turnId?.slice(0, 12) ?? 'none'}; it will not settle a turn`);
  }
  // The turn the failure belongs to, as far as this worker can tell.
  const failedTurn = claimMatches
    ? active
    : ctx.isKnownTurn(claimedTurn.turnId!) ? claimedTurn : {};
  const settleTurnId = claimMatches && !opts.notifyOnly ? active.turnId : undefined;
  // The transcript surfaces this failure within a second or two of it, on
  // either side of the report (see above). This window only matters for a
  // failure surfaced on another turn (a local-turn notice, an absorbed input).
  const surfacedSinceMs = ctx.now() - CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS;
  const outcome = classifyClaudeStopFailure(report);
  ctx.log(`Claude StopFailure (${report.error}${opts.notifyOnly ? ', notify-only' : ''}) for turn `
    + `${failedTurn.turnId?.slice(0, 12) ?? '-'}; waiting ${CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS}ms `
    + 'for the transcript to surface it');
  const settle = (lastChance: boolean): void => {
    try {
      ctx.catchUp();
    } catch (err) {
      ctx.log(`Claude StopFailure catch-up read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (needsRecord && outcome && (outcome.status === 'failed' || outcome.status === 'ambiguous')
      && !ctx.transcriptEvidence.take(report, arrivedAtMs)) {
      if (!lastChance) {
        ctx.schedule(CLAUDE_STOP_FAILURE_CORROBORATION_EXTRA_MS, () => settle(true));
        return;
      }
      ctx.log('Claude StopFailure without a main-chain terminal record in the transcript the bridge reads '
        + '(a background request of the session failed, not the conversation); not reported '
        + `(${describeClaudeStopFailureReport(report)})`);
      return;
    }
    const settledStatus = failedTurn.turnId
      ? ctx.settledStatus(failedTurn.turnId, failedTurn.dispatchAttempt)
      : undefined;
    const decision = decideClaudeStopFailureFallback({
      outcome,
      turnId: settleTurnId,
      settled: settledStatus !== undefined,
      cliIdle: ctx.cliIdle(),
      // The failed turn's own failed terminal is this failure, however late
      // the report. Otherwise only a failure surfaced around the report counts.
      surfaced: settledStatus === 'failed' || settledStatus === 'ambiguous'
        || (ctx.lastFailureSurfacedAtMs() ?? -Infinity) >= surfacedSinceMs,
    });
    switch (decision.action) {
      case 'skip':
        ctx.log(`Claude StopFailure (${report.error}) needs no fallback (${decision.reason})`);
        return;
      case 'emit':
        ctx.log(`Claude StopFailure fallback: the transcript never settled turn ${settleTurnId!.slice(0, 12)}; `
          + `emitting ${decision.status}/${decision.errorCode}`);
        ctx.emit(settleTurnId!, decision.status, decision.errorCode, active.dispatchAttempt, decision.retryable);
        return;
      case 'notify':
        // A closed turn gets one notice: whatever else fails after it stopped
        // is the same "check the terminal" the chat already has.
        if (failedTurn.turnId && settledStatus !== undefined
          && !ctx.claimTurnNotice(failedTurn.turnId, failedTurn.dispatchAttempt)) {
          ctx.log(`Claude StopFailure (${report.error}): closed turn ${failedTurn.turnId.slice(0, 12)} already got `
            + 'its failure notice; not repeating it');
          return;
        }
        ctx.log(`Claude StopFailure fallback: no open turn to settle and nothing surfaced the failure; `
          + `notifying (${decision.errorCode})`);
        ctx.notify(decision.errorCode, failedTurn.turnId);
    }
  };
  return ctx.schedule(CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS, () => settle(false));
}

// ─── Relay outbox: the notify-only channel of an isolated session ─────────────
//
// A sandboxed / read-isolated CLI cannot read the host secret, so the hook
// client proves itself to the daemon with this turn's capability — which the
// worker revokes as soon as the turn settles at prompt-ready. The case this
// fallback exists for (a turn closed before its API error arrived) therefore
// always meets a 403. The client then drops the report into the session's
// relay outbox instead: only this session's sandbox and its worker can reach
// that directory, and it belongs to the worker generation. The sandbox
// controls every byte there, so the worker treats such a report as
// notify-only and bounds what it accepts.

export const CLAUDE_STOP_FAILURE_OUTBOX_SUFFIX = '.claude-stop-failure.json';
/** Older reports are left-overs (a previous worker generation's) and dropped. */
export const CLAUDE_STOP_FAILURE_OUTBOX_MAX_AGE_MS = 60_000;
const OUTBOX_REPORT_MAX_BYTES = 16 * 1024;
const OUTBOX_CLOCK_SKEW_MS = 5_000;

export interface ClaudeStopFailureOutboxReport {
  report: ClaudeStopFailureReport;
  /** The reporter's view of the active turn; a reply target hint only. */
  turnId?: string;
  atMs: number;
}

/** Hook-client side: publish one report atomically into the relay outbox. */
export function writeClaudeStopFailureOutboxReport(
  outbox: string,
  report: ClaudeStopFailureReport,
  opts: { turnId?: string; now?: number } = {},
): string {
  const name = `${randomBytes(12).toString('hex')}${CLAUDE_STOP_FAILURE_OUTBOX_SUFFIX}`;
  const path = join(outbox, name);
  const tmp = join(outbox, `.${name}.tmp`);
  const turnId = boundedString(opts.turnId, MAX_ID_LENGTH);
  writeFileSync(tmp, JSON.stringify({
    v: 1,
    atMs: opts.now ?? Date.now(),
    report,
    ...(turnId ? { turnId } : {}),
  }), { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

/** Worker side: consume every report in the outbox and return the fresh,
 *  well-formed ones, oldest first. Symlinks, oversized files and malformed
 *  bodies are consumed and dropped. */
export function drainClaudeStopFailureOutbox(outbox: string, now: number = Date.now()): ClaudeStopFailureOutboxReport[] {
  let names: string[];
  try { names = readdirSync(outbox); } catch { return []; }
  const out: ClaudeStopFailureOutboxReport[] = [];
  for (const name of names) {
    if (name.startsWith('.') || !name.endsWith(CLAUDE_STOP_FAILURE_OUTBOX_SUFFIX)) continue;
    const path = join(outbox, name);
    let body: string | undefined;
    let fd: number | undefined;
    try {
      // O_NOFOLLOW + fstat: the sandbox may swap the file for a symlink to a
      // host file between listing and reading.
      fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (stat.isFile() && stat.size <= OUTBOX_REPORT_MAX_BYTES) {
        const buf = Buffer.alloc(stat.size);
        const n = readSync(fd, buf, 0, stat.size, 0);
        body = buf.subarray(0, n).toString('utf8');
      }
    } catch { /* gone, a symlink, or unreadable: drop it */ }
    finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* */ } }
      try { unlinkSync(path); } catch { /* already consumed */ }
    }
    if (body === undefined) continue;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(body); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) continue;
    const atMs = typeof parsed.atMs === 'number' && Number.isFinite(parsed.atMs) ? parsed.atMs : undefined;
    if (atMs === undefined || now - atMs > CLAUDE_STOP_FAILURE_OUTBOX_MAX_AGE_MS || atMs - now > OUTBOX_CLOCK_SKEW_MS) continue;
    const report = normalizeClaudeStopFailureReport(parsed.report);
    if (!report) continue;
    const turnId = boundedString(parsed.turnId, MAX_ID_LENGTH);
    out.push({ report, atMs, ...(turnId ? { turnId } : {}) });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}
