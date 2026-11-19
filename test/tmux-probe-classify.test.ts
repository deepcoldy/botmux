/**
 * The tmux liveness probe is judged by two pure classifiers, fed by a
 * synchronous path (writes: execFileSync) and an asynchronous one (the
 * lifecycle watcher: execFile). These cases pin that both paths reach the same
 * verdict for the same tmux outcome — using REAL child processes to produce
 * the errors, since execFile and execFileSync report failures differently —
 * and that the answers measured on real tmux classify as the backend relies on.
 */
import { describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import {
  classifyPaneProbeAnswer,
  classifyPaneProbeFailure,
  execFileErrorAsSyncShape,
  resolvePaneDeath,
  resolvePaneDeathAsync,
} from '../src/adapters/backend/tmux-pipe-backend.js';

describe('classifyPaneProbeAnswer (answers measured on tmux 2.8 / 3.3a / 3.6a)', () => {
  it('a live pane exists, and its answer carries the server pid', () => {
    expect(classifyPaneProbeAnswer('%0:0::487614:487598\n')).toEqual({ state: 'exists', serverPid: 487598 });
  });

  it('a corpse kept by remain-on-exit is missing, with its death fields for the status capture', () => {
    expect(classifyPaneProbeAnswer('%1:1:77:487626:487598\n')).toEqual({
      state: 'missing', reason: expect.stringContaining('remain-on-exit'), deathLine: '1:77:487626:487598',
    });
    // signal death: no status published
    expect(classifyPaneProbeAnswer('%2:1::487631:487598\n')).toMatchObject({ state: 'missing', deathLine: '1::487631:487598' });
  });

  it('an unknown target on tmux 3.x (exit 0, every pane field empty) is missing', () => {
    expect(classifyPaneProbeAnswer('::::487598\n')).toMatchObject({ state: 'missing', reason: 'empty pane id' });
    expect(classifyPaneProbeAnswer('')).toMatchObject({ state: 'missing' });
  });

  it('trailing fields (the pre-write read appends #{pane_in_mode}) do not change the verdict', () => {
    expect(classifyPaneProbeAnswer('%0:0::10:20:1\n')).toEqual({ state: 'exists', serverPid: 20 });
    expect(classifyPaneProbeAnswer('%0:1:3:10:20:0\n')).toMatchObject({ state: 'missing', deathLine: '1:3:10:20' });
  });

  it('never invents a death from an unreadable dead flag', () => {
    expect(classifyPaneProbeAnswer('%0:')).toMatchObject({ state: 'exists' });
    expect(classifyPaneProbeAnswer('%0:x:1:2:3')).toMatchObject({ state: 'exists' });
  });
});

/** Run `sh -c script` through execFileSync and through execFile, and classify
 *  both outcomes the way the backend does. */
async function classifyBothWays(script: string, timeoutMs = 5_000, file = '/bin/sh') {
  let sync: ReturnType<typeof classifyPaneProbeFailure> | 'ok';
  try {
    execFileSync(file, ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    sync = 'ok';
  } catch (err) {
    sync = classifyPaneProbeFailure(err, 'tmux display-message');
  }
  const async = await new Promise<ReturnType<typeof classifyPaneProbeFailure> | 'ok'>((resolve) => {
    execFile(file, ['-c', script], { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, _out, stderr) => {
      resolve(error ? classifyPaneProbeFailure(execFileErrorAsSyncShape(error, stderr), 'tmux display-message') : 'ok');
    });
  });
  return { sync, async };
}

describe('the async probe path classifies failures exactly like the sync path', () => {
  it.each([
    ['connection refused (stalled server, 2026-08-20)', "echo 'error connecting to /tmp/tmux-0/botmux (Connection refused)' >&2; exit 1", { state: 'unknown', serverLevel: true }],
    ['lost server', "echo 'lost server' >&2; exit 1", { state: 'unknown', serverLevel: true }],
    ['server exited unexpectedly', "echo 'server exited unexpectedly' >&2; exit 1", { state: 'unknown', serverLevel: true }],
    ['no server running (the server answered)', "echo 'no server running on /tmp/tmux-0/botmux' >&2; exit 1", { state: 'missing' }],
    ["can't find pane (tmux 2.8)", "echo \"can't find pane bmx-x\" >&2; exit 1", { state: 'missing' }],
    ['killed by a signal', 'kill -9 $$', { state: 'unknown' }],
  ])('%s', async (_label, script, expected) => {
    const { sync, async } = await classifyBothWays(script);
    expect(sync).toMatchObject(expected);
    expect(async).toEqual(sync);
  });

  it('a deadline is unknown on both paths, never missing', async () => {
    const { sync, async } = await classifyBothWays('sleep 5', 200);
    expect(sync).toMatchObject({ state: 'unknown', reason: expect.stringContaining('ETIMEDOUT') });
    expect(async).toEqual(sync);
  });

  it('a spawn failure is unknown on both paths', async () => {
    const { sync, async } = await classifyBothWays('true', 5_000, '/nonexistent/tmux-binary');
    expect(sync).toMatchObject({ state: 'unknown' });
    expect(async).toMatchObject({ state: 'unknown' });
  });
});

describe('resolvePaneDeathAsync reaches the same verdicts as resolvePaneDeath', () => {
  const opts = { attempts: 5, intervalMs: 1 };
  const cases: Array<[string, string[]]> = [
    ['dead with a code at once', ['1:77']],
    ['alive at once', ['0:']],
    ['status published after the gap', ['1:', '1:', '1:9']],
    ['status never published (signal death)', ['1:', '1:', '1:', '1:', '1:', '1:']],
    ['unreadable, then dead', ['', '', '1:3']],
    ['unreadable throughout', ['', '', '', '', '', '']],
    ['a 0: after death does not revive it', ['1:', '0:', '', '', '', '']],
  ];
  it.each(cases)('%s', async (_label, lines) => {
    let i = 0;
    const sync = resolvePaneDeath(lines[0], () => lines[++i] ?? '', () => {}, opts);
    let j = 0;
    const asyncVerdict = await resolvePaneDeathAsync(lines[0], async () => lines[++j] ?? '', async () => {}, opts);
    expect(asyncVerdict).toEqual(sync);
    expect(j).toBe(i); // same number of re-reads
  });
});
