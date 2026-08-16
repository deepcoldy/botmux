import { describe, expect, it } from 'vitest';
import {
  WORKBENCH_GROUP_DIMENSIONS,
  WORKBENCH_RAIL_DEFAULT,
  WORKBENCH_RAIL_MAX,
  WORKBENCH_RAIL_MIN,
  defaultWorkbenchLayout,
  type WorkbenchGroupDimension,
} from '../src/dashboard/web/agent-workbench-model.js';
import {
  emptyWorkbenchSeenLedger,
  loadWorkbenchCollapsedGroups,
  loadWorkbenchGroupDimension,
  loadWorkbenchLayout,
  loadWorkbenchRailPrefs,
  loadWorkbenchSeenLedger,
  pruneWorkbenchSeenLedger,
  saveWorkbenchCollapsedGroups,
  saveWorkbenchGroupDimension,
  saveWorkbenchLayout,
  saveWorkbenchRailPrefs,
  saveWorkbenchSeenLedger,
  workbenchLayoutStorageKey,
  type WorkbenchStorage,
} from '../src/dashboard/web/agent-workbench-storage.js';

class MemoryStorage implements WorkbenchStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

/**
 * 全局栏宽记录的 key。故意在测试里写死字面量：它是窗口级的单条记录，
 * key 里一旦混进 sessionId，侧栏就会重新按会话跳变。
 */
const RAIL_PREFS_KEY = 'botmux.agent-workbench.rail.v1';
/** 未读账本和分组维度的 key 同样写死：它们是跨版本读回来的存量数据，改名就是丢数据。 */
const SEEN_LEDGER_KEY = 'botmux.agent-workbench.seen.v1';
const GROUP_DIMENSION_KEY = 'botmux.agent-workbench.group-dim.v1';
/** 折叠分组同理：换 key 就等于把所有人手动折起来的组全部弹开。 */
const COLLAPSED_GROUPS_KEY = 'botmux.agent-workbench.collapsed.v1';
/** 与实现里的上限保持一致；超了按时间新旧裁掉最老的。 */
const SEEN_LEDGER_MAX_ENTRIES = 500;
/** 折叠表按「加入顺序」封顶，超了丢最早折叠的那些组。 */
const COLLAPSED_GROUPS_MAX_ENTRIES = 200;

describe('Agent Workbench layout persistence', () => {
  it('persists independently per session and never serializes capabilities or URLs', () => {
    const storage = new MemoryStorage();
    const first = { ...defaultWorkbenchLayout(), paneMode: 'split' as const, splitAxis: 'vertical' as const, chatRequested: true };
    expect(saveWorkbenchLayout('a/b', first, storage)).toBe(true);
    expect(loadWorkbenchLayout('a/b', storage)).toEqual(first);
    expect(loadWorkbenchLayout('other', storage)).toEqual(defaultWorkbenchLayout());
    const raw = storage.values.get(workbenchLayoutStorageKey('a/b'))!;
    expect(raw).not.toMatch(/url|token|grant|cookie|previewPath|terminalHref/i);
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      'chatRequested', 'focus', 'paneMode', 'railCollapsed', 'railWidth', 'splitAxis', 'splitRatio', 'version',
    ]);
  });

  it('fails closed to defaults for corrupt storage', () => {
    const storage = new MemoryStorage();
    storage.setItem(workbenchLayoutStorageKey('bad'), '{broken');
    expect(loadWorkbenchLayout('bad', storage)).toEqual(defaultWorkbenchLayout());
  });
});

