import { z } from 'zod';

import { computeNextRun, parseSchedule } from '../../core/scheduler.js';
import {
  canonicalScheduleInput,
  createTask,
  getTask,
  IdempotencyConflictError,
} from '../../services/schedule-store.js';
import { computeInputHash } from '../../utils/canonical-input-hash.js';
import type { ParsedSchedule } from '../../types.js';
import type { ProviderReconciler } from '../shared/provider-reconciler.js';
import { PROVIDER_TTL_MS } from '../shared/provider-reconciler.js';
import type { SideEffectingExecutor } from './types.js';

export type ScheduleInput = {
  name: string;
  schedule: string;
  /** Pre-resolved schedule (parser output). Host preparation derives it when
   *  omitted; the frozen sidecar always contains it so recovery never reparses
   *  relative schedules (`30m`, `2h`, `明天9:00`). */
  parsed: ParsedSchedule;
  prompt: string;
  workingDir: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  rootMessageId?: string;
  scope?: 'thread' | 'chat';
  larkAppId?: string;
  /** `repeat.completed` is intentionally absent — it's a runtime counter
   *  and must not be part of canonical input.  See schedule-store
   *  canonicalScheduleInput. */
  repeat?: { times: number | null };
  deliver?: 'origin' | 'local' | 'new-topic';
};

export type ScheduleOutput = {
  taskId: string;
};

const ParsedScheduleSchema = z.object({
  kind: z.enum(['once', 'interval', 'cron']),
  runAt: z.string().optional(),
  minutes: z.number().optional(),
  expr: z.string().optional(),
  display: z.string(),
});

const ScheduleInputSchema = z.object({
  name: z.string().min(1),
  schedule: z.string().min(1),
  parsed: ParsedScheduleSchema.optional(),
  prompt: z.string().min(1),
  workingDir: z.string().min(1),
  chatId: z.string().min(1),
  // Optional only for legacy v2 definitions; v3 DAG validation requires the
  // exact context.chatType binding.
  chatType: z.enum(['group', 'p2p']).optional(),
  rootMessageId: z.string().optional(),
  scope: z.enum(['thread', 'chat']).optional(),
  larkAppId: z.string().optional(),
  repeat: z.object({ times: z.number().int().positive().nullable() }).optional(),
  deliver: z.enum(['origin', 'local', 'new-topic']).optional(),
});

export function parseScheduleInput(input: unknown): ScheduleInput {
  const parsed = ScheduleInputSchema.parse(input);
  const value = {
    ...parsed,
    chatType: parsed.chatType ?? 'group',
    // Raw authored/Saved Workflow input derives relative time exactly once at
    // host preparation. Re-validation receives the already-frozen `parsed`
    // sidecar value and therefore never reinterprets "30m" after a restart.
    parsed: parsed.parsed ?? parseSchedule(parsed.schedule),
  };
  if (value.parsed.kind === 'once') {
    if (!value.parsed.runAt || !Number.isFinite(Date.parse(value.parsed.runAt))) {
      throw new Error('one-shot schedule must contain a valid runAt timestamp');
    }
  } else if (value.parsed.kind === 'interval') {
    if (!Number.isSafeInteger(value.parsed.minutes) || (value.parsed.minutes ?? 0) < 1) {
      throw new Error('interval schedule minutes must be a positive integer');
    }
  } else if (!value.parsed.expr || computeNextRun(value.parsed) === null) {
    throw new Error('cron schedule must have a valid future occurrence');
  }
  return value;
}

/**
 * `botmux-schedule` hostExecutor.  Calls `schedule-store.createTask`
 * passing the runtime-derived `idempotencyKey` as the deterministic
 * task id; schedule-store applies create-or-return-identical semantics
 * (Step 5).
 *
 * Provider TTL is effectively infinite for schedule (the task entry
 * lives until removed), so dangling effectAttempted reconcile uses
 * readOnlyLookup (`getTask(idempotencyKey)`) — no TTL boundary.
 */
export const botmuxScheduleExecutor: SideEffectingExecutor<ScheduleInput, ScheduleOutput> = {
  provider: 'botmux-schedule',
  idempotencyTtlMs: PROVIDER_TTL_MS['botmux-schedule'],

  canonicalInput(input) {
    return canonicalScheduleInput(input);
  },

  validateBeforeIntent(input, nowMs) {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      return {
        ok: false,
        errorCode: 'HOST_SCHEDULE_CLOCK_INVALID',
        message: 'host clock evidence is invalid; freeze a fresh schedule attempt',
      };
    }
    if (input.deliver === 'local') {
      return {
        ok: false,
        errorCode: 'HOST_SCHEDULE_LOCAL_DELIVERY_UNSUPPORTED',
        message: 'v3 schedule host does not support deliver=local in P0',
      };
    }
    if (input.parsed.kind !== 'once') return { ok: true };
    const runAtMs = input.parsed.runAt ? Date.parse(input.parsed.runAt) : Number.NaN;
    // Keep exactly the scheduler's two-minute one-shot catch-up window. Once
    // this payload falls outside it, creating the task would report success
    // while computeNextRun() can never schedule it.
    if (!Number.isFinite(runAtMs) || runAtMs < nowMs - 120_000) {
      return {
        ok: false,
        errorCode: 'HOST_SCHEDULE_APPROVAL_STALE',
        message: 'approved one-shot schedule is stale; retry to freeze and approve a fresh runAt',
      };
    }
    return { ok: true };
  },

  async invoke(input, idempotencyKey) {
    const task = createTask({
      id: idempotencyKey,
      name: input.name,
      schedule: input.schedule,
      parsed: input.parsed,
      prompt: input.prompt,
      workingDir: input.workingDir,
      chatId: input.chatId,
      chatType: input.chatType,
      rootMessageId: input.rootMessageId,
      scope: input.scope,
      larkAppId: input.larkAppId,
      repeat: input.repeat ? { times: input.repeat.times, completed: 0 } : undefined,
      deliver: input.deliver,
    });
    return {
      output: { taskId: task.id },
      externalRefs: { taskId: task.id },
    };
  },

  classifyError(err) {
    if (err instanceof IdempotencyConflictError) {
      return {
        errorCode: 'IdempotencyConflict',
        errorClass: 'fatal',
        errorMessage: err.message,
      };
    }
    return null;
  },
};

export const botmuxScheduleReconciler: ProviderReconciler = {
  provider: 'botmux-schedule',

  // v3 supplies its verified frozen input and requires exact body matching.
  canonicalInput(input) {
    return botmuxScheduleExecutor.canonicalInput(input as ScheduleInput);
  },

  async readOnlyLookup(idempotencyKey, input) {
    const task = getTask(idempotencyKey);
    if (!task) {
      return {
        found: false,
        evidence: { source: 'getTask', returned: 'undefined' },
      };
    }
    if (input !== undefined) {
      const parsedInput = parseScheduleInput(input);
      const existingHash = computeInputHash(canonicalScheduleInput(task));
      const incomingHash = computeInputHash(canonicalScheduleInput(parsedInput));
      if (existingHash !== incomingHash) {
        throw new IdempotencyConflictError({
          taskId: idempotencyKey,
          existingInputHash: existingHash,
          incomingInputHash: incomingHash,
        });
      }
    }
    const externalRefs = { taskId: task.id };
    return {
      found: true,
      externalRefs,
      evidence: { source: 'getTask', externalRefs },
    };
  },
};
