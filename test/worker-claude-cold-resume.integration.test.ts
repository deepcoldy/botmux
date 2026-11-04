/**
 * Which conversation a Claude session resumes after a cold start — a daemon
 * restart on the pty backend, a tmux pane that is gone — once Claude moved to
 * another one: `/clear`, an in-pane `/resume`, a `--fork-session` launch.
 *
 * Issue #2155: the worker reported Claude's session id only around a Lark
 * message's submit. After a `/clear` followed by local turns alone (terminal
 * input, background-task wake-ups), the daemon still had the pre-clear id on
 * record, and the next `--resume` brought back the conversation the user had
 * cleared. The bridge now records the id Claude's pid-state record names once
 * that conversation's transcript holds something `--resume` can open.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backgroundTurn,
  claudeHarnessRunnable as runnable,
  cleanUpClaudeHarnesses,
  coldRestart,
  passthrough,
  promptReadyCount,
  recordedCliSessionId,
  restart,
  runBackgroundTurn,
  setupFakeClaude as setup,
  type Generation,
} from './helpers/claude-worker-harness.js';

afterEach(cleanUpClaudeHarnesses);

describe.skipIf(!runnable)('Which conversation a cold start resumes after the CLI moved to another', () => {
  it.each([
    { command: '/clear', backend: 'tmux' },
    { command: '/clear', backend: 'pty' },
    { command: '/resume', backend: 'tmux' },
    { command: '/compact', backend: 'tmux' },
  ] as const)('$command followed by local turns only: a $backend cold start resumes the conversation the CLI is in', async ({ command, backend }) => {
    const olderSid = randomUUID();
    const h = setup({ turnMs: 1_000, history: { sid: olderSid, reply: 'OLD reply from an hour ago' } });
    const current = { '/clear': h.clearSid, '/resume': olderSid, '/compact': h.sessionId }[command];
    const first = h.startWorker({ backendType: backend });
    await first.waitFor(() => promptReadyCount(first) > 0, 'the CLI to be ready');
    await backgroundTurn(h, first, 'R1 before the switch');
    await passthrough(h, first, command === '/resume' ? `/resume ${olderSid}` : command);
    await backgroundTurn(h, first, 'R2 after the switch');
    expect(readFileSync(h.transcript(current), 'utf8')).toContain('R2 after the switch');

    const restarted = await coldRestart(h, first, { backendType: backend, cliSessionId: recordedCliSessionId(first) });
    expect(h.launches().at(-1)?.sid, first.logs.join('')).toBe(current);
    await backgroundTurn(h, restarted, 'R3 after the restart');
    expect(readFileSync(h.transcript(current), 'utf8')).toContain('R3 after the restart');
    expect(restarted.finals().filter(text => /R[12] |OLD/.test(text)), restarted.logs.join('')).toEqual([]);
  }, 150_000);

  it('a record from before the upgrade, its pane gone, resumes the conversation it names, as it always did', async () => {
    const h = setup({ turnMs: 1_000 });
    const first = h.startWorker();
    await first.waitFor(() => promptReadyCount(first) > 0, 'the CLI to be ready');
    await backgroundTurn(h, first, 'R1 before the clear');
    await passthrough(h, first, '/clear');

    // The worker that ran the /clear reported nothing: no CLI session id on record.
    const restarted = await coldRestart(h, first, {});
    expect(h.launches().at(-1)?.sid).toBe(h.sessionId);
    await backgroundTurn(h, restarted, 'R2 after the restart');
    expect(readFileSync(h.transcript(h.sessionId), 'utf8')).toContain('R2 after the restart');
    expect(restarted.notices(), restarted.logs.join('')).toEqual([]);
  }, 150_000);

  it('a record from before the upgrade, its pane alive, is brought up to date by the re-attached worker', async () => {
    const h = setup({ turnMs: 1_000 });
    const first = h.startWorker();
    await first.waitFor(() => promptReadyCount(first) > 0, 'the CLI to be ready');
    await backgroundTurn(h, first, 'R1 before the clear');
    await passthrough(h, first, '/clear');
    await backgroundTurn(h, first, 'R2 after the clear');

    // Re-attached to the live pane by a daemon whose record predates the /clear.
    const reattached = await restart(h, first);
    await backgroundTurn(h, reattached, 'R3 after the upgrade');
    await coldRestart(h, reattached, { cliSessionId: recordedCliSessionId(reattached) });
    expect(h.launches().at(-1)?.sid, reattached.logs.join('')).toBe(h.clearSid);
  }, 150_000);

  it('a forked session is put on record once its transcript holds the conversation; a restart before that forks again', async () => {
    const parentSid = randomUUID();
    const h = setup({ turnMs: 1_000, history: { sid: parentSid, reply: 'PARENT reply' } });
    // The daemon keeps asking for the fork until the child reports its own id.
    const nextLaunch = (g: Generation) => {
      const recorded = recordedCliSessionId(g);
      return recorded ? { cliSessionId: recorded, forkSession: false } : { cliSessionId: parentSid, forkSession: true };
    };
    const first = h.startWorker({ resume: true, cliSessionId: parentSid, forkSession: true });
    await first.waitFor(() => promptReadyCount(first) > 0, 'the forked CLI to be ready');
    // A few bridge ticks while Claude already names the fork's id and its file
    // holds only metadata records.
    await new Promise(done => setTimeout(done, 2_500));

    const second = await coldRestart(h, first, nextLaunch(first));
    expect(h.launches().at(-1), first.logs.join('')).toEqual({ sid: h.forkSid, args: expect.arrayContaining(['--fork-session']) });
    await runBackgroundTurn(h, second, 'R1 in the fork');
    await new Promise(done => setTimeout(done, 1_500));

    const third = await coldRestart(h, second, nextLaunch(second));
    expect(h.launches().at(-1), second.logs.join('')).toEqual({ sid: h.forkSid, args: expect.not.arrayContaining(['--fork-session']) });
    expect(third.notices()).toEqual([]);
  }, 150_000);
});
