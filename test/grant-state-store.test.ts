/**
 * 授权状态持久层：daemon 启动时把 bots.json 上的授权字段迁进 SQLite 授权库，以及
 * 「内存缓存 ≡ 持久层」这条两个后端都必须守住的不变量。
 * grant-store 的业务语义（两个后端各跑一遍）见 grant-store.test.ts。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

const GRANT_KEYS = ['chatGrants', 'globalGrants', 'quotaState', 'grantExpiryState', 'dispatchLaunchQuotaReceipts'];

let dir: string;
let configPath: string;

function writeBots(entries: Array<Record<string, unknown>>): void {
  writeFileSync(configPath, JSON.stringify(entries.map(e => ({ larkAppSecret: 's', cliId: 'claude-code', ...e })), null, 2));
}
function readBots(): any[] { return JSON.parse(readFileSync(configPath, 'utf-8')); }

async function freshModules() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const grantStore = await import('../src/services/grant-store.js');
  const stateStore = await import('../src/services/grant-state-store.js');
  registry.loadBotConfigs().forEach(c => registry.registerBot(c));
  return { registry, grantStore, stateStore };
}

function loadDb(stateStore: typeof import('../src/services/grant-state-store.js'), appId: string) {
  const db = stateStore.SqliteGrantStateStore.open(dir);
  try { return db.loadState(appId); } finally { db.close(); }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-grant-state-'));
  configPath = join(dir, 'bots.json');
  process.env.BOTS_CONFIG = configPath;
  process.env.SESSION_DATA_DIR = dir;
});
afterEach(() => {
  delete process.env.BOTS_CONFIG;
  delete process.env.SESSION_DATA_DIR;
  delete process.env.BOTMUX_COORDINATION_MODE;
  vi.restoreAllMocks();
});

describe('initGrantStateForDaemon', () => {
  const a1Grants = {
    chatGrants: { oc_1: ['ou_b', 'ou_c'], oc_2: ['ou_b'] },
    globalGrants: ['ou_g'],
    quotaState: { 'chat:oc_1:ou_b': { limit: 3, used: 1 } },
    grantExpiryState: { 'chat:oc_1:ou_b': { expiresAt: 4_102_444_800_000 } },
    dispatchLaunchQuotaReceipts: { [`quota_${'a'.repeat(32)}`]: { allow: true, chargedAt: '2026-10-01T00:00:00.000Z' } },
  };

  it('moves only its own bot\'s grant fields into the store, keeps every other field, backs up once', async () => {
    writeBots([
      { larkAppId: 'a1', allowedUsers: ['ou_owner'], allowedChatGroups: ['oc_team'], ...a1Grants },
      { larkAppId: 'a2', allowedUsers: ['ou_owner2'], chatGrants: { oc_9: ['ou_x'] } },
    ]);
    const before = readFileSync(configPath, 'utf-8');
    const { registry, stateStore } = await freshModules();

    const r = await stateStore.initGrantStateForDaemon({ larkAppId: 'a1', dataDir: dir });

    expect(r).toEqual({ backend: 'sqlite', imported: 7 });
    expect(stateStore.grantStateBackendKind()).toBe('sqlite');
    const [a1, a2] = readBots();
    for (const k of GRANT_KEYS) expect(a1).not.toHaveProperty(k);
    expect(a1.allowedUsers).toEqual(['ou_owner']);
    expect(a1.allowedChatGroups).toEqual(['oc_team']);
    // 别的 bot 由它自己的 daemon 迁移（滚动重启时旧 daemon 仍按 bots.json 读写自己的授权）。
    expect(a2.chatGrants).toEqual({ oc_9: ['ou_x'] });
    expect(readFileSync(`${configPath}.bak-grants-v1`, 'utf-8')).toBe(before);
    expect(loadDb(stateStore, 'a1')).toEqual(a1Grants);
    expect(loadDb(stateStore, 'a2')).toEqual({});
    const mem = registry.getBot('a1').config;
    expect({
      chatGrants: mem.chatGrants,
      globalGrants: mem.globalGrants,
      quotaState: mem.quotaState,
      grantExpiryState: mem.grantExpiryState,
      dispatchLaunchQuotaReceipts: mem.dispatchLaunchQuotaReceipts,
    }).toEqual(a1Grants);
  });

  it('re-running merges grant fields that reappear in bots.json: fills gaps, never overrides the store', async () => {
    writeBots([{ larkAppId: 'a1', allowedUsers: ['ou_owner'], ...a1Grants }]);
    const first = await freshModules();
    await first.stateStore.initGrantStateForDaemon({ larkAppId: 'a1', dataDir: dir });
    const backup = readFileSync(`${configPath}.bak-grants-v1`, 'utf-8');

    // 降级后又升级 / 手工配置：条目上重新出现授权字段，其中一部分与库里同键。
    writeBots([{
      larkAppId: 'a1',
      allowedUsers: ['ou_owner'],
      chatGrants: { oc_1: ['ou_b', 'ou_new'], oc_3: ['ou_d'] },
      quotaState: { 'chat:oc_1:ou_b': { limit: 9, used: 0 }, 'chat:oc_3:ou_d': { limit: 2, used: 0 } },
    }]);
    const second = await freshModules();
    const r = await second.stateStore.initGrantStateForDaemon({ larkAppId: 'a1', dataDir: dir });

    expect(r.imported).toBe(3);
    const state = loadDb(second.stateStore, 'a1');
    expect(state.chatGrants).toEqual({ oc_1: ['ou_b', 'ou_c', 'ou_new'], oc_2: ['ou_b'], oc_3: ['ou_d'] });
    expect(state.quotaState).toEqual({ 'chat:oc_1:ou_b': { limit: 3, used: 1 }, 'chat:oc_3:ou_d': { limit: 2, used: 0 } });
    for (const k of GRANT_KEYS) expect(readBots()[0]).not.toHaveProperty(k);
    expect(readFileSync(`${configPath}.bak-grants-v1`, 'utf-8')).toBe(backup);
    expect(second.registry.getBot('a1').config.chatGrants).toEqual(state.chatGrants);

    // 没有可迁移字段时不再写 bots.json。
    const settled = readFileSync(configPath, 'utf-8');
    const third = await freshModules();
    expect(await third.stateStore.initGrantStateForDaemon({ larkAppId: 'a1', dataDir: dir }))
      .toEqual({ backend: 'sqlite', imported: 0 });
    expect(readFileSync(configPath, 'utf-8')).toBe(settled);
  });

  it('drops malformed legacy grant values but still strips the keys', async () => {
    writeBots([{
      larkAppId: 'a1',
      allowedUsers: ['ou_owner'],
      chatGrants: { oc_1: 'ou_x', oc_2: ['ou_ok', 7] },
      globalGrants: 'ou_g',
      quotaState: { bogus: { limit: 1, used: 0 }, 'global:ou_g': { limit: 0, used: 0 } },
    }]);
    const { stateStore } = await freshModules();
    await stateStore.initGrantStateForDaemon({ larkAppId: 'a1', dataDir: dir });
    expect(loadDb(stateStore, 'a1')).toEqual({ chatGrants: { oc_2: ['ou_ok'] } });
    for (const k of GRANT_KEYS) expect(readBots()[0]).not.toHaveProperty(k);
  });

  it('keeps grants in bots.json under primary coordination (replica dataDirs are not shared)', async () => {
    process.env.BOTMUX_COORDINATION_MODE = 'primary';
    writeBots([{ larkAppId: 'a1', allowedUsers: ['ou_owner'], ...a1Grants }]);
    const before = readFileSync(configPath, 'utf-8');
    const { stateStore } = await freshModules();
    expect(await stateStore.initGrantStateForDaemon({ larkAppId: 'a1', dataDir: dir }))
      .toEqual({ backend: 'bots-json', imported: 0 });
    expect(stateStore.grantStateBackendKind()).toBe('bots-json');
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
    expect(existsSync(join(dir, 'grants.sqlite'))).toBe(false);
  });

  it('refuses to start when the store cannot be opened, leaving bots.json untouched', async () => {
    writeBots([{ larkAppId: 'a1', allowedUsers: ['ou_owner'], ...a1Grants }]);
    mkdirSync(join(dir, 'grants.sqlite')); // 占位成目录 → 无法作为数据库打开
    const before = readFileSync(configPath, 'utf-8');
    const { stateStore } = await freshModules();
    await expect(stateStore.initGrantStateForDaemon({ larkAppId: 'a1', dataDir: dir })).rejects.toThrow();
    expect(stateStore.grantStateBackendKind()).toBe('bots-json');
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('refuses a store written by a newer schema instead of guessing its layout', async () => {
    writeBots([{ larkAppId: 'a1', allowedUsers: ['ou_owner'] }]);
    const { stateStore } = await freshModules();
    stateStore.SqliteGrantStateStore.open(dir).close();
    const { openDatabaseSyncOrThrow } = await import('../src/services/sqlite-compat.js');
    const raw = openDatabaseSyncOrThrow(join(dir, 'grants.sqlite'));
    raw.exec('PRAGMA user_version = 99;');
    raw.close();
    expect(() => stateStore.SqliteGrantStateStore.open(dir)).toThrow(/schema v99/);
  });
});

describe.each(['bots-json', 'sqlite'] as const)('revoke whose bots.json write throws [%s]', (backend) => {
  it('keeps the memory cache equal to the persisted grants, and a restart does not revive the grant', async () => {
    // 目标同时在 allowedUsers 与 chatGrants 里：/revoke 既要改授权，也要写 bots.json。
    writeBots([{ larkAppId: 'a1', allowedUsers: ['ou_owner', 'ou_g'], chatGrants: { oc_1: ['ou_g'] } }]);
    const first = await freshModules();
    if (backend === 'sqlite') await first.stateStore.initGrantStateForDaemon({ larkAppId: 'a1', dataDir: dir });
    const persisted = () => (backend === 'sqlite' ? loadDb(first.stateStore, 'a1').chatGrants : readBots()[0].chatGrants);

    // bots.json 原子写的临时文件名被目录占住 → 写盘抛 EISDIR（等价于磁盘满 / 只读 / 锁超时）。
    const blocker = `${configPath}.tmp.${process.pid}`;
    mkdirSync(blocker);
    await expect(first.grantStore.revokeGrant('a1', 'oc_1', 'ou_g')).rejects.toThrow();
    // SQLite 的授权事务先于配置写入提交：库里已撤销，内存读缓存必须跟上，否则 canTalk 仍放行。
    expect(first.registry.getBot('a1').config.chatGrants).toEqual(persisted());
    expect(persisted()).toEqual(backend === 'sqlite' ? undefined : { oc_1: ['ou_g'] });

    rmSync(blocker, { recursive: true });
    const second = await freshModules();
    if (backend === 'sqlite') await second.stateStore.initGrantStateForDaemon({ larkAppId: 'a1', dataDir: dir });
    expect(second.registry.getBot('a1').config.chatGrants).toEqual(persisted());
    expect(second.registry.getBot('a1').config.chatGrants).toEqual(backend === 'sqlite' ? undefined : { oc_1: ['ou_g'] });
  });
});

/** 极小的确定性 PRNG（mulberry32），让随机操作序列可复现。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.each(['bots-json', 'sqlite'] as const)('memory cache mirrors the persisted grant state [%s]', (backend) => {
  it('stays identical after every operation of a random grant workload', async () => {
    writeBots([{ larkAppId: 'a1', allowedUsers: ['ou_owner'] }]);
    const { registry, grantStore, stateStore } = await freshModules();
    if (backend === 'sqlite') await stateStore.initGrantStateForDaemon({ larkAppId: 'a1', dataDir: dir });

    // 成员列表的顺序没有语义（读取方只做 includes），SQLite 按主键序读出、内存按追加序，比较前排序。
    const canonical = (o: Record<string, any>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const k of GRANT_KEYS) {
        if (o[k] === undefined) continue;
        if (k === 'globalGrants') out[k] = [...o[k]].sort();
        else if (k === 'chatGrants') out[k] = Object.fromEntries(Object.entries(o[k] as Record<string, string[]>).map(([c, ids]) => [c, [...ids].sort()]));
        else out[k] = o[k];
      }
      return out;
    };
    const persisted = () => canonical(backend === 'sqlite' ? loadDb(stateStore, 'a1') : readBots()[0]);
    const inMemory = () => canonical(registry.getBot('a1').config as Record<string, any>);

    const next = rng(20261022);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
    const chats = ['oc_1', 'oc_2'];
    const users = ['ou_a', 'ou_b', 'ou_c'];
    const now = 1_000_000;
    let receipt = 0;

    for (let step = 0; step < 300; step++) {
      const chat = pick(chats);
      const user = pick(users);
      const quota = pick([undefined, 1, 2, 3]);
      const expiresAt = pick([undefined, now - 10, now + 10]);
      switch (pick(['addChat', 'addGlobal', 'removeChat', 'removeGlobal', 'revoke', 'consume', 'expire', 'dispatch', 'sweep'] as const)) {
        case 'addChat': await grantStore.addChatGrant('a1', chat, user, quota, expiresAt); break;
        case 'addGlobal': await grantStore.addGlobalGrant('a1', user, quota, expiresAt); break;
        case 'removeChat': await grantStore.removeChatGrant('a1', chat, user); break;
        case 'removeGlobal': await grantStore.removeGlobalGrant('a1', user); break;
        case 'revoke': await grantStore.revokeGrant('a1', chat, user); break;
        case 'consume': await grantStore.consumeQuota('a1', pick([`chat:${chat}:${user}`, `global:${user}`])); break;
        case 'expire': {
          const key = pick([`chat:${chat}:${user}`, `global:${user}`]);
          const observed = registry.getBot('a1').config.grantExpiryState?.[key]?.expiresAt ?? now - 10;
          if (key.startsWith('chat:')) await grantStore.removeExpiredGrant('a1', 'chat', chat, user, observed, now);
          else await grantStore.removeExpiredGrant('a1', 'global', undefined, user, observed, now);
          break;
        }
        case 'dispatch': {
          const global = next() < 0.5;
          await grantStore.consumeDispatchLaunchQuotaOnce({
            larkAppId: 'a1',
            quotaKey: global ? `global:${user}` : `chat:${chat}:${user}`,
            receiptId: `quota_${(receipt++ % 4).toString(16).padStart(32, '0')}`,
            sourceOpenId: user,
            ...(global ? {} : { grantChatId: chat }),
          });
          break;
        }
        case 'sweep': await grantStore.sweepExpiredGrants('a1', now); break;
      }
      expect(inMemory(), `step ${step}`).toEqual(persisted());
    }
    // 工作负载确实覆盖到了非空状态，而不是一路空表对空表。
    expect(Object.keys(persisted()).length).toBeGreaterThan(0);
  });
});
