export type FeedbackSemantic = 'positive' | 'progress' | 'negative';
export type FeedbackButtonStyle = 'primary' | 'default' | 'danger';

/**
 * Who may click the feedback buttons.
 *  - `requester`: default, backward-compatible. Only the exact person the
 *    answer was addressed to (session owner / turn recipient) can click.
 *  - `reviewers`: an explicit allowlist of trusted human identities. Used for
 *    bot-triggered auto-analysis (Oncall/alert listeners) where the requester
 *    is another bot and no single human owner exists. Entries may be `ou_`/`on_`
 *    ids or a full email — emails are resolved to this bot's app-scoped
 *    open_id at send time (the callback stays network-free) and frozen into the
 *    delivery snapshot. Deliberately NOT "anyone in the chat".
 *  - `everyone`: any operator whose identity the platform can verify may click.
 *    An explicit escape hatch when a chat trusts every member to give feedback
 *    (a bot sender still cannot forge a human id). No allowlist.
 */
export type FeedbackAudience = 'requester' | 'reviewers' | 'everyone';

export interface FeedbackButton {
  key: string;
  label: string;
  semantic: FeedbackSemantic;
  style: FeedbackButtonStyle;
}

export interface FeedbackReason { key: string; label: string }

export interface FeedbackPolicy {
  enabled: true;
  audience: FeedbackAudience;
  /**
   * Trusted human identities allowed to click when `audience === 'reviewers'`.
   * Config accepts `ou_`/`on_` ids and full email; email entries are
   * resolved to this bot's app-scoped open_id at send time so the callback can
   * match with no network lookup (a bot sender can never satisfy an entry).
   * Absent/empty for `requester` and `everyone`.
   */
  reviewers: string[];
  visibleSemantics: FeedbackSemantic[];
  buttons: FeedbackButton[];
  negativeFollowup: {
    reasons: FeedbackReason[];
    comment: { enabled: boolean; required: boolean; placeholder: string; maxLength: number };
  };
  allowReselect: boolean;
}

export interface FeedbackPolicyInput {
  enabled?: boolean;
  audience?: unknown;
  reviewers?: unknown;
  visibleSemantics?: unknown;
  buttons?: unknown;
  negativeFollowup?: unknown;
  allowReselect?: unknown;
}

const SEMANTICS: FeedbackSemantic[] = ['positive', 'progress', 'negative'];
const DEFAULT_BUTTONS: FeedbackButton[] = [
  { key: 'conclusive_usable', label: '结论可用', semantic: 'positive', style: 'primary' },
  { key: 'effective_progress', label: '有效推进', semantic: 'progress', style: 'default' },
  { key: 'incorrect', label: '结论有误', semantic: 'negative', style: 'danger' },
];
const KEY = /^[a-z0-9_-]+$/;

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new Error(`${path} must be 1-${max} characters`);
  return value;
}

function key(value: unknown, path: string): string {
  if (typeof value !== 'string' || !KEY.test(value)) throw new Error(`${path} key must match [a-z0-9_-]+`);
  return value;
}

function unique(values: string[], path: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${path} keys must be unique`);
}

function semantic(value: unknown, path: string): FeedbackSemantic {
  if (value !== 'positive' && value !== 'progress' && value !== 'negative') throw new Error(`${path}.semantic is invalid`);
  return value;
}

/**
 * Reviewer-entry format checks. Kept in sync (deliberately, by value) with the
 * canonical owner-allowedUsers email predicate in `setup/bot-config-editor.ts`;
 * this module stays a dependency-free leaf (it is imported by the store,
 * resolver, cli and worker-pool).
 */
const FULL_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A reviewer entry must be a human identity this bot can prove.
 *  - `ou_`/`on_` are matched directly against the platform-verified callback
 *    operator with no network call — a bot sender can never satisfy one.
 *  - A full email is human-readable and resolved to this bot's
 *    app-scoped `ou_` at SEND time (see `materializeFeedbackReviewers`); the
 *    callback still matches network-free against the frozen, resolved id.
 * A bare prefix (e.g. "alice") is rejected — same rule as owner allowedUsers.
 * Cross-app reviewers should prefer `on_` (an `ou_` is app-scoped).
 */
function reviewerIdentity(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`);
  const entry = value.trim();
  if (entry.startsWith('ou_') || entry.startsWith('on_')) {
    if (entry.length < 4) throw new Error(`${path} is not a valid open_id/union_id`);
    return entry;
  }
  if (FULL_EMAIL_RE.test(entry)) return entry;
  throw new Error(`${path} must be an ou_/on_ id or a full email`);
}

