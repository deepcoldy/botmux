/**
 * collab.kickoff target-owned durable operation store（PR-3a §7.1）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  prepareCollabKickoff,
  startCollabKickoff,
  cancelCollabKickoff,
  readCollabKickoffOperation,
} from '../src/core/collab-kickoff-store.js';

let dataDir: string;
const TARGET = 'cli_target';
const KICKOFF = 'a'.repeat(64);
const INIT = 'b'.repeat(64);

function prepOpts(overrides: Record<string, unknown> = {}) {
  return {
    dataDir,
    sourceLarkAppId: 'cli_source',
    targetLarkAppId: TARGET,
    kickoffId: KICKOFF,
    initId: INIT,
    appId: 'cli_target',
    chatId: 'oc_chat',
    configVersion: 'cv',
    payloadHash: 'h1',
    now: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'collab-kickoff-store-')); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

describe('collab-kickoff-store', () => {
  it('prepare 幂等：同 kickoffId + 同 payloadHash 返回原 operation', () => {
    const r1 = prepareCollabKickoff(prepOpts());
    expect(r1.ok).toBe(true);
    const r2 = prepareCollabKickoff(prepOpts());
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r2.operation.state).toBe(r1.operation.state);
      expect(r2.operation.createdAt).toBe(r1.operation.createdAt);
    }
  });

  it('prepare 冲突：同 kickoffId 不同 payloadHash → OPERATION_CONFLICT', () => {
    expect(prepareCollabKickoff(prepOpts()).ok).toBe(true);
    const conflict = prepareCollabKickoff(prepOpts({ payloadHash: 'h2' }));
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.errorCode).toBe('OPERATION_CONFLICT');
  });

  it('start 持久 {sessionId,turnId,acceptedAt} 后置 started', () => {
    expect(prepareCollabKickoff(prepOpts()).ok).toBe(true);
    const r = startCollabKickoff({
      dataDir, targetLarkAppId: TARGET, kickoffId: KICKOFF,
      sessionId: 'sess_1', turnId: 'turn_1', acceptedAt: new Date().toISOString(), now: new Date().toISOString(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.operation.state).toBe('started');
      expect(r.operation.sessionId).toBe('sess_1');
      expect(r.operation.turnId).toBe('turn_1');
      expect(r.operation.acceptedAt).toBeTruthy();
    }
    // 二次 start 幂等
    const r2 = startCollabKickoff({
      dataDir, targetLarkAppId: TARGET, kickoffId: KICKOFF,
      sessionId: 'sess_1', turnId: 'turn_1', acceptedAt: new Date().toISOString(), now: new Date().toISOString(),
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.operation.state).toBe('started');
  });

  it('未 prepare 就 start → OPERATION_NOT_FOUND', () => {
    const r = startCollabKickoff({
      dataDir, targetLarkAppId: TARGET, kickoffId: KICKOFF,
      sessionId: 's', turnId: 't', acceptedAt: new Date().toISOString(), now: new Date().toISOString(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('OPERATION_NOT_FOUND');
  });

  it('cancel 置 cancelled；已 started 不可 cancel', () => {
    expect(prepareCollabKickoff(prepOpts()).ok).toBe(true);
    const c = cancelCollabKickoff({ dataDir, targetLarkAppId: TARGET, kickoffId: KICKOFF, now: new Date().toISOString() });
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.operation.state).toBe('cancelled');
    expect(readCollabKickoffOperation(dataDir, TARGET, KICKOFF)!.state).toBe('cancelled');
  });

  it('query：GET 等价 readCollabKickoffOperation', () => {
    expect(readCollabKickoffOperation(dataDir, TARGET, KICKOFF)).toBeUndefined();
    prepareCollabKickoff(prepOpts());
    expect(readCollabKickoffOperation(dataDir, TARGET, KICKOFF)!.state).toBe('prepared');
  });
});
