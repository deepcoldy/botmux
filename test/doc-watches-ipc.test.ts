// test/doc-watches-ipc.test.ts
//
// `/api/doc-watches*` 路由级行为。手法沿用 test/dashboard-ipc.test.ts：起真实
// IPC server（port 0）+ fetch，`BOTS_CONFIG` 指到临时 bots.json、`config.session
// .dataDir` 指到临时目录，于是订阅表读写走真实 store（不 mock）。
//
// 为什么不 mock store：这一整条特性的价值就在「dashboard 改的和 daemon 读的是
// 同一份盘上数据」。mock 掉 store 只能证明「路由调了函数」，证不到真正要证的
// 那件事 —— 而那正是本 PR 的核心不变量（订阅表单写者模型）。
//
// `resolveDocFile` / `fetchDocTitle` 会打真飞书，测试里按需 spy 掉。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startIpcServer, setLarkAppId, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { loadBotConfigs, registerBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import {
  getDocSubscription,
  putDocSubscription,
  type DocSubscription,
} from '../src/services/doc-subs-store.js';
import * as docComment from '../src/im/lark/doc-comment.js';

const APP = 'cli_docwatchapp';
const TOKEN = 'LMP0dc0izogsLexr5Cic5bXkn6b';   // 27 chars, 合法形状
const OTHER_TOKEN = 'AAP0dc0izogsLexr5Cic5bXkn7c';

let handle: IpcServerHandle | null = null;
let dir = '';
let prevBotsConfig: string | undefined;
let prevDataDir = '';

