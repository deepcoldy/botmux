import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexAppRecoveryCaller, codexAppTurnFailureCode } from '../src/services/codex-app-failure.js';
import { codexAppSettlementOutcome, runnerFinalOutcome } from '../src/services/runner-final-outcome.js';
import * as recovery from '../src/services/ordinary-turn-recovery.js';
import { CODEX_CAPACITY_ERROR_CODE } from '../src/services/codex-transcript.js';
import { appRecoveryHarness } from './helpers/codex-app-capacity-harness.js';


afterEach(() => { vi.useRealTimers(); });

describe('Codex App structured capacity failure', () => {
  it('classifies only native failures and carries the same failure into durable settlement', () => {
    const error = { codexErrorInfo: 'ServerOverloaded', message: 'Selected model is at capacity. Please try a different model.' };
    const code = codexAppTurnFailureCode({ status: 'failed', error });
    expect(code).toBe(CODEX_CAPACITY_ERROR_CODE);
    expect(runnerFinalOutcome('codex-app', code)).toEqual({ status: 'failed', errorCode: code });
    expect(codexAppSettlementOutcome({ turnFailed: true, turnFailureCode: code })).toEqual({ status: 'failed', errorCode: code });
    expect(codexAppTurnFailureCode({ status: 'completed' })).toBeUndefined();
    expect(codexAppTurnFailureCode({ status: 'completed', error })).toBeUndefined();
    expect(runnerFinalOutcome('mira', code)).toEqual({ status: 'completed' });
    expect(codexAppTurnFailureCode({ status: 'failed', error: { code: 'rate_limit_exceeded', message: error.message } })).not.toBe(code);
  });

  it('classifies a failed terminal with a missing or null error object as a generic failure without throwing', () => {
    // JSON.stringify(undefined) returns undefined, so the classifier must guard
    // BEFORE descending into isCodexCapacityError (toLowerCase TypeError that
    // otherwise kills the runner). Missing key and explicit null both map to
    // the generic code; capacity text still wins when an error is present.
    expect(codexAppTurnFailureCode({ status: 'failed' })).toBe('codex_app_turn_failed');
    expect(codexAppTurnFailureCode({ status: 'failed', error: undefined })).toBe('codex_app_turn_failed');
    expect(codexAppTurnFailureCode({ status: 'failed', error: null })).toBe('codex_app_turn_failed');
    expect(codexAppTurnFailureCode({ status: 'failed', error: { codexErrorInfo: 'ServerOverloaded' } }))
      .toBe(CODEX_CAPACITY_ERROR_CODE);
  });

  it.each(['ou_other', undefined])('never borrows the current sender when exact human proof is missing: %s', sender => {
    const { ds } = appRecoveryHarness({ codexCapacityRecovery: false });
    ds.session.turnReplyContexts.om_original.replyTargetSenderIsBot = undefined;
    ds.session.replyTargets.om_original.participants = [];
    ds.session.quoteTargetSenderOpenId = sender;
    expect(codexAppRecoveryCaller(ds.session, ds.larkAppId, 'om_original')).toBeUndefined();
    expect(codexAppRecoveryCaller(ds.session, 'foreign_app', 'om_original')).toBeUndefined();
  });

  it('keeps the switch opt-in and excludes adopted/meeting sessions', () => {
    expect(appRecoveryHarness({ codexCapacityRecovery: undefined }).attached).toBe(false);
    expect(appRecoveryHarness({}, { adoptedFrom: 'foreign' }).attached).toBe(false);
    expect(appRecoveryHarness({}, { vcMeetingReceiver: {} }).attached).toBe(false);
    const h = appRecoveryHarness();
    recovery.disposeOrdinaryTurnRecovery(h.ds.session);
  });

  it('continues at most twice under the frozen original caller and prepares that turn identity first', async () => {
    vi.useFakeTimers();
    const h = appRecoveryHarness();
    recovery.beginOrdinaryTurnRecovery(h.ds.session, 'om_original'); h.fail();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(h.ds, expect.stringContaining('checkpoint'), expect.any(String), {
      trustedCaller: { requestLarkAppId: 'app_original', requestUserOpenId: 'ou_original', senderType: 'user' },
    });
    const continued = h.ds.session.ordinaryTurnRecovery.currentTurnId;
    expect(h.ds.session.turnReplyContexts[continued].replyTargetSenderOpenId).toBe('ou_original');
    h.fail(); await vi.advanceTimersByTimeAsync(45_000); h.fail();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.send).toHaveBeenCalledTimes(2); expect(h.warn).toHaveBeenCalledTimes(1);
    recovery.disposeOrdinaryTurnRecovery(h.ds.session);
  });

  it.each(['new-input', 'ctrlc', 'esc'])('cancels a pending App continuation on %s', async action => {
    vi.useFakeTimers(); const h = appRecoveryHarness();
    recovery.beginOrdinaryTurnRecovery(h.ds.session, 'om_original'); h.fail();
    if (action === 'new-input') recovery.cancelOrdinaryTurnRecoveryForUserInput(h.ds.session, 'om_new');
    else h.stop(h.ds, { type: 'term_action', key: action });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.send).not.toHaveBeenCalled();
    recovery.disposeOrdinaryTurnRecovery(h.ds.session);
  });
});
