import { canonicalJson } from '../utils/canonical-input-hash.js';

export const FEEDBACK_CONTEXT_MAX_BYTES = 8192;
export const FEEDBACK_BIND_MAX_BYTES = 12288;

export type FeedbackContext = Record<string, unknown>;
export interface FeedbackSubjectBinding {
  sourceMessageId: string;
  answerKind: 'substantive' | 'clarification' | 'progress' | 'failed';
  context?: FeedbackContext;
}

export function normalizeFeedbackContext(value: unknown): FeedbackContext | undefined {
  if (value === undefined) return undefined;
  function validate(node: unknown, depth: number): void {
    if (depth > 8) throw new Error('feedback_context_depth_exceeded');
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return;
    if (typeof node === 'number' && Number.isFinite(node)) return;
    if (!node || typeof node !== 'object') throw new Error('feedback_context_invalid');
    if (!Array.isArray(node) && Object.getPrototypeOf(node) !== Object.prototype
      && Object.getPrototypeOf(node) !== null) throw new Error('feedback_context_invalid');
    for (const child of Object.values(node)) validate(child, depth + 1);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('feedback_context_invalid');
  validate(value, 1);
  const serialized = canonicalJson(value);
  if (Buffer.byteLength(serialized) > FEEDBACK_CONTEXT_MAX_BYTES) throw new Error('feedback_context_too_large');
  return JSON.parse(serialized) as FeedbackContext;
}

export function normalizeFeedbackBinding(binding: FeedbackSubjectBinding): FeedbackSubjectBinding {
  const context = normalizeFeedbackContext(binding.context);
  return {
    sourceMessageId: binding.sourceMessageId,
    answerKind: binding.answerKind,
    ...(context === undefined ? {} : { context }),
  };
}
