/**
 * Frozen read-only projection for archived v2 workflow runs.
 *
 * The v2 execution engine is retired. Migration/archive verification retains
 * this projector so historical bytes can still be checked before deletion.
 * All readers in here are pure: they never `mkdir` and never validate
 * caller-provided runIds as filesystem paths without going through
 * `isValidRunId` first.  Callers built on top of this module can hand
 * the resulting DTOs to JSON responses or to plain stdout printers
 * without worrying about side effects.
 *
 * Side-effect contract:
 *   - listRuns / readRunSnapshot / readEventWindow all return null / []
 *     instead of throwing when a run is missing or its event log is
 *     corrupt.  Corrupt = "any line fails parseEvent" — same boundary
 *     `EventLog.readAll` uses, except we don't crash the caller.
 *   - We DO NOT use `EventLog` here; EventLog's constructor mkdirs
 *     runDir + blobDir, which is wrong for a read-only API.
 */
import { promises as fs } from 'node:fs';
import { relative, resolve, sep, join, dirname } from 'node:path';

import {
  parseWorkflowDefinition,
  type WorkflowDefinition,
} from './definition.js';
import {
  parseEvent,
  type WorkflowEvent,
} from './events/schema.js';
import {
  replay,
  type ActivityState,
  type NodeState,
  type RunState,
  type Snapshot,
} from './events/replay.js';
import type { OutputRef } from './events/payloads.js';
import { workActivityId } from './migration/v2-read-only-ids.js';
import {
  attemptTerminalSidecarPath,
  type AttemptTerminalSidecar,
} from './attempt-terminal.js';

export const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * runId allowlist — must be passed BEFORE concatenating into a path.
 *
 * The runtime generates runIds via `crypto.randomUUID()` or operator-
 * supplied slugs (CLI / dogfood scripts); both fit `[A-Za-z0-9._-]`.
 * This guard rejects `.`, `..`, slashes, and anything else that could
 * escape `runsDir` via path traversal, plus empty strings.
 */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function isValidRunId(runId: string): boolean {
  return RUN_ID_RE.test(runId);
}

/**
 * Activity / attempt id allowlist — accepts `<runId>::work::<nodeId>` and
 * `<...>::att-N` shaped strings the orchestrator emits, while still rejecting
 * `/`, `..`, whitespace and anything else that could escape the run dir when
 * concatenated into an attempt sidecar path.
 */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
export function isValidPathSegment(s: string): boolean {
  return SEGMENT_RE.test(s);
}

/**
 * Path-traversal guard — returns true iff `child`, after `..`/`.` resolution,
 * still lives inside `parent`.  Exported so dashboard surfaces that build
 * paths from caller-supplied ids (e.g. attempt terminal-log raw endpoint)
 * can apply the same defense-in-depth check on top of `isValidRunId` /
 * `isValidPathSegment`.
 */
export function isPathInsideDir(parent: string, child: string): boolean {
  return isPathInside(parent, child);
}

/**
 * Resolve the on-disk `terminal.log` path for a given attempt sidecar.
 * Production callers MUST validate runId / activityId / attemptId with
 * `isValidRunId` + `isValidPathSegment` first, and re-check `isPathInsideDir`
 * after joining to defend against any future segment-regex relaxation.
 */
export function attemptTerminalLogPath(
  runsDir: string,
  runId: string,
  activityId: string,
  attemptId: string,
): string {
  return join(runsDir, runId, 'attempts', activityId, attemptId, 'terminal.log');
}

/**
 * Resolve the on-disk raw `pty.log` path for a given attempt sidecar.
 * Same validation contract as `attemptTerminalLogPath` — callers MUST
 * pre-validate ids and re-check `isPathInsideDir` after joining.
 */
export function attemptPtyLogPath(
  runsDir: string,
  runId: string,
  activityId: string,
  attemptId: string,
): string {
  return join(runsDir, runId, 'attempts', activityId, attemptId, 'pty.log');
}

// ─── list ──────────────────────────────────────────────────────────────────

