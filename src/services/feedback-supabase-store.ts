import { createClient } from '@supabase/supabase-js';
import type { FeedbackAnalytics, FeedbackStore, SupabaseTarget } from './feedback-storage-types.js';
import { readFeedbackStorageSecret } from './feedback-storage-config.js';
import { feedbackDeliveryContext } from './feedback-extension-store.js';

export interface SupabaseFeedbackClient {
  call<Result>(operation: string, args: unknown[], instanceId: string): Promise<Result>;
  close(): Promise<void>;
}

const operations = [
  'createResponse', 'getResponse', 'createDelivery', 'recordTurnDelivery', 'recordTurnTerminal',
  'findDeliveryByPlatformMessage', 'findDeliveryById', 'listSubjectDeliveries', 'recordFeedback',
  'listFeedbackRevisions', 'getLatestFeedback', 'listTurnCompletionEvents', 'listFeedbackEvents',
  'readFeedbackEventsAfter', 'listFeedbackOutbox', 'claimFeedbackOutbox', 'startFeedbackOutboxRequest',
  'settleFeedbackOutboxDelivered', 'rescheduleFeedbackOutbox', 'resetExpiredFeedbackOutboxClaims',
  'analytics_summary', 'analytics_trend', 'analytics_reasons', 'analytics_deliveries',
  'migration_prepare', 'migration_import', 'migration_snapshot', 'migration_activate', 'migration_status',
] as const;
const mutationOperations = new Set<string>([
  'createResponse', 'createDelivery', 'recordTurnDelivery', 'recordTurnTerminal', 'recordFeedback',
  'claimFeedbackOutbox', 'startFeedbackOutboxRequest', 'settleFeedbackOutboxDelivered',
  'rescheduleFeedbackOutbox', 'resetExpiredFeedbackOutboxClaims', 'migration_prepare',
  'migration_import', 'migration_activate',
]);

function serverKey(value: string): boolean {
  if (value.startsWith('sb_secret_')) return true;
  try {
    const parts = value.split('.');
    return parts.length === 3 && JSON.parse(Buffer.from(parts[1], 'base64url').toString()).role === 'service_role';
  } catch { return false; }
}

export async function openSupabaseFeedbackClient(
  dataDir: string, target: SupabaseTarget, transport: typeof fetch = fetch,
): Promise<SupabaseFeedbackClient> {
  const key = await readFeedbackStorageSecret(dataDir, target.keyRef);
  if (!serverKey(key)) throw new Error('feedback_supabase_server_key_required');
  let closed = false;
  const requests = new Set<AbortController>();
  const boundedFetch: typeof fetch = async (input, init) => {
    const controller = new AbortController();
    requests.add(controller);
    const timer = setTimeout(() => controller.abort(), target.requestTimeoutMs);
    timer.unref();
    try { return await transport(input, { ...init, signal: controller.signal }); }
    finally { clearTimeout(timer); requests.delete(controller); }
  };
  const sdk = createClient(target.url, key, {
    db: { schema: target.schema },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: boundedFetch },
  });
  return {
    async call<Result>(operation: string, args: unknown[], instanceId: string): Promise<Result> {
      if (closed) throw new Error('feedback_storage_closed');
      if (!(operations as readonly string[]).includes(operation)) throw new Error('feedback_supabase_operation_invalid');
      let response;
      try {
        response = await sdk.rpc('botmux_feedback', {
          p_instance_id: instanceId, p_operation: operation, p_args: args,
        }).retry(false);
      } catch {
        throw new Error(mutationOperations.has(operation) ? 'feedback_supabase_outcome_unknown' : 'feedback_supabase_connection_failed');
      }
      if (response.error) {
        if (mutationOperations.has(operation) && (!response.error.code || response.status >= 500)) {
          throw new Error('feedback_supabase_outcome_unknown');
        }
        const message = response.error.message;
        throw new Error(/^feedback_[a-z_]+$/.test(message) ? message : 'feedback_supabase_operation_failed');
      }
      if (!response.data || response.data.version !== 1 || !Object.hasOwn(response.data, 'result')) {
        throw new Error(mutationOperations.has(operation) ? 'feedback_supabase_outcome_unknown' : 'feedback_supabase_response_invalid');
      }
      return response.data.result as Result;
    },
    async close(): Promise<void> {
      closed = true;
      for (const request of requests) request.abort();
      await sdk.removeAllChannels();
    },
  };
}

export async function openSupabaseFeedbackStorage(
  dataDir: string, target: SupabaseTarget, instanceId: string, transport?: typeof fetch,
): Promise<{ store: FeedbackStore; analytics: FeedbackAnalytics }> {
  const client = await openSupabaseFeedbackClient(dataDir, target, transport);
  try {
    const meta = await client.call<{ version: number; instance_id: string; state: string }>('migration_status', [], instanceId);
    if (meta.version !== 1 || meta.instance_id !== instanceId || meta.state !== 'active') {
      throw new Error('feedback_storage_target_not_active');
    }
  } catch (error) { await client.close(); throw error; }
  const lookupOperations = new Set(['getResponse', 'findDeliveryByPlatformMessage', 'findDeliveryById', 'getLatestFeedback', 'recordTurnTerminal']);
  const invoke = async (operation: string, args: unknown[]): Promise<unknown> => {
    if (operation === 'recordTurnDelivery') {
      const input = args[0] as Parameters<FeedbackStore['recordTurnDelivery']>[0];
      args = [{ ...input, context: feedbackDeliveryContext(dataDir, input) }];
    }
    const result = await client.call(operation, args, instanceId);
    return result === null && lookupOperations.has(operation) ? undefined : result;
  };
  const storeMethods: Record<string, unknown> = { close: () => client.close() };
  for (const operation of operations) {
    if (!operation.startsWith('analytics_') && !operation.startsWith('migration_')) {
      storeMethods[operation] = (...args: unknown[]) => invoke(operation, args);
    }
  }
  for (const [method, operation, property] of [
    ['tryRecordTurnTerminal', 'recordTurnTerminal', 'payload'],
    ['tryClaimFeedbackOutbox', 'claimFeedbackOutbox', 'rows'],
    ['tryStartFeedbackOutboxRequest', 'startFeedbackOutboxRequest', 'changed'],
    ['trySettleFeedbackOutboxDelivered', 'settleFeedbackOutboxDelivered', 'changed'],
    ['tryRescheduleFeedbackOutbox', 'rescheduleFeedbackOutbox', 'changed'],
    ['tryResetExpiredFeedbackOutboxClaims', 'resetExpiredFeedbackOutboxClaims', 'changed'],
  ]) {
    storeMethods[method] = async (...args: unknown[]) => ({ done: true, [property]: await invoke(operation, args) });
  }
  const analyticsMethods: Record<string, unknown> = { close: async () => {} };
  for (const method of ['summary', 'trend', 'reasons', 'deliveries']) {
    analyticsMethods[method] = (...args: unknown[]) => invoke(`analytics_${method}`, args);
  }
  return { store: storeMethods as FeedbackStore, analytics: analyticsMethods as FeedbackAnalytics };
}
