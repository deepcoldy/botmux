/**
 * Dashboard workflow drafts — the on-disk record (design 2026-11-03
 * workflow-dashboard-orchestration §2 草稿, §4.2–4.4, §4.6, D2).
 *
 * A draft is an ordinary grill run without a chat binding: a v3 run dir under
 * `~/.botmux/v3-runs/<runId>` with `grill.state.json` (the existing state
 * machine, unchanged) and no `run.json`. Everything the grill state cannot
 * hold lives beside it in `draft.json`:
 *
 *   - the orchestrating bot and the initiator (who alone may write, I6);
 *   - the clarify session (a headless session of the orchestrating bot) and
 *     its turns;
 *   - the Architect background task;
 *   - the two confirmations, each pinned to content digests so any later
 *     change of the flow definition voids them (E5, §4.4);
 *   - abandon / delete marks.
 *
 * Writes are read-modify-write under `draft.json.lock` with a monotonically
 * increasing `version` (callers may CAS on it). Lock order, fixed:
 *
 *   draft.json.lock -> grill.state.json.lock -> run.json.lock
 *
 * The draft lock is never held across an await, and nothing that holds the
 * grill lock takes the draft lock.
 *
 * Pure fs: the Dashboard reads the list from disk with this module; the
 * orchestrating bot's daemon is the only writer (draft-service.ts).
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';

import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { FileLockTimeoutError, withFileLockSync } from '../../utils/file-lock.js';
import { readGrillState, type GrillState, type GrillStatus } from './grill-state.js';
import { V3_RUN_ENVELOPE_FILE } from './run-envelope.js';
import { V3FlowSummarySchema } from './flow-summary.js';
import { isValidRunId } from './ops-projection.js';

export const WORKFLOW_DRAFT_FILE = 'draft.json';
export const WORKFLOW_DRAFT_SCHEMA_VERSION = 1 as const;
/** §4.6: a draft without activity for this long is greyed out and deletable. */
export const WORKFLOW_DRAFT_STALE_MS = 30 * 24 * 60 * 60_000;
/** Turns kept in draft.json (the oldest drop first). */
export const WORKFLOW_DRAFT_MAX_TURNS = 200;
/** One turn's text is cut here; a spec candidate has its own field. */
export const WORKFLOW_DRAFT_MAX_TURN_CHARS = 64_000;
/** Clarify sessions whose close failed, kept for the sweep to retry. */
export const WORKFLOW_DRAFT_MAX_ORPHANS = 20;

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const iso = z.string().min(1).max(64);
const sha = z.string().regex(SHA256_RE);
const openId = z.string().regex(/^ou_[A-Za-z0-9_-]{1,128}$/);

const initiatorSchema = z.object({
  openId,
  unionId: z.string().min(1).max(128).optional(),
  source: z.enum(['dashboard-local', 'dashboard-platform']),
}).strict();

const questionSchema = z.object({
  question: z.string().min(1).max(4000),
  options: z.array(z.string().min(1).max(1000)).max(20),
  recommended: z.string().min(1).max(1000).optional(),
}).strict();

const turnSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string().max(WORKFLOW_DRAFT_MAX_TURN_CHARS + 16),
  at: iso,
  triggerId: z.string().min(1).max(256).optional(),
  question: questionSchema.optional(),
  hasSpec: z.literal(true).optional(),
}).strict();

const reservationHolderSchema = z.object({
  pid: z.number().int().min(1),
  procStart: z.string().min(1).max(256).optional(),
  bootId: z.string().min(1).max(256).optional(),
  instance: z.string().min(1).max(64),
}).strict();

export type WorkflowDraftReservationHolder = z.infer<typeof reservationHolderSchema>;

