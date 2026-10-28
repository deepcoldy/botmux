/**
 * 拉新群时带上管家：哪些管家被带进新群（开关、owner 匹配、已在成员里、多 owner），加管家失败
 * 不影响建群，没开管家的部署什么都不做；以及管家 daemon 用来认「这次是静默加入」的标记文件。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotConfig } from '../src/bot-registry.js';
import type { BotAdminUnions } from '../src/services/bot-admin-unions-store.js';
import {
  STEWARD_SILENT_JOIN_TTL_MS,
  clearStewardSilentJoin,
  isStewardSilentJoin,
  joinStewardsToNewChat,
  markStewardSilentJoin,
  type StewardJoinDeps,
  type StewardJoinInput,
} from '../src/services/steward-auto-join.js';

const CREATOR = 'cli_creator';
const STEWARD_A = 'cli_steward_a';
const STEWARD_B = 'cli_steward_b';

function bot(larkAppId: string, extra: Partial<BotConfig> = {}): BotConfig {
  return { larkAppId, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [`${larkAppId}-owner@example.com`], ...extra } as BotConfig;
}

/** creator 应用域 open_id → union_id。 */
const UNION_OF: Record<string, string> = { ou_alice: 'on_alice', ou_bob: 'on_bob' };
/** 各管家 daemon 发布的 owner。 */
const OWNER_OF: Record<string, string> = { [STEWARD_A]: 'on_alice', [STEWARD_B]: 'on_bob' };

let configs: BotConfig[];
let addResult: Record<string, { ok: boolean; error?: string } | Error>;
let deps: StewardJoinDeps & {
  loadConfigs: ReturnType<typeof vi.fn>;
  readAdminUnions: ReturnType<typeof vi.fn>;
  lookupUnion: ReturnType<typeof vi.fn>;
  markSilentJoin: ReturnType<typeof vi.fn>;
  clearSilentJoin: ReturnType<typeof vi.fn>;
  addBot: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  configs = [bot(CREATOR), bot(STEWARD_A, { steward: { enabled: true } })];
  addResult = {};
  deps = {
    loadConfigs: vi.fn(() => configs),
    readAdminUnions: vi.fn((appId: string): BotAdminUnions | undefined => (OWNER_OF[appId]
      ? { admins: new Set([OWNER_OF[appId]!]), exact: true, owner: OWNER_OF[appId] }
      : undefined)),
    lookupUnion: vi.fn(async (openId: string) => UNION_OF[openId]),
    markSilentJoin: vi.fn(),
    clearSilentJoin: vi.fn(),
    addBot: vi.fn(async (appId: string) => {
      const r = addResult[appId] ?? { ok: true };
      if (r instanceof Error) throw r;
      return r;
    }),
    log: vi.fn(),
  };
});

function input(extra: Partial<StewardJoinInput> = {}): StewardJoinInput {
  return {
    creatorLarkAppId: CREATOR,
    requestedBotAppIds: [CREATOR],
    memberOpenIds: ['ou_alice'],
    memberUnionIds: [],
    initiatorOpenIds: [],
    initiatorUnionIds: [],
    ...extra,
  };
}

