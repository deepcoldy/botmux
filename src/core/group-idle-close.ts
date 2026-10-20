export interface GroupIdleCloseSettings {
  enabled: boolean;
  duration: number;
  unit: 'days' | 'hours';
}

export const DEFAULT_GROUP_IDLE_CLOSE: Readonly<GroupIdleCloseSettings> = {
  enabled: false,
  duration: 1,
  unit: 'days',
};

export function groupIdleCloseMs(settings: GroupIdleCloseSettings): number {
  return settings.duration * (settings.unit === 'days' ? 24 : 1) * 60 * 60 * 1000;
}

/** Reject malformed writes; never coerce strings, fractions or truthy values. */
export function parseGroupIdleClose(raw: unknown): GroupIdleCloseSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('body_must_be_object');
  const value = raw as Record<string, unknown>;
  if (typeof value.enabled !== 'boolean') throw new Error('enabled_must_be_boolean');
  if (value.unit !== 'days' && value.unit !== 'hours') throw new Error('invalid_idle_close_unit');
  if (typeof value.duration !== 'number' || !Number.isSafeInteger(value.duration) || value.duration < 1) {
    throw new Error('idle_close_duration_must_be_positive_integer');
  }
  const settings: GroupIdleCloseSettings = { enabled: value.enabled, duration: value.duration, unit: value.unit };
  if (!Number.isSafeInteger(groupIdleCloseMs(settings))) throw new Error('idle_close_duration_too_large');
  return settings;
}

/** Invalid hand-edited entries fail closed, leaving auto-close disabled. */
export function normalizeGroupIdleClose(raw: unknown): Record<string, GroupIdleCloseSettings> {
  const groups: Record<string, GroupIdleCloseSettings> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return groups;
  for (const [chatId, value] of Object.entries(raw)) {
    if (!/^oc_[a-zA-Z0-9_-]+$/.test(chatId)) continue;
    try { groups[chatId] = parseGroupIdleClose(value); }
    catch { /* Invalid configuration must never authorize closing a session. */ }
  }
  return groups;
}
