/**
 * Keeps each node card of a bot-executed run in step with the journal
 * (design 2026-11-03 §5.3): handing off → running (or "stopped without
 * submitting") → done / blocked with reason / timed out / cancelled.
 *
 * Retries, revisits and loop rounds of a node reuse the node's topic, so one
 * card can stand for several attempts; the card always shows the latest one.
 * The journal stays the only truth: the sync is a best-effort projection run
 * after every drive of a bot run, patching a card only when what it shows
 * changed.
 */

import { join } from 'node:path';

import { attemptNumber } from '../../workflows/v3/attempt-numbering.js';
import { isGoalNode, type V3Dag } from '../../workflows/v3/dag.js';
import type { StoredEvent } from '../../workflows/v3/event-contract.js';
import {
  foldV3ExternalAttempts,
  type V3ExternalAttempt,
} from '../../workflows/v3/external-attempt-ledger.js';
import { V3_EXTERNAL_ERROR_CODES } from '../../workflows/v3/external-executor.js';
import { readJournal } from '../../workflows/v3/journal.js';
import { materialize } from '../../workflows/v3/state.js';
import {
  v3CheckpointMarkedSince,
  v3CheckpointSuccesses,
  type V3CheckpointSuccess,
} from '../../workflows/v3/checkpoint-hold.js';
import {
  foldV3NodeInterventions,
  formatV3Intervention,
  latestV3InterventionFor,
} from '../../workflows/v3/interventions.js';
import {
  buildV3HandoffCard,
  buildV3NodeCard,
  v3HandoffCardStatus,
  type V3HandoffCardInput,
  type V3NodeCardStatus,
  type V3NodeCardView,
} from './v3-node-card.js';
import type { WorkflowSidebarEntryLink } from './workflow-sidebar-entry.js';

/** The card status an external attempt projects to (pure). */
export function v3NodeCardStatusFor(
  attempt: V3ExternalAttempt,
  events: readonly StoredEvent[],
  instanceStatus: string | undefined,
  acceptanceUnknownSince?: number,
  activeAt?: number,
): V3NodeCardStatus {
  const closed = attempt.closed;
  if (!closed) {
    if (attempt.phase === 'accepted') {
      return {
        kind: 'running',
        acceptedAt: attempt.acceptedAt!,
        ...(attempt.deadlineAt !== undefined ? { deadlineAt: attempt.deadlineAt } : {}),
        ...(attempt.stalledAt !== undefined ? { stalledAt: attempt.stalledAt } : {}),
        ...(activeAt !== undefined ? { activeAt } : {}),
        ...(attempt.startPending ? { queued: true as const } : {}),
        ...(attempt.startedAt !== undefined ? { startedAt: attempt.startedAt } : {}),
      };
    }
    return acceptanceUnknownSince !== undefined
      ? { kind: 'acceptance_unknown', since: acceptanceUnknownSince }
      : { kind: 'handing_off' };
  }
  switch (closed.kind) {
    case 'succeeded': {
      const succeeded = events.find((event) => event.type === 'nodeSucceeded' && event.attemptId === attempt.attemptId);
      return {
        kind: 'done',
        ...(succeeded && attempt.acceptedAt !== undefined ? { elapsedMs: Math.max(0, succeeded.ts - attempt.acceptedAt) } : {}),
      };
    }
    case 'blocked':
    case 'failed': {
      const verdict = [...events].reverse().find((event) =>
        (event.type === 'nodeBlocked' || event.type === 'nodeFailed') && event.attemptId === attempt.attemptId);
      const message = verdict && 'message' in verdict && typeof verdict.message === 'string' ? verdict.message : undefined;
      const errorCode = closed.errorCode ?? (closed.kind === 'failed' ? 'failed' : undefined);
      // A timeout reads as its own state; the engine's own timeout text adds
      // nothing to "超时未提交有效结果" — except for a main-topic handoff that
      // never left the queue (§5.5), whose reason is the point.
      return errorCode === V3_EXTERNAL_ERROR_CODES.NODE_TIMEOUT && !attempt.startPending
        ? { kind: 'blocked', errorCode }
        : { kind: 'blocked', ...(errorCode ? { errorCode } : {}), ...(message ? { message } : {}) };
    }
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'reassigned':
      return { kind: 'reassigned' };
    case 'drained':
      if (closed.reason === 'obsoleteAttempt') {
        return instanceStatus === 'cancelled' ? { kind: 'cancelled' } : { kind: 'superseded' };
      }
      return { kind: 'cancelled' };
  }
}

