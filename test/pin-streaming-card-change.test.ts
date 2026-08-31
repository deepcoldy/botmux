import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from '../src/utils/logger.js';
import {
  notifyPinStreamingCardChanged,
  registerPinStreamingCardChangeHandler,
  serializePinStreamingCardConfigChange,
} from '../src/services/pin-streaming-card-change.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('pin-streaming-card change handler seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerPinStreamingCardChangeHandler(null as any);
  });

  it('notifies the currently registered handler and allows disposal', () => {
    const calls: Array<[string, boolean]> = [];
    const dispose = registerPinStreamingCardChangeHandler((appId, enabled) => {
      calls.push([appId, enabled]);
    });

    notifyPinStreamingCardChanged('app-one', true);
    expect(calls).toEqual([['app-one', true]]);

    dispose();
    notifyPinStreamingCardChanged('app-one', false);
    expect(calls).toEqual([['app-one', true]]);
  });

  it('replaces the previous handler and only clears the current one when disposed', () => {
    const first = vi.fn();
    const second = vi.fn();

    const disposeFirst = registerPinStreamingCardChangeHandler(first);
    const disposeSecond = registerPinStreamingCardChangeHandler(second);

    notifyPinStreamingCardChanged('app-two', true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('app-two', true);

    disposeFirst();
    notifyPinStreamingCardChanged('app-two', false);
    expect(second).toHaveBeenNthCalledWith(2, 'app-two', false);

    disposeSecond();
    notifyPinStreamingCardChanged('app-two', true);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('swallows handler throws and logs them', () => {
    registerPinStreamingCardChangeHandler(() => {
      throw new Error('boom');
    });

    expect(() => notifyPinStreamingCardChanged('app-three', true)).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('pinStreamingCard change handler failed'));
  });

  it('does not block on async rejection and consumes the rejection with a warning', async () => {
    let resolved = false;
    const handler = vi.fn(async () => {
      await Promise.resolve();
      throw new Error('async boom');
    });

    registerPinStreamingCardChangeHandler(handler);

    expect(() => notifyPinStreamingCardChanged('app-four', false)).not.toThrow();
    expect(handler).toHaveBeenCalledWith('app-four', false);
    expect(logger.warn).not.toHaveBeenCalled();

    await Promise.resolve();
    await Promise.resolve();
    resolved = true;

    expect(resolved).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('async boom'));
  });

  it('releases the per-bot serializer after a failed operation so later writes still run', async () => {
    const calls: string[] = [];

    await expect(
      serializePinStreamingCardConfigChange('app-five', async () => {
        calls.push('first');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(
      serializePinStreamingCardConfigChange('app-five', async () => {
        calls.push('second');
      }),
    ).resolves.toBeUndefined();

    expect(calls).toEqual(['first', 'second']);
  });

  it('allows different larkAppIds to proceed independently while one bot is blocked', async () => {
    const appAStarted = deferred();
    const releaseAppA = deferred();
    const order: string[] = [];

    const blockedA = serializePinStreamingCardConfigChange('app-A', async () => {
      order.push('A:start');
      appAStarted.resolve();
      await releaseAppA.promise;
      order.push('A:end');
    });

    await appAStarted.promise;

    await expect(
      serializePinStreamingCardConfigChange('app-B', async () => {
        order.push('B:start');
        order.push('B:end');
      }),
    ).resolves.toBeUndefined();

    expect(order).toEqual(['A:start', 'B:start', 'B:end']);

    releaseAppA.resolve();
    await expect(blockedA).resolves.toBeUndefined();
    expect(order).toEqual(['A:start', 'B:start', 'B:end', 'A:end']);
  });
});
