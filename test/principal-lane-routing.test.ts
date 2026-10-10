import { describe, expect, it } from 'vitest';
import {
  decideLegacySourceMigration,
  decidePrincipalLaneRoute,
  lanePrincipalFromInbound,
  lanePrincipalKey,
  parsePrincipalLaneBinding,
  principalLaneDisplayTarget,
  resolveCallerLaneId,
  sourceSessionDisplayTarget,
  validPrincipalLaneBinding,
} from '../src/core/principal-lane-routing.js';
import {
  activeSessionKey,
  principalLaneRoutingAnchorId,
  runtimeSessionAnchorId,
  sessionAnchorId,
  sessionKey,
  storedSessionAnchorId,
} from '../src/core/types.js';

const callerA = lanePrincipalKey({ senderType: 'user', kind: 'union', unionId: 'on_a' });
const callerB = lanePrincipalKey({ senderType: 'user', kind: 'union', unionId: 'on_b' });

describe('principal lane route precedence', () => {
  it('keeps exact explicit new-topic intent above every parent reference', () => {
    expect(decidePrincipalLaneRoute({
      senderType: 'user',
      intent: 'explicit_new_topic',
      callerPrincipalKey: callerA,
      callerLaneId: 'source',
      reference: {
        trusted: true,
        principalKey: callerA,
        laneId: 'source',
        sessionId: 'sid-a',
        laneValid: true,
        foreignTurnActive: true,
        workerGenerationMatches: true,
      },
    })).toEqual({ kind: 'new_topic' });

    expect(decidePrincipalLaneRoute({
      senderType: 'user',
      intent: 'explicit_new_topic',
      callerPrincipalKey: callerB,
      reference: {
        trusted: true,
        principalKey: callerA,
        laneId: 'source',
        sessionId: 'sid-a',
        laneValid: true,
        foreignTurnActive: true,
        workerGenerationMatches: true,
      },
    })).toEqual({ kind: 'new_topic' });
  });

  it('keeps bot senders on the existing explicit --as control flow', () => {
    expect(decidePrincipalLaneRoute({
      senderType: 'bot',
      intent: 'explicit_new_topic',
      callerPrincipalKey: 'bot:union:on_bot',
    })).toEqual({ kind: 'bot_explicit_as' });
  });

  it('routes a trusted own-lane reference before considering suggestion intent', () => {
    expect(decidePrincipalLaneRoute({
      senderType: 'user',
      intent: 'explicit_suggest_current',
      callerPrincipalKey: callerB,
      callerLaneId: 'lane-b',
      reference: {
        trusted: true,
        principalKey: callerB,
        laneId: 'lane-b',
        sessionId: 'sid-b',
        laneValid: true,
      },
    })).toEqual({ kind: 'route_lane', laneId: 'lane-b', reason: 'trusted_own_reference' });
  });

  it('stages only an exact trusted foreign active-turn reference as suggestion', () => {
    expect(decidePrincipalLaneRoute({
      senderType: 'user',
      intent: 'none',
      callerPrincipalKey: callerB,
      reference: {
        trusted: true,
        principalKey: callerA,
        laneId: 'source',
        sessionId: 'sid-a',
        laneValid: true,
        foreignTurnActive: true,
        workerGenerationMatches: true,
      },
    })).toEqual({ kind: 'suggestion', targetSessionId: 'sid-a', targetLaneId: 'source' });
  });

  it('rejects explicit suggestion without current trusted provenance', () => {
    for (const reference of [
      undefined,
      { trusted: false },
      {
        trusted: true,
        principalKey: callerA,
        laneId: 'source',
        sessionId: 'sid-a',
        laneValid: true,
        foreignTurnActive: false,
        workerGenerationMatches: true,
      },
    ]) {
      expect(decidePrincipalLaneRoute({
        senderType: 'user',
        intent: 'explicit_suggest_current',
        callerPrincipalKey: callerB,
        callerLaneId: 'lane-b',
        reference,
      })).toEqual({ kind: 'reject_suggestion', reason: 'missing_current_task_reference' });
    }
  });

  it('defaults stale/untrusted references to the caller lane, then lane creation', () => {
    expect(decidePrincipalLaneRoute({
      senderType: 'user',
      intent: 'none',
      callerPrincipalKey: callerB,
      callerLaneId: 'lane-b',
      reference: { trusted: false, principalKey: callerA },
    })).toEqual({ kind: 'route_lane', laneId: 'lane-b', reason: 'existing_caller_lane' });

    expect(decidePrincipalLaneRoute({
      senderType: 'user',
      intent: 'none',
      callerPrincipalKey: callerB,
    })).toEqual({ kind: 'create_lane' });
  });
});

