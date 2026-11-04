/**
 * #2062 复审 F2（P2，带 DoS 性质）回归：一次非 operator 点击永久楔死会话控制分区
 *
 * 毒消息链（四环缺一不可）：
 *   ① activateBeforeAck 对 toggle_display **无条件 return true**（鉴权被推给执行期）；
 *   ② 执行期 handleCardAction 的敏感动作门对非 operator **静默 return undefined**
 *      （SENSITIVE_CARD_ACTIONS 里 toggle_display 是 NO_META ⇒ 无 toast）；
 *   ③ execute 因此**确定性**返回 not_applied，consumer 每 5s 重投，且这条 lane 没有
 *      attempts 上限（对比 durable-inbox-primary-consumer 的 maxAttempts=16）；
 *   ④ 同 partition 严格 FIFO（claimNextInbox 的 `NOT EXISTS ... earlier.state != 'completed'`）。
 *
 * 净效果：primary 部署里**任何能看到该卡片的群成员**，点一次「显示/隐藏输出」就能让
 * 该会话的 close / resume / toggle 全部永远 claim 不到。
 *
 * 期望修法（两条都要，不是二选一）：
 *   主修 ②③：handler 拒绝要落**终态**（ignored，或 status=active + applied:false 的 complete），
 *             not_applied 只留给「下一次确实可能成功」的情形；
 *   纵深 ① ：authorizeBeforeAck 对 toggle_display 也走 canOperate（与卡片门的 NO_META 对齐），
 *             **但不能只做这条** —— canOperate 之后仍有静默 return（卡片过期、principal-lane
 *             拒绝、visibility:private 等），楔死会以新姿势回来。
 *   兜底   ：这条 lane 也加 attempts 上限。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';
import type { InboxClaim } from '../src/services/durable-coordination.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import { createDurableSessionControlDispatch } from '../src/services/durable-session-control-dispatch.js';
import { createDurableSessionFacade } from '../src/services/durable-session-facade.js';
import {
  DURABLE_INBOX_LANE_SESSION_CONTROL,
} from '../src/services/durable-coordination.js';
import {
  durableLarkSessionControlEvent,
  durableLarkSessionControlEventId,
  durableLarkSessionControlPartition,
  parseDurableLarkSessionControlClaim,
} from '../src/services/durable-lark-session-control.js';
import { createDurableLarkSessionControlRuntime } from '../src/services/durable-lark-session-control-runtime.js';
import { admitDurableLarkSession } from '../src/services/durable-session-primary.js';
import type { DurableLarkMessageClaim } from '../src/services/durable-inbox-shadow.js';

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

function controlEvent(input: {
  eventId: string;
  operatorOpenId: string;
  value: Record<string, unknown>;
}) {
  return durableLarkSessionControlEvent({
    larkAppId: 'cli_test',
    eventId: durableLarkSessionControlEventId('cli_test', input.eventId),
    partitionKey: PARTITION,
    data: {
      event_id: input.eventId,
      action: { value: { session_id: 'session-1', root_id: 'om_root', ...input.value } },
      operator: { open_id: input.operatorOpenId },
      context: { open_message_id: 'om_card' },
    },
    now: 1,
  });
}

/** 生产形状的 runtime：非 operator 的 toggle 会执行期静默返回 undefined。 */
function makeRuntime(
  store: SqliteDurableCoordinationStore,
  facade: ReturnType<typeof createDurableSessionFacade>,
  active: DaemonSession,
  persisted: Session,
  onPresentationControl: () => void,
) {
  return createDurableLarkSessionControlRuntime({
    larkAppId: 'cli_test',
    privateCard: false,
    store,
    facade: () => facade,
    listActiveSessions: () => [active],
    findActiveSession: id => (id === 'session-1' ? active : undefined),
    listPersistedSessions: () => [persisted],
    getPersistedSession: id => (id === 'session-1' ? persisted : undefined),
    materializeClosedSession: value => value,
    // 只有 owner 能操作 —— 与 card-handler 的 SENSITIVE_CARD_ACTIONS 门一致
    canOperate: (_chatId, operatorOpenId) => operatorOpenId === 'ou_owner',
    // close 必须真的把本地 Session 翻成 closed，否则 commit 的
    // 「local Session state does not match」自检会一直不过（那会掩盖 F2）。
    closeSession: async () => { persisted.status = 'closed'; return { ok: true, outcome: 'closed' }; },
    resumeSession: async () => ({ ok: false, error: 'not_closed' }),
    // card-handler 对非 operator 的敏感动作 `return undefined`（无 toast、无卡片）
    handlePresentationControl: async () => { onPresentationControl(); return undefined; },
    buildClosedCard: () => '{"closed":true}',
    buildActiveCard: () => '{"active":true}',
    closeResidualText: () => 'residual',
    closeRefusedText: () => 'refused',
    resumeRefusedText: () => 'resume-refused',
  } as any);
}

