/**
 * dashboard-groups-names-view.test.ts
 *
 * 钉住 `?view=names` 轻量视图的契约，重点是**它不能悄悄削弱名称/头像**。
 *
 * 背景（MEASURED，本机直连）：`/api/groups` 完整矩阵 12.59MB，其中
 * `chats[].memberBots`（1420 群 × 56 bot）独占 12341KB；而 `loadNameMaps()`
 * 只需要 bots 的名称/头像 + chats 的 chatId/name/avatar。
 *
 * 为什么不复用已有的 `?view=compact`：实测它的顶层 key 只有 `['chats']`，
 * `bots` 是 undefined。而 `loadNameMaps()` 恰恰读 `data.bots` —— 直接换过去
 * 会让 56 个 bot 的名字和头像**全部**退化成 raw appId。这是本次优化最容易
 * 踩、且用户一眼可见的退化，所以下面第一组用例专门把它钉死。
 *
 * 第二个风险是缓存污染：群组页 / 角色页 / 日程页 / Bot 配置页的反馈区块都
 * 真的要读 `memberBots`。若轻量结果被灌进共享的 `cachedSnapshot`，它们会拿到
 * `memberBots: []` —— 「群里一个 bot 都没有」的静默错数据，比报错更难发现。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compactGroupsMatrix,
  groupsNamesMatrix,
  type GroupsMatrix,
} from '../src/dashboard/groups-matrix-snapshot.js';

function matrix(): GroupsMatrix {
  return {
    chats: [
      {
        chatId: 'oc_release',
        name: 'Release room',
        avatar: 'https://example.com/release.png',
        ownerId: 'ou_owner',
        chatMode: 'group',
        // 12.34MB 的大头：本视图必须摘掉
        memberBots: [
          { larkAppId: 'cli_a', botName: 'claude', inChat: true, hasRole: true },
          { larkAppId: 'cli_b', botName: 'codex', inChat: false },
        ],
      },
      { chatId: '', name: 'no id — dropped' },
    ],
    bots: [
      {
        larkAppId: 'cli_a',
        botName: 'claude',
        botAvatarUrl: 'https://example.com/a.png',
        cliId: 'claude-code',
      },
      {
        larkAppId: 'cli_b',
        botName: 'codex',
        botAvatarUrl: 'https://example.com/b.png',
        cliId: 'codex',
      },
    ],
  };
}

describe('groupsNamesMatrix — 名称/头像投影', () => {
  it('保留 bots 整行（名称+头像+cliId），这是与 compact 的关键差别', () => {
    const names = groupsNamesMatrix(matrix());
    // 有牙的那一半：compact 没有 bots，names 必须有。把实现改成
    // `return compactGroupsMatrix(matrix)` 这条会红。
    expect(names.bots).toHaveLength(2);
    expect(names.bots).toEqual(matrix().bots);
    // 名称与头像逐字段在位——loadNameMaps() 就是读这两个字段的
    for (const bot of names.bots as Array<Record<string, unknown>>) {
      expect(typeof bot.larkAppId).toBe('string');
      expect(typeof bot.botName).toBe('string');
      expect(typeof bot.botAvatarUrl).toBe('string');
    }
  });

  it('摘掉 memberBots（12.34MB 的来源），chats 只留 chatId/name/avatar', () => {
    const names = groupsNamesMatrix(matrix());
    expect(names.chats).toEqual([
      {
        chatId: 'oc_release',
        name: 'Release room',
        avatar: 'https://example.com/release.png',
      },
    ]);
    for (const chat of names.chats) {
      expect(chat).not.toHaveProperty('memberBots');
      // 顺带确认公开只读边界没被放宽：ownerId 不在投影里
      expect(chat).not.toHaveProperty('ownerId');
    }
  });

  it('与 compact 共用同一条 chats 白名单（避免两处实现漂移）', () => {
    expect(groupsNamesMatrix(matrix()).chats).toEqual(compactGroupsMatrix(matrix()).chats);
  });

  it('compact 仍然不带 bots —— 记录「为何不能复用它」这个前提', () => {
    // 若将来有人给 compact 加上 bots，这条会红，提示回来重新评估本视图是否
    // 还有必要（而不是让两个视图静默重复）。
    expect(compactGroupsMatrix(matrix())).not.toHaveProperty('bots');
  });
});

// 起因：app.tsx 启动时并行跑 loadNameMaps() 与 loadGroupsSnapshot()。只把其中一个换成
// names ⟹ 两者落在不同 in-flight 上 ⟹「names 387KB + full 12.73MB」两发（MEASURED
// 13.11MB，比改动前更差）。这里直接数真实调用方发出的请求。
describe('启动链调用方走轻量视图', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('并行的 loadNameMaps 与总览快照只发一条 ?view=names，且名称映射被真正填上', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      urls.push(String(url));
      // 张开并发窗口，否则「第二个调用命中 in-flight」会退化成 vacuous pass。
      await new Promise(r => setTimeout(r, 20));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          chats: [{ chatId: 'oc_a', name: 'A', avatar: 'https://x/a.png' }],
          bots: [{ larkAppId: 'cli_1', botName: 'bot-one', botAvatarUrl: 'https://x/b.png', cliId: 'claude-code' }],
        }),
      } as Response;
    }));
    vi.resetModules();
    const ui = await import('../src/dashboard/web/ui.js');
    const overview = await import('../src/dashboard/web/overview.js');

    await Promise.all([ui.loadNameMaps(), overview.loadGroupsSnapshot()]);

    expect(urls).toEqual(['/api/groups?view=names']);
    expect(ui.botNameForAppId('cli_1')).toBe('bot-one');
  });
});
