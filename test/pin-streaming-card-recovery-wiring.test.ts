import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const reconcileRestoredStreamingCardPinsMock = vi.fn();
const loggerWarnMock = vi.fn();

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  class FakeWSClient { start() {} }
  class FakeEventDispatcher { register() {} }
  return {
    Client: FakeClient,
    WSClient: FakeWSClient,
    EventDispatcher: FakeEventDispatcher,
    LoggerLevel: { info: 2 },
  };
});

vi.mock('../src/core/worker-pool.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  reconcileRestoredStreamingCardPins: (...args: any[]) => reconcileRestoredStreamingCardPinsMock(...args),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: (...args: any[]) => loggerWarnMock(...args),
  },
}));

const daemonSource = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
let daemon: typeof import('../src/daemon.js');

beforeAll(async () => {
  daemon = await import('../src/daemon.js');
}, 30_000);

function region(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('startup streaming-card Pin recovery helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('schedules restored Pin recovery in a fire-and-forget microtask', async () => {
    daemon.__testOnly_scheduleRestoredStreamingCardPinRecovery('app-pin');

    expect(reconcileRestoredStreamingCardPinsMock).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(reconcileRestoredStreamingCardPinsMock).toHaveBeenCalledTimes(1);
    expect(reconcileRestoredStreamingCardPinsMock).toHaveBeenCalledWith('app-pin');
  });

  it('does not propagate synchronous Pin recovery failures', async () => {
    reconcileRestoredStreamingCardPinsMock.mockImplementation(() => {
      throw new Error('pin restore boom');
    });

    expect(() => daemon.__testOnly_scheduleRestoredStreamingCardPinRecovery('app-pin')).not.toThrow();

    await Promise.resolve();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('[card-pin] startup restore reconcile failed for app-pin: pin restore boom'),
    );
  });
});

describe('startup restore phase wiring for restored streaming-card Pin recovery', () => {
  it('waits for restore, then marks ready without waiting for the Pin recovery task', async () => {
    const restoreGate = deferred<void>();
    const recoveryGate = deferred<void>();
    const events: string[] = [];
    reconcileRestoredStreamingCardPinsMock.mockImplementation(async (appId: string) => {
      events.push(`pin:${appId}`);
      await recoveryGate.promise;
      events.push(`pin:done:${appId}`);
    });
    await Promise.resolve();
    vi.clearAllMocks();

    const startupPhase = daemon.__testOnly_restoreSessionsAndScheduleStartupRecovery({
      larkAppId: 'app-pin',
      restoreSessions: async () => {
        events.push('restore:start');
        await restoreGate.promise;
        events.push('restore:done');
      },
      markSessionsRestored: () => {
        events.push('ready');
      },
    });

    await Promise.resolve();
    expect(events).toEqual(['restore:start']);
    expect(reconcileRestoredStreamingCardPinsMock).not.toHaveBeenCalled();

    restoreGate.resolve();
    await startupPhase;

    expect(reconcileRestoredStreamingCardPinsMock).toHaveBeenCalledTimes(1);
    expect(reconcileRestoredStreamingCardPinsMock).toHaveBeenCalledWith('app-pin');
    expect(events).toEqual(['restore:start', 'restore:done', 'ready', 'pin:app-pin']);

    recoveryGate.resolve();
    await Promise.resolve();
    expect(events).toEqual(['restore:start', 'restore:done', 'ready', 'pin:app-pin', 'pin:done:app-pin']);
  });

  it('keeps the startDaemon call site after restore as a supplemental source lock', () => {
    const block = region(
      daemonSource,
      'await restoreSessionsAndScheduleStartupRecovery({',
      'if (selfDaemonLarkAppId) {',
    );

    expect(block).toContain('restoreSessions: () => restoreActiveSessions(activeSessions, idempotencyQuarantinedSessionIds),');
    expect(block).toContain('larkAppId: cfg.larkAppId,');
    expect(block).toContain('sessionsRestored = true;');
  });
});