export type RunRow = {
  runId: string;
  workflowId: string;
  status: string;
  lastSeq: number;
  dEf: number;
  dAct: number;
  dWait: number;
  updatedAt: number;
  failedNodeId?: string;
  errorCode?: string;
  errorClass?: string;
  errorMessage?: string;
  chatId?: string;
  larkAppId?: string;
};

export type ListRunsOptions = {
  /** Include terminal runs.  Default false (matches `botmux workflow ls`). */
  all?: boolean;
  /** Explicit status filter.  Wins over `all` when provided. */
  statuses?: Set<string>;
  /** Read chat-binding.json per row (extra fs op per run). */
  includeBinding?: boolean;
};

/**
 * Project every run in `runsDir` to a row.  Most-recently-updated first.
 *
 * - ENOENT on `runsDir` → `[]` (nothing to list).
 * - Non-directory entries / unreadable / corrupt event logs → skipped.
 * - Filter precedence: explicit `statuses` (any) > `all` (terminal kept) >
 *   default (terminal hidden).
 */
export async function listRuns(
  runsDir: string,
  opts: ListRunsOptions = {},
): Promise<RunRow[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const wantStatuses = opts.statuses;
  const all = !!opts.all;

  const rows: RunRow[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    if (!isValidRunId(runId)) continue;

    const events = await readRunEventsPure(join(runsDir, runId));
    if (!events || events.length === 0) continue;

    let snap: Snapshot;
    try {
      snap = replay(events);
    } catch {
      continue;
    }
    const status = snap.run.status;
    if (wantStatuses) {
      if (!wantStatuses.has(status)) continue;
    } else if (!all && TERMINAL_RUN_STATUSES.has(status)) {
      continue;
    }

    const row = projectRunRow(runId, events, snap);
    if (opts.includeBinding) {
      const binding = await readChatBindingPure(join(runsDir, runId));
      if (binding) {
        row.chatId = binding.chatId;
        row.larkAppId = binding.larkAppId;
      }
    }
    rows.push(row);
  }

  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows;
}

export function projectRunRow(
  runId: string,
  events: WorkflowEvent[],
  snap: Snapshot,
): RunRow {
  // dAct = non-wait, non-effect dangling activities (worker-style bucket;
  // gates show up in dWait, effects in dEf).
  const effectSet = new Set(snap.danglingEffectAttempted);
  const waitSet = new Set(snap.danglingWaits);
  const dAct = snap.danglingActivities.filter(
    (a) => !effectSet.has(a) && !waitSet.has(a),
  ).length;

  const error = snap.run.status === 'failed' || snap.run.status === 'cancelled'
    ? findRunError(snap)
    : undefined;
  return {
    runId,
    workflowId: snap.run.workflowId ?? '?',
    status: snap.run.status,
    lastSeq: snap.lastSeq,
    dEf: snap.danglingEffectAttempted.length,
    dAct,
    dWait: snap.danglingWaits.length,
    updatedAt: events[events.length - 1]!.timestamp,
    failedNodeId: snap.run.failedNodeId,
    errorCode: error?.errorCode,
    errorClass: error?.errorClass,
    errorMessage: error?.errorMessage,
  };
}

function findRunError(snap: Snapshot): {
  errorCode: string;
  errorClass: string;
  errorMessage?: string;
} | undefined {
  const activities = [...snap.activities.values()];
  const preferredActivities = snap.run.failedNodeId
    ? activities.filter((activity) => activity.ownerNodeId === snap.run.failedNodeId)
    : [];
  const fallbackActivities = activities.filter((activity) => !preferredActivities.includes(activity));
  for (const activity of [...preferredActivities, ...fallbackActivities]) {
    for (const attempt of [...activity.attempts].reverse()) {
      if (attempt.error) return attempt.error;
    }
  }
  return undefined;
}

// ─── snapshot ──────────────────────────────────────────────────────────────

