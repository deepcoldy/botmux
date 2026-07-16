import { describe, expect, it, vi } from 'vitest';

import {
  signWorkflowDaemonIpcResponse,
  workflowDaemonIpcHeaders,
} from '../src/workflows/v3/daemon-ipc-auth.js';
import {
  WorkflowDaemonMutationTransportError,
  postWorkflowDaemonMutation,
  workflowDaemonMutationPath,
  workflowDaemonMutationTarget,
} from '../src/workflows/v3/daemon-ipc-client.js';

const SECRET = 'workflow-ipc-test-secret';
const TIMESTAMP = '1700000000123';
const NONCE = 'n'.repeat(43);
const DAEMON = {
  larkAppId: 'cli_test',
  ipcPort: 32_123,
  bootInstanceId: 'b'.repeat(43),
  workflowIpcProtocol: 'v1',
};

function signedResponse(input: {
  bodyRaw: string;
  status: number;
  pathWithQuery: string;
  nonce?: string;
}): Response {
  const requestNonce = input.nonce ?? NONCE;
  return new Response(input.bodyRaw, {
    status: input.status,
    headers: {
      'X-Botmux-Workflow-Ipc-Response-Signature': signWorkflowDaemonIpcResponse({
        secret: SECRET,
        requestNonce,
        method: 'POST',
        pathWithQuery: input.pathWithQuery,
        status: input.status,
        body: input.bodyRaw,
        target: DAEMON,
      }),
    },
  });
}

describe('Workflow daemon mutation client', () => {
  it('serializes once and sends the exact signed body/path/target headers', async () => {
    const path = '/__workflow-ipc/v1/runs/run%20%2F%20%E6%B5%81%E7%A8%8B/cancel';
    const fetchImpl = vi.fn().mockResolvedValue(signedResponse({
      bodyRaw: '{"ok":true}',
      status: 202,
      pathWithQuery: path,
    }));
    const body = { reason: '停止一下🚦' };
    const result = await postWorkflowDaemonMutation({
      daemon: DAEMON,
      runId: 'run / 流程',
      mutation: 'cancel',
      body,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
      fetchImpl,
    });

    const bodyRaw = JSON.stringify(body);
    const expectedAuth = workflowDaemonIpcHeaders({
      secret: SECRET,
      method: 'POST',
      pathWithQuery: path,
      bodyRaw,
      target: DAEMON,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    expect(result).toEqual({ ok: true, status: 202, bodyRaw: '{"ok":true}' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://127.0.0.1:${DAEMON.ipcPort}${path}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...expectedAuth },
        body: bodyRaw,
      },
    );
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).some((key) => key.toLowerCase().startsWith('x-botmux-cli-'))).toBe(false);
  });

  it('encodes the run id as one path segment', () => {
    expect(workflowDaemonMutationPath('a/b ?#中文', 'retry'))
      .toBe('/__workflow-ipc/v1/runs/a%2Fb%20%3F%23%E4%B8%AD%E6%96%87/retry');
  });

  it('fails closed before fetch when the descriptor lacks a boot instance', async () => {
    const fetchImpl = vi.fn();
    expect(() => workflowDaemonMutationTarget({
      larkAppId: 'cli_test',
      ipcPort: 32_123,
      workflowIpcProtocol: 'v1',
    })).toThrow(WorkflowDaemonMutationTransportError);
    await expect(postWorkflowDaemonMutation({
      daemon: { larkAppId: 'cli_test', ipcPort: 32_123, workflowIpcProtocol: 'v1' },
      runId: 'r',
      mutation: 'start',
      secret: SECRET,
      fetchImpl,
    })).rejects.toThrow(/Workflow IPC v1/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an old descriptor and an unauthenticated or tampered daemon response', async () => {
    const fetchImpl = vi.fn();
    await expect(postWorkflowDaemonMutation({
      daemon: { ...DAEMON, workflowIpcProtocol: undefined },
      runId: 'r',
      mutation: 'start',
      secret: SECRET,
      fetchImpl,
    })).rejects.toThrow(/Workflow IPC v1/);
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(postWorkflowDaemonMutation({
      daemon: DAEMON,
      runId: 'r',
      mutation: 'start',
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
      fetchImpl: vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 202 })),
    })).rejects.toThrow(/未通过 Workflow IPC v1 认证.*先重试一次/);

    const path = '/__workflow-ipc/v1/runs/r/start';
    const signed = signedResponse({ bodyRaw: '{"ok":true}', status: 202, pathWithQuery: path });
    await expect(postWorkflowDaemonMutation({
      daemon: DAEMON,
      runId: 'r',
      mutation: 'start',
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
      fetchImpl: vi.fn().mockResolvedValue(new Response('{"ok":false}', {
        status: signed.status,
        headers: signed.headers,
      })),
    })).rejects.toThrow(/未通过 Workflow IPC v1 认证.*先重试一次/);
  });

  it('does not transport-retry a failed mutation', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connection reset'));
    await expect(postWorkflowDaemonMutation({
      daemon: DAEMON,
      runId: 'r',
      mutation: 'grant',
      body: { loopId: 'loop' },
      secret: SECRET,
      fetchImpl,
    })).rejects.toBeInstanceOf(WorkflowDaemonMutationTransportError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never calls the legacy mutation path that an old daemon would execute裸', async () => {
    let legacyMutationExecuted = false;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/api/v3/runs/')) legacyMutationExecuted = true;
      return new Response('{"error":"not_found"}', { status: 404 });
    });
    await expect(postWorkflowDaemonMutation({
      daemon: DAEMON,
      runId: 'r',
      mutation: 'grant',
      body: { loopId: 'loop' },
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
      fetchImpl,
    })).rejects.toThrow(/未通过 Workflow IPC v1 认证/);
    expect(legacyMutationExecuted).toBe(false);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/__workflow-ipc/v1/runs/r/grant');
  });
});
