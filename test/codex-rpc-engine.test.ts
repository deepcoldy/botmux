import { describe, it, expect, beforeAll } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
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

function readRpcLog(path: string): Array<{ method?: string; params?: Record<string, unknown> }> {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

describe('CodexRpcEngine — happy-path lifecycle against a fake app-server', () => {
  it('resolves the model catalog Fast tier and pins it on thread/start + turn/start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-fast-rpc-'));
    const rpcLog = join(dir, 'rpc.jsonl');
    const engine = makeEngine({
      model: 'gpt-fast',
      fastMode: true,
      env: { ...process.env, FAKE_RPC_LOG: rpcLog },
    });

    try {
      await engine.start();
      await engine.startThread();
      await engine.sendTurn('run fast');

      const requests = readRpcLog(rpcLog);
      expect(requests.find(entry => entry.method === 'model/list')).toBeDefined();
      expect(requests.find(entry => entry.method === 'thread/start')?.params).toMatchObject({
        serviceTier: 'priority',
      });
      expect(requests.find(entry => entry.method === 'turn/start')?.params).toMatchObject({
        serviceTier: 'priority',
      });
    } finally {
      engine.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('pins Fast on thread/resume and applies runtime changes through acknowledged thread settings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-fast-rpc-update-'));
    const rpcLog = join(dir, 'rpc.jsonl');
    const engine = makeEngine({
      model: 'gpt-fast',
      env: { ...process.env, FAKE_RPC_LOG: rpcLog },
    });

    try {
      await engine.start();
      await engine.resumeThread('thread-fast-resume');
      await engine.setFastMode(true);
      await engine.sendTurn('fast turn');
      await engine.setFastMode(false);
      await engine.sendTurn('default turn');

      const requests = readRpcLog(rpcLog);
      const resume = requests.find(entry => entry.method === 'thread/resume');
      expect(resume?.params).toMatchObject({ serviceTier: null });
      const updates = requests.filter(entry => entry.method === 'thread/settings/update');
      expect(updates.map(entry => entry.params?.serviceTier)).toEqual(['priority', null]);
      const turns = requests.filter(entry => entry.method === 'turn/start');
      expect(turns.map(entry => entry.params?.serviceTier)).toEqual(['priority', null]);
    } finally {
      engine.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects Fast before thread creation when the selected model has no Fast tier', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-fast-rpc-unsupported-'));
    const rpcLog = join(dir, 'rpc.jsonl');
    const engine = makeEngine({
      model: 'gpt-standard',
      fastMode: true,
      env: { ...process.env, FAKE_RPC_LOG: rpcLog },
    });

    try {
      await engine.start();
      await expect(engine.startThread()).rejects.toThrow(/Fast Mode is not supported/);
      expect(readRpcLog(rpcLog).some(entry => entry.method === 'thread/start')).toBe(false);
    } finally {
      engine.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('start (spawn → /readyz → connect → initialize) then startThread → sendTurn → stop', async () => {
    const engine = makeEngine();
    await engine.start();
    const tid = await engine.startThread();
    expect(tid).toBe('thread-fake-1');
    expect(engine.activeThreadId).toBe('thread-fake-1');
    expect(engine.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    await engine.sendTurn('hello world'); // resolves on the ack, no throw
    await engine.waitForThreadPreview();
    await engine.setThreadName('[BotMux·Lark] hello world');
    engine.stop();
  }, 20_000);

  it('waits for a delayed first-message preview before allowing the final title write', async () => {
    const engine = makeEngine({
      sessionId: 'delayed-preview',
      env: { ...process.env, FAKE_PREVIEW_DELAY_READS: '2' },
    });
    await engine.start();
    await engine.startThread();
    expect(await engine.waitForThreadPreview()).toBe('<botmux_routing> first message preview');
    await engine.setThreadName('[BotMux·Lark] final title');
    engine.stop();
  }, 20_000);

  it('sets the final title when the first-message preview remains unavailable', async () => {
    const engine = makeEngine({
      sessionId: 'missing-preview',
      env: { ...process.env, FAKE_PREVIEW_DELAY_READS: '999999' },
    });
    await engine.start();
    await engine.startThread();
    expect(await engine.waitForThreadPreview(200)).toBeUndefined();
    await engine.setThreadName('[BotMux·Lark] final title');
    expect((await engine.readThreadMetadata()).name).toBe('[BotMux·Lark] final title');
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

  it('bridges requestUserInput server requests to the host callback', async () => {
    let received: unknown;
    let resolveReceived!: () => void;
    const receivedPromise = new Promise<void>(resolve => { resolveReceived = resolve; });
    const engine = makeEngine({
      env: { ...process.env, FAKE_REQUEST_USER_INPUT: '1' },
      appServerFeatures: ['default_mode_request_user_input'],
      onRequestUserInput: async params => {
        received = params;
        resolveReceived();
        return { answers: { choice: { answers: ['Yes'] } } };
      },
    });
    await engine.start();
    await engine.startThread();
    await engine.sendTurn('ask me');
    await receivedPromise;
    expect(received).toMatchObject({
      questions: [{ id: 'choice', question: 'Continue?' }],
    });
    engine.stop();
  }, 20_000);

  it('interrupts the turn (not a benign reply) when the input bridge rejects', async () => {
    // The blocker fix. Verified against real traex 0.200.19: replying to
    // requestUserInput with empty answers OR a JSON-RPC error is normalized to
    // {answers:{}} and the turn still COMPLETES, silently skipping the ask. Only
    // `turn/interrupt` actually stops the turn. So on bridge rejection the engine
    // must send turn/interrupt — asserted here via the engine log + the fixture
    // resolving turn/start as an interrupted turn rather than a completed one.
    const logs: string[] = [];
    const engine = makeEngine({
      env: { ...process.env, FAKE_REQUEST_USER_INPUT: '1' },
      appServerFeatures: ['default_mode_request_user_input'],
      log: (m: string) => logs.push(m),
      onRequestUserInput: async () => { throw new Error('cannot represent as ask card'); },
    });
    await engine.start();
    await engine.startThread();
    // turn/start resolves (interrupted), so sendTurn does not throw here; the
    // point is that the turn was stopped, not silently completed.
    await engine.sendTurn('ask me');
    // Give the async interrupt round-trip a moment to log its result.
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(logs.some(l => l.includes('interrupting turn'))).toBe(true);
    expect(logs.some(l => l.includes('turn interrupted after requestUserInput failure'))).toBe(true);
    engine.stop();
  }, 20_000);

  it('declares the engine dead when turn/interrupt itself fails (no permanently wedged turn)', async () => {
    // The interrupt is the last lever we have on bridge failure. If it errors or
    // times out, the turn stays stuck — so the engine must fire onDead so the
    // worker restarts the pane, rather than only logging and leaking the hang.
    let deadCount = 0;
    const engine = makeEngine({
      sessionId: 'interrupt-fail',
      env: { ...process.env, FAKE_REQUEST_USER_INPUT: '1', FAKE_INTERRUPT_ERROR: '1' },
      appServerFeatures: ['default_mode_request_user_input'],
      onRequestUserInput: async () => { throw new Error('cannot represent as ask card'); },
      onDead: () => { deadCount++; },
    });
    await engine.start();
    await engine.startThread();
    // failAll rejects the still-pending turn/start, so sendTurn rejects here —
    // that is the visible failure, not a silent hang. We only care that onDead fired.
    await engine.sendTurn('ask me').catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(deadCount).toBe(1);
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
