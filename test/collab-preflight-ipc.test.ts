/**
 * collab.preflight IPC（§7.1）：消息体 parse、能力声明、客户端 fail-closed。
 */
import { describe, it, expect } from 'vitest';
import {
  parseCollabPreflightRequest,
  declaresDurableTurnOutputReceipt,
  declaresDurableTurnOutputReceiptForCli,
  COLLAB_IPC_ROUTE_PREFIX,
  COLLAB_IPC_DURABLE_TURN_OUTPUT_RECEIPT,
  preflightCollabPeer,
  collabPreflightPath,
} from '../src/core/collab-preflight-ipc.js';
import { signDispatchLaunchIpcResponse, DISPATCH_LAUNCH_IPC_HEADERS } from '../src/core/dispatch-launch-ipc-auth.js';

function validReq() {
  return {
    schemaVersion: 1 as const,
    initId: 'a'.repeat(64),
    sourceMessageId: 'om_src',
    configVersion: 'c'.repeat(64),
    targetLarkAppId: 'cli_peer',
  };
}

describe('parseCollabPreflightRequest', () => {
  it('合法请求通过', () => {
    const r = parseCollabPreflightRequest(JSON.stringify(validReq()));
    expect(r.ok).toBe(true);
  });

  it('非法 initId / schemaVersion / targetLarkAppId 拒绝', () => {
    expect(parseCollabPreflightRequest(JSON.stringify({ ...validReq(), initId: 'short' })).ok).toBe(false);
    expect(parseCollabPreflightRequest(JSON.stringify({ ...validReq(), schemaVersion: 2 })).ok).toBe(false);
    expect(parseCollabPreflightRequest(JSON.stringify({ ...validReq(), targetLarkAppId: '' })).ok).toBe(false);
  });

  it('非 canonical JSON（多余空白/字段重排）拒绝', () => {
    expect(parseCollabPreflightRequest(JSON.stringify({ ...validReq() }) + '\n').ok).toBe(false);
  });

  it('R5：parseCollabPreflightRequest("null") 不抛 TypeError，返回 bad_body', () => {
    expect(parseCollabPreflightRequest('null').ok).toBe(false);
    expect(parseCollabPreflightRequest('null').error).toBe('bad_body');
    expect(parseCollabPreflightRequest('[]').ok).toBe(false);
  });
});

describe('declaresDurableTurnOutputReceipt', () => {
  it('PTY 家族（缺省/pty）与 tmux 声明能力，其余不声明', () => {
    expect(declaresDurableTurnOutputReceipt(undefined)).toBe(true);
    expect(declaresDurableTurnOutputReceipt('pty')).toBe(true);
    expect(declaresDurableTurnOutputReceipt('tmux')).toBe(true);
    expect(declaresDurableTurnOutputReceipt('herdr')).toBe(false);
    expect(declaresDurableTurnOutputReceipt('zellij')).toBe(false);
    expect(declaresDurableTurnOutputReceipt('mojo')).toBe(false);
    expect(declaresDurableTurnOutputReceipt('riff')).toBe(false);
    expect(declaresDurableTurnOutputReceipt('remote-runner')).toBe(false);
  });
  it('远程 CLI 即使 backendType 缺省也按实际配对拒绝能力声明', () => {
    for (const cliId of ['riff', 'mojo', 'remote-runner']) {
      expect(declaresDurableTurnOutputReceiptForCli(cliId, undefined, undefined)).toBe(false);
    }
    expect(declaresDurableTurnOutputReceiptForCli('claude-code', undefined, 'tmux')).toBe(true);
  });
});