/** The checkpoint line of a completed checkpoint node's card (§13.6). */
export function checkpointLine(success: V3CheckpointSuccess | undefined): string | undefined {
  if (!success) return undefined;
  if (!success.released) return '检查点：等主 Bot 看完结果，后续节点暂停';
  switch (success.released.reason) {
    case 'wakeTurnEnded': return '检查点：主 Bot 已看过结果，后续节点继续';
    case 'holdTimeout': return '检查点：等主 Bot 看结果超时，已按原流程继续';
    case 'wakeSessionEnded': return '检查点：主 Bot 的会话中途结束，已按原流程继续';
    default: return '检查点：没能唤醒主 Bot 看结果，已按原流程继续';
  }
}

export interface V3NodeCardSyncDeps {
  baseDir: string;
  /** Authorized run (pinned executor + effective DAG + display title, and
   *  the approved DAG for when checkpoint marks took effect), or undefined. */
  loadRun(runDir: string): { dag: V3Dag; authorizedDag?: V3Dag; nodeExecutor?: 'bot'; title: string } | undefined;
  patchCard(messageId: string, cardJson: string): Promise<void>;
  botName(larkAppId: string): string;
  selfLarkAppId: string;
  acceptanceUnknownSince?(runDir: string, attemptId: string): number | undefined;
  /** Display-only activity of an attempt (a later turn started). */
  activity?(runDir: string, attemptId: string): { activeAt?: number };
  /** Node cards by topic key, recorded when each card was sent. */
  topicCards?(runDir: string): Record<string, string>;
  /** §11: the run's「工作流 ›」sidebar entry (this daemon's bot is the main bot). */
  workflowEntry?(runId: string): WorkflowSidebarEntryLink | undefined;
  /** Main-topic placement (P2): the saved input of an attempt's handoff
   *  card, whose status line stands in for the node card. */
  handoffCardInput?(runDir: string, attemptId: string): V3HandoffCardInput | undefined;
  now?(): number;
}

/** Card key of an attempt's node: retries / revisits / loop rounds share it. */
function nodeTopicKey(attempt: V3ExternalAttempt): string {
  return attempt.loop ? `${attempt.loop.loopId}/${attempt.loop.bodyNodeId}` : attempt.nodeId;
}

