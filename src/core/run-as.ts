import { resolveAllowedUsersWithMap, resolveUnionIdFromOpenId } from '../im/lark/client.js';
import { canOperate } from '../im/lark/event-dispatcher.js';
import { RUN_AS_PATTERN } from '../services/trigger-types.js';

export type RunAsResolution =
  | { ok: true; openId: string; unionId: string }
  | { ok: false; reason: 'invalid' | 'unresolved' | 'not_allowed' };

export interface RunAsDeps {
  resolveAllowedUsersWithMap: (larkAppId: string, entries: string[]) => Promise<{ map: Map<string, string> }>;
  resolveUnionIdFromOpenId: (larkAppId: string, openId: string) => Promise<string | null>;
  canOperate: (larkAppId: string, chatId: string, openId: string, unionId: string) => boolean;
}

const liveDeps: RunAsDeps = {
  resolveAllowedUsersWithMap: (larkAppId, entries) => resolveAllowedUsersWithMap(larkAppId, entries),
  resolveUnionIdFromOpenId: (larkAppId, openId) => resolveUnionIdFromOpenId(larkAppId, openId),
  canOperate: (larkAppId, chatId, openId, unionId) => canOperate(larkAppId, chatId, openId, unionId),
};

/**
 * Resolve the person a host admin names with `--run-as` / trigger `runAs` and
 * check they may operate this bot in `chatId` right now. Shared by the schedule
 * host path and the trigger API so both apply one admission rule.
 */
export async function resolveRunAs(
  larkAppId: string, chatId: string, runAs: unknown, deps: RunAsDeps = liveDeps,
): Promise<RunAsResolution> {
  if (typeof runAs !== 'string' || !RUN_AS_PATTERN.test(runAs)) return { ok: false, reason: 'invalid' };
  const openId = runAs.startsWith('ou_')
    ? runAs
    : (await deps.resolveAllowedUsersWithMap(larkAppId, [runAs])).map.get(runAs);
  const unionId = openId ? await deps.resolveUnionIdFromOpenId(larkAppId, openId) : null;
  if (!openId || !unionId) return { ok: false, reason: 'unresolved' };
  if (!deps.canOperate(larkAppId, chatId, openId, unionId)) return { ok: false, reason: 'not_allowed' };
  return { ok: true, openId, unionId };
}
