import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UniversalOutputHandoff, outputSnapshot, type OutputHandoffReceipt } from '../src/services/universal-output-handoff.js';
import { WorkerOutputJournal } from '../src/services/worker-output-journal.js';
import { OutputDeliveryJournal, type OutputDeliveryRecord } from '../src/services/output-delivery-journal.js';
import { OutputDeliveryCoordinator } from '../src/services/output-delivery-coordinator.js';
import { TurnSendLedger } from '../src/services/turn-send-ledger.js';
import { loadWorkerPoolClosure, loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';
import { committedCodexAppSequence, hasUnsettledCodexAppDispatch } from '../src/utils/codex-app-dispatch-ledger.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import type { WorkerFinalOutput } from '../src/types.js';

const app = 'cli_universal';
const output: WorkerFinalOutput = { type: 'final_output', sessionId: 'session_one', turnId: 'om_turn', lastUuid: 'native_final', content: 'answer' };
const directories: string[] = [];
const dbs: OutputDeliveryJournal[] = [];
function directory() { const value = mkdtempSync(join(tmpdir(), 'universal-output-test-')); directories.push(value); return value; }
function database(dir = directory()) { const journal = new OutputDeliveryJournal(dir, app); dbs.push(journal); return journal; }
function receipt(sent: WorkerFinalOutput): OutputHandoffReceipt { return { type: 'final_output_settled', ...sent.handoff! }; }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const db of dbs.splice(0)) try { db.close(); } catch {} for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('universal output recovery', () => {
  it('persists the full envelope before IPC and replays it after replacement', () => {
    const dir = directory(); const journal = new WorkerOutputJournal(dir, app, output.sessionId!);
    const sent: WorkerFinalOutput[] = [];
    const first = new UniversalOutputHandoff({ appId: app, sessionId: output.sessionId!, token: 'old', persist: snap => journal.save(snap), remove: snap => journal.remove(snap), restore: () => journal.readPending(), send: () => { expect(journal.readPending()).toHaveLength(1); throw new Error('EPIPE'); }, error: vi.fn() });
    const full = { ...output, content: '长'.repeat(10000) + '\n![image](https://example.com/a.png)', replyTurnId: 'om_original', dispatchAttempt: 2, terminalLocal: true, kind: 'local-turn' as const, userText: 'question', turnFailed: true, turnFailureCode: 'provider_failed' };
    first.publish(full); first.stop();
    const replacement = new UniversalOutputHandoff({ appId: app, sessionId: output.sessionId!, token: 'new', persist: snap => journal.save(snap), remove: snap => journal.remove(snap), restore: () => journal.readPending(), send: msg => sent.push(msg), error: vi.fn() });
    replacement.start();
    expect(sent[0]).toMatchObject(full);
    expect(replacement.acknowledge({ ...receipt(sent[0]), token: 'old' })).toBe(false);
    expect(journal.readPending()).toHaveLength(1);
    expect(replacement.acknowledge(receipt(sent[0]))).toBe(true);
    expect(journal.readPending()).toHaveLength(0); replacement.stop();
  });

  it('retains the worker copy when ACK cleanup fails and retries exact content', async () => {
    vi.useFakeTimers(); const dir = directory(); const journal = new WorkerOutputJournal(dir, app, output.sessionId!); const send = vi.fn(); let failed = true;
    const bridge = new UniversalOutputHandoff({ appId: app, sessionId: output.sessionId!, token: 'one', persist: snap => journal.save(snap), remove: snap => { if (failed) throw new Error('EIO'); journal.remove(snap); }, restore: () => journal.readPending(), send, error: vi.fn(), retryMs: 10 });
    bridge.publish(output); expect(() => bridge.acknowledge(receipt(send.mock.calls[0][0]))).toThrow('EIO');
    await vi.advanceTimersByTimeAsync(11); expect(send).toHaveBeenCalledTimes(2); failed = false;
    bridge.acknowledge(receipt(send.mock.calls[1][0])); bridge.stop(); expect(journal.readPending()).toEqual([]);
  });

  it('refreshes native ACK address without changing content or effect identity, including settled rows', () => {
    const db = database(); const native = { ...output, codexAppSettlement: { requestId: 'old', generation: 'generation-3', seq: 4, dispatchId: 'dispatch' } };
    const first = outputSnapshot(app, native); const next = outputSnapshot(app, { ...native, lastUuid: 'rehydrated', durationMs: 10, codexAppSettlement: { ...native.codexAppSettlement, requestId: 'new' } });
    expect(next.id).toBe(first.id); expect(next.fingerprint).toBe(first.fingerprint);
    db.accept(first, { kind: 'managed' }); const owner = db.newOwner(); db.claim(first.id, owner); db.complete(first.id, owner, { status: 'delegated', owner: 'codex_app_dispatch_persisted' });
    const refreshed = db.accept(next, { kind: 'http', mode: 'wait' });
    expect(refreshed.output.codexAppSettlement?.requestId).toBe('new'); expect(refreshed.sink.kind).toBe('managed'); expect(refreshed.state).toBe('settled');
  });

  it('never acknowledges before adapter persistence and journal settlement both succeed', async () => {
    const db = database(); const record = db.accept(outputSnapshot(app, output), { kind: 'http', mode: 'async' }); const coordinator = new OutputDeliveryCoordinator(db); const settled = vi.fn();
    await coordinator.deliver(record, { owns: () => true, process: async () => { throw new Error('ENOSPC'); }, settled, error: vi.fn() });
    expect(settled).not.toHaveBeenCalled(); expect(db.read(record.id)?.state).toBe('blocked');
  });

  it('deduplicates overlapping deliveries and only ACKs the committed receipt', async () => {
    const db = database(); const record = db.accept(outputSnapshot(app, output), { kind: 'managed' }); const coordinator = new OutputDeliveryCoordinator(db); let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; }); const process = vi.fn(async () => { await blocked; return { status: 'delivered' as const, messageId: 'om_result' }; }); const settled = vi.fn();
    const deps = { owns: () => true, process, settled, error: vi.fn() }; const first = coordinator.deliver(record, deps); await coordinator.deliver(record, deps); expect(process).toHaveBeenCalledTimes(1); release(); await first;
    await coordinator.deliver(record, deps); expect(process).toHaveBeenCalledTimes(1); expect(settled).toHaveBeenCalledTimes(2);
  });

  it('keeps each completed document block and does not replay an unknown request', async () => {
    vi.useFakeTimers(); const db = database(); const record = db.accept(outputSnapshot(app, output), { kind: 'doc', context: { commentId: 'original' } }); const coordinator = new OutputDeliveryCoordinator(db); const writes: number[] = []; const settled = vi.fn();
    const process = async (_record: OutputDeliveryRecord, control: Parameters<Parameters<typeof coordinator.deliver>[1]['process']>[1]) => {
      for (const i of [0, 1]) await control.effect(`doc:${i}`, async hooks => { hooks.providerRequestStarted(); writes.push(i); if (i === 1) throw new Error('receipt lost'); return 'reply-0'; });
      return { status: 'captured' as const };
    };
    const deps = { owns: () => true, process, settled, error: vi.fn() };
    await coordinator.deliver(record, deps); await vi.advanceTimersByTimeAsync(5001); await coordinator.deliver(record, deps);
    expect(writes).toEqual([0, 1]); expect(settled).not.toHaveBeenCalled(); expect(db.read(record.id)?.reason).toContain('unknown');
  });

  it('checks cancellation at each document effect, retains successful evidence and permits a safe remaining block', async () => {
    vi.useFakeTimers(); const db = database(); const record = db.accept(outputSnapshot(app, output), { kind: 'doc', context: {} }); const coordinator = new OutputDeliveryCoordinator(db); let allowed = true; const writes: number[] = [];
    const process = async (_record: OutputDeliveryRecord, control: Parameters<Parameters<typeof coordinator.deliver>[1]['process']>[1]) => {
      for (const i of [0, 1]) await control.effect(`doc:${i}`, async hooks => { hooks.providerRequestStarted(); writes.push(i); if (i === 0) allowed = false; return `reply-${i}`; });
      return { status: 'captured' as const };
    };
    const deps = { owns: () => allowed, process, settled: vi.fn(), error: vi.fn() };
    await coordinator.deliver(record, deps); expect(writes).toEqual([0]); allowed = true;
    await vi.advanceTimersByTimeAsync(5001); await coordinator.deliver(record, { ...deps, process: async (_r, control) => { await control.effect('doc:0', async () => { throw new Error('duplicate'); }); await control.effect('doc:1', async hooks => { hooks.providerRequestStarted(); writes.push(1); return 'reply-1'; }); return { status: 'captured' }; } });
    expect(writes).toEqual([0, 1]); expect(db.read(record.id)?.state).toBe('settled');
  });

  it('retains original HTTP/private routing and rejects payload conflicts after reopening', () => {
    const dir = directory(); const db = database(dir); db.rememberSink(output.sessionId!, output.turnId, { kind: 'http', mode: 'wait' }); db.accept(outputSnapshot(app, output), { kind: 'http', mode: 'wait' }); db.close(); const reopened = database(dir);
    expect(reopened.sink(output.sessionId!, output.turnId)).toEqual({ kind: 'http', mode: 'wait' });
    expect(reopened.accept(outputSnapshot(app, output), { kind: 'im', context: { target: { mode: 'plain', chatId: 'oc_wrong' } }, chatId: 'oc_wrong', chatType: 'group', privateReply: true }).sink.kind).toBe('http');
    expect(() => reopened.accept(outputSnapshot(app, { ...output, content: 'different' }), { kind: 'managed' })).toThrow('conflict');
  });

  it('shares final publication fencing with explicit sends before taking the card lock', async () => {
    const ledger = new TurnSendLedger(directory()); const key = { larkAppId: app, sessionId: output.sessionId!, turnId: output.turnId }; const explicit = vi.fn(async () => 'om_explicit');
    await ledger.execute(key, 'final', 'explicit', explicit, { fenced: true });
    const bridge = vi.fn(async () => 'om_duplicate'); const result = await ledger.execute(key, 'final', 'bridge', bridge, { fenced: true, reuseExistingFinal: true });
    expect(result.messageId).toBe('om_explicit'); expect(bridge).not.toHaveBeenCalled();
  });
});

