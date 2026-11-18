/**
 * Authoritative non-screen execution & idle state reader for Google Antigravity CLI (`agy`).
 *
 * Why this exists:
 *  - On PTY and tmux, `worker.ts` confirms Antigravity's held provisional final
 *    and overrides dangling cancelled transcripts using the authoritative live
 *    viewport (`? for shortcuts` + absent `esc to cancel`).
 *  - On `zmx`, `history` includes scrollback and does not carry authoritative
 *    viewport geometry (`backendScreenEvidenceIsAuthoritativeForMutation() === false`),
 *    so screen text must never release a held candidate or declare a turn idle.
 *
 * Antigravity persists its own execution lifecycle in two local SQLite stores
 * under `<geminiCliDir>` (`~/.gemini/antigravity-cli`, or its isolated scratch
 * counterpart):
 *  1. `conversations/<conversationId>.db`:
 *     - `executor_metadata(idx, data)` protobuf rows written only when an
 *       execution loop terminates (`field 1`: `ExecutorTerminationReason`,
 *       `field 3`: `last_step_idx`, `field 4`: `proceeded_with_auto_continue`).
 *       While a turn is mid-flight — including during synchronous `Stop`-hook
 *       continuations and background-task waits — no terminal row covers the
 *       in-flight steps.
 *     - `steps(idx, step_type, status, ...)` trajectory table; if `MAX(idx) > last_step_idx`,
 *       new steps have started after the last terminated execution.
 *  2. `conversation_summaries.db`:
 *     - `conversation_summaries` row keyed by `conversation_id`, carrying
 *       `status` (`CASCADE_RUN_STATUS_IDLE` vs `RUNNING`/`BUSY`/`CANCELING`),
 *       `not_fully_idle` (`1` while any background task or subagent is active),
 *       `step_count`, and `raw_summary` protobuf (`field 21`: `not_fully_idle`,
 *       `field 29`: `background_task_count`, `field 30`: `has_running_subagents`).
 *
 * Every missing file, unreadable/locked DB, unknown enum, or lagging `step_count`
 * fails closed (`hold` / `false`).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CodexBridgeEvent } from './codex-transcript.js';
import {
  conversationIdFromAntigravityTranscriptPath,
  drainAntigravityTranscript,
  readLatestAntigravityTranscriptStepIndex,
} from './antigravity-transcript.js';
import { openDatabaseSyncNow, type DatabaseSyncLike } from './sqlite-compat.js';

function openReadOnlyAntigravityDb(dbPath: string): DatabaseSyncLike | null {
  const db = openDatabaseSyncNow(dbPath, { readOnly: true });
  if (!db) return null;
  try {
    db.exec('PRAGMA busy_timeout = 2000;');
  } catch { /* connection-level pragma; ignore if unsupported */ }
  return db;
}

const CONVERSATION_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** ExecutorTerminationReason enum values that represent normal/bounded planner completion. */
const COMPLETION_TERMINATION_REASONS = new Set<number>([
  3,  // MAX_INVOCATIONS
  4,  // NO_TOOL_CALL
  6,  // MAX_FORCED_INVOCATIONS
  8,  // TERMINAL_STEP_TYPE
  9,  // TERMINAL_CUSTOM_HOOK
  10, // INJECTED_RESPONSE
  11, // MAX_TOKEN_BUDGET_EXCEEDED
]);

/** ExecutorTerminationReason enum values that represent aborted/errored turns
 *  (idle, but held interim narration must NOT be emitted as a completed reply). */
const ABORTED_TERMINATION_REASONS = new Set<number>([
  1, // ERROR
  2, // USER_CANCELED
]);

export interface AntigravityExecutionRun {
  idx: number;
  terminationReason: number;
  lastStepIdx: number;
  proceededWithAutoContinue: boolean;
}

