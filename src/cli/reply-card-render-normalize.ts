import { normalizeCardUsageSnapshot } from './card-usage-normalize.js';
import { normalizeReplyCardPresentation, type ReplyCardRenderSnapshot } from '../services/reply-card-render.js';

export function normalizeReplyCardRenderSnapshot(value: unknown): ReplyCardRenderSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const usage = normalizeCardUsageSnapshot(raw.usage);
  return usage ? { usage, ...normalizeReplyCardPresentation(raw) } : null;
}
