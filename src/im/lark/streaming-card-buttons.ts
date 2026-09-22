import type { Session } from '../../types.js';

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
  session?: Pick<Session, 'oneShot'>,
): StreamingCardButtonId[] {
  const configured = normalizeHiddenStreamingCardButtons(config.hiddenStreamingCardButtons) ?? [];
  if (session?.oneShot?.mode !== 'ordinary_per_message') return configured;

  // An ordinary one-shot retires itself only after terminal output and visible
  // delivery have settled. A card close callback would race that authoritative
  // lifecycle, so force the existing v2 button policy to omit it on every card
  // render while preserving all other per-bot choices.
  const hidden = new Set<StreamingCardButtonId>(configured);
  hidden.add('close');
  return STREAMING_CARD_BUTTON_IDS.filter(id => hidden.has(id));
}

/** `/botconfig set hiddenStreamingCardButtons output,terminal,...` parser. */
export function parseHiddenStreamingCardButtonsInput(raw: string): StreamingCardButtonId[] {
  const tokens = raw.split(/[\s,，]+/).filter(Boolean);
  if (tokens.some(token => !isStreamingCardButtonId(token))) return [];
  return normalizeHiddenStreamingCardButtons(tokens) ?? [];
}