/** 跑真实 consumer 语义：claim → dispatch → (settled | retry 5s)，并记录每个 operation 的终态。 */
async function drain(
  store: SqliteDurableCoordinationStore,
  dispatch: ReturnType<typeof createDurableSessionControlDispatch>,
  now: () => number,
  advance: (ms: number) => void,
  rounds: number,
) {
  const trace: string[] = [];
  const lastState = new Map<string, string | undefined>();
  for (let round = 0; round < rounds; round += 1) {
    const claim: InboxClaim | undefined = await store.claimNextInbox({
      workerId: `w${round}`,
      lane: DURABLE_INBOX_LANE_SESSION_CONTROL,
      partitionKeys: [PARTITION],
      leaseDurationMs: 600_000,
    });
    if (!claim) { trace.push(`${round}:idle`); break; }
    const control = parseDurableLarkSessionControlClaim(claim);
    const which = control.operationId.includes('evt_display') ? 'display' : 'close';
    try {
      await dispatch(control, { claim, signal: new AbortController().signal });
      await store.completeInboxClaim(claim);
      trace.push(`${round}:${which}:settled`);
    } catch {
      await store.retryInboxClaim({ claim, visibleAt: now() + 5_000 });
      advance(5_000);
      const op = await store.readControlOperation(control.operationId);
      trace.push(`${round}:${which}:retry(state=${op?.state},attempts=${op?.attempts})`);
    }
    lastState.set(which, (await store.readControlOperation(control.operationId))?.state);
  }
  return { trace, lastState };
}

describe('F2 — 非 operator 的一次点击不能楔死会话控制分区', () => {
  it('纵深防线：ACK 前授权就对非 operator 的 toggle_display 说 no', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-2062-f2-auth-'));
    tempDirs.push(dir);
    const now = 1_000;
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => now });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const persisted = sessionRecord();
    const active = {
      session: persisted, larkAppId: 'cli_test', chatId: 'oc_chat',
      streamCardId: 'om_card', displayMode: 'hidden',
    } as unknown as DaemonSession;
    await admitDurableLarkSession({ facade, message: admission(), session: persisted });
    const runtime = makeRuntime(store, facade, active, persisted, () => undefined);

    const payload = (operatorOpenId: string) => ({
      event_id: 'evt_display',
      action: { value: {
        action: 'toggle_display',
        target_display_mode: 'screenshot',
        session_id: 'session-1',
        root_id: 'om_root',
      } },
      operator: { open_id: operatorOpenId },
      context: { open_message_id: 'om_card' },
    });

    // 断的是「能不能进 durable 通道」，不挑修法：返回 false 或直接抛错都接受。
    const outsiderAuthorized = await runtime.authorizeBeforeAck(payload('ou_member')).catch(() => false);
    expect(outsiderAuthorized).toBe(false);
    // owner 必须仍然被放行（别把整条按钮按死）。
    expect(await runtime.authorizeBeforeAck(payload('ou_owner'))).toBe(true);

    await facade.stop();
    await store.close();
  });

  it('主修：毒点击必须落终态，后续 operator 的 close 必须能被 claim 并执行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-2062-f2-'));
    tempDirs.push(dir);
    let now = 1_000;
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => now });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const persisted = sessionRecord();
    const active = {
      session: persisted,
      larkAppId: 'cli_test',
      chatId: 'oc_chat',
      streamCardId: 'om_card',
      displayMode: 'hidden',
    } as unknown as DaemonSession;
    await admitDurableLarkSession({ facade, message: admission(), session: persisted });

    let presentationCalls = 0;
    const runtime = makeRuntime(store, facade, active, persisted, () => { presentationCalls += 1; });

    // 直接入队，绕开 ACK 授权：本用例要证明的是「即便毒消息进了 lane，
    // 也必须落终态把分区让出来」——与上一条用例互补，缺一不可。
    await store.enqueueInbox(controlEvent({
      eventId: 'evt_display',
      operatorOpenId: 'ou_member',
      value: { action: 'toggle_display', target_display_mode: 'screenshot' },
    }));
    await store.enqueueInbox(controlEvent({
      eventId: 'evt_close',
      operatorOpenId: 'ou_owner',
      value: { action: 'close' },
    }));

    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });
    const { trace, lastState } = await drain(store, dispatch, () => now, ms => { now += ms; }, 6);

    // 毒消息的展示动作最多被真实执行一次（不允许每 5s 反复打进 card-handler）
    expect(presentationCalls).toBeLessThanOrEqual(1);
    // 毒消息必须落终态，把分区让出来（不许一直 pending）
    expect(lastState.get('display')).toBe('completed');
    // 后续 operator 的 close 必须真的跑到（不许被 FIFO 饿死）
    expect(trace.some(entry => entry.includes('close:settled'))).toBe(true);

    await facade.stop();
    await store.close();
  });
});

