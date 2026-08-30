/**
 * dashboard-groups-names-inflight.test.ts
 *
 * 行为测试（非 source-lock）：钉住 app.tsx 启动链的**请求条数**。
 *
 * 背景：`app.tsx` 启动时并行跑 `loadNameMaps()`（→ names）与
 * `loadGroupsSnapshot()`（→ names）。改动前两者打同一个
 * `fetchGroupsSnapshot()`，被 in-flight 去重成一次；只改一边会变成
 * 「names 387KB + full 12.73MB」两发（MEASURED 13.11MB，比改动前更差）。
 *
 * source-lock 只能证明「两处都写了 fetchGroupsNamesSnapshot」，**证不出运行时
 * 真的只发一次**——`fetchGroupsNamesSnapshot` 里还有一条「完整矩阵新鲜时复用
 * cachedSnapshot」的超集捷径，并发时序下它有没有可能让一个走 cache、另一个
 * 发请求？那是我推理出来的，不是实测。所以这里直接数 fetch 次数。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NAMES_URL = '/api/groups?view=names';
const FULL_URL = '/api/groups';

function payload() {
  return {
    ok: true,
    json: async () => ({
      chats: [{ chatId: 'oc_a', name: 'A', avatar: 'https://x/a.png' }],
      bots: [{ larkAppId: 'cli_1', botName: 'bot-one', botAvatarUrl: 'https://x/b.png', cliId: 'claude-code' }],
    }),
  };
}

let urls: string[] = [];

beforeEach(() => {
  urls = [];
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    urls.push(String(url));
    // 真实网络有延迟：并发窗口必须张开，否则「第二个调用命中 in-flight」这件事
    // 会因为第一个已经同步完成而变成 vacuous pass。
    await new Promise(r => setTimeout(r, 20));
    return payload() as unknown as Response;
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('启动链只发一次请求（app.tsx 的 Promise.all 并发形态）', () => {
  it('canary：探针本身有效——两次串行调用会命中 3s cache，只发一次', async () => {
    const api = await import('../src/dashboard/web/groups-api.js');
    await api.fetchGroupsNamesSnapshot();
    await api.fetchGroupsNamesSnapshot();
    // 若这条不是 1，说明 stub 没接上或缓存语义已变 —— 下面的断言就不可信
    expect(urls).toEqual([NAMES_URL]);
  });

  it('两个并发的 names 调用共享 in-flight，只发一次 names、零 full', async () => {
    const api = await import('../src/dashboard/web/groups-api.js');
    // 复刻 app.tsx:1696-1697 的形态：同一 tick 并行发出
    await Promise.all([
      api.fetchGroupsNamesSnapshot(),
      api.fetchGroupsNamesSnapshot(),
    ]);
    expect(urls.filter(u => u === NAMES_URL)).toHaveLength(1);
    // 关键：一个 full 都不能有（正是启动链那条 13.11MB 回归）
    expect(urls.filter(u => u === FULL_URL)).toHaveLength(0);
  });

  it('names 与 full 混用时各自只发一次（互不复用，也互不抵消）', async () => {
    const api = await import('../src/dashboard/web/groups-api.js');
    await Promise.all([
      api.fetchGroupsNamesSnapshot(),
      api.fetchGroupsSnapshot(),
    ]);
    // 这是「Cards tab 激活」等真实场景：两种数据都要，各一发，不重复
    expect(urls.filter(u => u === NAMES_URL)).toHaveLength(1);
    expect(urls.filter(u => u === FULL_URL)).toHaveLength(1);
  });

  it('完整矩阵先落地后，names 调用复用它（超集方向安全，省一发）', async () => {
    const api = await import('../src/dashboard/web/groups-api.js');
    await api.fetchGroupsSnapshot();
    expect(urls).toEqual([FULL_URL]);
    await api.fetchGroupsNamesSnapshot();
    // 不再发第二条：完整矩阵是 names 的超集
    expect(urls).toEqual([FULL_URL]);
  });

  it('反向不成立：names 先落地，需要 memberBots 的调用方仍必须真拉 full', async () => {
    const api = await import('../src/dashboard/web/groups-api.js');
    const names = await api.fetchGroupsNamesSnapshot();
    expect(urls).toEqual([NAMES_URL]);
    // names 的 chats 没有 memberBots —— 若被喂给 full 的消费方，群组/角色/日程页
    // 会拿到「群里一个 bot 都没有」的静默错数据。
    expect(names.chats[0]).not.toHaveProperty('memberBots');
    await api.fetchGroupsSnapshot();
    // 必须真的发出 full 请求，不能拿 cachedNames 顶
    expect(urls.filter(u => u === FULL_URL)).toHaveLength(1);
  });
});

/**
 * 反馈设置区块的「每 bot 只拉一次」闸门。
 *
 * 起因：该区块要 memberBots（只有 12.7MB 完整矩阵有），而各 tab 用 `hidden`
 * 隐藏而非条件卸载 ⟹ 组件在任何 tab 下都 mount。把「是否激活」加进 effect
 * 依赖能避免未打开就拉，但副作用是**每次切回该 tab 都重跑**：
 * cards → common → 隔几秒回 cards，groups-api 的 3s 缓存已过期 ⟹ 又一发
 * 12.7MB。原语义是「每次 mount / 每个 botId 一次」，延迟加载不该放宽它。
 *
 * 逻辑抽成纯工厂（同 createRefreshGate 的既有做法），这样「二次激活不重拉」
 * 不必起 DOM 就能咬住 —— 仓库里没有 React 组件测试设施，靠 source-lock 只能
 * 证明「写了 claim」，证不出**第二次激活真的不发请求**。
 */