export type RunSnapshotDTO = {
  runId: string;
  run: RunState;
  lastSeq: number;
  nodes: NodeState[];
  activities: ActivityState[];
  /**
   * v0.2 loop blocks indexed by their nodeId.  Optional so v0.1 clients
   * that don't render iteration timelines stay forward-compatible — if
   * the field is absent, no loops are present; if it's an empty record,
   * the workflow used loop schema but no loop instance ran.  See
   * /tmp/wf-loop-v02.md §8 (dashboard) + §9 (progress card).
   */
  loops?: Record<string, LoopSnapshotDTO>;
  dangling: {
    activities: string[];
    effectAttempted: string[];
    waits: string[];
    cancels: string[];
  };
  outputs: Record<string, OutputRef>;
  attemptIO: Record<string, AttemptIODTO>;
  chatBinding?: { chatId: string; larkAppId: string };
  updatedAt: number;
};

export type LoopIterationDTO = {
  iteration: number;
  status: 'running' | 'approved' | 'rejected' | 'failed' | 'cancelled';
  bodyActivityIds: string[];
  decisionActivityId?: string;
  waitResolvedEventId?: string;
  decisionBy?: string;
  decisionComment?: string;
  timedOut?: boolean;
};

export type LoopSnapshotDTO = {
  loopId: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  iteration: number;
  maxIterations: number;
  iterations: LoopIterationDTO[];
  output?: OutputRef;
  errorCode?: string;
  errorClass?: string;
};

export type BlobPreviewDTO = {
  outputHash?: string;
  outputBytes?: number;
  contentType?: string;
  truncated?: boolean;
  value?: unknown;
  text?: string;
  error?: string;
  /** Set by `scrubSnapshotForUnauthed`: text/value were stripped because
   *  the caller wasn't authenticated.  Metadata (bytes, truncated) stays
   *  so the dashboard can render a "log available after login" placeholder
   *  instead of pretending the blob doesn't exist. */
  redacted?: boolean;
};

export type AttemptIODTO = {
  input?: BlobPreviewDTO;
  resolvedInput?: BlobPreviewDTO;
  output?: BlobPreviewDTO;
  log?: BlobPreviewDTO;
  terminal?: AttemptTerminalDTO;
  /** Full humanGate prompt when the producer spilled it to a blob via
   *  `promptRef`.  Read on demand via the same 64 KiB preview ladder as
   *  output / input blobs; cards never use this. */
  waitPrompt?: BlobPreviewDTO;
};

export type AttemptTerminalDTO = {
  sessionId: string;
  cliSessionId?: string;
  webPort: number;
  status: 'live' | 'closed';
  larkAppId?: string;
  botName?: string;
  cliId?: string;
  workingDir?: string;
  logPath?: string;
  startedAt: number;
  updatedAt: number;
  closedAt?: number;
  error?: string;
  /** True when a raw PTY byte log (`pty.log`) exists alongside the sidecar.
   *  Drives the replay viewer's "terminal cinema" vs "diagnostic log"
   *  toggle.  Older attempts predate this file and project as `false`. */
  hasPtyLog?: boolean;
};

const BLOB_PREVIEW_MAX_BYTES = 64 * 1024;

/**
 * Scrub fields that leak raw CLI process bytes from a snapshot DTO before
 * exposing it to an unauthenticated reader.  Companion of the
 * `…/terminal-log/raw` cookie-auth carve-out: that carve-out hid the full
 * pty/terminal stream download, but the same data still leaked via
 * `attemptIO[*].log.text` (last 64 KiB tail of `terminal.log`) on the
 * public `/snapshot` endpoint.
 *
 * What stays public: run/node/activity status, output blob previews
 * (workflow author's intended product), terminal sidecar metadata.
 * What gets scrubbed: `io.log.text/value` (the raw stdout/stderr tail
 * — may contain env-var dumps, API key error messages, secret-bearing
 * curl responses) and `io.terminal.logPath` (absolute on-disk path
 * leaks filesystem layout).
 *
 * Idempotent + pure: caller is the route handler that already knows
 * `authed === false`.  Returns a new DTO; input is not mutated.
 */
