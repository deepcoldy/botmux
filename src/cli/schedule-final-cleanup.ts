import { parseScheduledTurnId } from '../core/scheduled-turn-provenance.js';
import type { TurnSendKind } from '../services/turn-send-ledger.js';

export interface ScheduleFinalCleanupPlanInput {
  requested: boolean;
  responseKind?: TurnSendKind;
  turnId?: string;
  incompatible: readonly string[];
}

export type ScheduleFinalCleanupPlan =
  | { ok: true; taskId?: string }
  | { ok: false; error: string };

/**
 * Resolve the exact task that may be removed after a final answer is delivered.
 * The caller supplies only presentation incompatibilities; task identity always
 * comes from the authenticated scheduled turn and can never be selected by the
 * model.
 */
export function planScheduleFinalCleanup(
  input: ScheduleFinalCleanupPlanInput,
): ScheduleFinalCleanupPlan {
  if (!input.requested) return { ok: true };
  if (input.responseKind !== 'final') {
    return {
      ok: false,
      error: '--schedule-remove-self 只能与显式 --response-kind final 一起使用',
    };
  }
  const taskId = parseScheduledTurnId(input.turnId ?? '');
  if (!taskId) {
    return {
      ok: false,
      error: '--schedule-remove-self 只能由当前 scheduled turn 删除自身任务',
    };
  }
  if (input.incompatible.length > 0) {
    return {
      ok: false,
      error: `--schedule-remove-self 不支持这些发送形态：${input.incompatible.join(', ')}`,
    };
  }
  return { ok: true, taskId };
}
