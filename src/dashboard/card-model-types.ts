/**
 * Shared pure-type primitives for dashboard card models (PR1).
 *
 * Zero runtime — only `interface` and string-literal unions. Imported as
 * `import type { ... }` by every dashboard card model so the model layer
 * stays erasable and IO-free.
 */

/** Pagination query input shared by list-style modules (sessions/workflows/groups/schedules). */
export interface PaginationParams {
  /** 1-based page index. Values < 1 are coerced to 1; values > totalPages coerce to totalPages. */
  page?: number;
  /** Page size; values < 1 coerce to default 20; values > 100 coerce to 100. */
  pageSize?: number;
}

/** Pagination metadata returned alongside paged results. */
export interface PaginationMeta {
  /** Active 1-based page after clamp. */
  page: number;
  /** Page size after clamp. */
  pageSize: number;
  /** Filtered total before slicing. */
  total: number;
  /** Math.max(1, Math.ceil(total / pageSize)). */
  totalPages: number;
}

/** Semantic status dot — color tone + animation flag + i18n-free label key. */
export interface StatusDot {
  /** Semantic color token; renderer maps to concrete hex. */
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  /** True hints the renderer to apply a pulsing animation. */
  pulse: boolean;
  /** Short label key; renderer translates via t(). */
  label: string;
}

/** Action button availability — enabled flag plus optional i18n reason for tooltips. */
export interface ButtonState {
  enabled: boolean;
  /** Optional i18n key explaining why the button is disabled. */
  reasonKey?: string;
}

/** Explicit "now" injection — keeps relative-time formatters pure and deterministic. */
export interface NowContext {
  /** Epoch milliseconds representing the current instant. */
  nowMs: number;
}

/** Section limit option bag — caps items per section (default 5, clamp [1, 50]). */
export interface SectionLimit {
  limit?: number;
}
