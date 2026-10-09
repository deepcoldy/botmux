/**
 * group-context-ingest: 把 im.message.receive_v1 事件静默写进 group-context-store。
 *
 * 契约：
 *  - 受 settings resolver 保护，默认关（未注册 resolver 或 enabled=false 时零写入）；
 *  - 只旁听群聊（p2p 跳过），不改任何唤醒/权限判断，纯记录；
 *  - 解析复用 message-parser（正文、[图片 N] 占位、附件引用）；
 *  - 任何错误（存储打不开、解析异常）都吞掉并返回 outcome，绝不向调用方抛出；
 *  - 不触碰 seen-message 去重：同一事件重复喂入时靠 store 的同正文判重，不分配新 seq。
 *
 * Run: bun run vitest run test/group-context-ingest.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), isDebug: () => false },
}));

import {
  ingestGroupContextEvent,
  normalizeGroupContextEvent,
  ingestGroupContextRecall,
  setGroupContextSettingsResolver,
  _resetGroupContextIngestForTest,
} from '../src/services/group-context-ingest.js';
import {
  listGroupContextMessages,
  getGroupContextMessage,
  groupContextDbPath,
  _resetGroupContextStoreForTest,
} from '../src/services/group-context-store.js';
import { logger } from '../src/utils/logger.js';
import { markGroupContextCardPurpose } from '../src/im/lark/group-context-card.js';

const APP = 'cli_app_a';
const CHAT = 'oc_chat_1';
let dataDir: string;

function event(over: {
  messageId?: string; text?: string; chatType?: string; senderType?: string; openId?: string; appId?: string;
  msgType?: string; content?: string; rootId?: string; threadId?: string; createTime?: string; mentions?: any[];
} = {}) {
  const msgType = over.msgType ?? 'text';
  const content = over.content ?? JSON.stringify({ text: over.text ?? 'hi' });
  return {
    sender: {
      sender_id: over.openId === undefined && over.appId
        ? { app_id: over.appId }
        : { open_id: over.openId ?? 'ou_user_1', union_id: 'on_u1' },
      sender_type: over.senderType ?? 'user',
    },
    message: {
      message_id: over.messageId ?? 'om_1',
      root_id: over.rootId,
      thread_id: over.threadId,
      message_type: msgType,
      content,
      chat_id: CHAT,
      chat_type: over.chatType ?? 'group',
      create_time: over.createTime ?? '1700000000123',
      mentions: over.mentions,
    },
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-group-ctx-ingest-'));
  vi.stubEnv('SESSION_DATA_DIR', dataDir);
  _resetGroupContextStoreForTest();
  _resetGroupContextIngestForTest();
  vi.mocked(logger.warn).mockClear();
});

afterEach(() => {
  _resetGroupContextStoreForTest();
  _resetGroupContextIngestForTest();
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('开关', () => {
  it('does not store routine bot Working posts or terminal control cards', () => {
    setGroupContextSettingsResolver(() => ({ enabled: true }));
    const working = event({ senderType: 'app', msgType: 'post', content: JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'text', text: 'Working' }]] } }) });
    expect(ingestGroupContextEvent(APP, working)).toBe('skipped_noise');
    const controls = event({ senderType: 'app', msgType: 'interactive', content: JSON.stringify({
      header: { title: { tag: 'plain_text', content: '🖥️ Codex · 启动中…' } },
      elements: [{ tag: 'markdown', content: '[🖥️ 打开 Web 终端](http://localhost:8801/s/test?viewToken=TEST_ONLY_VALUE)' }],
    }) });
    expect(ingestGroupContextEvent(APP, controls)).toBe('skipped_noise');
    expect(listGroupContextMessages(APP, CHAT).messages).toHaveLength(0);
  });

  it('keeps user discussion but masks session control credentials before persistence', () => {
    setGroupContextSettingsResolver(() => ({ enabled: true }));
    expect(ingestGroupContextEvent(APP, event({ text: 'Review http://localhost/s/test?viewToken=TEST_ONLY_VALUE&mode=view' }))).toBe('stored');
    const text = getGroupContextMessage(APP, CHAT, 'om_1')?.text;
    expect(text).toContain('viewToken=***************&mode=view');
    expect(text).not.toContain('TEST_ONLY_VALUE');
  });

  it('未注册 resolver → disabled，零写入（默认关）', () => {
    expect(ingestGroupContextEvent(APP, event())).toBe('disabled');
    expect(listGroupContextMessages(APP, CHAT).messages).toHaveLength(0);
  });

  it('resolver 返回 enabled=false → disabled', () => {
    setGroupContextSettingsResolver(() => ({ enabled: false, maxContextChars: 1000 }));
    expect(ingestGroupContextEvent(APP, event())).toBe('disabled');
    expect(listGroupContextMessages(APP, CHAT).messages).toHaveLength(0);
  });

  it('resolver 按 (appId, chatId) 调用', () => {
    const resolver = vi.fn(() => ({ enabled: true, maxContextChars: 1000 }));
    setGroupContextSettingsResolver(resolver);
    ingestGroupContextEvent(APP, event());
    expect(resolver).toHaveBeenCalledWith(APP, CHAT);
  });

  it('resolver 自身抛错 → 视为关闭，不抛出', () => {
    setGroupContextSettingsResolver(() => { throw new Error('boom'); });
    expect(ingestGroupContextEvent(APP, event())).toBe('disabled');
  });
});

describe('写入', () => {
  beforeEach(() => setGroupContextSettingsResolver(() => ({ enabled: true, maxContextChars: 1000 })));

  it('excludes explicit runtime cards, then stores only the published body of the same card', () => {
    const card = (purpose: 'runtime' | 'turn-message') => JSON.stringify(markGroupContextCardPurpose({ schema: '2.0', body: { elements: [
      { tag: 'markdown', element_id: 'botmux_turn_status', content: '💭 **处理中 · 12.0s**' },
      { tag: 'markdown', content: 'PUBLISHED_ANSWER' },
      { tag: 'div', element_id: 'botmux_turn_process', elements: [
        { tag: 'markdown', content: 'PRIVATE_PROCESS' }, { tag: 'img', img_key: 'process_image' },
      ] },
      { tag: 'img', img_key: 'answer_image' },
    ] } }, purpose));
    expect(ingestGroupContextEvent(APP, event({ senderType: 'app', msgType: 'interactive', content: card('runtime') }))).toBe('skipped_noise');
    expect(getGroupContextMessage(APP, CHAT, 'om_1')).toBeUndefined();
    expect(ingestGroupContextEvent(APP, event({ senderType: 'app', msgType: 'interactive', content: card('turn-message') }))).toBe('stored');
    const row = getGroupContextMessage(APP, CHAT, 'om_1');
    expect(row).toMatchObject({ cardContentVersion: 1 });
    expect(row?.text).toContain('PUBLISHED_ANSWER');
    expect(row?.text).not.toMatch(/PRIVATE_PROCESS|处理中/);
    expect(row?.resourceRefs.map(ref => ref.key)).toEqual(['answer_image']);
  });

  it('does not fall back to raw JSON for an unresolved or intentionally empty projected card', () => {
    const unresolved = markGroupContextCardPurpose({ elements: [[{ tag: 'text', text: 'DO_NOT_STORE_PROCESS' }]] }, 'turn-message');
    expect(ingestGroupContextEvent(APP, event({ senderType: 'app', msgType: 'interactive', content: JSON.stringify(unresolved) }))).toBe('skipped_noise');
    const empty = markGroupContextCardPurpose({ schema: '2.0', body: { elements: [] } }, 'message');
    expect(ingestGroupContextEvent(APP, event({ senderType: 'app', msgType: 'interactive', content: JSON.stringify(empty) }))).toBe('skipped_noise');
    expect(listGroupContextMessages(APP, CHAT).messages).toHaveLength(0);
  });

  it('群聊文本：正文、发送者、时间、sourceAppId 全部落库', () => {
    expect(ingestGroupContextEvent(APP, event({ text: '明天去 First' }))).toBe('stored');
    const row = getGroupContextMessage(APP, CHAT, 'om_1');
    expect(row).toMatchObject({
      messageId: 'om_1', chatId: CHAT, senderId: 'ou_user_1', senderType: 'user',
      msgType: 'text', text: '明天去 First', createTime: 1700000000123, sourceAppId: APP, deleted: false,
    });
  });

  it('p2p 私聊跳过', () => {
    expect(ingestGroupContextEvent(APP, event({ chatType: 'p2p' }))).toBe('skipped_p2p');
    expect(listGroupContextMessages(APP, CHAT).messages).toHaveLength(0);
  });

  it('bot 发送者（sender_type app/bot）归一为 bot；只有 app_id 时用 app_id 作 senderId', () => {
    ingestGroupContextEvent(APP, event({ messageId: 'om_b1', senderType: 'app', openId: 'ou_bot_x' }));
    ingestGroupContextEvent(APP, event({ messageId: 'om_b2', senderType: 'bot', openId: undefined, appId: 'cli_bot_y' }));
    expect(getGroupContextMessage(APP, CHAT, 'om_b1')).toMatchObject({ senderType: 'bot', senderId: 'ou_bot_x' });
    expect(getGroupContextMessage(APP, CHAT, 'om_b2')).toMatchObject({ senderType: 'bot', senderId: 'cli_bot_y' });
  });

  it('未知 sender_type → unknown', () => {
    ingestGroupContextEvent(APP, event({ senderType: 'weird' }));
    expect(getGroupContextMessage(APP, CHAT, 'om_1')?.senderType).toBe('unknown');
  });

  it('message.update_time 有值才记 updateTime；没有不伪造', () => {
    ingestGroupContextEvent(APP, event({ messageId: 'om_u1' }));
    expect(getGroupContextMessage(APP, CHAT, 'om_u1')?.updateTime).toBeUndefined();
    const e = event({ messageId: 'om_u2', text: 'edited' });
    (e.message as any).update_time = '1700000000999';
    ingestGroupContextEvent(APP, e);
    expect(getGroupContextMessage(APP, CHAT, 'om_u2')?.updateTime).toBe(1700000000999);
  });

  it('带版本的乱序编辑：更旧的 update_time 不覆盖本地已有的新版本', () => {
    const newer = event({ messageId: 'om_e', text: 'v1' }); (newer.message as any).update_time = '200';
    const older = event({ messageId: 'om_e', text: 'v0' }); (older.message as any).update_time = '100';
    expect(ingestGroupContextEvent(APP, newer)).toBe('stored');
    expect(ingestGroupContextEvent(APP, older)).toBe('duplicate');
    expect(getGroupContextMessage(APP, CHAT, 'om_e')).toMatchObject({ text: 'v1', revision: 0 });
  });

  it('话题回复保留 rootId / threadId', () => {
    ingestGroupContextEvent(APP, event({ rootId: 'om_root', threadId: 'omt_1' }));
    expect(getGroupContextMessage(APP, CHAT, 'om_1')).toMatchObject({ rootId: 'om_root', threadId: 'omt_1' });
  });

  it('proves main-chat quote bubbles and native topic seeds from event metadata', () => {
    expect(normalizeGroupContextEvent(APP, event({ rootId: 'om_quoted' })))
      .toMatchObject({ conversationScope: 'main', rootId: 'om_quoted' });
    expect(normalizeGroupContextEvent(APP, event({ threadId: 'omt_topic' })))
      .toMatchObject({ conversationScope: 'thread', threadId: 'omt_topic' });
  });

  it('图片消息：正文为 [图片 N] 占位，附件只存引用', () => {
    ingestGroupContextEvent(APP, event({ msgType: 'image', content: JSON.stringify({ image_key: 'img_v3_abc' }) }));
    const row = getGroupContextMessage(APP, CHAT, 'om_1');
    expect(row?.msgType).toBe('image');
    expect(row?.text).toMatch(/图片/);
    expect(row?.resourceRefs).toEqual([{ type: 'image', key: 'img_v3_abc', name: expect.stringContaining('img_v3_abc') }]);
  });

  it('@ 提及：正文保留被 @ 者的名字占位，不丢上下文', () => {
    ingestGroupContextEvent(APP, event({
      content: JSON.stringify({ text: '@_user_1 看一下' }),
      mentions: [{ key: '@_user_1', name: 'Alex', id: { open_id: 'ou_alex' }, id_type: 'open_id' }],
    }));
    expect(getGroupContextMessage(APP, CHAT, 'om_1')?.text).toContain('Alex');
  });

  it('同一事件重复喂入（飞书重推）：duplicate，不分配新 seq', () => {
    expect(ingestGroupContextEvent(APP, event())).toBe('stored');
    expect(ingestGroupContextEvent(APP, event())).toBe('duplicate');
    expect(listGroupContextMessages(APP, CHAT).messages).toHaveLength(1);
  });

  it('同 messageId 正文变化（编辑事件）：stored，追加 revision', () => {
    ingestGroupContextEvent(APP, event({ text: 'v0' }));
    expect(ingestGroupContextEvent(APP, event({ text: 'v1' }))).toBe('stored');
    expect(getGroupContextMessage(APP, CHAT, 'om_1')).toMatchObject({ text: 'v1', revision: 1 });
  });

  it('缺 message / chat_id / message_id → skipped_invalid', () => {
    expect(ingestGroupContextEvent(APP, { sender: { sender_id: {}, sender_type: 'user' } } as any)).toBe('skipped_invalid');
    const e = event(); (e.message as any).chat_id = '';
    expect(ingestGroupContextEvent(APP, e)).toBe('skipped_invalid');
    const e2 = event(); (e2.message as any).message_id = undefined;
    expect(ingestGroupContextEvent(APP, e2)).toBe('skipped_invalid');
  });
});

describe('撤回', () => {
  beforeEach(() => setGroupContextSettingsResolver(() => ({ enabled: true, maxContextChars: 1000 })));

  it('已记录的消息被撤回 → tombstone revision', () => {
    ingestGroupContextEvent(APP, event({ text: 'oops' }));
    expect(ingestGroupContextRecall(APP, { chatId: CHAT, messageId: 'om_1', recallTime: '1700000005000' })).toBe('stored');
    expect(getGroupContextMessage(APP, CHAT, 'om_1')).toMatchObject({ deleted: true, text: 'oops', deletedAt: 1700000005000 });
  });

  it('关闭时撤回也不写', () => {
    setGroupContextSettingsResolver(() => ({ enabled: false, maxContextChars: 0 }));
    expect(ingestGroupContextRecall(APP, { chatId: CHAT, messageId: 'om_1' })).toBe('disabled');
  });
});

describe('错误隔离', () => {
  beforeEach(() => setGroupContextSettingsResolver(() => ({ enabled: true, maxContextChars: 1000 })));

  it('存储打不开（db 路径被普通文件占住）→ error，不抛出，告警一次后限流', () => {
    const dir = join(dataDir, 'group-context');
    mkdirSync(dir, { recursive: true });
    // 让目标 sqlite 路径成为一个目录，打开必然失败
    mkdirSync(groupContextDbPath(APP), { recursive: true });
    expect(ingestGroupContextEvent(APP, event({ messageId: 'om_x1' }))).toBe('error');
    expect(ingestGroupContextEvent(APP, event({ messageId: 'om_x2' }))).toBe('error');
    expect(ingestGroupContextEvent(APP, event({ messageId: 'om_x3' }))).toBe('error');
    expect(vi.mocked(logger.warn).mock.calls.length).toBe(1);
  });

  it('解析器异常（content 不是合法 JSON）仍记录：以原始 content 作兜底正文', () => {
    expect(ingestGroupContextEvent(APP, event({ msgType: 'text', content: 'not-json' }))).toBe('stored');
    expect(getGroupContextMessage(APP, CHAT, 'om_1')?.text).toBe('not-json');
  });
});
