import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDeviceCredentials, writeDeviceCredentials } from '../src/platform/device.js';
import {
  DeviceEnrollmentClient,
  DeviceProtocolError,
  clearStoredDeviceCredentials,
  deviceEnrollmentJournalPath,
  enrollStoredDeviceCredentials,
  refreshStoredDeviceCredentials,
  type DeviceHttpRequest,
  type DeviceHttpResponse,
} from '../src/platform/device-enroll.js';

const roots: string[] = [];

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-device-refresh-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function queuedTransport(responses: DeviceHttpResponse[]) {
  const requests: DeviceHttpRequest[] = [];
  const transport = vi.fn(async (request: DeviceHttpRequest) => {
    requests.push(request);
    const response = responses.shift();
    if (!response) throw new Error('unexpected request');
    return response;
  });
  return { transport, requests };
}

describe('desktop device enrollment protocol client', () => {
  it('keeps the machine bearer in Authorization and secrets out of URLs', async () => {
    const fake = queuedTransport([{ status: 201, body: {
      grantId: 'grant-1',
      pollSecret: 'poll-secret',
      expiresAt: 1_900_000_000_000,
      pollIntervalMs: 3_000,
    } }]);
    const client = new DeviceEnrollmentClient('https://platform.example.test', {
      transport: fake.transport,
    });
    const grant = await client.beginEnrollment({
      machineToken: 'machine-secret',
      deviceName: 'Dev Mac',
    });

    expect(grant).toMatchObject({ grantId: 'grant-1', pollSecret: 'poll-secret' });
    expect(fake.requests[0]).toMatchObject({
      url: 'https://platform.example.test/api/devices/enroll',
      headers: { authorization: 'Bearer machine-secret' },
      body: { deviceKind: 'desktop-ide', deviceName: 'Dev Mac' },
    });
    expect(fake.requests[0].url).not.toContain('machine-secret');
    expect(JSON.stringify(fake.requests[0].body)).not.toContain('machine-secret');
  });

  it('models pending poll separately from the credential response', async () => {
    const fake = queuedTransport([
      { status: 200, body: { status: 'pending', pollIntervalMs: 4_000 } },
      { status: 200, body: {
        status: 'issued',
        accessToken: 'access-secret',
        accessExpiresAt: 1_800_000_000_000,
        refreshToken: 'refresh-secret',
        deviceExp: 1_900_000_000_000,
      } },
    ]);
    const client = new DeviceEnrollmentClient('https://platform.example.test', {
      transport: fake.transport,
    });
    const grant = { grantId: 'grant-1', pollSecret: 'poll-secret' };
    await expect(client.pollEnrollment(grant)).resolves.toEqual({ kind: 'pending', retryAfterMs: 4_000 });
    await expect(client.pollEnrollment(grant)).resolves.toEqual({
      kind: 'issued',
      credentials: {
        accessToken: 'access-secret',
        accessExpiresAt: 1_800_000_000_000,
        refreshToken: 'refresh-secret',
        deviceExp: 1_900_000_000_000,
      },
    });
    expect(fake.requests[0].url).not.toContain('poll-secret');
    expect(fake.requests[0].body).toEqual({ grantId: 'grant-1', pollSecret: 'poll-secret' });
  });

  it('waits through pending without exposing the grant secret', async () => {
    const fake = queuedTransport([
      { status: 202, body: { retryAfterMs: 1_000 } },
      { status: 200, body: {
        accessToken: 'a2', accessExpiresAt: 1_800_000_000_000,
        refreshToken: 'r2', deviceExp: 1_900_000_000_000,
      } },
    ]);
    let now = 1_800_000_000_000;
    const sleeps: number[] = [];
    const client = new DeviceEnrollmentClient('https://platform.example.test', {
      transport: fake.transport,
      now: () => now,
      sleep: async ms => { sleeps.push(ms); now += ms; },
    });
    const pending = vi.fn();
    await expect(client.waitForEnrollment({
      grantId: 'g', pollSecret: 'p', expiresAt: now + 10_000,
    }, { onPending: pending })).resolves.toMatchObject({ accessToken: 'a2', refreshToken: 'r2' });
    expect(pending).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([2_000]);
  });

  it('rotates refresh exactly once and does not reflect response bodies into errors', async () => {
    const reflectedSecret = 'refresh-should-never-be-reflected';
    const fake = queuedTransport([{ status: 400, body: {
      error: reflectedSecret,
      detail: `bad ${reflectedSecret}`,
    } }]);
    const client = new DeviceEnrollmentClient('https://platform.example.test', {
      transport: fake.transport,
    });
    let caught: unknown;
    try {
      await client.refresh(reflectedSecret, {
        requestId: '00000000-0000-4000-8000-000000000001',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DeviceProtocolError);
    expect((caught as Error).message).not.toContain(reflectedSecret);
    expect(fake.transport).toHaveBeenCalledTimes(1);
    expect(fake.requests[0].url).not.toContain(reflectedSecret);
    expect(fake.requests[0].body).toEqual({ refreshToken: reflectedSecret });
    expect(fake.requests[0].headers).toMatchObject({
      'idempotency-key': '00000000-0000-4000-8000-000000000001',
    });
  });

  it('rejects endpoint overrides that could escape the pinned origin', () => {
    expect(() => new DeviceEnrollmentClient('https://platform.example.test', {
      endpoints: { refresh: '//evil.example.test/steal' },
    })).toThrow(/同源/);
    expect(() => new DeviceEnrollmentClient('https://platform.example.test', {
      endpoints: { refresh: '/\\evil.example.test/steal' },
    })).toThrow(/同源/);
  });

  it('persists one refresh request id, retains it on failure, and reuses it on retry', async () => {
    const homeDir = tempHome();
    writeDeviceCredentials({
      issuer: 'https://platform.example.test',
      accessToken: 'old-access',
      accessExpiresAt: 1_800_000_000_000,
      refreshToken: 'old-refresh',
      deviceExp: 1_900_000_000_000,
    }, { homeDir });
    const requestId = '00000000-0000-4000-8000-000000000002';
    const failedRefresh = vi.fn(async () => {
      throw new DeviceProtocolError('无法连接设备平台', 'network_error');
    });
    await expect(refreshStoredDeviceCredentials({
      homeDir,
      requestIdFactory: () => requestId,
      sleep: async () => {},
      createClient: issuer => ({ issuer, refresh: failedRefresh }),
    })).rejects.toThrow(/无法连接/);
    expect(readDeviceCredentials({ homeDir })?.pendingRefreshRequestId).toBe(requestId);

    const successfulRefresh = vi.fn(async () => ({
      accessToken: 'new-access',
      accessExpiresAt: 1_800_000_100_000,
      refreshToken: 'new-refresh',
      deviceExp: 1_900_000_000_000,
    }));
    const result = await refreshStoredDeviceCredentials({
      homeDir,
      requestIdFactory: () => 'must-not-replace-persisted-id',
      createClient: issuer => ({ issuer, refresh: successfulRefresh }),
    });
    expect(successfulRefresh).toHaveBeenCalledWith('old-refresh', {
      requestId,
      signal: undefined,
    });
    expect(result).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh' });
    expect(result.pendingRefreshRequestId).toBeUndefined();
  });

  it('coalesces concurrent cross-process-style refresh callers into one rotation', async () => {
    const homeDir = tempHome();
    writeDeviceCredentials({
      issuer: 'https://platform.example.test',
      accessToken: 'old-access',
      accessExpiresAt: 1_800_000_000_000,
      refreshToken: 'old-refresh',
      deviceExp: 1_900_000_000_000,
    }, { homeDir });

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const refresh = vi.fn(async () => {
      started();
      await gate;
      return {
        accessToken: 'winner-access',
        accessExpiresAt: 1_800_000_100_000,
        refreshToken: 'winner-refresh',
        deviceExp: 1_900_000_000_000,
      };
    });
    const options = {
      homeDir,
      requestIdFactory: () => '00000000-0000-4000-8000-000000000003',
      createClient: (issuer: string) => ({ issuer, refresh }),
    };
    const first = refreshStoredDeviceCredentials(options);
    await entered;
    const second = refreshStoredDeviceCredentials(options);
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(left.refreshToken).toBe('winner-refresh');
    expect(right.refreshToken).toBe('winner-refresh');
  });

  it('serializes logout after an in-flight refresh so credentials cannot revive', async () => {
    const homeDir = tempHome();
    writeDeviceCredentials({
      issuer: 'https://platform.example.test', accessToken: 'a1',
      accessExpiresAt: 1_800_000_000_000, refreshToken: 'r1', deviceExp: 1_900_000_000_000,
    }, { homeDir });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const refresh = vi.fn(async () => {
      entered();
      await gate;
      return {
        accessToken: 'a2', accessExpiresAt: 1_800_000_010_000,
        refreshToken: 'r2', deviceExp: 1_900_000_000_000,
      };
    });
    const rotating = refreshStoredDeviceCredentials({
      homeDir,
      createClient: issuer => ({ issuer, refresh }),
    });
    await started;
    const loggingOut = clearStoredDeviceCredentials({ homeDir });
    release();
    await rotating;
    await expect(loggingOut).resolves.toBe(true);
    expect(readDeviceCredentials({ homeDir })).toBeNull();
  });

  it('retries ambiguous refresh failures with the same durable key', async () => {
    const homeDir = tempHome();
    writeDeviceCredentials({
      issuer: 'https://platform.example.test', accessToken: 'a1',
      accessExpiresAt: 1_800_000_000_000, refreshToken: 'r1', deviceExp: 1_900_000_000_000,
    }, { homeDir });
    const refresh = vi.fn()
      .mockRejectedValueOnce(new DeviceProtocolError('network', 'network_error'))
      .mockResolvedValueOnce({
        accessToken: 'a2', accessExpiresAt: 1_800_000_010_000,
        refreshToken: 'r2', deviceExp: 1_900_000_000_000,
      });
    const requestId = '00000000-0000-4000-8000-000000000004';
    await refreshStoredDeviceCredentials({
      homeDir,
      requestIdFactory: () => requestId,
      sleep: async () => {},
      createClient: issuer => ({ issuer, refresh }),
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh.mock.calls.map(call => call[1].requestId)).toEqual([requestId, requestId]);
    expect(readDeviceCredentials({ homeDir })?.pendingRefreshRequestId).toBeUndefined();
  });

  it('honors a bounded 429 Retry-After and retries with the same durable key', async () => {
    const homeDir = tempHome();
    writeDeviceCredentials({
      issuer: 'https://platform.example.test', accessToken: 'a1',
      accessExpiresAt: 1_800_000_000_000, refreshToken: 'r1', deviceExp: 1_900_000_000_000,
    }, { homeDir });
    const fake = queuedTransport([
      // Even an allow-listed terminal code in a transient-status body must not
      // override the HTTP 429 semantics.
      { status: 429, body: { error: 'bad_request' }, headers: { 'retry-after': '2' } },
      { status: 200, body: {
        accessToken: 'a2', accessExpiresAt: 1_800_000_010_000,
        refreshToken: 'r2', deviceExp: 1_900_000_000_000,
      } },
    ]);
    let now = 1_800_000_000_000;
    const sleeps: number[] = [];
    const requestId = '00000000-0000-4000-8000-000000000007';
    await refreshStoredDeviceCredentials({
      homeDir,
      now: () => new Date(now),
      requestIdFactory: () => requestId,
      sleep: async ms => { sleeps.push(ms); now += ms; },
      createClient: issuer => new DeviceEnrollmentClient(issuer, {
        transport: fake.transport,
        now: () => now,
      }),
    });
    expect(sleeps).toEqual([2_000]);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests.map(request => request.headers['idempotency-key']))
      .toEqual([requestId, requestId]);
    expect(readDeviceCredentials({ homeDir })).toMatchObject({ refreshToken: 'r2' });
    expect(readDeviceCredentials({ homeDir })?.pendingRefreshRequestId).toBeUndefined();
  });

  it.each([408, 425, 429])(
    'keeps the pending refresh journal after transient HTTP %s retries are exhausted',
    async status => {
      const homeDir = tempHome();
      writeDeviceCredentials({
        issuer: 'https://platform.example.test', accessToken: 'a1',
        accessExpiresAt: 1_800_000_000_000, refreshToken: 'r1', deviceExp: 1_900_000_000_000,
      }, { homeDir });
      const refresh = vi.fn(async () => {
        throw new DeviceProtocolError(
          'transient',
          'request_rejected',
          status,
          status === 429 ? 'bad_request' : 'device_revoked',
        );
      });
      const requestId = `00000000-0000-4000-8000-0000000000${status === 408 ? '08' : status === 425 ? '25' : '29'}`;
      await expect(refreshStoredDeviceCredentials({
        homeDir,
        requestIdFactory: () => requestId,
        sleep: async () => {},
        createClient: issuer => ({ issuer, refresh }),
      })).rejects.toMatchObject({ status });
      expect(refresh).toHaveBeenCalledTimes(3);
      expect(refresh.mock.calls.map(call => call[1].requestId))
        .toEqual([requestId, requestId, requestId]);
      expect(readDeviceCredentials({ homeDir })).toMatchObject({
        pendingRefreshRequestId: requestId,
      });
      expect(readDeviceCredentials({ homeDir })?.refreshRecoveryRequired).toBeUndefined();
    },
  );

  it('never sleeps past the 50s replay budget for a huge 429 Retry-After', async () => {
    const homeDir = tempHome();
    writeDeviceCredentials({
      issuer: 'https://platform.example.test', accessToken: 'a1',
      accessExpiresAt: 1_800_000_000_000, refreshToken: 'r1', deviceExp: 1_900_000_000_000,
    }, { homeDir });
    const fake = queuedTransport([
      { status: 429, body: {}, headers: { 'retry-after': '999999999999999999999' } },
    ]);
    const sleeps: number[] = [];
    const requestId = '00000000-0000-4000-8000-000000000030';
    await expect(refreshStoredDeviceCredentials({
      homeDir,
      requestIdFactory: () => requestId,
      sleep: async ms => { sleeps.push(ms); },
      createClient: issuer => new DeviceEnrollmentClient(issuer, { transport: fake.transport }),
    })).rejects.toMatchObject({ status: 429 });
    expect(sleeps).toEqual([]);
    expect(readDeviceCredentials({ homeDir })).toMatchObject({
      pendingRefreshRequestId: requestId,
    });
    expect(readDeviceCredentials({ homeDir })?.refreshRecoveryRequired).toBeUndefined();
  });

  it('blocks a 409 loser instead of replaying it past the server window', async () => {
    const homeDir = tempHome();
    writeDeviceCredentials({
      issuer: 'https://platform.example.test', accessToken: 'a1',
      accessExpiresAt: 1_800_000_000_000, refreshToken: 'r1', deviceExp: 1_900_000_000_000,
    }, { homeDir });
    const refresh = vi.fn(async () => {
      throw new DeviceProtocolError('conflict', 'request_rejected', 409, 'refresh_in_progress');
    });
    await expect(refreshStoredDeviceCredentials({
      homeDir,
      requestIdFactory: () => '00000000-0000-4000-8000-000000000005',
      sleep: async () => {},
      createClient: issuer => ({ issuer, refresh }),
    })).rejects.toThrow(/可能泄露/);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(readDeviceCredentials({ homeDir })).toMatchObject({ refreshRecoveryRequired: true });
  });

  it('caps foreign-journal recursion instead of ping-ponging forever', async () => {
    const homeDir = tempHome();
    const now = 1_800_000_000_000;
    writeDeviceCredentials({
      issuer: 'https://platform.example.test', accessToken: 'a1',
      accessExpiresAt: now + 600_000, refreshToken: 'r1', deviceExp: 1_900_000_000_000,
    }, { homeDir, now: () => new Date(now) });
    let requestSeq = 0;
    const refresh = vi.fn(async () => {
      // After each 409, a "foreign" process journals a different key so the
      // reread path keeps following foreign journals rather than blocking.
      const foreignId = `00000000-0000-4000-8000-0000000000f${requestSeq}`;
      requestSeq += 1;
      const current = readDeviceCredentials({ homeDir });
      if (current) {
        writeDeviceCredentials({
          issuer: current.issuer,
          accessToken: current.accessToken,
          accessExpiresAt: current.accessExpiresAt,
          refreshToken: current.refreshToken,
          deviceExp: current.deviceExp,
          pendingRefreshRequestId: foreignId,
          pendingRefreshStartedAt: now,
        }, { homeDir, now: () => new Date(now) });
      }
      throw new DeviceProtocolError('conflict', 'request_rejected', 409, 'refresh_in_progress');
    });
    await expect(refreshStoredDeviceCredentials({
      homeDir,
      now: () => new Date(now),
      requestIdFactory: () => `00000000-0000-4000-8000-0000000000a${requestSeq}`,
      sleep: async () => {},
      createClient: issuer => ({ issuer, refresh }),
    })).rejects.toThrow(/journal 切换超过/);
    // Initial attempt + 2 foreign-journal hops (depth 0,1,2) then stop.
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(3);
    expect(readDeviceCredentials({ homeDir })).toMatchObject({ refreshRecoveryRequired: true });
  });

  it('does not send a pending refresh after the safe replay window', async () => {
    const homeDir = tempHome();
    const now = 1_800_000_100_000;
    writeDeviceCredentials({
      issuer: 'https://platform.example.test', accessToken: 'a1',
      accessExpiresAt: 1_800_000_200_000, refreshToken: 'r1', deviceExp: 1_900_000_000_000,
      pendingRefreshRequestId: '00000000-0000-4000-8000-000000000006',
      pendingRefreshStartedAt: now - 51_000,
    }, { homeDir, now: () => new Date(now - 51_000) });
    const refresh = vi.fn();
    await expect(refreshStoredDeviceCredentials({
      homeDir,
      now: () => new Date(now),
      createClient: issuer => ({ issuer, refresh }),
    })).rejects.toThrow(/安全恢复窗口/);
    expect(refresh).not.toHaveBeenCalled();
    expect(readDeviceCredentials({ homeDir })).toMatchObject({ refreshRecoveryRequired: true });
  });

  it('clears locally revoked credentials from an allow-listed server error', async () => {
    const homeDir = tempHome();
    writeDeviceCredentials({
      issuer: 'https://platform.example.test', accessToken: 'a1',
      accessExpiresAt: 1_800_000_000_000, refreshToken: 'r1', deviceExp: 1_900_000_000_000,
    }, { homeDir });
    const fake = queuedTransport([{ status: 401, body: { error: 'device_revoked', detail: 'secret' } }]);
    await expect(refreshStoredDeviceCredentials({
      homeDir,
      sleep: async () => {},
      createClient: issuer => new DeviceEnrollmentClient(issuer, { transport: fake.transport }),
    })).rejects.toThrow(/HTTP 401/);
    expect(readDeviceCredentials({ homeDir })).toBeNull();
  });

  it('journals an enroll grant and resumes the exact poll secret after a crash', async () => {
    const homeDir = tempHome();
    expect(deviceEnrollmentJournalPath({ homeDir })).toBe(
      join(homeDir, '.botmux', 'device-auth', 'device-enroll-pending.json'),
    );
    const grant = {
      grantId: 'grant-resume', pollSecret: 'poll-secret-resume',
      expiresAt: 1_900_000_000_000, pollIntervalMs: 2_000,
    };
    const first = {
      issuer: 'https://platform.example.test',
      beginEnrollment: vi.fn(async () => grant),
      waitForEnrollment: vi.fn(async () => {
        throw new DeviceProtocolError('network', 'network_error');
      }),
    };
    await expect(enrollStoredDeviceCredentials({
      homeDir, client: first, machineToken: 'machine', deviceName: 'Work Mac',
    })).rejects.toThrow(/network/);

    const second = {
      issuer: first.issuer,
      beginEnrollment: vi.fn(),
      waitForEnrollment: vi.fn(async () => ({
        accessToken: 'a1', accessExpiresAt: 1_800_000_000_000,
        refreshToken: 'r1', deviceExp: 1_900_000_000_000,
      })),
    };
    const stored = await enrollStoredDeviceCredentials({
      homeDir, client: second, machineToken: 'machine', deviceName: 'Ignored New Name',
    });
    expect(second.beginEnrollment).not.toHaveBeenCalled();
    expect(second.waitForEnrollment.mock.calls[0][0]).toMatchObject(grant);
    expect(stored.refreshToken).toBe('r1');
    expect(existsSync(deviceEnrollmentJournalPath({ homeDir }))).toBe(false);
    expect(await clearStoredDeviceCredentials({ homeDir })).toBe(true);
  });

  it('treats 200 denied/expired poll states as terminal enrollment outcomes', async () => {
    const denied = queuedTransport([{ status: 200, body: { status: 'denied' } }]);
    const client = new DeviceEnrollmentClient('https://platform.example.test', {
      transport: denied.transport,
      now: () => 1_800_000_000_000,
    });
    await expect(client.waitForEnrollment({
      grantId: 'g', pollSecret: 'p', expiresAt: 1_800_000_010_000,
    })).rejects.toMatchObject({ code: 'enrollment_denied' });

    const expired = queuedTransport([{ status: 200, body: { status: 'expired' } }]);
    const expiredClient = new DeviceEnrollmentClient('https://platform.example.test', {
      transport: expired.transport,
      now: () => 1_800_000_000_000,
    });
    await expect(expiredClient.waitForEnrollment({
      grantId: 'g', pollSecret: 'p', expiresAt: 1_800_000_010_000,
    })).rejects.toMatchObject({ code: 'enrollment_expired' });
  });
});
