import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyLarkError,
  LarkApiError,
  extractLarkErrorShape,
} from '../src/im/lark/error-classify.js';
import { createResilientPoller } from '../src/services/resilient-poller.js';

describe('classifyLarkError', () => {
  it('classifies axios HTTP 400 with response.data.code 230002 as rejoinable permanent (the 19-day incident)', () => {
    const err = {
      message: 'Request failed with status code 400',
      response: { status: 400, data: { code: 230002, msg: 'Bot/User can NOT be out of the chat.' } },
    };
    const e = classifyLarkError(err);
    expect(e).toBeInstanceOf(LarkApiError);
    expect(e.classification).toBe('permanent');
    expect(e.larkCode).toBe(230002);
    expect(e.httpStatus).toBe(400);
    expect(e.rejoinable).toBe(true);
  });

  it('classifies business-error Error with code in message text', () => {
    const e = classifyLarkError(new Error('Failed to list chat messages: bad (code: 230002)'));
    expect(e.classification).toBe('permanent');
    expect(e.larkCode).toBe(230002);
  });

  it('classifies 429/5xx as transient', () => {
    expect(classifyLarkError({ response: { status: 429 } }).classification).toBe('transient');
    expect(classifyLarkError({ response: { status: 503, data: {} } }).classification).toBe('transient');
  });

  it('classifies 401/403/404 as permanent (403 rejoinable)', () => {
    expect(classifyLarkError({ response: { status: 401 } }).classification).toBe('permanent');
    expect(classifyLarkError({ response: { status: 403 } }).rejoinable).toBe(true);
    expect(classifyLarkError({ response: { status: 404 } }).classification).toBe('permanent');
  });

  it('treats known rate-limit business codes as transient even with HTTP 200', () => {
    const e = classifyLarkError(new Error('rate limited (code: 99991661)'));
    expect(e.classification).toBe('transient');
  });

  it('treats unknown errors as transient (fail-safe, never over-circuits)', () => {
    expect(classifyLarkError(new Error('ECONNRESET weird thing')).classification).toBe('transient');
  });

  it('passes through already-classified errors and reads shapes without throwing on junk input', () => {
    const original = classifyLarkError({ response: { status: 404 } });
    expect(classifyLarkError(original)).toBe(original);
    expect(extractLarkErrorShape(null).message).toBe('null');
    expect(extractLarkErrorShape('string error').message).toBe('string error');
  });
});

describe('createResilientPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function permErr(code = 230002) {
    return { response: { status: 400, data: { code } } };
  }

  it('suspends a key after permanentThreshold permanent errors, stops calling onTick, and alerts exactly once', async () => {
    const tick = vi.fn(async () => {
      throw permErr();
    });
    const alert = vi.fn();
    const p = createResilientPoller({
      intervalMs: 30_000,
      permanentThreshold: 3,
      probeIntervalMs: 1_000_000,
      classify: classifyLarkError,
      listKeys: () => ['chat-a'],
      onTick: tick,
      onAlert: alert,
      now: () => 1_000_000,
    });

    await p.runOnce();
    await p.runOnce();
    expect(p.stateFor('chat-a')!.suspended).toBe(false);
    await p.runOnce();
    expect(p.stateFor('chat-a')!.suspended).toBe(true);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0]).toBe('chat-a');
    expect(alert.mock.calls[0][1].classification).toBe('permanent');

    tick.mockClear();
    await p.runOnce();
    expect(tick).not.toHaveBeenCalled();
  });

  it('auto-resumes when a suspended-key probe succeeds and fires onResume', async () => {
    let fail = true;
    const tick = vi.fn(async () => {
      if (fail) throw permErr();
    });
    const resume = vi.fn();
    let nowMs = 0;
    const p = createResilientPoller({
      intervalMs: 30_000,
      permanentThreshold: 1,
      probeIntervalMs: 600_000,
      classify: classifyLarkError,
      listKeys: () => ['a'],
      onTick: tick,
      onResume: resume,
      now: () => nowMs,
    });
    await p.runOnce();
    expect(p.stateFor('a')!.suspended).toBe(true);

    nowMs = 599_000;
    await p.runOnce();
    expect(tick).toHaveBeenCalledTimes(1);
    nowMs = 600_000;
    fail = false;
    await p.runOnce();
    expect(p.stateFor('a')!.suspended).toBe(false);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith('a');
  });

  it('backs off exponentially on transient errors and returns to healthy after one success', async () => {
    let n = 0;
    const tick = vi.fn(async () => {
      n += 1;
      if (n <= 2) throw { response: { status: 503 } };
    });
    let nowMs = 0;
    const p = createResilientPoller({
      intervalMs: 30_000,
      maxBackoffMs: 300_000,
      jitterRatio: 0,
      classify: classifyLarkError,
      listKeys: () => ['a'],
      onTick: tick,
      now: () => nowMs,
    });
    await p.runOnce();
    await p.runOnce();
    expect(tick).toHaveBeenCalledTimes(1);
    nowMs = 60_000;
    await p.runOnce();
    expect(tick).toHaveBeenCalledTimes(2);
    nowMs = 180_000;
    await p.runOnce();
    expect(tick).toHaveBeenCalledTimes(3);
    const s = p.stateFor('a')!;
    expect(s.transientStreak).toBe(0);
    expect(s.backoffUntil).toBe(0);
  });

  it('clears state for keys that disappear from listKeys (listener disabled/deleted)', async () => {
    let keys: string[] = ['a', 'b'];
    const p = createResilientPoller({
      intervalMs: 30_000,
      classify: classifyLarkError,
      listKeys: () => keys,
      onTick: async () => {},
    });
    await p.runOnce();
    expect(p.stateFor('a')).toBeDefined();
    keys = ['a'];
    await p.runOnce();
    expect(p.stateFor('b')).toBeUndefined();
  });

  it('start/stop arms and clears the timer; a failing alert does not break the state machine', async () => {
    const setT = vi.fn(() => 1 as unknown as NodeJS.Timeout);
    const clearT = vi.fn();
    const p = createResilientPoller({
      intervalMs: 30_000,
      permanentThreshold: 1,
      classify: classifyLarkError,
      listKeys: () => ['a'],
      onTick: async () => {
        throw permErr();
      },
      onAlert: () => {
        throw new Error('alert channel down');
      },
      setTimeout: setT,
      clearTimeout: clearT,
    });
    p.start();
    expect(setT).toHaveBeenCalledTimes(1);
    await p.runOnce();
    expect(p.stateFor('a')!.suspended).toBe(true);
    p.stop();
    expect(clearT).toHaveBeenCalled();
  });
});
