/**
 * A real worker reports a lost tmux server as such.
 *
 * The daemon folds every `claude_exit` carrying `backendLost` into ONE backend
 * outage (backend-outage-coordinator.ts) instead of counting N CLI crashes.
 * That only works if the worker actually says so: here a real worker runs a
 * CLI on a PRIVATE tmux server (own TMUX_TMPDIR, own socket name), the test
 * kills that server's process — the 2026-11-19 SIGSEGV shape, where nothing
 * restarted the server before the panes were found gone — and the worker's
 * exit report must name the lost server. The same worker's ordinary CLI exit
 * must not.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  killLabServer,
  labServerPid,
  prepareOutageLabWorld,
  realTmuxPath,
  startOutageLabSession,
  type OutageLabSession,
} from './helpers/backend-outage-lab.js';

const realTmux = realTmuxPath();

describe.skipIf(!realTmux)('worker: claude_exit names a lost tmux server', () => {
  const root = mkdtempSync('/tmp/bo-rep-');
  const world = { root, tmuxTmpDir: join(root, 't'), socket: 'bmxrep' };
  const sessions: OutageLabSession[] = [];

  afterAll(() => {
    for (const s of sessions) {
      try { s.worker.kill('SIGKILL'); } catch { /* gone */ }
    }
    killLabServer(world, realTmux!);
    rmSync(root, { recursive: true, force: true });
  });

  const start = (index: number) => {
    const s = startOutageLabSession(world, index);
    sessions.push(s);
    s.sendInit();
    return s;
  };
  const exitsOf = (s: OutageLabSession) => s.ipc.filter(m => m.type === 'claude_exit');

  it('reports `gone` when the server process dies, and nothing for an ordinary exit', async () => {
    prepareOutageLabWorld(world);
    const a = start(0);
    const b = start(1);
    for (const s of [a, b]) {
      await vi.waitFor(() => expect(s.ipc.some(m => m.type === 'prompt_ready'), s.logs()).toBe(true), { timeout: 60_000, interval: 100 });
    }

    // Ordinary exit first: the CLI dies on its own, the server stays.
    a.worker.send({ type: 'message', content: 'please DIE', turnId: 'om_turn_die' });
    await vi.waitFor(() => expect(exitsOf(a), a.logs()).toHaveLength(1), { timeout: 60_000, interval: 100 });
    expect(exitsOf(a)[0]).toMatchObject({ code: 3 });
    expect(exitsOf(a)[0]!.backendLost).toBeUndefined();

    // Now the server itself (this test's private one) is killed.
    const pid = labServerPid(world, realTmux!);
    expect(pid).toBeGreaterThan(0);
    process.kill(pid!, 'SIGKILL');
    await vi.waitFor(() => expect(exitsOf(b), b.logs()).toHaveLength(1), { timeout: 90_000, interval: 100 });
    expect(exitsOf(b)[0]!.backendLost).toEqual({ backend: 'tmux', kind: 'gone', socketName: 'bmxrep' });
  }, 180_000);
});