export function createV3NodeCardSync(deps: V3NodeCardSyncDeps) {
  const shown = new Map<string, string>();
  const now = deps.now ?? Date.now;
  // Drives end concurrently; each sync reads the journal when it RUNS, and
  // runs one at a time per run, so the last patch always reflects the latest
  // journal (an older read can never land after a newer one).
  const chains = new Map<string, Promise<void>>();

  return function syncV3NodeCards(runId: string): Promise<void> {
    const previous = chains.get(runId) ?? Promise.resolve();
    const run = previous.then(() => syncOnce(runId), () => syncOnce(runId));
    const tail = run.then(() => undefined, () => undefined);
    chains.set(runId, tail);
    void tail.then(() => { if (chains.get(runId) === tail) chains.delete(runId); });
    return run;
  };

  async function syncOnce(runId: string): Promise<void> {
    const runDir = join(deps.baseDir, runId);
    const run = deps.loadRun(runDir);
    if (!run || run.nodeExecutor !== 'bot') return;
    const events = readJournal(join(runDir, 'journal.ndjson'));
    const snap = materialize([...events]);
    const topicCards = deps.topicCards?.(runDir) ?? {};
    const latestByCard = new Map<string, V3ExternalAttempt>();
    /** Main topic: every attempt has its own handoff card (P2). */
    const mainTopicCards = new Map<string, V3ExternalAttempt>();
    for (const attempt of foldV3ExternalAttempts(events).values()) {
      if (attempt.placement === 'main') {
        if (attempt.handoffMessageId) mainTopicCards.set(attempt.handoffMessageId, attempt);
        continue;
      }
      // An attempt whose Sent never reached the journal still owns the card
      // its node topic was opened with.
      const cardId = attempt.nodeCardMessageId ?? (attempt.phase !== 'dispatched' ? topicCards[nodeTopicKey(attempt)] : undefined);
      if (cardId) latestByCard.set(cardId, attempt);
    }
    const goalIds = run.dag.nodes.filter((node) => isGoalNode(node)).map((node) => node.id);
    const entry = deps.workflowEntry?.(runId);
    // Roles only: whether the initiator or someone else handed a node over
    // does not change the card line.
    const interventions = foldV3NodeInterventions(events);
    const checkpoints = new Map(v3CheckpointSuccesses({
      events,
      dag: run.dag,
      markedSince: v3CheckpointMarkedSince(runDir, run.authorizedDag ?? run.dag, events),
    }).map((success) => [success.attemptId, success]));
    for (const [messageId, attempt] of latestByCard) {
      const instanceStatus = attempt.instanceId
        ? snap.instances.get(attempt.instanceId)?.status
        : snap.nodes.get(attempt.nodeId)?.status;
      const status = v3NodeCardStatusFor(
        attempt,
        events,
        instanceStatus,
        deps.acceptanceUnknownSince?.(runDir, attempt.attemptId),
        deps.activity?.(runDir, attempt.attemptId).activeAt,
      );
      const authored = run.dag.nodes.find((node) => node.id === (attempt.loop ? attempt.loop.loopId : attempt.nodeId));
      const upstream = (authored?.depends ?? []).map((dep) => ({
        nodeId: dep.from,
        done: snap.nodes.get(dep.from)?.status === 'done',
      }));
      const target = attempt.targetLarkAppId ?? deps.selfLarkAppId;
      const index = goalIds.indexOf(authored?.id ?? '');
      const handled = latestV3InterventionFor(interventions.get(attempt.nodeId), attempt.attemptId);
      const intervention = handled ? formatV3Intervention(handled) : undefined;
      const checkpoint = checkpointLine(checkpoints.get(attempt.attemptId));
      const view: V3NodeCardView = {
        runTitle: run.title,
        runId,
        nodeId: attempt.loop ? attempt.loop.bodyNodeId : attempt.nodeId,
        ...(index >= 0 ? { nodeIndex: index + 1, nodeCount: goalIds.length } : {}),
        botName: deps.botName(target),
        selfExecuted: target === deps.selfLarkAppId,
        attemptNumber: attemptNumber(attempt.attemptId) ?? 1,
        ...(attempt.loop ? { loopIteration: attempt.loop.iteration } : {}),
        status,
        upstream,
        now: now(),
        ...(entry ? { entry } : {}),
        ...(intervention ? { intervention } : {}),
        ...(checkpoint ? { checkpoint } : {}),
      };
      // Elapsed time is not part of the change signal: a card is patched when
      // the node's state changes, not on every drive.
      const signature = JSON.stringify({ attempt: attempt.attemptId, status: { ...status, ...('since' in status ? { since: 0 } : {}) }, upstream, target, key: nodeTopicKey(attempt), intervention, checkpoint });
      if (shown.get(messageId) === signature) continue;
      await deps.patchCard(messageId, buildV3NodeCard(view));
      shown.set(messageId, signature);
    }
    for (const [messageId, attempt] of mainTopicCards) {
      const input = deps.handoffCardInput?.(runDir, attempt.attemptId);
      if (!input) continue;
      const instanceStatus = attempt.instanceId
        ? snap.instances.get(attempt.instanceId)?.status
        : snap.nodes.get(attempt.nodeId)?.status;
      const status = v3NodeCardStatusFor(
        attempt,
        events,
        instanceStatus,
        deps.acceptanceUnknownSince?.(runDir, attempt.attemptId),
        deps.activity?.(runDir, attempt.attemptId).activeAt,
      );
      const handled = latestV3InterventionFor(interventions.get(attempt.nodeId), attempt.attemptId);
      const intervention = handled ? formatV3Intervention(handled) : undefined;
      const checkpoint = checkpointLine(checkpoints.get(attempt.attemptId));
      const signature = JSON.stringify({ attempt: attempt.attemptId, status: { ...status, ...('since' in status ? { since: 0 } : {}) }, intervention, checkpoint, main: true });
      if (shown.get(messageId) === signature) continue;
      await deps.patchCard(messageId, buildV3HandoffCard({
        ...input,
        status: v3HandoffCardStatus(status, input.attemptNumber, {
          ...(intervention ? { intervention } : {}),
          ...(checkpoint ? { checkpoint } : {}),
        }),
      }));
      shown.set(messageId, signature);
    }
  }
}
