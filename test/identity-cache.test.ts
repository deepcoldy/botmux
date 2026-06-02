import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dataDir: '', larkGet: null as any }));

vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return state.dataDir; } } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/bot-registry.js', () => ({
  getBotClient: vi.fn(() => ({ __mock: true })),
}));
vi.mock('../src/im/lark/client.js', () => ({
  larkGet: (...args: any[]) => state.larkGet(...args),
}));

let seq = 0;
/** Unique larkAppId per test so module-level caches don't bleed across cases. */
function freshApp(): string {
  return `cli_test_${Date.now()}_${seq++}`;
}

describe('identity-cache resolveName — 41050 negative cache', () => {
  beforeEach(() => {
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-identity-'));
  });
  afterEach(async () => {
    const { flushIdentityCacheSync } = await import('../src/im/lark/identity-cache.js');
    flushIdentityCacheSync();
    if (state.dataDir) {
      rmSync(state.dataDir, { recursive: true, force: true });
      state.dataDir = '';
    }
  });

  it('does not re-call contact API after a 41050 no-authority response', async () => {
    state.larkGet = vi.fn(async () => ({ code: 41050, msg: 'no user authority error' }));
    const { resolveName } = await import('../src/im/lark/identity-cache.js');
    const app = freshApp();

    const n1 = await resolveName(app, 'ou_unknown_user');
    const n2 = await resolveName(app, 'ou_unknown_user');

    expect(n1).toBeUndefined();
    expect(n2).toBeUndefined();
    // The 41050 result is negative-cached per open_id → the second lookup must
    // NOT hit the contact API again (otherwise every inbound message re-burns it).
    expect(state.larkGet).toHaveBeenCalledTimes(1);
  });

  it('keeps re-trying a different open_id (negative cache is per-user, not per-app)', async () => {
    state.larkGet = vi.fn(async () => ({ code: 41050, msg: 'no user authority error' }));
    const { resolveName } = await import('../src/im/lark/identity-cache.js');
    const app = freshApp();

    await resolveName(app, 'ou_user_a');
    await resolveName(app, 'ou_user_b');

    // 41050 is "this user not visible", not "scope missing app-wide" — so a
    // brand-new open_id still gets one attempt.
    expect(state.larkGet).toHaveBeenCalledTimes(2);
  });

  it('retries the contact API only after the 41050 negative cache TTL expires', async () => {
    vi.useFakeTimers();
    try {
      state.larkGet = vi.fn(async () => ({ code: 41050, msg: 'no user authority error' }));
      const { resolveName } = await import('../src/im/lark/identity-cache.js');
      const app = freshApp();

      await resolveName(app, 'ou_u');
      expect(state.larkGet).toHaveBeenCalledTimes(1);

      // Within TTL: still suppressed.
      await vi.advanceTimersByTimeAsync(60_000);
      await resolveName(app, 'ou_u');
      expect(state.larkGet).toHaveBeenCalledTimes(1);

      // Past TTL (>24h): scope may have changed, so retry once more.
      await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000);
      await resolveName(app, 'ou_u');
      expect(state.larkGet).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
