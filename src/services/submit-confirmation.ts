export type SubmitActivityEvidence = 'pty-output' | 'structured-transcript' | 'botmux-send';

export type SubmitConfirmationAction =
  | { kind: 'notify-hard-failure'; reason: string }
  | { kind: 'suppress-confirmed' }
  | { kind: 'suppress-usage-limit' }
  | { kind: 'suppress-active'; evidence: SubmitActivityEvidence }
  | { kind: 'notify-stuck' };

export interface SubmitConfirmationDecisionInput {
  failureReason?: string;
  recheckSubmitted: boolean;
  usageLimitDetected: boolean;
  activityEvidence?: SubmitActivityEvidence;
}

export function decideSubmitConfirmationAction(input: SubmitConfirmationDecisionInput): SubmitConfirmationAction {
  if (input.failureReason) return { kind: 'notify-hard-failure', reason: input.failureReason };
  if (input.recheckSubmitted) return { kind: 'suppress-confirmed' };
  if (input.usageLimitDetected) return { kind: 'suppress-usage-limit' };
  if (input.activityEvidence) return { kind: 'suppress-active', evidence: input.activityEvidence };
  return { kind: 'notify-stuck' };
}