export function scrubSnapshotForUnauthed(snap: RunSnapshotDTO): RunSnapshotDTO {
  const attemptIO: Record<string, AttemptIODTO> = {};
  for (const [attemptId, io] of Object.entries(snap.attemptIO)) {
    const scrubbed: AttemptIODTO = { ...io };
    if (io.log) {
      const { text: _text, value: _value, ...logRest } = io.log;
      scrubbed.log = { ...logRest, redacted: true } as BlobPreviewDTO;
    }
    if (io.terminal && io.terminal.logPath !== undefined) {
      const { logPath: _logPath, ...termRest } = io.terminal;
      scrubbed.terminal = termRest;
    }
    attemptIO[attemptId] = scrubbed;
  }
  return { ...snap, attemptIO };
}

/**
 * Build a JSON-serializable snapshot for a single run.  Returns null when
 * the run is missing / has no events / has a corrupt log.  Callers
 * (dashboard `/snapshot` endpoint) should map null → 404.
 *
 * Always returns the full DTO including sensitive log bytes.  Callers
 * serving unauth'd HTTP requests MUST apply `scrubSnapshotForUnauthed`
 * before responding — kept as a separate step so internal callers
 * (cancel-run, daemon-side hooks) keep the full view without
 * round-tripping through scrub.
 */
export async function readRunSnapshot(
  runsDir: string,
  runId: string,
): Promise<RunSnapshotDTO | null> {
  if (!isValidRunId(runId)) return null;
  const runDir = join(runsDir, runId);
  const events = await readRunEventsPure(runDir);
  if (!events || events.length === 0) return null;
  let snap: Snapshot;
  try {
    snap = replay(events);
  } catch {
    return null;
  }
  const binding = await readChatBindingPure(runDir);
  const outputs: Record<string, OutputRef> = {};
  for (const [aid, ref] of snap.outputs) outputs[aid] = ref;
  const def = await readWorkflowDefinitionPure(runDir);
  const attemptIO = await buildAttemptIO(runDir, snap, def);
  return {
    runId,
    run: snap.run,
    lastSeq: snap.lastSeq,
    nodes: [...snap.nodes.values()],
    activities: [...snap.activities.values()],
    loops: projectLoops(snap),
    dangling: {
      activities: snap.danglingActivities,
      effectAttempted: snap.danglingEffectAttempted,
      waits: snap.danglingWaits,
      cancels: snap.danglingCancels,
    },
    outputs,
    attemptIO,
    chatBinding: binding ?? undefined,
    updatedAt: events[events.length - 1]!.timestamp,
  };
}

/**
 * Project the replay's in-memory `snapshot.loops` Map into the
 * JSON-serializable DTO surface.  Returns `undefined` when no loops
 * exist so v0.1 clients deserializing the snapshot see no `loops`
 * key at all (forward-compat for older dashboards).
 */
function projectLoops(snap: Snapshot): Record<string, LoopSnapshotDTO> | undefined {
  if (!snap.loops || snap.loops.size === 0) return undefined;
  const out: Record<string, LoopSnapshotDTO> = {};
  for (const [loopId, state] of snap.loops) {
    out[loopId] = {
      loopId,
      status: state.status,
      iteration: state.iteration,
      maxIterations: state.maxIterations,
      iterations: state.iterations.map((it) => ({
        iteration: it.iteration,
        status: it.status,
        bodyActivityIds: [...it.bodyActivityIds],
        decisionActivityId: it.decisionActivityId,
        waitResolvedEventId: it.waitResolvedEventId,
        decisionBy: it.decisionBy,
        decisionComment: it.decisionComment,
        timedOut: it.timedOut,
      })),
      output: state.output,
      errorCode: state.errorCode,
      errorClass: state.errorClass,
    };
  }
  return out;
}

async function buildAttemptIO(
  runDir: string,
  snap: Snapshot,
  def: WorkflowDefinition | null,
): Promise<Record<string, AttemptIODTO>> {
  const out: Record<string, AttemptIODTO> = {};
  const cache = new Map<string, BlobPreviewDTO>();
  for (const activity of snap.activities.values()) {
    for (const attempt of activity.attempts) {
      const io: AttemptIODTO = {};
      io.input = await previewRef(runDir, attempt.inputRef, cache);
      if (attempt.output) {
        io.output = await previewRef(runDir, attempt.output, cache);
      }
      io.log = await previewAttemptLog(runDir, activity.activityId, attempt.attemptId);
      io.terminal = await readAttemptTerminal(runDir, activity.activityId, attempt.attemptId);
      if (io.input?.value !== undefined && def) {
        io.resolvedInput = await previewResolvedInput(runDir, snap, def, io.input.value, cache);
      }
      if (attempt.wait?.promptRef) {
        io.waitPrompt = await previewRef(runDir, attempt.wait.promptRef, cache);
      }
      out[attempt.attemptId] = io;
    }
  }
  return out;
}