const clarifySchema = z.object({
  headlessId: z.string().min(1).max(256).optional(),
  sessionId: z.string().min(1).max(256).optional(),
  /** active: process may be live; suspended: idle-closed process, record kept
   *  (the next message resumes by CLI session id); disconnected: cannot be
   *  resumed — 「继续」 starts a new one; closed: abandoned/deleted. */
  state: z.enum(['active', 'suspended', 'disconnected', 'closed']),
  pending: z.object({
    triggerId: z.string().min(1).max(256),
    sentAt: iso,
    /** For a reservation: the process (and service instance) holding it, so
     *  another process only drops it once that holder is gone. */
    holder: reservationHolderSchema.optional(),
  }).strict().optional(),
  /** Last activity: a message sent or a reply landed (idle clock, §4.2). */
  lastMessageAt: iso.optional(),
  suspendedAt: iso.optional(),
  /** The process could not be released (non-suspendable backend); not
   *  retried until the next message. */
  suspendRefusedAt: iso.optional(),
  error: z.string().max(2000).optional(),
  turns: z.array(turnSchema).max(WORKFLOW_DRAFT_MAX_TURNS),
  /** The latest spec the model wrote (spec.md format), not yet finalized. */
  specCandidate: z.object({
    triggerId: z.string().min(1).max(256).optional(),
    markdown: z.string().min(1).max(256_000),
    at: iso,
  }).strict().optional(),
}).strict();

const architectSchema = z.object({
  state: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']),
  attempt: z.number().int().min(1),
  startedAt: iso,
  finishedAt: iso.optional(),
  /** 「重新编排」's extra instruction for this attempt. */
  note: z.string().min(1).max(4000).optional(),
  problems: z.array(z.string().max(4000)).max(200).optional(),
}).strict();

const specConfirmationSchema = z.object({
  confirmedByOpenId: openId,
  confirmedAt: iso,
  specSha256: sha,
}).strict();

const flowConfirmationSchema = z.object({
  confirmedByOpenId: openId,
  confirmedAt: iso,
  flowSummary: V3FlowSummarySchema,
  flowSummarySha256: sha,
  /** The summary omits topology, goal texts, inputs and host content; the
   *  dag / spec digests and the draft's flow revision are compared as well. */
  dagSha256: sha,
  specSha256: sha,
  flowRevision: z.number().int().min(0),
}).strict();

const nodeOverrideSchema = z.object({
  larkAppId: z.string().min(1).max(128),
  /** The Architect's choice this override replaced. */
  previousLarkAppId: z.string().min(1).max(128).optional(),
  at: iso,
}).strict();

export const WorkflowDraftRecordSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_DRAFT_SCHEMA_VERSION),
  runId: z.string().min(1).max(256),
  orchestratorAppId: z.string().min(1).max(128),
  initiator: initiatorSchema,
  goal: z.string().min(1).max(8000),
  createdAt: iso,
  updatedAt: iso,
  version: z.number().int().min(1),
  clarify: clarifySchema,
  architect: architectSchema.optional(),
  /** Bumped by every write that changes the DAG or the spec; a second
   *  confirmation holds for the revision it was given at only. */
  flowRevision: z.number().int().min(0).optional(),
  /** Per goal node: the executing bot a person chose on the page. */
  nodeBots: z.record(z.string().min(1).max(512), nodeOverrideSchema).optional(),
  specConfirmation: specConfirmationSchema.optional(),
  flowConfirmation: flowConfirmationSchema.optional(),
  abandonedAt: iso.optional(),
  deletedAt: iso.optional(),
  orphanSessions: z.array(z.object({
    sessionId: z.string().min(1).max(256),
    headlessId: z.string().min(1).max(256).optional(),
  }).strict()).max(WORKFLOW_DRAFT_MAX_ORPHANS).optional(),
}).strict();

export type WorkflowDraftRecord = z.infer<typeof WorkflowDraftRecordSchema>;
export type WorkflowDraftInitiator = z.infer<typeof initiatorSchema>;
export type WorkflowDraftTurn = z.infer<typeof turnSchema>;
export type WorkflowDraftQuestion = z.infer<typeof questionSchema>;
export type WorkflowDraftArchitect = z.infer<typeof architectSchema>;
export type WorkflowDraftFlowConfirmation = z.infer<typeof flowConfirmationSchema>;