export interface AntigravityExecutionSnapshot {
  conversationId: string;
  terminationReason: number;
  lastStepIdx: number;
  proceededWithAutoContinue: boolean;
  execRuns: readonly AntigravityExecutionRun[];
  maxStepIdx: number;
  stepCount: number;
  summaryStatus: string;
  notFullyIdle: boolean;
  killed: boolean;
  authoritativelyIdle: boolean;
}

export type AntigravityProvisionalFinalVerdict = 'confirm' | 'discard_aborted' | 'hold';

function skipVarint(buf: Uint8Array, pos: number): number | null {
  for (let count = 0; count < 10; count++) {
    const idx = pos + count;
    if (idx >= buf.length) return null;
    if ((buf[idx]! & 0x80) === 0) return idx + 1;
  }
  return null;
}

function readVarint(buf: Uint8Array, pos: number): { value: number; next: number } | null {
  let raw = 0n;
  let shift = 0n;
  for (let count = 0; count < 10; count++) {
    const idx = pos + count;
    if (idx >= buf.length) return null;
    const byte = buf[idx]!;
    raw |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      const signed = count === 9 ? BigInt.asIntN(64, raw) : raw;
      const num = Number(signed);
      if (!Number.isSafeInteger(num)) return null;
      return { value: num, next: idx + 1 };
    }
    shift += 7n;
  }
  return null;
}

function skipWireValue(buf: Uint8Array, pos: number, wireType: number): number | null {
  if (wireType === 0) {
    return skipVarint(buf, pos);
  }
  if (wireType === 1) {
    return pos + 8 <= buf.length ? pos + 8 : null;
  }
  if (wireType === 2) {
    const len = readVarint(buf, pos);
    if (!len || len.value < 0 || len.next + len.value > buf.length) return null;
    return len.next + len.value;
  }
  if (wireType === 5) {
    return pos + 4 <= buf.length ? pos + 4 : null;
  }
  return null;
}

function parseExecutorMetadataBlob(blob: Uint8Array): {
  terminationReason: number;
  lastStepIdx: number;
  proceededWithAutoContinue: boolean;
} | null {
  if (blob.length === 0) return null;
  let terminationReason = 0;
  let lastStepIdx = 0;
  let proceededWithAutoContinue = false;
  let pos = 0;
  while (pos < blob.length) {
    const tag = readVarint(blob, pos);
    if (!tag || tag.value === 0) return null;
    pos = tag.next;
    const fieldNo = Math.floor(tag.value / 8);
    const wireType = tag.value & 7;
    if (wireType === 0 && (fieldNo === 1 || fieldNo === 3 || fieldNo === 4)) {
      const val = readVarint(blob, pos);
      if (!val) return null;
      pos = val.next;
      if (fieldNo === 1) terminationReason = val.value;
      else if (fieldNo === 3) lastStepIdx = val.value;
      else if (fieldNo === 4) proceededWithAutoContinue = val.value !== 0;
    } else {
      const next = skipWireValue(blob, pos, wireType);
      if (next === null) return null;
      pos = next;
    }
  }
  if (terminationReason <= 0) return null;
  return { terminationReason, lastStepIdx, proceededWithAutoContinue };
}

function parseRawSummaryBusyFlags(blob: Uint8Array): {
  notFullyIdle: boolean;
  backgroundTaskCount: number;
  hasRunningSubagents: boolean;
} | null {
  let notFullyIdle = false;
  let backgroundTaskCount = 0;
  let hasRunningSubagents = false;
  let pos = 0;
  while (pos < blob.length) {
    const tag = readVarint(blob, pos);
    if (!tag || tag.value === 0) return null;
    pos = tag.next;
    const fieldNo = Math.floor(tag.value / 8);
    const wireType = tag.value & 7;
    if (wireType === 0 && (fieldNo === 21 || fieldNo === 29 || fieldNo === 30)) {
      const val = readVarint(blob, pos);
      if (!val) return null;
      pos = val.next;
      if (fieldNo === 21) notFullyIdle = val.value !== 0;
      else if (fieldNo === 29) backgroundTaskCount = val.value;
      else if (fieldNo === 30) hasRunningSubagents = val.value !== 0;
    } else {
      const next = skipWireValue(blob, pos, wireType);
      if (next === null) return null;
      pos = next;
    }
  }
  return { notFullyIdle, backgroundTaskCount, hasRunningSubagents };
}

