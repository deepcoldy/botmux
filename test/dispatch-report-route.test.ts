import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import * as daemonIpc from '../src/core/daemon-ipc-auth.js';
import * as daemonDiscovery from '../src/utils/daemon-discovery.js';
import * as workerPool from '../src/core/worker-pool.js';

const CAPABILITY = 'cafebabe'.repeat(8);
const HOST_SECRET = 'dispatch-report-route-host-secret';
let handle: IpcServerHandle | null = null;
let dataDir = '';

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = '';
});

function sourceSession(overrides: Record<string, unknown> = {}) {
  return {
    session: {
      sessionId: 'session-source',
      rootMessageId: 'om_dispatch',
      currentReplyTarget: {
        rootMessageId: 'om_dispatch',
        turnId: 'om_kickoff',
        updatedAt: '2026-07-25T00:00:00.000Z',
      },
      replyThreadAliases: {},
      ...overrides,
    },
    chatId: 'oc_task',
    larkAppId: 'cli_source',
    managedTurnOrigin: {
      capability: CAPABILITY,
      turnId: 'om_kickoff',
    },
  } as any;
}

async function setup() {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-dispatch-report-route-'));
  vi.stubEnv('SESSION_DATA_DIR', dataDir);
  writeFileSync(join(dataDir, 'orchestrate-dispatch.json'), JSON.stringify({
    om_dispatch: {
      orchAppId: 'cli_orchestrator',
      orchSessionId: 'session-orchestrator',
      orchChatId: 'oc_source',
      orchRoot: 'om_source',
      targetAppIds: ['cli_source'],
      targetChatId: 'oc_task',
      title: 'Workboard run run_1 dispatch rds_1',
    },
  }));
  setIpcAuthSecret(HOST_SECRET);
  handle = await startIpcServer({
    port: 0,
    host: '127.0.0.1',
    authRequired: true,
  });
  vi.spyOn(daemonDiscovery, 'findOnlineDaemon').mockReturnValue({
    larkAppId: 'cli_orchestrator',
    ipcPort: 43210,
  });
}

async function postReport(input: {
  capability?: string;
  signed?: boolean;
  dispatchRoot?: string;
} = {}) {
  const path = '/api/sessions/session-source/report';
  const body = {
    dispatchRoot: input.dispatchRoot ?? 'om_dispatch',
    content: '[MOSA_WORKBOARD_OUTCOME:review_ready]\n\nTask complete.',
    ...(input.capability === undefined
      ? { originCapability: CAPABILITY, originTurnId: 'om_kickoff' }
      : input.capability
        ? { originCapability: input.capability, originTurnId: 'om_kickoff' }
        : {}),
  };
  const headers = input.signed
    ? daemonIpcAuthHeaders({
        secret: HOST_SECRET,
        port: handle!.port,
        method: 'POST',
        path,
        headers: { 'content-type': 'application/json' },
      })
    : { 'content-type': 'application/json' };
  return fetch(`http://127.0.0.1:${handle!.port}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /api/sessions/:sessionId/report', () => {
  it('accepts the live session capability and proxies a host-authenticated trigger', async () => {
    await setup();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(sourceSession());
    const proxy = vi.spyOn(daemonIpc, 'fetchDaemonIpc').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, triggerId: 'trigger-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await postReport();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      delivery: 'orchestrator-session',
      reportedTo: 'session-orchestrator',
      viaRegistry: true,
      triggerId: 'trigger-1',
    });
    expect(proxy).toHaveBeenCalledOnce();
    const [port, path, init] = proxy.mock.calls[0];
    expect(port).toBe(43210);
    expect(path).toBe('/api/trigger');
    const forwarded = JSON.parse(String(init?.body));
    expect(forwarded.target).toEqual({
      kind: 'turn',
      botId: 'cli_orchestrator',
      sessionId: 'session-orchestrator',
    });
    expect(forwarded.envelope).toMatchObject({
      format: 'botmux-report/v1',
      trusted: false,
      payload: {
        dispatchRoot: 'om_dispatch',
        sourceSessionId: 'session-source',
        sourceBotAppId: 'cli_source',
      },
    });
  });

  it('accepts trusted-host HMAC without a capability', async () => {
    await setup();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(sourceSession());
    vi.spyOn(daemonIpc, 'fetchDaemonIpc').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, triggerId: 'trigger-host' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await postReport({ capability: '', signed: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      triggerId: 'trigger-host',
    });
  });

  it('rejects a stale capability before reading or forwarding the report', async () => {
    await setup();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(sourceSession());
    const proxy = vi.spyOn(daemonIpc, 'fetchDaemonIpc');

    const response = await postReport({ capability: 'f00d'.repeat(16) });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'origin_unproven',
    });
    expect(proxy).not.toHaveBeenCalled();
  });

  it('rejects a dispatch root that is not bound to the authenticated session', async () => {
    await setup();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(sourceSession());
    const proxy = vi.spyOn(daemonIpc, 'fetchDaemonIpc');

    const response = await postReport({ dispatchRoot: 'om_other' });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'dispatch_binding_mismatch',
    });
    expect(proxy).not.toHaveBeenCalled();
  });
});
