import * as Lark from '@larksuiteoapi/node-sdk';
import { describeLarkWsProxy, describeWsRuntime, larkWsAgentFor, resolveLarkWsProxy } from '../ws-proxy-agent.js';
import { logger } from '../../../utils/logger.js';
import { type Brand, sdkDomain } from '../lark-hosts.js';
import { registerLarkConnectionHealth, type LarkConnectionHealth } from './connection-health.js';
import { createResilientWsClient } from './resilient-ws-client.js';

export type LarkConnection = Pick<Lark.WSClient, 'close' | 'getConnectionStatus'>;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Own all SDK generations for this subscription. Closing the handle also disarms recovery. */
export function startLarkConnection(
  larkAppId: string,
  larkAppSecret: string,
  eventDispatcher: Lark.EventDispatcher,
  brand: Brand = 'feishu',
  lifecycle: {
    onReady?: () => void;
    onReconnecting?: () => void;
    onReconnected?: () => void;
    onRestarting?: () => void;
  } = {},
): LarkConnection {
  const reconnectLimit = positiveInt(process.env.BOTMUX_LARK_WS_RECONNECT_STALE_MS, 5 * 60_000);
  const inboundLimit = positiveInt(process.env.BOTMUX_LARK_WS_INBOUND_STALE_MS, 15 * 60_000);
  const maxRebuilds = positiveInt(process.env.BOTMUX_LARK_WS_MAX_REBUILDS, 3);
  const domain = sdkDomain(brand);
  const wsProxy = resolveLarkWsProxy(domain);
  const diagnostics = `proxy=${describeLarkWsProxy(wsProxy)} runtime=${describeWsRuntime()}`;
  logger.info(`[ws] ${larkAppId} connecting domain=${domain} ${diagnostics}`);

  let generation = 0;
  let generationStarted = Date.now();
  let cycleStarted = generationStarted;
  let rebuilds = 0;
  let everConnected = false;
  let closed = false;
  let active: Lark.WSClient;
  const health: LarkConnectionHealth = {
    state: 'connecting', since: generationStarted, attempts: 0, lastInboundAt: null,
  };
  const changeState = (state: LarkConnectionHealth['state']) => {
    if (health.state !== state) {
      health.state = state;
      health.since = Date.now();
    }
  };
  const unregister = registerLarkConnectionHealth(larkAppId, () => ({ ...health }));

  const startGeneration = () => {
    const current = generation;
    const isCurrent = () => !closed && current === generation;
    generationStarted = Date.now();
    const connected = () => {
      if (!isCurrent()) return;
      changeState('connected');
      logger.info(`[ws] ${larkAppId} ${everConnected ? 'reconnected' : 'connected'} attempt=${health.attempts} elapsed=${Date.now() - cycleStarted}ms`);
      if (everConnected) lifecycle.onReconnected?.();
      else {
        everConnected = true;
        lifecycle.onReady?.();
      }
    };
    active = createResilientWsClient({
      appId: larkAppId,
      appSecret: larkAppSecret,
      domain,
      agent: larkWsAgentFor(wsProxy),
      loggerLevel: process.env.DEBUG ? Lark.LoggerLevel.info : Lark.LoggerLevel.warn,
      wsConfig: { pingTimeout: 30 },
      handshakeTimeoutMs: 15_000,
      onReady: connected,
      onReconnected: connected,
      onReconnecting: () => {
        if (!isCurrent() || health.state === 'reconnecting') return;
        cycleStarted = Date.now();
        health.attempts = 0;
        changeState('reconnecting');
        logger.warn(`[ws] ${larkAppId} reconnecting…`);
        lifecycle.onReconnecting?.();
      },
      onError: () => {
        if (!isCurrent()) return;
        changeState('failed');
        logger.error(`[ws] ${larkAppId} terminal connection failure (${diagnostics})`);
      },
    }, {
      onAttempt: () => {
        if (!isCurrent()) return;
        health.attempts++;
        logger.info(`[ws] ${larkAppId} attempt=${health.attempts} starting`);
      },
      onAttemptFailed: (_attempt, reason) => {
        if (!isCurrent()) return;
        logger.warn(`[ws] ${larkAppId} attempt=${health.attempts} failed: ${reason} (${diagnostics})`);
      },
      onInbound: () => {
        if (!isCurrent()) return;
        health.lastInboundAt = Date.now();
        rebuilds = 0;
      },
    });
    void active.start({ eventDispatcher }).catch(() => {
      if (!isCurrent()) return;
      changeState('failed');
      logger.error(`[ws] ${larkAppId} WSClient start rejected (${diagnostics})`);
    });
  };

  startGeneration();
  const watchdog = setInterval(() => {
    if (closed) return;
    const now = Date.now();
    const state = active.getConnectionStatus().state;
    // Each replacement gets a full observation window. A handshake without
    // a subsequent inbound frame never resets the consecutive rebuild budget.
    const silentFor = now - Math.max(generationStarted, health.lastInboundAt ?? 0);
    const pendingFor = now - Math.max(generationStarted, health.since);
    let reason: string;
    if (state === 'failed' || health.state === 'failed') reason = 'terminal failure';
    else if (state !== 'connected' && pendingFor >= reconnectLimit) reason = `${state} for ${pendingFor}ms`;
    else if (silentFor >= inboundLimit) reason = `no inbound for ${silentFor}ms`;
    else return;
    if (rebuilds >= maxRebuilds) {
      logger.error(`[ws] ${larkAppId} ${reason} after ${rebuilds} rebuilds; exiting for supervisor recovery (${diagnostics})`);
      process.exit(1);
    }
    logger.warn(`[ws] ${larkAppId} ${reason}; rebuilding WSClient ${++rebuilds}/${maxRebuilds} (${diagnostics})`);
    generation++;
    active.close({ force: true });
    if (health.state === 'connected') {
      cycleStarted = now;
      health.attempts = 0;
    }
    changeState(everConnected ? 'reconnecting' : 'connecting');
    try { lifecycle.onRestarting?.(); }
    catch { logger.error(`[ws] ${larkAppId} restart observer failed`); }
    // A synchronous subscriber can revoke ownership during the notification.
    if (!closed) startGeneration();
  }, Math.min(60_000, reconnectLimit, inboundLimit));
  watchdog.unref();

  return {
    getConnectionStatus: () => active.getConnectionStatus(),
    close: options => {
      if (closed) return;
      closed = true;
      clearInterval(watchdog);
      unregister();
      active.close(options);
    },
  };
}
