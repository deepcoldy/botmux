/**
 * collab.preflight IPC（§7.1）：消息体 parse、能力声明、客户端 fail-closed。
 */
import { describe, it, expect } from 'vitest';
import {
  parseCollabPreflightRequest,
  declaresDurableTurnOutputReceipt,
  COLLAB_IPC_ROUTE_PREFIX,
  COLLAB_IPC_DURABLE_TURN_OUTPUT_RECEIPT,
  preflightCollabPeer,
} from '../src/core/collab-preflight-ipc.js';

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
});

describe('route prefix', () => {
  it('COLLAB_IPC_ROUTE_PREFIX 与能力常量', () => {
    expect(COLLAB_IPC_ROUTE_PREFIX).toBe('/__collab-ipc/v1');
    expect(COLLAB_IPC_DURABLE_TURN_OUTPUT_RECEIPT).toBe('durable-turn-output-receipt-v1');
  });
});
