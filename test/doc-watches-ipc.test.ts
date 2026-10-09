// test/doc-watches-ipc.test.ts
//
// `/api/doc-watches*` 路由级行为。起真实 IPC server（port 0）+ fetch，bots.json 与
// config.session.dataDir 指到临时目录，订阅表读写走真实 store（不 mock）——这条特性
// 的价值就在「dashboard 改的和 daemon 读的是同一份盘上数据」。
// resolveDocFile / fetchDocTitle / unsubscribeDocFile 会打真飞书，按需 spy 掉。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startIpcServer, setLarkAppId, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { loadBotConfigs, registerBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import {
  getDocSubscription,
  putDocSubscription,
  docWatchAnchor,
  type DocSubscription,
} from '../src/services/doc-subs-store.js';
import * as docComment from '../src/im/lark/doc-comment.js';

const APP = 'cli_docwatchapp';
const TOKEN = 'LMP0dc0izogsLexr5Cic5bXkn6b';   // 27 chars，合法形状
const OTHER = 'AAP0dc0izogsLexr5Cic5bXkn7c';

let handle: IpcServerHandle | null = null;
let dir = '';
let prevBotsConfig: string | undefined;
let prevDataDir = '';

function sub(over: Partial<DocSubscription> = {}): DocSubscription {
  return {
    fileToken: TOKEN,
    fileType: 'docx',
    sessionAnchor: docWatchAnchor(TOKEN),
    scope: 'chat',
    chatId: docWatchAnchor(TOKEN),
    commentTriggerMode: 'mention-only',
    managedBy: 'watch-comment',
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

async function server(botConfig: Record<string, unknown> = { allowedUsers: ['ou_owner_real'] }): Promise<string> {
  dir = mkdtempSync(join(tmpdir(), 'doc-watches-ipc-'));
  prevBotsConfig = process.env.BOTS_CONFIG;
  prevDataDir = config.session.dataDir;
  const configPath = join(dir, 'bots.json');
  process.env.BOTS_CONFIG = configPath;
  config.session.dataDir = dir;
  writeFileSync(configPath, JSON.stringify([{ larkAppId: APP, larkAppSecret: 'secret', ...botConfig }]));
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
  it('空表返回空数组（不是 404/500）', async () => {
    const base = await server();
    const r = await fetch(`${base}/api/doc-watches`);
    expect(r.status).toBe(200);
    expect((await r.json()).watches).toEqual([]);
  });

  it('投影运行态字段；旧记录缺字段时不炸、dispatchCount 归零', async () => {
    const base = await server();
    putDocSubscription(dir, APP, sub());
    const rows = (await (await fetch(`${base}/api/doc-watches`)).json()).watches;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fileToken: TOKEN, commentTriggerMode: 'mention-only' });
    expect(rows[0].dispatchCount).toBe(0);
    expect(rows[0].lastActivityAt).toBeUndefined();
    expect(rows[0].autoCreated).toBe(false);
  });

  it('带上运行态与 auto-sub 溯源，并按 createdAt 倒序', async () => {
    const base = await server();
    putDocSubscription(dir, APP, sub({
      lastOutcome: 'dispatched', dispatchCount: 5, lastActivityAt: 900,
      autoCreated: true, autoCreatedBy: 'ou_stranger',
    }));
    putDocSubscription(dir, APP, sub({ fileToken: OTHER, createdAt: 1_700_000_000_001 }));
    const rows = (await (await fetch(`${base}/api/doc-watches`)).json()).watches;
    expect(rows[0].fileToken).toBe(OTHER); // 更新的在前
    const mine = rows.find((r: any) => r.fileToken === TOKEN);
    expect(mine.dispatchCount).toBe(5);
    expect(mine.autoCreated).toBe(true);
    expect(mine.autoCreatedBy).toBe('ou_stranger');
  });
});

