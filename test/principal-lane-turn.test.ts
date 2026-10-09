import { describe, expect, it } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import {
  freezePrincipalLaneTurnBinding,
  readPrincipalLaneTurnBinding,
} from '../src/core/principal-lane-turn.js';

function laneSession(): DaemonSession {
  const now = new Date().toISOString();
  return {
    session: {
      sessionId: 'child-b', chatId: 'oc_group', chatType: 'group', scope: 'chat',
      title: 'B', status: 'active', createdAt: now, larkAppId: 'app',
      workerGeneration: 7,
      principalLane: {
        version: 1, laneId: 'lane-b', sourceSessionId: 'source-a',
        principalKey: 'user:union:b',
        principal: { senderType: 'user', kind: 'union', unionId: 'b' },
        routingAnchor: 'principal-lane:b',
        displayTarget: { scope: 'chat', larkAppId: 'app', chatId: 'oc_group' },
        workspaceEpoch: 1, phase: 'active', revision: 1,
        createdAt: now, updatedAt: now,
      },
    },
    worker: null, workerPort: null, workerToken: null,
    workerGeneration: 7,
    larkAppId: 'app', chatId: 'oc_group', chatType: 'group', scope: 'chat',
    runtimeRoutingAnchor: 'principal-lane:b', spawnedAt: Date.now(),
    cliVersion: 'test', lastMessageAt: Date.now(), hasHistory: false,
  };
}

describe('principal lane immutable turn binding', () => {
  it('freezes runtime identity and rejects a replaced worker generation', () => {
    const ds = laneSession();
    const binding = freezePrincipalLaneTurnBinding(ds, 'om_b1', 7);
    expect(binding).toMatchObject({
      sourceSessionId: 'source-a', laneId: 'lane-b', sessionId: 'child-b',
      turnId: 'om_b1', inboundMessageId: 'om_b1', workerGeneration: 7,
    });
    expect(readPrincipalLaneTurnBinding(ds, 'om_b1')).toBe(binding);
    ds.workerGeneration = 8;
    ds.session.workerGeneration = 8;
    expect(readPrincipalLaneTurnBinding(ds, 'om_b1')).toBeUndefined();
  });

  it('rejects rebinding one turn to another generation', () => {
    const ds = laneSession();
    freezePrincipalLaneTurnBinding(ds, 'om_b1', 7);
    ds.workerGeneration = 8;
    ds.session.workerGeneration = 8;
    expect(() => freezePrincipalLaneTurnBinding(ds, 'om_b1', 8))
      .toThrow('principal-lane turn identity changed');
  });
});