describe('Agent Workbench rail preferences', () => {
  it('round-trips width and collapsed state through one window-global record', () => {
    const storage = new MemoryStorage();
    expect(loadWorkbenchRailPrefs(storage)).toBeNull();
    expect(saveWorkbenchRailPrefs(storage, { railWidth: 220, railCollapsed: true })).toBe(true);
    expect(loadWorkbenchRailPrefs(storage)).toEqual({ railWidth: 220, railCollapsed: true });
    // 只落一条记录，key 里不带 sessionId —— 这就是宽度不再随会话跳变的根据。
    expect([...storage.values.keys()]).toEqual([RAIL_PREFS_KEY]);
    expect(saveWorkbenchRailPrefs(storage, { railWidth: 264, railCollapsed: false })).toBe(true);
    expect(loadWorkbenchRailPrefs(storage)).toEqual({ railWidth: 264, railCollapsed: false });
    expect([...storage.values.keys()]).toEqual([RAIL_PREFS_KEY]);
  });

  it('clamps out-of-range widths on the way in and on the way out', () => {
    const storage = new MemoryStorage();
    saveWorkbenchRailPrefs(storage, { railWidth: 9999, railCollapsed: false });
    expect(JSON.parse(storage.values.get(RAIL_PREFS_KEY)!).railWidth).toBe(WORKBENCH_RAIL_MAX);
    expect(loadWorkbenchRailPrefs(storage)!.railWidth).toBe(WORKBENCH_RAIL_MAX);
    saveWorkbenchRailPrefs(storage, { railWidth: 4, railCollapsed: false });
    expect(loadWorkbenchRailPrefs(storage)!.railWidth).toBe(WORKBENCH_RAIL_MIN);
    // 别人写坏的存量记录同样要被夹住，而不是把 9999px 的栏宽读回来。
    storage.setItem(RAIL_PREFS_KEY, JSON.stringify({ railWidth: 9999, railCollapsed: true }));
    expect(loadWorkbenchRailPrefs(storage)).toEqual({ railWidth: WORKBENCH_RAIL_MAX, railCollapsed: true });
  });

  it('fails closed for corrupt or wrong-shaped records instead of throwing', () => {
    const storage = new MemoryStorage();
    for (const raw of ['{broken', 'null', '[]', '"300"', 'true', '']) {
      storage.setItem(RAIL_PREFS_KEY, raw);
      expect(loadWorkbenchRailPrefs(storage), raw).toBeNull();
    }
    // 结构对、字段是垃圾：宽度回落到默认值，collapsed 只认真正的 true。
    storage.setItem(RAIL_PREFS_KEY, JSON.stringify({ railWidth: 'wide', railCollapsed: 'yes' }));
    expect(loadWorkbenchRailPrefs(storage)).toEqual({ railWidth: WORKBENCH_RAIL_DEFAULT, railCollapsed: false });
    storage.setItem(RAIL_PREFS_KEY, JSON.stringify({}));
    expect(loadWorkbenchRailPrefs(storage)).toEqual({ railWidth: WORKBENCH_RAIL_DEFAULT, railCollapsed: false });
  });

  it('treats a missing or throwing storage as no preference at all', () => {
    expect(loadWorkbenchRailPrefs(null)).toBeNull();
    expect(loadWorkbenchRailPrefs(undefined)).toBeNull();
    expect(saveWorkbenchRailPrefs(null, { railWidth: 220, railCollapsed: false })).toBe(false);
    // Safari 无痕模式的 localStorage 会直接抛，读写都不能把页面带崩。
    const hostile: WorkbenchStorage = {
      getItem() { throw new Error('SecurityError'); },
      setItem() { throw new Error('QuotaExceededError'); },
    };
    expect(loadWorkbenchRailPrefs(hostile)).toBeNull();
    expect(saveWorkbenchRailPrefs(hostile, { railWidth: 220, railCollapsed: false })).toBe(false);
  });

  it('stays independent of the per-session layout records', () => {
    const storage = new MemoryStorage();
    saveWorkbenchLayout('a/b', { ...defaultWorkbenchLayout(), railWidth: 200 }, storage);
    saveWorkbenchLayout('c/d', { ...defaultWorkbenchLayout(), railWidth: 260 }, storage);
    // 会话记录再多也不会凭空生出全局记录：老用户首次进来要走 per-session 迁移兜底。
    expect(loadWorkbenchRailPrefs(storage)).toBeNull();
    saveWorkbenchRailPrefs(storage, { railWidth: 270, railCollapsed: false });
    // 反过来，写全局栏宽也不许改动任何会话记录。
    expect(loadWorkbenchLayout('a/b', storage).railWidth).toBe(200);
    expect(loadWorkbenchLayout('c/d', storage).railWidth).toBe(260);
    expect(loadWorkbenchRailPrefs(storage)).toEqual({ railWidth: 270, railCollapsed: false });
  });
});

