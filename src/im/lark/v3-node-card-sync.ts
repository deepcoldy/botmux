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
import { buildV3NodeCard, type V3NodeCardStatus, type V3NodeCardView } from './v3-node-card.js';

/** The card status an external attempt projects to (pure). */
export function v3NodeCardStatusFor(
  attempt: V3ExternalAttempt,
  events: readonly StoredEvent[],
  instanceStatus: string | undefined,
  acceptanceUnknownSince?: number,
): V3NodeCardStatus {
  const closed = attempt.closed;
  if (!closed) {
    if (attempt.phase === 'accepted') {
      return {
        kind: 'running',
        acceptedAt: attempt.acceptedAt!,
        ...(attempt.deadlineAt !== undefined ? { deadlineAt: attempt.deadlineAt } : {}),
        ...(attempt.stalledAt !== undefined ? { stalledAt: attempt.stalledAt } : {}),
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
      // nothing to "超时未提交有效结果".
      return errorCode === V3_EXTERNAL_ERROR_CODES.NODE_TIMEOUT
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

export interface V3NodeCardSyncDeps {
  baseDir: string;
  /** Authorized run (pinned executor + DAG + display title), or undefined. */
  loadRun(runDir: string): { dag: V3Dag; nodeExecutor?: 'bot'; title: string } | undefined;
  patchCard(messageId: string, cardJson: string): Promise<void>;
  botName(larkAppId: string): string;
  selfLarkAppId: string;
  acceptanceUnknownSince?(runDir: string, attemptId: string): number | undefined;
  now?(): number;
}

/** Card key of an attempt's node: retries / revisits / loop rounds share it. */
function nodeTopicKey(attempt: V3ExternalAttempt): string {
  return attempt.loop ? `${attempt.loop.loopId}/${attempt.loop.bodyNodeId}` : attempt.nodeId;
}

export function createV3NodeCardSync(deps: V3NodeCardSyncDeps) {
  const shown = new Map<string, string>();
  const now = deps.now ?? Date.now;

  return async function syncV3NodeCards(runId: string): Promise<void> {
    const runDir = join(deps.baseDir, runId);
    const run = deps.loadRun(runDir);
    if (!run || run.nodeExecutor !== 'bot') return;
    const events = readJournal(join(runDir, 'journal.ndjson'));
    const snap = materialize([...events]);
    const latestByCard = new Map<string, V3ExternalAttempt>();
    for (const attempt of foldV3ExternalAttempts(events).values()) {
      if (attempt.nodeCardMessageId) latestByCard.set(attempt.nodeCardMessageId, attempt);
    }
    const goalIds = run.dag.nodes.filter((node) => isGoalNode(node)).map((node) => node.id);
    for (const [messageId, attempt] of latestByCard) {
      const instanceStatus = attempt.instanceId
        ? snap.instances.get(attempt.instanceId)?.status
        : snap.nodes.get(attempt.nodeId)?.status;
      const status = v3NodeCardStatusFor(
        attempt,
        events,
        instanceStatus,
        deps.acceptanceUnknownSince?.(runDir, attempt.attemptId),
      );
      const authored = run.dag.nodes.find((node) => node.id === (attempt.loop ? attempt.loop.loopId : attempt.nodeId));
      const upstream = (authored?.depends ?? []).map((dep) => ({
        nodeId: dep.from,
        done: snap.nodes.get(dep.from)?.status === 'done',
      }));
      const target = attempt.targetLarkAppId ?? deps.selfLarkAppId;
      const index = goalIds.indexOf(authored?.id ?? '');
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
      };
      // Elapsed time is not part of the change signal: a card is patched when
      // the node's state changes, not on every drive.
      const signature = JSON.stringify({ attempt: attempt.attemptId, status: { ...status, ...('since' in status ? { since: 0 } : {}) }, upstream, target, key: nodeTopicKey(attempt) });
      if (shown.get(messageId) === signature) continue;
      await deps.patchCard(messageId, buildV3NodeCard(view));
      shown.set(messageId, signature);
    }
  };
}
