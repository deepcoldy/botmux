import * as Lark from '@larksuiteoapi/node-sdk';
import { Agent as HttpsAgent, globalAgent as defaultHttpsAgent } from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket from 'ws';

type Options = ConstructorParameters<typeof Lark.WSClient>[0];
type PullResult = { ok: boolean; retryable?: boolean; error?: string };

/**
 * Instance-local bridge for SDK 1.73.0 (pinned in package.json). Keep its
 * endpoint discovery, frame codec, ping/pong, fragmented-event cache, ACKs and
 * dispatcher. Replace the dial/retry owner for both SDK start() and its socket
 * close callback. No prototype or shared Axios interceptor is modified.
 */
interface SdkTransport {
  wsConfig: {
    getWS(key: 'connectUrl'): string;
    setWSInstance(socket: WebSocket | null): void;
    updateWs(config: object): void;
  };
  logger: Lark.Logger;
  httpInstance: Pick<Lark.HttpInstance, 'request'>;
  pullConnectConfig(): Promise<PullResult>;
  reConnect(isStart?: boolean): void;
  pingInterval?: NodeJS.Timeout;
  pingLoop(): void;
  clearLiveness(): void;
  communicate(): void;
  safeInvoke(name: string, callback?: (...args: any[]) => void, ...args: any[]): void;
}

interface Hooks {
  onAttempt?(attempt: number): void;
  onAttemptFailed?(attempt: number, reason: string): void;
  onInbound?(): void;
}

