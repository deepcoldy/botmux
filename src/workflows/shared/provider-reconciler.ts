/**
 * Provider recovery contract shared by the v3 host runtime and concrete
 * side-effect executors.
 *
 * This is deliberately independent of the retired v2 event log and resume
 * algorithm.  A reconciler proves what happened at the external provider;
 * the caller owns durable state transitions and retry policy.
 */

import type { ProviderReconciler } from '../v3/runtime-host-contract.js';

export type {
  IdempotentSubmitResult,
  ProviderReconciler,
  ReadOnlyLookupResult,
} from '../v3/runtime-host-contract.js';

/**
 * Provider dedupe windows shared by v3 host execution and frozen v2 replay.
 * These values participate in durable recovery decisions and must not drift.
 */
export const PROVIDER_TTL_MS = {
  'feishu-im': 60 * 60 * 1000,
  'botmux-schedule': Number.MAX_SAFE_INTEGER,
} as const;
