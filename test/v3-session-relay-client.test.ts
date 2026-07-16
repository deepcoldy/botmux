import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  managedOriginCapabilityPath,
  RELAY_ORIGIN_CAPABILITY_BASENAME,
} from '../src/core/managed-origin-capability.js';
import { WorkflowDaemonMutationTransportError } from '../src/workflows/v3/daemon-ipc-client.js';
import {
  postWorkflowSessionRunMutation,
  readWorkflowSessionRelayContext,
  type WorkflowSessionRelayContext,
} from '../src/workflows/v3/session-relay-client.js';

const CAPABILITY = 'c'.repeat(64);

describe('readWorkflowSessionRelayContext', () => {
  let root: string;
  let dataDir: string;
  let relayDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'v3-relay-client-'));
    dataDir = join(root, 'data');
    relayDir = join(root, 'outbox');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(relayDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns null without a session id or without a capability file (host session)', () => {
    expect(readWorkflowSessionRelayContext({ env: {}, dataDir })).toBeNull();
    expect(readWorkflowSessionRelayContext({
      env: { BOTMUX_SESSION_ID: 'sess-1' },
      dataDir,
    })).toBeNull();
    expect(readWorkflowSessionRelayContext({
      env: { BOTMUX_SESSION_ID: 'sess-1', BOTMUX_SEND_RELAY: relayDir },
      dataDir,
    })).toBeNull();
  });

  it('detects a Linux sandbox session via the relay outbox capability file', () => {
    writeFileSync(
      join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME),
      JSON.stringify({ token: CAPABILITY }),
    );
    const context = readWorkflowSessionRelayContext({
      env: {
        BOTMUX_SESSION_ID: 'sess-1',
        BOTMUX_SEND_RELAY: relayDir,
        BOTMUX_LARK_APP_ID: 'cli_owner',
        BOTMUX_DAEMON_IPC_PORT: '4310',
      },
      dataDir,
    });
    expect(context).toEqual({
      sessionId: 'sess-1',
      capability: CAPABILITY,
      larkAppId: 'cli_owner',
      ipcPortFallback: 4310,
    });
  });

  it('prefers a visible live process marker over a leftover capability file', () => {
    // A capability file can survive SIGKILL or disabling isolation. A healthy
    // host session (whose live marker is visible) must keep the strictly
    // stronger marker + signed-envelope path instead of being hijacked onto
    // the relay with a stale token.
    const carveOut = managedOriginCapabilityPath(dataDir, 'sess-1');
    mkdirSync(dirname(carveOut), { recursive: true });
    writeFileSync(carveOut, JSON.stringify({ sessionId: 'sess-1', capability: CAPABILITY }));
    expect(readWorkflowSessionRelayContext({
      env: { BOTMUX_SESSION_ID: 'sess-1' },
      dataDir,
      findMarker: () => ({ sessionId: 'sess-1', turnId: 'turn-1' }),
    })).toBeNull();
    // A corrupt marker ({sessionId: ''}) does not count as live — same
    // precedence as resolveSessionContext.
    expect(readWorkflowSessionRelayContext({
      env: { BOTMUX_SESSION_ID: 'sess-1' },
      dataDir,
      findMarker: () => ({ sessionId: '' }),
    })).not.toBeNull();
  });

  it('detects a macOS read-isolated session via the per-session carve-out file', () => {
    const carveOut = managedOriginCapabilityPath(dataDir, 'sess-1');
    mkdirSync(dirname(carveOut), { recursive: true });
    writeFileSync(carveOut, JSON.stringify({
      sessionId: 'sess-1',
      capability: CAPABILITY,
      turnId: 'turn-7',
      dispatchAttempt: 2,
    }));
    const context = readWorkflowSessionRelayContext({
      env: { BOTMUX_SESSION_ID: 'sess-1' },
      dataDir,
    });
    expect(context).toEqual({
      sessionId: 'sess-1',
      capability: CAPABILITY,
      turnId: 'turn-7',
      dispatchAttempt: 2,
    });
  });

  it('ignores an unusable port marker instead of inventing one', () => {
    writeFileSync(
      join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME),
      JSON.stringify({ token: CAPABILITY }),
    );
    for (const bad of ['abc', '0', '-4310', '4310.5']) {
      const context = readWorkflowSessionRelayContext({
        env: {
          BOTMUX_SESSION_ID: 'sess-1',
          BOTMUX_SEND_RELAY: relayDir,
          BOTMUX_DAEMON_IPC_PORT: bad,
        },
        dataDir,
      });
      expect(context?.ipcPortFallback, bad).toBeUndefined();
    }
  });
});

