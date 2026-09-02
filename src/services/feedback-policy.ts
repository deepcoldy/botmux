export type FeedbackSemantic = 'positive' | 'progress' | 'negative';
export type FeedbackButtonStyle = 'primary' | 'default' | 'danger';

/**
 * Who may click the feedback buttons.
 *  - `requester`: default, backward-compatible. Only the exact person the
 *    answer was addressed to (session owner / turn recipient) can click.
 *  - `reviewers`: an explicit allowlist of trusted human identities. Used for
 *    bot-triggered auto-analysis (Oncall/alert listeners) where the requester
 *    is another bot and no single human owner exists. Deliberately NOT
 *    "anyone in the chat" — every entry must be a verifiable human identity.
 */
export type FeedbackAudience = 'requester' | 'reviewers';

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
   * Entries are `ou_` (app-scoped open_id) or `on_` (cross-app union_id) and are
   * matched at callback time against the platform-verified operator with no
   * network lookup, so a bot sender can never satisfy an entry. Absent/empty for
   * `requester`.
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
 * A reviewer entry must be a platform-verifiable human identity. The card
 * callback only ever exposes the operator's `ou_` (app-scoped open_id) and,
 * when present/resolvable, `on_` (cross-app union_id). Matching those directly
 * needs no network call and can never be satisfied by a bot sender. We
 * deliberately accept ONLY `ou_`/`on_`: an email/mobile could not be matched at
 * callback time without a lookup and would ship as silently-dead config. Per
 * the app-scoped-open_id boundary, cross-app reviewers should use `on_`.
 */
function reviewerIdentity(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`);
  const entry = value.trim();
  if (entry.startsWith('ou_') || entry.startsWith('on_')) {
    if (entry.length < 4) throw new Error(`${path} is not a valid open_id/union_id`);
    return entry;
  }
  throw new Error(`${path} must be an ou_ open_id or on_ union_id`);
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
  if (input.audience !== undefined && input.audience !== 'requester' && input.audience !== 'reviewers') {
    throw new Error('feedback.audience must be requester or reviewers');
  }
  const audience: FeedbackAudience = input.audience === 'reviewers' ? 'reviewers' : 'requester';

  let reviewers: string[] = [];
  if (input.reviewers !== undefined) {
    reviewers = validateReviewerEntries(input.reviewers);
  }
  // `reviewers` audience is meaningless without at least one reviewer, and a
  // silently-empty allowlist would render an un-clickable control. Fail closed
  // at config time instead of shipping a dead button.
  if (audience === 'reviewers' && reviewers.length === 0) {
    throw new Error('feedback.audience "reviewers" requires a non-empty feedback.reviewers allowlist');
  }
  // A reviewers allowlist only has meaning under the reviewers audience; reject
  // the combination rather than silently ignoring it (a requester-only card
  // must never appear to have carried an allowlist).
  if (audience === 'requester' && reviewers.length > 0) {
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
