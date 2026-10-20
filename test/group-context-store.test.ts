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
  it('keeps local card observation separate from authoritative platform edit ordering', () => {
    const card = msg({ messageId: 'om_observed', senderType: 'bot', msgType: 'interactive', cardContentVersion: 1,
      text: 'Answer A', cardObservedAt: 500 });
    const first = upsertGroupContextMessage(APP, card);
    expect(getGroupContextMessage(APP, CHAT, card.messageId)).toMatchObject({ cardObservedAt: 500, updateTime: undefined });
    const edited = upsertGroupContextMessage(APP, { ...card, text: 'Answer B', updateTime: 450, cardObservedAt: undefined });
    expect(edited.seq).toBeGreaterThan(first.seq);
    expect(getGroupContextMessage(APP, CHAT, card.messageId)).toMatchObject({ text: 'Answer B', updateTime: 450, cardObservedAt: undefined });
    const stale = upsertGroupContextMessage(APP, { ...card, text: 'Stale answer', updateTime: 400, cardObservedAt: 600 });
    expect(stale).toEqual({ ...edited, inserted: false });
    expect(getGroupContextMessage(APP, CHAT, card.messageId)).toMatchObject({ text: 'Answer B', updateTime: 450, cardObservedAt: undefined });
  });

  it('preserves the earliest same-body observation across duplicate history and process-only updates', () => {
    const card = msg({ messageId: 'om_observed', senderType: 'bot', msgType: 'interactive', cardContentVersion: 1, text: 'Answer' });
    const first = upsertGroupContextMessage(APP, card);
    for (const cardObservedAt of [500, 700, 400, 900]) {
      expect(upsertGroupContextMessage(APP, { ...card, cardObservedAt })).toEqual({ ...first, inserted: false });
    }
    _resetGroupContextStoreForTest();
    expect(listGroupContextMessages(APP, CHAT).messages).toMatchObject([{ seq: first.seq, cardObservedAt: 400, updateTime: undefined }]);
    const revised = upsertGroupContextMessage(APP, { ...card, text: 'New answer', cardObservedAt: 1000 });
    expect(getGroupContextMessage(APP, CHAT, card.messageId)).toMatchObject({ seq: revised.seq, cardObservedAt: 1000 });
    markGroupContextMessageDeleted(APP, CHAT, card.messageId, { deletedAt: 1100 });
    upsertGroupContextMessage(APP, { ...card, text: 'New answer', cardObservedAt: 100 });
    expect(getGroupContextMessage(APP, CHAT, card.messageId)).toMatchObject({ deleted: true, cardObservedAt: 1000 });
  });

  it('does not accept card observation metadata without canonical content provenance', () => {
    const row = msg({ messageId: 'om_unverified', text: 'Unverified card', cardObservedAt: 500 });
    upsertGroupContextMessage(APP, row);
    expect(getGroupContextMessage(APP, CHAT, row.messageId)?.cardObservedAt).toBeUndefined();
    upsertGroupContextMessage(APP, { ...row, cardObservedAt: 400, cardContentVersion: 2 });
    expect(getGroupContextMessage(APP, CHAT, row.messageId)?.cardObservedAt).toBeUndefined();
  });

  it('same-content canonical history enriches card provenance without allocating a new seq', () => {
    const legacy = msg({ messageId: 'om_card', senderType: 'bot', msgType: 'interactive', text: 'Authored answer', updateTime: 200 });
    const first = upsertGroupContextMessage(APP, legacy);
    const projected = upsertGroupContextMessage(APP, { ...legacy, cardContentVersion: 1 });
    expect(projected).toEqual({ ...first, inserted: false });
    expect(getGroupContextMessage(APP, CHAT, 'om_card')).toMatchObject({ seq: first.seq, revision: 0, cardContentVersion: 1 });
    _resetGroupContextStoreForTest();
    expect(listGroupContextMessages(APP, CHAT).messages).toMatchObject([{ seq: first.seq, cardContentVersion: 1 }]);
    upsertGroupContextMessage(APP, legacy);
    expect(getGroupContextMessage(APP, CHAT, 'om_card')?.cardContentVersion).toBe(1);
    expect(getGroupContextHead(APP, CHAT).count).toBe(1);
  });

  it('stale canonical observations cannot certify retained legacy text even when hashes match', () => {
    const legacy = msg({ messageId: 'om_card', senderType: 'bot', msgType: 'interactive', text: '💭 **处理中 · 12.0s**\nPRIVATE_PROCESS', updateTime: 200 });
    const first = upsertGroupContextMessage(APP, legacy);
    for (const text of [legacy.text, 'Older projected answer']) {
      const stale = upsertGroupContextMessage(APP, { ...legacy, text, updateTime: 100, cardContentVersion: 1 });
      expect(stale).toEqual({ ...first, inserted: false });
      expect(getGroupContextMessage(APP, CHAT, 'om_card')).toMatchObject({ text: legacy.text, updateTime: 200 });
      expect(getGroupContextMessage(APP, CHAT, 'om_card')?.cardContentVersion).toBeUndefined();
    }
  });

  it('keeps projection provenance bound to each revision and preserves it on answer recall', () => {
    const answer = msg({ messageId: 'om_card', senderType: 'bot', msgType: 'interactive', text: 'The budget is 3000.', cardContentVersion: 1 });
    upsertGroupContextMessage(APP, answer);
    const deleted = markGroupContextMessageDeleted(APP, CHAT, 'om_card', { deletedAt: 7 });
    expect(getGroupContextMessage(APP, CHAT, 'om_card')).toMatchObject({ seq: deleted.seq, deleted: true, cardContentVersion: 1 });
    upsertGroupContextMessage(APP, { ...answer, text: 'Stale answer', cardContentVersion: 2 });
    expect(getGroupContextMessage(APP, CHAT, 'om_card')).toMatchObject({ seq: deleted.seq, deleted: true, text: answer.text, cardContentVersion: 1 });

    upsertGroupContextMessage(APP, { ...answer, messageId: 'om_edit' });
    upsertGroupContextMessage(APP, { ...answer, messageId: 'om_edit', text: 'Unprojected revision', cardContentVersion: undefined });
    expect(listGroupContextMessages(APP, CHAT).messages.filter(row => row.messageId === 'om_edit').map(row => row.cardContentVersion)).toEqual([1, undefined]);
  });

  it.each([0, -1, NaN, Infinity, 1.5, 2])('does not persist unsupported card projection version %s', (cardContentVersion) => {
    upsertGroupContextMessage(APP, msg({ messageId: 'om_invalid', cardContentVersion }));
    expect(getGroupContextMessage(APP, CHAT, 'om_invalid')?.cardContentVersion).toBeUndefined();
  });

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

