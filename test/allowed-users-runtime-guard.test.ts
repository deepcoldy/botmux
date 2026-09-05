/**
 * B-3 integration: the runtime allowedUsers write must reject ou_/on_ entries
 * that THIS bot's app proves unusable (cross-app open_id 99992361 / 41012 /
 * 40001 / code-0-without-user) BEFORE writing bots.json, while inconclusive
 * checks (network / scope) still allow the write.
 *
 * Unlike bot-config-store.test.ts (which mocks detectUnusableOwnerEntries),
 * this file drives the REAL detectUnusableOwnerEntries + REAL
 * resolveAllowedUsersWithMap, stubbing only the Lark SDK (owner-identity's own
 * client) and the per-bot HTTP client — so the credential/brand wiring and the
 * probe-before-resolve ordering are covered end-to-end.
 *
 * Run: pnpm vitest run test/allowed-users-runtime-guard.test.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { userGetMock } = vi.hoisted(() => ({ userGetMock: vi.fn() }));

// detectUnusableOwnerEntries builds its own SDK client per call.
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {
    contact = {
      v3: {
        user: {
          get: userGetMock,
          batchGetId: async () => ({ code: 0, data: { user_list: [] } }),
        },
      },
    };
  },
}));

const APP = 'app-runtime-guard-test';

describe('setBotAllowedUsers runtime cross-app guard (B-3, real detectUnusableOwnerEntries)', () => {
  let configPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-guard-'));
    configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
    process.env.SESSION_DATA_DIR = dir;
    userGetMock.mockReset();
  });
  afterEach(() => { delete process.env.BOTS_CONFIG; delete process.env.SESSION_DATA_DIR; });

  function writeConfig(extra: Record<string, unknown> = {}) {
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: APP,
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      ...extra,
    }], null, 2), 'utf-8');
  }
  function readConfig(): any {
    return JSON.parse(readFileSync(configPath, 'utf-8'))[0];
  }

  /** Load fresh modules, register the bot, stub its HTTP client for the resolver. */
  async function loaded(emailBatchGetId: any) {
    vi.resetModules();
    const registry = await import('../src/bot-registry.js');
    const store = await import('../src/services/bot-config-store.js');
    registry.loadBotConfigs().forEach((c: any) => registry.registerBot(c));
    const st = registry.getBot(APP);
    // resolveAllowedUsersWithMap talks to this stub: larkGet goes through
    // request() (ou_ diagnostic / on_ resolve), emails through batchGetId.
    (st as any).client = {
      request: async ({ url }: any) => ({
        code: 0,
        data: { user: { open_id: decodeURIComponent(String(url).split('/').pop()) } },
      }),
      contact: { v3: { user: { get: async () => ({ code: 0, data: { user: {} } }), batchGetId: emailBatchGetId } } },
    };
    return { registry, store };
  }

  it('rejects a cross-app ou_ (99992361) before resolving or writing', async () => {
    userGetMock.mockResolvedValueOnce({ code: 99992361, msg: 'user not found in app scope' });
    writeConfig();
    const { store } = await loaded(async () => {
      throw new Error('resolver must not run when the probe rejects');
    });
    const before = readConfig().allowedUsers;

    const r = await store.setBotAllowedUsers(APP, ['ou_other_app', 'alice@corp.com'], 'ou_alice');

    expect(r).toMatchObject({ ok: false, reason: 'unusable_owner_entries', entries: ['ou_other_app'] });
    // Probe used the target app credentials with open_id lookup.
    expect(userGetMock).toHaveBeenCalledWith({
      path: { user_id: 'ou_other_app' },
      params: { user_id_type: 'open_id' },
    });
    // Nothing written.
    expect(readConfig().allowedUsers).toEqual(before);
  });

  it('rejects an ou_ the target app reports as invalid id (41012)', async () => {
    userGetMock.mockResolvedValueOnce({ code: 41012, msg: 'invalid user id' });
    writeConfig();
    const { store } = await loaded(async () => ({ code: 0, data: { user_list: [] } }));

    const r = await store.setBotAllowedUsers(APP, ['ou_invalid'], 'ou_owner');

    expect(r).toMatchObject({ ok: false, reason: 'unusable_owner_entries', entries: ['ou_invalid'] });
    expect(readConfig().allowedUsers).toEqual(['ou_owner']);
  });

  it('does NOT reject when the probe is inconclusive (network throw) — write proceeds', async () => {
    userGetMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    writeConfig();
    const { store } = await loaded(async () => ({
      code: 0,
      data: { user_list: [{ user_id: 'ou_alice', email: 'alice@corp.com' }] },
    }));

    const r = await store.setBotAllowedUsers(APP, ['ou_owner', 'alice@corp.com'], 'ou_owner');

    expect(r).toMatchObject({ ok: true });
    expect(readConfig().allowedUsers).toEqual(['ou_owner', 'alice@corp.com']);
  });

  it('accepts an ou_ the target app resolves (no false rejection)', async () => {
    userGetMock.mockResolvedValueOnce({
      code: 0,
      data: { user: { open_id: 'ou_owner', union_id: 'on_owner' } },
    });
    writeConfig();
    const { store } = await loaded(async () => ({ code: 0, data: { user_list: [] } }));

    const r = await store.setBotAllowedUsers(APP, ['ou_owner'], 'ou_owner');

    expect(r).toMatchObject({ ok: true });
    expect(readConfig().allowedUsers).toEqual(['ou_owner']);
  });

  it('probes on_ entries with user_id_type=union_id and rejects a definitive miss', async () => {
    userGetMock.mockResolvedValueOnce({ code: 0, data: {} }); // code-0 without user → definitive
    writeConfig();
    const { store } = await loaded(async () => ({ code: 0, data: { user_list: [] } }));

    const r = await store.setBotAllowedUsers(APP, ['on_other_tenant'], 'ou_owner');

    expect(r).toMatchObject({ ok: false, reason: 'unusable_owner_entries', entries: ['on_other_tenant'] });
    expect(userGetMock).toHaveBeenCalledWith({
      path: { user_id: 'on_other_tenant' },
      params: { user_id_type: 'union_id' },
    });
    expect(readConfig().allowedUsers).toEqual(['ou_owner']);
  });
});