describe('Agent Workbench 未读账本 seen.v1', () => {
  it('按单条 key 往返，只落 id 和时间戳', () => {
    const storage = new MemoryStorage();
    // 没存过时回 null，而不是空账本：调用方要靠这个区分「首次进来」，好把当前
    // 快照全部记成已读，否则第一次打开满屏历史会话都会报未读。
    expect(loadWorkbenchSeenLedger(storage)).toBeNull();

    const ledger = { seen: { 'a/b': 1_700_000_000_000 }, unread: { 'c/d': 1_700_000_000_500 } };
    expect(saveWorkbenchSeenLedger(storage, ledger)).toBe(true);
    expect(loadWorkbenchSeenLedger(storage)).toEqual(ledger);
    // 一条窗口级记录，key 里不带 sessionId。
    expect([...storage.values.keys()]).toEqual([SEEN_LEDGER_KEY]);

    const raw = storage.values.get(SEEN_LEDGER_KEY)!;
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['seen', 'unread']);
    // 未读提示不需要标题、聊天内容或任何链接，落盘里也不许出现。
    expect(raw).not.toMatch(/title|url|token|grant|cookie|message|reason/i);

    expect(saveWorkbenchSeenLedger(storage, emptyWorkbenchSeenLedger())).toBe(true);
    expect(loadWorkbenchSeenLedger(storage)).toEqual({ seen: {}, unread: {} });
  });

  it('坏账本回 null，坏条目只丢自己那一条', () => {
    const storage = new MemoryStorage();
    // 整张表不成形：回 null，让调用方重新走首次基线。
    for (const raw of ['{broken', 'null', '[]', '"x"', 'true', '', '{}', '{"seen":1,"unread":"x"}']) {
      storage.setItem(SEEN_LEDGER_KEY, raw);
      expect(loadWorkbenchSeenLedger(storage), raw).toBeNull();
    }
    // 半张表仍然可用，另一半按空处理——老版本只写过 seen 的记录不该整份作废。
    storage.setItem(SEEN_LEDGER_KEY, JSON.stringify({ seen: { 'a/b': 5 } }));
    expect(loadWorkbenchSeenLedger(storage)).toEqual({ seen: { 'a/b': 5 }, unread: {} });

    // 表结构对、个别条目是垃圾：逐条丢掉即可，剩下的照常读回来。
    storage.setItem(SEEN_LEDGER_KEY, JSON.stringify({
      seen: { good: 10, zero: 0, negative: -5, notNumber: 'later', nulled: null, '': 7 },
      unread: { alsoGood: 11, infinite: Number.POSITIVE_INFINITY },
    }));
    expect(loadWorkbenchSeenLedger(storage)).toEqual({ seen: { good: 10 }, unread: { alsoGood: 11 } });
  });

  it('超过 500 条按时间裁掉最老的，写盘时就裁而不是等到读', () => {
    const storage = new MemoryStorage();
    const seen: Record<string, number> = {};
    const unread: Record<string, number> = {};
    for (let index = 0; index < 600; index += 1) {
      seen[`session-${index}`] = 1_700_000_000_000 + index;
      unread[`session-${index}`] = 1_700_000_000_000 + index;
    }
    expect(saveWorkbenchSeenLedger(storage, { seen, unread })).toBe(true);

    // 常年不关的机器不能把 localStorage 撑爆：落盘的那一份就已经是 500 条。
    const persisted = JSON.parse(storage.values.get(SEEN_LEDGER_KEY)!);
    expect(Object.keys(persisted.seen)).toHaveLength(SEEN_LEDGER_MAX_ENTRIES);
    expect(Object.keys(persisted.unread)).toHaveLength(SEEN_LEDGER_MAX_ENTRIES);

    const loaded = loadWorkbenchSeenLedger(storage)!;
    expect(Object.keys(loaded.seen)).toHaveLength(SEEN_LEDGER_MAX_ENTRIES);
    // 留下的是最近的 500 条（100..599），最老的 100 条被砍掉。
    expect(loaded.seen['session-599']).toBe(1_700_000_000_599);
    expect(loaded.seen['session-100']).toBe(1_700_000_000_100);
    expect(loaded.seen['session-99']).toBeUndefined();
    expect(loaded.seen['session-0']).toBeUndefined();

    // 上限可注入，裁剪本身按时间新旧而不是插入顺序。
    const pruned = pruneWorkbenchSeenLedger({ seen: { old: 1, newest: 3, middle: 2 }, unread: {} }, 2);
    expect(Object.keys(pruned.seen).sort()).toEqual(['middle', 'newest']);
    // 没超上限时原样保留。
    expect(pruneWorkbenchSeenLedger({ seen: { a: 1 }, unread: { b: 2 } }, 500))
      .toEqual({ seen: { a: 1 }, unread: { b: 2 } });
  });

  it('缺失或会抛异常的 storage 当作没有账本', () => {
    expect(loadWorkbenchSeenLedger(null)).toBeNull();
    expect(loadWorkbenchSeenLedger(undefined)).toBeNull();
    expect(saveWorkbenchSeenLedger(null, emptyWorkbenchSeenLedger())).toBe(false);
    // Safari 无痕模式的 localStorage 直接抛，读写都不能把页面带崩。
    const hostile: WorkbenchStorage = {
      getItem() { throw new Error('SecurityError'); },
      setItem() { throw new Error('QuotaExceededError'); },
    };
    expect(loadWorkbenchSeenLedger(hostile)).toBeNull();
    expect(saveWorkbenchSeenLedger(hostile, emptyWorkbenchSeenLedger())).toBe(false);
  });
});