interface RetryPolicy {
  attemptTimeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

// Socket errors and SDK exceptions may contain the signed frontier URL or
// proxy credentials. Keep only a protocol error code / HTTP status.
function failureCode(error: unknown, fallback: string): string {
  const err = error as { code?: unknown; response?: { status?: unknown } } | undefined;
  if (typeof err?.code === 'string' && /^E[A-Z0-9_]{1,40}$/.test(err.code)) return `${fallback} (${err.code})`;
  if (typeof err?.response?.status === 'number') return `${fallback} (HTTP ${err.response.status})`;
  return fallback;
}

class AttemptError extends Error {
  constructor(reason: string, readonly retryable = true) { super(reason); }
}

// An attempt owns its endpoint response. An aborted Axios adapter may still
// return (and a custom adapter may ignore signal altogether). Guard the SDK
// configuration commit as well as actually cancelling the HTTP request.
async function discover(sdk: SdkTransport, signal: AbortSignal): Promise<void> {
  const attempt: SdkTransport = Object.create(sdk);
  // The SDK logs the signed frontier URL at debug and the raw server message
  // at error. The owner reports the transport code/reason for each failure.
  attempt.logger = Object.create(sdk.logger);
  attempt.logger.debug = attempt.logger.error = () => {};
  attempt.wsConfig = Object.create(sdk.wsConfig);
  attempt.wsConfig.updateWs = config => { signal.throwIfAborted(); sdk.wsConfig.updateWs(config); };
  let reason = 'endpoint discovery failed';
  attempt.httpInstance = {
    async request<T, R, D>(opts: Lark.HttpRequestOptions<D>): Promise<R> {
      signal.throwIfAborted();
      // Axios may wait for a proxy's CONNECT before it assigns a socket to
      // the HTTP request. Aborting the request alone leaves that TCP socket
      // open. Axios inherits this agent's options when opening its tunnel.
      // Preserve Node's configured TLS / proxy defaults. Node 22's typings
      // omit the extra net.connect option but http.Agent forwards its options.
      const agentOptions = { ...defaultHttpsAgent.options, signal };
      const httpsAgent = new HttpsAgent(agentOptions);
      try {
        const request = { ...opts, signal, httpsAgent };
        const response = await sdk.httpInstance.request<T, R, D>(request);
        signal.throwIfAborted();
        const code = (response as { code?: unknown } | null)?.code;
        if (typeof code === 'number' && code !== 0) reason += ` (code=${code})`;
        return response;
      } catch (error) {
        reason = failureCode(error, reason);
        // SDK logs this message verbatim. Never pass an adapter error through.
        throw new Error(reason);
      } finally {
        httpsAgent.destroy();
      }
    },
  };
  const result = await attempt.pullConnectConfig();
  signal.throwIfAborted();
  if (!result.ok) throw new AttemptError(reason, result.retryable);
}

export function createResilientWsClient(options: Options, hooks: Hooks = {}, policy: RetryPolicy = {}): Lark.WSClient {
  const client = new Lark.WSClient(options);
  const sdk = client as unknown as SdkTransport;
  const closeSdk = client.close;
  const attemptTimeout = policy.attemptTimeoutMs ?? 35_000;
  const baseDelay = policy.baseDelayMs ?? 1_000;
  const maxDelay = policy.maxDelayMs ?? 60_000;
  const timing = { lastConnectTime: 0, nextConnectTime: 0 };
  let state: Lark.WSConnectionState = 'idle';
  let everConnected = false;
  let attempts = 0;
  let pending: AbortController | undefined;
  let retry: NodeJS.Timeout | undefined;
  let socket: WebSocket | undefined;

  function retireSocket(force = true) {
    const previous = socket;
    socket = undefined;
    sdk.wsConfig.setWSInstance(null);
    clearTimeout(sdk.pingInterval);
    sdk.clearLiveness();
    if (!previous) return;
    // Only this client owns these listeners. Keep the permanent error listener:
    // terminate() during CONNECTING emits an asynchronous 'error' (an ErrorEvent on
    // Bun <=1.4.3, an Error on Bun 1.4.4 and Node).
    for (const event of ['open', 'close', 'message', 'pong']) previous.removeAllListeners(event);
    if (previous.readyState === WebSocket.CLOSED) return;
    try {
      if (force) previous.terminate();
      else previous.close();
    } catch { /* best effort on an already closing transport */ }
  }

  function dial(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    // Node ws also waits for CONNECT before the WebSocket owns a socket.
    // Preserve the resolved proxy and tie its pending TCP dial to this flight.
    const agent = options.agent instanceof HttpsProxyAgent
      ? new HttpsProxyAgent(options.agent.proxy, { ...options.agent.connectOpts, headers: options.agent.proxyHeaders, signal })
      : options.agent;
    const ws = new WebSocket(sdk.wsConfig.getWS('connectUrl'), { agent });
    ws.on('error', () => {}); // Also protects deliberate close() and late Bun errors.
    socket = ws;
    return new Promise<void>((resolve, reject) => {
      const handshake = options.handshakeTimeoutMs;
      const timer = handshake && handshake > 0
        ? setTimeout(() => failed(new AttemptError(`handshake timeout after ${handshake}ms`)), handshake) : undefined;
      function cleanup() {
        clearTimeout(timer);
        ws.removeListener('error', onError);
        ws.removeListener('close', onClose);
        ws.removeListener('open', onOpen);
        signal.removeEventListener('abort', onAbort);
      }
      function failed(error: unknown) { cleanup(); reject(error); }
      function onAbort() { failed(signal.reason); }
      function onClose() { failed(new AttemptError('socket closed before handshake')); }
      function onError(error: unknown) { failed(new AttemptError(failureCode(error, 'WebSocket handshake failed'))); }
      function onOpen() {
        cleanup();
        try {
          signal.throwIfAborted();
          sdk.wsConfig.setWSInstance(ws);
          const inbound = () => sdk.safeInvoke('onInbound', hooks.onInbound);
          ws.on('message', inbound);
          ws.on('pong', inbound);
          sdk.communicate();
          sdk.pingLoop();
          resolve();
        } catch (error) { reject(error); }
      }
      signal.addEventListener('abort', onAbort, { once: true });
      ws.once('error', onError);
      ws.once('close', onClose);
      ws.once('open', onOpen);
    });
  }

  function scheduleRetry() {
    const cap = Math.min(maxDelay, baseDelay * 2 ** Math.min(30, Math.max(0, attempts - 1)));
    const delay = Math.floor(cap * (0.5 + Math.random() * 0.5));
    timing.nextConnectTime = Date.now() + delay;
    retry = setTimeout(() => { retry = undefined; void runAttempt(); }, delay);
  }

  async function runAttempt() {
    const flight = new AbortController();
    pending = flight;
    const attempt = ++attempts;
    timing.lastConnectTime = Date.now();
    timing.nextConnectTime = 0;
    const timer = setTimeout(() => flight.abort(new AttemptError(`attempt deadline after ${attemptTimeout}ms`)), attemptTimeout);
    const cancelled = new Promise<never>((_, reject) =>
      flight.signal.addEventListener('abort', () => reject(flight.signal.reason), { once: true }));
    try {
      sdk.safeInvoke('onAttempt', hooks.onAttempt, attempt);
      await Promise.race([discover(sdk, flight.signal).then(() => dial(flight.signal)), cancelled]);
      if (pending !== flight) return;
      if (socket?.readyState !== WebSocket.OPEN) throw new AttemptError('socket closed during handshake');
      const callback = everConnected ? options.onReconnected : options.onReady;
      everConnected = true;
      state = 'connected';
      attempts = 0;
      pending = undefined;
      sdk.safeInvoke('onConnected', callback);
    } catch (error) {
      if (pending !== flight) return;
      flight.abort(error);
      retireSocket();
      const reason = error instanceof AttemptError ? error.message : failureCode(error, 'transport attempt failed');
      sdk.safeInvoke('onAttemptFailed', hooks.onAttemptFailed, attempt, reason);
      if (pending !== flight) return; // an observer may have closed the client
      if ((error instanceof AttemptError && !error.retryable) || options.autoReconnect === false) {
        state = 'failed';
        sdk.safeInvoke('onError', options.onError, new Error(reason));
      } else {
        scheduleRetry();
      }
    } finally {
      clearTimeout(timer);
      if (pending === flight) pending = undefined;
    }
  }

  sdk.reConnect = (initial = false) => {
    if (pending || retry) return;
    if (initial) {
      if (state === 'connected') return;
      attempts = 0;
      state = 'connecting';
      void runAttempt();
    } else if (state === 'connected') {
      retireSocket();
      state = 'reconnecting';
      if (options.autoReconnect === false) { state = 'idle'; return; }
      scheduleRetry();
      sdk.safeInvoke('onReconnecting', options.onReconnecting);
    }
  };
  client.close = (params = {}) => {
    clearTimeout(retry);
    retry = undefined;
    const flight = pending;
    pending = undefined;
    flight?.abort(new AttemptError('client closed'));
    retireSocket(params.force === true);
    state = 'idle';
    attempts = 0;
    timing.nextConnectTime = 0;
    everConnected = false;
    closeSdk.call(client, params); // clear SDK fragment cache and internal timers
  };
  client.getReconnectInfo = () => timing;
  client.getConnectionStatus = () => ({
    state,
    lastConnectTime: timing.lastConnectTime || undefined,
    nextConnectTime: timing.nextConnectTime || undefined,
    reconnectAttempts: attempts,
  });
  return client;
}