describe('conversation provenance', () => {
  it.each(['main', 'thread'] as const)('persists %s scope across database reopen', conversationScope => {
    const saved = upsertGroupContextMessage(APP, msg({ messageId: 'om_scope', conversationScope }));
    _resetGroupContextStoreForTest();
    expect(getGroupContextMessage(APP, CHAT, 'om_scope')).toMatchObject({ seq: saved.seq, conversationScope });
  });

  it('enriches same-body unknown scope without allocating a revision', () => {
    const source = msg({ messageId: 'om_quote', rootId: 'om_quoted', text: 'Ordinary lobby quote', updateTime: 200 });
    const first = upsertGroupContextMessage(APP, source);
    expect(upsertGroupContextMessage(APP, { ...source, conversationScope: 'main' })).toEqual({ ...first, inserted: false });
    expect(getGroupContextMessage(APP, CHAT, source.messageId)).toMatchObject({ conversationScope: 'main', rootId: 'om_quoted' });
  });

  it('inherits known conversation and reply metadata on edits and real recalls', () => {
    const source = msg({ messageId: 'om_reply', conversationScope: 'thread', rootId: 'om_root', threadId: 'omt_native', parentId: 'om_parent' });
    upsertGroupContextMessage(APP, source);
    upsertGroupContextMessage(APP, msg({ messageId: source.messageId, text: 'Edited without routing metadata' }));
    const expected = { conversationScope: 'thread', rootId: 'om_root', threadId: 'omt_native', parentId: 'om_parent' };
    expect(getGroupContextMessage(APP, CHAT, source.messageId)).toMatchObject(expected);
    markGroupContextMessageDeleted(APP, CHAT, source.messageId, { deletedAt: 300 });
    expect(getGroupContextMessage(APP, CHAT, source.messageId)).toMatchObject({ ...expected, deleted: true });
  });

  it('recovers routing from older retained revisions when a legacy latest edit dropped it', async () => {
    const source = msg({ messageId: 'om_legacy_edit', conversationScope: 'thread', rootId: 'om_root', threadId: 'omt_native', parentId: 'om_parent' });
    upsertGroupContextMessage(APP, source);
    const latest = upsertGroupContextMessage(APP, { ...source, text: 'Legacy edit' });
    _resetGroupContextStoreForTest();
    const { openDatabaseSyncOrThrow } = await import('../src/services/sqlite-compat.js');
    const db = openDatabaseSyncOrThrow(groupContextDbPath(APP));
    db.prepare('UPDATE messages SET conversation_scope = NULL, root_id = NULL, thread_id = NULL, parent_id = NULL WHERE seq = ?').run(latest.seq);
    db.close();

    upsertGroupContextMessage(APP, msg({ messageId: source.messageId, text: 'Current edit' }));
    expect(getGroupContextMessage(APP, CHAT, source.messageId)).toMatchObject({
      conversationScope: 'thread', rootId: 'om_root', threadId: 'omt_native', parentId: 'om_parent',
    });
  });

  it.each([false, true])('does not downgrade legacy native topic evidence from a later sparse main observation, edited=%s', edited => {
    const source = msg({ messageId: 'om_native_legacy', threadId: 'omt_native', rootId: 'om_root', text: 'Native topic answer' });
    upsertGroupContextMessage(APP, source);
    upsertGroupContextMessage(APP, msg({ messageId: source.messageId, conversationScope: 'main', text: edited ? 'Updated answer' : source.text }));
    expect(getGroupContextMessage(APP, CHAT, source.messageId)).toMatchObject({ conversationScope: 'thread', threadId: 'omt_native', rootId: 'om_root' });
  });

  it.each([false, true])('retains the first proven main origin when a starter acquires a native topic, edited=%s', edited => {
    const source = msg({ messageId: 'om_starter', conversationScope: 'main', text: 'Initially visible in lobby' });
    upsertGroupContextMessage(APP, source);
    upsertGroupContextMessage(APP, { ...source, conversationScope: 'thread', threadId: 'omt_native', text: edited ? 'Edited starter' : source.text });
    expect(getGroupContextMessage(APP, CHAT, source.messageId)).toMatchObject({ conversationScope: 'main', threadId: 'omt_native' });
  });

  it.each(['same', 'older'])('cannot classify a retained newer body from stale %s-body routing', text => {
    const source = msg({ messageId: 'om_late', text: 'same', updateTime: 200 });
    const first = upsertGroupContextMessage(APP, source);
    expect(upsertGroupContextMessage(APP, { ...source, text, updateTime: 100, conversationScope: 'thread', rootId: 'om_wrong', threadId: 'omt_wrong', parentId: 'om_wrong_parent' }))
      .toEqual({ ...first, inserted: false });
    const retained = getGroupContextMessage(APP, CHAT, source.messageId)!;
    expect(retained.conversationScope).toBeUndefined();
    expect(retained.rootId).toBeUndefined();
    expect(retained.threadId).toBeUndefined();
    expect(retained.parentId).toBeUndefined();
  });
});

