import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PersistentBackendTarget } from '../src/adapters/backend/types.js';
import {
  buildDeviceIsolationInventory,
  commitDeviceIsolationActivation,
  mergePersistedDeviceIsolationSessions,
  prepareDeviceIsolationActivation,
  releaseDeviceIsolationActivation,
  resetDeviceIsolationDaemonForTest,
  setDeviceIsolationDaemonDependenciesForTest,
  setDeviceIsolationDaemonIdentity,
  type DeviceIsolationRuntimeSession,
} from '../src/core/device-isolation-daemon.js';
import {
  currentDeviceIsolationFreezeLease,
  resetDeviceIsolationActivationForTest,
} from '../src/core/device-isolation-activation.js';

const NONCE = 'n'.repeat(43);
const ENABLED_AT = '2026-07-22T00:00:00.000Z';
const NOW = Date.parse(ENABLED_AT);

function digest(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function pendingMarker(): string {
  return `${JSON.stringify({ version: 1, state: 'pending', enabledAt: ENABLED_AT }, null, 2)}\n`;
}

function activeMarker(): string {
  return `${JSON.stringify({
    version: 1,
    state: 'active',
    enabledAt: ENABLED_AT,
    activatedAt: '2026-07-22T00:01:00.000Z',
  }, null, 2)}\n`;
}

function ownedPtySession(): DeviceIsolationRuntimeSession {
  return {
    sessionId: 'session-owned',
    adopted: false,
    frozenBackend: 'pty',
    workerPresent: true,
    workerGeneration: 7,
    worker: { pid: 2001, procStart: 'worker-start' },
    attestation: {
      backendType: 'pty',
      credentialIsolated: false,
      cli: { pid: 2002, procStart: 'cli-start' },
      workerGeneration: 7,
    },
  };
}

beforeEach(() => {
  resetDeviceIsolationActivationForTest();
  resetDeviceIsolationDaemonForTest();
  setDeviceIsolationDaemonIdentity({ larkAppId: 'cli_test', bootInstanceId: 'boot-test' });
});

afterEach(() => {
  resetDeviceIsolationActivationForTest();
  resetDeviceIsolationDaemonForTest();
});

describe('device-isolation daemon transaction', () => {
  it('includes unregistered durable store rows and fails closed on exact ZMX/Herdr targets', () => {
    const zmxTarget = {
      backendType: 'zmx' as const,
      sessionName: 'bmx-storezmx',
    };
    const herdrTarget = {
      backendType: 'herdr' as const,
      sessionName: 'shared-host',
      agentName: 'botmux-store-agent',
    };
    const sessions = mergePersistedDeviceIsolationSessions([], [
      {
        sessionId: 'store-zmx',
        status: 'active',
        backendType: 'zmx',
        persistentBackendTarget: zmxTarget,
      } as any,
      {
        sessionId: 'store-herdr',
        status: 'active',
        backendType: 'herdr',
        persistentBackendTarget: herdrTarget,
      } as any,
      {
        sessionId: 'store-missing',
        status: 'active',
        backendType: 'zmx',
        persistentBackendTarget: {
          backendType: 'zmx',
          sessionName: 'bmx-missing',
        },
      } as any,
      {
        sessionId: 'store-adopted',
        status: 'active',
        backendType: 'tmux',
        adoptedFrom: { source: 'tmux', tmuxTarget: 'user:1.0', cwd: '/repo' },
      } as any,
      {
        sessionId: 'store-target-only',
        status: 'active',
        persistentBackendTarget: {
          backendType: 'zmx',
          sessionName: 'bmx-target-only',
        },
      } as any,
      {
        sessionId: 'store-legacy-durable',
        status: 'active',
        cliSessionId: 'legacy-cli-session',
      } as any,
      {
        sessionId: 'store-pty-live-pid',
        status: 'active',
        backendType: 'pty',
        pid: 4242,
      } as any,
      {
        sessionId: 'store-pty-dead-pid',
        status: 'active',
        backendType: 'pty',
        pid: 4343,
      } as any,
      {
        sessionId: 'store-queued',
        status: 'active',
        queued: true,
        backendType: 'zmx',
      } as any,
      {
        sessionId: 'store-scratch',
        status: 'active',
      } as any,
      {
        sessionId: 'store-closed',
        status: 'closed',
        backendType: 'zmx',
      } as any,
    ]);
    setDeviceIsolationDaemonDependenciesForTest({
      dataDir: () => '/tmp/data',
      listSessions: () => sessions,
      processStart: pid => pid === process.pid ? 'daemon-start' : undefined,
      processExists: pid => pid === 4242,
      probePersistent: target => {
        if (target.sessionName === zmxTarget.sessionName) return 'exists';
        if (
          target.backendType === 'herdr'
          && target.sessionName === herdrTarget.sessionName
          && target.agentName === herdrTarget.agentName
        ) return 'unknown';
        return 'missing';
      },
    });

    const inventory = buildDeviceIsolationInventory();

    expect(inventory.entries.map(entry => entry.sessionId)).toEqual([
      'store-adopted',
      'store-herdr',
      'store-legacy-durable',
      'store-missing',
      'store-pty-dead-pid',
      'store-pty-live-pid',
      'store-target-only',
      'store-zmx',
    ]);
    expect(inventory.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: 'store-zmx',
        disposition: 'blocked',
        blocker: 'unattested_worker',
        persistent: { target: zmxTarget, probe: 'exists' },
      }),
      expect.objectContaining({
        sessionId: 'store-herdr',
        disposition: 'blocked',
        blocker: 'backend_probe_unknown',
        persistent: { target: herdrTarget, probe: 'unknown' },
      }),
      expect.objectContaining({
        sessionId: 'store-missing',
        disposition: 'quiescent',
        persistent: {
          target: { backendType: 'zmx', sessionName: 'bmx-missing' },
          probe: 'missing',
        },
      }),
      expect.objectContaining({
        sessionId: 'store-adopted',
        disposition: 'blocked',
        blocker: 'adopted_session',
      }),
      expect.objectContaining({
        sessionId: 'store-target-only',
        backendType: 'zmx',
        disposition: 'quiescent',
        persistent: {
          target: {
            backendType: 'zmx',
            sessionName: 'bmx-target-only',
          },
          probe: 'missing',
        },
      }),
      expect.objectContaining({
        sessionId: 'store-legacy-durable',
        backendType: 'unknown',
        disposition: 'blocked',
        blocker: 'unknown_backend',
      }),
      expect.objectContaining({
        sessionId: 'store-pty-live-pid',
        backendType: 'pty',
        disposition: 'blocked',
        blocker: 'process_identity_unavailable',
      }),
      expect.objectContaining({
        sessionId: 'store-pty-dead-pid',
        backendType: 'pty',
        disposition: 'quiescent',
      }),
    ]));
    expect(prepareDeviceIsolationActivation({
      activationVersion: 1,
      nonce: NONCE,
    })).toMatchObject({
      status: 409,
      body: { ok: false, error: 'activation_blocked' },
    });
  });

  it('lets a runtime row win over a persisted active row with the same session id', () => {
    const runtime: DeviceIsolationRuntimeSession = {
      sessionId: 'same-session',
      adopted: false,
      frozenBackend: 'zmx',
      persistentBackendTarget: {
        backendType: 'zmx',
        sessionName: 'bmx-runtime',
      },
      workerPresent: false,
    };

    const merged = mergePersistedDeviceIsolationSessions([runtime], [{
      sessionId: runtime.sessionId,
      status: 'active',
      backendType: 'zmx',
      persistentBackendTarget: {
        backendType: 'zmx',
        sessionName: 'bmx-stale-store',
      },
    } as any]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(runtime);
    expect(merged[0]?.persistentBackendTarget).toEqual({
      backendType: 'zmx',
      sessionName: 'bmx-runtime',
    });
  });

  it('freezes, quiesces exact local identities, accepts ACTIVE release hash, then unfreezes', async () => {
    let marker = pendingMarker();
    let sessions = [ownedPtySession()];
    const live = new Map<number, string>([
      [process.pid, 'daemon-start'],
      [2001, 'worker-start'],
      [2002, 'cli-start'],
    ]);
    let closeCalls = 0;
    setDeviceIsolationDaemonDependenciesForTest({
      now: () => NOW,
      dataDir: () => '/tmp/botmux-device-isolation-data',
      listSessions: () => sessions,
      processStart: pid => live.get(pid),
      processExists: pid => live.has(pid),
      readMarker: () => marker,
      closeWorker: () => {
        closeCalls += 1;
        live.delete(2001);
        live.delete(2002);
        sessions = [{
          sessionId: 'session-owned',
          adopted: false,
          frozenBackend: 'pty',
          workerPresent: false,
        }];
      },
      sleep: async () => {},
    });

    const prepared = prepareDeviceIsolationActivation({ activationVersion: 1, nonce: NONCE });
    expect(prepared.status).toBe(200);
    expect(prepared.body).toMatchObject({
      ok: true,
      activationVersion: 1,
      nonce: NONCE,
      phase: 'prepared',
      daemon: {
        larkAppId: 'cli_test',
        bootInstanceId: 'boot-test',
        pid: process.pid,
        procStart: 'daemon-start',
      },
    });
    const leaseId = prepared.body.leaseId as string;
    expect(currentDeviceIsolationFreezeLease(NOW)).not.toBeNull();

    const committed = await commitDeviceIsolationActivation({
      activationVersion: 1,
      nonce: NONCE,
      leaseId,
      markerSha256: digest(marker),
    });
    expect(committed.status).toBe(200);
    expect(committed.body.phase).toBe('committed');
    expect(closeCalls).toBe(1);
    expect(currentDeviceIsolationFreezeLease(NOW)).not.toBeNull();

    marker = activeMarker();
    const released = releaseDeviceIsolationActivation({
      activationVersion: 1,
      nonce: NONCE,
      leaseId,
      markerSha256: digest(marker),
    });
    expect(released.status).toBe(200);
    expect(released.body.released).toBe(true);
    expect(currentDeviceIsolationFreezeLease(NOW)).toBeNull();
  });

  it('blocks adopted and unattested detached ZMX sessions before exposing a lease', () => {
    const sessions: DeviceIsolationRuntimeSession[] = [{
      sessionId: 'adopted',
      adopted: true,
      frozenBackend: 'tmux',
      workerPresent: false,
    }, {
      sessionId: 'abcdefgh-detached',
      adopted: false,
      frozenBackend: 'zmx',
      workerPresent: false,
    }];
    const probes: PersistentBackendTarget[] = [];
    setDeviceIsolationDaemonDependenciesForTest({
      dataDir: () => '/tmp/data',
      listSessions: () => sessions,
      processStart: pid => pid === process.pid ? 'daemon-start' : undefined,
      probePersistent: target => {
        probes.push(target);
        return 'exists';
      },
    });

    const inventory = buildDeviceIsolationInventory();
    expect(inventory.blockers).toEqual([
      { sessionId: 'abcdefgh-detached', blocker: 'unattested_worker' },
      { sessionId: 'adopted', blocker: 'adopted_session' },
    ]);
    expect(inventory.entries[0]).toMatchObject({
      sessionId: 'abcdefgh-detached',
      backendType: 'zmx',
      disposition: 'blocked',
      persistent: {
        target: {
          backendType: 'zmx',
          sessionName: 'bmx-abcdefgh',
        },
        probe: 'exists',
      },
    });
    expect(probes).toEqual([{
      backendType: 'zmx',
      sessionName: 'bmx-abcdefgh',
    }]);
    const result = prepareDeviceIsolationActivation({ activationVersion: 1, nonce: NONCE });
    expect(result).toMatchObject({
      status: 409,
      body: { ok: false, error: 'activation_blocked' },
    });
    expect(currentDeviceIsolationFreezeLease(NOW)).toBeNull();
  });

  it('terminates an attested live ZMX session before committing activation', async () => {
    let marker = pendingMarker();
    let backingExists = true;
    let sessions: DeviceIsolationRuntimeSession[] = [{
      sessionId: 'abcdefgh-owned',
      adopted: false,
      frozenBackend: 'zmx',
      workerPresent: true,
      workerGeneration: 9,
      worker: { pid: 3001, procStart: 'zmx-worker-start' },
      attestation: {
        backendType: 'zmx',
        credentialIsolated: false,
        cli: { pid: 3002, procStart: 'zmx-cli-start' },
        workerGeneration: 9,
      },
    }];
    const live = new Map<number, string>([
      [process.pid, 'daemon-start'],
      [3001, 'zmx-worker-start'],
      [3002, 'zmx-cli-start'],
    ]);
    const killed: Array<{ target: PersistentBackendTarget; sessionId: string }> = [];
    let closeCalls = 0;
    setDeviceIsolationDaemonDependenciesForTest({
      now: () => NOW,
      dataDir: () => '/tmp/data',
      listSessions: () => sessions,
      processStart: pid => live.get(pid),
      processExists: pid => live.has(pid),
      readMarker: () => marker,
      probePersistent: target => {
        expect(target).toEqual({
          backendType: 'zmx',
          sessionName: 'bmx-abcdefgh',
        });
        return backingExists ? 'exists' : 'missing';
      },
      killPersistent: (target, sessionId) => {
        killed.push({ target, sessionId });
        backingExists = false;
      },
      closeWorker: () => {
        closeCalls += 1;
        live.delete(3001);
        live.delete(3002);
        sessions = [{
          sessionId: 'abcdefgh-owned',
          adopted: false,
          frozenBackend: 'zmx',
          workerPresent: false,
        }];
      },
      sleep: async () => {},
    });

    const prepared = prepareDeviceIsolationActivation({ activationVersion: 1, nonce: NONCE });
    expect(prepared.status).toBe(200);
    expect(prepared.body.inventory).toEqual([
      expect.objectContaining({
        sessionId: 'abcdefgh-owned',
        backendType: 'zmx',
        disposition: 'owned_local',
        persistent: {
          target: {
            backendType: 'zmx',
            sessionName: 'bmx-abcdefgh',
          },
          probe: 'exists',
        },
      }),
    ]);

    const committed = await commitDeviceIsolationActivation({
      activationVersion: 1,
      nonce: NONCE,
      leaseId: prepared.body.leaseId,
      markerSha256: digest(marker),
    });

    expect(committed).toMatchObject({ status: 200, body: { phase: 'committed' } });
    expect(closeCalls).toBe(1);
    expect(killed).toEqual([{
      target: {
        backendType: 'zmx',
        sessionName: 'bmx-abcdefgh',
      },
      sessionId: 'abcdefgh-owned',
    }]);
    expect(backingExists).toBe(false);
  });

  it('uses the persisted shared Herdr host+agent for a live worker inventory', () => {
    const sharedTarget = {
      backendType: 'herdr' as const,
      sessionName: 'shared-host',
      agentName: 'botmux-owned-agent',
    };
    const probes: PersistentBackendTarget[] = [];
    const session: DeviceIsolationRuntimeSession = {
      sessionId: 'herdr-live-session',
      adopted: false,
      frozenBackend: 'herdr',
      persistentBackendTarget: sharedTarget,
      workerPresent: true,
      workerGeneration: 11,
      worker: { pid: 4101, procStart: 'herdr-worker-start' },
      attestation: {
        backendType: 'herdr' as const,
        credentialIsolated: false,
        cli: { pid: 4102, procStart: 'herdr-cli-start' },
        workerGeneration: 11,
      },
    };
    setDeviceIsolationDaemonDependenciesForTest({
      listSessions: () => [session],
      processStart: pid => new Map([
        [4101, 'herdr-worker-start'],
        [4102, 'herdr-cli-start'],
      ]).get(pid),
      probePersistent: target => {
        probes.push(target);
        return target.backendType === 'herdr'
          && target.sessionName === sharedTarget.sessionName
          && target.agentName === sharedTarget.agentName
          ? 'exists'
          : 'missing';
      },
    });

    const inventory = buildDeviceIsolationInventory();

    expect(inventory.blockers).toEqual([]);
    expect(inventory.entries).toEqual([
      expect.objectContaining({
        sessionId: session.sessionId,
        backendType: 'herdr',
        disposition: 'owned_local',
        persistent: {
          target: sharedTarget,
          probe: 'exists',
        },
      }),
    ]);
    expect(probes).toEqual([sharedTarget]);
  });

  it('kills only the exact worker-less shared Herdr agent before committing isolation', async () => {
    const marker = pendingMarker();
    const sharedTarget = {
      backendType: 'herdr' as const,
      sessionName: 'shared-host',
      agentName: 'botmux-owned-agent',
    };
    const siblingAgent = 'botmux-sibling-agent';
    const agents = new Set([sharedTarget.agentName, siblingAgent]);
    const probes: PersistentBackendTarget[] = [];
    const killed: Array<{ target: PersistentBackendTarget; sessionId: string }> = [];
    const session: DeviceIsolationRuntimeSession = {
      sessionId: 'herdr-workerless-session',
      adopted: false,
      frozenBackend: 'herdr',
      persistentBackendTarget: sharedTarget,
      workerPresent: false,
    };

    setDeviceIsolationDaemonDependenciesForTest({
      now: () => NOW,
      dataDir: () => '/tmp/data',
      listSessions: () => [session],
      processStart: pid => pid === process.pid ? 'daemon-start' : undefined,
      processExists: () => false,
      readMarker: () => marker,
      probePersistent: target => {
        probes.push(target);
        return target.backendType === 'herdr'
          && target.sessionName === sharedTarget.sessionName
          && target.agentName !== undefined
          && agents.has(target.agentName)
          ? 'exists'
          : 'missing';
      },
      killPersistent: (target, sessionId) => {
        killed.push({ target, sessionId });
        if (target.backendType === 'herdr' && target.agentName) {
          agents.delete(target.agentName);
        }
      },
      closeWorker: () => {
        throw new Error('worker-less exact target must not invoke closeWorker');
      },
      sleep: async () => {},
    });

    const prepared = prepareDeviceIsolationActivation({
      activationVersion: 1,
      nonce: NONCE,
    });
    expect(prepared.status).toBe(200);
    expect(prepared.body.inventory).toEqual([
      expect.objectContaining({
        sessionId: session.sessionId,
        disposition: 'owned_local',
        persistent: {
          target: sharedTarget,
          probe: 'exists',
        },
      }),
    ]);

    const committed = await commitDeviceIsolationActivation({
      activationVersion: 1,
      nonce: NONCE,
      leaseId: prepared.body.leaseId,
      markerSha256: digest(marker),
    });

    expect(committed).toMatchObject({ status: 200, body: { phase: 'committed' } });
    expect(killed).toEqual([{ target: sharedTarget, sessionId: session.sessionId }]);
    expect(agents.has(sharedTarget.agentName)).toBe(false);
    expect(agents.has(siblingAgent)).toBe(true);
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every(target =>
      target.backendType === sharedTarget.backendType
      && target.sessionName === sharedTarget.sessionName
      && target.agentName === sharedTarget.agentName
    )).toBe(true);
  });

  it('allows abort only before commit and retains the committed freeze', async () => {
    let marker = pendingMarker();
    setDeviceIsolationDaemonDependenciesForTest({
      now: () => NOW,
      dataDir: () => '/tmp/data',
      listSessions: () => [],
      processStart: pid => pid === process.pid ? 'daemon-start' : undefined,
      processExists: () => false,
      readMarker: () => marker,
    });
    const first = prepareDeviceIsolationActivation({ activationVersion: 1, nonce: NONCE });
    const firstLease = first.body.leaseId as string;
    expect(releaseDeviceIsolationActivation({
      activationVersion: 1, nonce: NONCE, leaseId: firstLease, abort: true,
    }).body.aborted).toBe(true);
    expect(currentDeviceIsolationFreezeLease(NOW)).toBeNull();

    const second = prepareDeviceIsolationActivation({ activationVersion: 1, nonce: NONCE });
    const secondLease = second.body.leaseId as string;
    expect((await commitDeviceIsolationActivation({
      activationVersion: 1,
      nonce: NONCE,
      leaseId: secondLease,
      markerSha256: digest(marker),
    })).status).toBe(200);
    const rejected = releaseDeviceIsolationActivation({
      activationVersion: 1, nonce: NONCE, leaseId: secondLease, abort: true,
    });
    expect(rejected).toMatchObject({
      status: 409,
      body: { error: 'activation_committed' },
    });
    expect(currentDeviceIsolationFreezeLease(NOW)).not.toBeNull();

    marker = activeMarker();
    expect(releaseDeviceIsolationActivation({
      activationVersion: 1,
      nonce: NONCE,
      leaseId: secondLease,
      markerSha256: digest(marker),
    }).status).toBe(200);
  });

  it('fails closed when marker state/hash or inventory changes', async () => {
    let marker = pendingMarker();
    let sessions: DeviceIsolationRuntimeSession[] = [];
    setDeviceIsolationDaemonDependenciesForTest({
      now: () => NOW,
      dataDir: () => '/tmp/data',
      listSessions: () => sessions,
      processStart: pid => pid === process.pid ? 'daemon-start' : undefined,
      processExists: () => false,
      readMarker: () => marker,
    });
    const prepared = prepareDeviceIsolationActivation({ activationVersion: 1, nonce: NONCE });
    const leaseId = prepared.body.leaseId as string;
    expect((await commitDeviceIsolationActivation({
      activationVersion: 1,
      nonce: NONCE,
      leaseId,
      markerSha256: '0'.repeat(64),
    })).body.error).toBe('marker_mismatch');

    sessions = [{
      sessionId: 'late-worker',
      adopted: false,
      frozenBackend: 'pty',
      workerPresent: false,
    }];
    expect((await commitDeviceIsolationActivation({
      activationVersion: 1,
      nonce: NONCE,
      leaseId,
      markerSha256: digest(marker),
    })).body.error).toBe('inventory_changed');
  });
});

describe('containment boot reconciliation runs once, before the inventory (round-11 P1-1)', () => {
  afterEach(() => { resetDeviceIsolationDaemonForTest(); });

  it('calls reconcileContainmentOnBoot exactly once across repeated inventory builds', () => {
    let calls = 0;
    setDeviceIsolationDaemonDependenciesForTest({
      listSessions: () => [],
      reconcileContainmentOnBoot: () => { calls++; },
    });
    buildDeviceIsolationInventory();
    buildDeviceIsolationInventory();
    buildDeviceIsolationInventory();
    expect(calls).toBe(1); // once per boot, guarded — not per request
  });

  it('a throwing reconciliation is swallowed and the inventory still builds (fail-closed: blockers retained)', () => {
    setDeviceIsolationDaemonDependenciesForTest({
      listSessions: () => [],
      reconcileContainmentOnBoot: () => { throw new Error('store unreadable'); },
    });
    expect(() => buildDeviceIsolationInventory()).not.toThrow();
  });
});