describe('worker production IPC boundary', () => {
  it('routes every final producer through durable publication and keeps workflow completion behind the write', () => {
    const ipc = vi.fn(); const publish = vi.fn();
    const scope: any = { closeRequested: false, log: vi.fn(), workerIpcPayload: (msg: WorkerFinalOutput) => msg,
      isWorkflowWorker: () => true, workflowFinalOutputSent: false, process: { send: ipc },
      universalOutputHandoff: { publish }, lastInitConfig: { finalOutputHandoff: { version: 2, admitNew: true } } };
    const send = loadWorkerFunction<(msg: unknown) => void>('send', scope);
    send(output); expect(publish).toHaveBeenCalledWith(output); expect(ipc).not.toHaveBeenCalled(); expect(scope.workflowFinalOutputSent).toBe(true);
    scope.workflowFinalOutputSent = false; publish.mockImplementationOnce(() => { throw new Error('ENOSPC'); });
    expect(() => send(output)).toThrow('ENOSPC'); expect(scope.workflowFinalOutputSent).toBe(false);
    send({ type: 'turn_terminal', turnId: 'turn' }); expect(ipc).toHaveBeenCalledOnce();
    scope.closeRequested = true; send(output); expect(publish).toHaveBeenCalledTimes(2);
  });
  it('keeps a failed pre-IPC write in memory and retries persistence before sending', async () => {
    vi.useFakeTimers(); const persist = vi.fn().mockImplementationOnce(() => { throw new Error('ENOSPC'); }); const send = vi.fn();
    const bridge = new UniversalOutputHandoff({ appId: app, sessionId: output.sessionId!, token: 'token', persist, remove: vi.fn(), restore: () => [], send, error: vi.fn(), retryMs: 10 });
    expect(() => bridge.publish(output)).toThrow('ENOSPC'); expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(11); expect(persist).toHaveBeenCalledTimes(2); expect(send).toHaveBeenCalledOnce(); bridge.stop();
  });
});

