import { describe, it, expect, beforeAll } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CodexRpcEngine } from '../src/codex-rpc-engine.js';

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A real subprocess app-server stand-in (HTTP /readyz + JSON-RPC WS on one port).
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-codex-rpc-server.mjs', import.meta.url));
beforeAll(() => { chmodSync(FIXTURE, 0o755); });

function makeEngine(over: Partial<ConstructorParameters<typeof CodexRpcEngine>[0]> = {}) {
  return new CodexRpcEngine({
    cliBin: FIXTURE, cwd: '/tmp', env: process.env,
    sessionId: `test-${Math.round(performance.now())}-${over.sessionId ?? ''}`,
    ...over,
  });
}
const owner = (turnId: string, dispatchAttempt?: number) => ({
  turnId,
  ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
});

describe('CodexRpcEngine — happy-path lifecycle against a fake app-server', () => {
  it('start (spawn → /readyz → connect → initialize) then startThread → sendTurn → stop', async () => {
    const engine = makeEngine();
    await engine.start();
    const tid = await engine.startThread();
    expect(tid).toBe('thread-fake-1');
    expect(engine.activeThreadId).toBe('thread-fake-1');
    expect(engine.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    await expect(engine.sendTurn('hello world', owner('turn-1', 1)))
      .resolves.toEqual({ nativeTurnId: 'turn-fake-1' });
    engine.stop();
  }, 20_000);

  it('resumeThread returns the resumed (persisted) thread id — resume-survival path', async () => {
    const engine = makeEngine({ sessionId: 'resume' });
    await engine.start();
    const tid = await engine.resumeThread('thread-persisted-42');
    expect(tid).toBe('thread-persisted-42');
    engine.stop();
  }, 20_000);

  it('maps an ultra-fast turn/completed to the exact Botmux attempt', async () => {
    const terminals: any[] = [];
    const engine = makeEngine({
      sessionId: 'terminal-map',
      onTurnTerminal: terminal => terminals.push(terminal),
    });
    await engine.start();
    await engine.startThread();
    await engine.sendTurn('fast', owner('botmux-fast', 7));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(terminals).toEqual([expect.objectContaining({
      identity: { turnId: 'botmux-fast', dispatchAttempt: 7 },
      nativeTurnId: 'turn-fake-1',
      status: 'completed',
    })]);
    engine.stop();
  }, 20_000);

  it('maps turn/completed that arrives before turn/start response without resurrecting the turn', async () => {
    const terminals: any[] = [];
    const engine = makeEngine({
      sessionId: 'terminal-before-response',
      env: { ...process.env, FAKE_TERMINAL_BEFORE_RESPONSE: '1' },
      onTurnTerminal: terminal => terminals.push(terminal),
    });
    await engine.start();
    await engine.startThread();
    await expect(engine.sendTurn('fastest', owner('before-response', 8)))
      .resolves.toEqual({ nativeTurnId: 'turn-fake-1' });
    expect(terminals).toEqual([expect.objectContaining({
      identity: { turnId: 'before-response', dispatchAttempt: 8 },
      nativeTurnId: 'turn-fake-1',
      status: 'completed',
    })]);

    // If response binding resurrected the already-terminal native id, stop()
    // would attempt another terminal callback. Native-terminal de-dupe masks
    // that callback, so assert the internal active ownership is actually empty.
    expect((engine as any).turnOwners.size).toBe(0);
    engine.stop();
  }, 20_000);

  it('deduplicates duplicate native terminal notifications', async () => {
    const terminals: any[] = [];
    const engine = makeEngine({
      sessionId: 'duplicate-terminal',
      env: { ...process.env, FAKE_DUPLICATE_TERMINAL: '1' },
      onTurnTerminal: terminal => terminals.push(terminal),
    });
    await engine.start();
    await engine.startThread();
    await engine.sendTurn('once', owner('dedupe', 9));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toEqual(expect.objectContaining({
      identity: { turnId: 'dedupe', dispatchAttempt: 9 },
      status: 'completed',
    }));
    engine.stop();
  }, 20_000);

  it('keeps sequential resume/typeahead attempts isolated by native turn id', async () => {
    const terminals: any[] = [];
    const engine = makeEngine({
      sessionId: 'terminal-sequential',
      onTurnTerminal: terminal => terminals.push(terminal),
    });
    await engine.start();
    await engine.resumeThread('thread-persisted');
    await engine.sendTurn('one', owner('same-logical', 1));
    await engine.sendTurn('two', owner('same-logical', 2));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(terminals.map(t => [t.nativeTurnId, t.identity.dispatchAttempt])).toEqual([
      ['turn-fake-1', 1],
      ['turn-fake-2', 2],
    ]);
    engine.stop();
  }, 20_000);
});

describe('CodexRpcEngine — failure/recovery paths', () => {
  it('P1-5: a wedged turn/start times out → onDead fires (fatal recovery, not a silent hang)', async () => {
    let deadCount = 0;
    const engine = makeEngine({
      sessionId: 'hang',
      env: { ...process.env, FAKE_HANG_TURN: '1' },
      requestTimeoutMs: 400,
      onDead: () => { deadCount++; },
    });
    await engine.start();
    await engine.startThread();
    await expect(engine.sendTurn('never answered', owner('turn-hang', 1))).rejects.toThrow(/timed out/);
    expect(deadCount).toBe(1); // failAll → onDead exactly once
    engine.stop();
  }, 20_000);

  it('lost follow-up ack with an exact native terminal resolves as accepted and does not kill the engine', async () => {
    let deadCount = 0;
    const terminals: any[] = [];
    const engine = makeEngine({
      sessionId: 'followup-lost-ack-terminal',
      env: {
        ...process.env,
        FAKE_HANG_TURN: '1',
        FAKE_HANG_TURN_NOTIFY: '1',
      },
      requestTimeoutMs: 400,
      onDead: () => { deadCount++; },
      onTurnTerminal: terminal => terminals.push(terminal),
    });
    await engine.start();
    await engine.startThread();
    await expect(engine.sendTurn('completed despite lost ack', owner('followup-proof', 4)))
      .resolves.toEqual({ nativeTurnId: 'turn-fake-1' });
    expect(deadCount).toBe(0);
    expect(terminals).toEqual([expect.objectContaining({
      identity: { turnId: 'followup-proof', dispatchAttempt: 4 },
      status: 'completed',
    })]);
    engine.stop();
  }, 20_000);

  it('app-server crash → onDead fires so the worker can restart the pane', async () => {
    let dead = false;
    const engine = makeEngine({
      sessionId: 'crash',
      env: { ...process.env, FAKE_DIE_AFTER_MS: '600' },
      onDead: () => { dead = true; },
    });
    await engine.start();
    await engine.startThread();
    await new Promise((r) => setTimeout(r, 1500)); // let the fixture exit(1)
    expect(dead).toBe(true);
    engine.stop();
  }, 20_000);

  it('P1-2: reapStaleAppServer refuses to kill a REUSED pid that is not our app-server', async () => {
    // Simulate a marker left by a SIGKILLed worker whose pid was reused by an
    // unrelated process (a harmless `sleep`, NOT an app-server). A broken guard
    // would kill it; the identity check (argv has no `app-server`) must spare it.
    const sid = `reuse-guard-${Math.round(performance.now())}`;
    const dir = join(homedir(), '.botmux', 'data', 'codex-rpc-app-servers');
    mkdirSync(dir, { recursive: true });
    const marker = join(dir, `${sid}.pid`);
    const sleeper = spawn('sleep', ['30'], { detached: true });
    sleeper.unref();
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(marker, `${sleeper.pid}\nws://127.0.0.1:59999`); // reused pid + a url it can't have

    const engine = makeEngine({ sessionId: sid });
    await engine.start();            // triggers reapStaleAppServer(sid)
    expect(isAlive(sleeper.pid!)).toBe(true); // NOT mis-killed
    engine.stop();
    try { process.kill(-sleeper.pid!, 'SIGKILL'); } catch { /* */ }
  }, 20_000);

  it('P1-1 sendFirstTurn: ack received → accepted (rollout probe not needed)', async () => {
    let probed = false;
    const engine = makeEngine({ sessionId: 'first-ok' });
    await engine.start();
    await engine.startThread();
    const outcome = await engine.sendFirstTurn('hello', owner('turn-1', 1), async () => { probed = true; return false; });
    expect(outcome).toEqual({ outcome: 'accepted', nativeTurnId: 'turn-fake-1' });
    expect(probed).toBe(false); // ack answered → no need to consult the rollout
    engine.stop();
  }, 20_000);

  it('P1-1 sendFirstTurn: frame NOT dispatched (ws down) → not-sent (safe paste)', async () => {
    const engine = makeEngine({ sessionId: 'first-notsent' });
    await engine.start();
    await engine.startThread();
    (engine as any).ws = undefined; // simulate ws not open → send() throws before the frame leaves
    const outcome = await engine.sendFirstTurn('hello', owner('turn-1', 1), async () => true);
    expect(outcome).toEqual({ outcome: 'not-sent' });
    engine.stop();
  }, 20_000);

  it('P1-1 sendFirstTurn: dispatched, accepted+persisted but NO response, rollout HIT → accepted (0 paste)', async () => {
    const engine = makeEngine({ sessionId: 'first-amb-hit', env: { ...process.env, FAKE_HANG_TURN: '1' }, requestTimeoutMs: 400 });
    await engine.start();
    await engine.startThread();
    // frame dispatched, no ack within 400ms, but the rollout shows the user turn.
    const outcome = await engine.sendFirstTurn('hello', owner('turn-1', 1), async () => true);
    expect(outcome).toEqual({ outcome: 'accepted' }); // positive evidence → never resend
    engine.stop();
  }, 20_000);

  it('lost ack still maps native terminal exactly when started/completed broadcasts identify the sole outbound turn', async () => {
    const terminals: any[] = [];
    const engine = makeEngine({
      sessionId: 'first-lost-ack-native',
      env: {
        ...process.env,
        FAKE_HANG_TURN: '1',
        FAKE_HANG_TURN_NOTIFY: '1',
      },
      requestTimeoutMs: 400,
      onTurnTerminal: terminal => terminals.push(terminal),
    });
    await engine.start();
    await engine.startThread();
    const outcome = await engine.sendFirstTurn(
      'hello',
      owner('first-native', 3),
      async () => true,
    );
    expect(outcome).toEqual({ outcome: 'accepted', nativeTurnId: 'turn-fake-1' });
    expect(terminals).toEqual([expect.objectContaining({
      identity: { turnId: 'first-native', dispatchAttempt: 3 },
      nativeTurnId: 'turn-fake-1',
      status: 'completed',
    })]);
    engine.stop();
  }, 20_000);

  it('lost first-turn ack with turn/started native ownership is accepted even before rollout evidence', async () => {
    let probed = false;
    const engine = makeEngine({
      sessionId: 'first-lost-ack-started',
      env: {
        ...process.env,
        FAKE_HANG_TURN: '1',
        FAKE_HANG_TURN_NOTIFY: '1',
        FAKE_NO_TURN_TERMINAL: '1',
      },
      requestTimeoutMs: 400,
    });
    await engine.start();
    await engine.startThread();
    const outcome = await engine.sendFirstTurn(
      'hello',
      owner('first-started', 5),
      async () => { probed = true; return false; },
    );
    expect(outcome).toEqual({
      outcome: 'accepted',
      nativeTurnId: 'turn-fake-1',
    });
    expect(probed).toBe(false);
    engine.stop();
  }, 20_000);

  it.each([
    ['aborted', 'aborted', undefined],
    ['failed', 'failed', 'fake_failed'],
  ] as const)('maps native %s completion to worker terminal %s', async (nativeStatus, expectedStatus, errorCode) => {
    const terminals: any[] = [];
    const engine = makeEngine({
      sessionId: `terminal-${nativeStatus}`,
      env: { ...process.env, FAKE_TURN_STATUS: nativeStatus },
      onTurnTerminal: terminal => terminals.push(terminal),
    });
    await engine.start();
    await engine.startThread();
    await engine.sendTurn(nativeStatus, owner(`turn-${nativeStatus}`, 6));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(terminals).toEqual([expect.objectContaining({
      identity: { turnId: `turn-${nativeStatus}`, dispatchAttempt: 6 },
      status: expectedStatus,
      ...(errorCode ? { errorCode } : {}),
    })]);
    engine.stop();
  }, 20_000);

  it('P1-1 sendFirstTurn: dispatched, no ack, NO rollout evidence → ambiguous (never downgraded to safe)', async () => {
    const engine = makeEngine({ sessionId: 'first-amb', env: { ...process.env, FAKE_HANG_TURN: '1' }, requestTimeoutMs: 400 });
    await engine.start();
    await engine.startThread();
    const outcome = await engine.sendFirstTurn('hello', owner('turn-1', 1), async () => false);
    expect(outcome).toEqual({ outcome: 'ambiguous' }); // absence of evidence stays ambiguous → 0 auto-paste
    engine.stop();
  }, 20_000);

  it('P1-1 sendFirstTurn: rollout probe failure stays ambiguous instead of falling back to paste', async () => {
    const engine = makeEngine({
      sessionId: 'first-probe-error',
      env: { ...process.env, FAKE_HANG_TURN: '1' },
      requestTimeoutMs: 400,
    });
    await engine.start();
    await engine.startThread();
    const outcome = await engine.sendFirstTurn(
      'hello',
      owner('turn-probe-error', 2),
      async () => { throw new Error('rollout unavailable'); },
    );
    expect(outcome).toEqual({ outcome: 'ambiguous' });
    engine.stop();
  }, 20_000);

  it('P1-2 ABA: an old engine\'s late child-exit does NOT delete a marker another engine now owns', async () => {
    const sid = `aba-${Math.round(performance.now())}`;
    const dir = join(homedir(), '.botmux', 'data', 'codex-rpc-app-servers');
    mkdirSync(dir, { recursive: true });
    const marker = join(dir, `${sid}.pid`);
    const engine = makeEngine({ sessionId: sid });
    await engine.start(); // writes marker = A's pid + A's wsUrl
    expect(existsSync(marker)).toBe(true);
    // Engine B took over: overwrite the marker with a different owner.
    writeFileSync(marker, `999999\nws://127.0.0.1:1`);
    engine.stop(); // A's SIGTERM → child exits → removeMarkerIfOwned reads B's marker → owner mismatch → keeps it
    await new Promise((r) => setTimeout(r, 2600)); // let the bounded SIGKILL + exit handler run
    expect(existsSync(marker)).toBe(true); // B's marker survived A's late exit (no orphan)
    try { rmSync(marker, { force: true }); } catch { /* */ }
  }, 20_000);

  it('stop() is idempotent and does NOT fire onDead (expected teardown)', async () => {
    let dead = false;
    const engine = makeEngine({ sessionId: 'stop', onDead: () => { dead = true; } });
    await engine.start();
    await engine.startThread();
    engine.stop();
    engine.stop();
    await new Promise((r) => setTimeout(r, 300));
    expect(dead).toBe(false);
  }, 20_000);

  it('stop releases every still-active native turn with its exact owner', async () => {
    const terminals: any[] = [];
    const engine = makeEngine({
      sessionId: 'stop-active',
      env: { ...process.env, FAKE_NO_TURN_TERMINAL: '1' },
      onTurnTerminal: terminal => terminals.push(terminal),
    });
    await engine.start();
    await engine.startThread();
    await engine.sendTurn('keep running', owner('active-stop', 11));
    engine.stop();
    expect(terminals).toEqual([expect.objectContaining({
      identity: { turnId: 'active-stop', dispatchAttempt: 11 },
      status: 'stopped',
      errorCode: 'rpc_engine_stopped',
    })]);
  }, 20_000);

  it('engine death releases every still-active native turn before onDead recovery', async () => {
    const order: string[] = [];
    const engine = makeEngine({
      sessionId: 'death-active',
      env: {
        ...process.env,
        FAKE_NO_TURN_TERMINAL: '1',
        FAKE_DIE_AFTER_MS: '600',
      },
      onTurnTerminal: terminal => order.push(`terminal:${terminal.identity.turnId}:${terminal.status}`),
      onDead: () => order.push('dead'),
    });
    await engine.start();
    await engine.startThread();
    await engine.sendTurn('active on crash', owner('active-dead', 12));
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(order).toEqual(['terminal:active-dead:engine-dead', 'dead']);
    engine.stop();
  }, 20_000);
});
