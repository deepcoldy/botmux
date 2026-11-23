/**
 * A real worker on hc reports a lost core as such.
 *
 * The daemon folds every `claude_exit` carrying `backendLost` into ONE backend
 * outage per lost server (backend-outage-coordinator.ts). For hc that server
 * is the core: here two real workers run a CLI on this file's PRIVATE core
 * (the hc test fence's runtime dir), one CLI exits on its own, then the core
 * is stopped. The ordinary exit must name no server; the stopped core must be
 * named by its socket, as an hc loss.
 *
 * Run:  BOTMUX_HC_TEST_BIN=<herdr-core> npx vitest run --project unit test/hc-backend-outage-worker-report.integration.test.ts
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hcControlEnv, hcCorePaths } from '../src/adapters/backend/hc/core.js';
import { prepareOutageLabWorld, startOutageLabSession, type OutageLabSession } from './helpers/backend-outage-lab.js';

const realHc = process.env.BOTMUX_HC_TEST_BIN;

describe.skipIf(!realHc)('worker: claude_exit names a lost hc core', () => {
  const root = mkdtempSync('/tmp/bo-hcrep-');
  const world = { root, tmuxTmpDir: join(root, 't'), socket: 'bmxhcrep' };
  const sessions: OutageLabSession[] = [];
  // This file's private core: the fence gave the process its own runtime dir.
  const core = hcCorePaths(process.env);
  // The fence's shim in front of the real binary (BOTMUX_HC_TEST_BIN).
  const stopCore = () => spawnSync(process.env.BOTMUX_HC_BIN!, ['server', 'stop'], {
    env: hcControlEnv(process.env, core), cwd: root, encoding: 'utf8', timeout: 20_000,
  });

  afterAll(() => {
    for (const s of sessions) {
      try { s.worker.kill('SIGKILL'); } catch { /* gone */ }
    }
    stopCore();
    rmSync(root, { recursive: true, force: true });
  });

  const start = (index: number) => {
    const s = startOutageLabSession(world, index, { backendType: 'hc' });
    sessions.push(s);
    s.sendInit();
    return s;
  };
  const exitsOf = (s: OutageLabSession) => s.ipc.filter(m => m.type === 'claude_exit');

  it('reports nothing for an ordinary exit, and the core socket when the core stops', async () => {
    prepareOutageLabWorld(world);
    const a = start(0);
    const b = start(1);
    for (const s of [a, b]) {
      await vi.waitFor(() => expect(s.ipc.some(m => m.type === 'prompt_ready'), s.logs()).toBe(true), { timeout: 60_000, interval: 100 });
    }

    a.worker.send({ type: 'message', content: 'please DIE', turnId: 'om_turn_die' });
    await vi.waitFor(() => expect(exitsOf(a), a.logs()).toHaveLength(1), { timeout: 60_000, interval: 100 });
    expect(exitsOf(a)[0]).toMatchObject({ code: 3 });
    expect(exitsOf(a)[0]!.backendLost).toBeUndefined();

    const stopped = stopCore();
    expect(stopped.status, stopped.stderr).toBe(0);
    await vi.waitFor(() => expect(exitsOf(b), b.logs()).toHaveLength(1), { timeout: 90_000, interval: 100 });
    expect(exitsOf(b)[0]!.backendLost).toEqual({ backend: 'hc', kind: 'gone', socketName: core.socket });
  }, 180_000);
});
