/**
 * collab.kickoff IPC（PR-3a §7.1）：parse + client fail-closed。
 */
import { describe, it, expect } from 'vitest';
import {
  parseCollabKickoffRequest,
  collabKickoffPath,
  requestCollabKickoff,
} from '../src/core/collab-kickoff-ipc.js';
import { collabKickoffId } from '../src/services/collab-group-config.js';

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
});
