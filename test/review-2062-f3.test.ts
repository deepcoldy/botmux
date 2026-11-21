/**
 * #2062 复审 F3（=初审 P2-1）回归：生产形状下，一次成功点击不该被判成 not_applied
 *
 * 生产路径（card-handler.ts 的「当前卡」分支）：displayMode 已切到目标值、卡片更新
 * 交给本地 patch 队列（scheduleCardPatch）⇒ 回调只返回 `{ toast }`，**没有 cardJson**。
 * 而 durability 层的 `presentationCardJson({toast})` 明确返回 undefined，于是 execute
 * 判 `not_applied`、5s 后靠 observed() 才收敛：
 *
 *   t+0     not_applied        ← 白等一轮
 *   t+5000  settled
 *
 * 连点 N 次 ≈ N × 5s（同 partition 严格 FIFO，前序不 completed 后序不能 claim）。
 * 另外每次点击都同时产生「本地 patch 队列」+「durable outbox 更新同一张卡」两条通道
 * 写同一张卡 —— 修好后 execute 完成时不带 cardJson，commit 自然不再发
 * `control_update_*`，双通道与延迟一起消失。
 *
 * 修法：cardJson 缺失但 `active.displayMode === target` 时用 buildActiveCard(current)
 * 判 completed。
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';
import type { InboxClaim } from '../src/services/durable-coordination.js';
import type { DurableLarkMessageClaim } from '../src/services/durable-inbox-shadow.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import { createDurableSessionControlDispatch } from '../src/services/durable-session-control-dispatch.js';
import { createDurableSessionFacade } from '../src/services/durable-session-facade.js';
import {
  durableLarkSessionControlEvent,
  durableLarkSessionControlEventId,
  durableLarkSessionControlPartition,
  parseDurableLarkSessionControlClaim,
} from '../src/services/durable-lark-session-control.js';
import {
  createDurableLarkSessionControlRuntime,
} from '../src/services/durable-lark-session-control-runtime.js';
import { admitDurableLarkSession } from '../src/services/durable-session-primary.js';

const tempDirs: string[] = [];
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const PARTITION = durableLarkSessionControlPartition('cli_test', 'session-1');

function sessionRecord(): Session {
  return {
    sessionId: 'session-1',
    chatId: 'oc_chat',
    chatType: 'group',
    rootMessageId: 'om_root',
    scope: 'thread',
    title: 'Control Session',
    status: 'active',
    createdAt: '2026-10-09T00:00:00.000Z',
    larkAppId: 'cli_test',
    ownerOpenId: 'ou_owner',
    streamCardId: 'om_card',
  } as unknown as Session;
}

function admission(): DurableLarkMessageClaim {
  return {
    eventType: 'lark.im.message.receive_v1',
    eventId: 'im.message.receive_v1:cli_test:om_turn',
    partitionKey: 'lark-message-routing:cli_test:oc_chat',
    larkAppId: 'cli_test',
    messageId: 'om_turn',
    attempts: 1,
    data: { message: { message_id: 'om_turn' } },
  } as unknown as DurableLarkMessageClaim;
}

async function setup(displayMode: 'hidden' | 'screenshot') {
  const dir = mkdtempSync(join(tmpdir(), 'review-2062-f3-'));
  tempDirs.push(dir);
  let now = 1_000;
  const startedAt = now;
  const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => now });
  const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
  const persisted = sessionRecord();
  const active = {
    session: persisted,
    larkAppId: 'cli_test',
    chatId: 'oc_chat',
    streamCardId: 'om_card',
    displayMode,
  } as unknown as DaemonSession;
  await admitDurableLarkSession({ facade, message: admission(), session: persisted });
  let presentationCalls = 0;
  const runtime = createDurableLarkSessionControlRuntime({
    larkAppId: 'cli_test',
    privateCard: false,
    store,
    facade: () => facade,
    listActiveSessions: () => [active],
    findActiveSession: id => (id === 'session-1' ? active : undefined),
    listPersistedSessions: () => [persisted],
    getPersistedSession: id => (id === 'session-1' ? persisted : undefined),
    materializeClosedSession: value => value,
    canOperate: () => true,
    closeSession: async () => ({ ok: false, error: 'not_used' }),
    resumeSession: async () => ({ ok: false, error: 'not_used' }),
    // 生产形状：模式已切好、卡片交给本地 patch 队列 ⇒ 只有 toast，没有 cardJson。
    handlePresentationControl: async (data: any) => {
      presentationCalls += 1;
      active.displayMode = data?.action?.value?.target_display_mode;
      return { toast: { type: 'info', content: '已收到' } };
    },
    buildClosedCard: () => '{"closed":true}',
    buildActiveCard: current => JSON.stringify({ mode: current.displayMode }),
    closeResidualText: () => 'residual',
    closeRefusedText: () => 'refused',
    resumeRefusedText: () => 'resume-refused',
  } as any);
  return {
    store, facade, active,
    now: () => now,
    advance: (ms: number) => { now += ms; },
    elapsed: () => now - startedAt,
    presentationCalls: () => presentationCalls,
    runtime,
  };
}

function displayEvent(suffix: string, target: 'hidden' | 'screenshot') {
  return durableLarkSessionControlEvent({
    larkAppId: 'cli_test',
    eventId: durableLarkSessionControlEventId('cli_test', `evt_display_${suffix}`),
    partitionKey: PARTITION,
    data: {
      event_id: `evt_display_${suffix}`,
      action: { value: {
        action: 'toggle_display',
        target_display_mode: target,
        session_id: 'session-1',
        root_id: 'om_root',
      } },
      operator: { open_id: 'ou_owner' },
      context: { open_message_id: 'om_card' },
    },
    now: 1,
  });
}

/** 单轮真实 consumer 语义，返回「是否 settled」与消耗的重试次数。 */
async function round(
  harness: Awaited<ReturnType<typeof setup>>,
  dispatch: ReturnType<typeof createDurableSessionControlDispatch>,
  workerId: string,
) {
  const claim: InboxClaim | undefined = await harness.store.claimNextInbox({
    workerId,
    lane: 'session-control',
    partitionKeys: [PARTITION],
    leaseDurationMs: 600_000,
  });
  if (!claim) return { settled: true, claim: undefined as InboxClaim | undefined, operationId: '' };
  const control = parseDurableLarkSessionControlClaim(claim);
  try {
    await dispatch(control, { claim, signal: new AbortController().signal });
    await harness.store.completeInboxClaim(claim);
    return { settled: true, claim, operationId: control.operationId };
  } catch {
    await harness.store.retryInboxClaim({ claim, visibleAt: harness.now() + 5_000 });
    harness.advance(5_000);
    return { settled: false, claim, operationId: control.operationId };
  }
}

