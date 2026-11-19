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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { processStuckWarningTuiKeys, shouldRearmStuckDetector, type StuckKeyGuardDeps, type StuckKeyGuardMessage } from '../src/utils/stuck-key-guard.js';
import { classifyStuckPage } from '../src/utils/stuck-detector.js';
import { isAllowedStuckKeySequence, stuckScreenTail } from '../src/core/stuck-page-catalog.js';

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
    // The capture that showed the other page comes back for the caller to act on.
    expect(result).toEqual({ sent: 'expired', wroteKeys: false, expiredScreen: 'Some other screen\nnot a hook review' });
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

describe('processStuckWarningTuiKeys — catalog key check and post-key observation', () => {
  // Real captures and the real classifier / catalog: the guard is wired with
  // exactly these in worker.ts.
  const page = (name: string) => readFileSync(join(process.cwd(), 'test/fixtures/stuck-pages', name), 'utf-8');
  const TRAEX_L1 = page('traex-0.213.1-hooks-browser-l1.txt');
  const TRAEX_STARTUP_AFTER_ESC = page('traex-0.213.1-hooks-startup-menu-after-l1-esc.txt');
  const TRAEX_STARTUP = page('traex-0.213.1-hooks-startup-menu.txt');
  const TRAEX_COMPOSER = page('traex-0.213.1-composer-after-hooks-esc.txt');

  function captureSequence(...screens: Array<string | Error>) {
    let i = 0;
    return vi.fn(async () => {
      const next = screens[Math.min(i++, screens.length - 1)];
      if (next instanceof Error) throw next;
      return { content: next };
    });
  }

  function afterWriteDeps(overrides?: Partial<NonNullable<StuckKeyGuardDeps['afterWrite']>>) {
    return {
      settleMs: 800,
      sleep: vi.fn(async (_ms: number) => {}),
      screenTail: stuckScreenTail,
      onObserved: vi.fn(),
      ...overrides,
    };
  }

  it('drops a key the catalog does not list for the re-matched page, without writing', async () => {
    // `t` (trust all) exists on the browser page but NOT on the startup menu.
    const state = { backend: {}, lifetime: 1 };
    const deps = makeDeps(state, {
      capture: captureSequence(TRAEX_STARTUP),
      match: classifyStuckPage,
      allowKeys: isAllowedStuckKeySequence,
    });
    const result = await processStuckWarningTuiKeys(makeMsg({ stuckPageType: 'hook review startup', keys: ['t'] }), deps);
    expect(result).toEqual({ sent: 'expired', wroteKeys: false });
    expect(deps.writeKeys).not.toHaveBeenCalled();
    expect(deps.sendExpired).toHaveBeenCalledWith(1, 'turn_1', 1);
    expect(deps.sendDelivered).not.toHaveBeenCalled();
  });

  it('drops a multi-key sequence even when every key is listed', async () => {
    const state = { backend: {}, lifetime: 1 };
    const deps = makeDeps(state, {
      capture: captureSequence(TRAEX_L1),
      match: classifyStuckPage,
      allowKeys: isAllowedStuckKeySequence,
    });
    const result = await processStuckWarningTuiKeys(makeMsg({ keys: ['Escape', 'Escape'] }), deps);
    expect(result.wroteKeys).toBe(false);
    expect(deps.writeKeys).not.toHaveBeenCalled();
  });

  it('after a key lands, settles, re-captures and reports the next blocking page with delivered', async () => {
    // traex L1 Esc goes back to the startup menu: still blocked, new page.
    const state = { backend: {}, lifetime: 1 };
    const after = afterWriteDeps();
    const deps = makeDeps(state, {
      capture: captureSequence(TRAEX_L1, TRAEX_STARTUP_AFTER_ESC),
      match: classifyStuckPage,
      allowKeys: isAllowedStuckKeySequence,
      afterWrite: after,
    });
    const result = await processStuckWarningTuiKeys(makeMsg({ keys: ['Escape'] }), deps);
    expect(result.sent).toBe('delivered');
    expect(after.sleep).toHaveBeenCalledWith(800);
    expect(deps.capture).toHaveBeenCalledTimes(2);
    expect(deps.sendDelivered).toHaveBeenCalledWith(1, 'turn_1', 1, {
      key: 'Escape',
      afterObserved: true,
      afterPageType: 'hook review startup',
      afterScreenTail: stuckScreenTail(TRAEX_STARTUP_AFTER_ESC),
    });
    expect(after.onObserved).toHaveBeenCalledWith(expect.objectContaining({
      observed: true, screen: TRAEX_STARTUP_AFTER_ESC, pageType: 'hook review startup',
    }));
  });

  it('reports no page when the composer is back', async () => {
    const state = { backend: {}, lifetime: 1 };
    const deps = makeDeps(state, {
      capture: captureSequence(TRAEX_STARTUP, TRAEX_COMPOSER),
      match: classifyStuckPage,
      allowKeys: isAllowedStuckKeySequence,
      afterWrite: afterWriteDeps(),
    });
    await processStuckWarningTuiKeys(makeMsg({ stuckPageType: 'hook review startup', keys: ['Escape'] }), deps);
    const details = (deps.sendDelivered as any).mock.calls[0][3];
    expect(details).toMatchObject({ key: 'Escape', afterObserved: true });
    expect(details.afterPageType).toBeUndefined();
    expect(details.afterScreenTail).toBe(stuckScreenTail(TRAEX_COMPOSER));
  });

  it('sends delivered only after the settle, and runs the hook only after delivered', async () => {
    const state = { backend: {}, lifetime: 1 };
    let releaseSettle!: () => void;
    const order: string[] = [];
    const after = afterWriteDeps({
      sleep: vi.fn(() => new Promise<void>(resolve => { releaseSettle = resolve; })),
      onObserved: vi.fn(() => { order.push('observed'); }),
    });
    const deps = makeDeps(state, {
      capture: captureSequence(TRAEX_STARTUP, TRAEX_COMPOSER),
      match: classifyStuckPage,
      afterWrite: after,
      sendDelivered: vi.fn(() => { order.push('delivered'); }),
    });
    const pending = processStuckWarningTuiKeys(makeMsg({ stuckPageType: 'hook review startup' }), deps);
    await vi.waitFor(() => expect(after.sleep).toHaveBeenCalled());
    expect(deps.writeKeys).toHaveBeenCalledTimes(1);
    expect(deps.sendDelivered).not.toHaveBeenCalled();
    releaseSettle();
    await pending;
    expect(order).toEqual(['delivered', 'observed']);
  });

  it('a backend replaced during the settle yields an unobserved delivery and never reads the new CLI', async () => {
    const state = { backend: { id: 'old' } as any, lifetime: 1 };
    const deps = makeDeps(state, {
      capture: captureSequence(TRAEX_STARTUP, TRAEX_COMPOSER),
      match: classifyStuckPage,
      afterWrite: afterWriteDeps({ sleep: vi.fn(async () => { state.backend = { id: 'new' }; }) }),
    });
    const result = await processStuckWarningTuiKeys(makeMsg({ stuckPageType: 'hook review startup' }), deps);
    expect(result).toMatchObject({ sent: 'delivered', wroteKeys: true, after: { observed: false } });
    expect(deps.capture).toHaveBeenCalledTimes(1);
    expect(deps.sendDelivered).toHaveBeenCalledWith(1, 'turn_1', 1, { key: 'Escape', afterObserved: false });
  });

  it('a lifetime change during the post-key capture discards that capture', async () => {
    const state = { backend: {}, lifetime: 1 };
    let calls = 0;
    const deps = makeDeps(state, {
      capture: vi.fn(async () => {
        calls += 1;
        if (calls === 2) state.lifetime = 2;
        return { content: calls === 1 ? TRAEX_STARTUP : TRAEX_COMPOSER };
      }),
      match: classifyStuckPage,
      afterWrite: afterWriteDeps(),
    });
    await processStuckWarningTuiKeys(makeMsg({ stuckPageType: 'hook review startup' }), deps);
    expect(deps.sendDelivered).toHaveBeenCalledWith(1, 'turn_1', 1, { key: 'Escape', afterObserved: false });
  });

  it('a failing post-key capture still reports the write as delivered (unobserved)', async () => {
    const state = { backend: {}, lifetime: 1 };
    const deps = makeDeps(state, {
      capture: captureSequence(TRAEX_STARTUP, new Error('tmux gone')),
      match: classifyStuckPage,
      afterWrite: afterWriteDeps(),
    });
    const result = await processStuckWarningTuiKeys(makeMsg({ stuckPageType: 'hook review startup' }), deps);
    expect(result.sent).toBe('delivered');
    expect(deps.sendFailed).not.toHaveBeenCalled();
    expect(deps.sendDelivered).toHaveBeenCalledWith(1, 'turn_1', 1, { key: 'Escape', afterObserved: false });
  });

  it('a write failure never observes or runs the post-key hook', async () => {
    const state = { backend: {}, lifetime: 1 };
    const after = afterWriteDeps();
    const deps = makeDeps(state, {
      capture: captureSequence(TRAEX_STARTUP),
      match: classifyStuckPage,
      writeKeys: vi.fn(async () => false),
      afterWrite: after,
    });
    const result = await processStuckWarningTuiKeys(makeMsg({ stuckPageType: 'hook review startup' }), deps);
    expect(result).toEqual({ sent: 'failed', wroteKeys: false });
    expect(after.sleep).not.toHaveBeenCalled();
    expect(after.onObserved).not.toHaveBeenCalled();
  });
});
