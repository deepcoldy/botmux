import { z } from 'zod';

import {
  createTask,
  getTask,
  IdempotencyConflictError,
} from '../../services/schedule-store.js';
import type { ParsedSchedule } from '../../types.js';
import type { ProviderReconciler } from '../resume.js';
import type { SideEffectingExecutor } from './types.js';

export type ScheduleInput = {
  name: string;
  schedule: string;
  /** Pre-resolved schedule (parser output).  Required for relative
   *  schedules (`30m`, `2h`, `明天9:00`) to keep canonical input frozen
   *  against re-parse drift (codex round 4 finding 4). */
  parsed: ParsedSchedule;
  prompt: string;
  workingDir: string;
  chatId: string;
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
  parsed: ParsedScheduleSchema,
  prompt: z.string(),
  workingDir: z.string().min(1),
  chatId: z.string().min(1),
  rootMessageId: z.string().optional(),
  scope: z.enum(['thread', 'chat']).optional(),
  larkAppId: z.string().optional(),
  repeat: z.object({ times: z.number().int().nonnegative().nullable() }).optional(),
  deliver: z.enum(['origin', 'local', 'new-topic']).optional(),
});

export function parseScheduleInput(input: unknown): ScheduleInput {
  return ScheduleInputSchema.parse(input);
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
  idempotencyTtlMs: Number.MAX_SAFE_INTEGER,

  canonicalInput(input) {
    // Mirrors schedule-store's `canonicalScheduleInput`.  Keeping them in
    // sync is critical: if they diverge, two callers can produce the
    // same idempotencyKey but disagree on canonicality and trip the
    // IdempotencyConflict path on every retry.
    return {
      name: input.name,
      schedule: input.schedule,
      parsed: {
        kind: input.parsed.kind,
        runAt: input.parsed.runAt,
        minutes: input.parsed.minutes,
        expr: input.parsed.expr,
      },
      prompt: input.prompt,
      workingDir: input.workingDir,
      chatId: input.chatId,
      rootMessageId: input.rootMessageId,
      scope: input.scope,
      larkAppId: input.larkAppId,
      repeat: input.repeat ? { times: input.repeat.times } : undefined,
      deliver: input.deliver ?? 'origin',
    };
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

  // Schedule reconciler doesn't load effect input (idempotencyKey is
  // self-sufficient), so the resume-side hash guard never fires.  We
  // still expose `canonicalInput` for interface uniformity — anyone
  // re-using the reconciler in a context that DOES load sidecars (e.g.
  // future ScheduleStore variants requiring body verification) gets the
  // same check for free.
  canonicalInput(input) {
    return botmuxScheduleExecutor.canonicalInput(input as ScheduleInput);
  },

  async readOnlyLookup(idempotencyKey) {
    const task = getTask(idempotencyKey);
    if (!task) {
      return {
        found: false,
        evidence: { source: 'getTask', returned: 'undefined' },
      };
    }
    const externalRefs = { taskId: task.id };
    return {
      found: true,
      externalRefs,
      evidence: { source: 'getTask', externalRefs },
    };
  },
};