describe('F3 — 生产 { toast } 形状的一次点击必须一次收敛', () => {
  it('单次点击立即 settle，且不再产生 control_update_* 双通道写卡', async () => {
    const harness = await setup('hidden');
    const event = displayEvent('a', 'screenshot');
    await harness.store.enqueueInbox(event);
    const dispatch = createDurableSessionControlDispatch({
      store: harness.store,
      sessionOwnerId: harness.facade.ownerId,
      resolve: harness.runtime.resolve,
    });

    const first = await round(harness, dispatch, 'w0');
    expect(first.settled).toBe(true);
    // 没有白等的重试轮
    expect(harness.elapsed()).toBe(0);
    // 展示动作只执行一次
    expect(harness.presentationCalls()).toBe(1);
    // 模式确实到了目标值
    expect(harness.active.displayMode).toBe('screenshot');

    const operationId = parseDurableLarkSessionControlClaim(first.claim!).operationId;
    const digest = createHash('sha256').update(operationId, 'utf8').digest('hex');
    // 卡片更新只走本地 patch 队列：durable outbox 不许再写同一张卡
    await expect(harness.store.readOutbox(`control_update_${digest}`)).resolves.toBeUndefined();

    await harness.facade.stop();
    await harness.store.close();
  });

  it('连点两次（hide→show）各自一次收敛，总延迟为 0 而不是 N×5s', async () => {
    const harness = await setup('screenshot');
    await harness.store.enqueueInbox(displayEvent('a', 'hidden'));
    await harness.store.enqueueInbox(displayEvent('b', 'screenshot'));
    const dispatch = createDurableSessionControlDispatch({
      store: harness.store,
      sessionOwnerId: harness.facade.ownerId,
      resolve: harness.runtime.resolve,
    });

    const first = await round(harness, dispatch, 'w0');
    expect(first.settled).toBe(true);
    const second = await round(harness, dispatch, 'w1');
    expect(second.settled).toBe(true);

    expect(harness.elapsed()).toBe(0);
    expect(harness.presentationCalls()).toBe(2);
    expect(harness.active.displayMode).toBe('screenshot');

    await harness.facade.stop();
    await harness.store.close();
  });
});