describe('Agent Workbench 分组维度 group-dim.v1', () => {
  it('只接受白名单里的六个维度，脏值当没存过', () => {
    const storage = new MemoryStorage();
    expect(loadWorkbenchGroupDimension(storage)).toBeNull();

    for (const option of WORKBENCH_GROUP_DIMENSIONS) {
      expect(saveWorkbenchGroupDimension(storage, option.value), option.value).toBe(true);
      expect(loadWorkbenchGroupDimension(storage), option.value).toBe(option.value);
    }
    // 全局偏好，一条记录，不分会话。
    expect([...storage.values.keys()]).toEqual([GROUP_DIMENSION_KEY]);
    // 裸字符串存盘，不套 JSON —— 读的那头正是这么认的。
    expect(storage.values.get(GROUP_DIMENSION_KEY)).toBe('time');

    // 白名单外的值不写盘，也不许把已存的选择覆盖掉。
    for (const bad of ['repo', '', 'STATUS', 'bot ']) {
      expect(saveWorkbenchGroupDimension(storage, bad as WorkbenchGroupDimension), bad).toBe(false);
    }
    expect(loadWorkbenchGroupDimension(storage)).toBe('time');

    // 别人写坏的存量记录读回 null，调用方回落到默认的 status。
    for (const raw of ['repo', '', 'STATUS', '{"dimension":"bot"}', '["bot"]', 'null']) {
      storage.setItem(GROUP_DIMENSION_KEY, raw);
      expect(loadWorkbenchGroupDimension(storage), raw).toBeNull();
    }
  });

  it('和栏宽、未读账本、会话布局互不干扰', () => {
    const storage = new MemoryStorage();
    saveWorkbenchLayout('a/b', { ...defaultWorkbenchLayout(), railWidth: 200 }, storage);
    saveWorkbenchRailPrefs(storage, { railWidth: 270, railCollapsed: true });
    saveWorkbenchSeenLedger(storage, { seen: { 'a/b': 7 }, unread: {} });
    saveWorkbenchGroupDimension(storage, 'cli');

    expect([...storage.values.keys()].sort()).toEqual([
      GROUP_DIMENSION_KEY, RAIL_PREFS_KEY, SEEN_LEDGER_KEY, workbenchLayoutStorageKey('a/b'),
    ].sort());
    expect(loadWorkbenchGroupDimension(storage)).toBe('cli');
    expect(loadWorkbenchSeenLedger(storage)).toEqual({ seen: { 'a/b': 7 }, unread: {} });
    expect(loadWorkbenchRailPrefs(storage)).toEqual({ railWidth: 270, railCollapsed: true });
    expect(loadWorkbenchLayout('a/b', storage).railWidth).toBe(200);
  });

  it('缺失或会抛异常的 storage 当作没有偏好', () => {
    expect(loadWorkbenchGroupDimension(null)).toBeNull();
    expect(loadWorkbenchGroupDimension(undefined)).toBeNull();
    expect(saveWorkbenchGroupDimension(null, 'bot')).toBe(false);
    const hostile: WorkbenchStorage = {
      getItem() { throw new Error('SecurityError'); },
      setItem() { throw new Error('QuotaExceededError'); },
    };
    expect(loadWorkbenchGroupDimension(hostile)).toBeNull();
    expect(saveWorkbenchGroupDimension(hostile, 'bot')).toBe(false);
  });
});

