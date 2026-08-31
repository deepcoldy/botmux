import {
  normalizeReplyStyleConfig,
  type NormalizedReplyStyleResult,
  type ReplyStyleConfig,
} from '../im/lark/reply-card-style.js';

/** Plenty for the canonical 4096-code-point prompt plus five short labels,
 * while preventing an authenticated Dashboard request from buffering an
 * arbitrarily large cosmetic payload in either proxy process. */
export const REPLY_STYLE_REQUEST_MAX_BYTES = 32 * 1024;

/**
 * Dashboard/API canonical form: validate fail-soft, then remove top-level
 * values that merely restate built-in defaults. Nested layout values remain
 * explicit because they intentionally pin a color/tag across theme changes.
 */
export function normalizeSparseReplyStyleConfig(raw: unknown): NormalizedReplyStyleResult {
  const normalized = normalizeReplyStyleConfig(raw);
  if (!normalized.config) return normalized;
  const config: ReplyStyleConfig = { ...normalized.config };
  if (config.recipes === true) delete config.recipes;
  if (config.layout === true) delete config.layout;
  if (config.theme === 'default') delete config.theme;
  return Object.keys(config).length > 0
    ? { config, warnings: normalized.warnings }
    : { warnings: normalized.warnings };
}
