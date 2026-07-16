import { describe, expect, it, vi } from 'vitest';

import {
  V3RunCancelDaemonError,
  formatV3RunCancelCliSuccess,
  parseV3RunCancelCliOptions,
  postV3RunCancel,
} from '../src/cli/v3-run-cancel.js';
import { signWorkflowDaemonIpcResponse } from '../src/workflows/v3/daemon-ipc-auth.js';

const daemon = {
  larkAppId: 'cli_owner',
  ipcPort: 12_345,
  bootInstanceId: 'b'.repeat(43),
  workflowIpcProtocol: 'v1',
};
const secret = 'workflow-ipc-test-secret';
const timestamp = '1700000000123';
const nonce = 'n'.repeat(43);

function signedResponse(bodyRaw: string, status: number, runId = 'run.a'): Response {
  const pathWithQuery = `/__workflow-ipc/v1/runs/${encodeURIComponent(runId)}/cancel`;
  return new Response(bodyRaw, {
    status,
    headers: {
      'X-Botmux-Workflow-Ipc-Response-Signature': signWorkflowDaemonIpcResponse({
        secret,
        requestNonce: nonce,
        method: 'POST',
        pathWithQuery,
        status,
        body: bodyRaw,
        target: daemon,
      }),
    },
  });
}

describe('v3 workflow cancel CLI transport', () => {
  it('strictly parses only reason/bot flags and rejects flag confusion or extras', () => {
    expect(parseV3RunCancelCliOptions([
      '--reason', 'stop now', '--bot=cli_owner',
    ])).toEqual({ ok: true, reason: 'stop now', larkAppId: 'cli_owner' });
    expect(parseV3RunCancelCliOptions(['--reason', '--bot', 'cli_owner']))
      .toEqual({ ok: false, error: '--reason 需要非空值' });
    expect(parseV3RunCancelCliOptions(['--reason=a', '--reason=b']))
      .toEqual({ ok: false, error: '参数重复：--reason' });
    expect(parseV3RunCancelCliOptions(['surprise']))
      .toEqual({ ok: false, error: '未知或多余参数：surprise' });
  });

  it('POSTs the encoded run to the owning daemon with the optional reason', async () => {
    const responseBody = JSON.stringify({
      ok: true,
      runId: 'run.a',
      status: 'cancelling',
      cancelRequestId: 'cancel-1',
      alreadyRequested: false,
    });
    const fetchImpl = vi.fn().mockResolvedValue(signedResponse(responseBody, 202));

    await expect(postV3RunCancel({
      daemon,
      runId: 'run.a',
      reason: 'stop now',
      secret,
      timestamp,
      nonce,
      fetchImpl,
    })).resolves.toMatchObject({ status: 'cancelling', cancelRequestId: 'cancel-1' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/__workflow-ipc/v1/runs/run.a/cancel',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reason: 'stop now' }),
        headers: expect.objectContaining({
          'X-Botmux-Workflow-Ipc-Ts': timestamp,
          'X-Botmux-Workflow-Ipc-Nonce': nonce,
          'X-Botmux-Workflow-Ipc-Signature': expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        }),
      }),
    );
    const headers = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(Object.keys(headers).some((key) => key.toLowerCase().startsWith('x-botmux-cli-'))).toBe(false);
  });

  it('fails loudly on daemon rejection or malformed success instead of claiming cancellation', async () => {
    await expect(postV3RunCancel({
      daemon: { ...daemon, ipcPort: 1 },
      runId: 'r',
      secret,
      timestamp,
      nonce,
      fetchImpl: vi.fn().mockResolvedValue(new Response('{"error":"wrong_daemon"}', {
        status: 409,
        headers: {
          'X-Botmux-Workflow-Ipc-Response-Signature': signWorkflowDaemonIpcResponse({
            secret,
            requestNonce: nonce,
            method: 'POST',
            pathWithQuery: '/__workflow-ipc/v1/runs/r/cancel',
            status: 409,
            body: '{"error":"wrong_daemon"}',
            target: { ...daemon, ipcPort: 1 },
          }),
        },
      })),
    })).rejects.toBeInstanceOf(V3RunCancelDaemonError);

    await expect(postV3RunCancel({
      daemon: { ...daemon, ipcPort: 1 },
      runId: 'r',
      secret,
      timestamp,
      nonce,
      fetchImpl: vi.fn().mockResolvedValue(new Response('{}', {
        status: 200,
        headers: {
          'X-Botmux-Workflow-Ipc-Response-Signature': signWorkflowDaemonIpcResponse({
            secret,
            requestNonce: nonce,
            method: 'POST',
            pathWithQuery: '/__workflow-ipc/v1/runs/r/cancel',
            status: 200,
            body: '{}',
            target: { ...daemon, ipcPort: 1 },
          }),
        },
      })),
    })).rejects.toThrow(/无效的成功响应/);
  });

  it('distinguishes durable acceptance, idempotent replay, and pre-existing terminal state', () => {
    expect(formatV3RunCancelCliSuccess({
      ok: true, runId: 'r', status: 'cancelling', cancelRequestId: 'c1',
    })).toContain('取消请求已持久化');
    expect(formatV3RunCancelCliSuccess({
      ok: true, runId: 'r', status: 'cancelling', cancelRequestId: 'c1', alreadyRequested: true,
    })).toContain('取消请求已存在');
    expect(formatV3RunCancelCliSuccess({
      ok: true, runId: 'r', status: 'succeeded', alreadyTerminal: true,
    })).toContain('未写入取消请求');
    expect(formatV3RunCancelCliSuccess({
      ok: true, runId: 'r', status: 'cancelled', alreadyTerminal: true,
    })).toContain('已取消');
  });
});
