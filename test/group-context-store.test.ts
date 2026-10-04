/**
 * group-context-store: 群聊旁听消息的共享记录层（SQLite，按 app + chat 隔离）。
 *
 * 契约要点（供 turn 前补齐层消费）：
 *  - 每条记录分配本地递增 seq；同 messageId 同正文重复写入不分配新 seq；
 *    正文/删除状态变化则以新 revision + 新 seq 追加（读方按 seq 游标即可看到更正）。
 *  - list 按 seq 游标翻页，返回 hasMore / throughSeq；被淘汰的区间以 retentionGap 显式标出，
 *    绝不默默当作完整记录。
 *  - 淘汰：默认保留 30 天、每群最多 10000 条。
 *
 * Run: bun run vitest run test/group-context-store.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import {
  upsertGroupContextMessage,
  listGroupContextMessages,
  getGroupContextHead,
  getGroupContextMessage,
  markGroupContextMessageDeleted,
  pruneGroupContext,
  groupContextDbPath,
  _resetGroupContextStoreForTest,
  type GroupContextMessageInput,
} from '../src/services/group-context-store.js';

const APP = 'cli_app_a';
const CHAT = 'oc_chat_1';
const DAY = 24 * 60 * 60_000;
let dataDir: string;

function msg(over: Partial<GroupContextMessageInput> & { messageId: string }): GroupContextMessageInput {
  return {
    chatId: CHAT,
    senderId: 'ou_user_1',
    senderType: 'user',
    msgType: 'text',
    text: `hello ${over.messageId}`,
    createTime: 1_700_000_000_000,
    resourceRefs: [],
    sourceAppId: APP,
    ...over,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-group-ctx-'));
  vi.stubEnv('SESSION_DATA_DIR', dataDir);
  _resetGroupContextStoreForTest();
});

afterEach(() => {
  _resetGroupContextStoreForTest();
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('upsert / seq 分配', () => {
  it('首次写入分配递增 seq，文件按 app 落在 dataDir 下', () => {
    const a = upsertGroupContextMessage(APP, msg({ messageId: 'om_1' }));
    const b = upsertGroupContextMessage(APP, msg({ messageId: 'om_2' }));
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(true);
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(a.revision).toBe(0);
    expect(existsSync(groupContextDbPath(APP))).toBe(true);
    expect(groupContextDbPath(APP).startsWith(dataDir)).toBe(true);
  });

  it('同 messageId 同正文重复写入：不分配新 seq、不新增 revision', () => {
    const first = upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'same' }));
    const dup = upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'same' }));
    expect(dup.inserted).toBe(false);
    expect(dup.seq).toBe(first.seq);
    expect(dup.revision).toBe(0);
    expect(getGroupContextHead(APP, CHAT).headSeq).toBe(first.seq);
    expect(listGroupContextMessages(APP, CHAT).messages).toHaveLength(1);
  });

  it('同 messageId 正文变化（编辑）：追加新 revision 与新 seq，get 返回最新版', () => {
    const v0 = upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'v0' }));
    const v1 = upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'v1' }));
    expect(v1.inserted).toBe(true);
    expect(v1.revision).toBe(1);
    expect(v1.seq).toBeGreaterThan(v0.seq);
    const latest = getGroupContextMessage(APP, CHAT, 'om_1');
    expect(latest?.text).toBe('v1');
    expect(latest?.revision).toBe(1);
    // 按 seq 游标翻页能看到两条（旧版 isLatest=false）
    const rows = listGroupContextMessages(APP, CHAT).messages;
    expect(rows.map(r => [r.text, r.isLatest])).toEqual([['v0', false], ['v1', true]]);
  });

  it('不同 app / 不同 chat 彼此隔离', () => {
    upsertGroupContextMessage(APP, msg({ messageId: 'om_1' }));
    upsertGroupContextMessage(APP, msg({ messageId: 'om_2', chatId: 'oc_chat_2' }));
    upsertGroupContextMessage('cli_app_b', msg({ messageId: 'om_3', sourceAppId: 'cli_app_b' }));
    expect(listGroupContextMessages(APP, CHAT).messages.map(m => m.messageId)).toEqual(['om_1']);
    expect(listGroupContextMessages(APP, 'oc_chat_2').messages.map(m => m.messageId)).toEqual(['om_2']);
    expect(listGroupContextMessages('cli_app_b', CHAT).messages.map(m => m.messageId)).toEqual(['om_3']);
    expect(getGroupContextMessage(APP, CHAT, 'om_3')).toBeUndefined();
  });

  it('保留完整字段：root/thread/parent、sender、resourceRefs、sourceAppId、createTime', () => {
    upsertGroupContextMessage(APP, msg({
      messageId: 'om_1', rootId: 'om_root', threadId: 'omt_1', parentId: 'om_p',
      senderId: 'ou_bot_x', senderType: 'bot', senderName: 'Alex', msgType: 'image', text: '[图片 1]',
      resourceRefs: [{ type: 'image', key: 'img_k1', name: 'a.jpg' }],
      sourceAppId: 'cli_app_a', createTime: 1_700_000_123_456,
    }));
    const row = getGroupContextMessage(APP, CHAT, 'om_1');
    expect(row).toMatchObject({
      messageId: 'om_1', chatId: CHAT, rootId: 'om_root', threadId: 'omt_1', parentId: 'om_p',
      senderId: 'ou_bot_x', senderType: 'bot', senderName: 'Alex', msgType: 'image', text: '[图片 1]',
      sourceAppId: 'cli_app_a', createTime: 1_700_000_123_456, deleted: false,
    });
    expect(row?.resourceRefs).toEqual([{ type: 'image', key: 'img_k1', name: 'a.jpg' }]);
  });

  it('app 文件名：合法 app id 原样；非法形态用 sha256，不做有损替换（turn/a 与 turn?a 不撞）', () => {
    expect(basename(groupContextDbPath('cli_a1b2c3'))).toBe('cli_a1b2c3.sqlite');
    const a = groupContextDbPath('turn/a');
    const b = groupContextDbPath('turn?a');
    expect(a).not.toBe(b);
    expect(basename(a)).toMatch(/^[0-9a-f]{32}\.sqlite$/);
    expect(a.startsWith(join(dataDir, 'group-context'))).toBe(true);
    expect(groupContextDbPath('..')).toMatch(/[0-9a-f]{32}\.sqlite$/);
    upsertGroupContextMessage('turn/a', msg({ messageId: 'om_1', sourceAppId: 'turn/a' }));
    expect(listGroupContextMessages('turn?a', CHAT).messages).toHaveLength(0);
    expect(listGroupContextMessages('turn/a', CHAT).messages).toHaveLength(1);
  });

  it('输入校验：缺 messageId / chatId 直接抛错，不写入', () => {
    expect(() => upsertGroupContextMessage(APP, msg({ messageId: '' }))).toThrow(/messageId/);
    expect(() => upsertGroupContextMessage(APP, msg({ messageId: 'om_1', chatId: '' }))).toThrow(/chatId/);
    expect(getGroupContextHead(APP, CHAT).count).toBe(0);
  });
});

describe('history 回填与实时事件的交错', () => {
  it('实时事件缺 senderName，history 同正文带 senderName：原地补全，不分配新 seq / revision', () => {
    const live = upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'same' }));
    const fill = upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'same', senderName: 'Alex', rootId: 'om_root' }));
    expect(fill.inserted).toBe(false);
    expect(fill.seq).toBe(live.seq);
    const row = getGroupContextMessage(APP, CHAT, 'om_1');
    expect(row).toMatchObject({ revision: 0, senderName: 'Alex', rootId: 'om_root', text: 'same' });
    expect(getGroupContextHead(APP, CHAT).count).toBe(1);
  });

  it('补全只填空缺：已有 senderName 不被后来的覆盖，正文变化仍正常升 revision', () => {
    upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'v0', senderName: 'Alex' }));
    upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'v0', senderName: 'Someone Else' }));
    expect(getGroupContextMessage(APP, CHAT, 'om_1')?.senderName).toBe('Alex');
    const edit = upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'v1' }));
    expect(edit.inserted).toBe(true);
    expect(getGroupContextMessage(APP, CHAT, 'om_1')).toMatchObject({ revision: 1, text: 'v1' });
  });

  it('反复喂同一条 history 记录不产生任何新行', () => {
    upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'x', senderName: 'A' }));
    for (let i = 0; i < 5; i++) upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'x', senderName: 'A' }));
    expect(getGroupContextHead(APP, CHAT).count).toBe(1);
  });
});

describe('tombstone（撤回/删除）', () => {
  it('撤回后 history 旧数据 / 乱序到达的原消息不能复活 tombstone', () => {
    upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'bye' }));
    const t = markGroupContextMessageDeleted(APP, CHAT, 'om_1', { deletedAt: 5 });
    // history 回填：同正文、未删除形态
    const r1 = upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'bye', senderName: 'Alex' }));
    expect(r1.inserted).toBe(false);
    expect(r1.seq).toBe(t.seq);
    // 乱序：一条正文还不同的旧版本晚到
    const r2 = upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'older draft' }));
    expect(r2.inserted).toBe(false);
    const row = getGroupContextMessage(APP, CHAT, 'om_1');
    expect(row).toMatchObject({ deleted: true, text: 'bye', senderName: 'Alex' });
    expect(getGroupContextHead(APP, CHAT).count).toBe(2);
  });

  it('从未观察到的消息先收到撤回、后收到原消息：仍保持 tombstone', () => {
    markGroupContextMessageDeleted(APP, CHAT, 'om_late');
    const r = upsertGroupContextMessage(APP, msg({ messageId: 'om_late', text: 'late original' }));
    expect(r.inserted).toBe(false);
    expect(getGroupContextMessage(APP, CHAT, 'om_late')?.deleted).toBe(true);
  });

  it('删除以新 revision 记录，get 返回 deleted=true 且保留最后正文', () => {
    upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'bye' }));
    const t = markGroupContextMessageDeleted(APP, CHAT, 'om_1', { deletedAt: 1_700_000_999_000 });
    expect(t.inserted).toBe(true);
    const row = getGroupContextMessage(APP, CHAT, 'om_1');
    expect(row?.deleted).toBe(true);
    expect(row?.text).toBe('bye');
    expect(row?.deletedAt).toBe(1_700_000_999_000);
    // 重复删除不再分配新 seq
    expect(markGroupContextMessageDeleted(APP, CHAT, 'om_1').inserted).toBe(false);
  });

  it('删除一条从未观察到的消息：写入占位 tombstone，便于读方知道它曾存在', () => {
    const t = markGroupContextMessageDeleted(APP, CHAT, 'om_ghost');
    expect(t.inserted).toBe(true);
    const row = getGroupContextMessage(APP, CHAT, 'om_ghost');
    expect(row?.deleted).toBe(true);
    expect(row?.text).toBe('');
    expect(row?.senderType).toBe('unknown');
  });
});

describe('list 游标 / 过滤', () => {
  beforeEach(() => {
    for (let i = 1; i <= 5; i++) {
      upsertGroupContextMessage(APP, msg({
        messageId: `om_${i}`,
        createTime: 1_700_000_000_000 + i * 1000,
        rootId: i % 2 === 0 ? 'om_rootA' : undefined,
      }));
    }
  });

  it('默认按 seq 升序全量返回，throughSeq = 最后一条 seq，hasMore=false', () => {
    const r = listGroupContextMessages(APP, CHAT);
    expect(r.messages.map(m => m.messageId)).toEqual(['om_1', 'om_2', 'om_3', 'om_4', 'om_5']);
    expect(r.hasMore).toBe(false);
    expect(r.throughSeq).toBe(r.messages[4].seq);
    expect(r.retentionGap).toBeUndefined();
  });

  it('afterSeq + limit 翻页：hasMore 与 throughSeq 可直接作为下一页游标', () => {
    const p1 = listGroupContextMessages(APP, CHAT, { limit: 2 });
    expect(p1.messages.map(m => m.messageId)).toEqual(['om_1', 'om_2']);
    expect(p1.hasMore).toBe(true);
    const p2 = listGroupContextMessages(APP, CHAT, { afterSeq: p1.throughSeq, limit: 2 });
    expect(p2.messages.map(m => m.messageId)).toEqual(['om_3', 'om_4']);
    const p3 = listGroupContextMessages(APP, CHAT, { afterSeq: p2.throughSeq, limit: 2 });
    expect(p3.messages.map(m => m.messageId)).toEqual(['om_5']);
    expect(p3.hasMore).toBe(false);
    // 游标到头：空页，throughSeq 原样返回
    const p4 = listGroupContextMessages(APP, CHAT, { afterSeq: p3.throughSeq, limit: 2 });
    expect(p4.messages).toEqual([]);
    expect(p4.throughSeq).toBe(p3.throughSeq);
  });

  it('throughSeq 上界、beforeCreateTime、rootId 过滤', () => {
    const all = listGroupContextMessages(APP, CHAT).messages;
    const upto3 = listGroupContextMessages(APP, CHAT, { throughSeq: all[2].seq });
    expect(upto3.messages.map(m => m.messageId)).toEqual(['om_1', 'om_2', 'om_3']);
    const early = listGroupContextMessages(APP, CHAT, { beforeCreateTime: 1_700_000_000_000 + 3000 });
    expect(early.messages.map(m => m.messageId)).toEqual(['om_1', 'om_2']);
    const rootA = listGroupContextMessages(APP, CHAT, { rootId: 'om_rootA' });
    expect(rootA.messages.map(m => m.messageId)).toEqual(['om_2', 'om_4']);
  });

  it('limit 非法或过大时收敛到安全范围', () => {
    expect(listGroupContextMessages(APP, CHAT, { limit: 0 }).messages).toHaveLength(5);
    expect(listGroupContextMessages(APP, CHAT, { limit: -3 }).messages).toHaveLength(5);
    expect(listGroupContextMessages(APP, CHAT, { limit: 10_000_000 }).messages).toHaveLength(5);
  });
});

describe('head', () => {
  it('空群：headSeq=0、count=0、无 pruned 信息', () => {
    expect(getGroupContextHead(APP, CHAT)).toEqual({
      headSeq: 0, count: 0, oldestSeq: 0, newestCreateTime: undefined, prunedThroughSeq: 0, prunedCount: 0,
    });
  });

  it('有数据：headSeq 为最新 seq，count 按行计，newestCreateTime 取最大', () => {
    upsertGroupContextMessage(APP, msg({ messageId: 'om_1', createTime: 10 }));
    const b = upsertGroupContextMessage(APP, msg({ messageId: 'om_2', createTime: 30 }));
    upsertGroupContextMessage(APP, msg({ messageId: 'om_1', createTime: 10, text: 'edited' }));
    const h = getGroupContextHead(APP, CHAT);
    expect(h.headSeq).toBeGreaterThan(b.seq);
    expect(h.count).toBe(3);
    expect(h.newestCreateTime).toBe(30);
  });
});

describe('淘汰与 retentionGap', () => {
  it('超过 maxRows 时淘汰最旧 seq，list 从头读时显式报 retentionGap', () => {
    for (let i = 1; i <= 6; i++) upsertGroupContextMessage(APP, msg({ messageId: `om_${i}`, createTime: 1000 + i }));
    const pruned = pruneGroupContext(APP, CHAT, { maxRows: 4, now: 2_000 });
    expect(pruned.prunedCount).toBe(2);
    const r = listGroupContextMessages(APP, CHAT);
    expect(r.messages.map(m => m.messageId)).toEqual(['om_3', 'om_4', 'om_5', 'om_6']);
    expect(r.retentionGap).toEqual({ prunedThroughSeq: pruned.prunedThroughSeq, prunedCount: 2 });
    // 游标已越过淘汰区 → 无 gap
    const r2 = listGroupContextMessages(APP, CHAT, { afterSeq: pruned.prunedThroughSeq });
    expect(r2.retentionGap).toBeUndefined();
    // 游标落在淘汰区之内 → 仍报 gap
    const r3 = listGroupContextMessages(APP, CHAT, { afterSeq: 1 });
    expect(r3.retentionGap?.prunedThroughSeq).toBe(pruned.prunedThroughSeq);
    const h = getGroupContextHead(APP, CHAT);
    expect(h.prunedThroughSeq).toBe(pruned.prunedThroughSeq);
    expect(h.prunedCount).toBe(2);
  });

  it('超过 maxAgeMs 的记录被淘汰（按 createTime），默认 30 天', () => {
    const now = 100 * DAY;
    upsertGroupContextMessage(APP, msg({ messageId: 'om_old', createTime: now - 31 * DAY }));
    upsertGroupContextMessage(APP, msg({ messageId: 'om_new', createTime: now - 1 * DAY }));
    const pruned = pruneGroupContext(APP, CHAT, { now });
    expect(pruned.prunedCount).toBe(1);
    expect(listGroupContextMessages(APP, CHAT).messages.map(m => m.messageId)).toEqual(['om_new']);
  });

  it('upsert 会按阈值自动触发淘汰（默认 10000 条/群），写入方不必手动 prune', () => {
    for (let i = 1; i <= 30; i++) upsertGroupContextMessage(APP, msg({ messageId: `om_${i}`, createTime: 1000 + i }), { maxRows: 20 });
    const h = getGroupContextHead(APP, CHAT);
    expect(h.count).toBeLessThanOrEqual(20);
    expect(h.prunedCount).toBeGreaterThan(0);
    expect(listGroupContextMessages(APP, CHAT).retentionGap).toBeDefined();
  });

  it('淘汰按 chat 隔离：另一个群不受影响', () => {
    for (let i = 1; i <= 3; i++) upsertGroupContextMessage(APP, msg({ messageId: `om_${i}` }));
    upsertGroupContextMessage(APP, msg({ messageId: 'om_other', chatId: 'oc_chat_2' }));
    pruneGroupContext(APP, CHAT, { maxRows: 1, now: 2_000 });
    expect(listGroupContextMessages(APP, 'oc_chat_2').messages).toHaveLength(1);
    expect(listGroupContextMessages(APP, 'oc_chat_2').retentionGap).toBeUndefined();
  });
});

describe('持久化 / 多进程', () => {
  it('重开（模拟重启）后记录与 seq 连续', () => {
    const a = upsertGroupContextMessage(APP, msg({ messageId: 'om_1' }));
    _resetGroupContextStoreForTest();
    const b = upsertGroupContextMessage(APP, msg({ messageId: 'om_2' }));
    expect(b.seq).toBe(a.seq + 1);
    expect(listGroupContextMessages(APP, CHAT).messages).toHaveLength(2);
    // 重启后对同 messageId 同正文的重复写入仍不分配新 seq
    expect(upsertGroupContextMessage(APP, msg({ messageId: 'om_1' })).inserted).toBe(false);
  });

  it('两个独立进程写同一文件：各自看得到对方写入（子进程走 ts-runner）', async () => {
    const { spawnSyncTsEvalWithRepoImports } = await import('./helpers/ts-runner.js');
    const { resolve } = await import('node:path');
    upsertGroupContextMessage(APP, msg({ messageId: 'om_parent' }));
    const storePath = resolve(process.cwd(), 'src/services/group-context-store.ts');
    const code = `
      import { upsertGroupContextMessage, listGroupContextMessages } from ${JSON.stringify(storePath)};
      const r = upsertGroupContextMessage(${JSON.stringify(APP)}, {
        chatId: ${JSON.stringify(CHAT)}, messageId: 'om_child', senderId: 'ou_c', senderType: 'user', msgType: 'text',
        text: 'from child', createTime: 1, resourceRefs: [], sourceAppId: ${JSON.stringify(APP)},
      });
      const ids = listGroupContextMessages(${JSON.stringify(APP)}, ${JSON.stringify(CHAT)}).messages.map(m => m.messageId);
      process.stdout.write(JSON.stringify({ seq: r.seq, ids }));
    `;
    const out = spawnSyncTsEvalWithRepoImports(code, {
      encoding: 'utf-8', timeout: 30_000,
      env: { ...process.env, SESSION_DATA_DIR: dataDir },
    });
    expect(out.status, String(out.stderr)).toBe(0);
    const parsed = JSON.parse(String(out.stdout).trim());
    expect(parsed.ids).toEqual(['om_parent', 'om_child']);
    _resetGroupContextStoreForTest();
    expect(listGroupContextMessages(APP, CHAT).messages.map(m => m.messageId)).toEqual(['om_parent', 'om_child']);
  });
});
