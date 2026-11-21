import type { AskQuestion, PendingAsk } from './ask-types.js';

export const ASK_CUSTOM_MAX_LENGTH = 1000;
export const ASK_CUSTOM_TOTAL_LENGTH = 2000;
/** Only general question origins. Host-owned security/identity approvals stay closed. */
export function supportsAskCustomInput(ask: Pick<PendingAsk, 'originKind' | 'questions'>): boolean {
  return !ask.questions.some(q => q.input) && ['explicit', 'host_explicit', 'hook', 'native-user-input', 'native-user-input-async'].includes(ask.originKind ?? '')
    && ask.questions.some(q => q.allowCustom !== false);
}

/** Missing fields preserve server drafts; malformed/foreign fields reject the whole action. */
export function parseAskCustomFields(
  fields: Record<string, unknown>, questions: ReadonlyArray<AskQuestion>, previous: ReadonlyArray<string | null> = [],
): Array<string | null> | null {
  const next = questions.map((q, i) => q.allowCustom === false ? null : previous[i] ?? null);
  for (const [name, value] of Object.entries(fields)) {
    const match = /^custom_(0|[1-9]\d*)$/.exec(name);
    if (!match) return null;
    const i = Number(match[1]);
    if (!questions[i] || questions[i].allowCustom === false || typeof value !== 'string' || value.length > ASK_CUSTOM_MAX_LENGTH) return null;
    next[i] = value.trim() || (previous[i] === '' ? '' : null);
  }
  return next.reduce((sum, text) => sum + (text?.length ?? 0), 0) <= ASK_CUSTOM_TOTAL_LENGTH ? next : null;
}
