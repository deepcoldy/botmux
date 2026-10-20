/** Ownerless sessions must authorize the current caller without acquiring a
 * permanent session owner. Both host CLI and daemon use the same allowlist join. */
export type ScheduleCreatorAuthorization =
  | { ok: true; ownerUnionId: string }
  | { ok: false; error: 'bot_unavailable' | 'caller_not_allowed' | 'caller_union_id_unresolved' };

export function authorizeOwnerlessScheduleCreator(input: {
  callerOpenId: string | undefined;
  allowedUsers: readonly string[] | undefined;
  resolutionCache: Readonly<Record<string, string>>;
  /** When available, require admission by the daemon's current resolved list too. */
  resolvedAllowedUsers?: readonly string[];
}): ScheduleCreatorAuthorization {
  if (!input.allowedUsers) return { ok: false, error: 'bot_unavailable' };
  const { callerOpenId, allowedUsers, resolutionCache, resolvedAllowedUsers } = input;
  if (!callerOpenId || !allowedUsers.some(entry =>
    (entry.startsWith('ou_') ? entry : resolutionCache[entry]) === callerOpenId)
    || (resolvedAllowedUsers !== undefined && !resolvedAllowedUsers.includes(callerOpenId))) {
    return { ok: false, error: 'caller_not_allowed' };
  }
  const matches = [...new Set(allowedUsers.filter(entry =>
    entry.startsWith('on_') && resolutionCache[entry] === callerOpenId))];
  if (matches.length !== 1) return { ok: false, error: 'caller_union_id_unresolved' };
  return { ok: true, ownerUnionId: matches[0] };
}

export function isScheduleCreatorAuthorization(value: unknown): value is ScheduleCreatorAuthorization {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.ok === true
    ? typeof result.ownerUnionId === 'string' && /^on_[A-Za-z0-9_]+$/.test(result.ownerUnionId)
    : result.ok === false && typeof result.error === 'string'
      && ['bot_unavailable', 'caller_not_allowed', 'caller_union_id_unresolved'].includes(result.error);
}

export function requireScheduleCreatorUnionId(result: ScheduleCreatorAuthorization | undefined): string {
  if (!result) throw new Error('daemon does not support schedule creator authorization; upgrade the owning daemon');
  if (result.ok) return result.ownerUnionId;
  const messages = {
    bot_unavailable: 'cannot load bot config for schedule creator authorization',
    caller_not_allowed: 'current turn caller is not an allowed bot operator',
    caller_union_id_unresolved: 'cannot resolve the current turn caller union_id',
  };
  throw new Error(messages[result.error]);
}
