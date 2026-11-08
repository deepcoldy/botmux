/**
 * Receiving side of a bot-executed workflow node (design 2026-11-03 §4.2,
 * §5.5, §7.1): pure helpers the executing bot's daemon uses once an inbound
 * handoff matched a host-signed binding, plus the acceptance query the main
 * bot's daemon runs against the receiver's session store.
 */

import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { GoalInputs } from '../workflows/v3/contract.js';
import type { WorkflowHandoffBindingPayload } from './workflow-handoff-binding.js';
import type { LarkAttachment, WorkflowNodeSessionMarker } from '../types.js';

export function workflowNodeMarkerFromBinding(
  binding: WorkflowHandoffBindingPayload,
  handoffMessageId: string,
  registeredAt: Date = new Date(),
): WorkflowNodeSessionMarker {
  return {
    runId: binding.workflow.runId,
    nodeId: binding.workflow.nodeId,
    ...(binding.workflow.instanceId ? { instanceId: binding.workflow.instanceId } : {}),
    attemptId: binding.workflow.attemptId,
    handoffMessageId,
    nonce: binding.nonce,
    publishRoot: binding.publishRoot,
    orchestratorAppId: binding.sourceLarkAppId,
    registeredAt: registeredAt.toISOString(),
    ...(binding.placement === 'main' ? { placement: 'main' as const } : {}),
  };
}

/**
 * How a handoff turn is handed to a live worker (design §5.5): a main-topic
 * handoff goes into an ordinary session that may be in the middle of someone
 * else's turn (for the main bot, the turn that started the run or a wake),
 * so it waits behind that turn as a turn of its own — its node deadline
 * counts from when it starts — and is never folded into it. A node topic's
 * session is the node's own: nothing changes there.
 */
export function workflowHandoffInputOptions(
  handoff: Pick<WorkflowNodeSessionMarker, 'placement'> | undefined,
): { queueAfterActiveTurn?: true } {
  return handoff?.placement === 'main' ? { queueAfterActiveTurn: true } : {};
}

/** What the report route needs of a session's marker (§5.5). */
export function workflowNodeReportMarker(marker: WorkflowNodeSessionMarker): {
  handoffMessageId: string;
  nonce: string;
  placement?: 'main';
  started?: boolean;
  active?: boolean;
} {
  return {
    handoffMessageId: marker.handoffMessageId,
    nonce: marker.nonce,
    ...(marker.placement === 'main'
      ? { placement: 'main' as const, started: !!marker.handoffStartedAt, active: workflowNodeMarkerActive(marker) }
      : {}),
  };
}

/**
 * Does this marker make its session a node session (session kind
 * `botNode`: no workflow / multi-bot skills, the node plugin dir)? A node
 * topic's session is the node's own and stays one. A main-topic handoff
 * (design §5.5) goes into the bot's ordinary main-topic session — possibly
 * the main session itself — which outlives the attempt: it never changes kind.
 */
export function isWorkflowNodeSessionMarker(marker: Pick<WorkflowNodeSessionMarker, 'placement'> | undefined): boolean {
  return !!marker && marker.placement !== 'main';
}

/**
 * Does the marker still stand for an attempt in progress? A node-topic
 * marker always does (that session is the node's). A main-topic marker only
 * until its attempt ends — work handed in (`submittedAt`) or the attempt
 * stopped / revoked / reported blocked (`closedAt`) — so the reused ordinary
 * session is not treated as a node session afterwards (sidebar entry, stall
 * tracking, turn stops).
 */
export function workflowNodeMarkerActive(
  marker: Pick<WorkflowNodeSessionMarker, 'placement' | 'submittedAt' | 'closedAt'> | undefined,
): boolean {
  if (!marker) return false;
  if (marker.placement !== 'main') return true;
  return !marker.submittedAt && !marker.closedAt;
}

/** Replace the handoff card's self-reference with its real message id in the
 *  text handed to the CLI (the card was rendered before Lark assigned it). */
export function substituteWorkflowHandoffPlaceholder(content: string, handoffMessageId: string, placeholder: string): string {
  return content.split(placeholder).join(handoffMessageId);
}

function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/** Per input file / per handoff bounds for staged upstream products. Larger
 *  products are expected to travel as a branch name or link in result.json. */
export const WORKFLOW_INPUT_STAGE_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const WORKFLOW_INPUT_STAGE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface StagedWorkflowInputs {
  attachments: LarkAttachment[];
  /** Declared inputs that could not be staged (outside the run, missing,
   *  not a regular file, over the size bounds). */
  skipped: Array<{ from: string; name: string; reason: string }>;
}

/**
 * §7.1: copy the node's resolved upstream products into this turn's
 * attachment directory — the same place user-uploaded files land — so a
 * sandboxed session that cannot read the run directory still gets them.
 * Only regular files that resolve inside the run directory are copied (the
 * paths come from the run's own `inputs.json`; anything else is refused).
 */
