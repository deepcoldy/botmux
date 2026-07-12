import { isValidRoleChatId } from '../core/role-resolver.js';
import { isValidRoleProfileEntryKey } from '../services/role-profile-store.js';

export const MAX_ROLE_BATCH_TARGETS = 1_000;

export interface RoleBatchTarget {
  larkAppId: string;
  chatId: string;
}

export type RoleBatchParseResult =
  | { ok: true; targets: RoleBatchTarget[] }
  | { ok: false; error: 'targets_required' | 'too_many_targets' | 'invalid_target' };

export interface RoleBatchAggregateResult {
  roles: Array<Record<string, unknown> & RoleBatchTarget>;
  errors: Array<{ larkAppId: string; status: number; error: string }>;
}

type ProxyToDaemon = (
  larkAppId: string,
  daemonPath: string,
  init: RequestInit,
) => Promise<Response>;

/** Validate and de-duplicate the browser-facing batch request before fan-out. */
export function parseRoleBatchTargets(body: unknown): RoleBatchParseResult {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { targets?: unknown }).targets)) {
    return { ok: false, error: 'targets_required' };
  }
  const rawTargets = (body as { targets: unknown[] }).targets;
  if (rawTargets.length > MAX_ROLE_BATCH_TARGETS) return { ok: false, error: 'too_many_targets' };

  const targets: RoleBatchTarget[] = [];
  const seen = new Set<string>();
  for (const raw of rawTargets) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid_target' };
    const { larkAppId, chatId } = raw as { larkAppId?: unknown; chatId?: unknown };
    if (
      typeof larkAppId !== 'string' ||
      !isValidRoleProfileEntryKey(larkAppId) ||
      typeof chatId !== 'string' ||
      !isValidRoleChatId(chatId)
    ) {
      return { ok: false, error: 'invalid_target' };
    }
    const key = `${larkAppId}\u0000${chatId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ larkAppId, chatId });
  }
  return { ok: true, targets };
}

/**
 * Collapse N browser role requests into one request per daemon. Individual
 * daemon failures are returned alongside successful role rows so one offline
 * bot does not hide profile matches for every other bot.
 */
export async function aggregateRoleBatch(
  targets: RoleBatchTarget[],
  proxyToDaemon: ProxyToDaemon,
): Promise<RoleBatchAggregateResult> {
  const byBot = new Map<string, string[]>();
  for (const target of targets) {
    const chatIds = byBot.get(target.larkAppId) ?? [];
    chatIds.push(target.chatId);
    byBot.set(target.larkAppId, chatIds);
  }

  const parts = await Promise.all([...byBot].map(async ([larkAppId, chatIds]) => {
    try {
      const upstream = await proxyToDaemon(larkAppId, '/api/roles/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatIds }),
      });
      if (!upstream.ok) {
        return {
          roles: [] as RoleBatchAggregateResult['roles'],
          error: { larkAppId, status: upstream.status, error: `upstream_http_${upstream.status}` },
        };
      }
      const body = await upstream.json().catch(() => ({})) as { roles?: unknown };
      if (!Array.isArray(body.roles)) {
        return {
          roles: [] as RoleBatchAggregateResult['roles'],
          error: { larkAppId, status: 502, error: 'invalid_upstream_response' },
        };
      }
      const requested = new Set(chatIds);
      const roles = body.roles
        .filter((role): role is Record<string, unknown> => !!role && typeof role === 'object')
        .filter(role => typeof role.chatId === 'string' && requested.has(role.chatId))
        .map(role => ({ ...role, larkAppId, chatId: role.chatId as string }));
      return { roles, error: null };
    } catch (err) {
      return {
        roles: [] as RoleBatchAggregateResult['roles'],
        error: {
          larkAppId,
          status: 502,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }));

  return {
    roles: parts.flatMap(part => part.roles),
    errors: parts.flatMap(part => part.error ? [part.error] : []),
  };
}