describe('Agent Workbench 折叠分组 collapsed.v1', () => {
  it('按一条全局记录往返，存的只是带维度前缀的组 key', () => {
    const storage = new MemoryStorage();
    // 没存过 = 没折叠过：回 null，调用方走「全部展开」的默认。
    expect(loadWorkbenchCollapsedGroups(storage)).toBeNull();

    expect(saveWorkbenchCollapsedGroups(storage, new Set(['active', 'bot:Builder', 'cli:codex']))).toBe(true);
    // 加入顺序即存盘顺序——封顶时要靠它判断谁是「最早折叠的」。
    expect(loadWorkbenchCollapsedGroups(storage)).toEqual(['active', 'bot:Builder', 'cli:codex']);
    // 窗口级的一条记录，key 里不带 sessionId：工作台和会话坞共用同一份折叠状态。
    expect([...storage.values.keys()]).toEqual([COLLAPSED_GROUPS_KEY]);
    // 落盘就是一个裸数组，且只有组 key —— 不带标题、链接或会话内容。
    const raw = storage.values.get(COLLAPSED_GROUPS_KEY)!;
    expect(JSON.parse(raw)).toEqual(['active', 'bot:Builder', 'cli:codex']);
    expect(raw).not.toMatch(/title|url|token|grant|cookie|sessionId/i);

    // 「一个都没折叠」和「没存过」是两回事：前者是用户把组全展开了，读回空数组。
    expect(saveWorkbenchCollapsedGroups(storage, [])).toBe(true);
    expect(loadWorkbenchCollapsedGroups(storage)).toEqual([]);

    // 重复 key 只留一份，顺序按首次出现。
    expect(saveWorkbenchCollapsedGroups(storage, ['active', 'bot:Builder', 'active'])).toBe(true);
    expect(loadWorkbenchCollapsedGroups(storage)).toEqual(['active', 'bot:Builder']);
  });

  it('坏记录回 null，数组里的坏条目只丢自己那一条', () => {
    const storage = new MemoryStorage();
    // 不是 JSON、或者根本不是数组：整份作废，回 null 走「全部展开」。
    // 一份读不懂的记忆比没有记忆更糟——它会让某些组永远打不开。
    for (const bad of ['{broken', 'null', 'true', '"active"', '42', '{}', '{"keys":["active"]}', '']) {
      storage.setItem(COLLAPSED_GROUPS_KEY, bad);
      expect(loadWorkbenchCollapsedGroups(storage), bad).toBeNull();
    }

    // 数组里混进非字符串：只剔掉那几项，不为一颗老鼠屎丢掉整份折叠状态。
    storage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([
      'active', 42, null, '', 'bot:Builder', { key: 'chat:前端群' }, ['cli:codex'], true, 'recent',
    ]));
    expect(loadWorkbenchCollapsedGroups(storage)).toEqual(['active', 'bot:Builder', 'recent']);

    // 空数组是合法记录，不是坏数据。
    storage.setItem(COLLAPSED_GROUPS_KEY, '[]');
    expect(loadWorkbenchCollapsedGroups(storage)).toEqual([]);
  });

  it('超过 200 条丢掉最早折叠的，写盘时就裁而不是等到读', () => {
    const storage = new MemoryStorage();
    const keys = Array.from({ length: 250 }, (_, index) => `bot:group-${index}`);
    expect(saveWorkbenchCollapsedGroups(storage, keys)).toBe(true);

    // 组名是数据里的自由文本（机器人名、会话名、仓库名），不封顶这张表只会越堆越长。
    const persisted: string[] = JSON.parse(storage.values.get(COLLAPSED_GROUPS_KEY)!);
    expect(persisted).toHaveLength(COLLAPSED_GROUPS_MAX_ENTRIES);
    // 数组按加入顺序存，所以砍掉的是最前面的（最早折叠的那 50 个）。
    expect(persisted[0]).toBe('bot:group-50');
    expect(persisted.at(-1)).toBe('bot:group-249');
    expect(persisted).not.toContain('bot:group-49');

    const loaded = loadWorkbenchCollapsedGroups(storage)!;
    expect(loaded).toHaveLength(COLLAPSED_GROUPS_MAX_ENTRIES);
    expect(loaded).toEqual(persisted);

    // 老版本写下的超长记录，读的那头同样要裁——否则升级前撑大的表会一直留着。
    storage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(keys));
    expect(loadWorkbenchCollapsedGroups(storage)).toEqual(persisted);

    // 去重发生在封顶之前：250 个 key 里只有 200 个不同的，就不该有人被裁掉。
    expect(saveWorkbenchCollapsedGroups(storage, [...keys.slice(0, 200), ...keys.slice(0, 50)])).toBe(true);
    expect(loadWorkbenchCollapsedGroups(storage)).toEqual(keys.slice(0, 200));

    // 恰好 200 条原样保留，不多裁一条。
    expect(saveWorkbenchCollapsedGroups(storage, keys.slice(0, COLLAPSED_GROUPS_MAX_ENTRIES))).toBe(true);
    expect(loadWorkbenchCollapsedGroups(storage)).toEqual(keys.slice(0, COLLAPSED_GROUPS_MAX_ENTRIES));
  });

  it('和栏宽、未读账本、分组维度、会话布局互不干扰', () => {
    const storage = new MemoryStorage();
    saveWorkbenchLayout('a/b', { ...defaultWorkbenchLayout(), railWidth: 200 }, storage);
    saveWorkbenchRailPrefs(storage, { railWidth: 270, railCollapsed: true });
    saveWorkbenchSeenLedger(storage, { seen: { 'a/b': 7 }, unread: {} });
    saveWorkbenchGroupDimension(storage, 'cli');
    saveWorkbenchCollapsedGroups(storage, ['cli:codex']);

    expect([...storage.values.keys()].sort()).toEqual([
      COLLAPSED_GROUPS_KEY, GROUP_DIMENSION_KEY, RAIL_PREFS_KEY, SEEN_LEDGER_KEY, workbenchLayoutStorageKey('a/b'),
    ].sort());
    expect(loadWorkbenchCollapsedGroups(storage)).toEqual(['cli:codex']);
    expect(loadWorkbenchGroupDimension(storage)).toBe('cli');
    expect(loadWorkbenchSeenLedger(storage)).toEqual({ seen: { 'a/b': 7 }, unread: {} });
    expect(loadWorkbenchRailPrefs(storage)).toEqual({ railWidth: 270, railCollapsed: true });
    expect(loadWorkbenchLayout('a/b', storage).railWidth).toBe(200);
  });

  it('缺失或会抛异常的 storage 当作没有折叠过', () => {
    expect(loadWorkbenchCollapsedGroups(null)).toBeNull();
    expect(loadWorkbenchCollapsedGroups(undefined)).toBeNull();
    expect(saveWorkbenchCollapsedGroups(null, ['active'])).toBe(false);
    // Safari 无痕模式的 localStorage 读写都直接抛，折叠一下不能把整个列表带崩。
    const hostile: WorkbenchStorage = {
      getItem() { throw new Error('SecurityError'); },
      setItem() { throw new Error('QuotaExceededError'); },
    };
    expect(loadWorkbenchCollapsedGroups(hostile)).toBeNull();
    expect(saveWorkbenchCollapsedGroups(hostile, ['active'])).toBe(false);
  });
});
