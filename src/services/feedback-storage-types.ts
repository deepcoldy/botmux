export interface PostgresTarget {
  host: string;
  port: number;
  database: string;
  user?: string;
  schema: string;
  passwordRef?: string;
  bytepg?: { computeId: string; tokenRef?: string; doas?: import('./feedback-doas-token.js').DoasTokenConfig };
  tls: { mode: 'verify-full' | 'disable'; caRef?: string };
  connectTimeoutMs: number;
}

export type FeedbackStorageTarget =
  | { backend: 'sqlite' }
  | { backend: 'postgresql'; postgres: PostgresTarget };

export interface FeedbackStorageConfig {
  version: 1;
  generation: number;
  instanceId: string;
  active: FeedbackStorageTarget;
  candidate?: FeedbackStorageTarget;
}
import type { SkillFeedbackStore } from './skill-feedback-store.js';
import type { FeedbackAnalyticsService } from './feedback-analytics.js';

type AsyncMethods<Methods> = {
  [Method in keyof Methods]: Methods[Method] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Promise<Awaited<Result>> : never;
};
export type FeedbackStore = AsyncMethods<Pick<SkillFeedbackStore,
  | 'close' | 'createResponse' | 'getResponse' | 'createDelivery'
  | 'recordTurnDelivery' | 'recordTurnTerminal' | 'tryRecordTurnTerminal'
  | 'findDeliveryByPlatformMessage' | 'findDeliveryById' | 'listSubjectDeliveries' | 'recordFeedback' | 'listFeedbackRevisions'
  | 'getLatestFeedback' | 'listTurnCompletionEvents' | 'listFeedbackEvents' | 'readFeedbackEventsAfter'
  | 'listFeedbackOutbox' | 'claimFeedbackOutbox' | 'tryClaimFeedbackOutbox'
  | 'settleFeedbackOutboxDelivered' | 'trySettleFeedbackOutboxDelivered'
  | 'rescheduleFeedbackOutbox' | 'tryRescheduleFeedbackOutbox'
  | 'resetExpiredFeedbackOutboxClaims' | 'tryResetExpiredFeedbackOutboxClaims'
>>;
export type FeedbackAnalytics = AsyncMethods<FeedbackAnalyticsService>;
export type CompatibleFeedbackStore = {
  [Method in keyof FeedbackStore]: FeedbackStore[Method] extends (...args: infer Args) => Promise<infer Result>
    ? (...args: Args) => Result | Promise<Result> : never;
};
