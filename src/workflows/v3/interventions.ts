/**
 * The main bot's automatic handling and hand-overs of a run's nodes, read
 * back from the journal for display (design 2026-11-03 §13.6): the node card
 * shows the latest one, the Dashboard node panel lists them all.
 *
 * - `retry` — a `nodeRetryRequested` with `by: 'main_bot'`;
 * - `reassign` — a `nodeReassigned` with `by: 'main_bot'`;
 * - `rerun` — a `dagRevised` with `by: 'main_bot'` that re-runs the node
 *   (`effects.rerun`) or invalidates its work in progress (`effects.supersede`,
 *   downstream instances a re-run replaces included);
 * - `handedToHuman` — every `nodeHandedToHuman` (the main bot's, or the
 *   initiator's own).
 *
 * Human actions (card clicks, an initiator's own retry) are not listed: they
 * are the people reading this. Only roles and reasons are kept — never an
 * open_id. Pure fold; replay of journals without these fields yields nothing.
 */

import type { StoredEvent } from './event-contract.js';

export type V3InterventionKind = 'retry' | 'reassign' | 'rerun' | 'handedToHuman';

export interface V3NodeIntervention {
  kind: V3InterventionKind;
  by: 'mainBot' | 'initiator' | 'other';
  /** As given (may be empty for a turn that was not required to give one). */
  reason: string;
  /** Engine clock (journal `ts`). */
  at: number;
  /** The attempt it is about: the one handed over, or the attempt a
   *  retry / reassignment / re-run led to once it was dispatched. */
  attemptId?: string;
}

function roleOf(by: string, initiatorOpenId: string | undefined): V3NodeIntervention['by'] {
  if (by === 'main_bot') return 'mainBot';
  return initiatorOpenId !== undefined && by === initiatorOpenId ? 'initiator' : 'other';
}

/** nodeId → its interventions, oldest first. */
export function foldV3NodeInterventions(
  events: readonly StoredEvent[],
  initiatorOpenId?: string,
): Map<string, V3NodeIntervention[]> {
  const out = new Map<string, V3NodeIntervention[]>();
  /** Interventions waiting for the next dispatch of their node. */
  const awaitingDispatch = new Map<string, V3NodeIntervention[]>();
  const add = (nodeId: string, item: V3NodeIntervention, awaitDispatch: boolean): void => {
    const list = out.get(nodeId) ?? [];
    list.push(item);
    out.set(nodeId, list);
    if (awaitDispatch) awaitingDispatch.set(nodeId, [...(awaitingDispatch.get(nodeId) ?? []), item]);
  };
  /** Nodes whose automatic reassignment is not dispatched yet: the retry
   *  that moves a blocked node onto its new bot is part of it, not news. */
  const reassignedBeforeDispatch = new Set<string>();
  for (const event of events) {
    switch (event.type) {
      case 'nodeDispatched': {
        for (const item of awaitingDispatch.get(event.nodeId) ?? []) item.attemptId ??= event.attemptId;
        awaitingDispatch.delete(event.nodeId);
        reassignedBeforeDispatch.delete(event.nodeId);
        break;
      }
      case 'nodeRetryRequested':
        if (event.by !== 'main_bot' || reassignedBeforeDispatch.has(event.nodeId)) break;
        add(event.nodeId, { kind: 'retry', by: 'mainBot', reason: event.auto?.reason ?? '', at: event.ts, attemptId: event.nextAttemptId }, false);
        break;
      case 'nodeReassigned':
        if (event.by !== 'main_bot') break;
        add(event.nodeId, { kind: 'reassign', by: 'mainBot', reason: event.auto?.reason ?? '', at: event.ts }, true);
        reassignedBeforeDispatch.add(event.nodeId);
        break;
      case 'dagRevised': {
        if (event.by !== 'main_bot') break;
        const nodes = new Set<string>([
          ...(event.effects?.rerun ?? []),
          ...(event.effects?.supersede ?? []).map((item) => item.nodeId),
        ]);
        for (const nodeId of nodes) {
          add(nodeId, { kind: 'rerun', by: 'mainBot', reason: event.auto?.reason ?? '', at: event.ts }, true);
        }
        break;
      }
      case 'nodeHandedToHuman':
        add(event.nodeId, {
          kind: 'handedToHuman',
          by: roleOf(event.by, initiatorOpenId),
          reason: event.reason,
          at: event.ts,
          attemptId: event.attemptId,
        }, false);
        break;
      default:
        break;
    }
  }
  return out;
}

/** The latest intervention about `attemptId` (what the node card shows for
 *  the attempt it stands for). */
export function latestV3InterventionFor(
  list: readonly V3NodeIntervention[] | undefined,
  attemptId: string,
): V3NodeIntervention | undefined {
  if (!list) return undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]!.attemptId === attemptId) return list[i];
  }
  return undefined;
}

const KIND_TEXT: Record<V3InterventionKind, string> = {
  retry: '主 Bot 自动重试',
  reassign: '主 Bot 自动改派',
  rerun: '主 Bot 自动重做',
  handedToHuman: '交给人决定',
};

/** One display line: 「主 Bot 自动重试：<理由>」/「交给人决定：<理由>」. */
export function formatV3Intervention(item: Pick<V3NodeIntervention, 'kind' | 'reason'>, maxChars = 300): string {
  const reason = item.reason.trim();
  const clipped = reason.length > maxChars ? `${reason.slice(0, maxChars)}…` : reason;
  return clipped ? `${KIND_TEXT[item.kind]}：${clipped}` : KIND_TEXT[item.kind];
}