function sub(over: Partial<DocSubscription> = {}): DocSubscription {
  return {
    fileToken: TOKEN,
    fileType: 'docx',
    sessionAnchor: `doc:${TOKEN}`,
    scope: 'chat',
    chatId: `doc:${TOKEN}`,
    commentTriggerMode: 'mention-only',
    managedBy: 'watch-comment',
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

async function server(): Promise<string> {
  dir = mkdtempSync(join(tmpdir(), 'doc-watches-ipc-'));
  prevBotsConfig = process.env.BOTS_CONFIG;
  prevDataDir = config.session.dataDir;
  const configPath = join(dir, 'bots.json');
  process.env.BOTS_CONFIG = configPath;
  config.session.dataDir = dir;
  writeFileSync(configPath, JSON.stringify([
    { larkAppId: APP, larkAppSecret: 'secret', allowedUsers: ['ou_owner_real'] },
  ]));
  loadBotConfigs().forEach((c: any) => registerBot(c));
  setLarkAppId(APP);
  handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${handle.port}`;
}

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setLarkAppId('');
  __testOnly_resetBotRegistry();
  vi.restoreAllMocks();
  if (prevDataDir) config.session.dataDir = prevDataDir;
  if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
  else process.env.BOTS_CONFIG = prevBotsConfig;
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = ''; }
});

describe('GET /api/doc-watches', () => {
  it('空表返回空数组（不是 404 / 不是 500）', async () => {
    const base = await server();
    const r = await fetch(`${base}/api/doc-watches`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ watches: [] });
  });

  it('投影出运行态字段；旧记录缺字段时不炸且 dispatchCount 归零', async () => {
    const base = await server();
    // 刻意用一条**没有任何**运行态字段的记录（线上既有订阅就是这个形状）。
    putDocSubscription(dir, APP, sub());
    const body = await (await fetch(`${base}/api/doc-watches`)).json();
    expect(body.watches).toHaveLength(1);
    const row = body.watches[0];
    expect(row).toMatchObject({
      fileToken: TOKEN,
      fileType: 'docx',
      commentTriggerMode: 'mention-only',
      managedBy: 'watch-comment',
      dispatchCount: 0,      // 缺字段 → 0，不是 undefined/NaN
      autoCreated: false,    // 缺字段 → false，不是 undefined
      larkAppId: APP,
    });
    expect(row.lastOutcome).toBeUndefined();
    expect(row.lastActivityAt).toBeUndefined();
  });

  it('带上运行态与 auto-sub 溯源字段', async () => {
    const base = await server();
    putDocSubscription(dir, APP, sub({
      docTitle: '产品需求文档',
      lastActivityAt: 1_800_000_000_000,
      lastOutcome: 'poll-failed',
      lastError: 'permission denied',
      lastDispatchAt: 1_700_000_500_000,
      dispatchCount: 7,
      autoCreated: true,
      autoCreatedBy: 'ou_stranger',
      autoCreatedAt: 1_700_000_100_000,
    }));
    const row = (await (await fetch(`${base}/api/doc-watches`)).json()).watches[0];
    expect(row).toMatchObject({
      docTitle: '产品需求文档',
      lastOutcome: 'poll-failed',
      lastError: 'permission denied',
      dispatchCount: 7,
      autoCreated: true,
      autoCreatedBy: 'ou_stranger',
    });
  });

  it('按 createdAt 倒序（新的在前）', async () => {
    const base = await server();
    putDocSubscription(dir, APP, sub({ fileToken: TOKEN, createdAt: 1_000 }));
    putDocSubscription(dir, APP, sub({ fileToken: OTHER_TOKEN, createdAt: 9_000 }));
    const rows = (await (await fetch(`${base}/api/doc-watches`)).json()).watches;
    expect(rows.map((r: any) => r.fileToken)).toEqual([OTHER_TOKEN, TOKEN]);
  });
});

describe('PUT /api/doc-watches/:fileToken', () => {
  it('切换触发范围并落盘', async () => {
    const base = await server();
    putDocSubscription(dir, APP, sub({ commentTriggerMode: 'mention-only' }));
    const r = await fetch(`${base}/api/doc-watches/${TOKEN}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commentTriggerMode: 'all' }),
    });
    expect(r.status).toBe(200);
    expect(getDocSubscription(dir, APP, TOKEN)?.commentTriggerMode).toBe('all');
  });

  it('⭐切到 all 必须重置轮询基线，否则 poller 会重放该文档全部历史评论', async () => {
    const base = await server();
    // mention-only 记录带着一个**陈旧**游标（可能来自很久以前的一次 all）。
    putDocSubscription(dir, APP, sub({
      commentTriggerMode: 'mention-only',
      pollCursorAt: 1,
      pollCursorReplyId: 'ancient',
      pollBaselineReady: true,
    }));
    await fetch(`${base}/api/doc-watches/${TOKEN}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commentTriggerMode: 'all' }),
    });
    const after = getDocSubscription(dir, APP, TOKEN);
    // 关键：baselineReady 必须为 false，让 poller 下一轮**只建基线、不重放历史**。
    expect(after?.pollBaselineReady).toBe(false);
    expect(after?.pollCursorAt).toBeUndefined();
    expect(after?.pollCursorReplyId).toBeUndefined();
  });

  it('已经是 all 时不动游标（避免每次保存都白重建基线）', async () => {
    const base = await server();
    putDocSubscription(dir, APP, sub({
      commentTriggerMode: 'all',
      pollCursorAt: 4242,
      pollCursorReplyId: 'r42',
      pollBaselineReady: true,
    }));
    await fetch(`${base}/api/doc-watches/${TOKEN}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commentTriggerMode: 'all' }),
    });
    const after = getDocSubscription(dir, APP, TOKEN);
    expect(after?.pollCursorAt).toBe(4242);
    expect(after?.pollBaselineReady).toBe(true);
  });

  it('未知 token → 404；非法 mode → 400；坏 token 形状 → 400', async () => {
    const base = await server();
    putDocSubscription(dir, APP, sub());
    const notFound = await fetch(`${base}/api/doc-watches/${OTHER_TOKEN}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commentTriggerMode: 'all' }),
    });
    expect(notFound.status).toBe(404);

    const badMode = await fetch(`${base}/api/doc-watches/${TOKEN}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commentTriggerMode: 'everything' }),
    });
    expect(badMode.status).toBe(400);
    expect((await badMode.json()).error).toBe('invalid_mode');
    // 拒绝后原值不变
    expect(getDocSubscription(dir, APP, TOKEN)?.commentTriggerMode).toBe('mention-only');

    const badToken = await fetch(`${base}/api/doc-watches/short`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commentTriggerMode: 'all' }),
    });
    expect(badToken.status).toBe(400);
    expect((await badToken.json()).error).toBe('invalid_file_token');
  });
});