/**
 * Format-only validation of a `reviewers` allowlist for a partial config layer,
 * WITHOUT the cross-field `audience`⟺`reviewers` coupling that only the merged
 * effective policy can decide (a split team/bot/chat config may legitimately set
 * `audience` in one layer and `reviewers` in another).
 */
export function validateReviewerEntries(value: unknown, path = 'feedback.reviewers'): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  if (value.length > 50) throw new Error(`${path} allows 0-50 entries`);
  const reviewers = value.map((entry, index) => reviewerIdentity(entry, `${path}[${index}]`));
  unique(reviewers, path);
  return reviewers;
}

export function normalizeFeedbackPolicy(raw: unknown): FeedbackPolicy {
  const input = object(raw, 'feedback');
  if (input.enabled !== true) throw new Error('feedback.enabled must be true');
  if (input.audience !== undefined && input.audience !== 'requester' && input.audience !== 'reviewers' && input.audience !== 'everyone') {
    throw new Error('feedback.audience must be requester, reviewers or everyone');
  }
  const audience: FeedbackAudience = input.audience === 'reviewers' || input.audience === 'everyone'
    ? input.audience
    : 'requester';

  let reviewers: string[] = [];
  if (input.reviewers !== undefined) {
    reviewers = validateReviewerEntries(input.reviewers);
  }
  // An empty reviewers allowlist is intentional: keep the feedback control
  // visible, but let the callback identity gate reject every operator. This
  // surfaces the configured feedback affordance without widening access when
  // the trusted reviewer list has not been filled in yet.
  // A reviewers allowlist only has meaning under the reviewers audience; reject
  // the combination rather than silently ignoring it (a requester-only or
  // everyone card must never appear to have carried an allowlist).
  if (audience !== 'reviewers' && reviewers.length > 0) {
    throw new Error('feedback.reviewers requires feedback.audience "reviewers"');
  }

  let visibleSemantics = [...SEMANTICS];
  if (input.visibleSemantics !== undefined) {
    if (!Array.isArray(input.visibleSemantics) || input.visibleSemantics.length < 1 || input.visibleSemantics.length > 3) {
      throw new Error('feedback.visibleSemantics must contain 1-3 semantics');
    }
    visibleSemantics = input.visibleSemantics.map((value, index) => semantic(value, `feedback.visibleSemantics[${index}]`));
    unique(visibleSemantics, 'feedback.visibleSemantics');
  }

  let buttons = DEFAULT_BUTTONS.map(button => ({ ...button }));
  if (input.buttons !== undefined) {
    if (!Array.isArray(input.buttons) || input.buttons.length < 2 || input.buttons.length > 4) throw new Error('feedback.buttons must contain 2-4 buttons');
    buttons = input.buttons.map((rawButton, index) => {
      const button = object(rawButton, `feedback.buttons[${index}]`);
      // Compatibility boundary for legacy config and persisted policy snapshots.
      const value = button.semantic ?? button.sentiment;
      const normalizedSemantic = semantic(value, `feedback.buttons[${index}]`);
      const style = button.style ?? (normalizedSemantic === 'positive' ? 'primary' : 'default');
      if (style !== 'primary' && style !== 'default' && style !== 'danger') throw new Error(`feedback.buttons[${index}].style is invalid`);
      return { key: key(button.key, `feedback.buttons[${index}]`), label: text(button.label, `feedback.buttons[${index}].label`, 24), semantic: normalizedSemantic, style };
    });
    unique(buttons.map(button => button.key), 'feedback.buttons');
  }
  for (const required of visibleSemantics) {
    if (!buttons.some(button => button.semantic === required)) throw new Error(`feedback.buttons requires at least one ${required} button`);
  }
  if (buttons.some(button => !visibleSemantics.includes(button.semantic))) {
    throw new Error('feedback.buttons semantic must be included in feedback.visibleSemantics');
  }

  const followup = input.negativeFollowup === undefined ? {} : object(input.negativeFollowup, 'feedback.negativeFollowup');
  let reasons: FeedbackReason[] = [];
  if (followup.reasons !== undefined) {
    if (!Array.isArray(followup.reasons) || followup.reasons.length > 6) throw new Error('feedback.negativeFollowup.reasons allows 0-6 reasons');
    reasons = followup.reasons.map((rawReason, index) => {
      const reason = object(rawReason, `feedback.negativeFollowup.reasons[${index}]`);
      return { key: key(reason.key, `feedback.negativeFollowup.reasons[${index}]`), label: text(reason.label, `feedback.negativeFollowup.reasons[${index}].label`, 32) };
    });
    unique(reasons.map(reason => reason.key), 'feedback.negativeFollowup.reasons');
  }
  const rawComment = followup.comment === undefined ? {} : object(followup.comment, 'feedback.negativeFollowup.comment');
  const maxLength = rawComment.maxLength ?? 1000;
  if (!Number.isInteger(maxLength) || Number(maxLength) < 1 || Number(maxLength) > 2000) throw new Error('feedback.negativeFollowup.comment.maxLength must be 1-2000');
  const placeholder = rawComment.placeholder === undefined ? '可以补充哪里需要改进' : text(rawComment.placeholder, 'feedback.negativeFollowup.comment.placeholder', 100);
  return {
    enabled: true,
    audience,
    reviewers,
    allowReselect: input.allowReselect === true,
    visibleSemantics,
    buttons,
    negativeFollowup: {
      reasons,
      comment: { enabled: rawComment.enabled !== false, required: rawComment.required === true, placeholder, maxLength: Number(maxLength) },
    },
  };
}