describe('native and generic settlement contracts', () => {
  it.each(['recovery receipt write', 'signed sequence rejection', 'unauthorized steer'])('retains both owners after %s failure', async (failure) => {
    const db = database(); const worker = { send: vi.fn() };
    const native: WorkerFinalOutput = { ...output, codexAppSettlement: { requestId: 'current', generation: 'native-1', seq: 1, dispatchId: 'dispatch' }, ...(failure === 'unauthorized steer' ? { disposition: 'steer_superseded' as const } : {}) };
    const record = db.accept(outputSnapshot(app, native), { kind: 'managed' });
    const ds: any = { worker, larkAppId: app, initConfig: { finalOutputHandoff: { token: 'token' } }, session: { sessionId: output.sessionId, status: 'active', codexAppDispatchLedger: [], codexAppGenerationCommits: failure === 'recovery receipt write' ? [{ generation: 'native-1', committedThrough: 1 }] : [] } };
    const scope: any = { ds, worker, t: 'probe', workerGeneration: 1, cb: {}, journal: db, coordinator: new OutputDeliveryCoordinator(db),
      ownsLifecycleMutation: () => true, logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      committedCodexAppSequence, hasUnsettledCodexAppDispatch,
      reconcileOrdinaryTurnRecoveryTerminalReceipt: () => { throw new Error('EIO'); },
      settleCodexAppDispatch: () => failure === 'unauthorized steer' ? { ok: true, ledger: [], settledEntry: { codexAppSteerable: false, deliverySink: 'suppressed' } } : { ok: false, error: 'signed_sequence_rejected' },
      FINAL_HANDOFF_DELIVERY_REASON: 'pending',
    };
    scope.processFinalOutput = loadWorkerPoolClosure('processFinalOutput', scope);
    const run = loadWorkerPoolClosure<(record: OutputDeliveryRecord) => Promise<void>>('runOutput', scope);
    await run(record);
    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'codex_app_dispatch_persisted', ok: false }));
    expect(worker.send.mock.calls.some(([message]) => message.type === 'final_output_settled')).toBe(false);
    expect(db.read(record.id)?.state).toBe('blocked'); expect(db.read(record.id)?.receipt).toBeUndefined();
  });
  it('reuses an explicit final in the production automatic-delivery helper without entering the card pipeline', async () => {
    const dir = directory(); const ledger = new TurnSendLedger(dir); const ds: any = { larkAppId: app, session: { sessionId: output.sessionId } };
    await ledger.execute({ larkAppId: app, sessionId: output.sessionId!, turnId: output.turnId }, 'final', 'explicit', async () => 'om_explicit', { fenced: true });
    const record = { ...outputSnapshot(app, output), sink: { kind: 'im', context: { target: { mode: 'thread', rootMessageId: 'om_root' } }, chatId: 'oc_chat', chatType: 'group' }, state: 'pending' } as OutputDeliveryRecord;
    const deliverFinalOutput = vi.fn();
    const helper = loadWorkerPoolFunction<(ds: any, msg: WorkerFinalOutput, t: string, control: any) => Promise<any>>('deliverFinalOutputWithOutputControl', { TurnSendLedger, config: { session: { dataDir: dir } }, deliverFinalOutput, bridgeFinalOutputUuid: () => 'stable', beginFinalOutputDelivery: vi.fn() });
    const receipt = await helper(ds, output, 'probe', { record, owns: () => true });
    expect(receipt.messageId).toBe('om_explicit'); expect(deliverFinalOutput).not.toHaveBeenCalled();
  });
});

