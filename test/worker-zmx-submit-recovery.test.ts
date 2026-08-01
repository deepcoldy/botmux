import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

function region(startMarker: string, endMarker: string): string {
  const start = workerSource.indexOf(startMarker);
  const end = workerSource.indexOf(endMarker, start);
  expect(start, `${startMarker} not found`).toBeGreaterThanOrEqual(0);
  expect(end, `${endMarker} not found`).toBeGreaterThan(start);
  return workerSource.slice(start, end);
}

describe('worker ZMX logical submission recovery', () => {
  it('serializes capture → write → confirm/cancel in one shared transaction', () => {
    const helper = region(
      'async function runAmbiguousSubmissionTransaction',
      'type VerifiableSubmissionResult',
    );
    const wait = helper.indexOf('await previous');
    const capture = helper.indexOf('captureAmbiguousSubmissionFence(target)');
    const beforeWrite = helper.indexOf('await beforeWrite?.()', capture);
    const started = helper.indexOf('submissionStarted = true', beforeWrite);
    const write = helper.indexOf('const result = await write()', started);
    const disposition = helper.indexOf('await submissionAccepted(result)', write);
    const confirm = helper.indexOf('confirmAmbiguousSubmissionAfterSuccess(', disposition);
    const explicitCancel = helper.indexOf('cancelAmbiguousSubmissionAfterFailure(', confirm);
    const caughtCancel = helper.indexOf(
      'cancelAmbiguousSubmissionAfterFailure(',
      explicitCancel + 1,
    );
    const release = helper.lastIndexOf('release()');

    expect(helper).toContain('ambiguousSubmissionWriteTail');
    expect(wait).toBeGreaterThanOrEqual(0);
    expect(capture).toBeGreaterThan(wait);
    expect(beforeWrite).toBeGreaterThan(capture);
    expect(started).toBeGreaterThan(beforeWrite);
    expect(write).toBeGreaterThan(started);
    expect(disposition).toBeGreaterThan(write);
    expect(confirm).toBeGreaterThan(disposition);
    expect(explicitCancel).toBeGreaterThan(confirm);
    expect(caughtCancel).toBeGreaterThan(explicitCancel);
    expect(release).toBeGreaterThan(caughtCancel);
  });

  it('routes normal and adopt adapter writes through the shared transaction', () => {
    const flush = region(
      'async function flushPending(): Promise<void>',
      'function sendToPty(',
    );
    const adopt = region('// Adopt mode write:', "case 'raw_input':");

    expect(flush).toContain('runAmbiguousSubmissionTransaction(');
    expect(flush).toContain('settleVerifiableSubmissionForJournal');
    expect(flush).toContain('err instanceof SubmissionWriteError');
    expect(flush).toContain('notifyAmbiguousSubmissionRecovery(recoveryFailureReason, item)');
    expect(flush).toContain('pendingMessages.unshift(item)');
    expect(flush).toContain('ambiguousSubmissionRecoveryHold = {');
    expect(flush).toContain('!err.submissionStarted');
    expect(flush).toContain('inflightInputs.retire(item)');
    const prepareStart = flush.indexOf('const prepareNormalWrite');
    const prepareEnd = flush.indexOf('// Defense in depth:', prepareStart);
    const prepare = flush.slice(prepareStart, prepareEnd);
    expect(prepare).toContain('if (durableWrite) durableTurnInFlight = true');
    expect(prepare).toContain('inflightInputs.onWrite(item)');
    expect(flush.slice(0, prepareStart)).not.toContain('durableTurnInFlight = true');
    expect(flush.slice(0, prepareStart)).not.toContain('inflightInputs.onWrite(item)');
    expect(flush).not.toContain('captureAmbiguousSubmissionFence(');

    expect(adopt.match(/runAmbiguousSubmissionTransaction\(/g)).toHaveLength(2);
    expect(adopt).toContain('settleVerifiableSubmissionForJournal');
    expect(adopt.match(/prepareAdoptWrite,/g)).toHaveLength(2);
    expect(adopt).toContain('err instanceof SubmissionWriteError');
    expect(adopt).toContain('notifyAmbiguousSubmissionRecovery(');
    expect(adopt).toContain('!err.submissionStarted');
    expect(adopt).toContain("'zmx_recovery_blocked_before_write'");
    expect(adopt).toContain("'failed'");
    expect(adopt).not.toContain('captureAmbiguousSubmissionFence(');
  });

  it('holds definitely-unwritten normal input until restart and fences any blocked durable expiry', () => {
    const flush = region(
      'async function flushPending(): Promise<void>',
      'function sendToPty(',
    );
    const expiry = region("case 'expire_durable_turn':", "case 'reset_ambiguous_receiver':");

    expect(flush).toContain('ambiguousSubmissionRecoveryHold?.backend === backend');
    expect(flush).toContain('pendingMessages.unshift(item)');
    expect(flush).not.toContain("'zmx_recovery_blocked_before_write'");
    expect(expiry).toContain('ambiguousSubmissionRecoveryHold?.backend === backend');
    expect(expiry).not.toContain('ambiguousSubmissionRecoveryHold?.item === item');
    expect(expiry).toContain("'ZMX recovery hold blocked durable lease'");
    expect(expiry).toContain("acknowledge('cli_fenced')");
  });

  it('hands all queued durable attempts to daemon replay on natural backend exit only', () => {
    const exit = region(
      'backend.onExit((code, signal) => {',
      'stopSessionMcpGatewayHost();',
    );

    expect(exit).toContain('handoffQueuedDurableInputsOnBackendExit(');
    expect(exit).toContain('{ intentionalRestart }');
    expect(exit).toContain('handedOffDurable.includes(recoveryHeld.item)');
    expect(exit).toContain('ambiguousSubmissionRecoveryHold = null');
    expect(exit).toContain('queued durable input(s)');
  });

  it('keeps slow authoritative transcript rechecks inside the pending journal', () => {
    const settle = region(
      'async function settleVerifiableSubmissionForJournal',
      'function captureAmbiguousSubmissionFence',
    );
    const wait = settle.indexOf('SUBMIT_DEFERRED_RECHECK_MS');
    const recheck = settle.indexOf('await result.recheck()', wait);
    const confirmMutation = settle.indexOf('result.submitted = true', recheck);

    expect(wait).toBeGreaterThanOrEqual(0);
    expect(recheck).toBeGreaterThan(wait);
    expect(confirmMutation).toBeGreaterThan(recheck);
    expect(settle).toContain('if (result.failureReason || !result.recheck) return false');
  });
});
