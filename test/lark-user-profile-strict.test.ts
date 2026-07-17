/**
 * getUserProfileStrict — drives the REAL implementation against an SDK client
 * whose `request` is scripted per-test, covering the production failure shapes
 * codex's delta review called out:
 *
 *   1. The Lark SDK is Axios-based: non-2xx responses THROW, with the business
 *      code in `err.response.data.code` — a definitive code arriving that way
 *      (403 + 99992361 cross-app, 403 + 41050 no-authority) must classify as
 *      its definitive cause, not as a transient 'error'.
 *   2. Per-cause precision: cross_app ≠ not_visible ≠ invalid_id.
 *   3. Transient failures ('error') are NOT negative-cached — the next call
 *      must hit the API again; definitive results ARE cached.
 *
 * Run: pnpm vitest run test/lark-user-profile-strict.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    constructor(public opts: Record<string, unknown>) {}
    request = requestMock;
  }
  return { Client: FakeClient, LoggerLevel: { fatal: 0 } };
});

import { registerBot } from '../src/bot-registry.js';
import { getUserProfileStrict, getUserProfile } from '../src/im/lark/client.js';

const APP = 'profile_strict_app';

/** Axios-shaped rejection: non-2xx HTTP with the Lark business code in the body. */
function axiosError(httpStatus: number, code: number): Error {
  const err = new Error(`Request failed with status code ${httpStatus}`) as any;
  err.response = { status: httpStatus, data: { code, msg: `code ${code}` } };
  return err;
}

let seq = 0;
/** Fresh id per test — the profile cache is module-global. */
function freshId(): string {
  return `ou_strict_${++seq}`;
}

beforeEach(() => {
  requestMock.mockReset();
  registerBot({ larkAppId: APP, larkAppSecret: 's', cliId: 'claude-code' });
});

describe('getUserProfileStrict', () => {
  it('resolves a normal profile and caches it', async () => {
    const id = freshId();
    requestMock.mockResolvedValue({ code: 0, data: { user: { name: 'Alice', avatar: { avatar_72: 'https://a/72' } } } });

    expect(await getUserProfileStrict(APP, id)).toEqual({ status: 'ok', profile: { name: 'Alice', avatarUrl: 'https://a/72' } });
    expect(await getUserProfileStrict(APP, id)).toEqual({ status: 'ok', profile: { name: 'Alice', avatarUrl: 'https://a/72' } });
    expect(requestMock).toHaveBeenCalledTimes(1); // second hit served from cache
  });

  it('classifies an Axios-thrown 403 + 99992361 as cross_app, not transient error', async () => {
    const id = freshId();
    requestMock.mockRejectedValue(axiosError(403, 99992361));

    expect(await getUserProfileStrict(APP, id)).toEqual({ status: 'cross_app' });
    // Definitive → cached: no second API call.
    expect(await getUserProfileStrict(APP, id)).toEqual({ status: 'cross_app' });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('classifies an Axios-thrown 403 + 41050 as not_visible (contact scope), distinct from cross_app', async () => {
    const id = freshId();
    requestMock.mockRejectedValue(axiosError(403, 41050));
    expect(await getUserProfileStrict(APP, id)).toEqual({ status: 'not_visible' });
  });

  it('classifies an Axios-thrown 400 + 41012 / 40001 as invalid_id', async () => {
    const a = freshId();
    requestMock.mockRejectedValueOnce(axiosError(400, 41012));
    expect(await getUserProfileStrict(APP, a)).toEqual({ status: 'invalid_id' });

    const b = freshId();
    requestMock.mockRejectedValueOnce(axiosError(400, 40001));
    expect(await getUserProfileStrict(APP, b)).toEqual({ status: 'invalid_id' });
  });

  it('does NOT negative-cache transient failures — the next call retries the API', async () => {
    const id = freshId();
    requestMock
      .mockRejectedValueOnce(new Error('socket hang up'))                 // pure network throw
      .mockRejectedValueOnce(axiosError(500, 40003))                      // internal error via throw
      .mockResolvedValueOnce({ code: 40003, msg: 'internal error' })      // internal error in body
      .mockResolvedValueOnce({ code: 0, data: { user: { name: 'Bob' } } });

    expect(await getUserProfileStrict(APP, id)).toEqual({ status: 'error' });
    expect(await getUserProfileStrict(APP, id)).toEqual({ status: 'error' });
    expect(await getUserProfileStrict(APP, id)).toEqual({ status: 'error' });
    // Fourth call reaches the API (nothing was cached) and succeeds.
    expect(await getUserProfileStrict(APP, id)).toEqual({ status: 'ok', profile: { name: 'Bob', avatarUrl: undefined } });
    expect(requestMock).toHaveBeenCalledTimes(4);
  });

  it('a code-0 body with no usable user is definitive not_visible', async () => {
    const id = freshId();
    requestMock.mockResolvedValue({ code: 0, data: {} });
    expect(await getUserProfileStrict(APP, id)).toEqual({ status: 'not_visible' });
  });

  it('legacy getUserProfile keeps its profile-or-null contract over all strict states', async () => {
    const ok = freshId();
    requestMock.mockResolvedValueOnce({ code: 0, data: { user: { name: 'C' } } });
    expect(await getUserProfile(APP, ok)).toEqual({ name: 'C', avatarUrl: undefined });

    const miss = freshId();
    requestMock.mockRejectedValueOnce(axiosError(403, 99992361));
    expect(await getUserProfile(APP, miss)).toBeNull();

    const transient = freshId();
    requestMock.mockRejectedValueOnce(new Error('timeout'));
    expect(await getUserProfile(APP, transient)).toBeNull();
  });
});
