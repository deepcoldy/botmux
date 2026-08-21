/**
 * Unit tests for the Lark API gate (src/im/lark/api-gate.ts):
 * per-larkAppId token bucket, 429 exponential-backoff retry (honouring
 * Retry-After), circuit breaker with half-open probe recovery, log visibility,
 * abort-signal propagation, and env config resolution.
 *
 * Run:  pnpm vitest run test/lark-api-gate.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: logMocks,
}));

import {
  LarkCircuitOpenError,
  __testOnly_resetLarkGate,
  executeWithLarkGate,
  isRetryableLarkError,
  resolveLarkGateConfig,
} from '../src/im/lark/api-gate.js';

const GATE_ENV_KEYS = [
  'BOTMUX_LARK_QPS',
  'BOTMUX_LARK_GATE_RETRY_MAX_ATTEMPTS',
  'BOTMUX_LARK_GATE_CIRCUIT_FAILURE_THRESHOLD',
  'BOTMUX_LARK_GATE_CIRCUIT_PROBE_INTERVAL_MS',
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of GATE_ENV_KEYS) savedEnv.set(k, process.env[k]);
  for (const k of GATE_ENV_KEYS) delete process.env[k];
  __testOnly_resetLarkGate();
  vi.clearAllMocks();
});

afterEach(() => {
  for (const k of GATE_ENV_KEYS) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv.clear();
});

/** Build an axios-shaped error with a Lark response body. */
function axiosError(
  status: number,
  opts: { code?: number; headers?: Record<string, string>; message?: string } = {},
): any {
  const err: any = new Error(opts.message ?? `Request failed with status code ${status}`);
  err.name = 'AxiosError';
  err.isAxiosError = true;
  err.config = { method: 'post', url: 'https://open.feishu.cn/open-apis/im/v1/messages' };
  err.response = {
    status,
    data: { code: opts.code, msg: 'boom' },
    headers: opts.headers ?? {},
  };
  return err;
}

// ─── Token bucket ─────────────────────────────────────────────────────────────