export function stageWorkflowNodeInputs(input: {
  runDir: string;
  inputs: GoalInputs;
  attachmentsDir: string;
}): StagedWorkflowInputs {
  const attachments: LarkAttachment[] = [];
  const skipped: StagedWorkflowInputs['skipped'] = [];
  let runRoot: string;
  try {
    runRoot = realpathSync(input.runDir);
  } catch {
    return { attachments, skipped: input.inputs.inputs.map((item) => ({ from: item.from, name: item.name, reason: 'run directory unavailable' })) };
  }
  let total = 0;
  const usedNames = new Set<string>();
  for (const item of input.inputs.inputs) {
    const skip = (reason: string) => skipped.push({ from: item.from, name: item.name, reason });
    let source: string;
    try {
      source = realpathSync(resolve(item.path));
    } catch {
      skip('missing');
      continue;
    }
    if (!insideRoot(runRoot, source)) { skip('outside the run directory'); continue; }
    const stat = lstatSync(source);
    if (!stat.isFile()) { skip('not a regular file'); continue; }
    if (stat.size > WORKFLOW_INPUT_STAGE_MAX_FILE_BYTES) { skip('larger than the per-file bound'); continue; }
    if (total + stat.size > WORKFLOW_INPUT_STAGE_MAX_TOTAL_BYTES) { skip('over the per-handoff bound'); continue; }
    const safeFrom = item.from.replace(/[^A-Za-z0-9._-]/g, '_');
    let name = `${safeFrom}__${basename(item.name).replace(/[\\/\0]/g, '_') || basename(source)}`;
    for (let n = 2; usedNames.has(name); n++) name = `${safeFrom}__${n}__${basename(item.name)}`;
    usedNames.add(name);
    mkdirSync(input.attachmentsDir, { recursive: true });
    const target = join(input.attachmentsDir, name);
    copyFileSync(source, target);
    total += stat.size;
    attachments.push({ type: 'file', path: target, name });
  }
  return { attachments, skipped };
}

/** The full handoff text, written next to the attempt when it does not fit
 *  the card (the card says so; the receiver stages it as an attachment). */
export const WORKFLOW_HANDOFF_TASK_FILE = 'handoff-task.md';

/** Read the attempt's resolved inputs (`<attemptDir>/inputs.json`), plus the
 *  overflow handoff text when the card could not carry all of it. */
export function readWorkflowAttemptInputs(runDir: string, attemptId: string): GoalInputs | undefined {
  const root = resolve(runDir);
  const attemptDir = resolve(root, attemptId);
  if (!insideRoot(root, attemptDir)) return undefined;
  let parsed: GoalInputs;
  try {
    parsed = JSON.parse(readFileSync(join(attemptDir, 'inputs.json'), 'utf-8')) as GoalInputs;
    if (!parsed || !Array.isArray(parsed.inputs)) return undefined;
  } catch {
    return undefined;
  }
  const task = join(attemptDir, WORKFLOW_HANDOFF_TASK_FILE);
  try {
    if (lstatSync(task).isFile()) {
      return { ...parsed, inputs: [...parsed.inputs, { from: 'handoff', name: WORKFLOW_HANDOFF_TASK_FILE, path: task, kind: 'markdown' }] };
    }
  } catch { /* no overflow text */ }
  return parsed;
}

export interface HandoffAcceptanceSession {
  sessionId: string;
  larkAppId?: string;
  chatId: string;
  rootMessageId?: string;
  status?: string;
  queued?: boolean;
  pid?: number | null;
  workerGeneration?: number;
  workflowNode?: Pick<WorkflowNodeSessionMarker, 'handoffMessageId' | 'publishRoot' | 'registeredAt'>;
  dispatchInputReceipts?: Record<string, { rootMessageId?: string; committedAt?: string; workerGeneration?: number }>;
}

/**
 * §5.5 / §9.5: the receiver's session that registered this handoff. Two kinds
 * of durable evidence count, both scoped to exactly this message id, topic
 * root, chat and bot:
 * - the session's verified workflow-node marker for this handoff (written
 *   when its daemon accepted the inbound handoff — before a slow CLI cold
 *   start, so acceptance does not race the CLI's boot);
 * - the durable input receipt `botmux dispatch` acceptance uses (the live
 *   worker generation committed this exact turn to its CLI input queue).
 */
export function findWorkflowHandoffAcceptance(input: {
  sessions: Iterable<HandoffAcceptanceSession>;
  targetLarkAppId: string;
  chatId: string;
  publishRoot: string;
  handoffMessageId: string;
  isWorkerAlive: (pid: number) => boolean;
}): { sessionId: string; acceptedAt?: number } | undefined {
  for (const session of input.sessions) {
    if (session.larkAppId !== input.targetLarkAppId || session.chatId !== input.chatId) continue;
    if (session.status === 'closed') continue;
    const marker = session.workflowNode;
    if (marker?.handoffMessageId === input.handoffMessageId
      && marker.publishRoot === input.publishRoot
      && session.rootMessageId === input.publishRoot) {
      const registeredAt = Date.parse(marker.registeredAt ?? '');
      return { sessionId: session.sessionId, ...(Number.isFinite(registeredAt) ? { acceptedAt: registeredAt } : {}) };
    }
    if (session.queued === true) continue;
    const pid = session.pid;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || !input.isWorkerAlive(pid)) continue;
    const generation = session.workerGeneration;
    if (!Number.isSafeInteger(generation) || (generation ?? 0) <= 0) continue;
    const receipt = session.dispatchInputReceipts?.[input.handoffMessageId];
    if (!receipt || receipt.rootMessageId !== input.publishRoot || receipt.workerGeneration !== generation) continue;
    const committedAt = Date.parse(receipt.committedAt ?? '');
    return { sessionId: session.sessionId, ...(Number.isFinite(committedAt) ? { acceptedAt: committedAt } : {}) };
  }
  return undefined;
}
