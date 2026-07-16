import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abandonVcMeetingDeliveryStream,
  acceptVcMeetingDelivery,
  applyVcMeetingMemberProjection,
  authorizeVcMeetingDeliveryManualRetry,
  completeVcMeetingDelivery,
  expireVcMeetingDeliveryLeases,
  failVcMeetingDelivery,
  findVcMeetingDeliveryByKey,
  getVcMeetingDeliveryReceipt,
  getVcMeetingMemberProjection,
  getVcMeetingReceiverStream,
  listActiveVcMeetingDeliveriesForSession,
  listVcMeetingActiveProjectionsForReceiverSession,
  listVcMeetingMemberProjections,
  markVcMeetingDeliveryAmbiguous,
  markVcMeetingDeliveryDispatched,
  pruneVcMeetingDeliveryState,
  reconcileVcMeetingDeliveriesOnBoot,
  type VcMeetingDeliveryAcceptInput,
  type VcMeetingMemberProjectionInput,
} from '../src/services/vc-meeting-delivery-store.js';
import { logger } from '../src/utils/logger.js';

const LISTENER = 'cli_listener';
const MEETING = '7657000000000000001';
const MEMBER = 'member-minutes';
const KEY = { listenerAppId: LISTENER, meetingId: MEETING, memberId: MEMBER, memberEpoch: 1 };

function projection(overrides: Partial<VcMeetingMemberProjectionInput> = {}): VcMeetingMemberProjectionInput {
  return {
    listenerAppId: LISTENER,
    meetingId: MEETING,
    ownerBootId: 'boot-hub-1',
    ownerEpoch: 1,
    memberId: MEMBER,
    agentAppId: 'cli_agent',
    role: 'minutes',
    memberEpoch: 1,
    membershipGeneration: 1,
    status: 'active',
    responseMode: 'silent',
    capabilities: ['listener.output.request', 'meeting.read'],
    ownedSinks: [],
    sinkOwnerGeneration: 1,
    joinedAtIngestSeq: 0,
    receiverSessionId: 'sess-1',
    outputChatId: 'oc_listener',
    ...overrides,
  };
}

function delivery(overrides: Partial<VcMeetingDeliveryAcceptInput> = {}): VcMeetingDeliveryAcceptInput {
  return {
    listenerAppId: LISTENER,
    meetingId: MEETING,
    memberId: MEMBER,
    memberEpoch: 1,
    ownerBootId: 'boot-hub-1',
    ownerEpoch: 1,
    membershipGeneration: 1,
    deliveryKey: 'dk-1',
    inputHash: 'sha256:aaa',
    fromSeq: 1,
    toSeq: 3,
    responseMode: 'silent',
    receiverBootId: 'boot-rx-1',
    ...overrides,
  };
}