function toBytes(value: unknown): Uint8Array | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return value;
  return null;
}

/**
 * Read the authoritative SQLite execution snapshot for `conversationId`.
 * Pass `geminiCliDir: null` when an isolated scratch view could not be proven;
 * this function then returns `null` immediately without touching host files.
 */
export function readAntigravityExecutionSnapshot(
  conversationId: string | undefined,
  opts?: { geminiCliDir?: string | null },
): AntigravityExecutionSnapshot | null {
  if (!conversationId || !CONVERSATION_ID_RE.test(conversationId)) return null;
  if (opts && opts.geminiCliDir === null) return null;
  const geminiCliDir = opts?.geminiCliDir ?? join(homedir(), '.gemini', 'antigravity-cli');
  const convDbPath = join(geminiCliDir, 'conversations', `${conversationId}.db`);
  const summariesDbPath = join(geminiCliDir, 'conversation_summaries.db');
  if (!existsSync(convDbPath) || !existsSync(summariesDbPath)) return null;

  let terminationReason = 0;
  let lastStepIdx = -1;
  let proceededWithAutoContinue = false;
  let execRuns: AntigravityExecutionRun[] = [];
  let maxStepIdx = -1;

  const convDb = openReadOnlyAntigravityDb(convDbPath);
  if (!convDb) return null;
  try {
    const stepRow = convDb.prepare('SELECT MAX(idx) AS max_idx, COUNT(*) AS cnt FROM steps').get() as
      | { max_idx?: unknown; cnt?: unknown }
      | undefined;
    const cnt = typeof stepRow?.cnt === 'number' ? stepRow.cnt : Number(stepRow?.cnt ?? 0);
    const rawMax = stepRow?.max_idx;
    const parsedMax = typeof rawMax === 'number' ? rawMax : (rawMax == null ? -1 : Number(rawMax));
    if (!Number.isSafeInteger(cnt) || cnt <= 0 || !Number.isSafeInteger(parsedMax) || parsedMax < 0) {
      return null;
    }
    maxStepIdx = parsedMax;

    const execRows = convDb.prepare('SELECT idx, data FROM executor_metadata ORDER BY idx ASC').all() as Array<{
      idx?: unknown;
      data?: unknown;
    }>;
    if (!Array.isArray(execRows) || execRows.length === 0) return null;
    const parsedRuns: AntigravityExecutionRun[] = [];
    for (const row of execRows) {
      const execBytes = toBytes(row?.data);
      if (!execBytes) return null;
      const parsedExec = parseExecutorMetadataBlob(execBytes);
      if (!parsedExec) return null;
      const runIdx = typeof row.idx === 'number' ? row.idx : Number(row.idx ?? parsedRuns.length);
      parsedRuns.push({
        idx: Number.isSafeInteger(runIdx) ? runIdx : parsedRuns.length,
        terminationReason: parsedExec.terminationReason,
        lastStepIdx: parsedExec.lastStepIdx,
        proceededWithAutoContinue: parsedExec.proceededWithAutoContinue,
      });
    }
    execRuns = parsedRuns;
    const latestRun = execRuns[execRuns.length - 1]!;
    terminationReason = latestRun.terminationReason;
    lastStepIdx = latestRun.lastStepIdx;
    proceededWithAutoContinue = latestRun.proceededWithAutoContinue;
  } catch {
    return null;
  } finally {
    try { convDb.close(); } catch { /* ignore */ }
  }

  const sumDb = openReadOnlyAntigravityDb(summariesDbPath);
  if (!sumDb) return null;
  try {
    const sumRow = sumDb.prepare(
      'SELECT step_count, status, not_fully_idle, killed, raw_summary FROM conversation_summaries WHERE conversation_id = ?',
    ).get(conversationId) as {
      step_count?: unknown;
      status?: unknown;
      not_fully_idle?: unknown;
      killed?: unknown;
      raw_summary?: unknown;
    } | undefined;
    if (!sumRow) return null;

    const stepCount = typeof sumRow.step_count === 'number' ? sumRow.step_count : Number(sumRow.step_count ?? -1);
    const summaryStatus = typeof sumRow.status === 'string' ? sumRow.status : '';
    const sqlNotFullyIdle = Number(sumRow.not_fully_idle ?? 1) !== 0;
    const killed = Number(sumRow.killed ?? 0) !== 0;
    if (!Number.isSafeInteger(stepCount) || stepCount < 0 || !summaryStatus) return null;

    let rawBusy = false;
    const rawBytes = toBytes(sumRow.raw_summary);
    if (rawBytes && rawBytes.length > 0) {
      const parsedRaw = parseRawSummaryBusyFlags(rawBytes);
      if (!parsedRaw) return null;
      rawBusy = parsedRaw.notFullyIdle || parsedRaw.backgroundTaskCount > 0 || parsedRaw.hasRunningSubagents;
    }

    const notFullyIdle = sqlNotFullyIdle || rawBusy;
    const isKnownTerminalReason = COMPLETION_TERMINATION_REASONS.has(terminationReason)
      || ABORTED_TERMINATION_REASONS.has(terminationReason);
    const authoritativelyIdle = isKnownTerminalReason
      && !proceededWithAutoContinue
      && lastStepIdx >= maxStepIdx
      && summaryStatus === 'CASCADE_RUN_STATUS_IDLE'
      && !notFullyIdle
      && stepCount >= maxStepIdx + 1;

    return {
      conversationId,
      terminationReason,
      lastStepIdx,
      proceededWithAutoContinue,
      execRuns,
      maxStepIdx,
      stepCount,
      summaryStatus,
      notFullyIdle,
      killed,
      authoritativelyIdle,
    };
  } catch {
    return null;
  } finally {
    try { sumDb.close(); } catch { /* ignore */ }
  }
}

