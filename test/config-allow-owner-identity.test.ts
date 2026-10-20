/**
 * `/botconfig set allowedUsers` owner-identity boundary.
 *
 * `ou_` is app-scoped and the allowedUsers resolver passes it through
 * verbatim, so a foreign-app open_id (typically a managed Agent copying the
 * source app's BOTMUX_OWNER_OPEN_ID) used to be persisted and then silently
 * never match any sender. setBotAllowedUsers must validate ou_/on_ entries
 * through the TARGET app (shared setup/owner-identity.ts helper) before it
 * writes: definitive ou_ miss → reject; definitive on_ miss → keep + surface;
 * transient/scope failures → inconclusive, write proceeds.
 *
 * Run: bun run test test/config-allow-owner-identity.test.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { clientArgsMock, userGetMock, batchGetIdMock, requestMock, generatedUserGetMock } = vi.hoisted(() => ({
  clientArgsMock: vi.fn(),
  /** Logical "contact user lookup" — what the OpenAPI handler would answer. */
  userGetMock: vi.fn(),
  batchGetIdMock: vi.fn(),
  /** SDK generic request(): the no-body GET path (larkGet). */
  requestMock: vi.fn(),
  /** SDK generated contact.v3.user.get: attaches a `{}` GET body. */
  generatedUserGetMock: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {
    constructor(args: unknown) { clientArgsMock(args); }
    request = requestMock;
    contact = { v3: { user: { get: generatedUserGetMock, batchGetId: batchGetIdMock } } };
  },
}));

/** A gateway that rejects GET-with-body: the generated method never reaches OpenAPI. */
function gateway411() {
  return Object.assign(new Error('Request failed with status code 411'), {
    response: { status: 411, data: '<html>411 Length Required</html>' },
  });
}

/** Route a no-body GET /contact/v3/users/<id> to the logical lookup mock. */
function routeRequest(req: any) {
  const m = /^\/open-apis\/contact\/v3\/users\/([^/?]+)$/.exec(req?.url ?? '');
  if (req?.method !== 'GET' || !m || 'data' in req) throw new Error(`unexpected request ${JSON.stringify(req)}`);
  return userGetMock({ path: { user_id: decodeURIComponent(m[1]) }, params: req.params });
}

// Resolver stub (same contract as test/bot-config-store.test.ts): ou_ passes
// through literally, on_xxx → ou_xxx unless listed as invisible, email →
// ou_<localpart>. The literal ou_ passthrough is exactly why a foreign ou_
// would land in resolvedAllowedUsers without the identity check.
const invisibleUnion = new Set<string>();
let useRealResolver = false;
vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveAllowedUsersWithMap: async (appId: string, raw: string[]) => {
      if (useRealResolver) {
        // Fresh actual module per call so it binds to the CURRENT (post-resetModules) bot registry.
        const real = await vi.importActual<any>('../src/im/lark/client.js');
        return real.resolveAllowedUsersWithMap(appId, raw);
      }
      const map = new Map<string, string>();
      const resolved: string[] = [];
      const entryStatus = new Map<string, 'resolved' | 'transient' | 'definitive'>();
      for (const v of raw) {
        let id: string | undefined;
        if (v.startsWith('ou_')) id = v;
        else if (v.startsWith('on_') && !invisibleUnion.has(v)) id = 'ou_' + v.slice(3);
        else if (v.includes('@')) id = 'ou_' + v.split('@')[0];
        if (id) { resolved.push(id); map.set(v, id); entryStatus.set(v, 'resolved'); }
        else entryStatus.set(v, 'definitive');
      }
      return { resolved, map, entryStatus };
    },
  };
});

const SOURCE_APP = 'cli_source_app';
const TARGET_APP = 'cli_target_app';
/** The real owner's open_id as observed by the TARGET app (the /config sender). */
const OWNER_IN_TARGET = 'ou_owner_target';
/** The same human's open_id under the SOURCE app — what a managed Agent sees. */
const OWNER_IN_SOURCE = 'ou_owner_source';