describe('DELETE /api/doc-watches/:fileToken', () => {
  it('删除 watch-comment 族：不打飞书退订（它没有逐文件订阅）', async () => {
    const base = await server();
    const unsub = vi.spyOn(docComment, 'unsubscribeDocFile').mockResolvedValue(undefined);
    putDocSubscription(dir, APP, sub({ managedBy: 'watch-comment' }));
    const r = await fetch(`${base}/api/doc-watches/${TOKEN}`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(getDocSubscription(dir, APP, TOKEN)).toBeNull();
    expect(unsub).not.toHaveBeenCalled();
  });

  it('删除旧式订阅：要打飞书退订', async () => {
    const base = await server();
    const unsub = vi.spyOn(docComment, 'unsubscribeDocFile').mockResolvedValue(undefined);
    putDocSubscription(dir, APP, sub({ managedBy: 'subscribe-lark-doc' }));
    await fetch(`${base}/api/doc-watches/${TOKEN}`, { method: 'DELETE' });
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(getDocSubscription(dir, APP, TOKEN)).toBeNull();
  });

  it('⭐远端退订失败仍要删掉本地记录（否则留下永远删不掉的幽灵监听）', async () => {
    const base = await server();
    vi.spyOn(docComment, 'unsubscribeDocFile').mockRejectedValue(new Error('403 forbidden'));
    putDocSubscription(dir, APP, sub({ managedBy: 'subscribe-lark-doc' }));
    const r = await fetch(`${base}/api/doc-watches/${TOKEN}`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(getDocSubscription(dir, APP, TOKEN)).toBeNull();
  });

  it('未知 token → 404', async () => {
    const base = await server();
    const r = await fetch(`${base}/api/doc-watches/${OTHER_TOKEN}`, { method: 'DELETE' });
    expect(r.status).toBe(404);
  });
});

describe('POST /api/doc-watches', () => {
  it('登记一篇文档：解析 + 抓标题 + 落盘，anchor 用 doc: 虚拟地址', async () => {
    const base = await server();
    vi.spyOn(docComment, 'resolveDocFile').mockResolvedValue({ fileToken: TOKEN, fileType: 'docx' });
    vi.spyOn(docComment, 'fetchDocTitle').mockResolvedValue('季度规划');
    const r = await fetch(`${base}/api/doc-watches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docRef: `https://x.feishu.cn/docx/${TOKEN}`, commentTriggerMode: 'mention-only' }),
    });
    expect(r.status).toBe(200);
    const stored = getDocSubscription(dir, APP, TOKEN);
    expect(stored).toMatchObject({
      fileToken: TOKEN,
      docTitle: '季度规划',
      commentTriggerMode: 'mention-only',
      managedBy: 'watch-comment',
      sessionAnchor: `doc:${TOKEN}`,
      chatId: `doc:${TOKEN}`,
      scope: 'chat',
    });
  });

  it('⭐ownerOpenId 记的是本 app 的真人 owner（open_id 是 app-scoped，不能来自别处）', async () => {
    const base = await server();
    vi.spyOn(docComment, 'resolveDocFile').mockResolvedValue({ fileToken: TOKEN, fileType: 'docx' });
    vi.spyOn(docComment, 'fetchDocTitle').mockResolvedValue(undefined);
    await fetch(`${base}/api/doc-watches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docRef: TOKEN }),
    });
    // bots.json 里 allowedUsers 的那个 ou_ —— 与飞书侧 getOwnerOpenId 同一判据。
    expect(getDocSubscription(dir, APP, TOKEN)?.ownerOpenId).toBe('ou_owner_real');
  });

  it('mode 省略时用 bot 的 docSubscribeDefaultMode', async () => {
    dir = mkdtempSync(join(tmpdir(), 'doc-watches-ipc-'));
    prevBotsConfig = process.env.BOTS_CONFIG;
    prevDataDir = config.session.dataDir;
    const configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
    config.session.dataDir = dir;
    writeFileSync(configPath, JSON.stringify([
      { larkAppId: APP, larkAppSecret: 's', docSubscribeDefaultMode: 'all' },
    ]));
    loadBotConfigs().forEach((c: any) => registerBot(c));
    setLarkAppId(APP);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${handle.port}`;
    vi.spyOn(docComment, 'resolveDocFile').mockResolvedValue({ fileToken: TOKEN, fileType: 'docx' });
    vi.spyOn(docComment, 'fetchDocTitle').mockResolvedValue(undefined);
    await fetch(`${base}/api/doc-watches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docRef: TOKEN }),
    });
    const stored = getDocSubscription(dir, APP, TOKEN);
    expect(stored?.commentTriggerMode).toBe('all');
    // all 且没有可继承基线 → 必须交给 poller 建，不能装作已就绪。
    expect(stored?.pollBaselineReady).toBe(false);
  });

  it('⭐抓标题失败不该阻断登记（标题只是显示字段）', async () => {
    const base = await server();
    vi.spyOn(docComment, 'resolveDocFile').mockResolvedValue({ fileToken: TOKEN, fileType: 'docx' });
    vi.spyOn(docComment, 'fetchDocTitle').mockResolvedValue(undefined);
    const r = await fetch(`${base}/api/doc-watches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docRef: TOKEN }),
    });
    expect(r.status).toBe(200);
    expect(getDocSubscription(dir, APP, TOKEN)).not.toBeNull();
    expect(getDocSubscription(dir, APP, TOKEN)?.docTitle).toBeUndefined();
  });

  it('缺 docRef → 400；解析失败 → 400 且不落盘', async () => {
    const base = await server();
    const missing = await fetch(`${base}/api/doc-watches`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBe('doc_ref_required');

    vi.spyOn(docComment, 'resolveDocFile').mockRejectedValue(new Error('无法识别'));
    const bad = await fetch(`${base}/api/doc-watches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docRef: 'not-a-doc' }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('unresolvable_doc');
    expect(getDocSubscription(dir, APP, TOKEN)).toBeNull();
  });

  it('⭐不存在的 workingDir → 400 且不落盘（不静默 mkdir，免得掩盖打错的路径）', async () => {
    const base = await server();
    vi.spyOn(docComment, 'resolveDocFile').mockResolvedValue({ fileToken: TOKEN, fileType: 'docx' });
    const r = await fetch(`${base}/api/doc-watches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docRef: TOKEN, workingDir: join(dir, 'definitely-absent') }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_working_dir');
    expect(getDocSubscription(dir, APP, TOKEN)).toBeNull();
  });

  it('重复登记同一文档：覆盖而非新增（1 文档 : 1 会话），保留原 createdAt', async () => {
    const base = await server();
    vi.spyOn(docComment, 'resolveDocFile').mockResolvedValue({ fileToken: TOKEN, fileType: 'docx' });
    vi.spyOn(docComment, 'fetchDocTitle').mockResolvedValue(undefined);
    putDocSubscription(dir, APP, sub({ createdAt: 111 }));
    await fetch(`${base}/api/doc-watches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docRef: TOKEN, commentTriggerMode: 'all' }),
    });
    const rows = (await (await fetch(`${base}/api/doc-watches`)).json()).watches;
    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt).toBe(111);
    expect(rows[0].commentTriggerMode).toBe('all');
  });
});

describe('larkAppId 未绑定', () => {
  it('全部端点 503（不是 200 空表 —— 那会让界面误报「没有监听」）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'doc-watches-ipc-'));
    prevDataDir = config.session.dataDir;
    config.session.dataDir = dir;
    setLarkAppId('');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${handle.port}`;
    expect((await fetch(`${base}/api/doc-watches`)).status).toBe(503);
    expect((await fetch(`${base}/api/doc-watches/${TOKEN}`, { method: 'DELETE' })).status).toBe(503);
  });
});
