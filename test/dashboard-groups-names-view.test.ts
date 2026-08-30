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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
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

describe('路由接线与前端调用方（source-lock）', () => {
  it('/api/groups 注册了 view=names 分支，且不与 compact 抢路径', () => {
    const source = readFileSync(resolve('src/dashboard.ts'), 'utf8');
    const start = source.indexOf("url.pathname === '/api/groups'");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, start + 2600);
    expect(block).toContain("url.searchParams.get('view') === 'names'");
    expect(block).toContain('groupsNamesMatrix(matrix)');
    // compact 分支仍在（不是被替换掉）
    expect(block).toContain("url.searchParams.get('view') === 'compact'");
    expect(block).toContain('compactGroupsMatrix(matrix)');
  });

  it('loadNameMaps 走轻量视图，且不再拉完整矩阵', () => {
    const source = readFileSync(resolve('src/dashboard/web/ui.ts'), 'utf8');
    expect(source).toContain('fetchGroupsNamesSnapshot()');
    // 有牙：改回 fetchGroupsSnapshot() 就红（12.59MB 又回来了）
    expect(source).not.toContain('fetchGroupsSnapshot(');
  });

  it('轻量缓存与完整矩阵缓存分离，绝不污染需要 memberBots 的页面', () => {
    const source = readFileSync(resolve('src/dashboard/web/groups-api.ts'), 'utf8');
    // 两条独立的缓存变量
    expect(source).toContain('let cachedNames');
    expect(source).toContain('let cachedNamesAt');
    // 按声明位置切出两个函数体，**不假设**它们在文件里的先后顺序（早先一版
    // 测试把顺序写反，导致切片跑到文件末尾、把另一个函数也圈进来而误红）。
    const bounds = [
      { name: 'names', at: source.indexOf('export async function fetchGroupsNamesSnapshot') },
      { name: 'full', at: source.indexOf('export async function fetchGroupsSnapshot') },
    ].sort((a, b) => a.at - b.at);
    expect(bounds[0].at).toBeGreaterThan(-1);
    const bodyOf = (name: 'names' | 'full'): string => {
      const i = bounds.findIndex(b => b.name === name);
      const from = bounds[i].at;
      const to = i + 1 < bounds.length ? bounds[i + 1].at : source.length;
      return source.slice(from, to);
    };
    // 关键判据：轻量路径**不得**调用 primeGroupsSnapshotCache（那会把
    // memberBots: [] 灌进群组/角色/日程页共用的那份快照）。
    const namesFn = bodyOf('names');
    expect(namesFn).not.toContain('primeGroupsSnapshotCache');
    expect(namesFn).toContain('cachedNames = snapshot');
    // 完整矩阵那条路径仍然写共享缓存（没被误伤）
    const fullFn = bodyOf('full');
    expect(fullFn.length).toBeGreaterThan(0);
    expect(fullFn).toContain('primeGroupsSnapshotCache(snapshot)');
  });

  it('仍需 memberBots 的页面继续用完整矩阵（没被顺手改错）', () => {
    for (const [file, why] of [
      ['src/dashboard/web/groups-page.tsx', '群组页'],
      ['src/dashboard/web/bot-defaults-page.tsx', 'Bot 配置页的反馈区块'],
      ['src/dashboard/web/schedules-page.tsx', '日程页'],
    ] as const) {
      const source = readFileSync(resolve(file), 'utf8');
      expect(source, `${why} 必须继续拉完整矩阵`).toContain('fetchGroupsSnapshot');
      expect(source, `${why} 不该改用轻量视图`).not.toContain('fetchGroupsNamesSnapshot');
    }
  });

  // ─── 启动链与 Cards tab 两条回归（源码守卫覆盖不到的运行时路径）────────
  //
  // 起因：app.tsx 启动时并行跑 loadNameMaps() 与 loadGroupsSnapshot()。master
  // 上两者打同一个 fetchGroupsSnapshot()，被 in-flight 去重成**一次**请求。
  // 只把前者换成 names ⟹ 落在不同 in-flight 上 ⟹ 变成「names 387KB + full
  // 12.73MB」两发，MEASURED 合计 13.11MB，**比改动前 12.73MB 更差**。
  it('overview 与 loadNameMaps 必须共享同一个 in-flight（否则首页净增一发）', () => {
    const overview = readFileSync(resolve('src/dashboard/web/overview.ts'), 'utf8');
    const ui = readFileSync(resolve('src/dashboard/web/ui.ts'), 'utf8');
    // 两条都必须走轻量视图，才会命中同一个 namesInFlight
    expect(overview).toContain('fetchGroupsNamesSnapshot()');
    expect(ui).toContain('fetchGroupsNamesSnapshot()');
    // 有牙：overview 退回完整矩阵 → 红（启动链那条回归）
    expect(overview).not.toMatch(/fetchGroupsSnapshot\(/);
    // app.tsx 确实并行跑这两个（前提没变；若哪天不再并行，本用例的理由需重估）
    const app = readFileSync(resolve('src/dashboard/web/app.tsx'), 'utf8');
    expect(app).toContain('loadNameMaps()');
    expect(app).toContain('loadGroupsSnapshot()');
  });

  it('反馈区块的完整矩阵拉取延迟到 Cards tab 激活，且不靠条件卸载', () => {
    const source = readFileSync(resolve('src/dashboard/web/bot-defaults-page.tsx'), 'utf8');
    // 各 tab 用 hidden 隐藏而非卸载 ⟹ 本区块任何 tab 下都会 mount。
    // 无条件拉取 = 每次进 Bot 配置页都后台补一发 12.7MB。
    expect(source).toContain('active={props.activeTab === \'cards\'}');
    const section = source.slice(
      source.indexOf('function FeedbackSettingsSection'),
      source.indexOf('async function save', source.indexOf('function FeedbackSettingsSection')),
    );
    expect(section.length).toBeGreaterThan(0);
    // 有牙：删掉这道闸 → 红
    expect(section).toContain('if (!props.active) return;');
    // 「每 bot 只拉一次」闸门：把 active 加进依赖会让每次切回 tab 都重跑 effect，
    // 3s 缓存过期后又一发 12.7MB。行为断言在
    // dashboard-groups-names-inflight.test.ts 的 createOncePerKeyGate 用例里。
    expect(section).toContain('chatsGateRef.current.claim(props.bot.larkAppId)');
    // 失败要释放认领，否则一次网络抖动让该 bot 的群列表永久空着
    expect(section).toContain('chatsGateRef.current.release(appId)');
    // 依赖数组要带 active，否则激活后不会重跑
    expect(section).toMatch(/\[props\.bot\.larkAppId,\s*props\.active\]/);
    // 刻意保留挂载（不做 `{active && <Section/>}`）：条件卸载会丢用户正在编辑
    // 的 JSON 草稿。这里断言 section 仍是无条件渲染的。
    expect(source).toMatch(/<FeedbackSettingsSection[^>]*active=/);
    expect(source).not.toMatch(/\{\s*props\.activeTab === 'cards' && <FeedbackSettingsSection/);
  });
});