/**
 * Classify a provisional candidate at `candidateStepIndex` when a subsequent
 * explicit `USER_INPUT` has ALREADY arrived in the transcript (meaning the
 * execution covering `candidateStepIndex` has definitely finished, even if the
 * new turn is currently `RUNNING` in `conversation_summaries.db`).
 *
 *  - If `<cid>.db` is absent on disk (transcript-only fixture), returns `'confirm'`.
 *  - If `opts.geminiCliDir === null` (missing/unverified scratch view), fails closed (`'discard_aborted'`).
 *  - Otherwise inspects `executor_metadata` in `<cid>.db` for the first run with
 *    `lastStepIdx >= candidateStepIndex` and rejects aborted/non-completion runs.
 */
export function classifyAntigravityProvisionalBeforeNextTurn(
  conversationId: string | undefined,
  candidateStepIndex: number | undefined,
  opts?: { geminiCliDir?: string | null },
): 'confirm' | 'discard_aborted' {
  if (opts && opts.geminiCliDir === null) return 'discard_aborted';
  if (!conversationId || !CONVERSATION_ID_RE.test(conversationId)) return 'confirm';
  if (candidateStepIndex === undefined || !Number.isSafeInteger(candidateStepIndex) || candidateStepIndex < 0) {
    return 'confirm';
  }
  const geminiCliDir = opts?.geminiCliDir ?? join(homedir(), '.gemini', 'antigravity-cli');
  const convDbPath = join(geminiCliDir, 'conversations', `${conversationId}.db`);
  if (!existsSync(convDbPath)) return 'confirm';

  const convDb = openReadOnlyAntigravityDb(convDbPath);
  if (!convDb) return 'discard_aborted';
  try {
    const execRows = convDb.prepare('SELECT idx, data FROM executor_metadata ORDER BY idx ASC').all() as Array<{
      idx?: unknown;
      data?: unknown;
    }>;
    for (const row of execRows) {
      const execBytes = toBytes(row?.data);
      if (!execBytes) return 'discard_aborted';
      const parsed = parseExecutorMetadataBlob(execBytes);
      if (!parsed) return 'discard_aborted';
      if (parsed.lastStepIdx >= candidateStepIndex) {
        if (parsed.proceededWithAutoContinue) return 'discard_aborted';
        if (COMPLETION_TERMINATION_REASONS.has(parsed.terminationReason)) return 'confirm';
        return 'discard_aborted';
      }
    }
    return 'discard_aborted';
  } catch {
    return 'discard_aborted';
  } finally {
    try { convDb.close(); } catch { /* ignore */ }
  }
}