it('does not accept a generic suppression receipt as native FIFO settlement', async () => {
  const db = database(); const worker = { send: vi.fn() };
  const native: WorkerFinalOutput = { ...output, codexAppSettlement: { requestId: 'current', generation: 'native-1', seq: 1, dispatchId: 'dispatch' } };
  const record = db.accept(outputSnapshot(app, native), { kind: 'managed' });
  const ds = { worker, larkAppId: app, session: { sessionId: output.sessionId, status: 'active' } };
  const scope: any = { ds, worker, journal: db, coordinator: new OutputDeliveryCoordinator(db), ownsLifecycleMutation: () => true,
    processFinalOutput: async () => ({ status: 'suppressed' }), logger: { warn: vi.fn() }, FINAL_HANDOFF_DELIVERY_REASON: 'pending', t: 'probe' };
  await loadWorkerPoolClosure<(record: OutputDeliveryRecord) => Promise<void>>('runOutput', scope)(record);
  expect(db.read(record.id)?.state).toBe('blocked'); expect(worker.send).not.toHaveBeenCalled();
});

describe('native suppressed replay', () => {
  it.each(['pending', 'settled'])('keeps the first full body and ACKs the new waiter after %s publication', async state => {
    const dir = directory(); const workerJournal = new WorkerOutputJournal(dir, app, output.sessionId!); const host = database(dir); const sent: WorkerFinalOutput[] = [];
    const bridge = new UniversalOutputHandoff({ appId: app, sessionId: output.sessionId!, token: 'token', persist: snap => workerJournal.save(snap), remove: snap => workerJournal.remove(snap), restore: () => workerJournal.readPending(), send: msg => sent.push(msg), error: vi.fn() });
    const full: WorkerFinalOutput = { ...output, codexAppSettlement: { requestId: 'first', generation: 'native-1', seq: 1, dispatchId: 'dispatch' } };
    bridge.publish(full); const first = outputSnapshot(app, sent[0]); host.accept(first, { kind: 'managed' });
    if (state === 'settled') {
      const owner = host.newOwner(); host.claim(first.id, owner); host.complete(first.id, owner, { status: 'delegated', owner: 'codex_app_dispatch_persisted' });
      bridge.acknowledge(receipt(sent[0]));
    }
    const empty: WorkerFinalOutput = { ...full, content: '', suppressDelivery: true, codexAppSettlement: { ...full.codexAppSettlement!, requestId: 'replacement' } };
    bridge.publish(empty); const snapshot = outputSnapshot(app, sent[1]);
    expect(snapshot.id).toBe(first.id); expect(snapshot.fingerprint).toBe(first.fingerprint);
    const record = host.accept(snapshot, { kind: 'http', mode: 'wait' });
    expect(record.output.content).toBe('answer'); expect(record.output.codexAppSettlement?.requestId).toBe('replacement');
    if (state === 'pending') expect(workerJournal.readPending()[0].output.content).toBe('answer');
    const worker = { send: vi.fn() }; const ds: any = { worker, larkAppId: app, session: { sessionId: output.sessionId, status: 'active', codexAppGenerationCommits: [{ generation: 'native-1', committedThrough: 1 }], codexAppDispatchLedger: [] }, initConfig: { finalOutputHandoff: { token: 'token' } } };
    const scope: any = { ds, worker, t: 'probe', workerGeneration: 1, cb: {}, journal: host, coordinator: new OutputDeliveryCoordinator(host), ownsLifecycleMutation: () => true, logger: { warn: vi.fn() }, committedCodexAppSequence, hasUnsettledCodexAppDispatch, reconcileOrdinaryTurnRecoveryTerminalReceipt: () => {}, FINAL_HANDOFF_DELIVERY_REASON: 'pending' };
    scope.processFinalOutput = loadWorkerPoolClosure('processFinalOutput', scope);
    await loadWorkerPoolClosure<(record: OutputDeliveryRecord) => Promise<void>>('runOutput', scope)(record);
    expect(worker.send).toHaveBeenCalledWith({ type: 'codex_app_dispatch_persisted', requestId: 'replacement', ok: true });
    const ack = worker.send.mock.calls.map(([message]) => message).find(message => message.type === 'final_output_settled');
    expect(bridge.acknowledge(ack)).toBe(true); expect(workerJournal.readPending()).toEqual([]); expect(host.read(first.id)?.output.content).toBe('answer'); bridge.stop();
  });
  it('rejects a native body rewrite and retains the original recovery copy', () => {
    const dir = directory(); const journal = new WorkerOutputJournal(dir, app, output.sessionId!); const host = database(dir);
    const full: WorkerFinalOutput = { ...output, codexAppSettlement: { requestId: 'first', generation: 'native-1', seq: 1, dispatchId: 'dispatch' } };
    const first = outputSnapshot(app, full); journal.save(first); host.accept(first, { kind: 'managed' });
    const changed = outputSnapshot(app, { ...full, content: 'rewritten', codexAppSettlement: { ...full.codexAppSettlement!, requestId: 'new' } });
    expect(() => journal.save(changed)).toThrow('conflict'); expect(() => host.accept(changed, { kind: 'managed' })).toThrow('conflict');
    expect(journal.readPending()[0].output.content).toBe('answer'); expect(host.read(first.id)?.output.content).toBe('answer');
  });
});

