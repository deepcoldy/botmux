import { describe, expect, it } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import type { MessageProvenance } from '../src/types.js';
import { activeSessionKey } from '../src/core/types.js';
import { freezePrincipalLaneTurnBinding, readPrincipalLaneTurnBinding } from '../src/core/principal-lane-turn.js';
import { __testOnly_decideLivePrincipalLaneReference } from '../src/daemon.js';

function laneSession(laneId: string, sessionId: string, principalKey: string): DaemonSession {
  const now = new Date().toISOString();
  const ds: DaemonSession = {
    session: {
      sessionId, chatId: 'oc_group', chatType: 'group', scope: 'chat',
      title: laneId, status: 'active', createdAt: now, larkAppId: 'app', workerGeneration: 7,
      principalLane: {
        version: 1, laneId, sourceSessionId: 'source-a', principalKey,
        principal: principalKey.endsWith(':a')
          ? { senderType: 'user', kind: 'union', unionId: 'a' }
          : { senderType: 'user', kind: 'union', unionId: 'b' },
        routingAnchor: `principal-lane:${laneId}`,
        displayTarget: { scope: 'chat', larkAppId: 'app', chatId: 'oc_group' },
        workspaceEpoch: 1, phase: 'active', revision: 1, createdAt: now, updatedAt: now,
      },
    },
    worker: null, workerPort: null, workerToken: null, workerGeneration: 7,
    currentTurnId: 'turn-a', larkAppId: 'app', chatId: 'oc_group', chatType: 'group',
    scope: 'chat', runtimeRoutingAnchor: `principal-lane:${laneId}`, spawnedAt: Date.now(),
    cliVersion: 'test', lastMessageAt: Date.now(), hasHistory: false,
  };
  return ds;
}

function provenance(ds: DaemonSession): MessageProvenance {
  const lane = ds.session.principalLane!;
  const now = new Date().toISOString();
  return {
    messageId: 'om_parent', larkAppId: 'app', chatId: 'oc_group',
    sourceSessionId: 'source-a', laneId: lane.laneId, sessionId: ds.session.sessionId,
    turnId: 'turn-a', principalKey: lane.principalKey, workerGeneration: 7,
    direction: 'outbound', trustState: 'trusted', createdAt: now, updatedAt: now,
  };
}

describe('principal lane live reference routing', () => {
  it('routes a reply to the caller own trusted lane', () => {
    const own = laneSession('lane-b', 'child-b', 'user:union:b');
    const result = __testOnly_decideLivePrincipalLaneReference({
      sourceSessionId: 'source-a', larkAppId: 'app', callerPrincipalKey: 'user:union:b',
      callerLaneId: 'lane-b', parentId: 'om_parent',
      deps: {
        readTrustedMessageProvenance: () => provenance(own),
        findActiveSession: () => own,
        readTurnBinding: () => undefined,
      },
    });
    expect(result.decision).toEqual({
      kind: 'route_lane', laneId: 'lane-b', reason: 'trusted_own_reference',
    });
  });

  it('routes a reply to another active turn as a suggestion', () => {
    const target = laneSession('source', 'source-a', 'user:union:a');
    target.activeInteractiveTurn = {
      turnId: 'turn-a',
      caller: { requestUserUnionId: 'a', requestLarkAppId: 'app', senderType: 'user' },
    };
    freezePrincipalLaneTurnBinding(target, 'turn-a', 7, 'om_in');
    const p = provenance(target);
    const active = new Map([[activeSessionKey(target), target]]);
    const result = __testOnly_decideLivePrincipalLaneReference({
      sourceSessionId: 'source-a', larkAppId: 'app', callerPrincipalKey: 'user:union:b',
      callerLaneId: 'lane-b', parentId: 'om_parent',
      deps: {
        readTrustedMessageProvenance: () => p,
        findActiveSession: sessionId => [...active.values()].find(ds => ds.session.sessionId === sessionId),
        readTurnBinding: readPrincipalLaneTurnBinding,
      },
    });
    expect(result.decision).toEqual({
      kind: 'suggestion', targetSessionId: 'source-a', targetLaneId: 'source',
    });
  });

  it('routes an inactive foreign reference back to the caller lane', () => {
    const target = laneSession('source', 'source-a', 'user:union:a');
    const result = __testOnly_decideLivePrincipalLaneReference({
      sourceSessionId: 'source-a', larkAppId: 'app', callerPrincipalKey: 'user:union:b',
      callerLaneId: 'lane-b', parentId: 'om_parent',
      deps: {
        readTrustedMessageProvenance: () => provenance(target),
        findActiveSession: () => target,
        readTurnBinding: () => undefined,
      },
    });
    expect(result.decision).toEqual({
      kind: 'route_lane', laneId: 'lane-b', reason: 'existing_caller_lane',
    });
  });
});