describe('PUT /api/doc-watches/:fileToken（切触发范围）', () => {
  it('⭐mention-only→all 必须重置轮询基线，否则 poller 重放全部历史', async () => {
    const base = await server();
    putDocSubscription(dir, APP, sub({
      commentTriggerMode: 'mention-only',
      pollCursorAt: 1, pollCursorReplyId: 'ancient', pollBaselineReady: true,
    }));
    const r = await fetch(`${base}/api/doc-watches/${TOKEN}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commentTriggerMode: 'all' }),
    });
    expect(r.status).toBe(200);
    const after = getDocSubscription(dir, APP, TOKEN)!;
    expect(after.pollBaselineReady).toBe(false);
    expect(after.pollCursorAt).toBeUndefined();
    expect(after.pollCursorReplyId).toBeUndefined();
  });

  it('已经是 all 时不动游标（避免每次保存白重建基线）', async () => {
    const base = await server();
    putDocSubscription(dir, APP, sub({
      commentTriggerMode: 'all', pollCursorAt: 4242, pollCursorReplyId: 'r42', pollBaselineReady: true,
    }));
    await fetch(`${base}/api/doc-watches/${TOKEN}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commentTriggerMode: 'all' }),
    });
    const after = getDocSubscription(dir, APP, TOKEN)!;
    expect(after.pollCursorAt).toBe(4242);
    expect(after.pollBaselineReady).toBe(true);
  });

  it('未知 token → 404；非法 mode → 400；坏 token 形状 → 400', async () => {
    const base = await server();
    const a = await fetch(`${base}/api/doc-watches/${TOKEN}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commentTriggerMode: 'all' }),
    });
    expect(a.status).toBe(404);
    putDocSubscription(dir, APP, sub());
    const b = await fetch(`${base}/api/doc-watches/${TOKEN}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commentTriggerMode: 'nope' }),
    });
    expect(b.status).toBe(400);
    const c = await fetch(`${base}/api/doc-watches/bad-token`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commentTriggerMode: 'all' }),
    });
    expect(c.status).toBe(400);
  });
});

