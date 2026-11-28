import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('atomcode runner did not reach expected state');
    await new Promise(r => setTimeout(r, 20));
  }
}

function startRunner(extra: string[] = [], hiddenEntry = false) {
  const f = fixture();
  const child = spawnTsScript(
    resolve('src/atomcode-runner.ts'),
    [...(hiddenEntry ? ['__atomcode-runner'] : []), '--atomcode-bin', f.executable, '--cwd', f.root, '--data-dir', join(f.root, 'home'), ...extra],
    { env: { ...process.env, ATOMCODE_TEST_LOG: f.log } },
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
  it('handles framed turns, persists threadId across resumes, and supports hidden compiled entry', async () => {
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

    const calls = readFileSync(r.h.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.some(entry => entry.message?.method === 'session/resume' && entry.message.params.sessionId === 'acp-fixture-session-1')).toBe(true);
  });

  it('cancels an active turn on Ctrl+C and reports cancelled errorCode', async () => {
    const r = startRunner();
    await waitFor(() => /^›$/m.test(r.h.stdout));

    r.send('hang', 'turn-cancel');
    await waitFor(() => r.h.stdout.includes('[AtomCode] running…'));
    r.h.child.stdin.write('\x03');
    await waitFor(() => markers(r.h.stdout).some(m => m.kind === 'final' && m.payload.turnId === 'turn-cancel'));

    const final = markers(r.h.stdout).find(m => m.kind === 'final' && m.payload.turnId === 'turn-cancel')?.payload;
    expect(final).toMatchObject({ errorCode: 'cancelled', turnId: 'turn-cancel' });
  });

  it('aborts with turn_budget_exhausted when --turn-timeout-ms expires', async () => {
    const r = startRunner(['--turn-timeout-ms', '150']);
    await waitFor(() => /^›$/m.test(r.h.stdout));

    r.send('hang', 'turn-budget');
    await waitFor(() => markers(r.h.stdout).some(m => m.kind === 'final' && m.payload.turnId === 'turn-budget'));

    const final = markers(r.h.stdout).find(m => m.kind === 'final' && m.payload.turnId === 'turn-budget')?.payload;
    expect(final).toMatchObject({ errorCode: 'turn_budget_exhausted', turnId: 'turn-budget' });
  });
});
