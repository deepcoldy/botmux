import { z } from 'zod';
import {
  RunCreatedEventSchema,
  RunStartedEventSchema,
  RunSucceededEventSchema,
  RunFailedEventSchema,
  RunCanceledEventSchema,
  NodeWaitingEventSchema,
  NodeRetryingEventSchema,
  NodeSucceededEventSchema,
  NodeFailedEventSchema,
  NodeSkippedEventSchema,
  NodeCanceledEventSchema,
  ActivityRunningEventSchema,
  ActivityWaitingEventSchema,
  ActivityTimedOutEventSchema,
  LoopStartedEventSchema,
  LoopIterationStartedEventSchema,
  LoopIterationFinishedEventSchema,
  LoopFinishedEventSchema,
  ConditionEvaluatedEventSchema,
  LeaseSignedEventSchema,
  AttemptCreatedEventSchema,
  BackoffScheduledEventSchema,
  BackoffElapsedEventSchema,
  EffectAttemptedEventSchema,
  ActivitySucceededEventSchema,
  ActivityFailedEventSchema,
  WaitCreatedEventSchema,
  WaitResolvedEventSchema,
  WaitDeadlineExceededEventSchema,
  CancelRequestedEventSchema,
  CancelDeliveredEventSchema,
  ActivityCanceledEventSchema,
  WorkerLostEventSchema,
  ResumeStartedEventSchema,
  ReconcileResultEventSchema,
} from './schema.js';

// Per-event TS types inferred from zod schemas.  Use these in producer
// code paths so the compiler enforces shape at the call site instead of
// only at validate time.

export type RunCreatedEvent = z.infer<typeof RunCreatedEventSchema>;
export type RunStartedEvent = z.infer<typeof RunStartedEventSchema>;
export type RunSucceededEvent = z.infer<typeof RunSucceededEventSchema>;
export type RunFailedEvent = z.infer<typeof RunFailedEventSchema>;
export type RunCanceledEvent = z.infer<typeof RunCanceledEventSchema>;
export type NodeWaitingEvent = z.infer<typeof NodeWaitingEventSchema>;
export type NodeRetryingEvent = z.infer<typeof NodeRetryingEventSchema>;
export type NodeSucceededEvent = z.infer<typeof NodeSucceededEventSchema>;
export type NodeFailedEvent = z.infer<typeof NodeFailedEventSchema>;
export type NodeSkippedEvent = z.infer<typeof NodeSkippedEventSchema>;
export type NodeCanceledEvent = z.infer<typeof NodeCanceledEventSchema>;
export type ActivityRunningEvent = z.infer<typeof ActivityRunningEventSchema>;
export type ActivityWaitingEvent = z.infer<typeof ActivityWaitingEventSchema>;
export type ActivityTimedOutEvent = z.infer<typeof ActivityTimedOutEventSchema>;
export type LoopStartedEvent = z.infer<typeof LoopStartedEventSchema>;
export type LoopIterationStartedEvent = z.infer<typeof LoopIterationStartedEventSchema>;
export type LoopIterationFinishedEvent = z.infer<typeof LoopIterationFinishedEventSchema>;
export type LoopFinishedEvent = z.infer<typeof LoopFinishedEventSchema>;
export type ConditionEvaluatedEvent = z.infer<typeof ConditionEvaluatedEventSchema>;
export type LeaseSignedEvent = z.infer<typeof LeaseSignedEventSchema>;
export type AttemptCreatedEvent = z.infer<typeof AttemptCreatedEventSchema>;
export type BackoffScheduledEvent = z.infer<typeof BackoffScheduledEventSchema>;
export type BackoffElapsedEvent = z.infer<typeof BackoffElapsedEventSchema>;
export type EffectAttemptedEvent = z.infer<typeof EffectAttemptedEventSchema>;
export type ActivitySucceededEvent = z.infer<typeof ActivitySucceededEventSchema>;
export type ActivityFailedEvent = z.infer<typeof ActivityFailedEventSchema>;
export type WaitCreatedEvent = z.infer<typeof WaitCreatedEventSchema>;
export type WaitResolvedEvent = z.infer<typeof WaitResolvedEventSchema>;
export type WaitDeadlineExceededEvent = z.infer<typeof WaitDeadlineExceededEventSchema>;
export type CancelRequestedEvent = z.infer<typeof CancelRequestedEventSchema>;
export type CancelDeliveredEvent = z.infer<typeof CancelDeliveredEventSchema>;
export type ActivityCanceledEvent = z.infer<typeof ActivityCanceledEventSchema>;
export type WorkerLostEvent = z.infer<typeof WorkerLostEventSchema>;
export type ResumeStartedEvent = z.infer<typeof ResumeStartedEventSchema>;
export type ReconcileResultEvent = z.infer<typeof ReconcileResultEventSchema>;
