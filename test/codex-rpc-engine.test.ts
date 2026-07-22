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

describe('CodexRpcEngine — happy-path lifecycle against a fake app-server', () => {
  it('start (spawn → /readyz → connect → initialize) then startThread → sendTurn → stop', async () => {
    const engine = makeEngine();
    await engine.start();
    const tid = await engine.startThread();
    expect(tid).toBe('thread-fake-1');
    expect(engine.activeThreadId).toBe('thread-fake-1');
    expect(engine.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    await engine.sendTurn('hello world'); // resolves on the ack, no throw
    await engine.waitForThreadName();
    await engine.setThreadName('[BotMux·Lark] hello world');
    engine.stop();
  }, 20_000);

  it('waits for a delayed automatic title before allowing the final title write', async () => {
    const engine = makeEngine({
      sessionId: 'delayed-title',
      env: { ...process.env, FAKE_TITLE_DELAY_READS: '2' },
    });
    await engine.start();
    await engine.startThread();
    expect(await engine.waitForThreadName()).toBe('<botmux_routing> automatic title');
    await engine.setThreadName('[BotMux·Lark] final title');
    engine.stop();
  }, 20_000);

  it('waits for resumed-thread metadata to advance before restoring its title', async () => {
    const engine = makeEngine({
      sessionId: 'resume-title',
      env: {
        ...process.env,
        FAKE_UPDATED_DELAY_READS: '2',
        FAKE_UPDATED_BEFORE: '100',
        FAKE_UPDATED_AFTER: '101',
      },
    });
    await engine.start();
    await engine.resumeThread('thread-resumed-title');
    expect((await engine.readThreadMetadata()).updatedAt).toBe(100);
    await engine.waitForThreadUpdatedAfter(100);
    await engine.setThreadName('[BotMux·Lark] resumed title');
    engine.stop();
  }, 20_000);

  it('resumeThread returns the resumed (persisted) thread id — resume-survival path', async () => {
    const engine = makeEngine({ sessionId: 'resume' });
    await engine.start();
    const tid = await engine.resumeThread('thread-persisted-42');
    expect(tid).toBe('thread-persisted-42');
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
    await expect(engine.sendTurn('never answered')).rejects.toThrow(/timed out/);
    expect(deadCount).toBe(1); // failAll → onDead exactly once
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
    const outcome = await engine.sendFirstTurn('hello', 'turn-1', async () => { probed = true; return false; });
    expect(outcome).toBe('accepted');
    expect(probed).toBe(false); // ack answered → no need to consult the rollout
    engine.stop();
  }, 20_000);

  it('P1-1 sendFirstTurn: frame NOT dispatched (ws down) → not-sent (safe paste)', async () => {
    const engine = makeEngine({ sessionId: 'first-notsent' });
    await engine.start();
    await engine.startThread();
    (engine as any).ws = undefined; // simulate ws not open → send() throws before the frame leaves
    const outcome = await engine.sendFirstTurn('hello', 'turn-1', async () => true);
    expect(outcome).toBe('not-sent');
    engine.stop();
  }, 20_000);

  it('P1-1 sendFirstTurn: dispatched, accepted+persisted but NO response, rollout HIT → accepted (0 paste)', async () => {
    const engine = makeEngine({ sessionId: 'first-amb-hit', env: { ...process.env, FAKE_HANG_TURN: '1' }, requestTimeoutMs: 400 });
    await engine.start();
    await engine.startThread();
    // frame dispatched, no ack within 400ms, but the rollout shows the user turn.
    const outcome = await engine.sendFirstTurn('hello', 'turn-1', async () => true);
    expect(outcome).toBe('accepted'); // positive evidence → never resend
    engine.stop();
  }, 20_000);

  it('P1-1 sendFirstTurn: dispatched, no ack, NO rollout evidence → ambiguous (never downgraded to safe)', async () => {
    const engine = makeEngine({ sessionId: 'first-amb', env: { ...process.env, FAKE_HANG_TURN: '1' }, requestTimeoutMs: 400 });
    await engine.start();
    await engine.startThread();
    const outcome = await engine.sendFirstTurn('hello', 'turn-1', async () => false);
    expect(outcome).toBe('ambiguous'); // absence of evidence stays ambiguous → 0 auto-paste
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
});
