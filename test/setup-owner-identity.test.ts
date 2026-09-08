import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clientArgsMock, userGetMock, batchGetIdMock } = {
  clientArgsMock: vi.fn(),
  userGetMock: vi.fn(),
  batchGetIdMock: vi.fn(),
};

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {
    constructor(args: unknown) {
      clientArgsMock(args);
    }
    contact = {
      v3: {
        user: {
          get: userGetMock,
          batchGetId: batchGetIdMock,
        },
      },
    };
  },
}));

import {
  detectUnusableOwnerEntries,
  normalizeManagedOwnerEntries,
  resolveScannerAllowedUser,
} from '../src/setup/owner-identity.js';

describe('scripted setup owner identity', () => {
  beforeEach(() => {
    clientArgsMock.mockReset();
    userGetMock.mockReset();
    batchGetIdMock.mockReset();
  });

  it('replaces the managed source-bot open_id with a stable union_id before creating another app', async () => {
    const resolveStable = vi.fn(async () => 'on_owner');

    await expect(normalizeManagedOwnerEntries(
      'ou_source,coowner@example.com,on_owner',
      { sourceAppId: 'cli_source', sourceOwnerOpenId: 'ou_source', creatingApp: true },
      resolveStable,
    )).resolves.toBe('on_owner,coowner@example.com');
    expect(resolveStable).toHaveBeenCalledWith('cli_source', 'ou_source');
  });

  it('does not rewrite an open_id when configuring the same app', async () => {
    const resolveStable = vi.fn(async () => 'on_owner');

    await expect(normalizeManagedOwnerEntries(
      'ou_source',
      { sourceAppId: 'cli_same', sourceOwnerOpenId: 'ou_source', creatingApp: false, targetAppId: 'cli_same' },
      resolveStable,
    )).resolves.toBe('ou_source');
    expect(resolveStable).not.toHaveBeenCalled();
  });

  it('fails before app creation when the managed open_id cannot be made cross-app stable', async () => {
    await expect(normalizeManagedOwnerEntries(
      'ou_source',
      { sourceAppId: 'cli_source', sourceOwnerOpenId: 'ou_source', creatingApp: true },
      async () => undefined,
    )).rejects.toThrow(/不能把当前 Bot 的 app-scoped open_id.*union_id/);
  });

  it('rejects every unrelated open_id before creating a brand-new app', async () => {
    const resolveStable = vi.fn(async () => 'on_owner');

    await expect(normalizeManagedOwnerEntries(
      'owner@example.com,ou_foreign',
      { creatingApp: true },
      resolveStable,
    )).rejects.toThrow(/创建新 Bot 时不能使用 app-scoped open_id.*ou_foreign/);
    expect(resolveStable).not.toHaveBeenCalled();
  });

  it('leaves stable owner forms untouched when creating a brand-new app', async () => {
    const resolveStable = vi.fn(async () => 'on_owner');

    await expect(normalizeManagedOwnerEntries(
      'owner@example.com,+14155550123,on_owner',
      { creatingApp: true },
      resolveStable,
    )).resolves.toBe('owner@example.com,+14155550123,on_owner');
    expect(resolveStable).not.toHaveBeenCalled();
  });

  it('resolves a source-app open_id to union_id for managed normalization', async () => {
    userGetMock.mockResolvedValueOnce({
      code: 0,
      data: { user: { open_id: 'ou_source', union_id: 'on_owner' } },
    });

    await expect(resolveScannerAllowedUser('cli_source', 'secret', 'ou_source', 'feishu'))
      .resolves.toBe('on_owner');
  });

  it('uses the Lark SDK domain for source-owner normalization', async () => {
    userGetMock.mockResolvedValueOnce({ code: 0, data: { user: { union_id: 'on_owner' } } });

    await resolveScannerAllowedUser('cli_source', 'secret', 'ou_source', 'lark');
    expect(clientArgsMock).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'https://open.larksuite.com',
    }));
  });

  it('rejects a cross-app open_id returned as a normal SDK payload', async () => {
    userGetMock.mockResolvedValueOnce({ code: 99992361, msg: 'cross app' });

    await expect(detectUnusableOwnerEntries(
      'cli_target', 'secret', 'feishu', ['ou_source'],
    )).resolves.toEqual(['ou_source']);
  });

  it('rejects the same definitive cross-app error when the SDK throws Axios-style', async () => {
    userGetMock.mockRejectedValueOnce({
      response: { data: { code: 99992361, msg: 'cross app' } },
    });

    await expect(detectUnusableOwnerEntries(
      'cli_target', 'secret', 'feishu', ['ou_source'],
    )).resolves.toEqual(['ou_source']);
  });

  // P1 regression: an ou_ that the target app proves invalid must be rejected
  // through the SAME definitive-code set as on_. A prior ou_-only 99992361
  // check let 41012 / 40001 and code:0-without-user slip through and land as
  // the sole owner, reproducing the very lockout this module prevents.
  it('rejects an ou_ the target app reports as an invalid id (41012 / 40001)', async () => {
    userGetMock.mockResolvedValueOnce({ code: 41012, msg: 'invalid user id' });
    await expect(detectUnusableOwnerEntries(
      'cli_target', 'secret', 'feishu', ['ou_invalid'],
    )).resolves.toEqual(['ou_invalid']);

    userGetMock.mockResolvedValueOnce({ code: 40001, msg: 'invalid param' });
    await expect(detectUnusableOwnerEntries(
      'cli_target', 'secret', 'feishu', ['ou_bad_param'],
    )).resolves.toEqual(['ou_bad_param']);
  });

  it('rejects an ou_ definitive-invalid id that arrives as an Axios throw', async () => {
    userGetMock.mockRejectedValueOnce({
      response: { data: { code: 40001, msg: 'invalid param' } },
    });
    await expect(detectUnusableOwnerEntries(
      'cli_target', 'secret', 'feishu', ['ou_thrown'],
    )).resolves.toEqual(['ou_thrown']);
  });

  it('rejects an ou_ with a clean code:0 response that carries no target-app user', async () => {
    userGetMock.mockResolvedValueOnce({ code: 0, data: {} });
    await expect(detectUnusableOwnerEntries(
      'cli_target', 'secret', 'feishu', ['ou_no_user'],
    )).resolves.toEqual(['ou_no_user']);
  });

  it('accepts an ou_ that resolves to a target-app user (no false rejection)', async () => {
    userGetMock.mockResolvedValueOnce({
      code: 0,
      data: { user: { open_id: 'ou_same_app', union_id: 'on_owner' } },
    });
    await expect(detectUnusableOwnerEntries(
      'cli_target', 'secret', 'feishu', ['ou_same_app'],
    )).resolves.toEqual([]);
    expect(userGetMock).toHaveBeenCalledWith({
      path: { user_id: 'ou_same_app' },
      params: { user_id_type: 'open_id' },
    });
  });

  it('does not reject an ou_ on a transient (non-definitive) lookup code', async () => {
    userGetMock.mockResolvedValueOnce({ code: 40003, msg: 'internal error' });
    await expect(detectUnusableOwnerEntries(
      'cli_target', 'secret', 'feishu', ['ou_transient'],
    )).resolves.toEqual([]);
  });

  it('does not reject an owner on transient lookup failure', async () => {
    userGetMock.mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(detectUnusableOwnerEntries(
      'cli_target', 'secret', 'feishu', ['ou_maybe_valid'],
    )).resolves.toEqual([]);
  });

  it('rejects a union_id that the target app definitively cannot resolve', async () => {
    userGetMock.mockResolvedValueOnce({ code: 0, data: {} });

    await expect(detectUnusableOwnerEntries(
      'cli_target', 'secret', 'feishu', ['on_other_tenant'],
    )).resolves.toEqual(['on_other_tenant']);
    expect(userGetMock).toHaveBeenCalledWith({
      path: { user_id: 'on_other_tenant' },
      params: { user_id_type: 'union_id' },
    });
  });

  it('accepts a union_id that resolves to an open_id in the target app', async () => {
    userGetMock.mockResolvedValueOnce({
      code: 0,
      data: { user: { open_id: 'ou_target' } },
    });

    await expect(detectUnusableOwnerEntries(
      'cli_target', 'secret', 'feishu', ['on_owner'],
    )).resolves.toEqual([]);
  });
});
