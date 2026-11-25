/**
 * collab.kickoff IPC（PR-3a §7.1）：parse + client fail-closed。
 */
import { describe, it, expect } from 'vitest';
import {
  parseCollabKickoffRequest,
  validateCollabKickoffPrepare,
  collabKickoffPath,
  requestCollabKickoff,
} from '../src/core/collab-kickoff-ipc.js';
import { collabKickoffId } from '../src/services/collab-group-config.js';
import { signDispatchLaunchIpcResponse, DISPATCH_LAUNCH_IPC_HEADERS } from '../src/core/dispatch-launch-ipc-auth.js';

function validPrepare() {
  return {
    schemaVersion: 1 as const,
    initId: 'a'.repeat(64),
    kickoffId: collabKickoffId('a'.repeat(64), 'cli_peer', 'cv'),
    sourceMessageId: 'om_src',
    configVersion: 'cv',
    targetLarkAppId: 'cli_peer',
    appId: 'cli_peer',
    prompt: 'hello',
  };
}

describe('parseCollabKickoffRequest', () => {
  it('合法 prepare 通过', () => {
    expect(parseCollabKickoffRequest(JSON.stringify(validPrepare())).ok).toBe(true);
  });

  it('非法 initId/kickoffId/configVersion 拒绝', () => {
    expect(parseCollabKickoffRequest(JSON.stringify({ ...validPrepare(), initId: 'short' })).ok).toBe(false);
    expect(parseCollabKickoffRequest(JSON.stringify({ ...validPrepare(), kickoffId: 'short' })).ok).toBe(false);
    expect(parseCollabKickoffRequest(JSON.stringify({ ...validPrepare(), configVersion: '' })).ok).toBe(false);
  });

  it('"null" 不抛 TypeError，返回 bad_body', () => {
    expect(parseCollabKickoffRequest('null').ok).toBe(false);
    expect(parseCollabKickoffRequest('[]').ok).toBe(false);
  });
});

describe('R1：validateCollabKickoffPrepare 类型校验', () => {
  const base = { schemaVersion: 1, initId: 'i'.repeat(64), kickoffId: 'k'.repeat(64), configVersion: 'cv', targetLarkAppId: 'cli_peer', appId: 'cli_peer', sourceMessageId: 'om_src', prompt: 'hello' };
  it('sourceMessageId 非 string → 拒绝', () => {
    expect(validateCollabKickoffPrepare({ ...base, sourceMessageId: 42 }).ok).toBe(false);
  });
  it('prompt 非 string → 拒绝', () => {
    expect(validateCollabKickoffPrepare({ ...base, prompt: null }).ok).toBe(false);
  });
  it('合法通过', () => {
    expect(validateCollabKickoffPrepare(base).ok).toBe(true);
  });
});

describe('collabKickoffId 稳定性', () => {
  it('含 configVersion：同 initId/appId 换 configVersion 产出不同 kickoffId', () => {
    const initId = 'i'.repeat(64);
    const appId = 'cli_peer';
    const k1 = collabKickoffId(initId, appId, 'v1');
    const k2 = collabKickoffId(initId, appId, 'v2');
    expect(k1).not.toBe(k2);
    expect(collabKickoffId(initId, appId, 'v1')).toBe(k1); // 同参数稳定
  });
});

describe('collabKickoffPath', () => {
  it('构造 prepare/start/query/cancel 路径', () => {
    const k = 'k'.repeat(64);
    expect(collabKickoffPath('i'.repeat(64), k, 'prepare')).toContain('/kickoff/');
    expect(collabKickoffPath('i'.repeat(64), k)).not.toContain('/prepare');
    expect(collabKickoffPath('i'.repeat(64), k, 'cancel')).toContain('/cancel');
  });
});