/**
 * Decide whether Antigravity's held provisional final at `candidateStepIndex`
 * may be released on a backend without authoritative viewport geometry (`zmx`).
 *
 *  - `'confirm'`: execution loop covering `candidateStepIndex` terminated cleanly
 *    and (for the latest execution) the conversation summary is caught up and idle.
 *  - `'discard_aborted'`: execution loop covering `candidateStepIndex` terminated
 *    via `USER_CANCELED` or `ERROR`; discard the interim candidate so it is neither
 *    emitted now nor replayed on the next `USER_INPUT`.
 *  - `'hold'`: still running, waiting on background task / `Stop` hook, stale, or
 *    unreadable — fail closed and keep holding.
 */
export function evaluateAntigravityProvisionalFinalVerdict(
  conversationId: string | undefined,
  candidateStepIndex: number | undefined,
  opts?: { geminiCliDir?: string | null },
): AntigravityProvisionalFinalVerdict {
  if (candidateStepIndex === undefined || !Number.isSafeInteger(candidateStepIndex) || candidateStepIndex < 0) {
    return 'hold';
  }
  const snap = readAntigravityExecutionSnapshot(conversationId, opts);
  if (!snap || snap.maxStepIdx < candidateStepIndex) return 'hold';
  const coveringRun = snap.execRuns.find(r => r.lastStepIdx >= candidateStepIndex);
  if (!coveringRun) return 'hold';
  const isLatestRun = coveringRun === snap.execRuns[snap.execRuns.length - 1];
  if (isLatestRun && !snap.authoritativelyIdle) return 'hold';
  if (coveringRun.proceededWithAutoContinue) return 'hold';
  if (COMPLETION_TERMINATION_REASONS.has(coveringRun.terminationReason)) return 'confirm';
  if (ABORTED_TERMINATION_REASONS.has(coveringRun.terminationReason)) return 'discard_aborted';
  return 'hold';
}

/**
 * Non-screen proof that `conversationId` has settled idle at `transcriptLatestStepIndex`:
 *  - For `USER_CANCELED` / `ERROR`, SQLite may record one extra cancelled step beyond
 *    the dangling transcript (`snap.lastStepIdx >= transcriptLatestStepIndex`).
 *  - For normal completions (`NO_TOOL_CALL`, etc.), the transcript MUST have caught up
 *    to `snap.lastStepIdx` (`transcriptLatestStepIndex >= snap.lastStepIdx`) so an early
 *    SQLite commit never fires `prompt_ready` before `PLANNER_RESPONSE` reaches JSONL.
 */
export function isAntigravityExecutionIdleAtOrAfterStep(
  conversationId: string | undefined,
  minStepIndex: number | undefined,
  opts?: { geminiCliDir?: string | null },
): boolean {
  if (minStepIndex === undefined || !Number.isSafeInteger(minStepIndex) || minStepIndex < 0) {
    return false;
  }
  const snap = readAntigravityExecutionSnapshot(conversationId, opts);
  if (!snap || !snap.authoritativelyIdle) return false;
  if (ABORTED_TERMINATION_REASONS.has(snap.terminationReason)) {
    return snap.lastStepIdx >= minStepIndex && snap.maxStepIdx >= minStepIndex;
  }
  return minStepIndex >= snap.lastStepIdx && minStepIndex >= snap.maxStepIdx;
}

