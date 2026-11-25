/**
 * 真实 daemon 入口 → 队列落盘 → 回读 → /models 原 bot 分类一致（PR-3b-2 拆分A 五轮收口）。
 *
 * 用真实 buildCollabRoutingEvent（daemon 构造点）+ 真实 enqueueCollabChatItem 落盘 +
 * 真实 readCollabChatQueue 回读，断言持久化事件完整保留身份投影（senderType / teamTrustAppId /
 * 两个 bot 旗标 / mentions / 线程上下文 / 资源归属），再回读后重新 classifySlash 断言分类一致
 * （bot + acceptSlashFromBots=false → forward(bot_gated)，不是被误判成 human 的 daemon(sessionless)）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCollabRoutingEvent, type NormalizedCollabRoutingEvent } from '../src/core/collab-gate-admission.js';
import { enqueueCollabChatItem, readCollabChatQueue } from '../src/services/collab-chat-queue-store.js';
import { classifySlash } from '../src/core/command-router.js';

let dataDir: string;
const CHAT = 'oc_chat';
const TARGET = 'cli_target';

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'collab-gate-routing-event-')); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

describe('routingEvent 持久化身份投影（删身份字段变异须咬红）', () => {
  it('真实构造 → 落盘 → 回读 → 完整身份保留 → /models bot 分类一致', () => {
    // 平台 bot 输入
    const ev = buildCollabRoutingEvent({
      chatId: CHAT,
      messageId: 'om_src',
      senderType: 'app',
      senderOpenId: 'ou_bot',
      senderUnionId: 'on_bot',
      teamTrustAppId: 'cli_source_app',
      teamTrustUnionId: 'on_source',
      isBotSenderType: true,
      isForeignBotSender: true,
      chatType: 'group',
      scope: 'chat',
      anchor: 'om_anchor',
      replyRootId: 'om_root',
      threadId: 'omt_thread',
      parentId: 'om_parent',
      content: '/models',
      mentions: [{ key: '@_user_1', name: 'Someone', openId: 'ou_mentioned', appId: 'cli_mentioned_app' }],
      resources: [{ type: 'file', key: 'file:abc', name: 'doc.pdf', messageId: 'om_owner', fallbackMessageIds: ['om_fb1'] }],
    });

    // 落盘
    const added = enqueueCollabChatItem(dataDir, CHAT, {
      sourceMessageId: ev.messageId,
      targetAppId: TARGET,
      routingEvent: ev,
      deliveryStatus: 'pending',
      enqueuedAt: 1,
    });
    expect(added).toBe(true);

    // 回读
    const q = readCollabChatQueue(dataDir, CHAT, TARGET);
    expect(q.items).toHaveLength(1);
    const readBack = q.items[0].routingEvent as NormalizedCollabRoutingEvent;

    // 完整身份投影
    expect(readBack.senderType).toBe('app');
    expect(readBack.teamTrustAppId).toBe('cli_source_app');
    expect(readBack.isBotSenderType).toBe(true);
    expect(readBack.isForeignBotSender).toBe(true);
    expect(readBack.replyRootId).toBe('om_root');
    expect(readBack.threadId).toBe('omt_thread');
    expect(readBack.parentId).toBe('om_parent');
    expect(readBack.mentions?.[0].openId).toBe('ou_mentioned');
    expect(readBack.mentions?.[0].appId).toBe('cli_mentioned_app');
    expect(readBack.resources[0].key).toBe('file:abc');
    expect(readBack.resources[0].messageId).toBe('om_owner');
    expect(readBack.resources[0].fallbackMessageIds).toEqual(['om_fb1']);

    // 回读后重新 classifySlash：bot 身份 → forward(bot_gated)，不是 human 的 daemon(sessionless)
    const d = classifySlash({
      cliId: 'claude-code',
      text: readBack.content,
      context: 'thread',
      phase: 'running',
      passthrough: new Set<string>(),
      coldStartPassthrough: new Set<string>(),
      senderIsBot: readBack.isBotSenderType === true || readBack.isForeignBotSender === true,
      acceptSlashFromBots: false,
    });
    expect(d.kind).toBe('forward');
    if (d.kind === 'forward') expect(d.reason).toBe('bot_gated');
  });
});