it('retains the first rendered transport across lease replacement and records image fallback separately', async () => {
  vi.useFakeTimers(); const db = database(); const record = db.accept(outputSnapshot(app, output), { kind: 'managed' });
  const owner = db.newOwner(); db.claim(record.id, owner, Date.now(), 10);
  const first = { content: 'original rendered card', msgType: 'interactive', providerUuid: 'stable' };
  db.freezeTransport(record.id, owner, 'primary', first);
  await vi.advanceTimersByTimeAsync(11); const replacement = db.newOwner(); db.claim(record.id, replacement);
  expect(db.freezeTransport(record.id, replacement, 'primary', { ...first, content: 'newer turn metadata' })).toEqual(first);
  expect(db.freezeTransport(record.id, replacement, 'image-fallback', { ...first, content: 'image omitted' }).content).toBe('image omitted');
  expect(() => db.freezeTransport(record.id, owner, 'new', first)).toThrow('authority_changed');
});

describe('document provider boundaries', () => {
  it('cancels token waiting without an attempt marker and can resume the rejected request', async () => {
    vi.useFakeTimers(); const db = database(); const record = db.accept(outputSnapshot(app, output), { kind: 'doc', context: {} });
    const coordinator = new OutputDeliveryCoordinator(db); let allowed = true; let releaseToken!: () => void;
    const token = new Promise<void>(resolve => { releaseToken = resolve; }); const userWrite = vi.fn();
    const first = coordinator.deliver(record, { owns: () => allowed, process: async (_r, control) => {
      await control.effect('doc:0', async hooks => {
        hooks.providerRequestStarted(); hooks.providerRequestNotDelivered();
        await token; hooks.beforeProviderEffect(); hooks.providerRequestStarted(); userWrite(); return 'reply';
      });
      return { status: 'delivered' };
    }, settled: vi.fn(), error: vi.fn() });
    await Promise.resolve(); allowed = false; releaseToken(); await first;
    expect(userWrite).not.toHaveBeenCalled(); expect(db.read(record.id)?.state).toBe('blocked');
    allowed = true; await vi.advanceTimersByTimeAsync(5001);
    await coordinator.deliver(record, { owns: () => allowed, process: async (_r, control) => {
      await control.effect('doc:0', async hooks => { hooks.beforeProviderEffect(); hooks.providerRequestStarted(); userWrite(); return 'reply'; });
      return { status: 'delivered' };
    }, settled: vi.fn(), error: vi.fn() });
    expect(userWrite).toHaveBeenCalledOnce(); expect(db.read(record.id)?.state).toBe('settled');
  });

  it('retries a definitely rejected document request while retaining unknown provider outcomes', async () => {
    vi.useFakeTimers(); const db = database(); const record = db.accept(outputSnapshot(app, output), { kind: 'doc', context: {} }); const coordinator = new OutputDeliveryCoordinator(db);
    const send = vi.fn(); const settled = vi.fn();
    await coordinator.deliver(record, { owns: () => true, process: async (_r, control) => {
      await control.effect('doc:0', async hooks => { hooks.providerRequestStarted(); send(); hooks.providerRequestNotDelivered(); throw new Error('HTTP 400 missing scope'); });
      return { status: 'delivered' };
    }, settled, error: vi.fn() });
    expect(settled).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(5001);
    await coordinator.deliver(record, { owns: () => true, process: async (_r, control) => {
      await control.effect('doc:0', async hooks => { hooks.providerRequestStarted(); send(); return 'reply'; });
      return { status: 'delivered' };
    }, settled, error: vi.fn() });
    expect(send).toHaveBeenCalledTimes(2); expect(db.read(record.id)?.state).toBe('settled');
  });

  it('records a returned document receipt after lease loss so the replacement does not send again', async () => {
    vi.useFakeTimers(); const db = database(); const record = db.accept(outputSnapshot(app, output), { kind: 'doc', context: {} });
    const owner = db.newOwner(); db.claim(record.id, owner, Date.now(), 10); let resolveReceipt!: (value: string) => void;
    const receipt = new Promise<string>(resolve => { resolveReceipt = resolve; });
    const first = db.effect(record.id, owner, 'doc:0', async hooks => { hooks.providerRequestStarted(); return receipt; });
    await vi.advanceTimersByTimeAsync(11); const replacement = db.newOwner(); db.claim(record.id, replacement);
    const duplicate = vi.fn(async () => 'duplicate');
    await expect(db.effect(record.id, replacement, 'doc:0', duplicate)).rejects.toThrow('unknown');
    resolveReceipt('original-reply'); await first;
    expect(await db.effect(record.id, replacement, 'doc:0', duplicate)).toBe('original-reply'); expect(duplicate).not.toHaveBeenCalled();
  });
});

