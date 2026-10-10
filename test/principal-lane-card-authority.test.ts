import { describe, expect, it } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import type { MessageProvenance } from '../src/types.js';
import { freezePrincipalLaneTurnBinding } from '../src/core/principal-lane-turn.js';
import { activeSessionKey } from '../src/core/types.js';
import { validatePrincipalLaneCardActionAuthority } from '../src/im/lark/card-handler.js';

function laneSession(): DaemonSession {
  const now = new Date().toISOString();
  return {
    session: {
      sessionId: 'child-b', chatId: 'oc_group', chatType: 'group', scope: 'chat',
      title: 'B', status: 'active', createdAt: now, larkAppId: 'app', workerGeneration: 7,
      principalLane: {
        version: 1, laneId: 'lane-b', sourceSessionId: 'source-a',
        principalKey: 'user:union:b',
        principal: { senderType: 'user', kind: 'union', unionId: 'b' },
        routingAnchor: 'principal-lane:b',
        displayTarget: { scope: 'chat', larkAppId: 'app', chatId: 'oc_group' },
        workspaceEpoch: 1, phase: 'active', revision: 1, createdAt: now, updatedAt: now,
      },
    },
    worker: null, workerPort: null, workerToken: null, workerGeneration: 7,
    currentTurnId: 'turn-7', larkAppId: 'app', chatId: 'oc_group', chatType: 'group',
    scope: 'chat', runtimeRoutingAnchor: 'principal-lane:b', spawnedAt: Date.now(),
    cliVersion: 'test', lastMessageAt: Date.now(), hasHistory: false,
  };
}

function provenance(workerGeneration = 7): MessageProvenance {
  const now = new Date().toISOString();
  return {
    messageId: 'om_card', larkAppId: 'app', chatId: 'oc_group',
    sourceSessionId: 'source-a', laneId: 'lane-b', sessionId: 'child-b',
    turnId: 'turn-7', principalKey: 'user:union:b', workerGeneration,
    direction: 'outbound', trustState: 'trusted', createdAt: now, updatedAt: now,
  };
}

describe('principal lane card action authority', () => {
  it('accepts only the current immutable turn and worker generation', () => {
    const ds = laneSession();
    freezePrincipalLaneTurnBinding(ds, 'turn-7', 7, 'om_in');
    const active = new Map([[activeSessionKey(ds), ds]]);
    expect(validatePrincipalLaneCardActionAuthority(ds, 'om_card', active, {
      readTrustedProvenance: () => provenance(),
    })).toBe(true);

    ds.workerGeneration = 8;
    ds.session.workerGeneration = 8;
    expect(validatePrincipalLaneCardActionAuthority(ds, 'om_card', active, {
      readTrustedProvenance: () => provenance(7),
    })).toBe(false);
  });

  it('rejects a late card from a previous turn', () => {
    const ds = laneSession();
    freezePrincipalLaneTurnBinding(ds, 'turn-7', 7, 'om_in');
    ds.currentTurnId = 'turn-8';
    expect(validatePrincipalLaneCardActionAuthority(
      ds,
      'om_card',
      new Map([[activeSessionKey(ds), ds]]),
      { readTrustedProvenance: () => provenance() },
    )).toBe(false);
  });
});
