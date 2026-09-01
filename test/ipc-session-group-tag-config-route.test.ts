/**
 * PUT /api/session-group-tag-config —— Dashboard「会话群标签」区块的写入通路。
 *
 * 这条路由原先只收 `{ mode }`；补上标签名输入框后还要收 `{ name }`，两者可以分别
 * 单独提交（下拉只发 mode，输入框只发 name）。本文件盯住写入语义：
 *   - 合法名字 → 落到 bots.json 的 sessionGroup.tag.name，并热更内存注册表；
 *   - 前后空白只 trim，超长按码点截断，存进去的就是实际生效的那个值；
 *   - 留空（或全空白）→ 删掉该字段回默认名，bots.json 保持干净；
 *   - mode 与 name 互不干扰，非法输入各自报错。
 *
 * 跟随 test/ipc-chat-rename-route.test.ts 的写法：起一个不带 authRequired 的
 * 轻量 in-process IPC server，spy 掉持久化与注册表。
 *
 * Run:  pnpm vitest run test/ipc-session-group-tag-config-route.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import {
  setIpcAuthSecret,
  setLarkAppId,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import * as configStore from '../src/services/config-store.js';
import * as botRegistry from '../src/bot-registry.js';

const APP = 'cli_tagname_route';

let handle: IpcServerHandle | null = null;
/** bots.json 里那一条（rmwBotEntry 的 mutate 目标）。 */
let entry: any;
/** 内存注册表里的 config（热更新目标）。 */
let botConfig: any;

beforeEach(() => {
  entry = { larkAppId: APP };
  botConfig = { larkAppId: APP, larkAppSecret: 'sec', brand: 'feishu' };
  setLarkAppId(APP);
  vi.spyOn(botRegistry, 'getBot').mockReturnValue({ config: botConfig, botName: 'CodeXonAst' } as any);
  vi.spyOn(configStore, 'rmwBotEntry').mockImplementation(async (_appId: string, mutate: any) => {
    const out = mutate(entry, [entry]);
    return { ok: true, result: out?.result };
  });
});

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
});

async function put(body: unknown): Promise<{ status: number; json: any }> {
  if (!handle) handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
  const res = await fetch(`http://127.0.0.1:${handle.port}/api/session-group-tag-config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe('PUT /api/session-group-tag-config —— 标签名', () => {
  it('写入自定义名字：落盘 + 热更内存，并回显默认名给 placeholder 用', async () => {
    const { status, json } = await put({ name: '我的工作台' });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, tagName: '我的工作台', defaultTagName: 'CodeXonAst会话' });
    expect(entry.sessionGroup.tag.name).toBe('我的工作台');
    expect(botConfig.sessionGroup.tag.name).toBe('我的工作台');
  });

  it('前后空白只 trim', async () => {
    const { json } = await put({ name: '   我的工作台\t' });
    expect(json.tagName).toBe('我的工作台');
    expect(entry.sessionGroup.tag.name).toBe('我的工作台');
  });

  it('超长名字按码点截断，回显的就是真正存下来的值', async () => {
    const { json } = await put({ name: '很'.repeat(200) });
    expect(json.tagName).toBe('很'.repeat(60));
    expect(entry.sessionGroup.tag.name).toBe('很'.repeat(60));
  });

  it('留空 = 删字段回默认名（bots.json 不留空串）', async () => {
    entry.sessionGroup = { tag: { mode: 'feed-group', name: '旧名字' } };
    botConfig.sessionGroup = { tag: { mode: 'feed-group', name: '旧名字' } };

    const { json } = await put({ name: '   ' });

    expect(json).toMatchObject({ ok: true, tagName: '', tagMode: 'feed-group' });
    expect('name' in entry.sessionGroup.tag).toBe(false);
    expect('name' in botConfig.sessionGroup.tag).toBe(false);
    // 同一条 tag 上的 mode 不能被顺手清掉。
    expect(entry.sessionGroup.tag.mode).toBe('feed-group');
    expect(botConfig.sessionGroup.tag.mode).toBe('feed-group');
  });

  it('只发 name 不动已存在的 mode；只发 mode 不动已存在的 name', async () => {
    entry.sessionGroup = { tag: { mode: 'chat-tag', name: '旧名字' } };
    botConfig.sessionGroup = { tag: { mode: 'chat-tag', name: '旧名字' } };

    const renamed = await put({ name: '新名字' });
    expect(renamed.json).toMatchObject({ tagMode: 'chat-tag', tagName: '新名字' });
    expect(entry.sessionGroup.tag).toMatchObject({ mode: 'chat-tag', name: '新名字' });

    const remoded = await put({ mode: 'off' });
    expect(remoded.json).toMatchObject({ tagMode: 'off', tagName: '新名字' });
    expect(entry.sessionGroup.tag).toMatchObject({ mode: 'off', name: '新名字' });
  });

  it('非法输入各自报错，且一个字段都不写盘', async () => {
    expect((await put({ name: 42 })).json).toMatchObject({ ok: false, error: 'invalid_name' });
    expect((await put({ mode: 'nope' })).json).toMatchObject({ ok: false, error: 'invalid_mode' });
    // 一个字段都没带：沿用老的 invalid_mode（只发 mode 的旧 dashboard 语义不变）。
    expect((await put({})).json).toMatchObject({ ok: false, error: 'invalid_mode' });
    expect(entry.sessionGroup).toBeUndefined();
    expect(vi.mocked(configStore.rmwBotEntry)).not.toHaveBeenCalled();
  });
});
