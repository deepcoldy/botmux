export type SupervisionReviewStage = 'completion' | 'acceptance';

export type SupervisionAssessment =
  | { verdict: 'ready' }
  | { verdict: 'accepted'; evidence: string[] }
  | { verdict: 'rework'; missing: number[]; reason: string }
  | { verdict: 'wait'; reason: string; evidence: string; minutes: number }
  | { verdict: 'needs_user'; reason: string; decision?: SupervisionDecision };

export interface SupervisionDecision {
  question: string;
  options: string[];
  recommended?: number;
}

export function supervisionCriteria(criteria: string): string[] {
  const lines = criteria.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  // Treat unusually long lists as one composite criterion without dropping any text.
  return lines.length <= 20 ? lines : [criteria];
}

export function supervisionAssessmentSchema(stage: SupervisionReviewStage) {
  const keys = {
    verdict: { type: 'string', enum: [stage === 'completion' ? 'ready' : 'accepted', 'rework', 'wait', 'needs_user'] },
    reason: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    missing: { type: 'array', items: { type: 'integer' } },
    minutes: { type: 'integer' },
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
    recommended: { type: 'integer' },
  };
  return { type: 'object', properties: keys, required: Object.keys(keys), additionalProperties: false };
}

function reviewText(raw: unknown, limit = 320): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit);
}

export function parseSupervisionAssessment(
  value: unknown, stage: SupervisionReviewStage, criteria: string, answer: string,
): SupervisionAssessment | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const reason = reviewText(raw.reason);
  const count = supervisionCriteria(criteria).length;
  const evidence = Array.isArray(raw.evidence) ? raw.evidence.map(item => reviewText(item, 400)) : [];
  const source = answer.replace(/\s+/g, ' ');
  const anchored = (quote: string) => !!quote && source.includes(quote.replace(/\s+/g, ' '));
  if (raw.verdict === 'ready' && stage === 'completion') return { verdict: 'ready' };
  if (raw.verdict === 'accepted' && stage === 'acceptance') {
    if (count && evidence.length === count && evidence.every(anchored)) return { verdict: 'accepted', evidence };
    return { verdict: 'needs_user', reason: '' };
  }
  if (raw.verdict === 'wait') {
    const quote = evidence[0];
    if (quote && anchored(quote) && reason && typeof raw.minutes === 'number' && Number.isInteger(raw.minutes)) {
      return { verdict: 'wait', evidence: quote, reason, minutes: Math.max(5, Math.min(raw.minutes, 60)) };
    }
    return { verdict: 'needs_user', reason: '' };
  }
  if (raw.verdict === 'rework') {
    const missing: number[] = Array.isArray(raw.missing) ? [...new Set(raw.missing)] : [];
    if (missing.length && missing.every(index => Number.isInteger(index) && index >= 1 && index <= count)) {
      return { verdict: 'rework', missing, reason };
    }
    return { verdict: 'needs_user', reason: '' };
  }
  if (raw.verdict === 'needs_user') {
    const question = reviewText(raw.question);
    const options = Array.isArray(raw.options) ? raw.options.map(item => reviewText(item, 160)) : [];
    const recommended = typeof raw.recommended === 'number' && Number.isInteger(raw.recommended)
      && raw.recommended > 0 && raw.recommended <= options.length ? raw.recommended : undefined;
    const decision = question && options.length >= 2 && options.length <= 4
      && options.every(Boolean) && new Set(options).size === options.length
      ? { question, options, recommended } : undefined;
    return { verdict: 'needs_user', reason, decision };
  }
  return undefined;
}
