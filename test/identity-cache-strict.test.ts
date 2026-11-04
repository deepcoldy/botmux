import { beforeEach, describe, expect, it, vi } from 'vitest';

import { structuredLarkCode } from '../src/im/lark/lark-errors.js';

const larkGet = vi.fn();
const getBotClient = vi.fn(() => ({ marker: true }));

vi.mock('../src/bot-registry.js', () => ({ getBotClient }));
vi.mock('../src/config.js', () => ({ config: { session: { dataDir: '/tmp/botmux-test' } } }));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/im/lark/client.js', () => ({
  // Keep the REAL extraction (the same function client.ts's getLarkErrorCode
  // delegates to) so the catch-path classification is parsed by production
  // logic. Deliberately a ZERO-ARG factory: a factory that takes the
  // original-module argument is unsupported by `bun test`, and the selector then
  // silently drops this FILE from that leg.
  larkGet,
  getMessageDetail: vi.fn(),
  getLarkErrorCode: structuredLarkCode,
}));

describe('resolveVerifiedUserIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves a configured owner union_id into target-app identity', async () => {
    larkGet.mockResolvedValue({
      code: 0,
      data: {
        user: {
          open_id: 'ou_target_scope',
          union_id: 'on_owner',
          name: 'Owner',
          enterprise_email: 'owner@bytedance.com',
        },
      },
    });
    const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');

    await expect(resolveVerifiedUserIdentityByUnionId('cli_target', 'on_owner')).resolves.toEqual({
      openId: 'ou_target_scope',
      unionId: 'on_owner',
      type: 'user',
      name: 'Owner',
      email: 'owner@bytedance.com',
    });
    expect(larkGet).toHaveBeenCalledWith(
      { marker: true },
      '/open-apis/contact/v3/users/on_owner',
      { user_id_type: 'union_id' },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    // Transport-layer timeout: positive and never longer than the wall-clock
    // budget (the withTimeout race is what actually caps the whole call).
    const transportTimeoutMs = larkGet.mock.calls[0][3].timeoutMs as number;
    expect(Number(transportTimeoutMs)).toBeGreaterThan(0);
    expect(transportTimeoutMs).toBeLessThanOrEqual(3_000);
  });

  it('rejects a union_id response that resolves to another principal', async () => {
    larkGet.mockResolvedValue({
      code: 0,
      data: { user: { open_id: 'ou_target_scope', union_id: 'on_other' } },
    });
    const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');
    await expect(resolveVerifiedUserIdentityByUnionId('cli_target', 'on_owner')).resolves.toBeUndefined();
  });

  it('always reads the exact current open_id from the contact API', async () => {
    larkGet.mockResolvedValue({
      code: 0,
      data: {
        user: {
          name: 'Current User',
          email: 'personal@example.com',
          enterprise_email: 'current.user@bytedance.com',
        },
      },
    });
    const { resolveVerifiedUserIdentity } = await import('../src/im/lark/identity-cache.js');

    await expect(resolveVerifiedUserIdentity('cli_current', 'ou_current')).resolves.toEqual({
      openId: 'ou_current',
      type: 'user',
      name: 'Current User',
      email: 'current.user@bytedance.com',
    });
    expect(larkGet).toHaveBeenCalledWith(
      { marker: true },
      '/open-apis/contact/v3/users/ou_current',
      { user_id_type: 'open_id' },
    );
  });

  it('fails closed on a missing or failed contact result', async () => {
    larkGet.mockResolvedValue({ code: 41050 });
    const { resolveVerifiedUserIdentity } = await import('../src/im/lark/identity-cache.js');
    await expect(resolveVerifiedUserIdentity('cli_current', 'ou_current')).resolves.toBeUndefined();

    larkGet.mockRejectedValueOnce(new Error('network'));
    await expect(resolveVerifiedUserIdentity('cli_current', 'ou_current')).resolves.toBeUndefined();
  });
});