describe('DELETE /api/doc-watches/:fileToken', () => {
  it('watch-comment 族不打飞书退订（它只依赖应用级评论事件）', async () => {
    const base = await server();
    const spy = vi.spyOn(docComment, 'unsubscribeDocFile').mockResolvedValue(undefined);
    putDocSubscription(dir, APP, sub());
    const r = await fetch(`${base}/api/doc-watches/${TOKEN}`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(getDocSubscription(dir, APP, TOKEN)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('旧式订阅要打飞书退订', async () => {
    const base = await server();
    const spy = vi.spyOn(docComment, 'unsubscribeDocFile').mockResolvedValue(undefined);
    putDocSubscription(dir, APP, sub({ managedBy: 'subscribe-lark-doc' }));
    const r = await fetch(`${base}/api/doc-watches/${TOKEN}`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('⭐远端退订失败仍删掉本地记录（否则留下永远删不掉的幽灵监听）', async () => {
    const base = await server();
    vi.spyOn(docComment, 'unsubscribeDocFile').mockRejectedValue(new Error('403'));
    putDocSubscription(dir, APP, sub({ managedBy: 'subscribe-lark-doc' }));
    const r = await fetch(`${base}/api/doc-watches/${TOKEN}`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(getDocSubscription(dir, APP, TOKEN)).toBeNull();
  });

  it('未知 token → 404', async () => {
    const base = await server();
    expect((await fetch(`${base}/api/doc-watches/${TOKEN}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('POST /api/doc-watches（登记）', () => {
  it('解析 + 抓标题 + 落盘，无会话用 doc:<token>:watch 虚拟 anchor', async () => {
    const base = await server();
    vi.spyOn(docComment, 'resolveDocFile').mockResolvedValue({ fileToken: TOKEN, fileType: 'docx' });
    vi.spyOn(docComment, 'fetchDocTitle').mockResolvedValue('需求文档');
    const r = await fetch(`${base}/api/doc-watches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docRef: TOKEN }),
    });
    expect(r.status).toBe(200);
    const after = getDocSubscription(dir, APP, TOKEN)!;
    expect(after.sessionAnchor).toBe(docWatchAnchor(TOKEN));
    expect(after.chatId).toBe(docWatchAnchor(TOKEN));
    expect(after.scope).toBe('chat');
    expect(after.managedBy).toBe('watch-comment');
    expect(after.docTitle).toBe('需求文档');
    expect((await r.json()).keptBinding).toBe(false);
  });

  it('⭐ownerOpenId 记本 app 真人 owner（open_id 是 app-scoped，不能来自别处）', async () => {
    const base = await server();
    vi.spyOn(docComment, 'resolveDocFile').mockResolvedValue({ fileToken: TOKEN, fileType: 'docx' });
    vi.spyOn(docComment, 'fetchDocTitle').mockResolvedValue(undefined);
    await fetch(`${base}/api/doc-watches`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ docRef: TOKEN }),
    });
    expect(getDocSubscription(dir, APP, TOKEN)?.ownerOpenId).toBe('ou_owner_real');
  });

  it('mode 省略时用 bot 的 docSubscribeDefaultMode', async () => {
    const base = await server({ allowedUsers: ['ou_owner_real'], docSubscribeDefaultMode: 'all' });
    vi.spyOn(docComment, 'resolveDocFile').mockResolvedValue({ fileToken: TOKEN, fileType: 'docx' });
    vi.spyOn(docComment, 'fetchDocTitle').mockResolvedValue(undefined);
    await fetch(`${base}/api/doc-watches`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ docRef: TOKEN }),
    });
    expect(getDocSubscription(dir, APP, TOKEN)?.commentTriggerMode).toBe('all');
  });

  it('抓不到标题（fetchDocTitle 按契约 resolve undefined、绝不抛）不阻断登记', async () => {
    const base = await server();
    vi.spyOn(docComment, 'resolveDocFile').mockResolvedValue({ fileToken: TOKEN, fileType: 'docx' });
    vi.spyOn(docComment, 'fetchDocTitle').mockResolvedValue(undefined);
    const r = await fetch(`${base}/api/doc-watches`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ docRef: TOKEN }),
    });
    expect(r.status).toBe(200);
    expect(getDocSubscription(dir, APP, TOKEN)?.docTitle).toBeUndefined();
  });

  it('缺 docRef → 400；解析失败 → 400 且不落盘', async () => {
    const base = await server();
    const a = await fetch(`${base}/api/doc-watches`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ docRef: '   ' }),
    });
    expect(a.status).toBe(400);
    vi.spyOn(docComment, 'resolveDocFile').mockRejectedValue(new Error('无法识别'));
    const b = await fetch(`${base}/api/doc-watches`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ docRef: 'not a doc' }),
    });
    expect(b.status).toBe(400);
    expect(getDocSubscription(dir, APP, TOKEN)).toBeNull();
  });

  it('⭐不存在的 workingDir → 400 且不落盘（不静默 mkdir）', async () => {
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

  it('⭐重复登记不清零运行态，且保留 auto-sub 溯源（dashboard 不改变行来源）', async () => {
    const base = await server();
    vi.spyOn(docComment, 'resolveDocFile').mockResolvedValue({ fileToken: TOKEN, fileType: 'docx' });
    vi.spyOn(docComment, 'fetchDocTitle').mockResolvedValue(undefined);
    putDocSubscription(dir, APP, sub({
      lastActivityAt: 999, lastOutcome: 'dispatched', lastDispatchAt: 999, dispatchCount: 42,
      autoCreated: true, autoCreatedBy: 'ou_stranger', autoCreatedAt: 500,
    }));
    await fetch(`${base}/api/doc-watches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docRef: TOKEN, commentTriggerMode: 'all' }),
    });
    const after = getDocSubscription(dir, APP, TOKEN)!;
    expect(after.dispatchCount).toBe(42);
    expect(after.lastOutcome).toBe('dispatched');
    expect(after.autoCreated).toBe(true);
    expect(after.autoCreatedBy).toBe('ou_stranger');
  });

  it('⭐已绑真实飞书话题：dashboard 只改配置，不把落点搬到虚拟 watch 会话', async () => {
    const base = await server();
    vi.spyOn(docComment, 'resolveDocFile').mockResolvedValue({ fileToken: TOKEN, fileType: 'docx' });
    vi.spyOn(docComment, 'fetchDocTitle').mockResolvedValue(undefined);
    putDocSubscription(dir, APP, sub({
      sessionAnchor: 'om_realRootMessageId01', sessionId: 'sess-abc-123',
      scope: 'thread', chatId: 'oc_realGroupChatId01', ownerOpenId: 'ou_the_real_person',
    }));
    const r = await fetch(`${base}/api/doc-watches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docRef: TOKEN, commentTriggerMode: 'all' }),
    });
    const body = await r.json();
    const after = getDocSubscription(dir, APP, TOKEN)!;
    expect(after.sessionAnchor).toBe('om_realRootMessageId01');
    expect(after.sessionId).toBe('sess-abc-123');
    expect(after.scope).toBe('thread');
    expect(after.chatId).toBe('oc_realGroupChatId01');
    expect(after.ownerOpenId).toBe('ou_the_real_person');
    expect(after.commentTriggerMode).toBe('all');
    expect(body.rebound).toBe(false);
    expect(body.keptBinding).toBe(true);
  });

  it('旧 legacy 虚拟 anchor（doc:<token>，无 :watch）也被识别为文档原生、可重登为 :watch', async () => {
    const base = await server();
    vi.spyOn(docComment, 'resolveDocFile').mockResolvedValue({ fileToken: TOKEN, fileType: 'docx' });
    vi.spyOn(docComment, 'fetchDocTitle').mockResolvedValue(undefined);
    // 旧版本写下的裸 doc:<token>
    putDocSubscription(dir, APP, sub({ sessionAnchor: `doc:${TOKEN}`, chatId: `doc:${TOKEN}` }));
    const r = await fetch(`${base}/api/doc-watches`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ docRef: TOKEN }),
    });
    const body = await r.json();
    // 旧原生 anchor 不算「真实飞书会话绑定」，重登归一到 :watch；这属于 anchor 迁移。
    expect(getDocSubscription(dir, APP, TOKEN)?.sessionAnchor).toBe(docWatchAnchor(TOKEN));
    expect(body.keptBinding).toBe(false);
  });
});

