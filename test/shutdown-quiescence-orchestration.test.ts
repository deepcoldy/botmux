import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { waitAllWithin, trackProducerQuiet, trackProcessExited, type ProducerHandle } from '../src/core/producer-quiescence.ts';
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

// Reaping vs producer-fence separation, exercised against REAL child processes
// so exit vs disconnect timing is real. Models the daemon's Phase-1 reaping:
// register exit promises before signals, grace-wait exit, SIGKILL still-alive,
// confirm exit — independent of the producer (disconnect) fence.
describe('shutdown reaping / producer-fence separation (real ChildProcess)', () => {
  const kids: ChildProcess[] = [];
  afterEach(() => { for (const k of kids.splice(0)) { try { k.kill('SIGKILL'); } catch { /* */ } } });

  async function spawnIpcChild(setup: string): Promise<ChildProcess> {
    // `ready` is a happens-before barrier: the parent signals immediately after
    // it, so every handler needed by that signal must already be installed.
    const child = spawn(process.execPath, ['-e', `${setup}\nprocess.send?.({ ready: true });`], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    kids.push(child);
    await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error('no ready')), 5000); child.once('message', (m: any) => { if (m?.ready) { clearTimeout(t); res(); } }); });
    return child;
  }

  // A) SIGTERM → immediate disconnect, but process exits ~1s later. Reaping must
  //    NOT SIGKILL it at the grace boundary just because it disconnected fast;
  //    it must actually wait for exit (cleanup window preserved).
  it('A: fast disconnect + slow exit is not SIGKILLed; reaping waits for the real exit', async () => {
    // Worker disconnects its IPC immediately on SIGTERM, then exits after ~600ms.
    const child = await spawnIpcChild(`process.on('SIGTERM', () => { try { process.disconnect(); } catch {}; setTimeout(() => process.exit(0), 600); }); setInterval(()=>{},100000);`);
    const { done: exitDone } = trackProcessExited(child as ProducerHandle);

    child.kill('SIGTERM');
    // Phase 1 reaping: grace-wait exit (generous), then SIGKILL if still alive.
    const graceDeadline = Date.now() + 2000;
    await waitAllWithin([exitDone!], graceDeadline);
    let sigkilled = false;
    if (child.exitCode === null && child.signalCode === null) { sigkilled = true; child.kill('SIGKILL'); }

    expect(sigkilled).toBe(false);                 // was NOT hard-killed at grace boundary
    expect(child.signalCode).not.toBe('SIGKILL');  // exited on its own (code 0), not by our SIGKILL
    expect(child.exitCode).toBe(0);
  });

  // B) Worker whose IPC is already disconnected but process stays alive and
  //    IGNORES SIGTERM. Producer fence sees it quiet, but reaping MUST still
  //    track it and escalate to SIGKILL — otherwise it is a ppid=1 orphan.
  it('B: already-disconnected-but-alive worker ignoring SIGTERM is still reaped and SIGKILLed', async () => {
    const child = await spawnIpcChild(`process.on('SIGTERM', () => { /* ignore */ }); setInterval(()=>{},100000);`);
    child.disconnect();                             // IPC already gone before shutdown
    await new Promise(r => child.once('disconnect', () => r(null)));
    expect(child.connected).not.toBe(true);

    // Producer fence: already quiet (no terminal source) — correct.
    expect(trackProducerQuiet(child as ProducerHandle).alreadyQuiet).toBe(true);
    // Reaping: NOT already exited — must be tracked.
    const { alreadyExited, done: exitDone } = trackProcessExited(child as ProducerHandle);
    expect(alreadyExited).toBe(false);

    child.kill('SIGTERM');                          // ignored by the child
    const graceDeadline = Date.now() + 300;
    await waitAllWithin([exitDone!], graceDeadline);
    // Still alive after grace → escalate to SIGKILL, then confirm exit.
    expect(child.exitCode === null && child.signalCode === null).toBe(true);
    child.kill('SIGKILL');
    const exited = await Promise.race([exitDone!.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 2000))]);
    expect(exited).toBe(true);
    expect(child.signalCode).toBe('SIGKILL');       // reaped by our SIGKILL
  });
});
