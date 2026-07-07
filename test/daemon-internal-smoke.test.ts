/**
 * End-to-end smoke for `/__daemon/*` over loopback:
 *   - spins a real `http.createServer` wired with `createDaemonInternalApi`,
 *   - hits it via the real `createDaemonClient`,
 *   - asserts GET sessions-list returns 200 and settings-write returns
 *     403 owner_only when ownerUnionId is missing.
 *
 * This is the codex-required "tsx smoke" for C8: it exercises the full HTTP
 * envelope (verify → bodyRaw → dispatch → handler → render) with a real
 * signed request, while staying in-process so no real dashboard / daemon
 * needs to be started.
 */

import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDaemonInternalApi, type DaemonInternalApiDeps } from '../src/dashboard/daemon-internal-api.js';
import { createDaemonClient, type DaemonClient } from '../src/dashboard/daemon-internal-client.js';

const SECRET = 'smoke-secret-string';

function makeStubDeps(): DaemonInternalApiDeps {
  return {
    secret: SECRET,
    getSessions: () => [{ sessionId: 's-smoke', status: 'idle' }],
    getSchedules: () => [],
    resolveDashboardSettings: () => ({
      publicReadOnly: false,
      openTerminalInFeishu: false,
      vcMeetingAgent: { enabled: true },
      maintenance: {},
      localDevInstall: false,
    }),
    buildGroupsMatrix: async () => ({ chats: [], bots: [] }),
    settingsApplierDeps: {
      readGlobalConfig: () => ({}),
      mergeDashboardConfig: (p: any) => p,
      mergeMaintenanceConfig: (p: any) => p,
      parseMaintenancePatch: (b: any) => ({ ok: true, patch: b ?? {} }),
      isLocalDevInstall: () => false,
      resolveDashboardSettings: () => ({
        publicReadOnly: false,
        openTerminalInFeishu: false,
        vcMeetingAgent: { enabled: true },
        maintenance: {},
        localDevInstall: false,
      }),
    },
    groupsActionDeps: {
      registryList: () => [],
      registryGetByAppId: () => undefined,
      proxyToDaemon: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      closeSessionsMatching: async () => [],
    },
    workflowsActionDeps: {
      runsDir: '/tmp/smoke-runs',
      proxyToDaemon: async () => new Response('{}', { status: 200 }),
      listRuns: async () => [],
      readRunSnapshot: async () => null,
      scrubSnapshotForUnauthed: (s: any) => s,
      TERMINAL_RUN_STATUSES: new Set(['succeeded', 'failed', 'cancelled']),
      isValidRunId: () => true,
    } as any,
    proxyToDaemon: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ownerOf: () => undefined,
    scheduleOwnerOf: () => undefined,
    // No owner candidates → all settings-write requests should be 403.
    settingsOwnerDeps: {
      resolveOwnerCandidates: async () => [],
    },
  };
}

describe('Route B end-to-end smoke', () => {
  let server: Server;
  let baseUrl: string;
  let client: DaemonClient;

  beforeEach(async () => {
    const api = createDaemonInternalApi(makeStubDeps());
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`);
      const handled = await api.handle(req, res, url);
      if (!handled) {
        res.writeHead(404).end('{}');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
    client = createDaemonClient({
      dashboardUrl: baseUrl,
      appId: 'cli_smoke',
      secret: SECRET,
      retries: 0,
      timeoutMs: 5_000,
    });
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('GET /__daemon/sessions-list → 200 with stub session row (full HMAC envelope)', async () => {
    const r = await client.request({ method: 'GET', path: '/__daemon/sessions-list' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sessions: [{ sessionId: 's-smoke', status: 'idle' }] });
  });

  it('PUT /__daemon/settings-write without ownerUnionId → 403 owner_only', async () => {
    const r = await client.request({
      method: 'PUT',
      path: '/__daemon/settings-write',
      body: { patch: { publicReadOnly: true } },
    });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ ok: false, error: 'owner_only' });
  });

  it('PUT /__daemon/settings-write with bogus on_ ownerUnionId → 403 owner_only', async () => {
    const r = await client.request({
      method: 'PUT',
      path: '/__daemon/settings-write',
      body: { patch: { publicReadOnly: true }, ownerUnionId: 'on_not_authorized' },
    });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ ok: false, error: 'owner_only' });
  });

  it('Unknown /__daemon/* path → 404 unknown_endpoint (does not leak allowlist)', async () => {
    const r = await client.request({ method: 'GET', path: '/__daemon/secrets' });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ ok: false, error: 'unknown_endpoint' });
  });
});
