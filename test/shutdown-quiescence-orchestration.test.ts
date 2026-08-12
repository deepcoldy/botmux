import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { waitAllWithin, trackProducerQuiet, type ProducerHandle } from '../src/core/producer-quiescence.ts';
import {
  enqueueTurnTerminal,
  drainTurnTerminalQueue,
  __testOnly_pendingTurnTerminalCount,
  __testOnly_reopenTurnTerminalAdmission,
} from '../src/services/turn-completion-events.ts';
import { getSkillFeedbackStore, __testOnly_closeSkillFeedbackStores } from '../src/services/skill-feedback-store.ts';

// Models the daemon shutdown fail-closed staged-quiescence orchestration using
// the SAME extracted primitives the daemon uses (trackProducerQuiet +
// waitAllWithin + drainTurnTerminalQueue), driving controlled producers so the
// decision logic — "close admission and drain ONLY when both fences are
// quiescent within the shared deadline; otherwise keep admission OPEN" — is
// asserted deterministically without booting a full daemon.

const dirs: string[] = [];
function freshDir(): string { const d = mkdtempSync(join(tmpdir(), 'botmux-shutdown-orch-')); dirs.push(d); return d; }
afterEach(async () => {
  __testOnly_reopenTurnTerminalAdmission();
  await __testOnly_closeSkillFeedbackStores();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeProducer(connected: boolean): ProducerHandle & { disconnect: () => void } {
  const ee = new EventEmitter();
  const state = { connected };
  return {
    get connected() { return state.connected; },
    exitCode: null, signalCode: null,
    once(e: string, l: (...a: unknown[]) => void) { ee.once(e, l); return this as unknown; },
    disconnect() { state.connected = false; ee.emit('disconnect'); },
  };
}

/** The daemon's staged decision, extracted to exactly mirror daemon.ts. */
async function orchestrate(opts: {
  producers: Array<ReturnType<typeof fakeProducer>>;
  settlements: Array<Promise<unknown>>;
  settlementCountAfter: () => number;
  deadlineMs: number;
}): Promise<{ disconnectQuiesced: boolean; settlementQuiesced: boolean; drained: boolean }> {
  const producerClosed: Array<Promise<void>> = [];
  for (const p of opts.producers) {
    const { alreadyQuiet, done } = trackProducerQuiet(p);
    if (!alreadyQuiet && done) producerClosed.push(done);
  }
  const disconnectQuiesced = await waitAllWithin(producerClosed, opts.deadlineMs);
  let settlementQuiesced = false;
  if (disconnectQuiesced) {
    await waitAllWithin(opts.settlements, opts.deadlineMs);
    settlementQuiesced = opts.settlementCountAfter() === 0;
  }
  let drained = false;
  if (disconnectQuiesced && settlementQuiesced) {
    await drainTurnTerminalQueue(Math.max(0, opts.deadlineMs - Date.now()));
    drained = true;
  }
  return { disconnectQuiesced, settlementQuiesced, drained };
}

describe('shutdown staged-quiescence orchestration (fail-closed)', () => {
  it('late (but in-budget) disconnect still transitions into drain; the terminal is persisted', async () => {
    const dir = freshDir();
    const store = await getSkillFeedbackStore(dir);
    store.recordTurnDelivery({ botAppId: 'app', sessionId: 'sess', turnId: 'turn-1', nativeSessionId: 'ns', dispatchAttempt: 0,
      platform: 'lark', platformAppId: 'app', platformMessageId: 'om_a', chatId: 'oc', topicRootId: 'om_root',
      content: 'x', cliId: 'claude-code', cardMode: 'feedback', status: 'delivered', requesterSubjectId: 'ou_r', policy: { enabled: true } as any });
    // A terminal was enqueued while the producer was still up (before drain).
    const inflight = enqueueTurnTerminal({ dataDir: dir, botAppId: 'app', sessionId: 'sess', terminal: { turnId: 'turn-1', dispatchAttempt: 0, status: 'completed' } });

    const producer = fakeProducer(true);
    // Producer disconnects at ~200ms — late, but well within a 3s deadline.
    setTimeout(() => producer.disconnect(), 200);
    const result = await orchestrate({
      producers: [producer], settlements: [], settlementCountAfter: () => 0,
      deadlineMs: Date.now() + 3000,
    });
    await inflight;
    expect(result.disconnectQuiesced).toBe(true);
    expect(result.settlementQuiesced).toBe(true);
    expect(result.drained).toBe(true);
    expect(store.listTurnCompletionEvents().length).toBe(1); // persisted
  });

  it('a producer that NEVER disconnects within the deadline keeps admission OPEN — a late terminal is NOT refused', async () => {
    const dir = freshDir();
    const store = await getSkillFeedbackStore(dir);
    store.recordTurnDelivery({ botAppId: 'app', sessionId: 'sess', turnId: 'turn-2', nativeSessionId: 'ns', dispatchAttempt: 0,
      platform: 'lark', platformAppId: 'app', platformMessageId: 'om_b', chatId: 'oc', topicRootId: 'om_root',
      content: 'x', cliId: 'claude-code', cardMode: 'feedback', status: 'delivered', requesterSubjectId: 'ou_r', policy: { enabled: true } as any });

    const stuck = fakeProducer(true); // never disconnects
    const result = await orchestrate({
      producers: [stuck], settlements: [], settlementCountAfter: () => 0,
      deadlineMs: Date.now() + 150, // short deadline: disconnect fence times out
    });
    expect(result.disconnectQuiesced).toBe(false);
    expect(result.drained).toBe(false);         // did NOT close admission

    // Because admission was never closed, a terminal arriving now is accepted &
    // persisted — NOT refused with turn_terminal_persist_refused_shutdown.
    const errors: unknown[] = [];
    await enqueueTurnTerminal({ dataDir: dir, botAppId: 'app', sessionId: 'sess',
      terminal: { turnId: 'turn-2', dispatchAttempt: 0, status: 'completed' }, onError: e => errors.push(e) });
    expect(errors.map(String).join()).not.toContain('refused_shutdown');
    expect(store.listTurnCompletionEvents().length).toBe(1); // accepted & persisted
    stuck.disconnect(); // cleanup
  });

  it('a settlement that never resolves within the deadline keeps admission OPEN (fail-closed)', async () => {
    const dir = freshDir();
    await getSkillFeedbackStore(dir);
    const producer = fakeProducer(true);
    producer.disconnect(); // IPC quiesces immediately...
    let stillInFlight = 1;
    const neverSettles = new Promise(() => { /* pending */ });
    const result = await orchestrate({
      producers: [producer], settlements: [neverSettles],
      settlementCountAfter: () => stillInFlight, // map never drains
      deadlineMs: Date.now() + 150,
    });
    expect(result.disconnectQuiesced).toBe(true);
    expect(result.settlementQuiesced).toBe(false); // settlement fence not quiescent
    expect(result.drained).toBe(false);            // → admission NOT closed
    // admission still open:
    const errors: unknown[] = [];
    await enqueueTurnTerminal({ dataDir: dir, botAppId: 'app', sessionId: 'sess',
      terminal: { turnId: 'turn-x', dispatchAttempt: 0, status: 'completed' }, onError: e => errors.push(e) });
    expect(errors.map(String).join()).not.toContain('refused_shutdown');
    stillInFlight = 0;
  });
});