export function resolveFeedbackPolicy(raw: unknown, bot?: { apiOnly?: boolean }): FeedbackPolicy | undefined {
  if (bot?.apiOnly || !raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as { enabled?: unknown }).enabled !== true) return undefined;
  return normalizeFeedbackPolicy(raw);
}

/** Whether an entry needs a send-time contact lookup to become a matchable id. */
function isResolvableReviewerEntry(entry: string): boolean {
  return !entry.startsWith('ou_') && !entry.startsWith('on_');
}

/**
 * Freeze the `reviewers` allowlist into ids the network-free callback can match.
 *
 * Email entries are human-readable config but cannot be compared against
 * a card operator without a contact lookup, so we resolve them ONCE here (at
 * send time, with the bot's own app credentials) into this bot's app-scoped
 * `ou_`, exactly like owner `allowedUsers`. `ou_`/`on_` pass through untouched.
 *
 * Fail closed by dropping only the entries this resolution could not prove:
 *  - a resolver that maps an email to an `ou_` replaces that entry;
 *  - an unresolved email is DROPPED (never shipped as a dead entry that
 *    silently gates nothing, and never left as raw text the callback can't
 *    match). If every entry drops, the caller sees an empty allowlist and the
 *    callback remains fail closed: the control stays visible, but nobody can
 *    submit feedback until a reviewer can be verified.
 *
 * `resolve` receives the raw email entries and returns a map from the
 * raw entry to a resolved `ou_` (missing key = unresolved). It is only called
 * when there is something to resolve, so `everyone`/`requester` and pure-id
 * `reviewers` policies never trigger a lookup.
 */
export async function materializeFeedbackReviewers(
  policy: FeedbackPolicy,
  resolve: (entries: string[]) => Promise<Map<string, string>>,
): Promise<FeedbackPolicy> {
  if (policy.audience !== 'reviewers') return policy;
  const pending = policy.reviewers.filter(isResolvableReviewerEntry);
  if (pending.length === 0) return policy;
  let map: Map<string, string>;
  try {
    map = await resolve(pending);
  } catch {
    // A transient resolver failure must not silently widen or dead-gate the
    // card. Drop the unresolved entries; keep any literal ids that need no
    // lookup. An all-dropped result yields an empty allowlist (the callback
    // rejects every operator), never an open one.
    map = new Map();
  }
  const seen = new Set<string>();
  const reviewers: string[] = [];
  for (const entry of policy.reviewers) {
    const resolved = isResolvableReviewerEntry(entry) ? map.get(entry) : entry;
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    reviewers.push(resolved);
  }
  return { ...policy, reviewers };
}
