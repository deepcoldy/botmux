import { describe, expect, it } from 'vitest';
import { decideSubmitConfirmationAction } from '../src/services/submit-confirmation.js';

describe('decideSubmitConfirmationAction', () => {
  it('notifies immediately when the adapter reports a hard failure reason', () => {
    expect(decideSubmitConfirmationAction({
      failureReason: 'unsupported submit key',
      recheckSubmitted: false,
      usageLimitDetected: false,
      activityEvidence: undefined,
    })).toEqual({ kind: 'notify-hard-failure', reason: 'unsupported submit key' });
  });

  it('suppresses the user warning when submit is unconfirmed but later activity proves the CLI consumed it', () => {
    expect(decideSubmitConfirmationAction({
      recheckSubmitted: false,
      usageLimitDetected: false,
      activityEvidence: 'pty-output',
    })).toEqual({ kind: 'suppress-active', evidence: 'pty-output' });
  });

  it('suppresses the user warning when the deferred recheck eventually confirms the submit', () => {
    expect(decideSubmitConfirmationAction({
      recheckSubmitted: true,
      usageLimitDetected: false,
      activityEvidence: undefined,
    })).toEqual({ kind: 'suppress-confirmed' });
  });

  it('suppresses the user warning when the turn hit a usage limit instead of a stuck input', () => {
    expect(decideSubmitConfirmationAction({
      recheckSubmitted: false,
      usageLimitDetected: true,
      activityEvidence: undefined,
    })).toEqual({ kind: 'suppress-usage-limit' });
  });

  it('notifies when submit is unconfirmed and there is no later activity evidence', () => {
    expect(decideSubmitConfirmationAction({
      recheckSubmitted: false,
      usageLimitDetected: false,
      activityEvidence: undefined,
    })).toEqual({ kind: 'notify-stuck' });
  });
});
