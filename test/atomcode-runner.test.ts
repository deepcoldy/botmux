import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(r => child.once('close', () => r()));
      child.kill('SIGTERM');
      await closed;
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'botmux-atomcode-runner-'));
  roots.push(root);
  const executable = join(root, 'atomcode');
  const prefix = tsRunnerPrefix();
  writeFileSync(
    executable,
    `#!/bin/sh\nexec ${[prefix.command, resolve('test/fixtures/fake-atomcode-acp.mjs')].map(quote).join(' ')} "$@"\n`,
    { mode: 0o700 },
  );
  return { root, executable, log: join(root, 'calls.jsonl') };
}

function markers(stdout: string) {
  return [...stdout.matchAll(/\x1b\]777;botmux:(\w+):([A-Za-z0-9+/=]+)\x07/g)]
    .map(m => ({ kind: m[1], payload: JSON.parse(Buffer.from(m[2], 'base64').toString('utf8')) }));
}

function readCalls(logPath: string) {
  try {
    return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('atomcode runner did not reach expected state');
    await new Promise(r => setTimeout(r, 20));
  }
}

function startRunner(
  extra: string[] = [],
  hiddenEntry = false,
  opts?: { existingFixture?: ReturnType<typeof fixture>; extraEnv?: Record<string, string> },
) {
  const f = opts?.existingFixture ?? fixture();
  const child = spawnTsScript(
    resolve('src/atomcode-runner.ts'),
    [...(hiddenEntry ? ['__atomcode-runner'] : []), '--atomcode-bin', f.executable, '--cwd', f.root, '--data-dir', join(f.root, 'home'), ...extra],
    { env: { ...process.env, ATOMCODE_TEST_LOG: f.log, ...opts?.extraEnv } },
  ) as ChildProcessWithoutNullStreams;
  children.push(child);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(r =>
    child.once('close', (code, signal) => r({ code, signal })));
  const h = { ...f, child, closed, stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { h.stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { h.stderr += chunk.toString(); });
  return {
    h,
    send(content: string, turnId: string, dispatchAttempt?: number) {
      const payload = {
        type: 'message',
        content,
        replyTurnId: turnId,
        ...(dispatchAttempt !== undefined ? { replyDispatchAttempt: dispatchAttempt } : {}),
      };
      child.stdin.write(`::botmux-atomcode:${Buffer.from(JSON.stringify(payload)).toString('base64')}\n`);
    },
  };
}

describe('atomcode-runner', () => {
  it('reuses one ACP process across consecutive turns, supports hidden compiled entry, and closes lease on SIGTERM', async () => {
    const r = startRunner(['--model', 'codingplan/glm-5', '--effort', 'high'], true);
    await waitFor(() => /^›$/m.test(r.h.stdout));

    r.send('first turn', 'turn-1', 1);
    await waitFor(() => markers(r.h.stdout).some(m => m.kind === 'final' && m.payload.turnId === 'turn-1'));

    const firstMarkers = markers(r.h.stdout);
    expect(firstMarkers.find(m => m.kind === 'thread')?.payload).toEqual({ threadId: 'acp-fixture-session-1' });
    expect(firstMarkers.find(m => m.kind === 'final' && m.payload.turnId === 'turn-1')?.payload).toMatchObject({
      content: 'echo:first turn|mode=bypass|model=codingplan/glm-5|effort=high',
      turnId: 'turn-1',
      dispatchAttempt: 1,
    });

    r.send('second turn', 'turn-2', 2);
    await waitFor(() => markers(r.h.stdout).some(m => m.kind === 'final' && m.payload.turnId === 'turn-2'));
    expect(markers(r.h.stdout).find(m => m.kind === 'final' && m.payload.turnId === 'turn-2')?.payload).toMatchObject({
      content: 'echo:second turn|mode=bypass|model=codingplan/glm-5|effort=high',
      turnId: 'turn-2',
      dispatchAttempt: 2,
    });

    // SIGTERM while idle must send session/close to release the native lease before exiting.
    r.h.child.kill('SIGTERM');
    const exit = await r.h.closed;
    expect(exit.code).toBe(0);

    const calls = readCalls(r.h.log);
    expect(calls.filter(entry => Array.isArray(entry.args))).toHaveLength(1);
    expect(calls.filter(entry => entry.message?.method === 'initialize')).toHaveLength(1);
    expect(calls.filter(entry => entry.message?.method === 'session/prompt')).toHaveLength(2);
    expect(calls.filter(entry => entry.message?.method === 'session/resume')).toHaveLength(0);
    expect(calls.filter(entry => entry.message?.method === 'session/close')).toHaveLength(1);
  });

  it('releases the idle ACP session after --idle-timeout-ms and transparently resumes on the next turn', async () => {
    const r = startRunner(['--idle-timeout-ms', '120']);
    await waitFor(() => /^›$/m.test(r.h.stdout));

    r.send('turn-before-idle', 'turn-1');
    await waitFor(() => markers(r.h.stdout).some(m => m.kind === 'final' && m.payload.turnId === 'turn-1'));

    await waitFor(() => readCalls(r.h.log).some(entry => entry.event === 'close_done'));

    r.send('turn-after-idle', 'turn-2');
    await waitFor(() => markers(r.h.stdout).some(m => m.kind === 'final' && m.payload.turnId === 'turn-2'));

    const calls = readCalls(r.h.log);
    expect(calls.filter(entry => Array.isArray(entry.args))).toHaveLength(2);
    expect(calls.some(entry => entry.message?.method === 'session/resume' && entry.message.params.sessionId === 'acp-fixture-session-1')).toBe(true);
  });

  it('recovers cleanly via session/resume after crash, invalid JSON, and Ctrl+C cancellation', async () => {
    const r = startRunner();
    await waitFor(() => /^›$/m.test(r.h.stdout));

    r.send('seed', 'turn-seed');
    await waitFor(() => markers(r.h.stdout).some(m => m.kind === 'final' && m.payload.turnId === 'turn-seed'));

    r.send('crash', 'turn-crash');
    await waitFor(() => markers(r.h.stdout).some(m => m.kind === 'final' && m.payload.turnId === 'turn-crash'));
    expect(markers(r.h.stdout).find(m => m.kind === 'final' && m.payload.turnId === 'turn-crash')?.payload).toMatchObject({
      errorCode: 'execution_failed',
      turnId: 'turn-crash',
    });

    r.send('invalid-json', 'turn-bad-json');
    await waitFor(() => markers(r.h.stdout).some(m => m.kind === 'final' && m.payload.turnId === 'turn-bad-json'));
    expect(markers(r.h.stdout).find(m => m.kind === 'final' && m.payload.turnId === 'turn-bad-json')?.payload).toMatchObject({
      errorCode: 'execution_failed',
      turnId: 'turn-bad-json',
    });

    r.send('hang', 'turn-cancel');
    await waitFor(() => r.h.stdout.includes('[AtomCode] running…') && readCalls(r.h.log).some(e => e.message?.method === 'session/prompt' && e.message.params.prompt[0].text === 'hang'));
    r.h.child.stdin.write('\x03');
    await waitFor(() => markers(r.h.stdout).some(m => m.kind === 'final' && m.payload.turnId === 'turn-cancel'));
    expect(markers(r.h.stdout).find(m => m.kind === 'final' && m.payload.turnId === 'turn-cancel')?.payload).toMatchObject({
      errorCode: 'cancelled',
      turnId: 'turn-cancel',
    });

    r.send('recovered', 'turn-recovered');
    await waitFor(() => markers(r.h.stdout).some(m => m.kind === 'final' && m.payload.turnId === 'turn-recovered'));
    expect(markers(r.h.stdout).find(m => m.kind === 'final' && m.payload.turnId === 'turn-recovered')?.payload).toMatchObject({
      content: 'echo:recovered|mode=bypass|model=demo-default|effort=off',
      turnId: 'turn-recovered',
    });

    const calls = readCalls(r.h.log);
    expect(calls.filter(entry => entry.message?.method === 'session/resume')).toHaveLength(3);
  });

  it('aborts with turn_budget_exhausted when --turn-timeout-ms expires', async () => {
    const r = startRunner(['--turn-timeout-ms', '150']);
    await waitFor(() => /^›$/m.test(r.h.stdout));

    r.send('hang', 'turn-budget');
    await waitFor(() => markers(r.h.stdout).some(m => m.kind === 'final' && m.payload.turnId === 'turn-budget'));

    const final = markers(r.h.stdout).find(m => m.kind === 'final' && m.payload.turnId === 'turn-budget')?.payload;
    expect(final).toMatchObject({ errorCode: 'turn_budget_exhausted', turnId: 'turn-budget' });
  });

  it('waits out a retiring runner slow session/close across PTY SIGHUP restart without failing preserved input', async () => {
    const shared = fixture();
    const leaseFile = join(shared.root, 'session.lease');
    const oldRunner = startRunner([], false, {
      existingFixture: shared,
      extraEnv: {
        ATOMCODE_ACP_LEASE_FILE: leaseFile,
        ATOMCODE_ACP_CLOSE_DELAY_MS: '2000',
      },
    });
    await waitFor(() => /^›$/m.test(oldRunner.h.stdout));

    oldRunner.send('warm-turn-1', 'turn-1');
    await waitFor(() => markers(oldRunner.h.stdout).some(m => m.kind === 'final' && m.payload.turnId === 'turn-1'));

    // Mimic worker PTY in-place restart: SIGHUP old runner, then spawn replacement
    // 500ms later with the same nativeSessionId and immediately deliver preserved input.
    oldRunner.h.child.kill('SIGHUP');
    await waitFor(() => readCalls(shared.log).some(e => e.message?.method === 'session/close'));
    await new Promise(r => setTimeout(r, 500));

    const newRunner = startRunner(['--native-session-id', 'acp-fixture-session-1'], false, {
      existingFixture: shared,
      extraEnv: { ATOMCODE_ACP_LEASE_FILE: leaseFile },
    });
    await waitFor(() => /^›$/m.test(newRunner.h.stdout));
    newRunner.send('preserved-after-sighup', 'turn-2');

    await waitFor(() => markers(newRunner.h.stdout).some(m => m.kind === 'final' && m.payload.turnId === 'turn-2'));
    const oldExit = await oldRunner.h.closed;
    expect(oldExit.code).toBe(0);

    const turn2Final = markers(newRunner.h.stdout).find(m => m.kind === 'final' && m.payload.turnId === 'turn-2')?.payload;
    expect(turn2Final).toMatchObject({
      content: 'echo:preserved-after-sighup|mode=bypass|model=demo-default|effort=off',
      turnId: 'turn-2',
    });
    expect(turn2Final?.errorCode).toBeUndefined();

    const calls = readCalls(shared.log);
    const busyIdx = calls.findIndex(e => e.event === 'resume_lease_busy');
    const closeDoneIdx = calls.findIndex(e => e.event === 'close_done');
    expect(busyIdx).toBeGreaterThan(-1);
    expect(closeDoneIdx).toBeGreaterThan(busyIdx);
    // Exactly 2 ACP spawns total (old + replacement); retries happened on the live replacement ACP process.
    expect(calls.filter(e => Array.isArray(e.args))).toHaveLength(2);
  });

  it('handles broken stdout (EPIPE) + SIGHUP mid-stream cleanly and still closes the ACP session lease', async () => {
    const shared = fixture();
    const leaseFile = join(shared.root, 'session.lease');
    const r = startRunner([], false, {
      existingFixture: shared,
      extraEnv: {
        ATOMCODE_ACP_LEASE_FILE: leaseFile,
        ATOMCODE_ACP_CANCEL_DELAY_MS: '150',
      },
    });
    await waitFor(() => /^›$/m.test(r.h.stdout));

    r.send('stream-then-slow-cancel', 'turn-epipe');
    await waitFor(() => r.h.stdout.includes('chunk1'));

    // Tear down stdout reader (simulating PTY/pipe close) and send SIGHUP mid-stream:
    // runner must not crash with uncaught EPIPE before releasing the session lease.
    r.h.child.stdout.destroy();
    r.h.child.kill('SIGHUP');
    const exit = await r.h.closed;
    expect(exit.code).toBe(0);
    expect(r.h.stderr).not.toContain('EPIPE');
    expect(existsSync(leaseFile)).toBe(false);
  });
});
