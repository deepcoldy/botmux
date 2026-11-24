import { rmwBotEntry } from './config-store.js';
import {
  deferredScopesToBuckets,
  normalizeApprovalDeferredScopes,
  type ApprovalDeferredScopeBuckets,
  type DeferredApprovalScope,
} from '../setup/approval-scope-resolver.js';

export function approvalAutomationOptionsForBot(config: {
  approvalDeferredScopes?: ApprovalDeferredScopeBuckets;
  autoAvoidApproval?: boolean;
}): {
  excludeScopes: ApprovalDeferredScopeBuckets | undefined;
  autoAvoidApproval: boolean;
} {
  return {
    excludeScopes: config.approvalDeferredScopes,
    autoAvoidApproval: config.autoAvoidApproval !== false,
  };
}

export function mergeApprovalDeferredScopeBuckets(
  ...sources: Array<ApprovalDeferredScopeBuckets | undefined>
): ApprovalDeferredScopeBuckets | undefined {
  return normalizeApprovalDeferredScopes({
    tenant: sources.flatMap(source => source?.tenant ?? []),
    user: sources.flatMap(source => source?.user ?? []),
  });
}

/**
 * Merge newly discovered deferrals into the latest bots.json entry.
 *
 * This is deliberately union-only: daemon self-healing and VC preflight run with
 * partial manifests, so a clean run proves nothing about historical deferrals
 * outside that manifest. Only a full configure flow may clear those records.
 */
export async function persistNewApprovalDeferredScopes(
  larkAppId: string,
  deferred: readonly DeferredApprovalScope[],
  options: {
    path?: string;
    onCommitted?: (buckets: ApprovalDeferredScopeBuckets) => void | Promise<void>;
  } = {},
): Promise<
  | { ok: true; buckets: ApprovalDeferredScopeBuckets | undefined }
  | { ok: false; reason: string }
> {
  const incoming = deferredScopesToBuckets(deferred);
  if (!incoming) return { ok: true, buckets: undefined };
  try {
    const result = await rmwBotEntry(larkAppId, entry => {
      const existing = normalizeApprovalDeferredScopes(entry.approvalDeferredScopes);
      const merged = mergeApprovalDeferredScopeBuckets(existing, incoming)!;
      const changed = JSON.stringify(existing ?? null) !== JSON.stringify(merged);
      if (changed) entry.approvalDeferredScopes = merged;
      return { write: changed, result: merged };
    }, { ...(options.path ? { path: options.path } : {}) });
    if (!result.ok) return { ok: false, reason: result.reason };
    await options.onCommitted?.(result.result);
    return { ok: true, buckets: result.result };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
