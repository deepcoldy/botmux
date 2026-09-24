/**
 * Daemon-side CLI quota fallback policy.
 *
 * The configured target is a stable Lark application id.  The receiver-scoped
 * open_id used in the actual <at> tag is resolved only at send time from live
 * chat membership; config must never persist or copy an app-scoped open_id.
 */

export type QuotaFallbackKind = 'usage' | 'rate';

export const DEFAULT_QUOTA_FALLBACK_MESSAGE =
  '主 Bot 当前额度已耗尽，请接手本会话并结合上下文继续处理。';
export const MAX_QUOTA_FALLBACK_MESSAGE_LENGTH = 1_000;
export const QUOTA_FALLBACK_DEDUPE_WINDOW_MS = 5 * 60 * 1_000;

const recentQuotaFallbackEvents = new Map<string, number>();

/** Claim one source-bot/kind event across all of this daemon's sessions. */
export function claimQuotaFallbackEvent(
  sourceAppId: string,
  kind: QuotaFallbackKind,
  now = Date.now(),
): boolean {
  const cutoff = now - QUOTA_FALLBACK_DEDUPE_WINDOW_MS;
  for (const [key, claimedAt] of recentQuotaFallbackEvents) {
    if (claimedAt <= cutoff) recentQuotaFallbackEvents.delete(key);
  }
  const key = `${sourceAppId}:${kind}`;
  const claimedAt = recentQuotaFallbackEvents.get(key);
  if (claimedAt !== undefined && claimedAt > cutoff) return false;
  recentQuotaFallbackEvents.set(key, now);
  return true;
}

export function __testOnly_resetQuotaFallbackEvents(): void {
  recentQuotaFallbackEvents.clear();
}

export interface QuotaFallbackBotConfig {
  enabled: true;
  targetAppId: string;
  kinds: QuotaFallbackKind[];
  message: string;
}

export type QuotaFallbackGraphEntry = {
  larkAppId?: unknown;
  apiOnly?: unknown;
  activationPending?: unknown;
  activationDeactivating?: unknown;
  activationStarting?: unknown;
  activationCommitted?: unknown;
  quotaFallbackBot?: unknown;
};

export class QuotaFallbackCycleError extends Error {
  readonly cycle: string[];

  constructor(cycle: string[]) {
    super(
      `额度耗尽交接配置存在循环: ${cycle.join(' -> ')}。`
      + ` 请在 Dashboard「Bot 配置 → 高级 → 额度耗尽交接」中修改。`,
    );
    this.name = 'QuotaFallbackCycleError';
    this.cycle = cycle;
  }
}

export type QuotaFallbackConfigNormalization =
  | { config: QuotaFallbackBotConfig; error?: undefined }
  | { config?: undefined; error?: string };

const LARK_APP_ID_RE = /^cli_[A-Za-z0-9]+$/;
const NATIVE_AT_TAG_RE = /<\/?at(?:\s|>|$)/i;

/**
 * Normalize the optional bots.json block. Invalid enabled blocks are disabled
 * as one unit (and surfaced to the caller as an error) rather than partially
 * applying a potentially surprising handoff policy.
 */
export function normalizeQuotaFallbackBotConfig(
  raw: unknown,
  sourceAppId: string,
): QuotaFallbackConfigNormalization {
  if (raw === undefined || raw === null) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'quotaFallbackBot must be an object' };
  }

  const value = raw as Record<string, unknown>;
  // Explicit opt-in only. A disabled block is inert even if it retains draft
  // values for a later edit.
  if (value.enabled !== true) return {};

  const targetAppId = typeof value.targetAppId === 'string'
    ? value.targetAppId.trim()
    : '';
  if (!LARK_APP_ID_RE.test(targetAppId)) {
    return { error: 'quotaFallbackBot.targetAppId must be a valid cli_ application id' };
  }
  if (targetAppId === sourceAppId) {
    return { error: 'quotaFallbackBot.targetAppId must not point to the current bot' };
  }

  let kinds: QuotaFallbackKind[] = ['usage', 'rate'];
  if (value.kinds !== undefined) {
    if (!Array.isArray(value.kinds)) {
      return { error: 'quotaFallbackBot.kinds must be an array containing usage and/or rate' };
    }
    const normalized: QuotaFallbackKind[] = [];
    for (const kind of value.kinds) {
      if (kind !== 'usage' && kind !== 'rate') {
        return { error: 'quotaFallbackBot.kinds accepts only usage and rate' };
      }
      if (!normalized.includes(kind)) normalized.push(kind);
    }
    if (normalized.length === 0) {
      return { error: 'quotaFallbackBot.kinds must contain at least one limit kind' };
    }
    kinds = normalized;
  }

  const message = value.message === undefined
    ? DEFAULT_QUOTA_FALLBACK_MESSAGE
    : typeof value.message === 'string'
      ? value.message.trim()
      : '';
  if (!message) return { error: 'quotaFallbackBot.message must be a non-blank string' };
  if (message.length > MAX_QUOTA_FALLBACK_MESSAGE_LENGTH) {
    return { error: `quotaFallbackBot.message must be at most ${MAX_QUOTA_FALLBACK_MESSAGE_LENGTH} characters` };
  }
  // The daemon owns the one real mention it prepends. Config text cannot add a
  // second native mention or smuggle an arbitrary receiver-scoped open_id.
  if (NATIVE_AT_TAG_RE.test(message)) {
    return { error: 'quotaFallbackBot.message must not contain native <at> tags' };
  }

  return { config: { enabled: true, targetAppId, kinds, message } };
}

