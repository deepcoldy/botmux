/**
 * 队列重放 + 目标重启对账（PR-3b-2 收口，§8.3）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  enqueueCollabChatItem,
  markCollabChatItemDelivered,
  listPendingCollabChatItems,
  reconcileCollabChatQueue,
} from '../src/services/collab-chat-queue-store.js';

let dataDir: string;
const CHAT = 'oc_chat';
const TARGET = 'cli_target';

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'collab-queue-replay-')); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

describe('队列重放 + 重启对账', () => {
  it('按 sourceMessageId/enqueuedAt 顺序重放 pending，不包含 delivered', () => {
    enqueueCollabChatItem(dataDir, CHAT, { sourceMessageId: 'om_2', targetAppId: TARGET, routingEvent: { t: 'two' }, deliveryStatus: 'pending', enqueuedAt: 2 });
    enqueueCollabChatItem(dataDir, CHAT, { sourceMessageId: 'om_1', targetAppId: TARGET, routingEvent: { t: 'one' }, deliveryStatus: 'pending', enqueuedAt: 1 });
    enqueueCollabChatItem(dataDir, CHAT, { sourceMessageId: 'om_3', targetAppId: TARGET, routingEvent: { t: 'three' }, deliveryStatus: 'pending', enqueuedAt: 3 });
    markCollabChatItemDelivered(dataDir, CHAT, TARGET, 'om_1', 'delivered');

    const pending = listPendingCollabChatItems(dataDir, CHAT, TARGET);
    expect(pending.map(i => i.sourceMessageId)).toEqual(['om_2', 'om_3']); // om_1 delivered 不在
    // 按 enqueuedAt 排序
    expect(pending[0].enqueuedAt).toBeLessThan(pending[1].enqueuedAt);
  });

  it('reconcile：gate open → 重放 pending；closed → 空（保持原队列）', () => {
    enqueueCollabChatItem(dataDir, CHAT, { sourceMessageId: 'om_1', targetAppId: TARGET, routingEvent: { t: 'one' }, deliveryStatus: 'pending', enqueuedAt: 1 });
    // gate open
    expect(reconcileCollabChatQueue({ dataDir, chatId: CHAT, targetAppId: TARGET, gateOpen: true })).toHaveLength(1);
    // gate closed → 不重放（保持原队列不变）
    expect(reconcileCollabChatQueue({ dataDir, chatId: CHAT, targetAppId: TARGET, gateOpen: false })).toHaveLength(0);
    // 原队列仍在
    expect(listPendingCollabChatItems(dataDir, CHAT, TARGET)).toHaveLength(1);
  });
});