describe('principal identity and legacy source migration', () => {
  it('maps the source principal to lane 0 even when no turn is active', () => {
    expect(resolveCallerLaneId({
      callerPrincipalKey: callerA,
      sourcePrincipalKey: callerA,
    })).toBe('source');
    expect(resolveCallerLaneId({
      callerPrincipalKey: callerB,
      sourcePrincipalKey: callerA,
      indexedLaneId: 'lane-b',
    })).toBe('lane-b');
  });

  it('prefers union id and app-scopes the open-id fallback', () => {
    expect(lanePrincipalFromInbound({
      senderType: 'user', larkAppId: 'cli_1', unionId: 'on_1', openId: 'ou_1',
    })).toEqual({ senderType: 'user', kind: 'union', unionId: 'on_1' });
    expect(lanePrincipalKey(lanePrincipalFromInbound({
      senderType: 'user', larkAppId: 'cli_1', openId: 'ou_1',
    })!)).toBe('user:app:cli_1:open:ou_1');
  });

  it('binds a legacy source only with owner-union evidence', () => {
    const decision = decideLegacySourceMigration({
      session: { larkAppId: 'cli_1', ownerUnionId: 'on_a', ownerOpenId: 'ou_a' },
      inboundLarkAppId: 'cli_1',
      caller: { senderType: 'user', kind: 'union', unionId: 'on_a' },
    });
    expect(decision).toMatchObject({ kind: 'bind', evidence: 'owner_union_id' });

    expect(decideLegacySourceMigration({
      session: { larkAppId: 'cli_1', ownerUnionId: 'on_a', ownerOpenId: 'ou_a' },
      inboundLarkAppId: 'cli_1',
      caller: { senderType: 'user', kind: 'union', unionId: 'on_b' },
    })).toEqual({ kind: 'disable_principal_lanes', reason: 'caller_identity_unproven' });
  });

  it('allows same-app owner open-id fallback only when legacy union is absent', () => {
    const caller = { senderType: 'user', kind: 'app_open', larkAppId: 'cli_1', openId: 'ou_a' } as const;
    expect(decideLegacySourceMigration({
      session: { larkAppId: 'cli_1', ownerOpenId: 'ou_a' },
      inboundLarkAppId: 'cli_1',
      caller,
    })).toMatchObject({ kind: 'bind', evidence: 'same_app_owner_open_id' });

    expect(decideLegacySourceMigration({
      session: { larkAppId: 'cli_1', ownerOpenId: 'ou_a' },
      inboundLarkAppId: 'cli_2',
      caller,
    })).toEqual({ kind: 'disable_principal_lanes', reason: 'caller_identity_unproven' });
  });
});