/**
 * Return every executable cycle in the local quota-fallback graph.
 *
 * The input is intentionally the raw, impending bots.json array: save/clone
 * paths can validate the exact generation they are about to commit while they
 * still hold the file lock. Pending/starting onboarding rows and apiOnly bots
 * cannot receive a Lark handoff, so they do not participate. Invalid enabled
 * blocks remain inert exactly as the runtime parser treats them, except direct
 * self-reference which is itself a cycle and is reported explicitly.
 */
export function findQuotaFallbackCycles(
  entries: readonly QuotaFallbackGraphEntry[],
): string[][] {
  const active = entries.filter(entry =>
    entry
    && typeof entry === 'object'
    && typeof entry.larkAppId === 'string'
    && entry.apiOnly !== true
    && entry.activationPending !== true
    && entry.activationDeactivating === undefined
    && entry.activationStarting === undefined
    && entry.activationCommitted === undefined,
  );
  const activeIds = new Set(active.map(entry => String(entry.larkAppId)));
  const edges = new Map<string, string>();
  for (const entry of active) {
    const sourceAppId = String(entry.larkAppId);
    const raw = entry.quotaFallbackBot;
    const rawTarget = raw && typeof raw === 'object' && !Array.isArray(raw)
      && (raw as Record<string, unknown>).enabled === true
      && typeof (raw as Record<string, unknown>).targetAppId === 'string'
      ? ((raw as Record<string, unknown>).targetAppId as string).trim()
      : '';
    if (rawTarget === sourceAppId && activeIds.has(rawTarget)) {
      edges.set(sourceAppId, rawTarget);
      continue;
    }
    const normalized = normalizeQuotaFallbackBotConfig(raw, sourceAppId).config;
    if (normalized && activeIds.has(normalized.targetAppId)) {
      edges.set(sourceAppId, normalized.targetAppId);
    }
  }

  const cycles: string[][] = [];
  const done = new Set<string>();
  for (const start of activeIds) {
    if (done.has(start)) continue;
    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let current: string | undefined = start;
    while (current && !done.has(current)) {
      const index = pathIndex.get(current);
      if (index !== undefined) {
        cycles.push([...path.slice(index), current]);
        break;
      }
      pathIndex.set(current, path.length);
      path.push(current);
      current = edges.get(current);
    }
    for (const appId of path) done.add(appId);
  }
  return cycles;
}

export function findQuotaFallbackCycle(
  entries: readonly QuotaFallbackGraphEntry[],
): string[] | null {
  return findQuotaFallbackCycles(entries)[0] ?? null;
}

export function assertQuotaFallbackGraphAcyclic(
  entries: readonly QuotaFallbackGraphEntry[],
): void {
  const cycle = findQuotaFallbackCycle(entries);
  if (cycle) throw new QuotaFallbackCycleError(cycle);
}

export type QuotaFallbackTargetResolution =
  | { ok: true; openId: string; source: 'local-peer' }
  | {
      ok: false;
      reason:
        | 'self_target'
        | 'local_resolution_failed'
        | 'target_not_local';
      detail?: string;
    };

export interface QuotaFallbackTargetDeps {
  isLocalConfigured(appId: string): boolean;
  resolveLocal(
    receiverAppId: string,
    chatId: string,
    targetAppId: string,
  ): Promise<{ ok: true; openId: string } | { ok: false; detail?: string }>;
}

/**
 * Bind a stable target app id to one live, receiver-scoped mention handle.
 * Only local peers are supported: the existing authorization-grade resolver
 * proves both the target application identity and its current chat membership.
 * A remote/team entry cannot provide an equivalent app-id-to-open-id proof, so
 * it must fail closed instead of binding an untrusted live row by display name.
 */
export async function resolveQuotaFallbackTarget(
  sourceAppId: string,
  chatId: string,
  targetAppId: string,
  deps: QuotaFallbackTargetDeps,
): Promise<QuotaFallbackTargetResolution> {
  if (sourceAppId === targetAppId) return { ok: false, reason: 'self_target' };

  if (!deps.isLocalConfigured(targetAppId)) {
    return { ok: false, reason: 'target_not_local' };
  }

  try {
    const resolved = await deps.resolveLocal(sourceAppId, chatId, targetAppId);
    if (!resolved.ok) {
      return { ok: false, reason: 'local_resolution_failed', detail: resolved.detail };
    }
    if (!resolved.openId.startsWith('ou_')) {
      return { ok: false, reason: 'local_resolution_failed', detail: 'resolved handle is not an open_id' };
    }
    return { ok: true, openId: resolved.openId, source: 'local-peer' };
  } catch (error) {
    return {
      ok: false,
      reason: 'local_resolution_failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
