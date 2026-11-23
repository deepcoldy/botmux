/**
 * hc end to end against the real binary, inside the hc test fence. A session
 * goes through what botmux does with it: the worker's gate and the selector put
 * its terminal on this env's botmux core, a scripted CLI runs there and answers
 * input, a new worker instance reattaches from the persisted target and gets
 * its history back, and the daemon probes, batch-probes and ends terminals
 * through persistent-backend.ts. The startup sweep ends only a terminal its own
 * store owns. The host's hc runtime dir comes out exactly as it went in.
 *
 * Run:  BOTMUX_HC_TEST_BIN=<herdr-core> npx vitest run --project e2e test/hc-backend.e2e.ts
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HcBackend } from '../src/adapters/backend/hc-backend.js';
import { hcTerminalName, probeHcTerminal, type HcTarget } from '../src/adapters/backend/hc/cli-ops.js';
import { hcControlEnv, hcCoreAddress, hcCorePaths, hcRuntimeDirError } from '../src/adapters/backend/hc/core.js';
import { resolveHcBackendGate, selectSessionBackend } from '../src/adapters/backend/session-backend-selector.js';
import type { PersistentBackendTarget } from '../src/adapters/backend/types.js';
import {
  killPersistentBackendTarget,
  persistentBackendTargetKey,
  probePersistentBackendTarget,
  probePersistentBackendTargetAfterKill,
  probePersistentBackendTargets,
} from '../src/core/persistent-backend.js';
import { killStalePids } from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import { probeHcAvailability, resetHcAvailabilityCache } from '../src/setup/ensure-hc.js';
import type { Session } from '../src/types.js';

const realHc = process.env.BOTMUX_HC_TEST_BIN;
const hostRuntimeDir = `/run/user/${process.getuid?.() ?? 0}/herdr-core`;

const CLI = `#!/bin/sh
i=1
while [ $i -le 200 ]; do echo "history line $i"; i=$((i+1)); done
echo READY
while IFS= read -r line; do echo "GOT:$line"; done
`;

/** Names and inodes only: the host's files are listed, never opened. */
function hostEntries(): string[] {
  try {
    return readdirSync(hostRuntimeDir).map(name => `${name}#${lstatSync(join(hostRuntimeDir, name)).ino}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

class Watched {
  readonly data: string[] = [];
  readonly exits: Array<[number | null, string | null]> = [];
  readonly resyncs: string[] = [];

  constructor(readonly backend: HcBackend) {
    backend.onData(chunk => this.data.push(chunk));
    backend.onExit((code, signal) => this.exits.push([code, signal]));
    backend.onScreenResync(snapshot => this.resyncs.push(snapshot));
  }

  output(): string {
    return this.data.join('');
  }
}

async function until(check: () => void, timeout = 15_000): Promise<void> {
  await vi.waitFor(check, { timeout, interval: 50 });
}

describe.skipIf(!realHc)('hc end to end against the real binary', () => {
  let root: string;
  let cli: string;
  let hostBefore: string[];
  const opened: HcBackend[] = [];

  beforeAll(() => {
    if (!process.env.BOTMUX_HC_BIN || !process.env.XDG_RUNTIME_DIR?.startsWith('/tmp/bmhc-')) {
      throw new Error('the hc test fence did not set a private XDG_RUNTIME_DIR and BOTMUX_HC_BIN');
    }
    hostBefore = hostEntries();
    resetHcAvailabilityCache();
    root = mkdtempSync('/tmp/bmhce-');
    mkdirSync(join(root, 'home'));
    cli = join(root, 'cli.sh');
    writeFileSync(cli, CLI);
    chmodSync(cli, 0o755);
    sessionStore.init('hc-e2e');
  });

  afterAll(() => {
    for (const backend of opened.splice(0)) backend.destroySession();
    if (process.env.BOTMUX_HC_BIN) {
      // `server stop` only connects: it never starts a core.
      spawnSync(process.env.BOTMUX_HC_BIN, ['server', 'stop'], {
        env: hcControlEnv(process.env, hcCorePaths(process.env)),
        cwd: '/',
        stdio: 'ignore',
        timeout: 20_000,
      });
    }
    resetHcAvailabilityCache();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function workerGate(sessionId: string, recorded?: PersistentBackendTarget) {
    return resolveHcBackendGate({
      sessionId,
      recorded,
      availability: () => probeHcAvailability({ env: process.env }),
      defaultCore: () => hcCoreAddress(hcCorePaths(process.env)),
      coreUnreachable: core => hcRuntimeDirError(hcCorePaths(process.env, { core })),
      probe: target => probeHcTerminal(target),
    });
  }

  function spawnOpts(sessionId: string) {
    return {
      cwd: root,
      cols: 100,
      rows: 30,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(root, 'home') },
      launchShell: '/bin/sh',
      paneLaunchDir: join(root, 'launch', sessionId),
    };
  }

  /** What a worker does with a fresh session: gate, select, spawn the CLI, wait for it. */
  async function startSession(sessionId = randomUUID()): Promise<{ sessionId: string; target: HcTarget; session: Watched }> {
    const gate = workerGate(sessionId);
    const selected = selectSessionBackend({
      backendType: 'hc', sessionId, persistentBackendTarget: gate.target, hasExistingSession: gate.hasExistingSession,
    });
    const backend = selected.backend as HcBackend;
    opened.push(backend);
    const session = new Watched(backend);
    backend.spawn(cli, [], spawnOpts(sessionId));
    await until(() => expect(session.output()).toContain('READY'));
    return { sessionId, target: selected.persistentBackendTarget as HcTarget, session };
  }

  it('runs a CLI, reattaches it from a new worker instance and ends it from the daemon', async () => {
    const sessionId = randomUUID();
    const gate = workerGate(sessionId);
    expect(gate).toMatchObject({ available: true, probe: 'missing', hasExistingSession: false });
    const selected = selectSessionBackend({
      backendType: 'hc', sessionId, persistentBackendTarget: gate.target, hasExistingSession: gate.hasExistingSession,
    });
    expect(selected.backend).toBeInstanceOf(HcBackend);
    expect(selected).toMatchObject({ isPipeMode: true, isTmuxMode: false, isReattach: false });
    const target = selected.persistentBackendTarget as HcTarget;
    expect(target).toEqual({
      backendType: 'hc',
      sessionName: hcTerminalName(sessionId),
      hcSession: 'botmux',
      socket: join(process.env.XDG_RUNTIME_DIR!, 'herdr-core', 'botmux.sock'),
    });
    // Deciding needed no core; the spawn starts the first one, from the control env.
    expect(existsSync(target.socket)).toBe(false);

    const first = new Watched(selected.backend as HcBackend);
    opened.push(first.backend);
    first.backend.spawn(cli, [], spawnOpts(sessionId));
    await until(() => expect(first.output()).toContain('READY'));
    expect(existsSync(target.socket)).toBe(true);
    expect(first.backend.sendText('ping\r')).toBe(true);
    await until(() => expect(first.output()).toContain('GOT:ping'));
    const pid = first.backend.getChildPid();
    expect(pid).toEqual(expect.any(Number));
    expect(probePersistentBackendTarget(target)).toBe('exists');

    // Worker restart: the old instance only detaches; the new one has the persisted target.
    first.backend.kill();
    expect(first.exits).toEqual([]);
    const regate = workerGate(sessionId, target);
    expect(regate).toMatchObject({ target, probe: 'exists', hasExistingSession: true });
    const resumed = selectSessionBackend({
      backendType: 'hc', sessionId, persistentBackendTarget: regate.target, hasExistingSession: regate.hasExistingSession,
    });
    expect(resumed).toMatchObject({ isReattach: true, persistentBackendTarget: target });
    const again = new Watched(resumed.backend as HcBackend);
    opened.push(again.backend);
    again.backend.spawn('/bin/sh', ['-c', 'echo MUST_NOT_RUN'], spawnOpts(sessionId));
    // The worker's reattach seed (seedBackendScreen) asks before the first paint is in.
    expect(again.backend.captureCurrentScreen()).toBe('');
    await until(() => expect(again.resyncs).toHaveLength(1));
    expect(again.resyncs[0]).toMatch(/history line 1(?!\d)/);
    expect(again.resyncs[0]).toContain('GOT:ping');
    expect(again.backend.getChildPid()).toBe(pid);
    expect(again.backend.sendText('pong\r')).toBe(true);
    await until(() => expect(again.output()).toContain('GOT:pong'));
    expect(again.backend.captureCurrentScreen()).not.toContain('MUST_NOT_RUN');

    const other = await startSession();
    other.session.backend.kill();
    const ghost: HcTarget = { ...target, sessionName: hcTerminalName(randomUUID()) };
    const batch = probePersistentBackendTargets([target, other.target, ghost]);
    expect([target, other.target, ghost].map(t => batch.get(persistentBackendTargetKey(t)))).toEqual(['exists', 'exists', 'missing']);

    expect(() => killPersistentBackendTarget(other.target, sessionId)).toThrow();
    expect(probePersistentBackendTarget(other.target)).toBe('exists');
    again.backend.kill();
    killPersistentBackendTarget(target, sessionId);
    expect(probePersistentBackendTargetAfterKill(target)).toBe('missing');
    expect(probePersistentBackendTarget(other.target)).toBe('exists');
    killPersistentBackendTarget(other.target, other.sessionId);
    expect(probePersistentBackendTarget(other.target)).toBe('missing');
  }, 120_000);

  it('ends at startup a terminal its own store owns and no longer runs, never another store\'s', async () => {
    const owned = await startSession();
    const active = await startSession();
    const foreign = await startSession();
    for (const { session } of [owned, active, foreign]) session.backend.kill();
    const row = (sessionId: string, target: HcTarget, status: Session['status']): Session => ({
      sessionId,
      chatId: 'oc_hc_e2e',
      rootMessageId: `om_${sessionId.slice(0, 8)}`,
      title: 'hc-e2e',
      status,
      createdAt: new Date().toISOString(),
      larkAppId: 'app_hc_e2e',
      cliId: 'claude-code',
      backendType: 'hc',
      persistentBackendTarget: target,
    }) as Session;
    sessionStore.updateSession(row(owned.sessionId, owned.target, 'closed'));
    const activeRow = row(active.sessionId, active.target, 'active');
    sessionStore.updateSession(activeRow);

    killStalePids([activeRow]);

    expect(probePersistentBackendTarget(owned.target)).toBe('missing');
    expect(probePersistentBackendTarget(active.target)).toBe('exists');
    expect(probePersistentBackendTarget(foreign.target)).toBe('exists');
    killPersistentBackendTarget(active.target, active.sessionId);
    killPersistentBackendTarget(foreign.target, foreign.sessionId);
  }, 120_000);

  it('leaves the host hc runtime dir as it was', () => {
    expect(hostEntries().filter(entry => !hostBefore.includes(entry))).toEqual([]);
  });
});
