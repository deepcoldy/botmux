import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

import {
  createWorkflowDaemonSpawn,
  type WorkerHandle,
  type WorkerProcessFactory,
} from '../src/workflows/daemon-spawn.js';
import {
  WorkflowSpawnCancelledError,
  type DaemonRunOneShotInput,
} from '../src/workflows/spawn-bot.js';
import type { AbortCancelReason } from '../src/workflows/runtime.js';

/**
 * Fake WorkerHandle helper.  `exitOn` lists the signals that cause the
 * simulated process to exit (CLI cooperation behavior).  SIGINT-only
 * workers model a cooperative CLI; SIGKILL-only workers model a stuck
 * CLI; etc.
 */
function makeFakeWorker(opts: { exitOn?: NodeJS.Signals[] } = {}): {
  worker: WorkerHandle;
  emitter: EventEmitter;
  kills: NodeJS.Signals[];
  sent: unknown[];
} {
  const emitter = new EventEmitter();
  const kills: NodeJS.Signals[] = [];
  const sent: unknown[] = [];
  let killed = false;
  const exitOn = new Set<NodeJS.Signals>(opts.exitOn ?? ['SIGINT', 'SIGKILL', 'SIGTERM']);
  const worker: WorkerHandle = {
    send: (msg) => { sent.push(msg); },
    on: ((event: any, cb: any) => emitter.on(event, cb)) as WorkerHandle['on'],
    kill: (sig) => {
      const s = (sig ?? 'SIGTERM') as NodeJS.Signals;
      kills.push(s);
      if (exitOn.has(s) && !killed) {
        killed = true;
        setImmediate(() => emitter.emit('exit', null));
      }
    },
    pid: 12345,
    stdout: null,
    stderr: null,
  };
  return { worker, emitter, kills, sent };
}

function makeFactory(handle: WorkerHandle): WorkerProcessFactory {
  return { spawn: () => handle };
}

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wf-spawn-cancel-'));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const baseInput = (): DaemonRunOneShotInput => ({
  botName: 'cli_x',
  prompt: 'do',
  runId: 'spawn-cancel-test',
  nodeId: 'n',
  activityId: 'spawn-cancel-test::work::n',
  attemptId: 'spawn-cancel-test::work::n::1',
  attemptLogPath: join(tempDir, 'attempt.log'),
});

