import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDeviceIsolationInventory,
  commitDeviceIsolationActivation,
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
    const probes: Array<{ backendType: string; name: string }> = [];
    setDeviceIsolationDaemonDependenciesForTest({
      dataDir: () => '/tmp/data',
      listSessions: () => sessions,
      processStart: pid => pid === process.pid ? 'daemon-start' : undefined,
      probePersistent: (backendType, name) => {
        probes.push({ backendType, name });
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
        backendType: 'zmx',
        name: 'bmx-abcdefgh',
        probe: 'exists',
      },
    });
    expect(probes).toEqual([{ backendType: 'zmx', name: 'bmx-abcdefgh' }]);
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
    const killed: Array<{ backendType: string; name: string; sessionId: string }> = [];
    let closeCalls = 0;
    setDeviceIsolationDaemonDependenciesForTest({
      now: () => NOW,
      dataDir: () => '/tmp/data',
      listSessions: () => sessions,
      processStart: pid => live.get(pid),
      processExists: pid => live.has(pid),
      readMarker: () => marker,
      probePersistent: (backendType, name) => {
        expect({ backendType, name }).toEqual({
          backendType: 'zmx',
          name: 'bmx-abcdefgh',
        });
        return backingExists ? 'exists' : 'missing';
      },
      killPersistent: (backendType, name, sessionId) => {
        killed.push({ backendType, name, sessionId });
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
          backendType: 'zmx',
          name: 'bmx-abcdefgh',
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
      backendType: 'zmx',
      name: 'bmx-abcdefgh',
      sessionId: 'abcdefgh-owned',
    }]);
    expect(backingExists).toBe(false);
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