export class WorkflowDraftBusyError extends Error {
  constructor(runId: string) {
    super(`草稿 ${runId} 正在被另一个操作修改，请稍后重试`);
    this.name = 'WorkflowDraftBusyError';
  }
}

const DRAFT_LOCK_WAIT_MS = 2_000;

function draftPath(runDir: string): string {
  return join(runDir, WORKFLOW_DRAFT_FILE);
}

/** draft.json, or undefined when missing / unreadable / not this schema. */
export function readWorkflowDraft(runDir: string): WorkflowDraftRecord | undefined {
  let raw: string;
  try {
    if (!lstatSync(draftPath(runDir)).isFile()) return undefined;
    raw = readFileSync(draftPath(runDir), 'utf-8');
  } catch {
    return undefined;
  }
  try {
    const parsed = WorkflowDraftRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Validate then write atomically (0600). Throws on a malformed record. */
export function writeWorkflowDraft(runDir: string, record: WorkflowDraftRecord): void {
  const checked = WorkflowDraftRecordSchema.parse(record);
  atomicWriteFileSync(draftPath(runDir), `${JSON.stringify(checked, null, 2)}\n`, { mode: 0o600 });
}

/** The run-scoped draft lock (sync: never hold it across an await). */
export function withWorkflowDraftLock<T>(runDir: string, runId: string, fn: () => T): T {
  try {
    return withFileLockSync(draftPath(runDir), fn, { maxWaitMs: DRAFT_LOCK_WAIT_MS });
  } catch (err) {
    if (err instanceof FileLockTimeoutError) throw new WorkflowDraftBusyError(runId);
    throw err;
  }
}

/** `sha256:<hex>` of a file's bytes, or undefined when it cannot be read. */
export function fileSha256(path: string | undefined): `sha256:${string}` | undefined {
  if (!path) return undefined;
  try {
    return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  } catch {
    return undefined;
  }
}

/** The run dir of `runId` under `baseDir`, or undefined for anything that
 *  is not a plain run id inside it. */
export function workflowDraftRunDir(baseDir: string, runId: string): string | undefined {
  if (!isValidRunId(runId)) return undefined;
  const root = resolve(baseDir);
  const dir = resolve(root, runId);
  if (dir === root || !dir.startsWith(root + sep)) return undefined;
  return dir;
}

/** A Dashboard draft: draft.json + grill.state.json, and no run.json yet
 *  (once run.json exists it is a run, shown by /api/v3/runs). */
export function isWorkflowDraftDir(runDir: string): boolean {
  if (existsSync(join(runDir, V3_RUN_ENVELOPE_FILE))) return false;
  return existsSync(draftPath(runDir)) && existsSync(join(runDir, 'grill.state.json'));
}

/**
 * What a draft is doing, for the list and the page (§4.6):
 *   clarifying 澄清中 · spec_ready 待确认需求 · awaiting_architect 待编排 ·
 *   architect_running 编排中 · dag_ready 待确认流程 · flow_confirmed 已确认流程 ·
 *   abandoned 已放弃. (拉群中 arrives with D4.)
 *
 * `flowConfirmationValid` is the caller's verdict on the recorded second
 * confirmation (digests still match); without it a recorded one counts.
 */
export type WorkflowDraftPhase =
  | 'clarifying'
  | 'spec_ready'
  | 'awaiting_architect'
  | 'architect_running'
  | 'dag_ready'
  | 'flow_confirmed'
  | 'abandoned'
  | 'committed';

export function workflowDraftPhase(
  grill: Pick<GrillState, 'status'>,
  draft: Pick<WorkflowDraftRecord, 'abandonedAt' | 'architect' | 'flowConfirmation'>,
  flowConfirmationValid?: boolean,
): WorkflowDraftPhase {
  if (draft.abandonedAt) return 'abandoned';
  if (draft.architect?.state === 'running' || grill.status === 'architect_running') return 'architect_running';
  const byStatus: Record<GrillStatus, WorkflowDraftPhase> = {
    grilling: 'clarifying',
    spec_ready: 'spec_ready',
    spec_approved: 'awaiting_architect',
    architect_running: 'architect_running',
    dag_ready: 'dag_ready',
    dag_approved: 'committed',
  };
  const phase = byStatus[grill.status];
  if (phase === 'dag_ready' && draft.flowConfirmation && flowConfirmationValid !== false) return 'flow_confirmed';
  return phase;
}

export interface WorkflowDraftSummary {
  runId: string;
  title: string;
  goal: string;
  orchestratorAppId: string;
  initiator: WorkflowDraftInitiator;
  phase: WorkflowDraftPhase;
  grillStatus: GrillStatus;
  createdAt: string;
  updatedAt: string;
  /** §4.6: 30 days without activity — greyed out, deletable. */
  stale: boolean;
}

function specTitle(grill: GrillState): string | undefined {
  try {
    const spec = JSON.parse(readFileSync(grill.specJsonPath, 'utf-8')) as { title?: unknown };
    return typeof spec.title === 'string' && spec.title.trim() ? spec.title.trim().slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}

/** The second confirmation still matches the dag and spec bytes on disk (the
 *  flow summary itself needs bots.json, so only the daemon compares it). */
export function flowConfirmationMatchesFiles(grill: GrillState, draft: WorkflowDraftRecord): boolean {
  const confirmation = draft.flowConfirmation;
  if (!confirmation) return false;
  return confirmation.flowRevision === (draft.flowRevision ?? 0)
    && fileSha256(grill.dagPath) === confirmation.dagSha256
    && fileSha256(grill.specJsonPath) === confirmation.specSha256;
}

export function summarizeWorkflowDraft(runDir: string, now: Date = new Date()): WorkflowDraftSummary | undefined {
  if (!isWorkflowDraftDir(runDir)) return undefined;
  const draft = readWorkflowDraft(runDir);
  const grill = readGrillState(runDir);
  if (!draft || !grill || draft.deletedAt || grill.runId !== draft.runId || grill.chatBinding) return undefined;
  const updatedAt = draft.updatedAt > grill.updatedAt ? draft.updatedAt : grill.updatedAt;
  return {
    runId: draft.runId,
    title: specTitle(grill) ?? draft.goal.replace(/\s+/g, ' ').trim().slice(0, 200),
    goal: draft.goal,
    orchestratorAppId: draft.orchestratorAppId,
    initiator: draft.initiator,
    phase: workflowDraftPhase(grill, draft, flowConfirmationMatchesFiles(grill, draft)),
    grillStatus: grill.status,
    createdAt: draft.createdAt,
    updatedAt,
    stale: now.getTime() - Date.parse(updatedAt) >= WORKFLOW_DRAFT_STALE_MS,
  };
}

/** Run dirs under `baseDir` that are drafts (any bot, any state). */
export function listWorkflowDraftDirs(baseDir: string): Array<{ runId: string; runDir: string }> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && isValidRunId(entry.name) && isWorkflowDraftDir(join(baseDir, entry.name)))
    .map((entry) => ({ runId: entry.name, runDir: join(baseDir, entry.name) }));
}

/** Every draft under `baseDir` (newest activity first). */
export function listWorkflowDrafts(baseDir: string, now: Date = new Date()): WorkflowDraftSummary[] {
  if (!existsSync(baseDir)) return [];
  const out: WorkflowDraftSummary[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
    const summary = summarizeWorkflowDraft(join(baseDir, entry.name), now);
    if (summary && summary.runId === entry.name) out.push(summary);
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** The orchestrating bot of a draft, for routing (the Dashboard proxy). */
export function workflowDraftOwner(baseDir: string, runId: string): string | undefined {
  const runDir = workflowDraftRunDir(baseDir, runId);
  if (!runDir || !isWorkflowDraftDir(runDir)) return undefined;
  const draft = readWorkflowDraft(runDir);
  // A marked-deleted draft still routes, so a repeated delete can finish it.
  return draft && draft.runId === runId ? draft.orchestratorAppId : undefined;
}