describe('平台 update_time 版本：乱序编辑', () => {
  it('实时先到 v1(200)，history 后回填 v0(100)：拒绝回退，最新仍是 v1，不加行', () => {
    const v1 = upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'v1', updateTime: 200 }));
    const stale = upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'v0', updateTime: 100, senderName: 'Alex' }));
    expect(stale.inserted).toBe(false);
    expect(stale.seq).toBe(v1.seq);
    const row = getGroupContextMessage(APP, CHAT, 'om_1');
    expect(row).toMatchObject({ text: 'v1', revision: 0, updateTime: 200, senderName: 'Alex' });
    expect(getGroupContextHead(APP, CHAT).count).toBe(1);
  });

  it('正序 v0(100) → v1(200)：正常追加 revision，updateTime 落库', () => {
    upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'v0', updateTime: 100 }));
    const r = upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'v1', updateTime: 200 }));
    expect(r.inserted).toBe(true);
    expect(getGroupContextMessage(APP, CHAT, 'om_1')).toMatchObject({ text: 'v1', revision: 1, updateTime: 200 });
    expect(listGroupContextMessages(APP, CHAT).messages.map(m => [m.text, m.updateTime])).toEqual([['v0', 100], ['v1', 200]]);
  });

  it('任一方没有版本号：无法消歧，按到达顺序追加（不伪造版本）', () => {
    upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'v1', updateTime: 200 }));
    const r = upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'v0' }));
    expect(r.inserted).toBe(true);
    expect(getGroupContextMessage(APP, CHAT, 'om_1')).toMatchObject({ text: 'v0', revision: 1, updateTime: undefined });
    upsertGroupContextMessage(APP, msg({ messageId: 'om_2', text: 'a' }));
    const r2 = upsertGroupContextMessage(APP, msg({ messageId: 'om_2', text: 'b', updateTime: 50 }));
    expect(r2.inserted).toBe(true);
  });

  it('同正文同版本：不加行；同正文更新版本：只把 update_time 往前推，不回退', () => {
    const a = upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'x', updateTime: 100 }));
    expect(upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'x', updateTime: 100 })).inserted).toBe(false);
    expect(upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'x', updateTime: 300 })).inserted).toBe(false);
    expect(getGroupContextMessage(APP, CHAT, 'om_1')).toMatchObject({ seq: a.seq, updateTime: 300 });
    expect(upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'x', updateTime: 150 })).inserted).toBe(false);
    expect(getGroupContextMessage(APP, CHAT, 'om_1')?.updateTime).toBe(300);
    // 实时无版本、history 带版本：补空缺
    upsertGroupContextMessage(APP, msg({ messageId: 'om_2', text: 'y' }));
    upsertGroupContextMessage(APP, msg({ messageId: 'om_2', text: 'y', updateTime: 500 }));
    expect(getGroupContextMessage(APP, CHAT, 'om_2')?.updateTime).toBe(500);
    expect(getGroupContextHead(APP, CHAT).count).toBe(2);
  });

  it('非法版本号（0 / 负数 / NaN）按未知处理', () => {
    upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'v1', updateTime: 200 }));
    const r = upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'v0', updateTime: 0 }));
    expect(r.inserted).toBe(true);
    expect(getGroupContextMessage(APP, CHAT, 'om_1')?.updateTime).toBeUndefined();
  });

  it('撤回压过正文版本：活正文 updateTime=200 后送 deleted + updateTime=100，latest 必须是 tombstone', () => {
    upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'live', updateTime: 200 }));
    const t = upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'live', updateTime: 100, deleted: true, deletedAt: 7 }));
    expect(t.inserted).toBe(true);
    expect(getGroupContextMessage(APP, CHAT, 'om_1')).toMatchObject({ deleted: true, deletedAt: 7, revision: 1 });
    // 之后更高版本的正文也不能复活
    expect(upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'live again', updateTime: 900 })).inserted).toBe(false);
    expect(getGroupContextMessage(APP, CHAT, 'om_1')?.deleted).toBe(true);
  });

  it('markGroupContextMessageDeleted 不复制旧版本号：tombstone 行 updateTime 为空，并发写入的新正文也压不过它', () => {
    upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'v1', updateTime: 100 }));
    upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'v2', updateTime: 300 }));
    const t = markGroupContextMessageDeleted(APP, CHAT, 'om_1', { deletedAt: 9 });
    expect(t.inserted).toBe(true);
    const row = getGroupContextMessage(APP, CHAT, 'om_1');
    expect(row).toMatchObject({ deleted: true, text: 'v2', updateTime: undefined });
    expect(upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'v3', updateTime: 400 })).inserted).toBe(false);
  });

  it('tombstone 仍是终态：带更新版本号的未删除形态也不能复活', () => {
    upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'bye', updateTime: 100 }));
    markGroupContextMessageDeleted(APP, CHAT, 'om_1', { deletedAt: 5 });
    expect(upsertGroupContextMessage(APP, msg({ messageId: 'om_1', text: 'bye edited', updateTime: 900 })).inserted).toBe(false);
    expect(getGroupContextMessage(APP, CHAT, 'om_1')?.deleted).toBe(true);
  });
});

