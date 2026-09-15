import * as Lark from '@larksuiteoapi/node-sdk';
import { ProxyAgent } from 'proxy-agent';
import { logger } from '../../../utils/logger.js';
import { type Brand, sdkDomain } from '../lark-hosts.js';

const LARK_WS_PROXY_ENV_KEYS = [
  'npm_config_https_proxy',
  'NPM_CONFIG_HTTPS_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'npm_config_proxy',
  'NPM_CONFIG_PROXY',
  'all_proxy',
  'ALL_PROXY',
] as const;

function createLarkWsAgent(): ProxyAgent | undefined {
  const hasSecureProxy = LARK_WS_PROXY_ENV_KEYS.some(key => process.env[key]?.trim());
  if (!hasSecureProxy) return undefined;

  const agent = new ProxyAgent();
  const resolveEnvProxy = agent.getProxyForUrl;
  agent.getProxyForUrl = (url, req) => {
    const target = new URL(url);
    if (target.protocol === 'wss:') target.protocol = 'https:';
    else if (target.protocol === 'ws:') target.protocol = 'http:';
    return resolveEnvProxy(target.href, req);
  };
  return agent;
}

/**
 * Start the SDK connection and its failed-state recovery watchdog.
 * The caller owns event registration and business dispatch; this module only
 * passes the supplied dispatcher to the SDK. Returns the original SDK client.
 */
export function startLarkConnection(
  larkAppId: string,
  larkAppSecret: string,
  eventDispatcher: Lark.EventDispatcher,
  brand: Brand = 'feishu',
): Lark.WSClient {
  // Start WSClient
  const wsClient = new Lark.WSClient({
    appId: larkAppId,
    appSecret: larkAppSecret,
    // brand → 长连接域名。国际版租户必须连 larksuite.com，否则收不到任何事件。
    domain: sdkDomain(brand),
    // `proxy-from-env` treats WSS_PROXY as distinct from HTTPS_PROXY, while
    // Lark's preceding Axios bootstrap request uses HTTPS proxy semantics.
    // The custom resolver keeps both phases aligned and still honors NO_PROXY.
    agent: createLarkWsAgent(),
    // Default to warn — the SDK is chatty at info ("client ready", reconnect
    // heartbeats, etc.) and floods pm2 error.log when stderr is the only sink.
    // DEBUG=1 widens the level back to info for troubleshooting.
    loggerLevel: process.env.DEBUG ? Lark.LoggerLevel.info : Lark.LoggerLevel.warn,
    // 主机长断网（夜间合盖睡眠、Wi-Fi 切换、VPN 重连）后，SDK 重连要先用 HTTPS 去
    // 飞书换 ws 接入点，这步会 ENOTFOUND / 15s 超时；重连次数由服务端下发且有限，
    // 耗尽后 SDK 置 terminalError 永久放弃，但进程仍 online、PM2 不会兜底 —— 表现为
    // 「必须手动 botmux restart 才能恢复收消息」。下面两道防线让长连接死后自愈。
    //
    // ① pingTimeout：发 ping 后 30s 内无任何 inbound 帧即掐断 socket，触发 close →
    //    SDK 自身重连。专治 TCP 半开连接（没收到 FIN/RST、close 事件不触发）的静默卡死。
    wsConfig: { pingTimeout: 30 },
    // 重连握手卡死（DNS/代理/NAT）兜底，避免单次握手永久 pending。
    handshakeTimeoutMs: 15_000,
    // 重连过程打日志，便于事后从 `bun run daemon:logs` 复盘（warn 默认看不到这些）。
    onReconnecting: () => logger.warn(`[ws] ${larkAppId} reconnecting…`),
    onReconnected: () => logger.info(`[ws] ${larkAppId} reconnected`),
    onError: (err) => logger.error(`[ws] ${larkAppId} terminal error: ${err.message}`),
  });

  wsClient.start({ eventDispatcher });
  logger.info('Daemon WSClient started');

  // ② SDK 重连耗尽后停在 terminalError（getConnectionStatus().state === 'failed'）并
  //    永久放弃。每分钟探测一次，发现已放弃就 start() 重新发起一轮全新握手 —— start()
  //    会清掉 terminalError 并重新 pullConnectConfig + connect，无需手动重启 daemon。
  //    只在 'failed' 时介入，不打断 SDK 正在进行的 'reconnecting' / 'connecting'。
  let reviving = false;
  const reviveTimer = setInterval(() => {
    if (reviving) return;
    if (wsClient.getConnectionStatus().state !== 'failed') return;
    reviving = true;
    logger.warn(`[ws] ${larkAppId} connection failed (reconnect exhausted), restarting WSClient`);
    wsClient.start({ eventDispatcher })
      .catch(err => logger.error(`[ws] ${larkAppId} WSClient restart failed: ${err?.message ?? err}`))
      .finally(() => { reviving = false; });
  }, 60_000);
  reviveTimer.unref();

  return wsClient;
}