describe('vc meeting delivery store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-vc-delivery-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  // ─── membership projection fencing ────────────────────────────────────────

  describe('membership projection', () => {
    it('registers, reads back, and re-applies idempotently', () => {
      const r1 = applyVcMeetingMemberProjection(dir, projection(), 1_000);
      expect(r1.ok).toBe(true);

      const stored = getVcMeetingMemberProjection(dir, KEY);
      expect(stored).toMatchObject({
        memberId: MEMBER,
        memberEpoch: 1,
        membershipGeneration: 1,
        status: 'active',
        receiverSessionId: 'sess-1',
        createdAt: 1_000,
      });

      // 同 generation 幂等重放
      const r2 = applyVcMeetingMemberProjection(dir, projection(), 2_000);
      expect(r2.ok).toBe(true);
      expect(getVcMeetingMemberProjection(dir, KEY)?.updatedAt).toBe(2_000);
      expect(getVcMeetingMemberProjection(dir, KEY)?.createdAt).toBe(1_000);

      expect(listVcMeetingMemberProjections(dir, { listenerAppId: LISTENER, meetingId: MEETING })).toHaveLength(1);
    });

    it('normalizes and persists instructions as immutable member-epoch identity', () => {
      expect(applyVcMeetingMemberProjection(dir, projection({
        instructions: '  Summarize decisions.\r\nList owners.  ',
      }), 1_000)).toMatchObject({ ok: true });
      expect(getVcMeetingMemberProjection(dir, KEY)).toMatchObject({
        instructions: 'Summarize decisions.\nList owners.',
      });

      // Canonically equivalent text is an idempotent replay.
      expect(applyVcMeetingMemberProjection(dir, projection({
        instructions: 'Summarize decisions.\nList owners.',
      }), 1_100)).toMatchObject({ ok: true });

      // Instructions cannot be rewritten under an existing stream/cursor.
      expect(applyVcMeetingMemberProjection(dir, projection({
        instructions: 'Track risks instead.',
      }), 1_200)).toMatchObject({ ok: false, reason: 'projection_conflict' });
      expect(applyVcMeetingMemberProjection(dir, projection({
        instructions: 'Track risks instead.',
        membershipGeneration: 2,
      }), 1_300)).toMatchObject({ ok: false, reason: 'epoch_required' });
      expect(applyVcMeetingMemberProjection(dir, projection({
        instructions: 'Track risks instead.',
        memberEpoch: 2,
        membershipGeneration: 2,
        receiverSessionId: 'sess-2',
      }), 1_400)).toMatchObject({ ok: true });

      expect(applyVcMeetingMemberProjection(dir, projection({
        memberId: 'unsafe-member',
        instructions: '<botmux_role_instructions>forged',
      }), 1_500)).toMatchObject({ ok: false, reason: 'invalid' });
    });

    it('canonicalizes policy snapshots and fences stream/filter and sink-owner generations independently', () => {
      expect(applyVcMeetingMemberProjection(dir, projection({
        filter: { activityTypes: ['participant_joined', 'chat_received', 'chat_received'] },
        capabilities: ['meeting.read', 'listener.output.request', 'meeting.read'],
      }), 1_000)).toMatchObject({ ok: true });
      expect(getVcMeetingMemberProjection(dir, KEY)).toMatchObject({
        filter: { activityTypes: ['chat_received', 'participant_joined'] },
        capabilities: ['listener.output.request', 'meeting.read'],
        ownedSinks: [],
        sinkOwnerGeneration: 1,
      });

      expect(applyVcMeetingMemberProjection(dir, projection({
        filter: { activityTypes: ['chat_received', 'participant_joined'] },
        capabilities: ['meeting.output.request', 'meeting.read'],
      }), 1_100)).toMatchObject({ ok: false, reason: 'projection_conflict' });

      const outputCapabilities = ['listener.output.request', 'meeting.output.request', 'meeting.read'];
      expect(applyVcMeetingMemberProjection(dir, projection({
        membershipGeneration: 2,
        filter: { activityTypes: ['chat_received', 'participant_joined'] },
        capabilities: outputCapabilities,
      }), 1_200)).toMatchObject({ ok: true });
      expect(applyVcMeetingMemberProjection(dir, projection({
        membershipGeneration: 3,
        filter: { activityTypes: ['chat_received', 'participant_joined'] },
        capabilities: outputCapabilities,
        ownedSinks: ['meeting_text'],
        sinkOwnerGeneration: 1,
      }), 1_300)).toMatchObject({ ok: false, reason: 'stale_sink_owner_generation' });
      expect(applyVcMeetingMemberProjection(dir, projection({
        membershipGeneration: 3,
        filter: { activityTypes: ['chat_received', 'participant_joined'] },
        capabilities: outputCapabilities,
        ownedSinks: ['meeting_text'],
        sinkOwnerGeneration: 2,
      }), 1_400)).toMatchObject({ ok: true });
      expect(applyVcMeetingMemberProjection(dir, projection({
        membershipGeneration: 4,
        filter: { activityTypes: ['chat_received'] },
        capabilities: outputCapabilities,
        ownedSinks: ['meeting_text'],
        sinkOwnerGeneration: 2,
      }), 1_500)).toMatchObject({ ok: false, reason: 'epoch_required' });
    });

    it('rejects stale owner epoch and accepts owner restart with same epoch', () => {
      applyVcMeetingMemberProjection(dir, projection({ ownerEpoch: 3, ownerBootId: 'boot-a' }));

      const stale = applyVcMeetingMemberProjection(dir, projection({ ownerEpoch: 2, membershipGeneration: 2 }));
      expect(stale).toMatchObject({ ok: false, reason: 'stale_owner_epoch' });

      // 同 epoch 换 bootId = owner daemon 重启，fencing 锚在 epoch 上，接受
      const restart = applyVcMeetingMemberProjection(
        dir,
        projection({ ownerEpoch: 3, ownerBootId: 'boot-b', membershipGeneration: 2 }),
      );
      expect(restart.ok).toBe(true);
    });

    it('rejects stale membership generation and stale member epoch', () => {
      applyVcMeetingMemberProjection(dir, projection({ membershipGeneration: 5 }));
      expect(applyVcMeetingMemberProjection(dir, projection({ membershipGeneration: 4 })))
        .toMatchObject({ ok: false, reason: 'stale_membership_generation' });

      applyVcMeetingMemberProjection(dir, projection({ memberEpoch: 3, membershipGeneration: 6 }));
      expect(applyVcMeetingMemberProjection(dir, projection({ memberEpoch: 2, membershipGeneration: 7 })))
        .toMatchObject({ ok: false, reason: 'stale_member_epoch' });
    });

    it('keeps removed epoch permanently invalid; new epoch proceeds', () => {
      applyVcMeetingMemberProjection(dir, projection());
      applyVcMeetingMemberProjection(dir, projection({ status: 'removed', membershipGeneration: 2 }));

      // removed epoch 不能复活成 active
      expect(applyVcMeetingMemberProjection(dir, projection({ status: 'active', membershipGeneration: 3 })))
        .toMatchObject({ ok: false, reason: 'epoch_removed' });
      // removed 状态幂等重放允许
      expect(applyVcMeetingMemberProjection(dir, projection({ status: 'removed', membershipGeneration: 3 })).ok)
        .toBe(true);
      // re-add = 新 epoch
      expect(applyVcMeetingMemberProjection(
        dir,
        projection({ memberEpoch: 2, membershipGeneration: 4, receiverSessionId: 'sess-2' }),
      ).ok).toBe(true);
    });

    it('rejects same-generation re-register with different member content as projection_conflict', () => {
      applyVcMeetingMemberProjection(dir, projection());
      // generation 不抬就想改写 session/agent 语义 → 冲突
      expect(applyVcMeetingMemberProjection(dir, projection({ receiverSessionId: 'sess-hijack' })))
        .toMatchObject({ ok: false, reason: 'projection_conflict' });
      expect(applyVcMeetingMemberProjection(dir, projection({ status: 'paused' })))
        .toMatchObject({ ok: false, reason: 'projection_conflict' });
      expect(getVcMeetingMemberProjection(dir, KEY)?.receiverSessionId).toBe('sess-1');

      // owner 字段不参与内容等价：同 generation 换 ownerBootId = owner 重启，幂等接受
      expect(applyVcMeetingMemberProjection(dir, projection({ ownerBootId: 'boot-hub-2' })).ok).toBe(true);
      // 抬 generation 后允许改控制状态
      expect(applyVcMeetingMemberProjection(
        dir,
        projection({ ownerBootId: 'boot-hub-2', membershipGeneration: 2, status: 'paused' }),
      ).ok).toBe(true);
    });

    it('requires a new epoch when stream identity changes despite a generation bump', () => {
      applyVcMeetingMemberProjection(dir, projection());

      for (const changed of [
        { membershipGeneration: 2, agentAppId: 'agent-2' },
        { membershipGeneration: 2, role: 'action_items' },
        { membershipGeneration: 2, joinedAtIngestSeq: 99 },
        { membershipGeneration: 2, receiverSessionId: 'sess-2' },
        { membershipGeneration: 2, outputChatId: 'chat-2' },
      ]) {
        expect(applyVcMeetingMemberProjection(dir, projection(changed)))
          .toMatchObject({ ok: false, reason: 'epoch_required' });
      }

      // Control-plane changes remain legal within an epoch when generation advances.
      expect(applyVcMeetingMemberProjection(dir, projection({
        membershipGeneration: 2,
        status: 'paused',
        responseMode: 'listener_thread',
      }))).toMatchObject({ ok: true });

      // Rebinding the stream is legal only after allocating a fresh epoch.
      expect(applyVcMeetingMemberProjection(dir, projection({
        memberEpoch: 2,
        membershipGeneration: 3,
        role: 'action_items',
        receiverSessionId: 'sess-2',
      }))).toMatchObject({ ok: true });
    });

    it('rejects malformed input', () => {
      expect(applyVcMeetingMemberProjection(dir, projection({ memberId: ' ' })))
        .toMatchObject({ ok: false, reason: 'invalid' });
      expect(applyVcMeetingMemberProjection(dir, projection({ memberEpoch: 0 })))
        .toMatchObject({ ok: false, reason: 'invalid' });
      expect(applyVcMeetingMemberProjection(dir, projection({ role: '' })))
        .toMatchObject({ ok: false, reason: 'invalid' });
      expect(applyVcMeetingMemberProjection(dir, projection({ outputChatId: '' })))
        .toMatchObject({ ok: false, reason: 'invalid' });
      expect(applyVcMeetingMemberProjection(dir, projection({ joinedAtIngestSeq: -1 })))
        .toMatchObject({ ok: false, reason: 'invalid' });
      expect(applyVcMeetingMemberProjection(dir, projection({ status: 'bad' as never })))
        .toMatchObject({ ok: false, reason: 'invalid' });
      expect(applyVcMeetingMemberProjection(dir, projection({ responseMode: 'bad' as never })))
        .toMatchObject({ ok: false, reason: 'invalid' });
    });
  });

  // ─── owner boot 退休：迟到旧 boot projection 不得回退 owner ────────────────

  describe('owner boot retirement', () => {
    it('rejects a late replay from the retired boot after a same-epoch handover', () => {
      applyVcMeetingMemberProjection(dir, projection({ ownerBootId: 'boot-a' }));
      // 同 epoch A→B 顶替（同 generation 幂等内容，owner 字段刷新）
      expect(applyVcMeetingMemberProjection(dir, projection({ ownerBootId: 'boot-b' })).ok).toBe(true);

      // A 的迟到重放——以前会被当「同代幂等」接受并把 owner 改回 A，现在必须拒
      expect(applyVcMeetingMemberProjection(dir, projection({ ownerBootId: 'boot-a' })))
        .toMatchObject({ ok: false, reason: 'stale_owner_boot' });
      // generation 抬高也救不了退休 boot
      expect(applyVcMeetingMemberProjection(dir, projection({ ownerBootId: 'boot-a', membershipGeneration: 2 })))
        .toMatchObject({ ok: false, reason: 'stale_owner_boot' });

      // B 仍是 owner：B 的 delivery 继续接受，A 的新 delivery 被拒
      expect(acceptVcMeetingDelivery(dir, delivery({ ownerBootId: 'boot-b' })))
        .toMatchObject({ kind: 'accepted' });
      expect(acceptVcMeetingDelivery(dir, delivery({ deliveryKey: 'dk-late-a', fromSeq: 4, toSeq: 5, ownerBootId: 'boot-a' })))
        .toMatchObject({ kind: 'conflict', reason: 'stale_owner_boot' });
    });

    it('keeps frozen receipts from the retired boot recoverable by the same key', () => {
      applyVcMeetingMemberProjection(dir, projection({ ownerBootId: 'boot-a' }));
      acceptVcMeetingDelivery(dir, delivery({ ownerBootId: 'boot-a' }));
      const RK = { ...KEY, deliveryKey: 'dk-1' };
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });
      markVcMeetingDeliveryAmbiguous(dir, RK, { workerGeneration: 1, dispatchAttempt: 1 });

      // B 顶替 → A 退休；A 任期冻结的 envelope 同 key 仍可恢复重派到 cursor
      applyVcMeetingMemberProjection(dir, projection({ ownerBootId: 'boot-b' }));
      expect(applyVcMeetingMemberProjection(dir, projection({ ownerBootId: 'boot-a' })))
        .toMatchObject({ ok: false, reason: 'stale_owner_boot' });

      expect(acceptVcMeetingDelivery(dir, delivery({ ownerBootId: 'boot-a' })))
        .toMatchObject({ kind: 'existing', receipt: { status: 'ambiguous' } });
      expect(markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 2 }))
        .toMatchObject({ ok: true, receipt: { dispatchAttempt: 2 } });
      expect(completeVcMeetingDelivery(dir, RK, { workerGeneration: 2, dispatchAttempt: 2 }))
        .toMatchObject({ ok: true, receiverCommittedThrough: 3 });
    });

    it('retires transitively across handovers and resets the list when the owner epoch rises', () => {
      applyVcMeetingMemberProjection(dir, projection({ ownerBootId: 'boot-a' }));
      applyVcMeetingMemberProjection(dir, projection({ ownerBootId: 'boot-b' }));
      applyVcMeetingMemberProjection(dir, projection({ ownerBootId: 'boot-c' }));

      // A、B 都退休；C 是现任
      expect(applyVcMeetingMemberProjection(dir, projection({ ownerBootId: 'boot-a' })))
        .toMatchObject({ ok: false, reason: 'stale_owner_boot' });
      expect(applyVcMeetingMemberProjection(dir, projection({ ownerBootId: 'boot-b' })))
        .toMatchObject({ ok: false, reason: 'stale_owner_boot' });
      expect(applyVcMeetingMemberProjection(dir, projection({ ownerBootId: 'boot-c' })).ok).toBe(true);

      // ownerEpoch 抬高：退休名单重置，新任期的 bootId 不受旧名单牵连
      expect(applyVcMeetingMemberProjection(
        dir,
        projection({ ownerEpoch: 2, ownerBootId: 'boot-a', membershipGeneration: 2 }),
      ).ok).toBe(true);
      // 但旧 epoch 整体已被挡住
      expect(applyVcMeetingMemberProjection(dir, projection({ ownerEpoch: 1, ownerBootId: 'boot-c', membershipGeneration: 2 })))
        .toMatchObject({ ok: false, reason: 'stale_owner_epoch' });
    });
  });

  // ─── delivery accept：幂等 / 冲突分类 ─────────────────────────────────────

  describe('delivery accept', () => {
    beforeEach(() => {
      applyVcMeetingMemberProjection(dir, projection());
    });

    it('accepts a contiguous batch and persists a durable accepted receipt', () => {
      const r = acceptVcMeetingDelivery(dir, delivery(), 1_000);
      expect(r).toMatchObject({
        kind: 'accepted',
        receiverCommittedThrough: 0,
        receipt: {
          deliveryKey: 'dk-1',
          stableTurnId: 'dk-1',
          status: 'accepted',
          fromSeq: 1,
          toSeq: 3,
          workerGeneration: 0,
          dispatchAttempt: 0,
        },
      });
      // 落盘可查（GET 语义）
      expect(getVcMeetingDeliveryReceipt(dir, KEY, 'dk-1')?.receipt.status).toBe('accepted');
    });

    it('same key + same hash is an idempotent echo across states (ACK-lost re-query)', () => {
      acceptVcMeetingDelivery(dir, delivery());
      const echo1 = acceptVcMeetingDelivery(dir, delivery());
      expect(echo1).toMatchObject({ kind: 'existing', receipt: { status: 'accepted' } });

      markVcMeetingDeliveryDispatched(dir, { ...KEY, deliveryKey: 'dk-1' }, { receiverBootId: 'boot-rx-1', workerGeneration: 7 });
      completeVcMeetingDelivery(dir, { ...KEY, deliveryKey: 'dk-1' });

      // hub 的 ACK 丢了：重 POST 同 envelope → 回显 completed + cursor，不再注入
      const echo2 = acceptVcMeetingDelivery(dir, delivery());
      expect(echo2).toMatchObject({
        kind: 'existing',
        receiverCommittedThrough: 3,
        receipt: { status: 'completed' },
      });
      // GET 路径同样可查
      expect(getVcMeetingDeliveryReceipt(dir, KEY, 'dk-1')).toMatchObject({
        receiverCommittedThrough: 3,
        receipt: { status: 'completed', dispatchAttempt: 1, workerGeneration: 7 },
      });
    });

    it('same key + different hash is always input_mismatch', () => {
      acceptVcMeetingDelivery(dir, delivery());
      const r = acceptVcMeetingDelivery(dir, delivery({ inputHash: 'sha256:bbb' }));
      expect(r).toMatchObject({ kind: 'conflict', reason: 'input_mismatch', receipt: { deliveryKey: 'dk-1' } });
    });

    it('fully committed range with a new key returns duplicate', () => {
      acceptVcMeetingDelivery(dir, delivery());
      markVcMeetingDeliveryDispatched(dir, { ...KEY, deliveryKey: 'dk-1' }, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });
      completeVcMeetingDelivery(dir, { ...KEY, deliveryKey: 'dk-1' });

      const r = acceptVcMeetingDelivery(dir, delivery({ deliveryKey: 'dk-other', fromSeq: 2, toSeq: 3 }));
      expect(r).toEqual({ kind: 'duplicate', receiverCommittedThrough: 3 });
    });

    it('rejects partial overlap strictly without trimming', () => {
      acceptVcMeetingDelivery(dir, delivery());
      markVcMeetingDeliveryDispatched(dir, { ...KEY, deliveryKey: 'dk-1' }, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });
      completeVcMeetingDelivery(dir, { ...KEY, deliveryKey: 'dk-1' });

      // cursor=3；[3,5] 与 [2,6] 都是 partial overlap，必须 409 而不是裁剪
      for (const [fromSeq, toSeq] of [[3, 5], [2, 6]] as const) {
        const r = acceptVcMeetingDelivery(dir, delivery({ deliveryKey: `dk-${fromSeq}-${toSeq}`, fromSeq, toSeq }));
        expect(r).toMatchObject({
          kind: 'conflict',
          reason: 'delivery_partial_overlap',
          receiverCommittedThrough: 3,
          expectedFromSeq: 4,
        });
      }
    });

    it('rejects a gap beyond cursor+1', () => {
      acceptVcMeetingDelivery(dir, delivery());
      markVcMeetingDeliveryDispatched(dir, { ...KEY, deliveryKey: 'dk-1' }, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });
      completeVcMeetingDelivery(dir, { ...KEY, deliveryKey: 'dk-1' });

      const r = acceptVcMeetingDelivery(dir, delivery({ deliveryKey: 'dk-2', fromSeq: 5, toSeq: 6 }));
      expect(r).toMatchObject({ kind: 'conflict', reason: 'delivery_gap', expectedFromSeq: 4 });
    });

    it('rejects an overlapping different key while a receipt is in flight', () => {
      acceptVcMeetingDelivery(dir, delivery());
      const r = acceptVcMeetingDelivery(dir, delivery({ deliveryKey: 'dk-2', fromSeq: 4, toSeq: 6 }));
      expect(r).toMatchObject({
        kind: 'conflict',
        reason: 'delivery_in_flight',
        activeDeliveryKey: 'dk-1',
      });
    });

    it('enforces owner/member/generation fencing on accept', () => {
      // projection ownerEpoch=1、generation=1
      expect(acceptVcMeetingDelivery(dir, delivery({ ownerEpoch: 2 })))
        .toMatchObject({ kind: 'conflict', reason: 'owner_epoch_not_registered' });

      applyVcMeetingMemberProjection(dir, projection({ ownerEpoch: 2, membershipGeneration: 2 }));
      expect(acceptVcMeetingDelivery(dir, delivery({ ownerEpoch: 1, membershipGeneration: 2 })))
        .toMatchObject({ kind: 'conflict', reason: 'stale_owner_epoch' });
      expect(acceptVcMeetingDelivery(dir, delivery({ ownerEpoch: 2, membershipGeneration: 1 })))
        .toMatchObject({ kind: 'conflict', reason: 'stale_membership_generation' });
      expect(acceptVcMeetingDelivery(dir, delivery({ ownerEpoch: 2, membershipGeneration: 3 })))
        .toMatchObject({ kind: 'conflict', reason: 'membership_generation_not_registered' });

      expect(acceptVcMeetingDelivery(dir, delivery({ memberId: 'member-ghost', ownerEpoch: 2, membershipGeneration: 2 })))
        .toMatchObject({ kind: 'conflict', reason: 'unknown_member' });
    });

    it('rejects deliveries from a stale owner boot after the hub daemon restarts', () => {
      // hub 重启：同 ownerEpoch、新 bootId re-register（同 generation 幂等重放）
      applyVcMeetingMemberProjection(dir, projection({ ownerBootId: 'boot-hub-2' }));

      // 崩溃前旧 boot 的在途 delivery 必须 stale 拒绝
      expect(acceptVcMeetingDelivery(dir, delivery({ ownerBootId: 'boot-hub-1' })))
        .toMatchObject({ kind: 'conflict', reason: 'stale_owner_boot' });
      // 新 boot 的 delivery 正常接受
      expect(acceptVcMeetingDelivery(dir, delivery({ ownerBootId: 'boot-hub-2' })))
        .toMatchObject({ kind: 'accepted' });
    });

    it('rejects deliveries for paused/removed membership and for a stale member epoch', () => {
      applyVcMeetingMemberProjection(dir, projection({ status: 'paused', membershipGeneration: 2 }));
      expect(acceptVcMeetingDelivery(dir, delivery({ membershipGeneration: 2 })))
        .toMatchObject({ kind: 'conflict', reason: 'membership_paused' });

      applyVcMeetingMemberProjection(dir, projection({ status: 'removed', membershipGeneration: 3 }));
      expect(acceptVcMeetingDelivery(dir, delivery({ membershipGeneration: 3 })))
        .toMatchObject({ kind: 'conflict', reason: 'membership_removed' });

      // re-add 后旧 epoch 的迟到 delivery 被拒（D1）
      applyVcMeetingMemberProjection(dir, projection({ memberEpoch: 2, membershipGeneration: 4, receiverSessionId: 'sess-2' }));
      expect(acceptVcMeetingDelivery(dir, delivery({ memberEpoch: 1, membershipGeneration: 4 })))
        .toMatchObject({ kind: 'conflict', reason: 'stale_member_epoch' });

      // 新 epoch 从 seq 1 开始正常接受
      expect(acceptVcMeetingDelivery(dir, delivery({ memberEpoch: 2, membershipGeneration: 4, deliveryKey: 'dk-e2' })))
        .toMatchObject({ kind: 'accepted' });
    });

    it('rejects a delivery before any projection is registered', () => {
      const fresh = mkdtempSync(join(tmpdir(), 'botmux-vc-delivery-fresh-'));
      try {
        expect(acceptVcMeetingDelivery(fresh, delivery()))
          .toMatchObject({ kind: 'conflict', reason: 'unknown_member' });
      } finally {
        rmSync(fresh, { recursive: true, force: true });
      }
    });
  });

  // ─── 生命周期：dispatch / fail / retry / complete ─────────────────────────

  describe('receipt lifecycle', () => {
    const RK = { ...KEY, deliveryKey: 'dk-1' };

    beforeEach(() => {
      applyVcMeetingMemberProjection(dir, projection());
      acceptVcMeetingDelivery(dir, delivery());
    });

    it('advances the cursor only on terminal completion, then accepts the next contiguous batch', () => {
      expect(getVcMeetingReceiverStream(dir, KEY)?.receiverCommittedThrough).toBe(0);

      const d = markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });
      expect(d).toMatchObject({ ok: true, receipt: { status: 'dispatched', dispatchAttempt: 1 } });
      expect(getVcMeetingReceiverStream(dir, KEY)?.receiverCommittedThrough).toBe(0);

      const c = completeVcMeetingDelivery(dir, RK);
      expect(c).toMatchObject({ ok: true, receiverCommittedThrough: 3 });

      // 幂等重复 terminal
      expect(completeVcMeetingDelivery(dir, RK)).toMatchObject({ ok: true, noop: true, receiverCommittedThrough: 3 });

      // stream head 释放，下一批 [4,6] 正常接受
      expect(acceptVcMeetingDelivery(dir, delivery({ deliveryKey: 'dk-2', fromSeq: 4, toSeq: 6 })))
        .toMatchObject({ kind: 'accepted', receiverCommittedThrough: 3 });
    });

    it('retries with the same key through failed_retryable and keeps the cursor still', () => {
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });
      const f = failVcMeetingDelivery(
        dir,
        RK,
        { kind: 'retryable', errorCode: 'worker_timeout', workerGeneration: 1, dispatchAttempt: 1 },
      );
      expect(f).toMatchObject({ ok: true, receipt: { status: 'failed_retryable', errorCode: 'worker_timeout' } });
      expect(getVcMeetingReceiverStream(dir, KEY)?.receiverCommittedThrough).toBe(0);
      // 同 key 重派：attempt 递增
      const d2 = markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 2 });
      expect(d2).toMatchObject({ ok: true, receipt: { status: 'dispatched', dispatchAttempt: 2, workerGeneration: 2 } });
      expect(completeVcMeetingDelivery(dir, RK)).toMatchObject({ ok: true, receiverCommittedThrough: 3 });
    });

    it('allows bounded retry from failed_terminal and blocks double dispatch', () => {
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });
      expect(markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 }))
        .toMatchObject({ ok: false, reason: 'already_dispatched' });

      failVcMeetingDelivery(
        dir,
        RK,
        { kind: 'terminal', errorCode: 'prompt_rejected', workerGeneration: 1, dispatchAttempt: 1 },
      );
      // §10.3：FAILED_TERMINAL 同 key bounded retry
      expect(markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 2 }))
        .toMatchObject({ ok: true, receipt: { dispatchAttempt: 2 } });
    });

    it('durably pauses a poison head and consumes one operator retry authorization', () => {
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });
      failVcMeetingDelivery(dir, RK, {
        kind: 'retryable', workerGeneration: 1, dispatchAttempt: 1,
      });
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 2 });
      failVcMeetingDelivery(dir, RK, {
        kind: 'terminal',
        errorCode: 'retry_budget_exhausted',
        workerGeneration: 2,
        dispatchAttempt: 2,
        pauseStream: true,
      });

      expect(getVcMeetingReceiverStream(dir, KEY)).toMatchObject({
        receiverCommittedThrough: 0,
        poisoned: { deliveryKey: 'dk-1', reason: 'retry_budget_exhausted' },
      });
      expect(acceptVcMeetingDelivery(dir, delivery()))
        .toMatchObject({ kind: 'conflict', reason: 'stream_poisoned', activeDeliveryKey: 'dk-1' });
      expect(acceptVcMeetingDelivery(dir, delivery({ deliveryKey: 'dk-2' })))
        .toMatchObject({ kind: 'conflict', reason: 'stream_poisoned' });

      expect(authorizeVcMeetingDeliveryManualRetry(dir, RK)).toMatchObject({
        ok: true,
        receipt: { status: 'failed_terminal', manualRetryAuthorizedAtAttempt: 2 },
      });
      expect(acceptVcMeetingDelivery(dir, delivery())).toMatchObject({ kind: 'existing' });
      expect(markVcMeetingDeliveryDispatched(
        dir,
        RK,
        { receiverBootId: 'boot-rx-2', workerGeneration: 3 },
      )).toMatchObject({
        ok: true,
        receipt: { status: 'dispatched', dispatchAttempt: 3 },
      });
      expect(getVcMeetingDeliveryReceipt(dir, RK)?.manualRetryAuthorizedAtAttempt).toBeUndefined();
      expect(authorizeVcMeetingDeliveryManualRetry(dir, RK))
        .toMatchObject({ ok: false, reason: 'stream_not_poisoned' });
    });

    it('rejects terminal signals from a stale dispatch attempt or worker generation', () => {
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });
      failVcMeetingDelivery(dir, RK, { kind: 'retryable', workerGeneration: 1, dispatchAttempt: 1 });
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 2 });

      // attempt 1 的迟到 terminal 不能结算 attempt 2
      expect(completeVcMeetingDelivery(dir, RK, { dispatchAttempt: 1 }))
        .toMatchObject({ ok: false, reason: 'stale_dispatch_attempt' });
      expect(completeVcMeetingDelivery(dir, RK, { workerGeneration: 1 }))
        .toMatchObject({ ok: false, reason: 'stale_worker_generation' });
      expect(completeVcMeetingDelivery(dir, RK, { dispatchAttempt: 2, workerGeneration: 2 }))
        .toMatchObject({ ok: true, receiverCommittedThrough: 3 });
    });

    it('rejects completion of a receipt that was never dispatched', () => {
      expect(completeVcMeetingDelivery(dir, RK)).toMatchObject({ ok: false, reason: 'invalid_transition' });
    });

    it('rejects an evidence-free fail unless the receipt is still accepted', () => {
      // accepted：dispatch 前同步失败，无证据 fail 合法
      expect(failVcMeetingDelivery(dir, RK, { kind: 'retryable', errorCode: 'session_gone' }))
        .toMatchObject({ ok: true, receipt: { status: 'failed_retryable' } });

      // dispatched（同 key 并发的另一路已 markDispatched 在飞）：无证据 fail 无权打掉
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });
      expect(failVcMeetingDelivery(dir, RK, { kind: 'retryable', errorCode: 'trigger_failed' }))
        .toMatchObject({ ok: false, reason: 'invalid_transition' });
      expect(getVcMeetingDeliveryReceipt(dir, KEY, 'dk-1')?.receipt.status).toBe('dispatched');
      // 该 in-flight 派发的 terminal 仍可正常结算
      expect(completeVcMeetingDelivery(dir, RK, { workerGeneration: 1, dispatchAttempt: 1 }))
        .toMatchObject({ ok: true, receiverCommittedThrough: 3 });
    });

    it('rejects an evidence-free fail for an ambiguous receipt', () => {
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });
      markVcMeetingDeliveryAmbiguous(dir, RK, { workerGeneration: 1, dispatchAttempt: 1 });
      // ambiguous 是待 replay 决策状态；无证据的失败上报不改写它
      expect(failVcMeetingDelivery(dir, RK, { kind: 'retryable' }))
        .toMatchObject({ ok: false, reason: 'invalid_transition' });
      expect(getVcMeetingDeliveryReceipt(dir, KEY, 'dk-1')?.receipt.status).toBe('ambiguous');
      // 带证据的仍允许（terminal 失败路径）
      expect(failVcMeetingDelivery(dir, RK, { kind: 'retryable', workerGeneration: 1, dispatchAttempt: 1 }))
        .toMatchObject({ ok: true, receipt: { status: 'failed_retryable' } });
    });
  });

  // ─── dispatched lease 到期（live-never-terminal 的运行期出口）─────────────

  describe('dispatched lease expiry', () => {
    const RK = { ...KEY, deliveryKey: 'dk-1' };

    beforeEach(() => {
      applyVcMeetingMemberProjection(dir, projection());
      acceptVcMeetingDelivery(dir, delivery());
    });

    it('expires an over-lease dispatched receipt to ambiguous, then the same key redispatches to terminal', () => {
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 }, 1_000);
      expect(getVcMeetingDeliveryReceipt(dir, KEY, 'dk-1')?.receipt.dispatchedAt).toBe(1_000);

      // 未到期不动
      expect(expireVcMeetingDeliveryLeases(dir, { agentAppId: 'cli_agent', leaseMs: 5_000 }, 5_500)).toEqual([]);
      expect(getVcMeetingDeliveryReceipt(dir, KEY, 'dk-1')?.receipt.status).toBe('dispatched');

      // 到期 → ambiguous（exact generation/attempt 记账）
      const affected = expireVcMeetingDeliveryLeases(dir, { agentAppId: 'cli_agent', leaseMs: 5_000 }, 7_000);
      expect(affected).toEqual([{
        listenerAppId: LISTENER,
        meetingId: MEETING,
        memberId: MEMBER,
        memberEpoch: 1,
        deliveryKey: 'dk-1',
        receiverSessionId: 'sess-1',
        workerGeneration: 1,
        dispatchAttempt: 1,
        ambiguousReplayCount: 1,
      }]);
      expect(getVcMeetingDeliveryReceipt(dir, KEY, 'dk-1')?.receipt.status).toBe('ambiguous');

      // 幂等：重复扫描零增量
      expect(expireVcMeetingDeliveryLeases(dir, { agentAppId: 'cli_agent', leaseMs: 5_000 }, 8_000)).toEqual([]);

      // 同 key 重派 → terminal 推进 cursor；旧 attempt 的迟到 terminal 被证据拒
      expect(markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 2 }, 9_000))
        .toMatchObject({ ok: true, receipt: { status: 'dispatched', dispatchAttempt: 2, dispatchedAt: 9_000 } });
      expect(completeVcMeetingDelivery(dir, RK, { workerGeneration: 1, dispatchAttempt: 1 }))
        .toMatchObject({ ok: false, reason: 'stale_dispatch_attempt' });
      expect(completeVcMeetingDelivery(dir, RK, { workerGeneration: 2, dispatchAttempt: 2 }))
        .toMatchObject({ ok: true, receiverCommittedThrough: 3 });
    });

    it('does not touch other agents, fresh leases after redispatch, or terminal receipts', () => {
      // 另一个 agent 的 member 同会议在飞（共享 dataDir 常态）
      applyVcMeetingMemberProjection(
        dir,
        projection({ memberId: 'member-actions', agentAppId: 'cli_agent_b', receiverSessionId: 'sess-b' }),
      );
      acceptVcMeetingDelivery(dir, delivery({ memberId: 'member-actions', deliveryKey: 'dk-b' }));
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 }, 1_000);
      markVcMeetingDeliveryDispatched(
        dir,
        { ...KEY, memberId: 'member-actions', deliveryKey: 'dk-b' },
        { receiverBootId: 'boot-rx-b', workerGeneration: 1 },
        1_000,
      );

      // 只处置本 agent；B 的超时派发不动
      const affected = expireVcMeetingDeliveryLeases(dir, { agentAppId: 'cli_agent', leaseMs: 5_000 }, 10_000);
      expect(affected.map((ref) => ref.deliveryKey)).toEqual(['dk-1']);
      expect(getVcMeetingDeliveryReceipt(dir, { ...KEY, memberId: 'member-actions' }, 'dk-b')?.receipt.status)
        .toBe('dispatched');

      // 重派刷新 lease 锚：旧的 dispatchedAt 不再算数
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 2 }, 10_500);
      expect(expireVcMeetingDeliveryLeases(dir, { agentAppId: 'cli_agent', leaseMs: 5_000 }, 12_000)).toEqual([]);

      // completed 后不受任何后续扫描影响
      completeVcMeetingDelivery(dir, RK, { workerGeneration: 2, dispatchAttempt: 2 });
      expect(expireVcMeetingDeliveryLeases(dir, { agentAppId: 'cli_agent', leaseMs: 1 }, 99_000)).toEqual([]);
      expect(getVcMeetingDeliveryReceipt(dir, KEY, 'dk-1')?.receipt.status).toBe('completed');

      // 防呆：非法 leaseMs / 空 agent 返回空
      expect(expireVcMeetingDeliveryLeases(dir, { agentAppId: 'cli_agent', leaseMs: 0 }, 99_000)).toEqual([]);
      expect(expireVcMeetingDeliveryLeases(dir, { agentAppId: '  ', leaseMs: 5_000 }, 99_000)).toEqual([]);
    });
  });

  // ─── frozen envelope 同 key 恢复（owner boot / generation 换代不卡死 head）──

  describe('frozen delivery recovery across owner boot / generation changes', () => {
    const RK = { ...KEY, deliveryKey: 'dk-1' };

    beforeEach(() => {
      applyVcMeetingMemberProjection(dir, projection());
      acceptVcMeetingDelivery(dir, delivery());
    });

    it('recovers the same frozen key across an owner daemon restart and settles through to the cursor', () => {
      // boot A 任期内派发丢失 → ambiguous
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });
      markVcMeetingDeliveryAmbiguous(dir, RK, { workerGeneration: 1, dispatchAttempt: 1 });

      // owner daemon 重启：同 ownerEpoch、新 bootId re-register（同 generation 幂等）
      expect(applyVcMeetingMemberProjection(dir, projection({ ownerBootId: 'boot-hub-2' })).ok).toBe(true);

      // hub 重发冻结的同一份 envelope（携带旧 bootId）→ 同 key 幂等回显，不被 stale_owner_boot 卡死
      const echo = acceptVcMeetingDelivery(dir, delivery({ ownerBootId: 'boot-hub-1' }));
      expect(echo).toMatchObject({ kind: 'existing', receipt: { status: 'ambiguous', deliveryKey: 'dk-1' } });

      // 同 key 重派 → terminal → cursor 推进
      expect(markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 2 }))
        .toMatchObject({ ok: true, receipt: { status: 'dispatched', dispatchAttempt: 2 } });
      expect(completeVcMeetingDelivery(dir, RK, { workerGeneration: 2, dispatchAttempt: 2 }))
        .toMatchObject({ ok: true, receiverCommittedThrough: 3 });
    });

    it('recovers the same frozen key across a membership generation bump with an unchanged session binding', () => {
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });
      markVcMeetingDeliveryAmbiguous(dir, RK, { workerGeneration: 1, dispatchAttempt: 1 });

      // generation bump（改 role，session 绑定不变）
      expect(applyVcMeetingMemberProjection(
        dir,
        projection({ membershipGeneration: 2, responseMode: 'listener_thread' }),
      ).ok).toBe(true);

      // 冻结 envelope 携带旧 generation → 同 key 恢复
      const echo = acceptVcMeetingDelivery(dir, delivery({ membershipGeneration: 1 }));
      expect(echo).toMatchObject({ kind: 'existing', receipt: { status: 'ambiguous' } });

      expect(markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 2 }))
        .toMatchObject({ ok: true });
      expect(completeVcMeetingDelivery(dir, RK, { workerGeneration: 2, dispatchAttempt: 2 }))
        .toMatchObject({ ok: true, receiverCommittedThrough: 3 });
    });

    it('still fences a NEW key carrying stale owner boot or stale generation after re-register', () => {
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });
      completeVcMeetingDelivery(dir, RK, { workerGeneration: 1, dispatchAttempt: 1 });
      applyVcMeetingMemberProjection(dir, projection({ ownerBootId: 'boot-hub-2', membershipGeneration: 2 }));

      // 新 key 必须携带当前注册值——旧 boot / 旧 generation 都严格拒绝
      expect(acceptVcMeetingDelivery(
        dir,
        delivery({ deliveryKey: 'dk-2', fromSeq: 4, toSeq: 5, ownerBootId: 'boot-hub-1', membershipGeneration: 2 }),
      )).toMatchObject({ kind: 'conflict', reason: 'stale_owner_boot' });
      expect(acceptVcMeetingDelivery(
        dir,
        delivery({ deliveryKey: 'dk-2', fromSeq: 4, toSeq: 5, ownerBootId: 'boot-hub-2', membershipGeneration: 1 }),
      )).toMatchObject({ kind: 'conflict', reason: 'stale_membership_generation' });
      // 当前值正常接受
      expect(acceptVcMeetingDelivery(
        dir,
        delivery({ deliveryKey: 'dk-2', fromSeq: 4, toSeq: 5, ownerBootId: 'boot-hub-2', membershipGeneration: 2 }),
      )).toMatchObject({ kind: 'accepted' });
    });

    it('does not recover a frozen key across owner epochs', () => {
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });
      markVcMeetingDeliveryAmbiguous(dir, RK, { workerGeneration: 1, dispatchAttempt: 1 });
      applyVcMeetingMemberProjection(dir, projection({ ownerEpoch: 2, ownerBootId: 'boot-hub-2', membershipGeneration: 2 }));

      expect(acceptVcMeetingDelivery(dir, delivery({ ownerEpoch: 1 })))
        .toMatchObject({ kind: 'conflict', reason: 'stale_owner_epoch' });
    });

    it('does not recover a frozen key once the membership is paused or removed', () => {
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });
      markVcMeetingDeliveryAmbiguous(dir, RK, { workerGeneration: 1, dispatchAttempt: 1 });

      applyVcMeetingMemberProjection(dir, projection({ status: 'paused', membershipGeneration: 2 }));
      expect(acceptVcMeetingDelivery(dir, delivery()))
        .toMatchObject({ kind: 'conflict', reason: 'membership_paused' });

      applyVcMeetingMemberProjection(dir, projection({ status: 'removed', membershipGeneration: 3 }));
      expect(acceptVcMeetingDelivery(dir, delivery()))
        .toMatchObject({ kind: 'conflict', reason: 'membership_removed' });
    });

    it('rejects receiver session rebinding within an epoch and keeps the frozen key recoverable', () => {
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });
      markVcMeetingDeliveryAmbiguous(dir, RK, { workerGeneration: 1, dispatchAttempt: 1 });

      // A generation bump cannot rebind a stream; a new epoch is required.
      expect(applyVcMeetingMemberProjection(
        dir,
        projection({ membershipGeneration: 2, receiverSessionId: 'sess-2' }),
      )).toMatchObject({ ok: false, reason: 'epoch_required' });
      expect(acceptVcMeetingDelivery(dir, delivery()))
        .toMatchObject({ kind: 'existing' });
    });

    it('does not recover a frozen key from a retired member epoch', () => {
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });
      markVcMeetingDeliveryAmbiguous(dir, RK, { workerGeneration: 1, dispatchAttempt: 1 });

      applyVcMeetingMemberProjection(
        dir,
        projection({ memberEpoch: 2, membershipGeneration: 2, receiverSessionId: 'sess-2' }),
      );
      expect(acceptVcMeetingDelivery(dir, delivery({ memberEpoch: 1 })))
        .toMatchObject({ kind: 'conflict', reason: 'stale_member_epoch' });
    });
  });

  // ─── ambiguous 重派与重启恢复 ─────────────────────────────────────────────

  describe('ambiguous replay and boot recovery', () => {
    const RK = { ...KEY, deliveryKey: 'dk-1' };

    beforeEach(() => {
      applyVcMeetingMemberProjection(dir, projection());
      acceptVcMeetingDelivery(dir, delivery());
    });

    it('marks stale dispatched receipts ambiguous on boot and allows same-key redispatch', () => {
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });

      // “重启”：新 bootId reconcile → dispatched(旧 boot) 判 ambiguous
      const affected = reconcileVcMeetingDeliveriesOnBoot(dir, { receiverBootId: 'boot-rx-2', agentAppId: 'cli_agent' });
      expect(affected).toEqual([{
        listenerAppId: LISTENER,
        meetingId: MEETING,
        memberId: MEMBER,
        memberEpoch: 1,
        deliveryKey: 'dk-1',
        receiverSessionId: 'sess-1',
        workerGeneration: 1,
        dispatchAttempt: 1,
        ambiguousReplayCount: 1,
      }]);
      expect(getVcMeetingDeliveryReceipt(dir, KEY, 'dk-1')?.receipt.status).toBe('ambiguous');

      // cursor 未动；同 key 重派（AMBIGUOUS → DISPATCHED），attempt 递增
      expect(getVcMeetingReceiverStream(dir, KEY)?.receiverCommittedThrough).toBe(0);
      const d2 = markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-2', workerGeneration: 1 });
      expect(d2).toMatchObject({ ok: true, receipt: { status: 'dispatched', dispatchAttempt: 2 } });
      expect(completeVcMeetingDelivery(dir, RK)).toMatchObject({ ok: true, receiverCommittedThrough: 3 });
    });

    it('leaves accepted-but-never-dispatched receipts untouched on boot', () => {
      const affected = reconcileVcMeetingDeliveriesOnBoot(dir, { receiverBootId: 'boot-rx-2', agentAppId: 'cli_agent' });
      expect(affected).toEqual([]);
      expect(getVcMeetingDeliveryReceipt(dir, KEY, 'dk-1')?.receipt.status).toBe('accepted');
    });

    it('does not reconcile receipts dispatched by the current boot', () => {
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });
      expect(reconcileVcMeetingDeliveriesOnBoot(dir, { receiverBootId: 'boot-rx-1', agentAppId: 'cli_agent' })).toEqual([]);
      expect(getVcMeetingDeliveryReceipt(dir, KEY, 'dk-1')?.receipt.status).toBe('dispatched');
    });

    it('only reconciles streams whose projection belongs to the given agent (shared dataDir)', () => {
      // 同一场会议里另一个 agent bot 的 member 也在飞（多 bot 共享 dataDir 的常态）
      applyVcMeetingMemberProjection(
        dir,
        projection({ memberId: 'member-actions', agentAppId: 'cli_agent_b', receiverSessionId: 'sess-b' }),
      );
      acceptVcMeetingDelivery(
        dir,
        delivery({ memberId: 'member-actions', deliveryKey: 'dk-b', receiverBootId: 'boot-rx-b' }),
      );
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });
      markVcMeetingDeliveryDispatched(
        dir,
        { ...KEY, memberId: 'member-actions', deliveryKey: 'dk-b' },
        { receiverBootId: 'boot-rx-b', workerGeneration: 1 },
      );

      // agent A 的 daemon 重启：只处置 A 名下的 stream，B 的 in-flight 派发不动
      const affected = reconcileVcMeetingDeliveriesOnBoot(dir, { receiverBootId: 'boot-rx-2', agentAppId: 'cli_agent' });
      expect(affected.map((ref) => ref.deliveryKey)).toEqual(['dk-1']);
      expect(getVcMeetingDeliveryReceipt(dir, KEY, 'dk-1')?.receipt.status).toBe('ambiguous');
      expect(getVcMeetingDeliveryReceipt(dir, { ...KEY, memberId: 'member-actions' }, 'dk-b')?.receipt.status)
        .toBe('dispatched');

      // B 的 daemon 随后重启：这回轮到 B 的被判 ambiguous
      const affectedB = reconcileVcMeetingDeliveriesOnBoot(
        dir,
        { receiverBootId: 'boot-rx-b2', agentAppId: 'cli_agent_b' },
      );
      expect(affectedB.map((ref) => ref.deliveryKey)).toEqual(['dk-b']);
    });

    it('settles a late terminal for an ambiguous receipt only with matching generation evidence', () => {
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 5 });
      markVcMeetingDeliveryAmbiguous(dir, RK);

      // 不带证据的 terminal 不能结算 ambiguous
      expect(completeVcMeetingDelivery(dir, RK)).toMatchObject({ ok: false, reason: 'invalid_transition' });
      // 世代证据匹配 → 允许迟到结算，减少一次无谓重放
      expect(completeVcMeetingDelivery(dir, RK, { workerGeneration: 5, dispatchAttempt: 1 }))
        .toMatchObject({ ok: true, receiverCommittedThrough: 3 });
    });

    it('does not let a stale exit mark a newer dispatch attempt ambiguous', () => {
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 5 });
      markVcMeetingDeliveryAmbiguous(dir, RK, { workerGeneration: 5, dispatchAttempt: 1 });
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 5 });

      expect(markVcMeetingDeliveryAmbiguous(dir, RK, { workerGeneration: 5, dispatchAttempt: 1 }))
        .toMatchObject({ ok: false, reason: 'stale_dispatch_attempt' });
      expect(getVcMeetingDeliveryReceipt(dir, KEY, 'dk-1')?.receipt.status).toBe('dispatched');
    });

    it('survives a store reload with cursor and receipts intact (restart recovery)', () => {
      markVcMeetingDeliveryDispatched(dir, RK, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });
      completeVcMeetingDelivery(dir, RK);

      // “重启”后（无内存态，纯读盘）：cursor / receipt / projection 原样
      expect(getVcMeetingReceiverStream(dir, KEY)).toMatchObject({ receiverCommittedThrough: 3 });
      expect(getVcMeetingDeliveryReceipt(dir, KEY, 'dk-1')?.receipt.status).toBe('completed');
      expect(getVcMeetingMemberProjection(dir, KEY)?.status).toBe('active');
      expect(acceptVcMeetingDelivery(dir, delivery({ deliveryKey: 'dk-2', fromSeq: 4, toSeq: 4 })))
        .toMatchObject({ kind: 'accepted' });
    });
  });

  // ─── abandon（§10.3 manual abandon）───────────────────────────────────────

  describe('abandon stream', () => {
    beforeEach(() => {
      applyVcMeetingMemberProjection(dir, projection());
      acceptVcMeetingDelivery(dir, delivery());
    });

    it('abandons the active receipt durably without touching the cursor, then blocks the epoch', () => {
      markVcMeetingDeliveryDispatched(dir, { ...KEY, deliveryKey: 'dk-1' }, { receiverBootId: 'boot-rx-1', workerGeneration: 1 });

      const r = abandonVcMeetingDeliveryStream(dir, KEY, { reason: 'operator poison-batch abandon' }, 9_000);
      expect(r.ok).toBe(true);
      expect(getVcMeetingReceiverStream(dir, KEY)).toMatchObject({
        receiverCommittedThrough: 0,
        abandoned: { at: 9_000, reason: 'operator poison-batch abandon' },
      });
      expect(getVcMeetingDeliveryReceipt(dir, KEY, 'dk-1')?.receipt.status).toBe('abandoned');

      // 该 epoch 拒绝一切新 delivery；幂等 re-abandon OK
      expect(acceptVcMeetingDelivery(dir, delivery({ deliveryKey: 'dk-3', fromSeq: 1, toSeq: 2 })))
        .toMatchObject({ kind: 'conflict', reason: 'stream_abandoned' });
      expect(abandonVcMeetingDeliveryStream(dir, KEY).ok).toBe(true);

      // 继续只能走新 epoch（from-now，seq 从 1 起）
      applyVcMeetingMemberProjection(dir, projection({ memberEpoch: 2, membershipGeneration: 2, receiverSessionId: 'sess-2' }));
      expect(acceptVcMeetingDelivery(dir, delivery({ memberEpoch: 2, membershipGeneration: 2, deliveryKey: 'dk-e2', fromSeq: 1, toSeq: 1 })))
        .toMatchObject({ kind: 'accepted' });
    });
  });

  // ─── 全局 deliveryKey 反查（turn_terminal / GET :deliveryKey 对接面）─────

  describe('findVcMeetingDeliveryByKey', () => {
    beforeEach(() => {
      applyVcMeetingMemberProjection(dir, projection());
      applyVcMeetingMemberProjection(dir, projection({ meetingId: 'meeting-2', receiverSessionId: 'sess-m2' }));
      acceptVcMeetingDelivery(dir, delivery());
      acceptVcMeetingDelivery(dir, delivery({ meetingId: 'meeting-2', deliveryKey: 'dk-m2' }));
    });

    it('resolves member key, session, receipt, and cursor from a bare deliveryKey across meetings', () => {
      expect(findVcMeetingDeliveryByKey(dir, 'dk-m2')).toMatchObject({
        memberKey: { listenerAppId: LISTENER, meetingId: 'meeting-2', memberId: MEMBER, memberEpoch: 1 },
        receiverSessionId: 'sess-m2',
        receipt: { deliveryKey: 'dk-m2', status: 'accepted' },
        receiverCommittedThrough: 0,
      });
      expect(findVcMeetingDeliveryByKey(dir, 'dk-unknown')).toBeUndefined();
    });

    it('validates receiver session binding on the terminal path', () => {
      expect(findVcMeetingDeliveryByKey(dir, 'dk-1', { receiverSessionId: 'sess-1' })).toBeDefined();
      // key 命中但 session 不符：宁可返回 undefined（→ ambiguous）也不结算错流
      expect(findVcMeetingDeliveryByKey(dir, 'dk-1', { receiverSessionId: 'sess-other' })).toBeUndefined();
    });
  });

  // ─── 文件级属性：0600 / 损坏取证 / TTL 清理 ───────────────────────────────

  describe('listActiveVcMeetingDeliveriesForSession', () => {
    beforeEach(() => {
      applyVcMeetingMemberProjection(dir, projection());
      applyVcMeetingMemberProjection(dir, projection({ meetingId: 'meeting-2' }));
      applyVcMeetingMemberProjection(
        dir,
        projection({ meetingId: 'meeting-other-session', receiverSessionId: 'sess-other' }),
      );
      acceptVcMeetingDelivery(dir, delivery());
      acceptVcMeetingDelivery(dir, delivery({ meetingId: 'meeting-2', deliveryKey: 'dk-completed' }));
      acceptVcMeetingDelivery(
        dir,
        delivery({ meetingId: 'meeting-other-session', deliveryKey: 'dk-other-session' }),
      );
    });

    it('returns only active receipts bound to the requested receiver session', () => {
      expect(listActiveVcMeetingDeliveriesForSession(dir, 'sess-1')).toMatchObject([
        {
          memberKey: { listenerAppId: LISTENER, meetingId: MEETING, memberId: MEMBER, memberEpoch: 1 },
          receiverSessionId: 'sess-1',
          receipt: { deliveryKey: 'dk-1', status: 'accepted' },
        },
        {
          memberKey: { listenerAppId: LISTENER, meetingId: 'meeting-2', memberId: MEMBER, memberEpoch: 1 },
          receiverSessionId: 'sess-1',
          receipt: { deliveryKey: 'dk-completed', status: 'accepted' },
        },
      ]);
      expect(listActiveVcMeetingDeliveriesForSession(dir, 'sess-other')).toMatchObject([
        { receipt: { deliveryKey: 'dk-other-session' }, receiverSessionId: 'sess-other' },
      ]);
      expect(listActiveVcMeetingDeliveriesForSession(dir, 'missing-session')).toEqual([]);
    });

    it('excludes a completed receipt after it releases the stream head', () => {
      const completedKey = {
        listenerAppId: LISTENER,
        meetingId: 'meeting-2',
        memberId: MEMBER,
        memberEpoch: 1,
        deliveryKey: 'dk-completed',
      };
      markVcMeetingDeliveryDispatched(
        dir,
        completedKey,
        { receiverBootId: 'boot-rx-1', workerGeneration: 7 },
      );
      completeVcMeetingDelivery(dir, completedKey, { workerGeneration: 7, dispatchAttempt: 1 });

      expect(listActiveVcMeetingDeliveriesForSession(dir, 'sess-1').map((entry) => entry.receipt.deliveryKey))
        .toEqual(['dk-1']);
    });
  });

  // ─── 按 receiverSessionId 反查当前有效 projection（botmux send 拒发面）────

  describe('listVcMeetingActiveProjectionsForReceiverSession', () => {
    it('lists only active current-epoch projections bound to the session, across meetings', () => {
      applyVcMeetingMemberProjection(dir, projection());
      applyVcMeetingMemberProjection(dir, projection({ meetingId: 'meeting-2', responseMode: 'listener_thread' }));
      applyVcMeetingMemberProjection(dir, projection({ meetingId: 'meeting-3', receiverSessionId: 'sess-other' }));

      const bound = listVcMeetingActiveProjectionsForReceiverSession(dir, 'sess-1');
      expect(bound.map((p) => [p.meetingId, p.responseMode])).toEqual([
        [MEETING, 'silent'],
        ['meeting-2', 'listener_thread'],
      ]);
      expect(listVcMeetingActiveProjectionsForReceiverSession(dir, 'sess-none')).toEqual([]);
      expect(listVcMeetingActiveProjectionsForReceiverSession(dir, '  ')).toEqual([]);
    });

    it('ignores retired epochs and non-active statuses', () => {
      applyVcMeetingMemberProjection(dir, projection());
      // member epoch 换代到 sess-2：epoch 1 的 active 残留不再算 sess-1 的绑定
      applyVcMeetingMemberProjection(
        dir,
        projection({ memberEpoch: 2, membershipGeneration: 2, receiverSessionId: 'sess-2' }),
      );
      expect(listVcMeetingActiveProjectionsForReceiverSession(dir, 'sess-1')).toEqual([]);
      expect(listVcMeetingActiveProjectionsForReceiverSession(dir, 'sess-2')).toHaveLength(1);

      // removed 后不再返回
      applyVcMeetingMemberProjection(
        dir,
        projection({ memberEpoch: 2, membershipGeneration: 3, receiverSessionId: 'sess-2', status: 'removed' }),
      );
      expect(listVcMeetingActiveProjectionsForReceiverSession(dir, 'sess-2')).toEqual([]);
    });
  });

  describe('storage properties', () => {
    it('writes state files with 0600 permissions', () => {
      applyVcMeetingMemberProjection(dir, projection());
      const storeDir = join(dir, 'vc-meeting-delivery');
      const files = readdirSync(storeDir).filter((f) => f.endsWith('.json'));
      expect(files).toHaveLength(1);
      const mode = statSync(join(storeDir, files[0])).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('moves a corrupt state file aside instead of silently overwriting, and warns', () => {
      applyVcMeetingMemberProjection(dir, projection());
      const storeDir = join(dir, 'vc-meeting-delivery');
      const [file] = readdirSync(storeDir).filter((f) => f.endsWith('.json'));
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      writeFileSync(join(storeDir, file), '{ not json', { mode: 0o600 });

      // 损坏后的变更从空状态重建（investigable aside 保留取证）
      const r = applyVcMeetingMemberProjection(dir, projection());
      expect(r.ok).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('corrupt state'));
      expect(readdirSync(storeDir).some((f) => f.includes('.corrupt.'))).toBe(true);
    });

    it('prunes whole meetings past TTL and keeps fresh ones', () => {
      applyVcMeetingMemberProjection(dir, projection(), 1_000);
      applyVcMeetingMemberProjection(
        dir,
        projection({ meetingId: 'meeting-fresh' }),
        50_000,
      );

      const removed = pruneVcMeetingDeliveryState(dir, { ttlMs: 10_000 }, 60_000);
      expect(removed).toBe(1);
      expect(getVcMeetingMemberProjection(dir, KEY)).toBeUndefined();
      expect(getVcMeetingMemberProjection(dir, { ...KEY, meetingId: 'meeting-fresh' })).toBeDefined();
      expect(existsSync(join(dir, 'vc-meeting-delivery'))).toBe(true);
    });
  });
});