describe('daemon-spawn cancel responsiveness', () => {
  it('case 7: cancel sends close + SIGINT and waits for worker exit before settling', async () => {
    // Cooperative worker: exits on SIGINT (no need for SIGKILL).
    const fake = makeFakeWorker({ exitOn: ['SIGINT'] });
    const deps = createWorkflowDaemonSpawn({
      resolveLarkCredentials: () => ({ larkAppId: 'cli_x', larkAppSecret: 'sec' }),
      factory: makeFactory(fake.worker),
      cancelGraceMs: 5000,
      defaultTimeoutMs: 60_000,
      quiesceMs: 100,
    });
    const ac = new AbortController();
    const reason: AbortCancelReason = { cancelOriginEventId: 'evt-1' };
    setTimeout(() => fake.emitter.emit('message', { type: 'ready', port: 0 }), 5);
    setTimeout(() => ac.abort(reason), 20);

    const result = await deps.runOneShot({ ...baseInput(), cancelSignal: ac.signal })
      .catch((err) => err);
    expect(result).toBeInstanceOf(WorkflowSpawnCancelledError);
    expect((result as WorkflowSpawnCancelledError).cancelOriginEventId).toBe('evt-1');
    // close was sent before SIGINT — CLI gets a chance to flush.
    expect(fake.sent.some((m: any) => m?.type === 'close')).toBe(true);
    expect(fake.kills[0]).toBe('SIGINT');
    // SIGTERM should NOT race with the 5s grace — cancel cleanup skips it.
    expect(fake.kills).not.toContain('SIGTERM');
  });

  it('case 8: SIGKILL escalation only after full grace; no SIGTERM races during grace', async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeWorker({ exitOn: ['SIGKILL'] });
      const deps = createWorkflowDaemonSpawn({
        resolveLarkCredentials: () => ({ larkAppId: 'cli_x', larkAppSecret: 'sec' }),
        factory: makeFactory(fake.worker),
        cancelGraceMs: 5000,
        defaultTimeoutMs: 60_000,
        quiesceMs: 100,
      });
      const ac = new AbortController();
      const reason: AbortCancelReason = { cancelOriginEventId: 'evt-grace' };
      const promise = deps.runOneShot({ ...baseInput(), cancelSignal: ac.signal });
      const settled = promise.catch((err) => err);
      await vi.advanceTimersByTimeAsync(0);
      ac.abort(reason);
      await vi.advanceTimersByTimeAsync(0);
      // SIGINT first; the 250ms SIGTERM cleanup MUST be skipped on cancel
      // path so it doesn't race the 5s grace.
      expect(fake.kills[0]).toBe('SIGINT');
      expect(fake.kills).not.toContain('SIGTERM');
      expect(fake.kills).not.toContain('SIGKILL');
      await vi.advanceTimersByTimeAsync(4000);
      expect(fake.kills).not.toContain('SIGTERM');
      expect(fake.kills).not.toContain('SIGKILL');
      await vi.advanceTimersByTimeAsync(2000);
      expect(fake.kills).toContain('SIGKILL');
      expect(fake.kills).not.toContain('SIGTERM');
      expect(await settled).toBeInstanceOf(WorkflowSpawnCancelledError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('case 10: cancel wins over a pending quiesce (final_output landed, abort fires before quiesce expires)', async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeWorker({ exitOn: ['SIGINT'] });
      const deps = createWorkflowDaemonSpawn({
        resolveLarkCredentials: () => ({ larkAppId: 'cli_x', larkAppSecret: 'sec' }),
        factory: makeFactory(fake.worker),
        cancelGraceMs: 5000,
        defaultTimeoutMs: 60_000,
        quiesceMs: 800,
      });
      const ac = new AbortController();
      const reason: AbortCancelReason = { cancelOriginEventId: 'evt-quiesce-race' };
      const promise = deps.runOneShot({ ...baseInput(), cancelSignal: ac.signal });
      const settled = promise.catch((err) => err);
      // Worker reports final_output → quiesce timer armed at t+800.
      await vi.advanceTimersByTimeAsync(0);
      fake.emitter.emit('message', {
        type: 'final_output',
        turnId: 't1',
        content: '<<WF-OUT>>{"ok":true}<<WF-END>>',
      });
      // Inside the quiesce window — abort fires.
      await vi.advanceTimersByTimeAsync(400);
      ac.abort(reason);
      // Advance past where quiesce WOULD fire if we hadn't disarmed it.
      await vi.advanceTimersByTimeAsync(1000);
      // Worker is cooperative — exits on SIGINT.  Promise must settle as
      // CANCELLED, not as success from the late quiesce.
      expect(fake.kills).toContain('SIGINT');
      expect(fake.kills).not.toContain('SIGTERM');
      const result = await settled;
      expect(result).toBeInstanceOf(WorkflowSpawnCancelledError);
      expect((result as WorkflowSpawnCancelledError).cancelOriginEventId).toBe('evt-quiesce-race');
    } finally {
      vi.useRealTimers();
    }
  });

  it('case 11: cancel wins over a post-abort hardDeadline / worker error', async () => {
    vi.useFakeTimers();
    try {
      // Worker stays alive until SIGKILL — gives us a long enough window
      // for the (disarmed) hardDeadline to be irrelevant; the exit
      // handler must settle as cancelled, not as timeout failure.
      const fake = makeFakeWorker({ exitOn: ['SIGKILL'] });
      const deps = createWorkflowDaemonSpawn({
        resolveLarkCredentials: () => ({ larkAppId: 'cli_x', larkAppSecret: 'sec' }),
        factory: makeFactory(fake.worker),
        cancelGraceMs: 5000,
        defaultTimeoutMs: 10_000,
        quiesceMs: 100,
      });
      const ac = new AbortController();
      const reason: AbortCancelReason = { cancelOriginEventId: 'evt-timeout-race' };
      const promise = deps.runOneShot({ ...baseInput(), cancelSignal: ac.signal });
      const settled = promise.catch((err) => err);
      await vi.advanceTimersByTimeAsync(0);
      ac.abort(reason);
      // Even if we advance well past the original hardDeadline window,
      // it must have been disarmed by onCancelAbort.  Worker stays alive
      // until SIGKILL at t≥5000.
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await settled;
      expect(result).toBeInstanceOf(WorkflowSpawnCancelledError);
      expect((result as WorkflowSpawnCancelledError).cancelOriginEventId).toBe('evt-timeout-race');
      expect(fake.kills).toContain('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('case 9: worker exits voluntarily after SIGINT — promise settles AFTER exit, no SIGKILL', async () => {
    vi.useFakeTimers();
    try {
      const emitter = new EventEmitter();
      const kills: NodeJS.Signals[] = [];
      const sent: unknown[] = [];
      const worker: WorkerHandle = {
        send: (msg) => { sent.push(msg); },
        on: ((event: any, cb: any) => emitter.on(event, cb)) as WorkerHandle['on'],
        kill: (sig) => {
          const s = (sig ?? 'SIGTERM') as NodeJS.Signals;
          kills.push(s);
          if (s === 'SIGINT') {
            // Worker complies and exits cleanly after a short delay.
            setTimeout(() => emitter.emit('exit', 0), 100);
          }
        },
        pid: 12345,
        stdout: null,
        stderr: null,
      };
      const deps = createWorkflowDaemonSpawn({
        resolveLarkCredentials: () => ({ larkAppId: 'cli_x', larkAppSecret: 'sec' }),
        factory: { spawn: () => worker },
        cancelGraceMs: 5000,
        defaultTimeoutMs: 60_000,
        quiesceMs: 100,
      });
      const ac = new AbortController();
      const reason: AbortCancelReason = { cancelOriginEventId: 'evt-voluntary' };
      const promise = deps.runOneShot({ ...baseInput(), cancelSignal: ac.signal });
      let resolvedYet = false;
      const settled = promise.catch((err) => { resolvedYet = true; return err; });
      await vi.advanceTimersByTimeAsync(0);
      ac.abort(reason);
      // Right after abort: SIGINT sent, promise NOT settled (waits for exit).
      await vi.advanceTimersByTimeAsync(0);
      expect(kills[0]).toBe('SIGINT');
      expect(resolvedYet).toBe(false);
      // Advance through worker's voluntary exit (100ms) plus a buffer.
      await vi.advanceTimersByTimeAsync(200);
      expect(kills).not.toContain('SIGKILL');
      expect(kills).not.toContain('SIGTERM');
      // After exit, promise should now have rejected with cancelled.
      expect(resolvedYet).toBe(true);
      // Advance well past grace to confirm SIGKILL never fired.
      await vi.advanceTimersByTimeAsync(6000);
      expect(kills).not.toContain('SIGKILL');
      expect(await settled).toBeInstanceOf(WorkflowSpawnCancelledError);
    } finally {
      vi.useRealTimers();
    }
  });
});
