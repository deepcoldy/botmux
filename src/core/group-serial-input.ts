/** Only explicit booleans on valid group IDs can enable serial input. */
export function normalizeGroupSerialInput(raw: unknown): Record<string, boolean> {
  const groups: Record<string, boolean> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return groups;
  for (const [chatId, enabled] of Object.entries(raw)) {
    if (/^oc_[a-zA-Z0-9_-]+$/.test(chatId) && typeof enabled === 'boolean') groups[chatId] = enabled;
  }
  return groups;
}

export function parseGroupSerialInput(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || typeof (raw as { enabled?: unknown }).enabled !== 'boolean') throw new Error('enabled_must_be_boolean');
  return (raw as { enabled: boolean }).enabled;
}
