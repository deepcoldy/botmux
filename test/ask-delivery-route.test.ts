/**
 * Where `botmux ask` can reach a human (daemon handleAskRequest routes on
 * resolveAskDeliveryRoute + isNativeGatewayCoreProcess).
 *
 * A session without Lark transport fails fast with `unsupported` — including a
 * bare core-only service with no gateway, which must not register an ask that
 * nothing will ever deliver (the agent would block on the delivery window).
 * Only the dedicated core of a native gateway, for a turn the gateway can see,
 * routes asks to the gateway.
 */
import { describe, expect, it } from 'vitest';
import { isNativeGatewayCoreEnv } from '../src/core/runtime-mode.js';
import { resolveAskDeliveryRoute } from '../src/core/native-gateway-ask-dispatch.js';
import { wecomManagedCoreEnvironment } from '../src/im/wecom/config/managed-core-env.js';

const managedCoreEnv = wecomManagedCoreEnvironment({
  managedCore: {
    botId: 'local_route_probe', cli: 'codex', backend: 'pty', workingDirectory: '/tmp',
    port: 19999, stateDir: '/tmp/route-probe-state',
  },
}, { PATH: '/usr/bin' });

const liveTurn = { turnOrigin: { turnId: 'trg_turn', dispatchAttempt: 2 }, workerGeneration: 3 };

/** A core-only service without the native gateway mark: `serve --api-only`,
 * riff, or an external core a WeCom configuration points at. */
const { BOTMUX_NATIVE_GATEWAY_CORE: _gatewayMark, ...bareCore } = managedCoreEnv;

describe('isNativeGatewayCoreEnv', () => {
  it('recognises the environment the WeCom managed-core launcher produces', () => {
    expect(isNativeGatewayCoreEnv(managedCoreEnv)).toBe(true);
  });

  it('is false for a bare core-only service and for fleet daemons', () => {
    const { BOTMUX_CORE_BOT_CONFIG: _profile, ...profilelessCore } = bareCore;
    expect(isNativeGatewayCoreEnv(profilelessCore)).toBe(false);
    const { BOTMUX_CORE_ONLY: _coreOnly, ...notCoreOnly } = managedCoreEnv;
    expect(isNativeGatewayCoreEnv(notCoreOnly)).toBe(false);
    expect(isNativeGatewayCoreEnv({ PATH: '/usr/bin' })).toBe(false);
  });

  it('is false for a bare core-only service that was handed a bot profile', () => {
    // Any core-only host may pass BOTMUX_CORE_BOT_CONFIG (bot-registry reads it
    // for every core-only service); a profile does not make a gateway exist.
    expect(bareCore.BOTMUX_CORE_BOT_CONFIG).toBeDefined();
    expect(isNativeGatewayCoreEnv(bareCore)).toBe(false);
    expect(isNativeGatewayCoreEnv({ BOTMUX_CORE_ONLY: '1', BOTMUX_CORE_BOT_CONFIG: '{}' })).toBe(false);
  });
});

describe('resolveAskDeliveryRoute', () => {
  it('fleet daemon: Lark transport delivers, a no-transport session is unsupported', () => {
    const fleet = isNativeGatewayCoreEnv({ PATH: '/usr/bin' });
    expect(resolveAskDeliveryRoute({ nativeGatewayCore: fleet, larkTransport: true, ...liveTurn })).toEqual({ kind: 'lark' });
    expect(resolveAskDeliveryRoute({ nativeGatewayCore: fleet, larkTransport: false, ...liveTurn })).toEqual({ kind: 'unsupported' });
  });

  it('bare core-only service: unsupported even for a live turn, because no gateway will poll the ask', () => {
    const route = resolveAskDeliveryRoute({ nativeGatewayCore: isNativeGatewayCoreEnv(bareCore), larkTransport: false, ...liveTurn });
    expect(route).toEqual({ kind: 'unsupported' });
  });

  it('native gateway core: routes a live turn to the gateway under its exact origin', () => {
    const route = resolveAskDeliveryRoute({ nativeGatewayCore: isNativeGatewayCoreEnv(managedCoreEnv), larkTransport: false, ...liveTurn });
    expect(route).toEqual({ kind: 'native_gateway', origin: { turnId: 'trg_turn', workerGeneration: 3, dispatchAttempt: 2 } });
  });

  it('native gateway core without a live turn: a caller naming its turn is told that turn ended', () => {
    // A `botmux ask` still waiting across a daemon restart: HTTP turns do not survive it.
    const route = resolveAskDeliveryRoute({
      nativeGatewayCore: isNativeGatewayCoreEnv(managedCoreEnv), larkTransport: false, turnOrigin: {}, workerGeneration: 3,
      claimedTurnId: 'trg_turn',
    });
    expect(route).toMatchObject({ kind: 'ended', result: { kind: 'invalidated', failureCode: 'execution_ended' } });
  });

  it('a named turn or attempt can only refuse: matching names route to the live turn, any other ends', () => {
    const gateway = isNativeGatewayCoreEnv(managedCoreEnv);
    const route = (claims: { claimedTurnId?: string; claimedDispatchAttempt?: number }) =>
      resolveAskDeliveryRoute({ nativeGatewayCore: gateway, larkTransport: false, ...liveTurn, ...claims });
    const live = { kind: 'native_gateway', origin: { turnId: 'trg_turn', workerGeneration: 3, dispatchAttempt: 2 } };
    expect(route({})).toEqual(live);
    expect(route({ claimedTurnId: 'trg_turn', claimedDispatchAttempt: 2 })).toEqual(live);
    expect(route({ claimedTurnId: 'trg_turn' })).toEqual(live);
    for (const claims of [{ claimedTurnId: 'trg_other' }, { claimedDispatchAttempt: 1 },
      { claimedTurnId: 'trg_turn', claimedDispatchAttempt: 3 }]) {
      expect(route(claims)).toMatchObject({ kind: 'ended', result: { kind: 'invalidated', failureCode: 'execution_ended' } });
    }
  });

  it('other daemons ignore a named turn entirely', () => {
    const fleet = isNativeGatewayCoreEnv({ PATH: '/usr/bin' });
    const claims = { claimedTurnId: 'trg_other', claimedDispatchAttempt: 9 };
    expect(resolveAskDeliveryRoute({ nativeGatewayCore: fleet, larkTransport: true, ...liveTurn, ...claims })).toEqual({ kind: 'lark' });
    expect(resolveAskDeliveryRoute({ nativeGatewayCore: fleet, larkTransport: false, ...liveTurn, ...claims })).toEqual({ kind: 'unsupported' });
    expect(resolveAskDeliveryRoute({ nativeGatewayCore: isNativeGatewayCoreEnv(bareCore), larkTransport: false, ...claims }))
      .toEqual({ kind: 'unsupported' });
  });

  it('native gateway core: without a live turn every ask has ended, named turn or not', () => {
    const gateway = isNativeGatewayCoreEnv(managedCoreEnv);
    const ended = { kind: 'ended', result: { kind: 'invalidated', failureCode: 'execution_ended' } };
    expect(resolveAskDeliveryRoute({ nativeGatewayCore: gateway, larkTransport: false, turnOrigin: {}, workerGeneration: 3 }))
      .toMatchObject(ended);
    expect(resolveAskDeliveryRoute({ nativeGatewayCore: gateway, larkTransport: false, turnOrigin: liveTurn.turnOrigin }))
      .toMatchObject(ended);
  });
});
