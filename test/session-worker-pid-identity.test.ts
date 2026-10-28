/**
 * A restart's stale-worker sweep must only ever signal the exact worker a
 * session row recorded. Dormant rows kept their worker pid for weeks; once the
 * kernel reused those numbers the sweep SIGTERMed unrelated processes (two
 * running sessions died on one restart). These tests pin the gates:
 *   - recorded birth identity must equal the live one (pid reuse is skipped),
 *   - rows without a recorded identity are never signalled,
 *   - the live process must also be provably a botmux worker,
 * while the genuine stale worker is still terminated.
 *
 * Every process signalled here is a detached idle child this file spawned.
 */
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';

// Nothing in this file may reach a real multiplexer.
vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: { sessionName: (id: string) => `bmx-${id.slice(0, 8)}`, killSession: vi.fn(), listBotmuxSessions: vi.fn(() => []) },
}));
vi.mock('../src/adapters/backend/herdr-backend.js', () => ({
  HerdrBackend: { sessionName: (id: string) => `bmx-${id.slice(0, 8)}`, killSession: vi.fn(), killAgent: vi.fn(), killAgents: vi.fn(), listBotmuxSessions: vi.fn(() => []) },
}));
vi.mock('../src/adapters/backend/zellij-backend.js', () => ({
  ZellijBackend: { sessionName: (id: string) => `bmx-${id.slice(0, 8)}`, killSession: vi.fn() },
}));
vi.mock('../src/adapters/backend/zmx-backend.js', () => ({
  ZmxBackend: { sessionName: (id: string) => `bmx-${id.slice(0, 8)}`, killManagedSession: vi.fn(), listBotmuxSessions: vi.fn(() => []) },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { config } from '../src/config.js';
import { readFleetProcessCommandLine } from '../src/core/fleet-process-identity.js';
import {
  inspectRecordedSessionWorker,
  readWorkerProcessStart,
  signalRecordedSessionWorker,
  type SessionWorkerProcessRuntime,
} from '../src/core/session-worker-identity.js';
import { sweepStaleSessionWorkerPids } from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';

const SID = 'cafe0001-0000-4000-8000-000000000000';

function fakeRuntime(over: Partial<SessionWorkerProcessRuntime> = {}): SessionWorkerProcessRuntime & { kill: ReturnType<typeof vi.fn> } {
  return {
    readIdentity: () => 'boot:100',
    readCommandLine: () => '/usr/bin/bun /opt/botmux/dist/worker.js',
    readSystemdUnit: () => 'app.slice',
    pidExists: () => true,
    kill: vi.fn(),
    ...over,
  } as SessionWorkerProcessRuntime & { kill: ReturnType<typeof vi.fn> };
}

describe('inspectRecordedSessionWorker', () => {
  const row = { sessionId: SID, pid: 4242, pidProcStart: 'boot:100' };

  it('accepts the recorded worker by worker entry or by its own session scope', () => {
    expect(inspectRecordedSessionWorker(row, fakeRuntime()).status).toBe('exact');
    expect(inspectRecordedSessionWorker(row, fakeRuntime({ readCommandLine: () => '/opt/botmux __worker' })).status).toBe('exact');
    expect(inspectRecordedSessionWorker(row, fakeRuntime({
      readCommandLine: () => 'claude --resume x',
      readSystemdUnit: () => `botmux-session-${SID}.scope`,
    })).status).toBe('exact');
  });

  it('rejects a reused pid, a legacy row and a process botmux cannot be shown to have launched', () => {
    expect(inspectRecordedSessionWorker(row, fakeRuntime({ readIdentity: () => 'boot:999' })).status).toBe('reused');
    expect(inspectRecordedSessionWorker({ sessionId: SID, pid: 4242 }, fakeRuntime()).status).toBe('unrecorded');
    expect(inspectRecordedSessionWorker(row, fakeRuntime({
      readCommandLine: () => '/usr/bin/python3 server.py',
      readSystemdUnit: () => 'botmux-session-another-session.scope',
    })).status).toBe('unproven');
  });

  it('treats a pid recycled between the two identity samples as reused', () => {
    const samples = ['boot:100', 'boot:101'];
    expect(inspectRecordedSessionWorker(row, fakeRuntime({ readIdentity: () => samples.shift() })).status).toBe('reused');
  });

  it('distinguishes a gone pid from an unreadable one', () => {
    expect(inspectRecordedSessionWorker(row, fakeRuntime({ readIdentity: () => undefined, pidExists: () => false })).status).toBe('gone');
    expect(inspectRecordedSessionWorker(row, fakeRuntime({ readIdentity: () => undefined })).status).toBe('unverifiable');
  });
});

describe('signalRecordedSessionWorker', () => {
  it('does not signal once the pid stops being the attested process', () => {
    const runtime = fakeRuntime({ readIdentity: () => 'boot:101' });
    expect(signalRecordedSessionWorker({ pid: 4242, processStart: 'boot:100' }, 'SIGTERM', { processGroup: true }, runtime)).toBe(false);
    expect(runtime.kill).not.toHaveBeenCalled();
  });

  it('signals the process group, falling back to the pid when it is not a group leader', () => {
    const runtime = fakeRuntime();
    runtime.kill.mockImplementationOnce(() => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); });
    expect(signalRecordedSessionWorker({ pid: 4242, processStart: 'boot:100' }, 'SIGTERM', { processGroup: true }, runtime)).toBe(true);
    expect(runtime.kill.mock.calls).toEqual([[-4242, 'SIGTERM'], [4242, 'SIGTERM']]);
  });
});

describe.runIf(process.platform !== 'win32')('stale worker pid sweep against real processes', () => {
  const children: ChildProcess[] = [];
  const dirs: string[] = [];
  let dataDir = '';
  let previousDataDir = '';

  beforeEach(() => {
    previousDataDir = config.session.dataDir;
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-stale-pid-store-'));
    dirs.push(dataDir);
    config.session.dataDir = dataDir;
    sessionStore.init('stale-pid-identity-test');
  });

  afterEach(() => {
    // Only this file's own children, by their handles.
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    config.session.dataDir = previousDataDir;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function spawnIdle(scriptName: 'worker.js' | 'idle.js') {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-stale-pid-proc-'));
    dirs.push(dir);
    const script = join(dir, scriptName);
    writeFileSync(script, 'setTimeout(() => {}, 600_000);\n');
    const child = spawnTsScript(script, [], { detached: true, stdio: 'ignore' });
    children.push(child);
    const exited = new Promise<NodeJS.Signals | null>(resolve => child.once('exit', (_code, signal) => resolve(signal)));
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const pid = child.pid!;
    const deadline = Date.now() + 10_000;
    while (!(readFleetProcessCommandLine(pid) ?? '').includes(script)) {
      if (Date.now() > deadline) throw new Error(`child ${pid} never ran ${script}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return { pid, exited, start: readWorkerProcessStart(pid)! };
  }

  const stillRunningAfter = async (exited: Promise<unknown>, ms = 400) =>
    (await Promise.race([exited.then(() => 'exited'), new Promise(resolve => setTimeout(() => resolve('running'), ms))])) === 'running';

  function persist(row: { pid: number; pidProcStart?: string }) {
    const session = { sessionId: SID, status: 'active', larkAppId: 'stale-pid-identity-test', ...row } as any;
    sessionStore.updateSession(session);
    return session;
  }

  it('does not signal a pid that was reused by another process', async () => {
    const proc = await spawnIdle('worker.js');
    // A genuine birth identity, but of a different process: the row's worker
    // is long gone and `proc` merely inherited its number.
    const recordedForAnotherProcess = readWorkerProcessStart(process.pid)!;
    expect(recordedForAnotherProcess).not.toBe(proc.start);
    const row = persist({ pid: proc.pid, pidProcStart: recordedForAnotherProcess });

    expect(sweepStaleSessionWorkerPids([row]).signalled).toBe(0);

    expect(await stillRunningAfter(proc.exited)).toBe(true);
    expect(sessionStore.getSession(SID)?.pid).toBeUndefined();
  });

  it('never signals a legacy row that has no recorded start identity', async () => {
    const proc = await spawnIdle('worker.js');
    const row = persist({ pid: proc.pid });

    expect(sweepStaleSessionWorkerPids([row]).signalled).toBe(0);

    expect(await stillRunningAfter(proc.exited)).toBe(true);
    // Alive and unprovable: the pid is kept for read-only consumers, never acted on.
    expect(sessionStore.getSession(SID)?.pid).toBe(proc.pid);
  });

  it('does not signal a matching-identity process that is not a botmux worker', async () => {
    const proc = await spawnIdle('idle.js');
    const row = persist({ pid: proc.pid, pidProcStart: proc.start });

    expect(sweepStaleSessionWorkerPids([row]).signalled).toBe(0);

    expect(await stillRunningAfter(proc.exited)).toBe(true);
  });

  it('still terminates the exact stale worker and clears its record', async () => {
    const proc = await spawnIdle('worker.js');
    const row = persist({ pid: proc.pid, pidProcStart: proc.start });

    expect(sweepStaleSessionWorkerPids([row]).signalled).toBe(1);

    expect(await proc.exited).toBe('SIGTERM');
    expect(sessionStore.getSession(SID)?.pid).toBeUndefined();
    expect(sessionStore.getSession(SID)?.pidProcStart).toBeUndefined();
  });

  it('keeps a pid recorded after the sweep snapshot was taken', async () => {
    const fresh = await spawnIdle('worker.js');
    const staleSnapshot = { sessionId: SID, status: 'active', pid: 999_999_999, pidProcStart: 'boot:0' } as any;
    // A worker forked for the session after the snapshot owns the row now.
    persist({ pid: fresh.pid, pidProcStart: fresh.start });

    sweepStaleSessionWorkerPids([staleSnapshot]);

    expect(sessionStore.getSession(SID)?.pid).toBe(fresh.pid);
    expect(await stillRunningAfter(fresh.exited)).toBe(true);
  });
});

describe('updateSessionPid', () => {
  let dataDir = '';
  let previousDataDir = '';
  beforeEach(() => {
    previousDataDir = config.session.dataDir;
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-stale-pid-update-'));
    config.session.dataDir = dataDir;
    sessionStore.init('stale-pid-update-test');
  });
  afterEach(() => {
    config.session.dataDir = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('persists the birth identity with the pid and clears both together', () => {
    sessionStore.updateSession({ sessionId: SID, status: 'active' } as any);
    sessionStore.updateSessionPid(SID, 4242, 'boot:100');
    sessionStore.init('stale-pid-update-test');
    expect(sessionStore.getSession(SID)).toMatchObject({ pid: 4242, pidProcStart: 'boot:100' });

    sessionStore.updateSessionPid(SID, null);
    sessionStore.init('stale-pid-update-test');
    expect(sessionStore.getSession(SID)?.pid).toBeUndefined();
    expect(sessionStore.getSession(SID)?.pidProcStart).toBeUndefined();
  });
});