describe('PUT 基线重置的写入顺序（源码形状）', () => {
  // 行为测试只能看到两次同步写之后的最终状态，观测不到先后；但顺序是承重的安全
  // 性质：必须**先清游标、后改 mode**。反过来（f9161c850 修掉的回归）一旦清游标
  // 失败，会留下「mode=all + 陈旧游标 + baselineReady=true」让 poller 重放全部历史。
  const ipcSrc = readFileSync(new URL('../src/core/dashboard-ipc-server.ts', import.meta.url), 'utf-8');
  const putRoute = ipcSrc.slice(
    ipcSrc.indexOf("ipcRoute('PUT', '/api/doc-watches/:fileToken'"),
    ipcSrc.indexOf("ipcRoute('DELETE', '/api/doc-watches/:fileToken'"),
  );

  it('清游标 setDocCommentPollCursor 必须在 setCommentTriggerMode 之前', () => {
    const clearIdx = putRoute.indexOf('setDocCommentPollCursor(config.session.dataDir, cachedLarkAppId, p.fileToken, undefined, false)');
    const modeIdx = putRoute.indexOf('setCommentTriggerMode(config.session.dataDir, cachedLarkAppId, p.fileToken, mode)');
    expect(clearIdx).toBeGreaterThan(-1);
    expect(modeIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeLessThan(modeIdx);
  });
});

describe('larkAppId 未绑定', () => {
  it('全部端点 503（不是 200 空表——那会让界面误报「没有监听」）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'doc-watches-503-'));
    prevDataDir = config.session.dataDir;
    config.session.dataDir = dir;
    setLarkAppId('');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${handle.port}`;
    expect((await fetch(`${base}/api/doc-watches`)).status).toBe(503);
    expect((await fetch(`${base}/api/doc-watches/${TOKEN}`, { method: 'DELETE' })).status).toBe(503);
  });
});
