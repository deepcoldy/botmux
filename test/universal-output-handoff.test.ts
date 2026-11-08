import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UniversalOutputHandoff, outputSnapshot, type OutputHandoffReceipt } from '../src/services/universal-output-handoff.js';
import { WorkerOutputJournal } from '../src/services/worker-output-journal.js';
import { OutputDeliveryJournal, type OutputDeliveryRecord } from '../src/services/output-delivery-journal.js';
import { OutputDeliveryCoordinator } from '../src/services/output-delivery-coordinator.js';
import { FinalOutputHandoffStore } from '../src/services/final-output-handoff-store.js';
import { TurnSendLedger, FinalPublicationUnknownError } from '../src/services/turn-send-ledger.js';
import { OutputDeliveryTerminalError } from '../src/services/output-delivery-coordinator.js';
import { loadWorkerPoolClosure, loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';
import { committedCodexAppSequence, hasUnsettledCodexAppDispatch } from '../src/utils/codex-app-dispatch-ledger.js';
import { FINAL_HANDOFF_DELIVERY_REASON, FINAL_HANDOFF_WAIT_REASON } from '../src/core/worker-pool.js';
import { raiseDaemonAttention } from '../src/core/session-activity.js';
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

describe('journal app identity', () => {
  it('accepts any safe-basename app id but rejects path-shaped ids', () => {
    const dir = directory();
    // Non-`cli_` ids (test fixtures and config-controlled ids) must boot:
    // the `cli_` prefix is validated at Feishu protocol edges, not here.
    expect(() => new OutputDeliveryJournal(dir, 'app_test')).not.toThrow();
    expect(() => new WorkerOutputJournal(dir, 'app_test', output.sessionId!)).not.toThrow();
    expect(() => FinalOutputHandoffStore.exists(dir, 'app_test')).not.toThrow();
    // core-only synthesizes `local_<slug>` and the slug permits dots.
    expect(() => new OutputDeliveryJournal(dir, 'local_my.bot')).not.toThrow();
    for (const bad of ['../x', 'a/b', String.raw`cli_x\y`, '.', '..', '', 'x'.repeat(129), 'a b']) {
      expect(() => new OutputDeliveryJournal(dir, bad)).toThrow('invalid_output_app');
      expect(() => new WorkerOutputJournal(dir, bad, output.sessionId!)).toThrow('invalid_output_journal_identity');
      expect(() => FinalOutputHandoffStore.path(dir, bad)).toThrow('invalid_handoff_app');
    }
  });
});

describe('attention lifecycle', () => {
  const loadRunOutput = (scope: Record<string, any>) =>
    loadWorkerPoolClosure<(record: OutputDeliveryRecord) => Promise<void>>('runOutput', scope);
  const scopeFor = (
    db: OutputDeliveryJournal,
    record: OutputDeliveryRecord,
    dir: string,
    options: {
      sink?: OutputDeliveryRecord['sink'];
      processFinalOutput?: any;
      v1Exists?: boolean;
      v1Attention?: boolean;
      bridgeEntries?: any[];
      chatId?: string; chatType?: 'group' | 'p2p'; privateReplyOn?: boolean;
      asyncResults?: Map<string, unknown>;
      /** talk evaluation: false-ish values map to the recoverable 'none'
       *  reason unless talkReason:'blocked' is given (governance blocklist). */
      canTalk?: boolean | (() => boolean);
      talkReason?: string;
      sessionMismatch?: boolean;
    } = {},
  ) => {
    const talkAllowed = typeof options.canTalk === 'function' ? options.canTalk : () => (options.canTalk ?? true);
    const worker = { send: vi.fn() };
    const sink = options.sink ?? record.sink;
    const ds: any = { larkAppId: app, chatId: options.chatId ?? 'oc', chatType: options.chatType ?? 'group',
      session: { sessionId: output.sessionId! },
      worker, initConfig: { finalOutputHandoff: { version: 2, token: 'tok' } },
      agentAttention: { kind: 'blocked' as const, reason: FINAL_HANDOFF_DELIVERY_REASON } };
    if (options.asyncResults) ds.asyncTriggerResults = options.asyncResults;
    const publishAttentionPatch = vi.fn();
    const coordinator = new OutputDeliveryCoordinator(db);
    const scope: any = {
      ds, worker, t: 'probe', journal: db, coordinator, config: { session: { dataDir: dir } },
      ownsLifecycleMutation: () => true, ownsWorkerSession: () => true, isSessionTransferring: () => false, sessionController: undefined,
      processFinalOutput: options.processFinalOutput ?? vi.fn(async () => ({ status: 'suppressed' as const })),
      canTalk: typeof options.canTalk === 'function' ? options.canTalk : () => options.canTalk ?? true,
      evaluateTalk: () => { const a = talkAllowed(); return { allowed: a, reason: a ? 'allowedUser' : (options.talkReason ?? 'none') }; },
      FinalOutputHandoffStore: { exists: () => options.v1Exists ?? false },
      finalOutputHandoffHost: () => ({ store: { attentionPending: () => options.v1Attention ? {} : undefined } }),
      readBridgeTurnJournal: () => options.bridgeEntries ?? [], publishAttentionPatch, raiseDaemonAttention, join,
      FINAL_HANDOFF_WAIT_REASON, FINAL_HANDOFF_DELIVERY_REASON,
      privateReplyEnabled: () => options.privateReplyOn ?? false,
      asyncTriggerStore: { lookupStrict: () => undefined },
      FinalPublicationUnknownError, OutputDeliveryTerminalError,
      shouldDropMismatchedFinalOutput: () => options.sessionMismatch ?? false,
      shouldDropMismatchedHermesFinalOutput: () => false,
      logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    };
    record = { ...record, sink };
    return { scope, ds, publishAttentionPatch, run: () => loadRunOutput(scope)(record) };
  };
  it('clears the durable-output attention after a replacement delivery settles', async () => {
    const dir = directory(); const db = database();
    const record = db.accept(outputSnapshot(app, output), { kind: 'suppressed', reason: 'probe' });
    const ctx = scopeFor(db, record, dir);
    await ctx.run();
    expect(db.read(record.id)?.state).toBe('settled');
    expect(ctx.ds.agentAttention).toBeUndefined();
    expect(ctx.publishAttentionPatch).toHaveBeenCalledOnce();
  });
  it('keeps the attention while another durable output for the session is still unsettled', async () => {
    const dir = directory(); const db = database();
    const first = db.accept(outputSnapshot(app, output), { kind: 'suppressed', reason: 'probe' });
    db.accept(outputSnapshot(app, { ...output, turnId: 'om_other', lastUuid: 'other' }), { kind: 'suppressed', reason: 'probe' });
    const ctx = scopeFor(db, first, dir);
    await ctx.run();
    expect(ctx.ds.agentAttention).toBeDefined();
    expect(ctx.publishAttentionPatch).not.toHaveBeenCalled();
  });
  it('keeps the attention while a V1 ambiguous/rejected handoff still requires inspection', async () => {
    const dir = directory(); const db = database();
    const record = db.accept(outputSnapshot(app, output), { kind: 'suppressed', reason: 'probe' });
    const ctx = scopeFor(db, record, dir, { v1Exists: true, v1Attention: true });
    await ctx.run();
    expect(db.read(record.id)?.state).toBe('settled');
    expect(ctx.ds.agentAttention).toBeDefined();
    expect(ctx.publishAttentionPatch).not.toHaveBeenCalled();
  });
  it('keeps the attention while a legacy bridge mark still carries a pending final snapshot', async () => {
    const dir = directory(); const db = database();
    const record = db.accept(outputSnapshot(app, output), { kind: 'suppressed', reason: 'probe' });
    const ctx = scopeFor(db, record, dir, { bridgeEntries: [{ pendingFinal: { intentId: 'x' } }] });
    await ctx.run();
    expect(db.read(record.id)?.state).toBe('settled');
    expect(ctx.ds.agentAttention).toBeDefined();
    expect(ctx.publishAttentionPatch).not.toHaveBeenCalled();
  });
  it('files a structurally undeliverable output as terminal rejected and never retries it', async () => {
    const dir = directory(); const db = database();
    const record = db.accept(outputSnapshot(app, output),
      { kind: 'im', context: { target: { mode: 'plain', chatId: 'oc' } }, chatId: 'oc', chatType: 'group' });
    // Session has been rehomed into a different chat: the frozen IM target can
    // never come back; no provider call must ever happen.
    const ctx = scopeFor(db, record, dir, { chatId: 'oc_new_chat' });
    await ctx.run();
    expect(db.read(record.id)?.state).toBe('rejected');
    expect(ctx.scope.processFinalOutput).not.toHaveBeenCalled();
    expect(ctx.ds.agentAttention).toBeDefined();
    // A second pump (worker retransmission / restart recovery) does nothing:
    // no retry, no settled receipt, no worker ACK.
    ctx.scope.processFinalOutput.mockClear?.();
    await ctx.run();
    expect(db.read(record.id)?.state).toBe('rejected');
    expect(ctx.scope.processFinalOutput).not.toHaveBeenCalled();
    expect(ctx.scope.worker.send).not.toHaveBeenCalled();
  });
  it('files the expired publication window as terminal rejected instead of looping blocked', async () => {
    const dir = directory(); const db = database();
    const record = db.accept(outputSnapshot(app, output),
      { kind: 'im', context: { target: { mode: 'plain', chatId: 'oc' } }, chatId: 'oc', chatType: 'group' });
    const ctx = scopeFor(db, record, dir, {
      processFinalOutput: vi.fn(async () => { throw new FinalPublicationUnknownError(); }),
    });
    await ctx.run();
    expect(db.read(record.id)?.state).toBe('rejected');
  });
  it('keeps a transient failure in blocked so the next pump retries the same record', async () => {
    vi.useFakeTimers();
    const dir = directory(); const db = database();
    const record = db.accept(outputSnapshot(app, output),
      { kind: 'im', context: { target: { mode: 'plain', chatId: 'oc' } }, chatId: 'oc', chatType: 'group' });
    let attempts = 0;
    const ctx = scopeFor(db, record, dir, {
      processFinalOutput: vi.fn(async () => { if (++attempts === 1) throw new Error('feishu 502'); return { status: 'delivered' as const, messageId: 'om_ok' }; }),
    });
    await ctx.run();
    expect(db.read(record.id)?.state).toBe('blocked');
    // Expire the short blocked cooldown and pump again: same record settles.
    await vi.advanceTimersByTimeAsync(5_001);
    await ctx.run();
    expect(db.read(record.id)?.state).toBe('settled');
    expect(attempts).toBe(2);
    vi.useRealTimers();
  });
  it('treats a startup-window canTalk=false as recoverable: blocked, then settles once the allowlist resolves', async () => {
    vi.useFakeTimers();
    const dir = directory(); const db = database();
    // requesterOpenId present so the canTalk gate actually runs.
    const record = db.accept(outputSnapshot(app, output),
      { kind: 'im', context: { target: { mode: 'plain', chatId: 'oc' }, requesterOpenId: 'ou_actor' }, chatId: 'oc', chatType: 'group' });
    let allowed = false; // allowlist/sidecar still unresolved during startup
    let attempts = 0;
    const ctx = scopeFor(db, record, dir, {
      canTalk: () => allowed,
      processFinalOutput: vi.fn(async () => { attempts++; return { status: 'delivered' as const, messageId: 'om_ok' }; }),
    });
    await ctx.run();
    expect(db.read(record.id)?.state).toBe('blocked');
    expect(attempts).toBe(0); // rejected before any provider effect
    expect(ctx.ds.agentAttention).toBeDefined();
    // Allowlist resolves (sidecar load / /grant persist / API recovery).
    allowed = true;
    await vi.advanceTimersByTimeAsync(5_001);
    await ctx.run();
    expect(db.read(record.id)?.state).toBe('settled');
    expect(attempts).toBe(1);
    // The startup blip must NOT latch the attention after a later success.
    expect(ctx.ds.agentAttention).toBeUndefined();
    vi.useRealTimers();
  });
  it('files a deterministic non-native drop (binding mismatch, undefined receipt) as terminal rejected', async () => {
    const dir = directory(); const db = database();
    const record = db.accept(outputSnapshot(app, output),
      { kind: 'im', context: { target: { mode: 'plain', chatId: 'oc' } }, chatId: 'oc', chatType: 'group' });
    // processFinalOutput returns undefined AND the binding mismatch predicate
    // fires: a definite "this output will never be posted", not an in-flight write.
    const ctx = scopeFor(db, record, dir, {
      sessionMismatch: true,
      processFinalOutput: vi.fn(async () => undefined),
    });
    await ctx.run();
    expect(db.read(record.id)?.state).toBe('rejected');
    expect(db.read(record.id)?.reason).toContain('output_dropped_without_receipt');
  });
  it('keeps an undefined receipt from a recoverable failure (transfer/EIO/doc 5xx) in blocked, not terminal', async () => {
    vi.useFakeTimers();
    const dir = directory(); const db = database();
    const record = db.accept(outputSnapshot(app, output),
      { kind: 'im', context: { target: { mode: 'plain', chatId: 'oc' } }, chatId: 'oc', chatType: 'group' });
    // No binding mismatch: the undefined receipt is a transient false-completion
    // (ownership lost mid-transfer, store EIO, doc 5xx) — must self-heal.
    let attempts = 0;
    const ctx = scopeFor(db, record, dir, {
      sessionMismatch: false,
      processFinalOutput: vi.fn(async () => { if (++attempts === 1) return undefined; return { status: 'delivered' as const, messageId: 'om_ok' }; }),
    });
    await ctx.run();
    expect(db.read(record.id)?.state).toBe('blocked');
    await vi.advanceTimersByTimeAsync(5_001);
    await ctx.run();
    expect(db.read(record.id)?.state).toBe('settled');
    expect(attempts).toBe(2);
    vi.useRealTimers();
  });
  it('files a governance blocklist decision (reason blocked) as terminal, but keeps reason none recoverable', async () => {
    vi.useFakeTimers();
    const dir = directory(); const db = database();
    const blocked = db.accept(outputSnapshot(app, output),
      { kind: 'im', context: { target: { mode: 'plain', chatId: 'oc' }, requesterOpenId: 'ou_banned' }, chatId: 'oc', chatType: 'group' });
    const ctxB = scopeFor(db, blocked, dir, {
      canTalk: false, talkReason: 'blocked',
      processFinalOutput: vi.fn(async () => ({ status: 'delivered' as const })),
    });
    await ctxB.run();
    expect(db.read(blocked.id)?.state).toBe('rejected');
    vi.useRealTimers();
  });
  it('keeps a native final without its codex ACK in blocked (in flight, never terminal)', async () => {
    vi.useFakeTimers();
    const dir = directory(); const db = database();
    const native: WorkerFinalOutput = { ...output, codexAppSettlement: { requestId: 'r1', generation: 'g', seq: 1, dispatchId: 'd' } };
    const record = db.accept(outputSnapshot(app, native), { kind: 'managed' });
    let attempts = 0;
    const ctx = scopeFor(db, record, dir, {
      processFinalOutput: vi.fn(async () => { if (++attempts === 1) return undefined; return { status: 'delegated' as const, owner: 'codex_app_dispatch_persisted' }; }),
    });
    await ctx.run();
    expect(db.read(record.id)?.state).toBe('blocked');
    await vi.advanceTimersByTimeAsync(5_001);
    await ctx.run();
    expect(db.read(record.id)?.state).toBe('settled');
    expect(attempts).toBe(2);
    vi.useRealTimers();
  });
});

describe('rejected terminal state guards', () => {
  it('excludes rejected rows from claim, pending scan and coordinator delivery', async () => {
    const dir = directory(); const db = database();
    const record = db.accept(outputSnapshot(app, output), { kind: 'managed' });
    const firstOwner = db.newOwner();
    expect(db.claim(record.id, firstOwner)).toBe(true);
    expect(db.rejectTerminal(record.id, firstOwner, 'output_original_channel_changed')).toBe(true);
    // Guard 1: a rejected row can never be claimed again by any owner.
    expect(db.claim(record.id, db.newOwner())).toBe(false);
    // Guard 2: rejected rows never enter the recovery scan (global + per-session).
    expect(db.pending()).toEqual([]);
    expect(db.pending(output.sessionId!)).toEqual([]);
    expect(db.hasUnsettled(output.sessionId!)).toBe(false);
    expect(db.hasTerminalRejection(output.sessionId!)).toBe(true);
    // With a later live row bounding the watermark above the rejected row, the
    // scan must still skip the rejected row (exercises the SELECT predicate,
    // not only the watermark's MAX aggregation).
    const later = db.accept(outputSnapshot(app, { ...output, turnId: 'om_later', lastUuid: 'later' }, Date.now() + 1), { kind: 'managed' });
    const scanned = db.pending(output.sessionId!);
    expect(scanned.map(r => r.id)).toEqual([later.id]);
    // Guard 3: coordinator delivery early-returns without invoking process,
    // settled or error — the row is a inert inspection record.
    const coordinator = new OutputDeliveryCoordinator(db);
    const process = vi.fn(async () => ({ status: 'delivered' as const }));
    const settled = vi.fn(); const error = vi.fn();
    await coordinator.deliver(db.read(record.id)!, { owns: () => true, process, settled, error });
    expect(process).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
  it('rejectTerminal refuses a non-owner and a settled row', () => {
    const dir = directory(); const db = database();
    const record = db.accept(outputSnapshot(app, output), { kind: 'managed' });
    const owner = db.newOwner();
    db.claim(record.id, owner);
    expect(db.rejectTerminal(record.id, db.newOwner(), 'x')).toBe(false); // stale owner
    expect(db.read(record.id)?.state).toBe('processing');
    expect(db.complete(record.id, owner, { status: 'suppressed' })).toBe(true);
    expect(db.rejectTerminal(record.id, owner, 'x')).toBe(false); // already settled
  });
});

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
    const scope: any = { closeRequested: false, log: vi.fn(), workerIpcPayload: (msg: WorkerFinalOutput) => msg, sessionEventMetadata: (msg: WorkerFinalOutput) => msg,
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
      ownsLifecycleMutation: () => true, ownsWorkerSession: () => true, isSessionTransferring: () => false, sessionController: undefined, logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
  const scope: any = { ds, worker, journal: db, coordinator: new OutputDeliveryCoordinator(db), ownsLifecycleMutation: () => true, ownsWorkerSession: () => true, isSessionTransferring: () => false, sessionController: undefined,
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
    const scope: any = { ds, worker, t: 'probe', workerGeneration: 1, cb: {}, journal: host, coordinator: new OutputDeliveryCoordinator(host), ownsLifecycleMutation: () => true, ownsWorkerSession: () => true, isSessionTransferring: () => false, sessionController: undefined, logger: { warn: vi.fn() }, committedCodexAppSequence, hasUnsettledCodexAppDispatch, reconcileOrdinaryTurnRecoveryTerminalReceipt: () => {}, FINAL_HANDOFF_DELIVERY_REASON: 'pending' };
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