describe('createOncePerKeyGate — 二次激活不重拉', () => {
  it('同一 key 只认领一次：第二、第三次激活都不放行', async () => {
    const { createOncePerKeyGate } = await import('../src/dashboard/web/bot-defaults.js');
    const gate = createOncePerKeyGate();
    expect(gate.claim('cli_a')).toBe(true);   // 首次激活 → 拉
    expect(gate.claim('cli_a')).toBe(false);  // 切走再回来 → 不拉
    expect(gate.claim('cli_a')).toBe(false);
  });

  it('切换 bot 会重新认领（群列表是 per-bot 的）', async () => {
    const { createOncePerKeyGate } = await import('../src/dashboard/web/bot-defaults.js');
    const gate = createOncePerKeyGate();
    expect(gate.claim('cli_a')).toBe(true);
    expect(gate.claim('cli_b')).toBe(true);   // 换 bot → 必须拉
    expect(gate.claim('cli_b')).toBe(false);
    // 切回旧 bot 也会重拉一次（只记最近一个 key，够用且不占内存）
    expect(gate.claim('cli_a')).toBe(true);
    // 注：当前调用点的父组件带 key={larkAppId:...}，切 bot 会整体 remount、
    // 闸门随之新建，所以这条在**今天的接线下走不到**。仍然断言它，是为了让
    // 「换 bot 必须重拉」这条不变量不悄悄依赖别处的 key 拼法 —— 那个 key 是为
    // profileRoleVersion 加的，不是为本闸门加的，随时可能变。
  });

  it('失败释放后允许重试（否则一次网络抖动让列表永久空着）', async () => {
    const { createOncePerKeyGate } = await import('../src/dashboard/web/bot-defaults.js');
    const gate = createOncePerKeyGate();
    expect(gate.claim('cli_a')).toBe(true);
    gate.release('cli_a');                    // 请求失败
    expect(gate.claim('cli_a')).toBe(true);   // 下次激活重试
    expect(gate.claim('cli_a')).toBe(false);  // 成功后又收敛
  });

  it('release 只影响当前 key，不会误放行别的 bot', async () => {
    const { createOncePerKeyGate } = await import('../src/dashboard/web/bot-defaults.js');
    const gate = createOncePerKeyGate();
    gate.claim('cli_a');
    gate.release('cli_b');                    // 过期的失败回调（已切走）
    expect(gate.claimed('cli_a')).toBe(true); // cli_a 的认领不该被撤销
    expect(gate.claim('cli_a')).toBe(false);
  });
});
