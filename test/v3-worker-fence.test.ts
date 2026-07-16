import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readProcessStartIdentity } from '../src/core/session-marker.js';
import {
  activateV3AttemptWorkerFence,
  armV3AttemptWorkerFence,
  bindV3AttemptWorkerFence,
  closeV3ArmedFenceWithoutSpawn,
  discoverV3AttemptWorker,
  probeV3AttemptWorkerFence,
  readV3AttemptWorkerFence,
  removeV3AttemptWorkerFence,
  recoverV3ArmedFenceWorker,
  signalV3AttemptWorker,
  V3_ATTEMPT_WORKER_FENCE_SCHEMA_VERSION,
  V3AttemptWorkerFenceIntegrityError,
  v3AttemptWorkerFencePath,
  type V3ActiveAttemptWorkerFence,
  type V3ArmedAttemptWorkerFence,
} from '../src/workflows/v3/worker-fence.js';

const binding = { runId: 'run-1', attemptId: 'node-a/attempts/001' } as const;

describe('v3 attempt worker fence', () => {
  let root: string;
  let attemptDir: string;
  const children = new Set<ChildProcess>();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-v3-worker-fence-'));
    attemptDir = join(root, 'attempt');
    mkdirSync(attemptDir);
  });

  afterEach(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    children.clear();
    rmSync(root, { recursive: true, force: true });
  });

  function ownerStart(): string {
    const value = readProcessStartIdentity(process.pid);
    if (!value) throw new Error('test process identity unavailable');
    return value;
  }

  function rawArmed(overrides: Partial<V3ArmedAttemptWorkerFence> = {}): V3ArmedAttemptWorkerFence {
    return {
      schemaVersion: V3_ATTEMPT_WORKER_FENCE_SCHEMA_VERSION,
      ...binding,
      ownerPid: process.pid,
      ownerProcStart: ownerStart(),
      phase: 'armed',
      ...overrides,
    };
  }

  function writeRaw(value: unknown): void {
    writeFileSync(v3AttemptWorkerFencePath(attemptDir), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }

  async function spawnReadyChild(): Promise<ChildProcess> {
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGINT',()=>process.exit(0));process.stdout.write('ready\\n');setInterval(()=>{},1000)"],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    children.add(child);
    if (!child.stdout) throw new Error('child stdout unavailable');
    await once(child.stdout, 'data');
    return child;
  }

  async function spawnDiscoverableWorker(
    boundAttemptDir = attemptDir,
    workerEntry: 'worker.js' | 'worker.ts' = 'worker.js',
  ): Promise<ChildProcess> {
    const workerPath = join(root, workerEntry);
    if (!existsSync(workerPath)) {
      writeFileSync(
        workerPath,
        "process.on('SIGINT',()=>process.exit(0));process.stdout.write('ready\\n');setInterval(()=>{},1000);\n",
      );
    }
    const child = spawn(process.execPath, [workerPath], {
      env: { ...process.env, BOTMUX_GOAL_ATTEMPT_DIR: boundAttemptDir },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    children.add(child);
    if (!child.stdout) throw new Error('child stdout unavailable');
    await once(child.stdout, 'data');
    return child;
  }

  it('durably arms before spawn and never mistakes armed for a dead worker', () => {
    const armed = armV3AttemptWorkerFence({ attemptDir, ...binding });

    expect(armed.phase).toBe('armed');
    expect(readV3AttemptWorkerFence(attemptDir, binding)).toEqual(armed);
    expect(probeV3AttemptWorkerFence(attemptDir, binding)).toEqual({
      status: 'unknown',
      fence: armed,
      reason: 'armed_without_worker_identity',
    });
    expect(lstatSync(v3AttemptWorkerFencePath(attemptDir)).mode & 0o777).toBe(0o600);
    expect(armV3AttemptWorkerFence({ attemptDir, ...binding })).toEqual(armed);
  });

  it('keeps an armed fence unknown even when its owner identity is stale', () => {
    const armed = rawArmed({ ownerProcStart: 'dead-or-reused-owner' });
    writeRaw(armed);
    expect(probeV3AttemptWorkerFence(attemptDir, binding)).toEqual({
      status: 'unknown',
      fence: armed,
      reason: 'armed_without_worker_identity',
    });
  });

  it('keeps a missing fence distinct instead of using it as proof of worker death', () => {
    expect(probeV3AttemptWorkerFence(attemptDir, binding)).toEqual({ status: 'missing' });
  });

  it.each(['pre_aborted', 'secret_missing', 'setup_failed', 'spawn_threw'] as const)(
    'durably closes an armed fence when no worker was spawned (%s)',
    (reason) => {
      const armed = armV3AttemptWorkerFence({ attemptDir, ...binding });
      const closed = closeV3ArmedFenceWithoutSpawn(attemptDir, armed, reason);
      expect(closed).toEqual({ ...armed, phase: 'closed_no_spawn', reason });
      expect(probeV3AttemptWorkerFence(attemptDir, binding)).toEqual({
        status: 'dead',
        fence: closed,
        reason: 'no_worker_spawned',
      });
      expect(closeV3ArmedFenceWithoutSpawn(attemptDir, armed, reason)).toEqual(closed);
      expect(() => closeV3ArmedFenceWithoutSpawn(
        attemptDir,
        armed,
        reason === 'pre_aborted' ? 'spawn_threw' : 'pre_aborted',
      )).toThrow(/another reason/);
      expect(removeV3AttemptWorkerFence(attemptDir, closed)).toBe('removed');
    },
  );

  it.each(['worker.js', 'worker.ts'] as const)(
    'discovers only an exact attempt-bound %s process on Linux',
    async (workerEntry) => {
      if (process.platform !== 'linux') return;
      const matching = await spawnDiscoverableWorker(attemptDir, workerEntry);
      if (!matching.pid) throw new Error('matching pid unavailable');
      await spawnDiscoverableWorker(join(root, 'another-attempt'), workerEntry);

      const discovery = discoverV3AttemptWorker(attemptDir);
      expect(discovery.status).toBe('one');
      if (discovery.status === 'one') {
        expect(discovery.worker.pid).toBe(matching.pid);
        expect(discovery.worker.procStart).toBe(readProcessStartIdentity(matching.pid));
      }
    },
  );

  it.runIf(process.platform === 'linux')('fails closed when exact discovery is ambiguous', async () => {
    await spawnDiscoverableWorker();
    await spawnDiscoverableWorker();
    const discovery = discoverV3AttemptWorker(attemptDir);
    expect(discovery.status).toBe('ambiguous');
    if (discovery.status === 'ambiguous') expect(discovery.workers).toHaveLength(2);
  });

  it.runIf(process.platform === 'linux')('recovers armed to active only after its recorded owner is dead', async () => {
    const oldOwner = await spawnReadyChild();
    if (!oldOwner.pid) throw new Error('old owner pid unavailable');
    const oldOwnerStart = readProcessStartIdentity(oldOwner.pid);
    if (!oldOwnerStart) throw new Error('old owner identity unavailable');
    oldOwner.kill('SIGKILL');
    await once(oldOwner, 'exit');
    children.delete(oldOwner);

    const armed = rawArmed({ ownerPid: oldOwner.pid, ownerProcStart: oldOwnerStart });
    writeRaw(armed);
    const worker = await spawnDiscoverableWorker();
    if (!worker.pid) throw new Error('worker pid unavailable');

    const recovered = recoverV3ArmedFenceWorker({ attemptDir, armed });
    expect(recovered.status).toBe('recovered');
    if (recovered.status === 'recovered') {
      expect(recovered.fence).toMatchObject({
        phase: 'active',
        workerPid: worker.pid,
        ownerPid: armed.ownerPid,
        ownerProcStart: armed.ownerProcStart,
      });
      expect(probeV3AttemptWorkerFence(attemptDir, binding).status).toBe('alive');
    }
  });

  it.runIf(process.platform === 'linux')('refuses armed recovery while the recorded owner is alive', async () => {
    const armed = armV3AttemptWorkerFence({ attemptDir, ...binding });
    await spawnDiscoverableWorker();
    expect(recoverV3ArmedFenceWorker({ attemptDir, armed })).toEqual({ status: 'owner_alive' });
    expect(readV3AttemptWorkerFence(attemptDir, binding)).toEqual(armed);
  });

  it('atomically transitions the exact owner-bound armed fence to active', async () => {
    const armed = armV3AttemptWorkerFence({ attemptDir, ...binding });
    const child = await spawnReadyChild();
    if (!child.pid) throw new Error('child pid unavailable');
    const active = activateV3AttemptWorkerFence({ attemptDir, armed, workerPid: child.pid });

    expect(active).toMatchObject({ ...binding, phase: 'active', workerPid: child.pid });
    expect(probeV3AttemptWorkerFence(attemptDir, binding)).toEqual({ status: 'alive', fence: active });
    expect(activateV3AttemptWorkerFence({ attemptDir, armed, workerPid: child.pid })).toEqual(active);
    expect(() => activateV3AttemptWorkerFence({ attemptDir, armed, workerPid: process.pid }))
      .toThrow(/another worker/);
  });

  it('retains active on exit and writes a durable closed tombstone only on close', () => {
    class FakeWorker extends EventEmitter {
      readonly pid = process.pid;
    }
    const worker = new FakeWorker();
    const armed = armV3AttemptWorkerFence({ attemptDir, ...binding });
    const active = bindV3AttemptWorkerFence({ worker, attemptDir, armed });

    worker.emit('exit', 0);
    expect(readV3AttemptWorkerFence(attemptDir, binding)).toEqual(active);
    worker.emit('close', 0);
    const closed = { ...active, phase: 'closed' as const };
    expect(readV3AttemptWorkerFence(attemptDir, binding)).toEqual(closed);
    expect(probeV3AttemptWorkerFence(attemptDir, binding)).toEqual({
      status: 'dead',
      fence: closed,
      reason: 'outer_process_closed',
    });
    expect(signalV3AttemptWorker(attemptDir, active, 'SIGKILL')).toEqual({
      status: 'dead',
      fence: closed,
      reason: 'outer_process_closed',
    });
    expect(() => worker.emit('close', 0)).not.toThrow();
    expect(removeV3AttemptWorkerFence(attemptDir, closed)).toBe('removed');
  });

  it('fails closed on malformed, unknown-field, wrong-binding, symlink, and non-regular sidecars', () => {
    const path = v3AttemptWorkerFencePath(attemptDir);
    writeFileSync(path, '{broken');
    expect(() => readV3AttemptWorkerFence(attemptDir, binding)).toThrow(V3AttemptWorkerFenceIntegrityError);

    writeRaw({ ...rawArmed(), injected: true });
    expect(() => readV3AttemptWorkerFence(attemptDir, binding)).toThrow(/unknown or missing/);

    writeRaw(rawArmed({ runId: 'other-run' }));
    expect(() => readV3AttemptWorkerFence(attemptDir, binding)).toThrow(/binding mismatch/);

    rmSync(path, { force: true });
    const outside = join(root, 'outside.json');
    writeFileSync(outside, JSON.stringify(rawArmed()));
    symlinkSync(outside, path);
    expect(() => readV3AttemptWorkerFence(attemptDir, binding)).toThrow(/regular file|symlink/);

    rmSync(path, { force: true });
    mkdirSync(path);
    expect(() => readV3AttemptWorkerFence(attemptDir, binding)).toThrow(/regular file/);
  });

  it('refuses to arm over a conflicting owner identity', () => {
    const conflict = rawArmed({ ownerProcStart: 'stale-owner' });
    writeRaw(conflict);
    expect(() => armV3AttemptWorkerFence({ attemptDir, ...binding })).toThrow(/already exists/);
    expect(readV3AttemptWorkerFence(attemptDir, binding)).toEqual(conflict);
  });

  it('treats a live reused worker PID with a different start identity as dead', () => {
    const active: V3ActiveAttemptWorkerFence = {
      ...rawArmed(),
      phase: 'active',
      workerPid: process.pid,
      workerProcStart: 'definitely-not-this-process-start',
    };
    writeRaw(active);
    expect(probeV3AttemptWorkerFence(attemptDir, binding)).toEqual({
      status: 'dead',
      fence: active,
      reason: 'process_identity_mismatch',
    });
    expect(signalV3AttemptWorker(attemptDir, active, 'SIGINT')).toEqual({
      status: 'dead',
      fence: active,
      reason: 'process_identity_mismatch',
    });
  });

  it('proves an active worker dead after its process exits', async () => {
    const armed = armV3AttemptWorkerFence({ attemptDir, ...binding });
    const child = await spawnReadyChild();
    if (!child.pid) throw new Error('child pid unavailable');
    const active = activateV3AttemptWorkerFence({ attemptDir, armed, workerPid: child.pid });
    child.kill('SIGKILL');
    await once(child, 'exit');
    children.delete(child);
    expect(probeV3AttemptWorkerFence(attemptDir, binding)).toEqual({
      status: 'dead',
      fence: active,
      reason: 'process_missing',
    });
  });

  it('signals only an exact active pid+procStart identity', async () => {
    const armed = armV3AttemptWorkerFence({ attemptDir, ...binding });
    const child = await spawnReadyChild();
    if (!child.pid) throw new Error('child pid unavailable');
    const active = activateV3AttemptWorkerFence({ attemptDir, armed, workerPid: child.pid });
    expect(signalV3AttemptWorker(attemptDir, active, 'SIGINT')).toEqual({
      status: 'signalled',
      fence: active,
      signal: 'SIGINT',
    });
    await once(child, 'exit');
    children.delete(child);
    expect(probeV3AttemptWorkerFence(attemptDir, binding).status).toBe('dead');
  });

  it('removes only the exact expected phase and identity', () => {
    const armed = armV3AttemptWorkerFence({ attemptDir, ...binding });
    expect(removeV3AttemptWorkerFence(attemptDir, { ...armed, ownerProcStart: 'stale' })).toBe('mismatch');
    expect(existsSync(v3AttemptWorkerFencePath(attemptDir))).toBe(true);
    expect(removeV3AttemptWorkerFence(attemptDir, armed)).toBe('removed');
    expect(removeV3AttemptWorkerFence(attemptDir, armed)).toBe('missing');
  });
});
