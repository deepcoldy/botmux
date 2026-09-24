export const STREAMING_CARD_BUTTON_IDS = [
  'output',
  'terminal',
  'writeLink',
  'compact',
  'stop',
  'close',
] as const;

export type StreamingCardButtonId = typeof STREAMING_CARD_BUTTON_IDS[number];

const BUTTON_ID_BY_LOWER = new Map<string, StreamingCardButtonId>(
  STREAMING_CARD_BUTTON_IDS.map(id => [id.toLowerCase(), id]),
);

export function isStreamingCardButtonId(value: unknown): value is StreamingCardButtonId {
  return typeof value === 'string' && BUTTON_ID_BY_LOWER.has(value.trim().toLowerCase());
}

/** Keep only known button ids, preserving the canonical order and removing duplicates. */
export function normalizeHiddenStreamingCardButtons(value: unknown): StreamingCardButtonId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const selected = new Set<StreamingCardButtonId>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = BUTTON_ID_BY_LOWER.get(item.trim().toLowerCase());
    if (id) selected.add(id);
  }
  const normalized = STREAMING_CARD_BUTTON_IDS.filter(id => selected.has(id));
  return normalized.length > 0 ? [...normalized] : undefined;
}

export function resolveHiddenStreamingCardButtons(
  config: { hiddenStreamingCardButtons?: unknown },
): StreamingCardButtonId[] {
  return normalizeHiddenStreamingCardButtons(config.hiddenStreamingCardButtons) ?? [];
}

/** `/botconfig set hiddenStreamingCardButtons output,terminal,...` parser. */
export function parseHiddenStreamingCardButtonsInput(raw: string): StreamingCardButtonId[] {
  const tokens = raw.split(/[\s,，]+/).filter(Boolean);
  if (tokens.some(token => !isStreamingCardButtonId(token))) return [];
  return normalizeHiddenStreamingCardButtons(tokens) ?? [];
}
