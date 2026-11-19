import { randomUUID } from 'node:crypto';
import * as Lark from '@larksuiteoapi/node-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResilientWsClient } from '../src/im/lark/transport/resilient-ws-client.js';

const dispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.fatal });
const fatalResponse = { code: 514, data: {} };
const clients: Lark.WSClient[] = [];

function fixture(request: Lark.HttpInstance['request'], hooks = {}, overrides: Partial<ConstructorParameters<typeof Lark.WSClient>[0]> = {}) {
  const client = createResilientWsClient({
    appId: 'cli_0000000000000000', appSecret: randomUUID(),
    httpInstance: { ...Lark.defaultHttpInstance, request },
    loggerLevel: Lark.LoggerLevel.fatal, ...overrides,
  }, hooks, { attemptTimeoutMs: 200, baseDelayMs: 100, maxDelayMs: 250 });
  clients.push(client);
  return client;
}

async function advance(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  // Bun's fake clock runs the due timers synchronously. Let the SDK's nested
  // discovery/Promise.race continuations finish before inspecting the result.
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe('Lark SDK transport retry ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => {
    for (const client of clients.splice(0)) client.close({ force: true });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('bounds one whole attempt and fences an aborted adapter that returns after a newer attempt', async () => {
    let release!: (value: unknown) => void;
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValueOnce(fatalResponse);
    const onAttemptFailed = vi.fn();
    const client = fixture(request, { onAttemptFailed });
    await client.start({ eventDispatcher: dispatcher });
    await client.start({ eventDispatcher: dispatcher });
    expect(request).toHaveBeenCalledTimes(1);
    const signal = request.mock.calls[0][0].signal;
    await advance(200);
    expect(signal.aborted).toBe(true);
    expect(onAttemptFailed).toHaveBeenCalledWith(1, 'attempt deadline after 200ms');
    // A duplicate start during backoff must not bypass the scheduled retry.
    await client.start({ eventDispatcher: dispatcher });
    expect(request).toHaveBeenCalledTimes(1);
    await advance(50);
    expect(request).toHaveBeenCalledTimes(2);
    expect(client.getConnectionStatus().state).toBe('failed');
    const staleData = vi.fn();
    release({ code: 0, get data() { staleData(); return {}; } });
    await advance();
    expect(staleData).not.toHaveBeenCalled();
    expect(client.getConnectionStatus().state).toBe('failed');
  });

  it('backs off with bounded jitter across failures and stops all work on close', async () => {
    const request = vi.fn().mockRejectedValue(Object.assign(new Error('adapter-specific detail'), { code: 'ECONNRESET' }));
    const onAttempt = vi.fn();
    const onAttemptFailed = vi.fn();
    const client = fixture(request, { onAttempt, onAttemptFailed });
    await client.start({ eventDispatcher: dispatcher });
    await advance();
    for (const delay of [50, 100, 125, 125]) {
      expect(client.getReconnectInfo().nextConnectTime - Date.now()).toBe(delay);
      await advance(delay);
    }
    expect(onAttempt.mock.calls.flat()).toEqual([1, 2, 3, 4, 5]);
    expect(onAttemptFailed).toHaveBeenLastCalledWith(5, 'endpoint discovery failed (ECONNRESET)');
    client.close({ force: true });
    await advance(10_000);
    expect(request).toHaveBeenCalledTimes(5);
    expect(client.getConnectionStatus().state).toBe('idle');
  });

  it('keeps trying after a synchronous dial exception, then reports a terminal endpoint error', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      code: 0, data: { URL: 'invalid URL', ClientConfig: { PingInterval: 30, ReconnectCount: 0 } },
    }).mockResolvedValue(fatalResponse);
    const onAttemptFailed = vi.fn();
    const client = fixture(request, { onAttemptFailed });
    await client.start({ eventDispatcher: dispatcher });
    await advance();
    expect(onAttemptFailed.mock.calls[0][0]).toBe(1);
    await advance(50);
    expect(onAttemptFailed).toHaveBeenLastCalledWith(2, 'endpoint discovery failed (code=514)');
    expect(client.getConnectionStatus().state).toBe('failed');
    await advance(10_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('omits signed URLs and raw gateway messages from discovery logs; a throwing observer cannot stop retry', async () => {
    const marker = randomUUID();
    const log = vi.fn();
    const request = vi.fn().mockResolvedValueOnce({
      code: 0, data: { URL: marker, ClientConfig: { PingInterval: 30 } },
    }).mockResolvedValue({ ...fatalResponse, msg: marker });
    const reasons: string[] = [];
    const client = fixture(request, {
      onAttemptFailed(_attempt: number, reason: string) {
        reasons.push(reason);
        throw new Error('observer failed');
      },
    }, {
      logger: { trace: log, debug: log, info: log, warn: log, error: log },
      loggerLevel: Lark.LoggerLevel.debug,
    });
    await client.start({ eventDispatcher: dispatcher });
    await advance();
    await advance(50);
    expect(request).toHaveBeenCalledTimes(2);
    expect(reasons).toHaveLength(2);
    expect(reasons[1]).toBe('endpoint discovery failed (code=514)');
    expect(JSON.stringify([...log.mock.calls, reasons])).not.toContain(marker);
    expect(client.getConnectionStatus().state).toBe('failed');
  });

  it('does not revive a manually closed attempt, even across a fresh start', async () => {
    let release!: (value: unknown) => void;
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockImplementation(() => new Promise(() => {}));
    const onAttemptFailed = vi.fn();
    const client = fixture(request, { onAttemptFailed });
    await client.start({ eventDispatcher: dispatcher });
    client.close({ force: true });
    await client.start({ eventDispatcher: dispatcher });
    release(fatalResponse);
    await advance();
    expect(onAttemptFailed).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
    expect(client.getConnectionStatus()).toMatchObject({ state: 'connecting', reconnectAttempts: 1 });
  });
});