describe('requestCollabKickoff fail-closed', () => {
  it('peer 未声明 v1 → PEER_NOT_READY', async () => {
    const r = await requestCollabKickoff(
      { larkAppId: 'cli_peer', ipcPort: 1, bootInstanceId: 'x'.repeat(43), dispatchLaunchIpcProtocol: undefined } as any,
      'i'.repeat(64), 'k'.repeat(64), 'prepare', validPrepare(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('PEER_NOT_READY');
  });

  it('fetch 抛错（离线）→ PEER_OFFLINE', async () => {
    const r = await requestCollabKickoff(
      { larkAppId: 'cli_peer', ipcPort: 1, bootInstanceId: 'x'.repeat(43), dispatchLaunchIpcProtocol: 'v1' } as any,
      'i'.repeat(64), 'k'.repeat(64), 'prepare', validPrepare(),
      { secret: 's'.repeat(32), fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as any },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('PEER_OFFLINE');
  });

  it('响应头已到但 body 永不结束 → deadline 覆盖 body read', async () => {
    const fakeFetch = (async (_url: string, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
      },
    }), { status: 200 })) as typeof fetch;
    const r = await requestCollabKickoff(
      { larkAppId: 'cli_peer', ipcPort: 1, bootInstanceId: 'x'.repeat(43), dispatchLaunchIpcProtocol: 'v1' } as any,
      'i'.repeat(64), 'k'.repeat(64), 'prepare', validPrepare(),
      { secret: 's'.repeat(32), fetchImpl: fakeFetch, timeoutMs: 5 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('PEER_TIMEOUT');
  });

  it('F3：签名有效的 started 但 sessionId 空 → BAD_RESPONSE', async () => {
    const secret = 's'.repeat(32);
    const initId = 'i'.repeat(64);
    const kickoffId = 'k'.repeat(64);
    const target = { larkAppId: 'cli_peer', ipcPort: 12345, bootInstanceId: 'x'.repeat(43) };
    const nonce = 'n'.repeat(43);
    const pathWithQuery = collabKickoffPath(initId, kickoffId); // query = 无 action
    const body = JSON.stringify({
      ok: true,
      operation: {
        schemaVersion: 1, kickoffId, initId, sourceLarkAppId: 's', targetLarkAppId: 'cli_peer', appId: 'cli_peer',
        chatId: 'oc', configVersion: 'cv', payloadHash: 'h', state: 'started', sessionId: '', turnId: 't', acceptedAt: '2026-01-01T00:00:00Z',
        createdAt: 'x', updatedAt: 'x',
      },
    });
    const signature = signDispatchLaunchIpcResponse({ secret, requestNonce: nonce, method: 'GET', pathWithQuery, status: 200, body, target });
    const fakeFetch = (async () => ({
      status: 200,
      headers: { get: (k: string) => (k === DISPATCH_LAUNCH_IPC_HEADERS.responseSignature ? signature : null) },
      text: async () => body,
    })) as any;
    const r = await requestCollabKickoff(
      { larkAppId: 'cli_peer', ipcPort: 12345, bootInstanceId: 'x'.repeat(43), dispatchLaunchIpcProtocol: 'v1' } as any,
      initId, kickoffId, undefined, undefined,
      { secret, nonce, fetchImpl: fakeFetch },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('BAD_RESPONSE');
  });

  it('R2：签名有效但 targetLarkAppId/appId 改成不同 peer → BAD_RESPONSE', async () => {
    const secret = 's'.repeat(32);
    const initId = 'i'.repeat(64);
    const kickoffId = 'k'.repeat(64);
    const target = { larkAppId: 'cli_peer', ipcPort: 12345, bootInstanceId: 'x'.repeat(43) };
    const nonce = 'n'.repeat(43);
    const pathWithQuery = collabKickoffPath(initId, kickoffId);
    const body = JSON.stringify({
      ok: true,
      operation: {
        schemaVersion: 1, kickoffId, initId, sourceLarkAppId: 's', targetLarkAppId: 'cli_different_peer', appId: 'cli_different_peer',
        chatId: 'oc', configVersion: 'cv', payloadHash: 'h', state: 'prepared',
        createdAt: 'x', updatedAt: 'x',
      },
    });
    const signature = signDispatchLaunchIpcResponse({ secret, requestNonce: nonce, method: 'GET', pathWithQuery, status: 200, body, target });
    const fakeFetch = (async () => ({
      status: 200,
      headers: { get: (k: string) => (k === DISPATCH_LAUNCH_IPC_HEADERS.responseSignature ? signature : null) },
      text: async () => body,
    })) as any;
    const r = await requestCollabKickoff(
      { larkAppId: 'cli_peer', ipcPort: 12345, bootInstanceId: 'x'.repeat(43), dispatchLaunchIpcProtocol: 'v1' } as any,
      initId, kickoffId, undefined, undefined,
      { secret, nonce, fetchImpl: fakeFetch },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('BAD_RESPONSE');
  });

  it('R2：签名有效但三元组类型错（sessionId=42/turnId=对象/acceptedAt=bool）→ BAD_RESPONSE', async () => {
    const secret = 's'.repeat(32);
    const initId = 'i'.repeat(64);
    const kickoffId = 'k'.repeat(64);
    const target = { larkAppId: 'cli_peer', ipcPort: 12345, bootInstanceId: 'x'.repeat(43) };
    const nonce = 'n'.repeat(43);
    const pathWithQuery = collabKickoffPath(initId, kickoffId);
    const body = JSON.stringify({
      ok: true,
      operation: {
        schemaVersion: 1, kickoffId, initId, sourceLarkAppId: 's', targetLarkAppId: 'cli_peer', appId: 'cli_peer',
        chatId: 'oc', configVersion: 'cv', payloadHash: 'h', state: 'started', sessionId: 42, turnId: { x: 1 }, acceptedAt: true,
        createdAt: 'x', updatedAt: 'x',
      },
    });
    const signature = signDispatchLaunchIpcResponse({ secret, requestNonce: nonce, method: 'GET', pathWithQuery, status: 200, body, target });
    const fakeFetch = (async () => ({
      status: 200,
      headers: { get: (k: string) => (k === DISPATCH_LAUNCH_IPC_HEADERS.responseSignature ? signature : null) },
      text: async () => body,
    })) as any;
    const r = await requestCollabKickoff(
      { larkAppId: 'cli_peer', ipcPort: 12345, bootInstanceId: 'x'.repeat(43), dispatchLaunchIpcProtocol: 'v1' } as any,
      initId, kickoffId, undefined, undefined,
      { secret, nonce, fetchImpl: fakeFetch },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('BAD_RESPONSE');
  });
});