async function freshModules() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const store = await import('../src/services/bot-config-store.js');
  const dispatcher = await import('../src/im/lark/event-dispatcher.js');
  return { registry, store, dispatcher };
}

describe('setBotAllowedUsers owner identity boundary', () => {
  let configPath: string;
  const savedEnv = { ...process.env };

  // event-dispatcher has a large import graph; pay its cold transform once here
  // instead of inside the first test's timeout (flaked under full-suite load).
  beforeAll(async () => { await freshModules(); }, 120_000);

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-allow-owner-'));
    configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
    process.env.SESSION_DATA_DIR = dir;
    clientArgsMock.mockReset();
    userGetMock.mockReset();
    batchGetIdMock.mockReset();
    requestMock.mockReset().mockImplementation(async (req: any) => routeRequest(req));
    generatedUserGetMock.mockReset().mockRejectedValue(gateway411());
    invisibleUnion.clear();
    useRealResolver = false;
  });
  afterEach(() => { process.env = { ...savedEnv }; });

  async function loaded(allowedUsers: string[] = [OWNER_IN_TARGET]) {
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: TARGET_APP,
      larkAppSecret: 'target-secret',
      cliId: 'claude-code',
      allowedUsers,
    }], null, 2), 'utf-8');
    const mods = await freshModules();
    mods.registry.loadBotConfigs().forEach((c: any) => mods.registry.registerBot(c));
    return mods;
  }
  const disk = () => JSON.parse(readFileSync(configPath, 'utf-8'))[0].allowedUsers;

  /** Target-app contact API: only its own open_ids / visible union_ids resolve. */
  function targetAppKnows(opts: { openIds?: string[]; unionIds?: string[] }) {
    userGetMock.mockImplementation(async ({ path, params }: any) => {
      const id = path.user_id as string;
      if (params.user_id_type === 'open_id') {
        return opts.openIds?.includes(id)
          ? { code: 0, data: { user: { open_id: id } } }
          : { code: 99992361, msg: 'open_id cross app' };
      }
      return opts.unionIds?.includes(id)
        ? { code: 0, data: { user: { open_id: 'ou_' + id.slice(3), union_id: id } } }
        : { code: 0, data: {} };
    });
  }

  it('managed Agent: rejects the source app BOTMUX_OWNER_OPEN_ID written into the target app', async () => {
    process.env.BOTMUX_LARK_APP_ID = SOURCE_APP;
    process.env.BOTMUX_OWNER_OPEN_ID = OWNER_IN_SOURCE;
    const { registry, store, dispatcher } = await loaded();
    targetAppKnows({ openIds: [OWNER_IN_TARGET] });

    const r = await store.setBotAllowedUsers(
      TARGET_APP, [OWNER_IN_TARGET, process.env.BOTMUX_OWNER_OPEN_ID!], OWNER_IN_TARGET,
    );
    expect(r).toEqual({ ok: false, reason: 'unusable_owner_entries', entries: [OWNER_IN_SOURCE] });

    // Validated with the TARGET app's credentials, never the source app's.
    expect(clientArgsMock).toHaveBeenCalled();
    for (const [args] of clientArgsMock.mock.calls) {
      expect(args).toMatchObject({ appId: TARGET_APP, appSecret: 'target-secret' });
    }
    // The sender's own open_id (observed by this app) is not re-probed.
    expect(userGetMock.mock.calls.map(([a]: any) => a.path.user_id)).toEqual([OWNER_IN_SOURCE]);
    // Nothing persisted, nothing hot-applied.
    expect(disk()).toEqual([OWNER_IN_TARGET]);
    const bot = registry.getBot(TARGET_APP);
    expect(bot.config.allowedUsers).toEqual([OWNER_IN_TARGET]);
    expect(bot.resolvedAllowedUsers).toEqual([OWNER_IN_TARGET]);
    // The real owner still operates the target bot; the foreign id never does.
    expect(dispatcher.canOperate(TARGET_APP, undefined, OWNER_IN_TARGET)).toBe(true);
    expect(dispatcher.canOperate(TARGET_APP, undefined, OWNER_IN_SOURCE)).toBe(false);
  });

  it('also rejects when the SDK throws the cross-app verdict as an Axios-shaped error', async () => {
    const { store } = await loaded();
    userGetMock.mockRejectedValue({ response: { data: { code: 99992361 } } });
    const r = await store.setBotAllowedUsers(TARGET_APP, [OWNER_IN_TARGET, OWNER_IN_SOURCE], OWNER_IN_TARGET);
    expect(r).toMatchObject({ ok: false, reason: 'unusable_owner_entries', entries: [OWNER_IN_SOURCE] });
    expect(disk()).toEqual([OWNER_IN_TARGET]);
  });

  it('writes an open_id the target app validates, and that co-owner can operate immediately', async () => {
    const { registry, store, dispatcher } = await loaded();
    targetAppKnows({ openIds: [OWNER_IN_TARGET, 'ou_coowner_target'] });
    expect(dispatcher.canOperate(TARGET_APP, undefined, 'ou_coowner_target')).toBe(false);

    const r = await store.setBotAllowedUsers(TARGET_APP, [OWNER_IN_TARGET, 'ou_coowner_target'], OWNER_IN_TARGET);
    expect(r).toEqual({ ok: true, raw: [OWNER_IN_TARGET, 'ou_coowner_target'], resolved: [OWNER_IN_TARGET, 'ou_coowner_target'] });
    expect(disk()).toEqual([OWNER_IN_TARGET, 'ou_coowner_target']);
    expect(registry.getBot(TARGET_APP).resolvedAllowedUsers).toEqual([OWNER_IN_TARGET, 'ou_coowner_target']);
    expect(dispatcher.canOperate(TARGET_APP, undefined, 'ou_coowner_target')).toBe(true);
    expect(dispatcher.canOperate(TARGET_APP, undefined, OWNER_IN_TARGET)).toBe(true);
  });

  it.each([
    ['network error', () => userGetMock.mockRejectedValue(new Error('ECONNRESET'))],
    ['missing contact scope', () => userGetMock.mockResolvedValue({ code: 99991672, msg: 'scope missing' })],
    ['Axios-shaped scope error', () => userGetMock.mockRejectedValue({ response: { data: { code: 99991672 } } })],
  ])('treats %s as inconclusive and still writes', async (_label, arrange) => {
    const { store } = await loaded();
    arrange();
    const r = await store.setBotAllowedUsers(TARGET_APP, [OWNER_IN_TARGET, 'ou_maybe'], OWNER_IN_TARGET);
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.unresolvedUnionIds).toBeFalsy();
    expect(disk()).toEqual([OWNER_IN_TARGET, 'ou_maybe']);
  });

  it('treats a missing app secret as inconclusive (no probe at all)', async () => {
    const { registry, store } = await loaded();
    registry.getBot(TARGET_APP).config.larkAppSecret = '';
    const r = await store.setBotAllowedUsers(TARGET_APP, [OWNER_IN_TARGET, 'ou_maybe'], OWNER_IN_TARGET);
    expect(r).toMatchObject({ ok: true });
    expect(userGetMock).not.toHaveBeenCalled();
  });

  it('email path: emails are not identity-probed and a resolved email owner can operate', async () => {
    const { store, dispatcher } = await loaded();
    targetAppKnows({ openIds: [] });
    const r = await store.setBotAllowedUsers(TARGET_APP, [OWNER_IN_TARGET, 'alice@corp.com'], OWNER_IN_TARGET);
    expect(r).toEqual({ ok: true, raw: [OWNER_IN_TARGET, 'alice@corp.com'], resolved: [OWNER_IN_TARGET, 'ou_alice'] });
    expect(userGetMock).not.toHaveBeenCalled();
    expect(batchGetIdMock).not.toHaveBeenCalled();
    expect(dispatcher.canOperate(TARGET_APP, undefined, 'ou_alice')).toBe(true);
  });

  it('411 gateway: a foreign ou_ is still rejected (probe uses the no-body GET, not the generated method)', async () => {
    const { store } = await loaded();
    targetAppKnows({ openIds: [OWNER_IN_TARGET] });
    const r = await store.setBotAllowedUsers(TARGET_APP, [OWNER_IN_TARGET, OWNER_IN_SOURCE], OWNER_IN_TARGET);
    expect(r).toEqual({ ok: false, reason: 'unusable_owner_entries', entries: [OWNER_IN_SOURCE] });
    expect(generatedUserGetMock).not.toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: `/open-apis/contact/v3/users/${OWNER_IN_SOURCE}`,
      params: { user_id_type: 'open_id' },
    }));
    expect(requestMock.mock.calls.every(([req]: any[]) => !('data' in req))).toBe(true);
    expect(disk()).toEqual([OWNER_IN_TARGET]);
  });

  it('union_id path: on_ is not hard-rejected by the precheck; a visible on_ is written and can operate', async () => {
    const { store, dispatcher } = await loaded();
    targetAppKnows({ unionIds: ['on_bob'] });
    const r = await store.setBotAllowedUsers(TARGET_APP, [OWNER_IN_TARGET, 'on_bob'], OWNER_IN_TARGET);
    expect(r).toEqual({ ok: true, raw: [OWNER_IN_TARGET, 'on_bob'], resolved: [OWNER_IN_TARGET, 'ou_bob'] });
    expect(userGetMock).not.toHaveBeenCalled();
    expect(dispatcher.canOperate(TARGET_APP, undefined, 'ou_bob')).toBe(true);
  });

  it('union_id path: an on_ the resolver drops is kept on disk but surfaced', async () => {
    const { store } = await loaded();
    invisibleUnion.add('on_ghost');
    const r = await store.setBotAllowedUsers(TARGET_APP, [OWNER_IN_TARGET, 'on_ghost'], OWNER_IN_TARGET);
    expect(r).toEqual({
      ok: true, raw: [OWNER_IN_TARGET, 'on_ghost'], resolved: [OWNER_IN_TARGET], unresolvedUnionIds: ['on_ghost'],
    });
    expect(disk()).toEqual([OWNER_IN_TARGET, 'on_ghost']);
  });

  it('real resolver: an on_ outside contact visibility (41050) is surfaced, matching what was hot-applied', async () => {
    useRealResolver = true;
    const { registry, store, dispatcher } = await loaded();
    userGetMock.mockImplementation(async ({ path, params }: any) => {
      if (params.user_id_type === 'open_id') return { code: 0, data: { user: { open_id: path.user_id } } };
      if (path.user_id === 'on_visible') return { code: 0, data: { user: { open_id: 'ou_visible', union_id: 'on_visible' } } };
      return { code: 41050, msg: 'no user authority' };
    });
    const r = await store.setBotAllowedUsers(
      TARGET_APP, [OWNER_IN_TARGET, 'on_visible', 'on_hidden'], OWNER_IN_TARGET,
    );
    expect(r).toEqual({
      ok: true,
      raw: [OWNER_IN_TARGET, 'on_visible', 'on_hidden'],
      resolved: expect.arrayContaining([OWNER_IN_TARGET, 'ou_visible']),
      unresolvedUnionIds: ['on_hidden'],
    });
    const live = registry.getBot(TARGET_APP).resolvedAllowedUsers;
    expect(live).toHaveLength(2);
    expect(live).toEqual(expect.arrayContaining([OWNER_IN_TARGET, 'ou_visible']));
    expect(dispatcher.canOperate(TARGET_APP, undefined, 'ou_visible')).toBe(true);
    expect(dispatcher.canOperate(TARGET_APP, undefined, OWNER_IN_TARGET)).toBe(true);
  });
});
