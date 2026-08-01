/**
 * Unit tests for the worker-side stuck-warning key-injection guard.
 *
 * Covers (PR #559 review round 7 — P1 regression fix):
 *   1. expected lifetime missing/unequal → no keys written, only expired
 *   2. fresh capture returns null → no keys written, only expired
 *   3. fresh capture throws → no keys written, only expired
 *   4. backend replaced DURING capture (live getter re-read) → expired
 *   5. lifetime changed DURING capture (live getter re-read) → expired
 *   6. page type no longer matches after capture → expired
 *   7. write success → only delivered, keys written
 *   8. write returns false → only failed
 *   9. write throws → only failed
 *  10. happy path → delivered
 *  11. expired carries correct nonce/turnId/dispatchAttempt
 *
 * Run:  pnpm vitest run test/stuck-key-guard.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { processStuckWarningTuiKeys, shouldRearmStuckDetector, type StuckKeyGuardDeps, type StuckKeyGuardMessage } from '../src/utils/stuck-key-guard.js';

const LEVEL_1_SNAPSHOT = 'Hooks\n\n⚠ 1 hook needs review before it can run.\n\nPress t to trust all; enter to review hooks; esc to close';

interface MutableState {
  backend: any;
  lifetime: number;
}

function makeDeps(state: MutableState, overrides?: Partial<StuckKeyGuardDeps>): StuckKeyGuardDeps {
  return {
    getBackend: () => state.backend,
    getCurrentLifetime: () => state.lifetime,
    renderCols: 80,
    renderRows: 24,
    turnId: 'turn_1',
    dispatchAttempt: 1,
    capture: vi.fn(async () => ({ content: LEVEL_1_SNAPSHOT })),
    match: vi.fn((snap: string) => (snap.includes('trust all') ? 'hook review level 1' : undefined)),
    writeKeys: vi.fn(async () => true),
    sendExpired: vi.fn(),
    sendDelivered: vi.fn(),
    sendFailed: vi.fn(),
    log: vi.fn(),
    ...overrides,
  };
}

function makeMsg(overrides?: Partial<StuckKeyGuardMessage>): StuckKeyGuardMessage {
  return {
    stuckNonce: 1,
    stuckPageType: 'hook review level 1',
    stuckCliLifetime: 1,
    keys: ['Escape'],
    isFinal: true,
    ...overrides,
  };
}

describe('processStuckWarningTuiKeys (worker fail-closed guard)', () => {
  it('lifetime missing → expired, no keys written', async () => {
    const state = { backend: {}, lifetime: 1 };
    const deps = makeDeps(state);
    const msg = makeMsg({ stuckCliLifetime: undefined });
    const result = await processStuckWarningTuiKeys(msg, deps);
    expect(result).toEqual({ sent: 'expired', wroteKeys: false });
    expect(deps.sendExpired).toHaveBeenCalledTimes(1);
    expect(deps.sendDelivered).not.toHaveBeenCalled();
    expect(deps.writeKeys).not.toHaveBeenCalled();
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it('lifetime unequal → expired, no keys written', async () => {
    const state = { backend: {}, lifetime: 2 };
    const deps = makeDeps(state);
    const msg = makeMsg({ stuckCliLifetime: 1 });
    const result = await processStuckWarningTuiKeys(msg, deps);
    expect(result).toEqual({ sent: 'expired', wroteKeys: false });
    expect(deps.sendExpired).toHaveBeenCalledTimes(1);
    expect(deps.sendDelivered).not.toHaveBeenCalled();
    expect(deps.writeKeys).not.toHaveBeenCalled();
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it('capture returns null → expired, no keys written', async () => {
    const state = { backend: {}, lifetime: 1 };
    const deps = makeDeps(state, { capture: vi.fn(async () => null) });
    const msg = makeMsg();
    const result = await processStuckWarningTuiKeys(msg, deps);
    expect(result).toEqual({ sent: 'expired', wroteKeys: false });
    expect(deps.sendExpired).toHaveBeenCalledTimes(1);
    expect(deps.sendDelivered).not.toHaveBeenCalled();
    expect(deps.writeKeys).not.toHaveBeenCalled();
  });

  it('capture returns content:null → expired, no keys written', async () => {
    const state = { backend: {}, lifetime: 1 };
    const deps = makeDeps(state, { capture: vi.fn(async () => ({ content: null })) });
    const msg = makeMsg();
    const result = await processStuckWarningTuiKeys(msg, deps);
    expect(result).toEqual({ sent: 'expired', wroteKeys: false });
    expect(deps.sendExpired).toHaveBeenCalledTimes(1);
    expect(deps.writeKeys).not.toHaveBeenCalled();
  });

  it('capture throws → expired, no keys written', async () => {
    const state = { backend: {}, lifetime: 1 };
    const deps = makeDeps(state, { capture: vi.fn(async () => { throw new Error('boom'); }) });
    const msg = makeMsg();
    const result = await processStuckWarningTuiKeys(msg, deps);
    expect(result).toEqual({ sent: 'expired', wroteKeys: false });
    expect(deps.sendExpired).toHaveBeenCalledTimes(1);
    expect(deps.sendDelivered).not.toHaveBeenCalled();
    expect(deps.writeKeys).not.toHaveBeenCalled();
  });

  it('backend null → expired (capture skipped, no keys written)', async () => {
    const state = { backend: null, lifetime: 1 };
    const deps = makeDeps(state);
    const msg = makeMsg();
    const result = await processStuckWarningTuiKeys(msg, deps);
    expect(result).toEqual({ sent: 'expired', wroteKeys: false });
    expect(deps.sendExpired).toHaveBeenCalledTimes(1);
    expect(deps.capture).not.toHaveBeenCalled();
    expect(deps.writeKeys).not.toHaveBeenCalled();
  });

  it('backend replaced DURING capture → expired, no keys written (live re-read)', async () => {
    const oldBackend = {};
    const newBackend = {};
    const state = { backend: oldBackend, lifetime: 1 };
    // Capture mutates the live state to simulate a CLI restart mid-capture.
    const capture = vi.fn(async () => {
      state.backend = newBackend;
      return { content: LEVEL_1_SNAPSHOT };
    });
    const deps = makeDeps(state, { capture });
    const msg = makeMsg();
    const result = await processStuckWarningTuiKeys(msg, deps);
    expect(result).toEqual({ sent: 'expired', wroteKeys: false });
    expect(deps.sendExpired).toHaveBeenCalledTimes(1);
    expect(deps.sendDelivered).not.toHaveBeenCalled();
    expect(deps.writeKeys).not.toHaveBeenCalled();
  });

  it('lifetime changed DURING capture → expired, no keys written (live re-read)', async () => {
    const state = { backend: {}, lifetime: 1 };
    const capture = vi.fn(async () => {
      state.lifetime = 2; // CLI restarted, new lifetime
      return { content: LEVEL_1_SNAPSHOT };
    });
    const deps = makeDeps(state, { capture });
    const msg = makeMsg();
    const result = await processStuckWarningTuiKeys(msg, deps);
    expect(result).toEqual({ sent: 'expired', wroteKeys: false });
    expect(deps.sendExpired).toHaveBeenCalledTimes(1);
    expect(deps.sendDelivered).not.toHaveBeenCalled();
    expect(deps.writeKeys).not.toHaveBeenCalled();
  });

  it('page type no longer matches after capture → expired, no keys written', async () => {
    const state = { backend: {}, lifetime: 1 };
    const deps = makeDeps(state, {
      capture: vi.fn(async () => ({ content: 'Some other screen\nnot a hook review' })),
      match: vi.fn(() => undefined),
    });
    const msg = makeMsg();
    const result = await processStuckWarningTuiKeys(msg, deps);
    expect(result).toEqual({ sent: 'expired', wroteKeys: false });
    expect(deps.sendExpired).toHaveBeenCalledTimes(1);
    expect(deps.sendDelivered).not.toHaveBeenCalled();
    expect(deps.writeKeys).not.toHaveBeenCalled();
  });

  it('write success → delivered, keys written', async () => {
    const state = { backend: {}, lifetime: 1 };
    const deps = makeDeps(state);
    const msg = makeMsg();
    const result = await processStuckWarningTuiKeys(msg, deps);
    expect(result).toEqual({ sent: 'delivered', wroteKeys: true });
    expect(deps.sendDelivered).toHaveBeenCalledTimes(1);
    expect(deps.sendExpired).not.toHaveBeenCalled();
    expect(deps.writeKeys).toHaveBeenCalledTimes(1);
    expect(deps.writeKeys).toHaveBeenCalledWith(['Escape'], true);
  });

  it('write returns false → failed, keys not written', async () => {
    const state = { backend: {}, lifetime: 1 };
    const deps = makeDeps(state, { writeKeys: vi.fn(async () => false) });
    const msg = makeMsg();
    const result = await processStuckWarningTuiKeys(msg, deps);
    expect(result).toEqual({ sent: 'failed', wroteKeys: false });
    expect(deps.sendFailed).toHaveBeenCalledTimes(1);
    expect(deps.sendExpired).not.toHaveBeenCalled();
    expect(deps.sendDelivered).not.toHaveBeenCalled();
    expect(deps.writeKeys).toHaveBeenCalledTimes(1);
  });

  it('write throws → failed, keys not written', async () => {
    const state = { backend: {}, lifetime: 1 };
    const deps = makeDeps(state, { writeKeys: vi.fn(async () => { throw new Error('write failed'); }) });
    const msg = makeMsg();
    const result = await processStuckWarningTuiKeys(msg, deps);
    expect(result).toEqual({ sent: 'failed', wroteKeys: false });
    expect(deps.sendFailed).toHaveBeenCalledTimes(1);
    expect(deps.sendExpired).not.toHaveBeenCalled();
    expect(deps.sendDelivered).not.toHaveBeenCalled();
    expect(deps.writeKeys).toHaveBeenCalledTimes(1);
  });

  it('happy path: all guards pass → delivered with correct nonce/turnId/dispatchAttempt', async () => {
    const state = { backend: {}, lifetime: 1 };
    const sendDelivered = vi.fn();
    const deps = makeDeps(state, { sendDelivered });
    const msg = makeMsg({ stuckNonce: 42, keys: ['t'], isFinal: true });
    await processStuckWarningTuiKeys(msg, deps);
    expect(sendDelivered).toHaveBeenCalledTimes(1);
    expect(sendDelivered).toHaveBeenCalledWith(42, 'turn_1', 1);
  });

  it('expired carries correct nonce/turnId/dispatchAttempt', async () => {
    const state = { backend: {}, lifetime: 99 };
    const sendExpired = vi.fn();
    const deps = makeDeps(state, { sendExpired });
    const msg = makeMsg({ stuckNonce: 7, stuckCliLifetime: 1 });
    await processStuckWarningTuiKeys(msg, deps);
    expect(sendExpired).toHaveBeenCalledWith(7, 'turn_1', 1);
  });
});

describe('shouldRearmStuckDetector (worker rearm decision)', () => {
  it('rearm=true + wroteKeys=false → false (expired Enter must NOT re-arm)', () => {
    expect(shouldRearmStuckDetector(true, false)).toBe(false);
  });

  it('rearm=true + wroteKeys=true → true (successful Enter re-arms once)', () => {
    expect(shouldRearmStuckDetector(true, true)).toBe(true);
  });

  it('rearm=false + wroteKeys=true → false (t/Esc/ScreenAnalyzer never re-arm)', () => {
    expect(shouldRearmStuckDetector(false, true)).toBe(false);
  });

  it('rearm=false + wroteKeys=false → false', () => {
    expect(shouldRearmStuckDetector(false, false)).toBe(false);
  });
});