describe('joinStewardsToNewChat', () => {
  it('新群成员里有管家的 owner：标记静默加入后把管家加进群', async () => {
    const res = await joinStewardsToNewChat(input(), deps);
    expect(res).toEqual([{ larkAppId: STEWARD_A, ok: true }]);
    expect(deps.addBot).toHaveBeenCalledWith(STEWARD_A);
    expect(deps.markSilentJoin).toHaveBeenCalledWith(STEWARD_A);
    // 标记必须写在加群之前：管家 daemon 的入群事件可能比 addBot 的返回先到。
    expect(deps.markSilentJoin.mock.invocationCallOrder[0]!).toBeLessThan(deps.addBot.mock.invocationCallOrder[0]!);
    expect(deps.lookupUnion).toHaveBeenCalledWith('ou_alice');
    expect(deps.readAdminUnions).toHaveBeenCalledWith(STEWARD_A, configs[1]!.allowedUsers);
  });

  it('owner 按 union_id 直接在成员里时不再换 open_id；只是发起人（群主转让对象）也算', async () => {
    expect(await joinStewardsToNewChat(input({ memberOpenIds: ['ou_x'], memberUnionIds: ['on_alice'] }), deps))
      .toEqual([{ larkAppId: STEWARD_A, ok: true }]);
    expect(deps.lookupUnion).not.toHaveBeenCalled();
    expect(await joinStewardsToNewChat(input({ memberOpenIds: [], initiatorOpenIds: ['ou_alice'] }), deps))
      .toEqual([{ larkAppId: STEWARD_A, ok: true }]);
    expect(await joinStewardsToNewChat(input({ memberOpenIds: [], initiatorUnionIds: ['on_alice'] }), deps))
      .toEqual([{ larkAppId: STEWARD_A, ok: true }]);
  });

  it('关掉「拉新群时带上管家」或管家没开：不带，也不去查任何身份', async () => {
    configs[1] = bot(STEWARD_A, { steward: { enabled: true, autoJoinNewGroups: false } });
    expect(await joinStewardsToNewChat(input(), deps)).toEqual([]);
    configs[1] = bot(STEWARD_A, { steward: { enabled: false, chatId: 'oc_s' } });
    expect(await joinStewardsToNewChat(input(), deps)).toEqual([]);
    expect(deps.readAdminUnions).not.toHaveBeenCalled();
    expect(deps.lookupUnion).not.toHaveBeenCalled();
    expect(deps.markSilentJoin).not.toHaveBeenCalled();
    expect(deps.addBot).not.toHaveBeenCalled();
  });

  it('只有一个人和一个 bot 的新群：默认不带且一次身份都不查；管家打开 autoJoinSoloGroups 才带', async () => {
    expect(await joinStewardsToNewChat(input({ soloGroup: true }), deps)).toEqual([]);
    for (const fn of [deps.readAdminUnions, deps.lookupUnion, deps.markSilentJoin, deps.addBot]) {
      expect(fn).not.toHaveBeenCalled();
    }
    configs[1] = bot(STEWARD_A, { steward: { enabled: true, autoJoinSoloGroups: true } });
    expect(await joinStewardsToNewChat(input({ soloGroup: true }), deps)).toEqual([{ larkAppId: STEWARD_A, ok: true }]);
  });

  it('没开管家的部署：只读一次 bots.json，不查身份、不写标记、不加 bot', async () => {
    configs = [bot(CREATOR), bot('cli_plain')];
    expect(await joinStewardsToNewChat(input(), deps)).toEqual([]);
    expect(deps.loadConfigs).toHaveBeenCalledTimes(1);
    for (const fn of [deps.readAdminUnions, deps.lookupUnion, deps.markSilentJoin, deps.addBot, deps.log]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('管家本来就在要拉的 bot 里、或它就是建群的 bot：不重复加', async () => {
    expect(await joinStewardsToNewChat(input({ requestedBotAppIds: [CREATOR, STEWARD_A] }), deps)).toEqual([]);
    configs = [bot(CREATOR, { steward: { enabled: true } })];
    expect(await joinStewardsToNewChat(input(), deps)).toEqual([]);
    expect(deps.addBot).not.toHaveBeenCalled();
  });

  it('同机多个 owner 各有管家：只带 owner 在新群里的那个', async () => {
    configs.push(bot(STEWARD_B, { steward: { enabled: true } }));
    expect(await joinStewardsToNewChat(input({ memberOpenIds: ['ou_bob'] }), deps)).toEqual([{ larkAppId: STEWARD_B, ok: true }]);
    expect(deps.addBot.mock.calls).toEqual([[STEWARD_B]]);
    // 两个 owner 都在群里时两个都带；每个成员只换一次 union_id。
    deps.addBot.mockClear();
    deps.lookupUnion.mockClear();
    expect(await joinStewardsToNewChat(input({ memberOpenIds: ['ou_alice', 'ou_bob'] }), deps))
      .toEqual([{ larkAppId: STEWARD_A, ok: true }, { larkAppId: STEWARD_B, ok: true }]);
    expect(deps.lookupUnion.mock.calls).toEqual([['ou_alice'], ['ou_bob']]);
  });

  it('群里人多时：owner 一找到就停止换 union_id，不把群里每个人都查一遍', async () => {
    const crowd = Array.from({ length: 12 }, (_, i) => `ou_member_${i}`);
    expect(await joinStewardsToNewChat(input({ memberOpenIds: ['ou_alice', ...crowd] }), deps))
      .toEqual([{ larkAppId: STEWARD_A, ok: true }]);
    expect(deps.lookupUnion.mock.calls.length).toBeLessThan(crowd.length);
    // owner 不在群里时才会把所有人查完，结论是不带。
    deps.lookupUnion.mockClear();
    expect(await joinStewardsToNewChat(input({ memberOpenIds: crowd }), deps)).toEqual([]);
    expect(deps.lookupUnion.mock.calls.length).toBe(crowd.length);
  });

  it('认不出 owner 就不带：管家没发布 owner、成员换不出 union_id、apiOnly 的 bot', async () => {
    deps.readAdminUnions.mockReturnValueOnce({ admins: new Set(['on_alice']), exact: true });
    expect(await joinStewardsToNewChat(input(), deps)).toEqual([]);
    deps.lookupUnion.mockRejectedValueOnce(new Error('contact scope missing'));
    expect(await joinStewardsToNewChat(input(), deps)).toEqual([]);
    expect(await joinStewardsToNewChat(input({ memberOpenIds: ['ou_stranger'] }), deps)).toEqual([]);
    configs[1] = bot(STEWARD_A, { steward: { enabled: true }, apiOnly: true });
    expect(await joinStewardsToNewChat(input(), deps)).toEqual([]);
    expect(deps.addBot).not.toHaveBeenCalled();
  });

  it('加管家失败（飞书拒绝或抛错）：只记在结果和日志里，撤掉静默标记，后面的管家照加', async () => {
    configs.push(bot(STEWARD_B, { steward: { enabled: true } }));
    addResult[STEWARD_A] = { ok: false, error: 'invalid_id' };
    const res = await joinStewardsToNewChat(input({ memberOpenIds: ['ou_alice', 'ou_bob'] }), deps);
    expect(res).toEqual([{ larkAppId: STEWARD_A, ok: false, error: 'invalid_id' }, { larkAppId: STEWARD_B, ok: true }]);
    expect(deps.clearSilentJoin.mock.calls).toEqual([[STEWARD_A]]);
    expect(deps.log).toHaveBeenCalledWith('warn', expect.stringContaining('invalid_id'));

    addResult[STEWARD_A] = new Error('socket hang up');
    expect(await joinStewardsToNewChat(input(), deps)).toEqual([{ larkAppId: STEWARD_A, ok: false, error: 'socket hang up' }]);
  });

  it('bots.json 读不了：不带管家，不抛错', async () => {
    deps.loadConfigs.mockImplementation(() => { throw new Error('BOTS_CONFIG file not found'); });
    await expect(joinStewardsToNewChat(input(), deps)).resolves.toEqual([]);
  });
});

describe('静默加入标记', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'steward-silent-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('只对写了标记的管家 × 群、在有效期内生效；撤掉后失效', () => {
    const now = 1_000_000;
    markStewardSilentJoin(dir, STEWARD_A, 'oc_new', now);
    expect(isStewardSilentJoin(dir, STEWARD_A, 'oc_new', now + 1_000)).toBe(true);
    expect(isStewardSilentJoin(dir, STEWARD_A, 'oc_new', now + STEWARD_SILENT_JOIN_TTL_MS + 1)).toBe(false);
    expect(isStewardSilentJoin(dir, STEWARD_B, 'oc_new', now)).toBe(false);
    expect(isStewardSilentJoin(dir, STEWARD_A, 'oc_other', now)).toBe(false);
    clearStewardSilentJoin(dir, STEWARD_A, 'oc_new');
    expect(isStewardSilentJoin(dir, STEWARD_A, 'oc_new', now)).toBe(false);
  });

  it('没开管家的部署没有标记目录；写新标记时清掉过期的；不安全的 id 不落盘', () => {
    expect(isStewardSilentJoin(dir, STEWARD_A, 'oc_new')).toBe(false);
    expect(existsSync(join(dir, 'steward-silent-joins'))).toBe(false);
    const now = Date.now();
    markStewardSilentJoin(dir, STEWARD_A, 'oc_old', now);
    const old = (now - STEWARD_SILENT_JOIN_TTL_MS - 60_000) / 1000;
    utimesSync(join(dir, 'steward-silent-joins', STEWARD_A, 'oc_old'), old, old);
    markStewardSilentJoin(dir, STEWARD_A, 'oc_new', now);
    expect(readdirSync(join(dir, 'steward-silent-joins', STEWARD_A))).toEqual(['oc_new']);
    expect(() => markStewardSilentJoin(dir, '../escape', 'oc_x')).toThrow();
    expect(() => markStewardSilentJoin(dir, STEWARD_A, '../../x')).toThrow();
    expect(isStewardSilentJoin(dir, '../escape', 'oc_x')).toBe(false);
  });
});