async function readAttemptTerminal(
  runDir: string,
  activityId: string,
  attemptId: string,
): Promise<AttemptTerminalDTO | undefined> {
  const path = attemptTerminalSidecarPath(runDir, activityId, attemptId);
  if (!isPathInside(runDir, path)) {
    return { sessionId: '', webPort: 0, status: 'closed', startedAt: 0, updatedAt: 0, error: 'terminal sidecar is outside run directory' };
  }
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AttemptTerminalSidecar>;
    // Schema bumps need an explicit migration story; reject unknown shapes for now.
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.webPort !== 'number' ||
      (parsed.status !== 'live' && parsed.status !== 'closed') ||
      typeof parsed.startedAt !== 'number' ||
      typeof parsed.updatedAt !== 'number'
    ) {
      return { sessionId: '', webPort: 0, status: 'closed', startedAt: 0, updatedAt: 0, error: 'invalid terminal sidecar' };
    }
    const ptyLog = join(dirname(path), 'pty.log');
    let hasPtyLog = false;
    try {
      const st = await fs.stat(ptyLog);
      hasPtyLog = st.isFile() && st.size > 0;
    } catch { /* ENOENT or other — treat as absent */ }
    return {
      sessionId: parsed.sessionId,
      cliSessionId: typeof parsed.cliSessionId === 'string' ? parsed.cliSessionId : undefined,
      webPort: parsed.webPort,
      status: parsed.status,
      larkAppId: parsed.larkAppId,
      botName: parsed.botName,
      cliId: parsed.cliId,
      workingDir: parsed.workingDir,
      logPath: parsed.logPath,
      startedAt: parsed.startedAt,
      updatedAt: parsed.updatedAt,
      closedAt: parsed.closedAt,
      hasPtyLog,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return {
      sessionId: '',
      webPort: 0,
      status: 'closed',
      startedAt: 0,
      updatedAt: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function previewAttemptLog(
  runDir: string,
  activityId: string,
  attemptId: string,
): Promise<BlobPreviewDTO | undefined> {
  const logPath = join(runDir, 'attempts', activityId, attemptId, 'terminal.log');
  if (!isPathInside(runDir, logPath)) {
    return { contentType: 'text/plain', error: 'attempt log is outside run directory' };
  }
  try {
    const handle = await fs.open(logPath, 'r');
    try {
      const stat = await handle.stat();
      const bytesToRead = Math.min(stat.size, BLOB_PREVIEW_MAX_BYTES);
      const start = Math.max(0, stat.size - bytesToRead);
      const buf = Buffer.alloc(bytesToRead);
      await handle.read(buf, 0, bytesToRead, start);
      return {
        contentType: 'text/plain',
        outputBytes: stat.size,
        truncated: stat.size > BLOB_PREVIEW_MAX_BYTES,
        text: buf.toString('utf-8'),
      };
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return {
      contentType: 'text/plain',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function previewRef(
  runDir: string,
  ref: OutputRef,
  cache: Map<string, BlobPreviewDTO>,
): Promise<BlobPreviewDTO> {
  const key = ref.outputHash;
  const cached = cache.get(key);
  if (cached) return cached;

  const base: BlobPreviewDTO = {
    outputHash: ref.outputHash,
    outputBytes: ref.outputBytes,
    contentType: ref.contentType,
  };
  if (!ref.outputPath) {
    const res = { ...base, error: 'outputRef has no outputPath' };
    cache.set(key, res);
    return res;
  }
  if (!isPathInside(runDir, ref.outputPath)) {
    const res = { ...base, error: 'outputPath is outside run directory' };
    cache.set(key, res);
    return res;
  }

  try {
    const handle = await fs.open(ref.outputPath, 'r');
    try {
      const stat = await handle.stat();
      const bytesToRead = Math.min(stat.size, BLOB_PREVIEW_MAX_BYTES);
      const buf = Buffer.alloc(bytesToRead);
      await handle.read(buf, 0, bytesToRead, 0);
      const text = buf.toString('utf-8');
      const truncated = stat.size > BLOB_PREVIEW_MAX_BYTES;
      const res: BlobPreviewDTO = {
        ...base,
        outputBytes: stat.size,
        truncated,
      };
      if (!truncated && isJsonContent(ref.contentType)) {
        try {
          res.value = JSON.parse(text);
        } catch (err) {
          res.text = text;
          res.error = `invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        res.text = text;
      }
      cache.set(key, res);
      return res;
    } finally {
      await handle.close();
    }
  } catch (err) {
    const res = {
      ...base,
      error: err instanceof Error ? err.message : String(err),
    };
    cache.set(key, res);
    return res;
  }
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !rel.startsWith(sep));
}

function isJsonContent(contentType?: string): boolean {
  return (contentType ?? '').toLowerCase().includes('json');
}

async function readWorkflowDefinitionPure(runDir: string): Promise<WorkflowDefinition | null> {
  try {
    const raw = await fs.readFile(join(runDir, 'workflow.json'), 'utf-8');
    return parseWorkflowDefinition(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function previewResolvedInput(
  runDir: string,
  snap: Snapshot,
  def: WorkflowDefinition,
  rawInput: unknown,
  cache: Map<string, BlobPreviewDTO>,
): Promise<BlobPreviewDTO> {
  try {
    const value = await resolveDashboardBindings(rawInput, { runDir, snap, def, cache });
    return {
      contentType: 'application/json',
      value,
      outputBytes: Buffer.byteLength(JSON.stringify(value), 'utf-8'),
    };
  } catch (err) {
    return {
      contentType: 'application/json',
      value: rawInput,
      error: `failed to resolve bindings: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

type DashboardBindingContext = {
  runDir: string;
  snap: Snapshot;
  def: WorkflowDefinition;
  cache: Map<string, BlobPreviewDTO>;
};

async function resolveDashboardBindings(
  value: unknown,
  ctx: DashboardBindingContext,
): Promise<unknown> {
  if (isRefSpec(value)) return resolveDashboardRef(value.$ref, ctx);
  if (typeof value === 'string') return interpolateDashboardStringRefs(value, ctx);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(await resolveDashboardBindings(item, ctx));
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = await resolveDashboardBindings(item, ctx);
    }
    return out;
  }
  return value;
}

async function interpolateDashboardStringRefs(
  value: string,
  ctx: DashboardBindingContext,
): Promise<string> {
  if (!value.includes('${')) return value;
  let out = '';
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf('${', cursor);
    if (start < 0) {
      out += value.slice(cursor);
      break;
    }
    out += value.slice(cursor, start);
    const end = value.indexOf('}', start + 2);
    if (end < 0) throw new Error(`unterminated string ref interpolation in '${value}'`);
    const ref = value.slice(start + 2, end);
    if (!ref) throw new Error(`empty string ref interpolation in '${value}'`);
    out += stringifyDashboardInterpolatedValue(ref, await resolveDashboardRef(ref, ctx));
    cursor = end + 1;
  }
  return out;
}

function stringifyDashboardInterpolatedValue(ref: string, value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return value as string;
  if (t === 'number' || t === 'boolean') return String(value);
  throw new Error(
    `string interpolation '\${${ref}}' resolved to ${Array.isArray(value) ? 'array' : t} ` +
    `(expected string/number/boolean/null; use whole-field $ref for structured values)`,
  );
}

function isRefSpec(value: unknown): value is { $ref: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length === 1 && entries[0]?.[0] === '$ref' && typeof entries[0]?.[1] === 'string';
}

async function resolveDashboardRef(ref: string, ctx: DashboardBindingContext): Promise<unknown> {
  if (ref.startsWith('params.')) {
    const inputRef = ctx.snap.run.input;
    if (!inputRef) throw new Error(`$ref '${ref}' requires run input`);
    const params = (await previewRef(ctx.runDir, inputRef, ctx.cache)).value;
    return walkPreviewPath(params, ref.slice('params.'.length).split('.'), ref);
  }

  const sepIdx = ref.indexOf('.output.');
  if (sepIdx < 0) {
    throw new Error(`$ref '${ref}' missing '.output.' separator`);
  }
  const nodeId = ref.slice(0, sepIdx);
  const path = ref.slice(sepIdx + '.output.'.length).split('.');
  const node = ctx.def.nodes[nodeId];
  if (!node) throw new Error(`$ref '${ref}' targets unknown node '${nodeId}'`);
  const outputRef = ctx.snap.outputs.get(workActivityId(ctx.snap.run.runId, nodeId));
  if (!outputRef) throw new Error(`$ref '${ref}' has no successful output yet`);
  const preview = await previewRef(ctx.runDir, outputRef, ctx.cache);
  if (preview.value === undefined) {
    throw new Error(preview.error ?? `$ref '${ref}' output preview has no JSON value`);
  }
  const root =
    node.type === 'hostExecutor' &&
    preview.value !== null &&
    typeof preview.value === 'object' &&
    Object.prototype.hasOwnProperty.call(preview.value, 'output')
      ? (preview.value as { output?: unknown }).output
      : preview.value;
  return walkPreviewPath(root, path, ref);
}

function walkPreviewPath(value: unknown, segments: string[], ref: string): unknown {
  let cursor = value;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined) {
      throw new Error(`$ref '${ref}' hit ${cursor === null ? 'null' : 'undefined'} at '${seg}'`);
    }
    if (Array.isArray(cursor)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) {
        throw new Error(`$ref '${ref}' array index '${seg}' out of bounds`);
      }
      cursor = cursor[idx];
      continue;
    }
    if (typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, seg)) {
      throw new Error(`$ref '${ref}' segment '${seg}' not found`);
    }
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

// ─── event window ──────────────────────────────────────────────────────────

export type EventWindowOptions = {
  /** Initial fetch: last N events.  Ignored if before/afterSeq is set. */
  tail?: number;
  /** Cursor: events with seq < beforeSeq, returned in seq-asc order. */
  beforeSeq?: number;
  /** Cursor: events with seq > afterSeq, returned in seq-asc order. */
  afterSeq?: number;
  /** Page size for before/afterSeq.  Default 200, max 1000. */
  limit?: number;
};

export type EventWindow = {
  events: WorkflowEvent[];
  oldestSeq: number | null;
  newestSeq: number | null;
  totalCount: number;
  hasOlder: boolean;
  hasNewer: boolean;
};

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const DEFAULT_TAIL = 100;

/**
 * Slice a run's event log into a paginated window.
 *
 * Mode precedence: `afterSeq` > `beforeSeq` > `tail` (default).  This
 * matches the dashboard usage: detail page first loads `?tail=100`,
 * then polls `?afterSeq=<newest>` and back-scrolls `?beforeSeq=<oldest>`.
 *
 * Pagination bookkeeping (`hasOlder` / `hasNewer`) is computed from the
 * full event list and the returned slice's bounds.  Returns null if the
 * runId is invalid or the run is missing.
 */
export async function readEventWindow(
  runsDir: string,
  runId: string,
  opts: EventWindowOptions = {},
): Promise<EventWindow | null> {
  if (!isValidRunId(runId)) return null;
  const events = await readRunEventsPure(join(runsDir, runId));
  if (!events) return null;
  const total = events.length;
  if (total === 0) {
    return {
      events: [],
      oldestSeq: null,
      newestSeq: null,
      totalCount: 0,
      hasOlder: false,
      hasNewer: false,
    };
  }

  const limit = clampLimit(opts.limit);

  if (opts.afterSeq !== undefined && Number.isFinite(opts.afterSeq)) {
    const after = opts.afterSeq;
    const idx = events.findIndex((e) => eventSeqFromId(e.eventId) > after);
    if (idx < 0) {
      return {
        events: [],
        oldestSeq: null,
        newestSeq: null,
        totalCount: total,
        hasOlder: true,
        hasNewer: false,
      };
    }
    const slice = events.slice(idx, idx + limit);
    return {
      events: slice,
      oldestSeq: eventSeqFromId(slice[0]!.eventId),
      newestSeq: eventSeqFromId(slice[slice.length - 1]!.eventId),
      totalCount: total,
      hasOlder: idx > 0,
      hasNewer: idx + slice.length < total,
    };
  }

  if (opts.beforeSeq !== undefined && Number.isFinite(opts.beforeSeq)) {
    const before = opts.beforeSeq;
    const endIdx = events.findIndex((e) => eventSeqFromId(e.eventId) >= before);
    const exclusiveEnd = endIdx < 0 ? total : endIdx;
    const startIdx = Math.max(0, exclusiveEnd - limit);
    const slice = events.slice(startIdx, exclusiveEnd);
    if (slice.length === 0) {
      return {
        events: [],
        oldestSeq: null,
        newestSeq: null,
        totalCount: total,
        hasOlder: false,
        hasNewer: true,
      };
    }
    return {
      events: slice,
      oldestSeq: eventSeqFromId(slice[0]!.eventId),
      newestSeq: eventSeqFromId(slice[slice.length - 1]!.eventId),
      totalCount: total,
      hasOlder: startIdx > 0,
      hasNewer: exclusiveEnd < total,
    };
  }

  const tail =
    opts.tail !== undefined && Number.isFinite(opts.tail) && opts.tail > 0
      ? Math.min(Math.floor(opts.tail), MAX_LIMIT)
      : DEFAULT_TAIL;
  const startIdx = Math.max(0, total - tail);
  const slice = events.slice(startIdx);
  return {
    events: slice,
    oldestSeq: eventSeqFromId(slice[0]!.eventId),
    newestSeq: eventSeqFromId(slice[slice.length - 1]!.eventId),
    totalCount: total,
    hasOlder: startIdx > 0,
    hasNewer: false,
  };
}

function clampLimit(raw?: number): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(raw), MAX_LIMIT);
}

// ─── pure readers (no mkdir side effects) ──────────────────────────────────

async function readRunEventsPure(runDir: string): Promise<WorkflowEvent[] | null> {
  const file = join(runDir, 'events.ndjson');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const events: WorkflowEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return null;
    }
    try {
      events.push(parseEvent(obj));
    } catch {
      return null;
    }
  }
  return events;
}

async function readChatBindingPure(
  runDir: string,
): Promise<{ chatId: string; larkAppId: string } | null> {
  try {
    const raw = await fs.readFile(join(runDir, 'chat-binding.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<{ chatId: string; larkAppId: string }>;
    if (!parsed.chatId || !parsed.larkAppId) return null;
    return { chatId: parsed.chatId, larkAppId: parsed.larkAppId };
  } catch {
    return null;
  }
}

// ─── event helpers ─────────────────────────────────────────────────────────

/**
 * Extract `<seq>` from a WorkflowEvent `eventId` of the form
 * `<runId>-<seq>` (events doc v0.1.2 §3.1).  Returns 0 for malformed
 * ids; callers should treat that as "unknown" rather than position 0.
 */
export function eventSeqFromId(eventId: string): number {
  const dash = eventId.lastIndexOf('-');
  if (dash < 0) return 0;
  const n = Number(eventId.slice(dash + 1));
  return Number.isFinite(n) ? n : 0;
}

export function extractEventContext(
  payload: unknown,
): { nodeId?: string; activityId?: string; errorCode?: string } {
  if (!payload || typeof payload !== 'object' || 'ref' in (payload as object)) {
    return {};
  }
  const p = payload as Record<string, unknown>;
  const out: { nodeId?: string; activityId?: string; errorCode?: string } = {};
  if (typeof p.nodeId === 'string') out.nodeId = p.nodeId;
  if (typeof p.activityId === 'string') out.activityId = p.activityId;
  if (typeof p.failedNodeId === 'string') out.nodeId = p.failedNodeId;
  const err = p.error;
  if (err && typeof err === 'object' && 'errorCode' in err) {
    out.errorCode = String((err as { errorCode: unknown }).errorCode);
  }
  return out;
}
