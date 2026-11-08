import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalOutputSnapshot, WorkerFinalOutputHandoff, validateFinalOutputSnapshot, type FinalOutputOffer } from '../src/services/final-output-handoff.js';
import { FinalOutputHandoffStore } from '../src/services/final-output-handoff-store.js';
import { FinalOutputHandoffHost } from '../src/services/final-output-handoff-host.js';
import { TurnSendLedger } from '../src/services/turn-send-ledger.js';
import { appendBridgeTurnJournalEntry, readBridgeTurnJournal, stageBridgeFinalOutput, acknowledgeBridgeFinalOutput } from '../src/services/bridge-turn-journal.js';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';
import { beginReplyTargetTurn, setFinalOutputOriginRecorder } from '../src/core/reply-target.js';

const app = 'cli_test';
const output = { sessionId: 'session_one', turnId: 'om_input', lastUuid: 'native-final', content: 'answer' };
const target = { mode: 'thread' as const, rootMessageId: 'om_original_topic' };
const snapshot = finalOutputSnapshot(app, output);
const roots: string[] = [];
const stores: FinalOutputHandoffStore[] = [];
function root() { const path = mkdtempSync(join(tmpdir(), 'final-handoff-host-')); roots.push(path); return path; }
function open(path: string) { const store = new FinalOutputHandoffStore(path, app); stores.push(store); return store; }
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setFinalOutputOriginRecorder(undefined);
  for (const store of stores.splice(0)) try { store.close(); } catch {}
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('durable output owner', () => {
  it('survives database reopen and deduplicates an ACK-lost offer without readdressing', () => {
    const path = root(); const first = open(path);
    first.accept(snapshot, target, 'ou_actor'); first.close();
    const next = open(path);
    const replay = next.accept(snapshot, { mode: 'plain', chatId: 'oc_new_topic' }, 'ou_new_actor');
    expect(replay.target).toEqual(target);
    expect(replay.actorOpenId).toBe('ou_actor');
    expect(next.pending()).toHaveLength(1);
    expect(() => next.accept(finalOutputSnapshot(app, { ...output, content: 'changed' }), target, 'ou_actor')).toThrow('conflict');
  });

  it('keeps publication authority bound to the original channel after a session is rehomed', () => {
    const path = root(); const store = open(path);
    store.rememberOrigin(output.sessionId, output.turnId, target, 'ou_actor', Date.now(), { chatId: 'oc_original', chatType: 'group' });
    const ds: any = { larkAppId: app, chatId: 'oc_rehomed', chatType: 'p2p', worker: { send: vi.fn() },
      initConfig: { finalOutputHandoff: { token: 'one', admitNew: true } }, session: { sessionId: output.sessionId, status: 'active' } };
    const accept = loadWorkerPoolFunction<(ds: any, offer: FinalOutputOffer) => void>('acceptFinalOutputOffer', {
      validateFinalOutputSnapshot, finalOutputHandoffSupported: () => true, finalOutputHandoffHost: () => ({ store, run: vi.fn(async () => {}) }),
    });
    accept(ds, { type: 'final_output_offer', version: 1, token: 'one', ...snapshot });
    expect(store.read(snapshot.intentId)).toMatchObject({ chatId: 'oc_original', chatType: 'group', target, actorOpenId: 'ou_actor' });
  });

  it('fences a replaced attempt and retains the first transport bytes', () => {
    const store = open(root()); const now = Date.now();
    store.accept(snapshot, target, 'ou_actor', now);
    const first = store.claim(snapshot.intentId, now, 10_000)!;
    const body = { content: 'first rendered card', msgType: 'interactive', providerUuid: 'stable_uuid' };
    store.freezeTransport(snapshot.intentId, first.claim!, body, now);
    store.attempting(snapshot.intentId, first.claim!, now);
    const next = store.claim(snapshot.intentId, now + 10_001)!;
    expect(store.owns(snapshot.intentId, first.claim!, now + 10_001)).toBe(false);
    expect(() => store.attempting(snapshot.intentId, first.claim!, now + 10_001)).toThrow('stale');
    expect(store.settle(snapshot.intentId, first.claim!, 'delivered', { messageId: 'om_stale' })).toBe(false);
    expect(store.freezeTransport(snapshot.intentId, next.claim!, { ...body, content: 'different after restart' }, now + 10_001)).toEqual(body);
  });

  it('does not transmit after a pre-effect cancellation', async () => {
    const store = open(root()); store.accept(snapshot, target, 'ou_actor');
    const deliver = vi.fn();
    const host = new FinalOutputHandoffHost(store, { available: () => 'cancelled', deliver, error: vi.fn() });
    await host.pump();
    expect(deliver).not.toHaveBeenCalled();
    expect(store.read(snapshot.intentId)?.state).toBe('cancelled');
  });

  it('retains an ambiguous external effect instead of marking it unsent on cancellation', async () => {
    const store = open(root()); const now = Date.now();
    store.accept(snapshot, target, 'ou_actor', now);
    const first = store.claim(snapshot.intentId, now, 1)!;
    store.attempting(snapshot.intentId, first.claim!, now);
    const host = new FinalOutputHandoffHost(store, { available: () => 'cancelled', deliver: vi.fn(), error: vi.fn(), now: () => now + 2 });
    await host.pump();
    expect(store.read(snapshot.intentId)?.state).toBe('ambiguous');
  });

  it('records an unknown provider outcome and stops automatic pumping', async () => {
    const store = open(root()); store.accept(snapshot, target, 'ou_actor');
    const deliver = vi.fn(async (_record, control) => { control.beforeEffect(); throw new Error('response lost'); });
    const host = new FinalOutputHandoffHost(store, { available: () => 'ready', deliver, error: vi.fn() });
    await host.pump(); await host.pump();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(store.read(snapshot.intentId)?.state).toBe('ambiguous');
  });

  it('scans past a batch of waiting sessions so a later ready output is not starved', async () => {
    const store = open(root()); const clock = Date.now() + 100;
    for (let n = 0; n < 33; n++) store.accept(finalOutputSnapshot(app, { ...output, sessionId: `session_${n}`, turnId: `om_${n}`, lastUuid: `uuid_${n}` }), target, 'ou_actor', clock - 100 + n);
    const deliver = vi.fn(async () => ({ messageId: 'om_ready' }));
    const host = new FinalOutputHandoffHost(store, { available: record => record.output.sessionId === 'session_32' ? 'ready' : 'wait', deliver, error: vi.fn(), now: () => clock });
    await host.pump(); await host.pump();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0].output.sessionId).toBe('session_32');
  });

  it('uses a known ledger receipt when output settlement fails once', async () => {
    const path = root(); const store = open(path); store.accept(snapshot, target, 'ou_actor');
    const ledger = new TurnSendLedger(path); const key = { larkAppId: app, sessionId: output.sessionId, turnId: output.turnId };
    const provider = vi.fn(async () => 'om_known');
    const settle = store.settle.bind(store);
    vi.spyOn(store, 'settle').mockImplementationOnce(() => { throw new Error('commit failed'); }).mockImplementation(settle);
    const host = new FinalOutputHandoffHost(store, { available: () => 'ready', error: vi.fn(),
      knownReceipt: () => { const receipt = ledger.read(key)?.final; return receipt ? { messageId: receipt.messageId } : undefined; },
      deliver: async (_record, control) => ({ messageId: (await ledger.execute(key, 'final', output.content, provider, { fenced: true, beforeDispatch: control.beforeEffect })).messageId }),
    });
    await host.pump(); await host.pump();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(store.read(snapshot.intentId)).toMatchObject({ state: 'delivered', messageId: 'om_known' });
  });

  it('does not turn a delivered ledger receipt into cancelled when authority is revoked', async () => {
    const store = open(root()); store.accept(snapshot, target, 'ou_actor');
    const deliver = vi.fn();
    const host = new FinalOutputHandoffHost(store, { available: () => 'cancelled', deliver, error: vi.fn(), knownReceipt: () => ({ messageId: 'om_previously_delivered' }) });
    await host.pump();
    expect(deliver).not.toHaveBeenCalled();
    expect(store.read(snapshot.intentId)).toMatchObject({ state: 'delivered', messageId: 'om_previously_delivered' });
  });

  it('publishes settled state after receipt reconciliation and ignores projection observer failures', async () => {
    const store = open(root()); store.accept(snapshot, target, 'ou_actor');
    const observer = vi.fn(() => { throw new Error('projection failed'); });
    const host = new FinalOutputHandoffHost(store, { available: () => 'ready', error: vi.fn(), settled: observer,
      deliver: async (_record, control) => { control.beforeEffect(); return { messageId: 'om_known' }; } });
    await expect(host.pump()).resolves.toBeUndefined();
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ state: 'delivered', messageId: 'om_known' }));
    expect(store.attentionPending(output.sessionId)).toBeUndefined();
  });

  it('keeps one in-flight publisher across overlapping pump ticks', async () => {
    const store = open(root()); store.accept(snapshot, target, 'ou_actor');
    let release!: () => void; const blocked = new Promise<void>(done => { release = done; });
    const deliver = vi.fn(async (_record, control) => { control.beforeEffect(); await blocked; return { messageId: 'om_delivered' }; });
    const host = new FinalOutputHandoffHost(store, { available: () => 'ready', deliver, error: vi.fn() });
    const first = host.pump(); const second = host.pump(); release();
    await Promise.all([first, second]);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(store.read(snapshot.intentId)?.state).toBe('delivered');
  });

  it('uses the real pool acceptance function to ACK only after a durable commit', () => {
    const store = open(root()); const send = vi.fn(() => { expect(store.read(snapshot.intentId)).toBeDefined(); });
    const offer: FinalOutputOffer = { type: 'final_output_offer', version: 1, token: 'current', ...snapshot };
    const accept = loadWorkerPoolFunction<(ds: any, value: FinalOutputOffer) => void>('acceptFinalOutputOffer', {
      validateFinalOutputSnapshot, finalOutputHandoffSupported: () => true,
      finalOutputHandoffHost: () => ({ store, run: vi.fn(async () => {}) }),
    });
    const ds = { larkAppId: app, worker: { send }, initConfig: { finalOutputHandoff: { token: 'current', admitNew: true } },
      session: { sessionId: output.sessionId, status: 'active', turnReplyContexts: { [output.turnId]: { target, requesterOpenId: 'ou_actor' } } } };
    accept(ds, offer);
    expect(send).toHaveBeenCalledWith({ type: 'final_output_accepted', intentId: snapshot.intentId, fingerprint: snapshot.fingerprint, token: 'current' });
    expect(() => accept(ds, { ...offer, token: 'stale' })).toThrow('not_authorized');
    expect(send).toHaveBeenCalledTimes(1);
    ds.session.turnReplyContexts = {};
    accept(ds, offer);
    expect(send).toHaveBeenCalledTimes(2);
    const commit = vi.spyOn(store, 'accept').mockImplementation(() => { throw new Error('commit failed'); });
    expect(() => accept(ds, offer)).toThrow('commit failed');
    expect(send).toHaveBeenCalledTimes(2);
    commit.mockRestore();
  });

  it('retains the authenticated requester after both bounded reply projections are pruned', () => {
    vi.stubEnv('BOTMUX_FINAL_OUTPUT_HANDOFF', '1');
    const store = open(root());
    setFinalOutputOriginRecorder((ds, turnId, context) => store.rememberOrigin(ds.session.sessionId, turnId, context.target, context.requesterOpenId!));
    const send = vi.fn();
    const ds: any = { larkAppId: app, chatId: 'oc_chat', scope: 'thread', worker: { send },
      initConfig: { finalOutputHandoff: { token: 'current', admitNew: true } },
      session: { sessionId: output.sessionId, rootMessageId: target.rootMessageId, status: 'active' } };
    beginReplyTargetTurn(ds, undefined, output.turnId, new Date().toISOString(), { senderOpenId: 'ou_actual_requester' });
    for (let n = 0; n < 260; n++) beginReplyTargetTurn(ds, undefined, `om_later_${n}`, new Date().toISOString(), { senderOpenId: `ou_later_${n}` });
    expect(ds.session.replyTargets[output.turnId]).toBeUndefined();
    expect(ds.session.turnReplyContexts[output.turnId]).toBeUndefined();
    const accept = loadWorkerPoolFunction<(ds: any, offer: FinalOutputOffer) => void>('acceptFinalOutputOffer', {
      validateFinalOutputSnapshot, finalOutputHandoffSupported: () => true,
      finalOutputHandoffHost: () => ({ store, run: vi.fn(async () => {}) }),
    });
    accept(ds, { type: 'final_output_offer', version: 1, token: 'current', ...snapshot });
    expect(store.read(snapshot.intentId)).toMatchObject({ actorOpenId: 'ou_actual_requester', target });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('uses the actual requester rather than a quoted author as publication authority', () => {
    const store = open(root()); const send = vi.fn();
    const ds: any = { larkAppId: app, worker: { send }, initConfig: { finalOutputHandoff: { token: 'current', admitNew: true } },
      session: { sessionId: output.sessionId, status: 'active',
        turnReplyContexts: { [output.turnId]: { target, replyTargetSenderOpenId: 'ou_quoted_author', requesterOpenId: 'ou_actual_requester' } } } };
    const accept = loadWorkerPoolFunction<(ds: any, offer: FinalOutputOffer) => void>('acceptFinalOutputOffer', {
      validateFinalOutputSnapshot, finalOutputHandoffSupported: () => true, finalOutputHandoffHost: () => ({ store, run: vi.fn(async () => {}) }),
    });
    accept(ds, { type: 'final_output_offer', version: 1, token: 'current', ...snapshot });
    expect(store.read(snapshot.intentId)?.actorOpenId).toBe('ou_actual_requester');
  });

  it('transfers recovery through worker journal, host restart and a lost ACK without rerunning a prompt', async () => {
    const path = root(); const journal = join(path, 'worker.json');
    appendBridgeTurnJournalEntry(journal, { turnId: output.turnId, handoffVersion: 1, markTimeMs: Date.now(), jsonlPath: '/tmp/native.jsonl', offsetAtMark: 0 });
    const originalStore = open(path);
    const old = new WorkerFinalOutputHandoff({ appId: app, sessionId: output.sessionId, token: 'old',
      persist: s => stageBridgeFinalOutput(journal, s), clear: s => acknowledgeBridgeFinalOutput(journal, s),
      send: offer => { originalStore.accept(offer, target, 'ou_actor'); }, accepted: vi.fn(), error: vi.fn() });
    old.offer(output); old.stop(); originalStore.close();
    expect(readBridgeTurnJournal(journal)).toHaveLength(1);
    const recoveredStore = open(path); const ledger = new TurnSendLedger(path); const provider = vi.fn(async () => 'om_once');
    const host = new FinalOutputHandoffHost(recoveredStore, { available: () => 'ready', error: vi.fn(),
      deliver: async (record, control) => {
        const sent = await ledger.execute({ larkAppId: app, sessionId: output.sessionId, turnId: output.turnId }, 'final', record.output.content, provider,
          { fenced: true, beforeDispatch: control.beforeEffect });
        return { messageId: sent.messageId, suppressed: sent.replayed };
      } });
    await host.pump();
    let replacement!: WorkerFinalOutputHandoff;
    replacement = new WorkerFinalOutputHandoff({ appId: app, sessionId: output.sessionId, token: 'new',
      persist: s => stageBridgeFinalOutput(journal, s), clear: s => acknowledgeBridgeFinalOutput(journal, s), accepted: vi.fn(), error: vi.fn(),
      send: offer => { recoveredStore.accept(offer, target, 'ou_actor'); replacement.acknowledge({ ...offer, type: 'final_output_accepted' }); } });
    replacement.restore(readBridgeTurnJournal(journal).map(entry => entry.pendingFinal!));
    await host.pump();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(readBridgeTurnJournal(journal)).toHaveLength(0);
    expect(recoveredStore.read(snapshot.intentId)?.messageId).toBe('om_once');
    replacement.stop();
  });

  it('recovers after an independent process exits after provider acceptance but before receipt storage', async () => {
    const path = root(); const receiptPath = join(path, 'provider.txt');
    const child = spawnSyncTsEvalWithRepoImports(`
      import { writeFileSync } from 'node:fs';
      import { FinalOutputHandoffStore } from './src/services/final-output-handoff-store.js';
      import { TurnSendLedger } from './src/services/turn-send-ledger.js';
      const store = new FinalOutputHandoffStore(${JSON.stringify(path)}, 'cli_test');
      const snapshot = ${JSON.stringify(snapshot)};
      store.accept(snapshot, ${JSON.stringify(target)}, 'ou_actor');
      const record = store.claim(snapshot.intentId, Date.now(), 60_000);
      const ledger = new TurnSendLedger(${JSON.stringify(path)});
      await ledger.execute({ larkAppId:'cli_test',sessionId:'session_one',turnId:'om_input' }, 'final', 'answer', async () => {
        writeFileSync(${JSON.stringify(receiptPath)}, 'om_provider_original');
        process.exit(86);
      }, { fenced: true, beforeDispatch: () => store.attempting(snapshot.intentId, record.claim) });
    `, { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 });
    expect(child.status, String(child.stderr)).toBe(86);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    const store = open(path); const ledger = new TurnSendLedger(path);
    expect(store.read(snapshot.intentId)?.state).toBe('attempting');
    const lookup = vi.fn(async () => readFileSync(receiptPath, 'utf8'));
    const host = new FinalOutputHandoffHost(store, { available: () => 'ready', error: vi.fn(),
      deliver: async (_record, control) => {
        const result = await ledger.execute({ larkAppId: app, sessionId: output.sessionId, turnId: output.turnId }, 'final', 'answer', lookup,
          { fenced: true, beforeDispatch: control.beforeEffect });
        return { messageId: result.messageId };
      } });
    await host.pump();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(store.read(snapshot.intentId)?.messageId).toBe('om_provider_original');
    await host.pump();
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