/**
 * Read-only restart-interruption drain for Antigravity transcripts.
 *
 * `drainAntigravityTranscript` holds a trailing `PLANNER_RESPONSE(no tool_calls)`
 * in `state.provisionalFinal` during live streaming because a synchronous `Stop`
 * hook or background task may continue the turn. On a cold-resume scan of a
 * previous process, leaving `provisionalFinal` parked would omit `assistant_final`
 * and falsely classify every completed Antigravity turn as interrupted (`turnOpen=true`).
 *
 * Reconciles the drained tail against the SQLite execution snapshot when present
 * (keeping an in-flight `Stop` hook / background task as `turnOpen=true` while
 * closing completed or `USER_CANCELED` turns), and falls back to releasing a
 * completed tool-free `provisionalFinal` when no SQLite store exists on disk.
 */
export function drainAntigravityForRestartScan(
  transcriptPath: string,
  fromOffset: number,
  opts: { geminiCliDir?: string | null; beforeMs: number },
): { events: CodexBridgeEvent[] } {
  const cid = conversationIdFromAntigravityTranscriptPath(transcriptPath) ?? undefined;
  const drained = drainAntigravityTranscript(transcriptPath, fromOffset, {}, {
    classifyProvisionalBeforeNextTurn: stepIdx =>
      classifyAntigravityProvisionalBeforeNextTurn(cid, stepIdx, { geminiCliDir: opts.geminiCliDir }),
  });
  const events: CodexBridgeEvent[] = [...drained.events];
  const resolvedCliDir = opts && opts.geminiCliDir === null
    ? null
    : (opts?.geminiCliDir ?? join(homedir(), '.gemini', 'antigravity-cli'));
  const hasExecutionStore = resolvedCliDir === null || Boolean(
    cid && (
      existsSync(join(resolvedCliDir, 'conversations', `${cid}.db`))
      || existsSync(join(resolvedCliDir, 'conversation_summaries.db'))
    ),
  );
  const snap = readAntigravityExecutionSnapshot(cid, { geminiCliDir: opts.geminiCliDir });

  if (drained.state.provisionalFinal && !drained.state.hasPendingTask) {
    if (hasExecutionStore) {
      const verdict = evaluateAntigravityProvisionalFinalVerdict(
        cid,
        drained.state.provisionalFinalStepIndex,
        { geminiCliDir: opts.geminiCliDir },
      );
      if (verdict === 'confirm') {
        events.push(drained.state.provisionalFinal);
      } else if (verdict === 'discard_aborted') {
        events.push({
          kind: 'turn_aborted',
          uuid: `agy-scan-abort:${cid ?? 'unknown'}:${drained.state.provisionalFinalStepIndex ?? 0}`,
          text: '',
          timestampMs: drained.state.provisionalFinal.timestampMs,
        });
      }
    } else {
      events.push(drained.state.provisionalFinal);
    }
  } else if (!drained.state.provisionalFinal && snap && snap.authoritativelyIdle && ABORTED_TERMINATION_REASONS.has(snap.terminationReason)) {
    const latestStep = readLatestAntigravityTranscriptStepIndex(transcriptPath);
    if (latestStep !== undefined && snap.lastStepIdx >= latestStep && snap.maxStepIdx >= latestStep) {
      events.push({
        kind: 'turn_aborted',
        uuid: `agy-scan-abort:${cid ?? 'unknown'}:${latestStep}`,
        text: '',
        timestampMs: Math.max(0, opts.beforeMs - 1),
      });
    }
  }
  return { events };
}