describe('routing/display separation', () => {
  const sourceDisplayTarget = {
    scope: 'thread', larkAppId: 'cli_app', chatId: 'oc_group', rootMessageId: 'om_visible',
  } as const;
  const lane = {
    version: 1 as const,
    laneId: 'lane-b',
    sourceSessionId: 'sid-source',
    principalKey: callerB,
    principal: { senderType: 'user', kind: 'union', unionId: 'on_b' } as const,
    routingAnchor: 'lane:source:b',
    displayTarget: sourceDisplayTarget,
    workspaceEpoch: 1,
    phase: 'active' as const,
    revision: 1,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
  };

  it('uses the virtual routing anchor but preserves the visible target', () => {
    const session = {
      scope: 'thread' as const,
      larkAppId: 'cli_app',
      chatId: 'oc_group',
      rootMessageId: 'om_visible',
      principalLane: lane,
    };
    expect(storedSessionAnchorId(session)).toBe('om_visible');
    expect(sessionAnchorId({
      session,
      scope: 'thread',
      chatId: 'oc_group',
    } as any)).toBe('om_visible');
    expect(principalLaneRoutingAnchorId(session)).toBe('lane:source:b');
    expect(principalLaneDisplayTarget(session, sourceDisplayTarget)).toEqual({
      scope: 'thread', larkAppId: 'cli_app', chatId: 'oc_group', rootMessageId: 'om_visible',
    });
    expect(validPrincipalLaneBinding(lane, { displayTarget: sourceDisplayTarget })).toBe(true);
  });

  it('separates a validated runtime lane key from the visible Lark anchor', () => {
    const ds = {
      session: {
        scope: 'chat' as const,
        chatId: 'oc_group',
        rootMessageId: 'om_visible',
      },
      scope: 'chat' as const,
      chatId: 'oc_group',
      larkAppId: 'cli_app',
      runtimeRoutingAnchor: 'lane:source:b',
    } as any;

    expect(sessionAnchorId(ds)).toBe('oc_group');
    expect(runtimeSessionAnchorId(ds)).toBe('lane:source:b');
    expect(activeSessionKey(ds)).toBe(sessionKey('lane:source:b', 'cli_app'));
    expect(activeSessionKey(ds)).not.toBe(sessionKey(sessionAnchorId(ds), 'cli_app'));
  });

  it('keeps the legacy active key byte-for-byte when no validated runtime lane exists', () => {
    const ds = {
      session: {
        scope: 'thread' as const,
        chatId: 'oc_group',
        rootMessageId: 'om_visible',
      },
      scope: 'thread' as const,
      chatId: 'oc_group',
      larkAppId: 'cli_app',
    } as any;

    expect(runtimeSessionAnchorId(ds)).toBe(sessionAnchorId(ds));
    expect(activeSessionKey(ds)).toBe(sessionKey(sessionAnchorId(ds), 'cli_app'));
  });

  it('accepts only explicit chat/thread or legacy undefined source scope', () => {
    expect(sourceSessionDisplayTarget({
      scope: undefined, larkAppId: 'cli_app', chatId: 'oc_group', rootMessageId: 'om_legacy',
    }, 'cli_app')).toEqual({
      scope: 'thread', larkAppId: 'cli_app', chatId: 'oc_group', rootMessageId: 'om_legacy',
    });
    expect(sourceSessionDisplayTarget({
      scope: 'invalid' as any,
      larkAppId: 'cli_app',
      chatId: 'oc_group',
      rootMessageId: 'om_visible',
    }, 'cli_app')).toBeUndefined();
  });

  it('fails closed when the display target belongs to another app', () => {
    const crossApp = {
      ...lane,
      displayTarget: { ...lane.displayTarget, larkAppId: 'cli_other' },
    };
    expect(parsePrincipalLaneBinding(crossApp, { displayTarget: sourceDisplayTarget }))
      .toEqual({ ok: false, error: 'display_app_mismatch' });
    expect(principalLaneDisplayTarget({
      scope: 'thread', larkAppId: 'cli_app', chatId: 'oc_group', rootMessageId: 'om_visible',
      principalLane: crossApp,
    }, sourceDisplayTarget)).toBeUndefined();
  });

  it('fails closed for the same app with another chat or thread root', () => {
    expect(parsePrincipalLaneBinding({
      ...lane,
      displayTarget: { ...sourceDisplayTarget, chatId: 'oc_other' },
    }, { displayTarget: sourceDisplayTarget }))
      .toEqual({ ok: false, error: 'display_chat_mismatch' });

    expect(parsePrincipalLaneBinding({
      ...lane,
      displayTarget: { ...sourceDisplayTarget, rootMessageId: 'om_other' },
    }, { displayTarget: sourceDisplayTarget }))
      .toEqual({ ok: false, error: 'display_root_mismatch' });
  });

  it.each([
    ['missing principal', { ...lane, principal: undefined }, 'invalid_principal'],
    ['missing display target', { ...lane, displayTarget: undefined }, 'invalid_display_target'],
    ['illegal phase', { ...lane, phase: 'running' }, 'invalid_phase'],
    ['principal key mismatch', { ...lane, principalKey: callerA }, 'principal_key_mismatch'],
  ])('returns a quarantine error for %s without throwing', (_name, value, error) => {
    expect(() => parsePrincipalLaneBinding(value, { displayTarget: sourceDisplayTarget })).not.toThrow();
    expect(parsePrincipalLaneBinding(value, { displayTarget: sourceDisplayTarget }))
      .toEqual({ ok: false, error });
  });

  it('rejects a durable bot principal even when the identity is otherwise well formed', () => {
    const botBinding = {
      ...lane,
      principal: { senderType: 'bot', kind: 'union', unionId: 'on_bot' },
      principalKey: 'bot:union:on_bot',
    };
    expect(parsePrincipalLaneBinding(botBinding, { displayTarget: sourceDisplayTarget }))
      .toEqual({ ok: false, error: 'invalid_principal' });
  });
});