describe('schema 迁移', () => {
  it.each([2, 3])('upgrades an existing v%s database with unknown card observation and preserves its seq', async schemaVersion => {
    const { openDatabaseSyncOrThrow } = await import('../src/services/sqlite-compat.js');
    const { mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const path = groupContextDbPath(APP);
    mkdirSync(dirname(path), { recursive: true });
    const db = openDatabaseSyncOrThrow(path);
    db.exec(`
      CREATE TABLE messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, message_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, root_id TEXT, thread_id TEXT, parent_id TEXT,
        sender_id TEXT NOT NULL, sender_type TEXT NOT NULL, sender_name TEXT, msg_type TEXT NOT NULL,
        text TEXT NOT NULL, create_time INTEGER NOT NULL, update_time INTEGER,
        ${schemaVersion === 3 ? 'card_content_version INTEGER,' : ''}
        resource_refs TEXT NOT NULL DEFAULT '[]', source_app_id TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER, content_hash TEXT NOT NULL, observed_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX ux_messages_chat_msg_rev ON messages(chat_id, message_id, revision);
      CREATE TABLE chat_meta (chat_id TEXT PRIMARY KEY, pruned_through_seq INTEGER NOT NULL DEFAULT 0, pruned_count INTEGER NOT NULL DEFAULT 0);
      INSERT INTO messages (seq, chat_id, message_id, revision, sender_id, sender_type, msg_type, text, create_time, update_time, source_app_id, content_hash, observed_at)
        VALUES (7, '${CHAT}', 'om_old', 0, 'bot', 'bot', 'interactive', 'Legacy card', 1, 50, '${APP}', 'h', 1);
      PRAGMA user_version=${schemaVersion};
    `);
    db.close();

    expect(getGroupContextMessage(APP, CHAT, 'om_old')).toMatchObject({ seq: 7, text: 'Legacy card', updateTime: 50 });
    expect(getGroupContextMessage(APP, CHAT, 'om_old')?.cardContentVersion).toBeUndefined();
    expect(getGroupContextMessage(APP, CHAT, 'om_old')?.cardObservedAt).toBeUndefined();
    expect(getGroupContextMessage(APP, CHAT, 'om_old')?.conversationScope).toBeUndefined();
    const canonical = upsertGroupContextMessage(APP, msg({ messageId: 'om_new', senderType: 'bot', msgType: 'interactive', text: 'Projected answer', cardContentVersion: 1, cardObservedAt: 500 }));
    expect(canonical.seq).toBe(8);
    expect(getGroupContextMessage(APP, CHAT, 'om_new')?.cardContentVersion).toBe(1);
    expect(getGroupContextMessage(APP, CHAT, 'om_new')?.cardObservedAt).toBe(500);
    _resetGroupContextStoreForTest();
    const upgraded = openDatabaseSyncOrThrow(path);
    expect((upgraded.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(column => column.name)).toContain('card_content_version');
    expect((upgraded.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(column => column.name)).toContain('card_observed_at');
    expect((upgraded.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(column => column.name)).toContain('conversation_scope');
    expect((upgraded.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(column => column.name)).toEqual(expect.arrayContaining(['mentions', 'raw_text']));
    expect((upgraded.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(5);
    upgraded.close();
  });

  it.each([
    ['a released v4 database (card_observed_at present, no mention columns)', false],
    ['a development v4 database that already carries the mention columns', true],
  ])('upgrades %s to v5 and keeps legacy rows on the name-stripping fallback', async (_label, withColumns) => {
    const { openDatabaseSyncOrThrow } = await import('../src/services/sqlite-compat.js');
    const { mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const path = groupContextDbPath(APP);
    mkdirSync(dirname(path), { recursive: true });
    const db = openDatabaseSyncOrThrow(path);
    // Exactly the shape the previous release leaves behind: schema 4 with every
    // v4 column, which used to satisfy the migration's early return.
    db.exec(`
      CREATE TABLE messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, message_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, root_id TEXT, thread_id TEXT, parent_id TEXT,
        sender_id TEXT NOT NULL, sender_type TEXT NOT NULL, sender_name TEXT, msg_type TEXT NOT NULL,
        text TEXT NOT NULL, create_time INTEGER NOT NULL, update_time INTEGER, card_content_version INTEGER, card_observed_at INTEGER,
        resource_refs TEXT NOT NULL DEFAULT '[]', ${withColumns ? 'mentions TEXT, raw_text TEXT,' : ''} source_app_id TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER, content_hash TEXT NOT NULL, observed_at INTEGER NOT NULL, conversation_scope TEXT
      );
      CREATE UNIQUE INDEX ux_messages_chat_msg_rev ON messages(chat_id, message_id, revision);
      CREATE INDEX ix_messages_chat_seq ON messages(chat_id, seq);
      CREATE TABLE chat_meta (chat_id TEXT PRIMARY KEY, pruned_through_seq INTEGER NOT NULL DEFAULT 0, pruned_count INTEGER NOT NULL DEFAULT 0);
      INSERT INTO messages (seq, chat_id, message_id, revision, sender_id, sender_type, msg_type, text, create_time, update_time, source_app_id, content_hash, observed_at, conversation_scope)
        VALUES (890, '${CHAT}', 'om_scope', 0, 'ou_user', 'user', 'text', '@Alex 范围有点问题', 100, 100, '${APP}', 'h', 1, 'main');
      PRAGMA user_version=4;
    `);
    db.close();

    // The legacy row reads back without mention evidence or a raw body.
    const legacy = getGroupContextMessage(APP, CHAT, 'om_scope');
    expect(legacy).toMatchObject({ seq: 890, text: '@Alex 范围有点问题' });
    expect(legacy?.mentions).toBeUndefined();
    expect(legacy?.rawText).toBeUndefined();
    // A history read carrying structured mentions (the common Lark shape) upgrades the
    // legacy row in place through the name-stripping fallback.
    expect(upsertGroupContextMessage(APP, msg({ messageId: 'om_scope', text: '@Alex 范围有点问题', createTime: 100, updateTime: 100,
      mentions: [{ key: '@_user_1', name: 'Alex', openId: 'ou_alex' }], rawText: '@_user_1 范围有点问题' })).inserted).toBe(false);
    const upgradedRow = getGroupContextMessage(APP, CHAT, 'om_scope');
    expect(upgradedRow?.revision).toBe(0);
    expect(upgradedRow?.mentions).toEqual([{ key: '@_user_1', name: 'Alex', openId: 'ou_alex' }]);
    expect(upgradedRow?.rawText).toBe('@_user_1 范围有点问题');
    // New rows persist both columns.
    upsertGroupContextMessage(APP, msg({ messageId: 'om_new', text: '@Bobby hi', mentions: [{ key: '@_user_1', name: 'Bobby', openId: 'ou_bobby' }], rawText: '@_user_1 hi' }));
    expect(getGroupContextMessage(APP, CHAT, 'om_new')).toMatchObject({ rawText: '@_user_1 hi', mentions: [{ key: '@_user_1', name: 'Bobby', openId: 'ou_bobby' }] });
    _resetGroupContextStoreForTest();
    const upgraded = openDatabaseSyncOrThrow(path);
    const columns = (upgraded.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(column => column.name);
    expect(columns).toEqual(expect.arrayContaining(['mentions', 'raw_text', 'card_observed_at', 'conversation_scope']));
    expect(columns.filter(name => name === 'mentions')).toHaveLength(1);
    expect((upgraded.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(5);
    upgraded.close();
    // Reopening a v5 database is a no-op.
    expect(getGroupContextMessage(APP, CHAT, 'om_new')?.rawText).toBe('@_user_1 hi');
  });

  it('v1 库（无 update_time 列）打开后自动补列，旧行 updateTime 为未知', async () => {
    const { openDatabaseSyncOrThrow } = await import('../src/services/sqlite-compat.js');
    const { mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const path = groupContextDbPath(APP);
    mkdirSync(dirname(path), { recursive: true });
    const db = openDatabaseSyncOrThrow(path);
    db.exec(`
      CREATE TABLE messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, message_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, root_id TEXT, thread_id TEXT, parent_id TEXT,
        sender_id TEXT NOT NULL, sender_type TEXT NOT NULL, sender_name TEXT, msg_type TEXT NOT NULL,
        text TEXT NOT NULL, create_time INTEGER NOT NULL, resource_refs TEXT NOT NULL DEFAULT '[]',
        source_app_id TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER,
        content_hash TEXT NOT NULL, observed_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX ux_messages_chat_msg_rev ON messages(chat_id, message_id, revision);
      CREATE TABLE chat_meta (chat_id TEXT PRIMARY KEY, pruned_through_seq INTEGER NOT NULL DEFAULT 0, pruned_count INTEGER NOT NULL DEFAULT 0);
      INSERT INTO messages (chat_id, message_id, revision, sender_id, sender_type, msg_type, text, create_time, source_app_id, content_hash, observed_at)
        VALUES ('${CHAT}', 'om_old', 0, 'ou_x', 'user', 'text', 'legacy', 1, '${APP}', 'h', 1);
      PRAGMA user_version=1;
    `);
    db.close();
    const row = getGroupContextMessage(APP, CHAT, 'om_old');
    expect(row).toMatchObject({ text: 'legacy', updateTime: undefined });
    const r = upsertGroupContextMessage(APP, msg({ messageId: 'om_old', text: 'edited', updateTime: 42 }));
    expect(r.inserted).toBe(true);
    expect(getGroupContextMessage(APP, CHAT, 'om_old')).toMatchObject({ text: 'edited', updateTime: 42 });
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

  it('history 新→旧回填（旧消息拿到大 seq）：maxRows 淘汰按消息时间删最早的，最新的必须留下', () => {
    // 105 条不同消息，按聊天时间从新到旧写入：第 1 条写入的是最新消息（seq=1），最后写入的最老（seq=105）。
    // 用接近当前的时间戳，避免 upsert 每 64 条的自动淘汰按默认 30 天把 1970 年的测试数据删掉。
    const base = Date.now();
    for (let i = 0; i < 105; i++) {
      upsertGroupContextMessage(APP, msg({ messageId: `om_${i}`, createTime: base - i * 1000 }));
    }
    const pruned = pruneGroupContext(APP, CHAT, { maxRows: 100, now: base + 1 });
    expect(pruned.prunedCount).toBe(5);
    const left = listGroupContextMessages(APP, CHAT, { limit: 2000 }).messages;
    expect(left).toHaveLength(100);
    const ids = new Set(left.map(m => m.messageId));
    expect(ids.has('om_0')).toBe(true);                       // 最新那条（seq=1）留下
    for (let i = 100; i < 105; i++) expect(ids.has(`om_${i}`)).toBe(false); // 最早 5 条被删
    for (let i = 0; i < 100; i++) expect(ids.has(`om_${i}`)).toBe(true);
    // prunedThroughSeq 是「有缺口的最大序号」（这里 = 105），不表示更小的 seq 全没了
    expect(pruned.prunedThroughSeq).toBe(105);
    const fromStart = listGroupContextMessages(APP, CHAT, { limit: 2000 });
    expect(fromStart.retentionGap).toEqual({ prunedThroughSeq: 105, prunedCount: 5 });
    expect(fromStart.messages[0].seq).toBe(1);
  });

  it('淘汰按有效时间：老消息最近被编辑过（updateTime 新）就不算最旧', () => {
    upsertGroupContextMessage(APP, msg({ messageId: 'om_old_edited', createTime: 1000, updateTime: 9000 }));
    upsertGroupContextMessage(APP, msg({ messageId: 'om_mid', createTime: 5000 }));
    upsertGroupContextMessage(APP, msg({ messageId: 'om_new', createTime: 8000 }));
    const pruned = pruneGroupContext(APP, CHAT, { maxRows: 2, now: 10_000 });
    expect(pruned.prunedCount).toBe(1);
    expect(listGroupContextMessages(APP, CHAT).messages.map(m => m.messageId).sort()).toEqual(['om_new', 'om_old_edited']);
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

describe('文件权限', () => {
  it('目录 0700、主文件 0600（非 Windows）', async () => {
    if (process.platform === 'win32') return;
    const { statSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    upsertGroupContextMessage(APP, msg({ messageId: 'om_1' }));
    const path = groupContextDbPath(APP);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // WAL 副文件若已出现，不能比主文件更宽
    for (const suffix of ['-wal', '-shm']) {
      let mode: number;
      try { mode = statSync(path + suffix).mode; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      expect(mode & 0o077).toBe(0);
    }
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
