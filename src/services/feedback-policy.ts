export type FeedbackSemantic = 'positive' | 'progress' | 'negative';
export type FeedbackButtonStyle = 'primary' | 'default' | 'danger';

export interface FeedbackButton {
  key: string;
  label: string;
  semantic: FeedbackSemantic;
  style: FeedbackButtonStyle;
}

export interface FeedbackReason { key: string; label: string }

export interface FeedbackPolicy {
  enabled: true;
  audience: 'requester';
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

export function normalizeFeedbackPolicy(raw: unknown): FeedbackPolicy {
  const input = object(raw, 'feedback');
  if (input.enabled !== true) throw new Error('feedback.enabled must be true');
  if (input.audience !== undefined && input.audience !== 'requester') throw new Error('feedback.audience must be requester');

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
    audience: 'requester',
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