describe('executeWithLarkGate — token bucket', () => {
  it('serves the first burst (qps tokens) without any wait', async () => {
    process.env.BOTMUX_LARK_QPS = '5';
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockResolvedValue('ok');
      const start = Date.now();
      for (let i = 0; i < 5; i++) {
        await executeWithLarkGate('app-burst', 'op', fn);
      }
      expect(Date.now() - start).toBe(0);
      expect(fn).toHaveBeenCalledTimes(5);
      expect(logMocks.warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('spaces requests beyond burst at the configured qps', async () => {
    process.env.BOTMUX_LARK_QPS = '5';
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockResolvedValue('ok');
      let elapsed = 0;
      const run = (async () => {
        const start = Date.now();
        for (let i = 0; i < 12; i++) {
          await executeWithLarkGate('app-bucket', 'op', fn);
        }
        elapsed = Date.now() - start;
      })();
      // burst=5 covers the first 5 instantly; the remaining 7 wait 200ms each.
      await vi.advanceTimersByTimeAsync(3000);
      await run;
      expect(fn).toHaveBeenCalledTimes(12);
      expect(elapsed).toBeGreaterThanOrEqual(1300);
      expect(elapsed).toBeLessThan(3000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('isolates buckets per larkAppId', async () => {
    process.env.BOTMUX_LARK_QPS = '5';
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockResolvedValue('ok');
      // Saturate app-A in the background (5 instant + 5 × 200ms waits).
      const saturated = (async () => {
        for (let i = 0; i < 10; i++) {
          await executeWithLarkGate('app-A', 'op', fn);
        }
      })();
      await vi.advanceTimersByTimeAsync(0);
      // app-B has its own bucket → served immediately even while app-A waits.
      const startB = Date.now();
      const b = executeWithLarkGate('app-B', 'op', fn);
      await vi.advanceTimersByTimeAsync(0);
      await b;
      expect(Date.now() - startB).toBe(0);
      await vi.advanceTimersByTimeAsync(2000);
      await saturated;
      expect(fn).toHaveBeenCalledTimes(11);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a warn when the bucket wait exceeds 100ms', async () => {
    process.env.BOTMUX_LARK_QPS = '1';
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockResolvedValue('ok');
      const p1 = executeWithLarkGate('app-wait', 'op', fn);
      await vi.advanceTimersByTimeAsync(0);
      await p1;
      const p2 = executeWithLarkGate('app-wait', 'op', fn);
      await vi.advanceTimersByTimeAsync(1000);
      await p2;
      expect(logMocks.warn).toHaveBeenCalledWith(
        expect.stringContaining('[lark-gate] app-wait rate-limit wait 1000ms op=op'),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Retry / backoff ──────────────────────────────────────────────────────────

describe('executeWithLarkGate — retry', () => {
  it('retries a 429 once and then resolves', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn()
        .mockRejectedValueOnce(axiosError(429))
        .mockResolvedValueOnce('ok');
      const p = executeWithLarkGate('app-retry', 'op', fn);
      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000); // backoff 500ms
      await expect(p).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
      expect(logMocks.warn).toHaveBeenCalledWith(
        expect.stringContaining('[lark-gate] app-retry retry 1/3 op=op backoff=500ms'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours the Retry-After header over the computed backoff', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn()
        .mockRejectedValueOnce(axiosError(429, { headers: { 'retry-after': '2' } }))
        .mockResolvedValueOnce('ok');
      const p = executeWithLarkGate('app-ra', 'op', fn);
      await vi.advanceTimersByTimeAsync(0);
      expect(logMocks.warn).toHaveBeenCalledWith(
        expect.stringContaining('backoff=2000ms'),
      );
      // 100ms is not enough — the header asked for 2000ms.
      await vi.advanceTimersByTimeAsync(100);
      await expect(Promise.race([p, Promise.resolve('still-pending')])).resolves.toBe('still-pending');
      await vi.advanceTimersByTimeAsync(2000);
      await expect(p).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours the x-ogw-ratelimit-reset header', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn()
        .mockRejectedValueOnce(axiosError(429, { headers: { 'x-ogw-ratelimit-reset': '3' } }))
        .mockResolvedValueOnce('ok');
      const p = executeWithLarkGate('app-ogw', 'op', fn);
      await vi.advanceTimersByTimeAsync(0);
      expect(logMocks.warn).toHaveBeenCalledWith(
        expect.stringContaining('backoff=3000ms'),
      );
      await vi.advanceTimersByTimeAsync(3000);
      await expect(p).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a deterministic 400', async () => {
    const fn = vi.fn().mockRejectedValue(axiosError(400));
    await expect(executeWithLarkGate('app-400', 'op', fn)).rejects.toThrow('status code 400');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(logMocks.warn).not.toHaveBeenCalled();
  });

  it('gives up after retryMaxAttempts and throws the last error', async () => {
    process.env.BOTMUX_LARK_GATE_RETRY_MAX_ATTEMPTS = '2';
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockRejectedValue(axiosError(429));
      const p = executeWithLarkGate('app-exhaust', 'op', fn);
      // 先挂 rejection 处理器再推进定时器：p 会在 advance 中途 reject，
      // 否则 Node 先报 unhandledRejection（处理器挂载晚于 reject）。
      const expectation = expect(p).rejects.toThrow('status code 429');
      await vi.advanceTimersByTimeAsync(20000); // 500 + 1000 backoffs
      await expectation;
      expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a 4xx carrying a transient Lark business code', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn()
        .mockRejectedValueOnce(axiosError(400, { code: 99991400 }))
        .mockResolvedValueOnce('ok');
      const p = executeWithLarkGate('app-code', 'op', fn);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(p).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a no-response network error', async () => {
    vi.useFakeTimers();
    try {
      const networkErr = Object.assign(new Error('ECONNRESET'), {
        name: 'AxiosError',
        isAxiosError: true,
        config: { method: 'post' },
      });
      const fn = vi.fn()
        .mockRejectedValueOnce(networkErr)
        .mockResolvedValueOnce('ok');
      const p = executeWithLarkGate('app-net', 'op', fn);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(p).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Circuit breaker ──────────────────────────────────────────────────────────

describe('executeWithLarkGate — circuit breaker', () => {
  beforeEach(() => {
    // Deterministic breaker: no retries (each fn call = one failure), low
    // threshold, short probe interval, high qps so the bucket never interferes.
    process.env.BOTMUX_LARK_GATE_RETRY_MAX_ATTEMPTS = '0';
    process.env.BOTMUX_LARK_GATE_CIRCUIT_FAILURE_THRESHOLD = '3';
    process.env.BOTMUX_LARK_GATE_CIRCUIT_PROBE_INTERVAL_MS = '1000';
    process.env.BOTMUX_LARK_QPS = '1000';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens after threshold consecutive failures and fast-fails until the probe interval', async () => {
    const fn = vi.fn().mockRejectedValue(axiosError(500));
    for (let i = 0; i < 3; i++) {
      await expect(executeWithLarkGate('app-c1', 'op', fn)).rejects.toThrow('status code 500');
    }
    const fastFail = await executeWithLarkGate('app-c1', 'op', fn).catch((e: unknown) => e);
    expect(fastFail).toBeInstanceOf(LarkCircuitOpenError);
    expect((fastFail as LarkCircuitOpenError).larkAppId).toBe('app-c1');
    expect(typeof (fastFail as LarkCircuitOpenError).openedAt).toBe('number');
    expect(fn).toHaveBeenCalledTimes(3); // 4th call never reached fn
    expect(logMocks.warn).toHaveBeenCalledWith(
      expect.stringContaining('[lark-gate] app-c1 circuit OPEN after 3 failures op=op'),
    );
  });

  it('half-opens after the probe interval and closes on a successful probe', async () => {
    const failFn = vi.fn().mockRejectedValue(axiosError(500));
    for (let i = 0; i < 3; i++) {
      await expect(executeWithLarkGate('app-c2', 'op', failFn)).rejects.toThrow();
    }
    await vi.advanceTimersByTimeAsync(1000);
    const okFn = vi.fn().mockResolvedValue('ok');
    await expect(executeWithLarkGate('app-c2', 'op', okFn)).resolves.toBe('ok');
    expect(logMocks.info).toHaveBeenCalledWith(
      expect.stringContaining('[lark-gate] app-c2 circuit closed (recovered) op=op'),
    );
    // Closed → subsequent calls pass through without waiting for another probe.
    const another = vi.fn().mockResolvedValue('ok2');
    await expect(executeWithLarkGate('app-c2', 'op', another)).resolves.toBe('ok2');
  });

  it('re-opens when a half-open probe fails', async () => {
    const failFn = vi.fn().mockRejectedValue(axiosError(500));
    for (let i = 0; i < 3; i++) {
      await expect(executeWithLarkGate('app-c3', 'op', failFn)).rejects.toThrow();
    }
    await vi.advanceTimersByTimeAsync(1000);
    await expect(executeWithLarkGate('app-c3', 'op', failFn)).rejects.toThrow('status code 500');
    // Re-opened → fast-fail again.
    await expect(executeWithLarkGate('app-c3', 'op', failFn)).rejects.toBeInstanceOf(LarkCircuitOpenError);
    expect(failFn).toHaveBeenCalledTimes(4); // 3 initial + 1 probe
  });
});

// ─── Abort signal ─────────────────────────────────────────────────────────────

describe('executeWithLarkGate — abort signal', () => {
  it('fast-fails without calling fn when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const fn = vi.fn();
    await expect(
      executeWithLarkGate('app-pre', 'op', fn, { signal: ac.signal }),
    ).rejects.toThrow('aborted');
    expect(fn).not.toHaveBeenCalled();
  });

  it('aborts during the retry backoff when the signal fires', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockRejectedValue(axiosError(429));
      const ac = new AbortController();
      const p = executeWithLarkGate('app-abort', 'op', fn, { signal: ac.signal });
      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1);
      ac.abort();
      await expect(p).rejects.toThrow('lark-gate operation aborted');
      expect(fn).toHaveBeenCalledTimes(1); // no retry after abort
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Error classification ─────────────────────────────────────────────────────

describe('isRetryableLarkError', () => {
  it('classifies axios HTTP statuses', () => {
    expect(isRetryableLarkError(axiosError(429))).toBe(true);
    expect(isRetryableLarkError(axiosError(500))).toBe(true);
    expect(isRetryableLarkError(axiosError(503))).toBe(true);
    expect(isRetryableLarkError(axiosError(400))).toBe(false);
    expect(isRetryableLarkError(axiosError(403))).toBe(false);
    expect(isRetryableLarkError(axiosError(404))).toBe(false);
  });

  it('treats a no-response axios error as transient', () => {
    const err = Object.assign(new Error('socket hang up'), {
      name: 'AxiosError',
      isAxiosError: true,
      config: { method: 'post' },
    });
    expect(isRetryableLarkError(err)).toBe(true);
  });

  it('retries transient Lark business codes even on 4xx', () => {
    for (const code of [230049, 230020, 99991400]) {
      expect(isRetryableLarkError(axiosError(400, { code }))).toBe(true);
    }
  });

  it('extracts the code from a message-tail (code: NNN) suffix', () => {
    expect(isRetryableLarkError(new Error('Failed to send message: boom (code: 230049)'))).toBe(true);
    expect(isRetryableLarkError(new Error('Failed to send message: boom (code: 230002)'))).toBe(false);
  });

  it('does not retry deterministic non-axios errors', () => {
    const withdrawn = new Error('Message om_x has been withdrawn');
    withdrawn.name = 'MessageWithdrawnError';
    expect(isRetryableLarkError(withdrawn)).toBe(false);
    expect(isRetryableLarkError(new Error('plain failure'))).toBe(false);
    expect(isRetryableLarkError('a string error')).toBe(false);
    expect(isRetryableLarkError(null)).toBe(false);
  });
});

// ─── Config ───────────────────────────────────────────────────────────────────

describe('resolveLarkGateConfig', () => {
  it('returns conservative defaults', () => {
    const cfg = resolveLarkGateConfig({} as NodeJS.ProcessEnv);
    expect(cfg.qps).toBe(15);
    expect(cfg.burst).toBe(15);
    expect(cfg.retryMaxAttempts).toBe(3);
    expect(cfg.retryBaseMs).toBe(500);
    expect(cfg.retryMaxMs).toBe(8000);
    expect(cfg.circuitFailureThreshold).toBe(5);
    expect(cfg.circuitWindowMs).toBe(30000);
    expect(cfg.circuitProbeIntervalMs).toBe(30000);
  });

  it('honours env overrides', () => {
    const cfg = resolveLarkGateConfig({
      BOTMUX_LARK_QPS: '8',
      BOTMUX_LARK_GATE_RETRY_MAX_ATTEMPTS: '7',
      BOTMUX_LARK_GATE_CIRCUIT_FAILURE_THRESHOLD: '11',
      BOTMUX_LARK_GATE_CIRCUIT_PROBE_INTERVAL_MS: '45000',
    } as NodeJS.ProcessEnv);
    expect(cfg.qps).toBe(8);
    expect(cfg.burst).toBe(8);
    expect(cfg.retryMaxAttempts).toBe(7);
    expect(cfg.circuitFailureThreshold).toBe(11);
    expect(cfg.circuitProbeIntervalMs).toBe(45000);
  });

  it('falls back to defaults on invalid env values', () => {
    const cfg = resolveLarkGateConfig({
      BOTMUX_LARK_QPS: 'nope',
      BOTMUX_LARK_GATE_RETRY_MAX_ATTEMPTS: '-3',
      BOTMUX_LARK_GATE_CIRCUIT_FAILURE_THRESHOLD: '0',
      BOTMUX_LARK_GATE_CIRCUIT_PROBE_INTERVAL_MS: 'abc',
    } as NodeJS.ProcessEnv);
    expect(cfg.qps).toBe(15);
    expect(cfg.retryMaxAttempts).toBe(3);
    expect(cfg.circuitFailureThreshold).toBe(5);
    expect(cfg.circuitProbeIntervalMs).toBe(30000);
  });
});
