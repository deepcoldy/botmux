import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerFinalOutputHandoff, finalOutputSnapshot, canHandoffFinalOutput, type FinalOutputOffer } from '../src/services/final-output-handoff.js';
import { appendBridgeTurnJournalEntry, readBridgeTurnJournal, stageBridgeFinalOutput, acknowledgeBridgeFinalOutput, writeBridgeTurnJournal, clearBridgeTurnJournal, removeBridgeTurnJournalEntry } from '../src/services/bridge-turn-journal.js';
import { BridgeTurnQueue } from '../src/services/bridge-turn-queue.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const app = 'cli_test';
const output = { sessionId: 'session_test', turnId: 'om_input', lastUuid: 'native-final', content: 'The answer' };
const roots: string[] = [];
function journal() {
  const root = mkdtempSync(join(tmpdir(), 'final-handoff-worker-')); roots.push(root);
  const path = join(root, 'turns.json');
  appendBridgeTurnJournalEntry(path, { turnId: output.turnId, markTimeMs: Date.now(), offsetAtMark: 0, jsonlPath: '/tmp/transcript.jsonl', handoffVersion: 1 });
  return path;
}
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('ordinary final output handoff', () => {
  it('rejects a full opening input before it can be passed as a CLI argv prompt', () => {
    const send = vi.fn();
    const scope = { finalHandoffAdmissionEnabled: true, workerFinalOutputHandoff: { size: () => 32 },
      FINAL_OUTPUT_HANDOFF_MAX_PENDING: 32, initHandoffRejectedTurnId: undefined, initialInputOwnershipPending: true, send };
    const apply = loadWorkerFunction<(cfg: any, turnId?: string) => boolean>('applyInitFinalOutputBackpressure', scope);
    const cfg = { prompt: 'must not execute' };
    expect(apply(cfg, 'om_opening')).toBe(true);
    expect(cfg.prompt).toBe('');
    expect(scope.initialInputOwnershipPending).toBe(false);
    expect(send).toHaveBeenCalledWith({ type: 'turn_input_rejected', turnId: 'om_opening', reason: 'final_output_handoff_backpressure', rejectedBeforeAdmission: true });
  });
  it('keeps one intent identity across producer replacement, but rejects changed payload', () => {
    const one = finalOutputSnapshot(app, output);
    const other = finalOutputSnapshot(app, { ...output, content: 'changed' });
    expect(other.intentId).toBe(one.intentId);
    expect(other.fingerprint).not.toBe(one.fingerprint);
    const worker = new WorkerFinalOutputHandoff({ appId: app, sessionId: output.sessionId, token: 'one', persist: vi.fn(), clear: vi.fn(), send: vi.fn(), accepted: vi.fn(), error: vi.fn() });
    worker.offer(output);
    expect(() => worker.offer({ ...output, content: 'changed' })).toThrow('conflict');
    worker.stop();
  });

  it('excludes uploads, empty output, oversized output and non-IM turns', () => {
    for (const changed of [{ content: '' }, { content: '![image](/tmp/a.png)' }, { content: 'x'.repeat(20_000) }, { turnId: 'schedule_1' }]) {
      expect(canHandoffFinalOutput({ ...output, ...changed })).toBe(false);
    }
    expect(canHandoffFinalOutput(output)).toBe(true);
  });

  it('writes the recovery snapshot before any offer and clears only an exact ACK', () => {
    const path = journal(); const offers: FinalOutputOffer[] = []; const accepted = vi.fn();
    const worker = new WorkerFinalOutputHandoff({ appId: app, sessionId: output.sessionId, token: 'generation-one',
      persist: snapshot => stageBridgeFinalOutput(path, snapshot), clear: snapshot => acknowledgeBridgeFinalOutput(path, snapshot),
      send: offer => { expect(readBridgeTurnJournal(path)[0].pendingFinal?.intentId).toBe(offer.intentId); offers.push(offer); }, accepted, error: vi.fn() });
    worker.offer(output);
    const offer = offers[0];
    expect(worker.acknowledge({ type: 'final_output_accepted', ...offer, token: 'old-generation' })).toBe(false);
    expect(worker.acknowledge({ type: 'final_output_accepted', ...offer, fingerprint: 'wrong' })).toBe(false);
    expect(readBridgeTurnJournal(path)).toHaveLength(1);
    expect(worker.acknowledge({ ...offer, type: 'final_output_accepted' })).toBe(true);
    expect(readBridgeTurnJournal(path)).toHaveLength(0);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(worker.acknowledge({ ...offer, type: 'final_output_accepted' })).toBe(false);
    worker.stop();
  });

  it('does not send when the durable snapshot write fails', () => {
    const send = vi.fn();
    const worker = new WorkerFinalOutputHandoff({ appId: app, sessionId: output.sessionId, token: 'one', persist: () => { throw new Error('disk full'); }, clear: vi.fn(), send, accepted: vi.fn(), error: vi.fn() });
    expect(() => worker.offer(output)).toThrow('disk full');
    expect(send).not.toHaveBeenCalled();
    worker.stop();
  });

  it('retries the exact output after a lost ACK and stops retrying after acceptance', async () => {
    vi.useFakeTimers(); const send = vi.fn();
    const worker = new WorkerFinalOutputHandoff({ appId: app, sessionId: output.sessionId, token: 'one', persist: vi.fn(), clear: vi.fn(), send, accepted: vi.fn(), error: vi.fn(), retryMs: 100 });
    worker.offer(output);
    await vi.advanceTimersByTimeAsync(300);
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls.every(([offer]) => JSON.stringify(offer) === JSON.stringify(send.mock.calls[0][0]))).toBe(true);
    worker.acknowledge({ ...send.mock.calls[0][0], type: 'final_output_accepted' });
    await vi.advanceTimersByTimeAsync(500);
    expect(send).toHaveBeenCalledTimes(4);
    worker.stop();
  });

  it('restores a frozen output after producer exit without invoking a business input path', () => {
    const path = journal(); const snapshot = finalOutputSnapshot(app, output);
    stageBridgeFinalOutput(path, snapshot);
    const send = vi.fn();
    const replacement = new WorkerFinalOutputHandoff({ appId: app, sessionId: output.sessionId, token: 'replacement', persist: vi.fn(), clear: vi.fn(), send, accepted: vi.fn(), error: vi.fn() });
    replacement.restore(readBridgeTurnJournal(path).map(entry => entry.pendingFinal!));
    expect(send).toHaveBeenCalledWith({ type: 'final_output_offer', version: 1, token: 'replacement', ...snapshot });
    replacement.stop();
  });

  it('pins unacknowledged output across pruning and watcher teardown', () => {
    const path = journal(); const snapshot = finalOutputSnapshot(app, output);
    stageBridgeFinalOutput(path, snapshot);
    writeBridgeTurnJournal(path, Array.from({ length: 40 }, (_, n) => ({ turnId: `om_${n}`, markTimeMs: n, jsonlPath: '/tmp/a', offsetAtMark: 0 })));
    expect(readBridgeTurnJournal(path)).toHaveLength(32);
    expect(readBridgeTurnJournal(path).find(entry => entry.pendingFinal)?.pendingFinal).toEqual(snapshot);
    clearBridgeTurnJournal(path);
    expect(readBridgeTurnJournal(path).map(entry => entry.pendingFinal)).toEqual([snapshot]);
    acknowledgeBridgeFinalOutput(path, snapshot);
    expect(readBridgeTurnJournal(path)).toHaveLength(0);
  });

  it('retains recovery when new admissions are switched off and reports a missing protocol', () => {
    const path = journal(); stageBridgeFinalOutput(path, finalOutputSnapshot(app, output));
    const send = vi.fn();
    const scope: Record<string, any> = {
      workerFinalOutputHandoff: undefined, finalHandoffAdmissionEnabled: true, finalHandoffAdmissions: new Map(),
      bridgeTurnJournalFilePath: () => path, WorkerFinalOutputHandoff, readBridgeTurnJournal,
      stageBridgeFinalOutput, acknowledgeBridgeFinalOutput, appendBridgeTurnJournalEntry,
      canAdmitFinalOutputHandoff: () => false,
      send, emitTurnTerminal: vi.fn(), log: vi.fn(),
    };
    const initialize = loadWorkerFunction<(cfg: any) => void>('initializeFinalOutputHandoff', scope);
    initialize({ larkAppId: app, sessionId: output.sessionId, finalOutputHandoff: { version: 1, token: 'replacement', admitNew: false } });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'final_output_offer', token: 'replacement' }));
    expect(scope.finalHandoffAdmissionEnabled).toBe(false);
    scope.workerFinalOutputHandoff.stop(); send.mockClear();
    initialize({ larkAppId: app, sessionId: output.sessionId });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'user_notify', turnId: output.turnId }));
    expect(readBridgeTurnJournal(path)).toHaveLength(1);
  });

  it('refuses a new admission instead of silently evicting it when all journal slots are pinned', () => {
    const path = journal();
    const pending = Array.from({ length: 32 }, (_, n) => {
      const snapshot = finalOutputSnapshot(app, { ...output, turnId: `om_old_${n}`, lastUuid: `uuid_${n}` });
      return { turnId: snapshot.output.turnId, handoffVersion: 1 as const, pendingFinal: snapshot, markTimeMs: Date.now(), jsonlPath: '/tmp/a', offsetAtMark: 0 };
    });
    writeBridgeTurnJournal(path, pending);
    const admission = { turnId: 'om_new', handoffVersion: 1 as const, markTimeMs: Date.now(), jsonlPath: '/tmp/a', offsetAtMark: 0 };
    expect(() => appendBridgeTurnJournalEntry(path, admission)).toThrow('backpressure');
    expect(readBridgeTurnJournal(path)).toHaveLength(32);
    const scope = { finalHandoffAdmissions: new Map(), finalHandoffAdmissionEnabled: true, canAdmitFinalOutputHandoff: () => true, FINAL_OUTPUT_HANDOFF_MAX_PENDING: 32,
      workerFinalOutputHandoff: { hasTurn: () => false }, bridgeTurnJournalFilePath: () => path, appendBridgeTurnJournalEntry, log: vi.fn() };
    const mark = loadWorkerFunction<(entry: any) => void>('journalBridgeTurnMark', scope);
    mark(admission);
    expect(scope.finalHandoffAdmissions.has(admission.turnId)).toBe(true);
    expect(scope.log).toHaveBeenCalled();
    // Releasing an exact acknowledged slot permits the retained admission.
    acknowledgeBridgeFinalOutput(path, pending[0].pendingFinal);
    appendBridgeTurnJournalEntry(path, scope.finalHandoffAdmissions.get(admission.turnId)!);
    expect(readBridgeTurnJournal(path).some(entry => entry.turnId === admission.turnId)).toBe(true);
  });

  it('offers a completed final after an ACK frees a full admission budget', () => {
    const path = journal();
    const pending = Array.from({ length: 32 }, (_, n) => {
      const snapshot = finalOutputSnapshot(app, { ...output, turnId: `om_old_${n}`, lastUuid: `uuid_${n}` });
      return { turnId: snapshot.output.turnId, handoffVersion: 1 as const, pendingFinal: snapshot, markTimeMs: Date.now(), jsonlPath: '/tmp/a', offsetAtMark: 0 };
    });
    writeBridgeTurnJournal(path, pending);
    const send = vi.fn();
    const scope: Record<string, any> = {
      workerFinalOutputHandoff: undefined, finalHandoffAdmissionEnabled: true,
      finalHandoffAdmissions: new Map(pending.map(entry => [entry.turnId, entry])), FINAL_OUTPUT_HANDOFF_MAX_PENDING: 32,
      canAdmitFinalOutputHandoff: () => true,
      WorkerFinalOutputHandoff, bridgeTurnJournalFilePath: () => path, readBridgeTurnJournal,
      appendBridgeTurnJournalEntry, stageBridgeFinalOutput, acknowledgeBridgeFinalOutput, send, emitTurnTerminal: vi.fn(), log: vi.fn(),
    };
    loadWorkerFunction<(cfg: any) => void>('initializeFinalOutputHandoff', scope)({ larkAppId: app, sessionId: output.sessionId, finalOutputHandoff: { token: 'one', version: 1, admitNew: true } });
    const worker = scope.workerFinalOutputHandoff as WorkerFinalOutputHandoff;
    loadWorkerFunction<(entry: any) => void>('journalBridgeTurnMark', scope)({ turnId: 'om_new', markTimeMs: Date.now(), jsonlPath: '/tmp/a', offsetAtMark: 0 });
    const fresh = { ...output, turnId: 'om_new', lastUuid: 'new-final' };
    expect(() => worker.offer(fresh)).toThrow('backpressure');
    worker.acknowledge({ ...pending[0].pendingFinal, type: 'final_output_accepted', token: 'one' });
    worker.offer(fresh);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'final_output_offer', output: fresh }));
    expect(readBridgeTurnJournal(path).find(entry => entry.turnId === 'om_new')?.pendingFinal?.output).toEqual(fresh);
    worker.stop();
  });

  it('preserves the real emitReadyTurns journal when interrupted before final_output IPC', () => {
    const path = journal(); const queue = new BridgeTurnQueue();
    queue.mark(output.turnId);
    queue.ingest([
      { type: 'user', uuid: 'u', message: { role: 'user', content: 'question' } },
      { type: 'assistant', uuid: 'a', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
    ]);
    const send = vi.fn();
    const emit = loadWorkerFunction<() => void>('emitReadyTurns', {
      bridgeQueue: queue, workerFinalOutputHandoff: {}, bridgeTurnJournalFilePath: () => path, readBridgeTurnJournal,
      finalHandoffAdmissionEnabled: false,
      journalBridgeTurnClear: (id: string) => { writeBridgeTurnJournal(path, readBridgeTurnJournal(path).filter(entry => entry.turnId !== id)); },
      bridgeFingerprintScanLastMs: new Map(), lastInitConfig: { adoptMode: false },
      readSendMarkers: () => { throw new Error('SIMULATED_PROCESS_EXIT'); }, log: vi.fn(), send,
    });
    expect(emit).toThrow('SIMULATED_PROCESS_EXIT');
    expect(readBridgeTurnJournal(path)).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns drained turns to the actual queue when downstream ownership was not committed', () => {
    const queue = new BridgeTurnQueue();
    queue.mark('om_a'); queue.mark('om_b');
    queue.ingest([{ type: 'user', uuid: 'u', message: { role: 'user', content: 'q' } }, { type: 'assistant', uuid: 'a', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } }]);
    const drained = queue.drainEmittable({ terminalBoundary: true });
    queue.restoreDrained(drained);
    expect(queue.peek().map(turn => turn.turnId)).toEqual(['om_a', 'om_b']);
    queue.restoreDrained(drained);
    expect(queue.peek().map(turn => turn.turnId)).toEqual(['om_a', 'om_b']);
  });
});