it('visits later ready output despite a backlog whose original owners are unavailable', async () => {
  const db = database(); const now = Date.now();
  for (let i = 0; i < 300; i++) db.accept(outputSnapshot(app, { ...output, turnId: `om_unavailable_${i}`, lastUuid: `final_${i}` }, now + i), { kind: 'managed' });
  const ready = db.accept(outputSnapshot(app, { ...output, turnId: 'om_ready', lastUuid: 'ready' }, now + 301), { kind: 'managed' });
  const coordinator = new OutputDeliveryCoordinator(db); const process = vi.fn(async (_record: OutputDeliveryRecord) => ({ status: 'delivered' as const, messageId: 'om_reply' })); const seen = new Set<string>();
  for (let i = 0; i < 302; i++) {
    const before = seen.size;
    for (const record of db.pending(output.sessionId)) {
      seen.add(record.id);
      await coordinator.deliver(record, { owns: () => record.id === ready.id, process, settled: vi.fn(), error: vi.fn() });
    }
    if (db.read(ready.id)?.state === 'settled' || seen.size === before) break;
  }
  expect(process).toHaveBeenCalledOnce(); expect(db.read(ready.id)?.state).toBe('settled');
});

it('revisits an expired earlier lease while newer output keeps arriving', async () => {
  vi.useFakeTimers(); const db = database(); const now = Date.now(); const coordinator = new OutputDeliveryCoordinator(db);
  const earlier = db.accept(outputSnapshot(app, { ...output, turnId: 'om_earlier', lastUuid: 'earlier' }, now), { kind: 'managed' });
  db.claim(earlier.id, db.newOwner(), now, 5_000);
  const process = vi.fn(async (_record: OutputDeliveryRecord) => ({ status: 'delivered' as const, messageId: 'om_reply' }));
  const deps = { owns: () => true, process, settled: vi.fn(), error: vi.fn() };
  for (let i = 0; i < 12; i++) {
    db.accept(outputSnapshot(app, { ...output, turnId: `om_incoming_${i}`, lastUuid: `incoming_${i}` }, now + i + 1), { kind: 'managed' });
    for (const record of db.pending(output.sessionId)) await coordinator.deliver(record, deps);
    await vi.advanceTimersByTimeAsync(1_000);
  }
  expect(db.read(earlier.id)?.state).toBe('settled');
  expect(process.mock.calls.some(([record]) => record.id === earlier.id)).toBe(true);
});