describe('postWorkflowSessionRunMutation', () => {
  const context: WorkflowSessionRelayContext = {
    sessionId: 'sess-1',
    capability: CAPABILITY,
    turnId: 'turn-7',
    dispatchAttempt: 2,
    larkAppId: 'cli_owner',
    ipcPortFallback: 4310,
  };

  function fetchOk(body: unknown = { ok: true }, status = 200) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status }));
  }

  it('POSTs the relay route with the session claim merged into the payload', async () => {
    const fetchImpl = fetchOk();
    const response = await postWorkflowSessionRunMutation({
      context,
      runId: 'run-1',
      mutation: 'cancel',
      body: { reason: 'stop' },
      resolveIpcPort: () => 4999,
      fetchImpl,
    });
    expect(response).toEqual({ ok: true, status: 200, bodyRaw: JSON.stringify({ ok: true }) });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4999/api/v3/session-runs/run-1/cancel');
    expect(JSON.parse(String(init.body))).toEqual({
      reason: 'stop',
      sessionId: 'sess-1',
      originCapability: CAPABILITY,
      originTurnId: 'turn-7',
      originDispatchAttempt: 2,
    });
  });

  it('omits absent turn fields and encodes the runId', async () => {
    const fetchImpl = fetchOk();
    await postWorkflowSessionRunMutation({
      context: { sessionId: 'sess-1', capability: CAPABILITY, ipcPortFallback: 4310 },
      runId: 'run/../1',
      mutation: 'start',
      fetchImpl,
    });
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4310/api/v3/session-runs/run%2F..%2F1/start');
    expect(JSON.parse(String(init.body))).toEqual({
      sessionId: 'sess-1',
      originCapability: CAPABILITY,
    });
  });

  it('prefers discovery, falls back to the env port marker, then fails closed', async () => {
    const fetchImpl = fetchOk();
    const resolveIpcPort = vi.fn(() => undefined);
    await postWorkflowSessionRunMutation({
      context,
      runId: 'run-1',
      mutation: 'start',
      resolveIpcPort,
      fetchImpl,
    });
    expect(resolveIpcPort).toHaveBeenCalledWith('cli_owner');
    expect(String(fetchImpl.mock.calls[0]![0])).toContain(':4310/');

    await expect(postWorkflowSessionRunMutation({
      context: { sessionId: 'sess-1', capability: CAPABILITY },
      runId: 'run-1',
      mutation: 'start',
      fetchImpl,
    })).rejects.toBeInstanceOf(WorkflowDaemonMutationTransportError);
  });

  it('passes non-ok statuses through and wraps connection failures', async () => {
    const denied = await postWorkflowSessionRunMutation({
      context,
      runId: 'run-1',
      mutation: 'start',
      fetchImpl: fetchOk({ ok: false, error: 'origin_unproven' }, 403),
    });
    expect(denied).toEqual({
      ok: false,
      status: 403,
      bodyRaw: JSON.stringify({ ok: false, error: 'origin_unproven' }),
    });

    await expect(postWorkflowSessionRunMutation({
      context,
      runId: 'run-1',
      mutation: 'start',
      fetchImpl: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
    })).rejects.toBeInstanceOf(WorkflowDaemonMutationTransportError);
  });
});
