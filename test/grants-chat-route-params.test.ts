import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import {
  setLarkAppId,
  setIpcAuthSecret,
  setExactChatGrantHandler,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { cliAuthBind } from '../src/dashboard/auth.js';

const TEST_IPC_SECRET = 'test-ipc-secret-grants-chat';

function tokenAuthHeaders(port: number): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(8).toString('hex');
  const bind = cliAuthBind('POST', '/api/grants/chat', port);
  const sig = createHmac('sha256', TEST_IPC_SECRET)
    .update(`${ts}:${nonce}:${bind}`)
    .digest('base64url');
  return { 'X-Botmux-Cli-Ts': ts, 'X-Botmux-Cli-Nonce': nonce, 'X-Botmux-Cli-Auth': sig };
}

function post(port: number, bodyObj: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/grants/chat',
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tokenAuthHeaders(port) },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(Buffer.from(c)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) });
      });
    });
    req.once('error', reject);
    req.end(body);
  });
}

let handle: IpcServerHandle | null = null;
const RECEIVER = 'cli_receiver';
const baseBody = {
  operation: 'grant',
  receiverLarkAppId: RECEIVER,
  chatId: 'oc_chat',
  subjectOpenIds: ['ou_peer'],
};

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  setLarkAppId('');
  setIpcAuthSecret(null);
  setExactChatGrantHandler(null);
});

describe('POST /api/grants/chat quota/durationMs normalization', () => {
  it('forwards normalized numeric quota and duration to the handler', async () => {
    const handler = vi.fn(async () => ({
      ok: true as const, operation: 'grant' as const, permissionSource: 'chatGrant' as const,
      talkOnly: true as const, receiverLarkAppId: RECEIVER, chatId: 'oc_chat',
      grantsTalk: true, grantsOperate: false as const, subjects: [],
    }));
    setExactChatGrantHandler(handler);
    setLarkAppId(RECEIVER);
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    const res = await post(handle.port, { ...baseBody, quota: '5', durationMs: '3600000' });
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledWith({
      ...baseBody,
      quota: 5,
      durationMs: 3_600_000,
    });
  });

  it('keeps the CLI wire shape byte-identical when the fields are absent', async () => {
    const handler = vi.fn(async () => ({
      ok: true as const, operation: 'grant' as const, permissionSource: 'chatGrant' as const,
      talkOnly: true as const, receiverLarkAppId: RECEIVER, chatId: 'oc_chat',
      grantsTalk: true, grantsOperate: false as const, subjects: [],
    }));
    setExactChatGrantHandler(handler);
    setLarkAppId(RECEIVER);
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    const res = await post(handle.port, baseBody);
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(baseBody);
    expect(Object.keys(handler.mock.calls[0]![0] as object).sort()).toEqual([
      'chatId', 'operation', 'receiverLarkAppId', 'subjectOpenIds',
    ]);
  });

  it('omits the extras for unlimited quota / permanent duration / empty string', async () => {
    const handler = vi.fn(async () => ({
      ok: true as const, operation: 'grant' as const, permissionSource: 'chatGrant' as const,
      talkOnly: true as const, receiverLarkAppId: RECEIVER, chatId: 'oc_chat',
      grantsTalk: true, grantsOperate: false as const, subjects: [],
    }));
    setExactChatGrantHandler(handler);
    setLarkAppId(RECEIVER);
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    const unlimited = await post(handle.port, { ...baseBody, quota: 'unlimited', durationMs: 'permanent' });
    expect(unlimited.status).toBe(200);
    // Empty quota string is the card's "no quota limit" representation; the
    // duration select never sends '' (it has no empty option and '' normalizes
    // to invalid), so it is simply omitted here.
    const empty = await post(handle.port, { ...baseBody, quota: '' });
    expect(empty.status).toBe(200);
    expect(handler).toHaveBeenNthCalledWith(1, baseBody);
    expect(handler).toHaveBeenNthCalledWith(2, baseBody);
  });

  it('400 invalid_quota for non-numeric / out-of-range quota without invoking the service', async () => {
    const handler = vi.fn();
    setExactChatGrantHandler(handler as any);
    setLarkAppId(RECEIVER);
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    for (const quota of ['abc', '0', '1001', '1.5', '-3']) {
      const res = await post(handle.port, { ...baseBody, quota });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('invalid_quota');
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('400 invalid_duration for values outside the fixed option set', async () => {
    const handler = vi.fn();
    setExactChatGrantHandler(handler as any);
    setLarkAppId(RECEIVER);
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    for (const durationMs of ['abc', '123', '0', '7200000']) {
      const res = await post(handle.port, { ...baseBody, durationMs });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('invalid_duration');
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('forwards quota through the subjectLarkAppIds branch too', async () => {
    const handler = vi.fn(async () => ({
      ok: true as const, operation: 'grant' as const, permissionSource: 'chatGrant' as const,
      talkOnly: true as const, receiverLarkAppId: RECEIVER, chatId: 'oc_chat',
      grantsTalk: true, grantsOperate: false as const, subjects: [],
    }));
    setExactChatGrantHandler(handler);
    setLarkAppId(RECEIVER);
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    const res = await post(handle.port, {
      operation: 'grant',
      receiverLarkAppId: RECEIVER,
      chatId: 'oc_chat',
      subjectLarkAppIds: ['cli_pm'],
      quota: '10',
      durationMs: '86400000',
    });
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledWith({
      operation: 'grant',
      receiverLarkAppId: RECEIVER,
      chatId: 'oc_chat',
      subjectLarkAppIds: ['cli_pm'],
      quota: 10,
      durationMs: 86_400_000,
    });
  });
});