describe('preflightCollabPeer fail-closed', () => {
  it('peer 未声明 v1 → PEER_NOT_READY', async () => {
    const r = await preflightCollabPeer(
      { larkAppId: 'cli_peer', ipcPort: 1, bootInstanceId: 'x'.repeat(43), dispatchLaunchIpcProtocol: undefined } as any,
      validReq(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('PEER_NOT_READY');
  });

  it('fetch 抛错（离线）→ PEER_OFFLINE', async () => {
    const r = await preflightCollabPeer(
      { larkAppId: 'cli_peer', ipcPort: 1, bootInstanceId: 'x'.repeat(43), dispatchLaunchIpcProtocol: 'v1' } as any,
      validReq(),
      { secret: 's'.repeat(32), fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as any },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('PEER_OFFLINE');
  });

  it('peer 永不响应 → deadline abort 并返回 PEER_TIMEOUT', async () => {
    let signal: AbortSignal | null | undefined;
    const fakeFetch = ((_url: string, init: RequestInit) => {
      signal = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    const r = await preflightCollabPeer(
      { larkAppId: 'cli_peer', ipcPort: 1, bootInstanceId: 'x'.repeat(43), dispatchLaunchIpcProtocol: 'v1' } as any,
      validReq(),
      { secret: 's'.repeat(32), fetchImpl: fakeFetch, timeoutMs: 5 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('PEER_TIMEOUT');
    expect(signal?.aborted).toBe(true);
  });

  it('R5：protocolVersion 不兼容的已签名响应被拒（不补默认成功）', async () => {
    const secret = 's'.repeat(32);
    const target = { larkAppId: 'cli_peer', ipcPort: 12345, bootInstanceId: 'x'.repeat(43) };
    const nonce = 'n'.repeat(43);
    const pathWithQuery = collabPreflightPath(validReq().initId);
    const body = JSON.stringify({ ok: true, protocolVersion: 99, capabilities: [], workingDirAccepted: true });
    const signature = signDispatchLaunchIpcResponse({ secret, requestNonce: nonce, method: 'POST', pathWithQuery, status: 200, body, target });
    const fakeFetch = (async () => ({
      status: 200,
      headers: { get: (k: string) => (k === DISPATCH_LAUNCH_IPC_HEADERS.responseSignature ? signature : null) },
      text: async () => body,
    })) as any;
    const r = await preflightCollabPeer(
      { larkAppId: 'cli_peer', ipcPort: 12345, bootInstanceId: 'x'.repeat(43), dispatchLaunchIpcProtocol: 'v1' } as any,
      validReq(),
      { secret, nonce, fetchImpl: fakeFetch },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('PROTOCOL_VERSION_MISMATCH');
  });

  it('R5：workingDirAccepted=false 的已签名响应被拒', async () => {
    const secret = 's'.repeat(32);
    const target = { larkAppId: 'cli_peer', ipcPort: 12345, bootInstanceId: 'x'.repeat(43) };
    const nonce = 'n'.repeat(43);
    const pathWithQuery = collabPreflightPath(validReq().initId);
    const body = JSON.stringify({ ok: true, protocolVersion: 1, capabilities: [], workingDirAccepted: false });
    const signature = signDispatchLaunchIpcResponse({ secret, requestNonce: nonce, method: 'POST', pathWithQuery, status: 200, body, target });
    const fakeFetch = (async () => ({
      status: 200,
      headers: { get: (k: string) => (k === DISPATCH_LAUNCH_IPC_HEADERS.responseSignature ? signature : null) },
      text: async () => body,
    })) as any;
    const r = await preflightCollabPeer(
      { larkAppId: 'cli_peer', ipcPort: 12345, bootInstanceId: 'x'.repeat(43), dispatchLaunchIpcProtocol: 'v1' } as any,
      validReq(),
      { secret, nonce, fetchImpl: fakeFetch },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('WORKING_DIR_NOT_ACCEPTED');
  });
});

describe('route prefix', () => {
  it('COLLAB_IPC_ROUTE_PREFIX 与能力常量', () => {
    expect(COLLAB_IPC_ROUTE_PREFIX).toBe('/__collab-ipc/v1');
    expect(COLLAB_IPC_DURABLE_TURN_OUTPUT_RECEIPT).toBe('durable-turn-output-receipt-v1');
  });
});
