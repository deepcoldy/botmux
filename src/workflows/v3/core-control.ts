import {
  DEFAULT_REVISIT_BUDGET_PER_PAIR,
  DEFAULT_REVISIT_BUDGET_PER_RUN,
  type V3LoopExitWhen,
} from './dag.js';
import type { StoredEvent } from './event-contract.js';

/** Pure loop/conditional predicate evaluation after DAG validation. */
export function matchLoopExitWhen(when: V3LoopExitWhen, value: unknown): boolean {
  if (when.equals !== undefined) return value === when.equals;
  if (when.notEquals !== undefined) return value !== when.notEquals;
  if (typeof value !== 'number') return false;
  if (when.gt !== undefined) return value > when.gt;
  if (when.gte !== undefined) return value >= when.gte;
  if (when.lt !== undefined) return value < when.lt;
  if (when.lte !== undefined) return value <= when.lte;
  return false;
}

/**
 * Pure two-tier anti-runaway policy for cross-node revisits.
 * Grant events extend exactly one pair or the whole run by one.
 */
export function revisitBudgetStatus(
  events: StoredEvent[],
  sourceNodeId: string,
  toNodeId: string,
): { ok: true } | { ok: false; tier: 'pair' | 'run'; detail: string } {
  let pairUsed = 0;
  let runUsed = 0;
  let pairGranted = 0;
  let runGranted = 0;
  for (const event of events) {
    if (event.type === 'nodeRevisitRequested') {
      runUsed++;
      if (event.nodeId === sourceNodeId && event.toNodeId === toNodeId) pairUsed++;
    } else if (event.type === 'revisitBudgetGranted') {
      if (event.sourceNodeId === sourceNodeId && event.toNodeId === toNodeId) pairGranted++;
      else if (event.sourceNodeId === undefined && event.toNodeId === undefined) runGranted++;
    }
  }
  const pairLimit = DEFAULT_REVISIT_BUDGET_PER_PAIR + pairGranted;
  const runLimit = DEFAULT_REVISIT_BUDGET_PER_RUN + runGranted;
  if (pairUsed >= pairLimit) {
    return {
      ok: false,
      tier: 'pair',
      detail: `revisit budget exhausted for ${sourceNodeId}->${toNodeId} (${pairUsed}/${pairLimit}) — grant +1 (this pair) to continue`,
    };
  }
  if (runUsed >= runLimit) {
    return {
      ok: false,
      tier: 'run',
      detail: `run-wide revisit budget exhausted (${runUsed}/${runLimit}) — grant +1 (run) to continue`,
    };
  }
  return { ok: true };
}
