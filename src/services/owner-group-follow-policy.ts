/** Per-bot opt-in to invite the bot to groups its configured owner newly joins. */
export interface OwnerGroupFollowConfig {
  enabled?: boolean;
  excludeChatIds?: string[];
  pollIntervalSeconds?: number;
}

export function normalizeOwnerGroupFollowConfig(raw: unknown): OwnerGroupFollowConfig | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('ownerGroupFollow must be an object');
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!['enabled', 'excludeChatIds', 'pollIntervalSeconds'].includes(key)) throw new Error(`unknown ownerGroupFollow field: ${key}`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('enabled must be boolean');
  if (value.pollIntervalSeconds !== undefined && (!Number.isInteger(value.pollIntervalSeconds)
      || Number(value.pollIntervalSeconds) < 30 || Number(value.pollIntervalSeconds) > 3600)) {
    throw new Error('pollIntervalSeconds must be an integer between 30 and 3600');
  }
  if (value.excludeChatIds !== undefined && (!Array.isArray(value.excludeChatIds)
      || value.excludeChatIds.length > 1000
      || value.excludeChatIds.some(id => typeof id !== 'string' || !/^oc_[A-Za-z0-9_-]+$/.test(id)))) {
    throw new Error('excludeChatIds must contain group chat IDs');
  }
  const excludeChatIds = [...new Set(value.excludeChatIds as string[] | undefined ?? [])];
  const result: OwnerGroupFollowConfig = {
    ...(value.enabled === true ? { enabled: true } : {}),
    ...(excludeChatIds.length ? { excludeChatIds } : {}),
    ...(value.pollIntervalSeconds !== undefined && value.pollIntervalSeconds !== 60
      ? { pollIntervalSeconds: Number(value.pollIntervalSeconds) } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

const changeHandlers = new Map<string, () => void>();
export function registerOwnerGroupFollowChangeHandler(appId: string, handler: () => void): () => void {
  changeHandlers.set(appId, handler);
  return () => { if (changeHandlers.get(appId) === handler) changeHandlers.delete(appId); };
}
export function notifyOwnerGroupFollowChanged(appId: string): void {
  changeHandlers.get(appId)?.();
}