describe('resolveVerifiedUserIdentityByUnionId admission protections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Mirror the module-private policy values: fake-clock tests must move past the
  // real admission budget, and the cap test drives the real boundary — the
  // coupling is inherent to what those tests prove, so it is stated in one place.
  const STRICT_BUDGET = 3_000;
  const NEGATIVE_CACHE_CAP = 1_000;

  const validUser = (overrides: Record<string, unknown> = {}) => ({
    code: 0,
    data: {
      user: {
        open_id: 'ou_target_scope',
        union_id: 'on_owner',
        name: 'Owner',
        enterprise_email: 'owner@bytedance.com',
        ...overrides,
      },
    },
  });

  /**
   * Advance the fake clock (optional), then drain enough microtask ticks for
   * chained promise reactions to settle. `vi.runAllTimersAsync` is a one-tick
   * shim under `bun test`, which is one flush short once the withTimeout race
   * adds a promise layer; an explicit multi-tick drain behaves identically on
   * both runners.
   */
  async function settle(advanceMs?: number): Promise<void> {
    if (advanceMs !== undefined) vi.advanceTimersByTime(advanceMs);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  it('trips the per-app scope breaker once and never calls the API again', async () => {
    larkGet.mockResolvedValue({ code: 99991672, msg: 'scope missing' });
    const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');
    await expect(resolveVerifiedUserIdentityByUnionId('cli_scope_breaker', 'on_owner')).resolves.toBeUndefined();
    await expect(resolveVerifiedUserIdentityByUnionId('cli_scope_breaker', 'on_owner')).resolves.toBeUndefined();
    expect(larkGet).toHaveBeenCalledTimes(1);
  });

  it('negative-caches a deterministic "cannot mint owner" answer within its TTL', async () => {
    larkGet.mockResolvedValue(validUser({ enterprise_email: '' }));
    const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');
    await expect(resolveVerifiedUserIdentityByUnionId('cli_neg_cached', 'on_owner')).resolves.toBeUndefined();
    await expect(resolveVerifiedUserIdentityByUnionId('cli_neg_cached', 'on_owner')).resolves.toBeUndefined();
    expect(larkGet).toHaveBeenCalledTimes(1);
  });

  it('re-resolves a deterministic negative once the negative-cache TTL has elapsed', async () => {
    // Real timers plus a mocked clock: `vi.runAllTimersAsync` is only a one-tick
    // shim under `bun test`, and this path now awaits a nested promise (the
    // withTimeout race), so a drain-based assertion would fail for a reason that
    // has nothing to do with the behaviour. Moving Date.now past the TTL keeps
    // the test about "the entry expires", not about timer plumbing.
    const now = Date.now();
    larkGet
      .mockResolvedValueOnce(validUser({ enterprise_email: '' }))
      .mockResolvedValueOnce(validUser());
    const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');
    await expect(resolveVerifiedUserIdentityByUnionId('cli_neg_ttl', 'on_owner')).resolves.toBeUndefined();
    // Still inside the TTL: the negative is served without touching the API.
    await expect(resolveVerifiedUserIdentityByUnionId('cli_neg_ttl', 'on_owner')).resolves.toBeUndefined();
    expect(larkGet).toHaveBeenCalledTimes(1);

    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 60_001);
    try {
      await expect(resolveVerifiedUserIdentityByUnionId('cli_neg_ttl', 'on_owner')).resolves.toBeDefined();
    } finally {
      spy.mockRestore();
    }
    expect(larkGet).toHaveBeenCalledTimes(2);
  });

  it('does not cache a successful resolution — credential material is read fresh every turn', async () => {
    larkGet.mockResolvedValue(validUser());
    const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');
    await expect(resolveVerifiedUserIdentityByUnionId('cli_fresh_owner', 'on_owner')).resolves.toBeDefined();
    await expect(resolveVerifiedUserIdentityByUnionId('cli_fresh_owner', 'on_owner')).resolves.toBeDefined();
    expect(larkGet).toHaveBeenCalledTimes(2);
  });

  it('de-duplicates concurrent resolutions of the same owner into one API call', async () => {
    let resolveCall: (v: unknown) => void = () => {};
    larkGet.mockReturnValueOnce(new Promise(resolve => { resolveCall = resolve; }));
    const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');
    const a = resolveVerifiedUserIdentityByUnionId('cli_inflight_owner', 'on_owner');
    const b = resolveVerifiedUserIdentityByUnionId('cli_inflight_owner', 'on_owner');
    resolveCall(validUser());
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBeDefined();
    expect(rb).toBe(ra);
    expect(larkGet).toHaveBeenCalledTimes(1);
  });

  it('keeps TRANSIENT API codes and thrown network errors retryable (no negative cache)', async () => {
    const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');
    // 40003 = internal error (transient); NOT 41050, which is a definitive
    // not-visible verdict and must be negative-cached instead.
    larkGet.mockResolvedValueOnce({ code: 40003 }).mockResolvedValueOnce(validUser());
    await expect(resolveVerifiedUserIdentityByUnionId('cli_retry_code', 'on_owner')).resolves.toBeUndefined();
    await expect(resolveVerifiedUserIdentityByUnionId('cli_retry_code', 'on_owner')).resolves.toBeDefined();
    larkGet.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(validUser());
    await expect(resolveVerifiedUserIdentityByUnionId('cli_retry_throw', 'on_owner')).resolves.toBeUndefined();
    await expect(resolveVerifiedUserIdentityByUnionId('cli_retry_throw', 'on_owner')).resolves.toBeDefined();
    expect(larkGet).toHaveBeenCalledTimes(4);
  });

  /** Axios-shaped rejection: non-2xx HTTP with the Lark business code in the
   *  body — the shape this SDK throws when the gateway answers with an error. */
  function axiosError(httpStatus: number, code: number): Error {
    const err = new Error(`Request failed with status code ${httpStatus}`) as any;
    err.response = { status: httpStatus, data: { code, msg: `code ${code}` } };
    return err;
  }

  it('negative-caches a definitive not-visible BODY code (41050) within its TTL', async () => {
    larkGet.mockResolvedValue({ code: 41050, msg: 'no user authority' });
    const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');
    await expect(resolveVerifiedUserIdentityByUnionId('cli_body_not_visible', 'on_owner')).resolves.toBeUndefined();
    await expect(resolveVerifiedUserIdentityByUnionId('cli_body_not_visible', 'on_owner')).resolves.toBeUndefined();
    expect(larkGet).toHaveBeenCalledTimes(1);
  });

  it('negative-caches a definitive verdict THROWN as an AxiosError (403 + 41050)', async () => {
    larkGet.mockRejectedValue(axiosError(403, 41050));
    const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');
    await expect(resolveVerifiedUserIdentityByUnionId('cli_thrown_not_visible', 'on_owner')).resolves.toBeUndefined();
    await expect(resolveVerifiedUserIdentityByUnionId('cli_thrown_not_visible', 'on_owner')).resolves.toBeUndefined();
    expect(larkGet).toHaveBeenCalledTimes(1);
  });

  it('negative-caches a cross-app verdict THROWN as an AxiosError (403 + 99992361)', async () => {
    larkGet.mockRejectedValue(axiosError(403, 99992361));
    const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');
    await expect(resolveVerifiedUserIdentityByUnionId('cli_thrown_cross_app', 'on_owner')).resolves.toBeUndefined();
    await expect(resolveVerifiedUserIdentityByUnionId('cli_thrown_cross_app', 'on_owner')).resolves.toBeUndefined();
    expect(larkGet).toHaveBeenCalledTimes(1);
  });

  it('trips the per-app scope breaker on a THROWN 99991672 as well (non-2xx shape)', async () => {
    larkGet.mockRejectedValue(axiosError(403, 99991672));
    const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');
    await expect(resolveVerifiedUserIdentityByUnionId('cli_thrown_scope', 'on_owner')).resolves.toBeUndefined();
    await expect(resolveVerifiedUserIdentityByUnionId('cli_thrown_scope', 'on_other')).resolves.toBeUndefined();
    expect(larkGet).toHaveBeenCalledTimes(1);
  });

  it('fails closed at the wall-clock budget even when the SDK call never settles (e.g. stalled token fetch)', async () => {
    vi.useFakeTimers();
    try {
      // Models the pre-request tenant-token POST hanging: larkGet's promise
      // never settles, so only an OUTER race can bound the admission wait.
      larkGet.mockImplementation(() => new Promise(() => {}));
      const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');
      const pending = resolveVerifiedUserIdentityByUnionId('cli_budget_stall', 'on_owner');
      let settled = false;
      void pending.then(() => { settled = true; });
      await settle(2_999);
      expect(settled).toBe(false);
      await settle(1);
      expect(settled).toBe(true);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('discards a stale definitive verdict from a budget-expired attempt instead of suppressing a newer success', async () => {
    // Reproduces the cross-attempt conflict the attempt token guards against:
    //   turn 1 hangs past its 3s budget and gets evicted;
    //   turn 2 starts a fresh attempt and VERIFIES the owner;
    //   turn 1's zombie then answers 41050 — it must not poison the 60s
    //   negative cache, or turn 3 would be suppressed without an API call.
    vi.useFakeTimers();
    try {
      let resolveZombie: (v: unknown) => void = () => {};
      larkGet
        .mockImplementationOnce(() => new Promise(resolve => { resolveZombie = resolve; }))
        .mockResolvedValueOnce(validUser())
        .mockResolvedValueOnce(validUser());
      const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');
      const turn1 = resolveVerifiedUserIdentityByUnionId('cli_stale_neg', 'on_owner');
      await settle(STRICT_BUDGET);
      await expect(turn1).resolves.toBeUndefined();
      expect(larkGet).toHaveBeenCalledTimes(1);

      await expect(resolveVerifiedUserIdentityByUnionId('cli_stale_neg', 'on_owner')).resolves.toBeDefined();
      expect(larkGet).toHaveBeenCalledTimes(2);

      resolveZombie({ code: 41050, msg: 'no user authority' });
      await settle();

      // Not suppressed: the stale 41050 was discarded, so turn 3 reaches the API.
      await expect(resolveVerifiedUserIdentityByUnionId('cli_stale_neg', 'on_owner')).resolves.toBeDefined();
      expect(larkGet).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stale THROWN 99991672 from an evicted attempt does not trip the scope breaker', async () => {
    // Same conflict, breaker variant: a zombie scope-missing error arriving
    // after a newer attempt already succeeded must not flip the per-app
    // breaker — a later turn for a DIFFERENT owner must still reach the API.
    vi.useFakeTimers();
    try {
      let rejectZombie: (e: unknown) => void = () => {};
      larkGet
        .mockImplementationOnce(() => new Promise((_, reject) => { rejectZombie = reject; }))
        .mockResolvedValueOnce(validUser())
        .mockResolvedValueOnce(validUser({ union_id: 'on_other' }));
      const { resolveVerifiedUserIdentityByUnionId } = await import('../src/im/lark/identity-cache.js');
      const turn1 = resolveVerifiedUserIdentityByUnionId('cli_stale_scope', 'on_owner');
      await settle(STRICT_BUDGET);
      await expect(turn1).resolves.toBeUndefined();
      await expect(resolveVerifiedUserIdentityByUnionId('cli_stale_scope', 'on_owner')).resolves.toBeDefined();

      rejectZombie(axiosError(403, 99991672));
      await settle();

      // Breaker NOT tripped: this call goes to the API and resolves the owner.
      await expect(resolveVerifiedUserIdentityByUnionId('cli_stale_scope', 'on_other')).resolves.toBeDefined();
      expect(larkGet).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the negative cache: crossing the cap clears old entries instead of growing forever', async () => {
    larkGet.mockResolvedValue({ code: 41050, msg: 'no user authority' });
    const { resolveVerifiedUserIdentityByUnionId, __testOnly_ownerNegativeCacheSize } = await import('../src/im/lark/identity-cache.js');
    let i = 0;
    while (__testOnly_ownerNegativeCacheSize() < NEGATIVE_CACHE_CAP) {
      if (i > NEGATIVE_CACHE_CAP + 50) throw new Error('negative cache never reached its cap');
      await resolveVerifiedUserIdentityByUnionId('cli_cap', `on_owner_${i++}`);
    }
    expect(__testOnly_ownerNegativeCacheSize()).toBe(NEGATIVE_CACHE_CAP);
    // One more deterministic negative: the map collapses via clear()-then-set
    // rather than holding CAP+1 entries.
    await resolveVerifiedUserIdentityByUnionId('cli_cap', `on_owner_${i}`);
    expect(__testOnly_ownerNegativeCacheSize()).toBe(1);
  });
});
