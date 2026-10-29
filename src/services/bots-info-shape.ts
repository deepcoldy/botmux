/**
 * Runtime shape guards for the merge-written `bots-info.json` registry.
 *
 * The file is user-editable and shared across daemon processes, so TypeScript
 * annotations at its read sites are not evidence that a parsed row is safe.
 * Keep the two useful contracts separate: name-only readers deliberately
 * accept rows without an app id, while routing readers require one.
 */

export type BotsInfoObjectEntry = Record<string, unknown>;

export type BotsInfoNameEntry = BotsInfoObjectEntry & {
  botName: string;
};

export type BotsInfoRouteEntry = BotsInfoObjectEntry & {
  larkAppId: string;
  botName: string | null;
};

/** Keep only JSON object rows; null, scalars and nested arrays are malformed. */
export function botsInfoObjectEntries(value: unknown): BotsInfoObjectEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is BotsInfoObjectEntry => (
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
  ));
}

/** A row usable by readers that only build a set/index of display names. */
export function isBotsInfoNameEntry(entry: BotsInfoObjectEntry): entry is BotsInfoNameEntry {
  return typeof entry.botName === 'string' && entry.botName.trim().length > 0;
}

/** A row usable for app-id routing/indexing. */
export function isBotsInfoRouteEntry(entry: BotsInfoObjectEntry): entry is BotsInfoRouteEntry {
  return typeof entry.larkAppId === 'string'
    && entry.larkAppId.trim().length > 0
    && (entry.botName === null || typeof entry.botName === 'string');
}
