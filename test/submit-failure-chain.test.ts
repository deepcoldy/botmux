import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelSubmitFailureChainForTerminal,
  createSubmitFailureChainController,
  submitFailureChainKeyOf,
  type SubmitFailureChainKey,
} from '../src/services/submit-failure-chain.js';

const key = (over: Partial<SubmitFailureChainKey> = {}): SubmitFailureChainKey => ({
  turnId: 'turn-1',
  dispatchAttempt: 1,
  cliGeneration: 3,
  ...over,
});

describe('submitFailureChainKeyOf', () => {
  it('distinguishes turnId, dispatchAttempt and cliGeneration', () => {
    const base = key();
    expect(submitFailureChainKeyOf(base)).toBe(submitFailureChainKeyOf({ ...base }));
    expect(submitFailureChainKeyOf({ ...base, turnId: 'turn-2' })).not.toBe(submitFailureChainKeyOf(base));
    expect(submitFailureChainKeyOf({ ...base, dispatchAttempt: 2 })).not.toBe(submitFailureChainKeyOf(base));
    expect(submitFailureChainKeyOf({ ...base, cliGeneration: 4 })).not.toBe(submitFailureChainKeyOf(base));
  });
});

describe('createSubmitFailureChainController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('arms a chain that fires after the delay and forgets the key', async () => {
    const controller = createSubmitFailureChainController();
    const fn = vi.fn();
    expect(controller.schedule(key(), 20_000, fn)).toEqual({ armed: true, replaced: false });
    expect(controller.has(key())).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(controller.has(key())).toBe(false);
  });

  it('replaces a live chain for the same key instead of stacking a second timer', () => {
    const controller = createSubmitFailureChainController();
    const first = vi.fn();
    const second = vi.fn();
    expect(controller.schedule(key(), 20_000, first)).toEqual({ armed: true, replaced: false });
    expect(controller.schedule(key(), 20_000, second)).toEqual({ armed: false, replaced: true });
    expect(controller.size()).toBe(1);
    vi.advanceTimersByTime(20_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('tracks an in-flight callback and preserves a replacement scheduled before it settles', async () => {
    const controller = createSubmitFailureChainController();
    let finishFirst: (() => void) | undefined;
    let firstWasCurrentAfterReplacement: boolean | undefined;
    const first = vi.fn((isCurrent: () => boolean) => new Promise<void>((resolve) => {
      finishFirst = () => {
        firstWasCurrentAfterReplacement = isCurrent();
        resolve();
      };
    }));
    const second = vi.fn();

    controller.schedule(key(), 20_000, first);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(controller.has(key())).toBe(true);

    expect(controller.schedule(key(), 20_000, second)).toEqual({ armed: false, replaced: true });
    finishFirst?.();
    await Promise.resolve();
    expect(firstWasCurrentAfterReplacement).toBe(false);
    expect(controller.has(key())).toBe(true);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(second).toHaveBeenCalledTimes(1);
    expect(controller.has(key())).toBe(false);
  });

  it('keeps independent chains for distinct keys', () => {
    const controller = createSubmitFailureChainController();
    const fnA = vi.fn();
    const fnB = vi.fn();
    controller.schedule(key(), 20_000, fnA);
    controller.schedule(key({ turnId: 'turn-2' }), 20_000, fnB);
    expect(controller.size()).toBe(2);
    vi.advanceTimersByTime(20_000);
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);
  });

  it('cancel clears a live chain before it fires', () => {
    const controller = createSubmitFailureChainController();
    const fn = vi.fn();
    controller.schedule(key(), 20_000, fn);
    expect(controller.cancel(key())).toBe(true);
    expect(controller.has(key())).toBe(false);
    vi.advanceTimersByTime(20_000);
    expect(fn).not.toHaveBeenCalled();
    expect(controller.cancel(key())).toBe(false);
  });

  it('clear cancels every live chain', () => {
    const controller = createSubmitFailureChainController();
    const fn = vi.fn();
    controller.schedule(key(), 20_000, fn);
    controller.schedule(key({ turnId: 'turn-2' }), 20_000, fn);
    controller.clear();
    vi.advanceTimersByTime(20_000);
    expect(fn).not.toHaveBeenCalled();
    expect(controller.size()).toBe(0);
  });

  it('keeps an identity-less warning chain bounded to one replacement and one warning', async () => {
    const controller = createSubmitFailureChainController();
    const unscoped = key({ turnId: 'unscoped-1', dispatchAttempt: undefined });
    let warnings = 0;
    const warn = () => {
      warnings++;
    };

    controller.schedule(unscoped, 20_000, warn);
    controller.schedule(unscoped, 20_000, warn);
    expect(controller.size()).toBe(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(warnings).toBe(1);
    expect(controller.size()).toBe(0);
  });

  it('cancels an ordinary completed transcript turn before its warning timer fires', async () => {
    const controller = createSubmitFailureChainController();
    const warning = vi.fn();
    controller.schedule(key({ dispatchAttempt: undefined }), 20_000, warning);

    expect(cancelSubmitFailureChainForTerminal(
      controller,
      { turnId: 'turn-1', dispatchAttempt: undefined },
      3,
    )).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(warning).not.toHaveBeenCalled();
    expect(controller.size()).toBe(0);
  });

  it('does not schedule an ordinary warning after its terminal arrived first', async () => {
    const controller = createSubmitFailureChainController();
    const warning = vi.fn();
    const ordinary = key({ dispatchAttempt: undefined });

    expect(cancelSubmitFailureChainForTerminal(
      controller,
      { turnId: 'turn-1', dispatchAttempt: undefined },
      3,
    )).toBe(false);
    expect(controller.schedule(ordinary, 20_000, warning)).toEqual({
      armed: false,
      replaced: false,
    });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(warning).not.toHaveBeenCalled();
    expect(controller.size()).toBe(0);
  });

  it('does not schedule durable attempt N after its exact terminal arrived first', async () => {
    const controller = createSubmitFailureChainController();
    const warning = vi.fn();

    cancelSubmitFailureChainForTerminal(
      controller,
      { turnId: 'turn-1', dispatchAttempt: 1 },
      3,
    );
    expect(controller.schedule(key({ dispatchAttempt: 1 }), 20_000, warning)).toEqual({
      armed: false,
      replaced: false,
    });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(warning).not.toHaveBeenCalled();
  });

  it('does not let attempt N terminal block N+1', async () => {
    const controller = createSubmitFailureChainController();
    const warning = vi.fn();

    cancelSubmitFailureChainForTerminal(
      controller,
      { turnId: 'turn-1', dispatchAttempt: 1 },
      3,
    );
    expect(controller.schedule(key({ dispatchAttempt: 2 }), 20_000, warning)).toEqual({
      armed: true,
      replaced: false,
    });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('does not let a prior-generation terminal block the same attempt in a new generation', async () => {
    const controller = createSubmitFailureChainController();
    const warning = vi.fn();

    cancelSubmitFailureChainForTerminal(
      controller,
      { turnId: 'turn-1', dispatchAttempt: 1 },
      3,
    );
    expect(controller.schedule(
      key({ dispatchAttempt: 1, cliGeneration: 4 }),
      20_000,
      warning,
    )).toEqual({ armed: true, replaced: false });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('bounds terminal receipts and clears them with the generation state', () => {
    const controller = createSubmitFailureChainController();
    const warning = vi.fn();
    for (let index = 0; index < 1_025; index++) {
      cancelSubmitFailureChainForTerminal(
        controller,
        { turnId: `turn-${index}`, dispatchAttempt: 1 },
        3,
      );
    }

    expect(controller.schedule(
      key({ turnId: 'turn-0', dispatchAttempt: 1 }),
      20_000,
      warning,
    )).toEqual({ armed: true, replaced: false });
    expect(controller.schedule(
      key({ turnId: 'turn-1024', dispatchAttempt: 1 }),
      20_000,
      warning,
    )).toEqual({ armed: false, replaced: false });

    controller.clear();
    expect(controller.schedule(
      key({ turnId: 'turn-1024', dispatchAttempt: 1 }),
      20_000,
      warning,
    )).toEqual({ armed: true, replaced: false });
  });

  it('cancels only the exact durable attempt when a completed turn is drained', async () => {
    const controller = createSubmitFailureChainController();
    const attemptOneWarning = vi.fn();
    const attemptTwoWarning = vi.fn();
    const unrelatedWarning = vi.fn();
    controller.schedule(key({ dispatchAttempt: 1 }), 20_000, attemptOneWarning);
    controller.schedule(key({ dispatchAttempt: 2 }), 20_000, attemptTwoWarning);
    controller.schedule(key({ turnId: 'turn-2', dispatchAttempt: 1 }), 20_000, unrelatedWarning);

    expect(cancelSubmitFailureChainForTerminal(
      controller,
      { turnId: 'turn-1', dispatchAttempt: 1 },
      3,
    )).toBe(true);
    expect(controller.size()).toBe(2);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(attemptOneWarning).not.toHaveBeenCalled();
    expect(attemptTwoWarning).toHaveBeenCalledTimes(1);
    expect(unrelatedWarning).toHaveBeenCalledTimes(1);
    expect(controller.size()).toBe(0);
  });
});
