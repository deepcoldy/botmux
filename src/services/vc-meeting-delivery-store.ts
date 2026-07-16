/**
 * vc-meeting-delivery-store.ts — MA-P0 receiver 侧耐久状态：
 * membership projection（hub 下发的成员投影 + fencing 高水位）与
 * delivery receipt / cursor（每条 member stream 的接收账本）。
 *
 * 对应设计稿 docs/design/2026-07-10-vc-multi-agent-consumer-delivery.md §7.2/§9/§10.3：
 * - key = (listenerAppId, meetingId, memberId, memberEpoch)
 * - projection 携带 ownerBootId / ownerEpoch / membershipGeneration / status /
 *   receiverSessionId；register/update 按 ownerEpoch、memberEpoch、
 *   membershipGeneration 三个高水位 fencing，removed epoch 永久失效
 * - receipt 携带 deliveryKey / inputHash / fromSeq / toSeq / status /
 *   receiverBootId / workerGeneration / dispatchAttempt；同 key 同 hash 幂等
 *   回显、异 hash 409、duplicate / partial overlap / gap / in-flight 各自显式
 *   冲突；只有 turn terminal 才原子推进 receiverCommittedThrough
 * - meeting receipt 是顺序与完成状态的唯一真源（§9.3）；cursor 从不跳号
 *
 * 存储：每场会议一个 JSON 文件（0600，tmp+rename 原子写），所有
 * read-modify-write 经 withFileLockSync 跨进程串行化。不引 SQLite。
 * 会议正文不落盘——这里只有位置、身份与 hash（§12.1）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';
import type {
  VcMeetingConsumerManagedSink,
  VcMeetingConsumerProfileFilter,
} from '../types.js';
import {
  normalizeVcMeetingMemberPolicy,
  vcMeetingCanonicalStringListsEqual,
  vcMeetingMemberFilterEquals,
} from './vc-meeting-member-policy.js';
import { normalizeVcMeetingProfileInstructions } from './vc-meeting-profile-instructions.js';

const DIR_NAME = 'vc-meeting-delivery';
const SCHEMA_VERSION = 1;

// ─── 身份与记录类型 ──────────────────────────────────────────────────────────

export interface VcMeetingMemberKey {
  listenerAppId: string;
  meetingId: string;
  memberId: string;
  memberEpoch: number;
}

export type VcMeetingMembershipStatus = 'active' | 'paused' | 'removed';
export type VcMeetingResponseMode = 'silent' | 'listener_thread';

export interface VcMeetingMemberProjectionInput {
  listenerAppId: string;
  meetingId: string;
  ownerBootId: string;
  ownerEpoch: number;
  memberId: string;
  agentAppId: string;
  role: string;
  /** Canonical trusted profile instructions, immutable within a member epoch. */
  instructions?: string;
  memberEpoch: number;
  membershipGeneration: number;
  status: VcMeetingMembershipStatus;
  responseMode: VcMeetingResponseMode;
  /** Optional only for exact legacy meeting_assistant migration. The store
   * normalizes every accepted record before it is persisted. */
  filter?: VcMeetingConsumerProfileFilter;
  capabilities?: string[];
  ownedSinks?: VcMeetingConsumerManagedSink[];
  sinkOwnerGeneration?: number;
  joinedAtIngestSeq: number;
  receiverSessionId: string;
  outputChatId: string;
}

export interface VcMeetingMemberProjectionRecord extends VcMeetingMemberProjectionInput {
  createdAt: number;
  updatedAt: number;
}

export type VcMeetingProjectionRejectReason =
  | 'invalid'
  | 'stale_owner_epoch'
  | 'stale_owner_boot'
  | 'stale_member_epoch'
  | 'stale_membership_generation'
  | 'stale_sink_owner_generation'
  | 'projection_conflict'
  | 'epoch_required'
  | 'epoch_removed';

export type VcMeetingProjectionResult =
  | { ok: true; record: VcMeetingMemberProjectionRecord }
  | { ok: false; reason: VcMeetingProjectionRejectReason; detail?: string };

export type VcMeetingDeliveryReceiptStatus =
  | 'accepted'
  | 'dispatched'
  | 'completed'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'ambiguous'
  | 'abandoned';

/** 终态：不再持有 stream head。 */
const TERMINAL_RECEIPT_STATUSES: ReadonlySet<VcMeetingDeliveryReceiptStatus> = new Set([
  'completed',
  'abandoned',
]);

export interface VcMeetingDeliveryReceiptRecord {
  deliveryKey: string;
  /** §9.3：stableTurnId = deliveryKey。 */
  stableTurnId: string;
  inputHash: string;
  fromSeq: number;
  toSeq: number;
  final: boolean;
  /** Response policy frozen when this logical delivery is first accepted.
   * Projection updates must not retroactively make an already-running silent
   * attempt loud (or the reverse). Older WIP records may omit this field;
   * readers fail closed to `silent`. */
  responseMode?: VcMeetingResponseMode;
  /** Sink-owner authorization generation frozen when this logical delivery
   * is first accepted. Projection updates must not let an old source turn
   * inherit authority from a later owner generation. Older WIP receipts may
   * omit this field; action creation fails closed for those records. */
  sinkOwnerGeneration?: number;
  status: VcMeetingDeliveryReceiptStatus;
  /** 最近一次 dispatch 所在的 receiver boot；accept 时记录接收 boot。 */
  receiverBootId: string;
  /** 最近一次 dispatch 的 worker 世代；未 dispatch 过为 0。 */
  workerGeneration: number;
  /**
   * 最近一次 markDispatched 的时刻——lease 判定的唯一时间锚。区别于
   * updatedAt（任何状态转移都会刷新）：dispatched 期间两者相等，但语义上
   * lease 只关心「这次派发躺了多久」。老记录缺席时读方以 updatedAt 兜底。
   */
  dispatchedAt?: number;
  /** 实际派发次数；未 dispatch 过为 0。每次重派（含 ambiguous 重派）+1。 */
  dispatchAttempt: number;
  /** 被判 ambiguous 的累计次数（审计）。 */
  ambiguousReplayCount: number;
  /**
   * Operator-authorized retry token.  Its value is the dispatchAttempt that
   * was current when authorization was granted; markDispatched consumes it
   * atomically before incrementing the attempt.
   */
  manualRetryAuthorizedAtAttempt?: number;
  errorCode?: string;
  createdAt: number;
  updatedAt: number;
}

export interface VcMeetingReceiverStreamRecord {
  listenerAppId: string;
  meetingId: string;
  memberId: string;
  memberEpoch: number;
  receiverSessionId: string;
  /** 已投递或已显式解决的连续前缀（§12.2）；从 0 起，从不跳号。 */
  receiverCommittedThrough: number;
  /** 非终态 receipt 的 deliveryKey；同一时刻至多一个 in-flight（§9.4 规则 6）。 */
  activeDeliveryKey?: string;
  /** 人工放弃后的耐久标记（§10.3 AbandonedStream）；该 epoch 不再接受新 delivery。 */
  abandoned?: { at: number; reason?: string };
  /**
   * Retry budget exhausted. The frozen head remains authoritative but no
   * delivery may be (re)accepted until an operator authorizes the exact key or
   * abandons the epoch.
   */
  poisoned?: { deliveryKey: string; at: number; reason: string };
  receipts: Record<string, VcMeetingDeliveryReceiptRecord>;
  createdAt: number;
  updatedAt: number;
}

// ─── accept / 状态转移 API 类型 ──────────────────────────────────────────────

export interface VcMeetingDeliveryAcceptInput extends VcMeetingMemberKey {
  ownerBootId: string;
  ownerEpoch: number;
  membershipGeneration: number;
  deliveryKey: string;
  inputHash: string;
  fromSeq: number;
  toSeq: number;
  final?: boolean;
  responseMode: VcMeetingResponseMode;
  receiverBootId: string;
}

export type VcMeetingDeliveryConflictReason =
  | 'invalid'
  | 'stale_owner_epoch'
  | 'stale_owner_boot'
  | 'owner_epoch_not_registered'
  | 'unknown_member'
  | 'stale_member_epoch'
  | 'stale_membership_generation'
  | 'membership_generation_not_registered'
  | 'membership_paused'
  | 'membership_removed'
  | 'stream_abandoned'
  | 'stream_poisoned'
  | 'receiver_session_changed'
  | 'input_mismatch'
  | 'delivery_partial_overlap'
  | 'delivery_gap'
  | 'delivery_in_flight';

export type VcMeetingDeliveryAcceptResult =
  | { kind: 'accepted'; receipt: VcMeetingDeliveryReceiptRecord; receiverCommittedThrough: number }
  /** 同 key 同 hash 的幂等回显：返回当前 receipt（可能已 terminal），不产生任何状态变化。 */
  | { kind: 'existing'; receipt: VcMeetingDeliveryReceiptRecord; receiverCommittedThrough: number }
  /** toSeq <= receiverCommittedThrough 的整批重放：不注入，只回报 cursor。 */
  | { kind: 'duplicate'; receiverCommittedThrough: number }
  | {
      kind: 'conflict';
      reason: VcMeetingDeliveryConflictReason;
      receiverCommittedThrough?: number;
      /** delivery_gap / delivery_partial_overlap 时的期望起点（= cursor + 1）。 */
      expectedFromSeq?: number;
      /** delivery_in_flight 时正在占用 stream head 的 deliveryKey。 */
      activeDeliveryKey?: string;
      /** input_mismatch 时已有的 receipt，供 hub 结算。 */
      receipt?: VcMeetingDeliveryReceiptRecord;
    };

export type VcMeetingDeliveryTransitionErrorReason =
  | 'unknown_stream'
  | 'unknown_receipt'
  | 'invalid_transition'
  | 'already_dispatched'
  | 'stale_dispatch_attempt'
  | 'stale_worker_generation'
  | 'stream_not_poisoned'
  | 'stream_abandoned';

export type VcMeetingDeliveryTransitionResult =
  | { ok: true; receipt: VcMeetingDeliveryReceiptRecord; receiverCommittedThrough: number; noop?: boolean }
  | { ok: false; reason: VcMeetingDeliveryTransitionErrorReason; receipt?: VcMeetingDeliveryReceiptRecord };

// ─── 文件布局与读写 ──────────────────────────────────────────────────────────

interface VcMeetingDeliveryStateFile {
  schemaVersion: number;
  listenerAppId: string;
  meetingId: string;
  owner: {
    ownerEpoch: number;
    ownerBootId: string;
    /** 同 ownerEpoch 内已被顶替的历任 bootId。迟到的退休
     *  boot projection 重放不得把 owner 改回去；ownerEpoch 抬高时重置——
     *  旧 epoch 的 boot 已整体被 stale_owner_epoch 挡住，无需留名单。 */
    retiredBootIds?: string[];
  };
  members: Record<string, {
    maxKnownEpoch: number;
    generationHighWater: number;
    projections: Record<string, VcMeetingMemberProjectionRecord>;
  }>;
  streams: Record<string, VcMeetingReceiverStreamRecord>;
  createdAt: number;
  updatedAt: number;
}

function safeFileToken(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, (ch) => `%${ch.charCodeAt(0).toString(16)}`);
}

function meetingFilePath(dataDir: string, listenerAppId: string, meetingId: string): string {
  return join(dataDir, DIR_NAME, `${safeFileToken(listenerAppId)}__${safeFileToken(meetingId)}.json`);
}

function streamKey(memberId: string, memberEpoch: number): string {
  return `${memberId}:${memberEpoch}`;
}

function normalizePersistedProjectionPolicies(state: VcMeetingDeliveryStateFile): void {
  for (const member of Object.values(state.members ?? {})) {
    for (const projection of Object.values(member.projections ?? {})) {
      const normalizedInstructions = normalizeVcMeetingProfileInstructions(projection.instructions);
      if (!normalizedInstructions.ok) {
        throw new Error(`invalid persisted member instructions: ${normalizedInstructions.error}`);
      }
      if (normalizedInstructions.instructions === undefined) delete projection.instructions;
      else projection.instructions = normalizedInstructions.instructions;
      const policy = normalizeVcMeetingMemberPolicy({
        memberId: projection.memberId,
        role: projection.role,
        membershipGeneration: projection.membershipGeneration,
        responseMode: projection.responseMode,
        filter: projection.filter,
        capabilities: projection.capabilities,
        ownedSinks: projection.ownedSinks,
        sinkOwnerGeneration: projection.sinkOwnerGeneration,
      });
      if (policy) Object.assign(projection, policy);
    }
  }
}

function readStateFile(fp: string): VcMeetingDeliveryStateFile | undefined {
  if (!existsSync(fp)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf-8')) as VcMeetingDeliveryStateFile;
    if (!raw || typeof raw !== 'object' || typeof raw.schemaVersion !== 'number') return undefined;
    normalizePersistedProjectionPolicies(raw);
    return raw;
  } catch (err) {
    logger.warn(
      `[vc-meeting-delivery-store] failed to read ${fp}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * 锁内读取：损坏文件改名保留取证（.corrupt.<ts>），当作缺失重建——cursor 丢失
 * 只会导致 at-least-once 重放，由 action gate 兜副作用；静默覆盖才是事故。
 */
function readStateFileForMutation(fp: string): VcMeetingDeliveryStateFile | undefined {
  if (!existsSync(fp)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf-8')) as VcMeetingDeliveryStateFile;
    if (!raw || typeof raw !== 'object' || typeof raw.schemaVersion !== 'number') {
      throw new Error('not a delivery state file');
    }
    normalizePersistedProjectionPolicies(raw);
    return raw;
  } catch (err) {
    const aside = `${fp}.corrupt.${Date.now()}`;
    try { renameSync(fp, aside); } catch { /* 已被并发处理，容忍 */ }
    logger.warn(
      `[vc-meeting-delivery-store] corrupt state at ${fp}, moved aside to ${aside}: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

function writeStateFile(fp: string, state: VcMeetingDeliveryStateFile, now: number): void {
  state.updatedAt = now;
  const dir = join(fp, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(fp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

function newStateFile(listenerAppId: string, meetingId: string, now: number): VcMeetingDeliveryStateFile {
  return {
    schemaVersion: SCHEMA_VERSION,
    listenerAppId,
    meetingId,
    owner: { ownerEpoch: 0, ownerBootId: '' },
    members: {},
    streams: {},
    createdAt: now,
    updatedAt: now,
  };
}

function mutateState<T>(
  dataDir: string,
  listenerAppId: string,
  meetingId: string,
  opts: { createIfMissing: boolean; now: number },
  fn: (state: VcMeetingDeliveryStateFile | undefined) => { result: T; write?: VcMeetingDeliveryStateFile },
): T {
  const fp = meetingFilePath(dataDir, listenerAppId, meetingId);
  const dir = join(dataDir, DIR_NAME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return withFileLockSync(fp, () => {
    let state = readStateFileForMutation(fp);
    if (!state && opts.createIfMissing) state = newStateFile(listenerAppId, meetingId, opts.now);
    const { result, write } = fn(state);
    if (write) writeStateFile(fp, write, opts.now);
    return result;
  });
}

function nonEmpty(...values: string[]): boolean {
  return values.every((v) => typeof v === 'string' && v.trim().length > 0);
}

/**
 * projection 的「member 语义内容」等价判断——不含 owner 字段：owner
 * bootId/epoch 是会议级 fencing 信息，owner daemon 重启后同 generation
 * re-register 换 bootId 是合法幂等重放，不构成内容冲突。
 */
function projectionContentEquals(
  a: VcMeetingMemberProjectionInput,
  b: VcMeetingMemberProjectionInput,
): boolean {
  return a.agentAppId === b.agentAppId
    && a.role === b.role
    && a.instructions === b.instructions
    && a.status === b.status
    && a.responseMode === b.responseMode
    && vcMeetingMemberFilterEquals(a.filter, b.filter)
    && vcMeetingCanonicalStringListsEqual(a.capabilities ?? [], b.capabilities ?? [])
    && vcMeetingCanonicalStringListsEqual(a.ownedSinks ?? [], b.ownedSinks ?? [])
    && a.sinkOwnerGeneration === b.sinkOwnerGeneration
    && a.joinedAtIngestSeq === b.joinedAtIngestSeq
    && a.receiverSessionId === b.receiverSessionId
    && a.outputChatId === b.outputChatId;
}

/**
 * These fields define the meaning and identity of one member delivery stream.
 * Changing any of them while reusing the same memberEpoch would attach a new
 * consumer/session to the old cursor and frozen receipts.  Control-plane
 * changes such as pause/resume and responseMode may advance only
 * membershipGeneration; stream-semantic changes must allocate a new epoch.
 */
function projectionStreamIdentityEquals(
  a: VcMeetingMemberProjectionInput,
  b: VcMeetingMemberProjectionInput,
): boolean {
  return a.agentAppId === b.agentAppId
    && a.role === b.role
    && a.instructions === b.instructions
    && vcMeetingMemberFilterEquals(a.filter, b.filter)
    && a.joinedAtIngestSeq === b.joinedAtIngestSeq
    && a.receiverSessionId === b.receiverSessionId
    && a.outputChatId === b.outputChatId;
}

// ─── membership projection：register / update + fencing ─────────────────────

export function applyVcMeetingMemberProjection(
  dataDir: string,
  input: VcMeetingMemberProjectionInput,
  now = Date.now(),
): VcMeetingProjectionResult {
  const normalizedInstructions = normalizeVcMeetingProfileInstructions(input.instructions);
  if (!normalizedInstructions.ok) return { ok: false, reason: 'invalid' };
  const policy = normalizeVcMeetingMemberPolicy({
    memberId: input.memberId,
    role: input.role,
    membershipGeneration: input.membershipGeneration,
    responseMode: input.responseMode,
    filter: input.filter,
    capabilities: input.capabilities,
    ownedSinks: input.ownedSinks,
    sinkOwnerGeneration: input.sinkOwnerGeneration,
  });
  if (
    !nonEmpty(
      input.listenerAppId,
      input.meetingId,
      input.ownerBootId,
      input.memberId,
      input.agentAppId,
      input.role,
      input.receiverSessionId,
      input.outputChatId,
    )
    || !Number.isInteger(input.memberEpoch) || input.memberEpoch < 1
    || !Number.isInteger(input.membershipGeneration) || input.membershipGeneration < 1
    || !Number.isInteger(input.ownerEpoch) || input.ownerEpoch < 1
    || !Number.isInteger(input.joinedAtIngestSeq) || input.joinedAtIngestSeq < 0
    || !(['active', 'paused', 'removed'] as const).includes(input.status)
    || !(['silent', 'listener_thread'] as const).includes(input.responseMode)
    || !policy
  ) {
    return { ok: false, reason: 'invalid' };
  }

  // Persist only canonical policy snapshots/instructions. This also materializes the exact
  // MA-P0 legacy defaults so subsequent comparisons never depend on omitted
  // JSON fields.
  input = { ...input, ...policy };
  if (normalizedInstructions.instructions === undefined) delete input.instructions;
  else input.instructions = normalizedInstructions.instructions;

  return mutateState<VcMeetingProjectionResult>(dataDir, input.listenerAppId, input.meetingId, { createIfMissing: true, now }, (state) => {
    // createIfMissing 保证 state 存在
    const s = state!;

    // owner fencing：projection 可以抬高 ownerEpoch 高水位；旧 epoch 拒绝。
    // 同 epoch 换 bootId = 同一 owner daemon 重启，接受并更新（fencing 锚在 epoch，§13）。
    if (input.ownerEpoch < s.owner.ownerEpoch) {
      return {
        result: {
          ok: false as const,
          reason: 'stale_owner_epoch' as const,
          detail: `ownerEpoch ${input.ownerEpoch} < ${s.owner.ownerEpoch}`,
        },
      };
    }
    // 同 epoch 内 boot 防回退：A→B 顶替后 A 进退休名单，A 的迟到 projection
    // 重放（哪怕同 generation 同内容的「幂等」形态）不得把 owner 改回 A——
    // 否则 B 的后续新 delivery 全被 stale_owner_boot 卡死、A 的旧在途反而放行。
    // 该检查必须先于下方一切幂等/内容判断。
    if (input.ownerEpoch === s.owner.ownerEpoch
      && (s.owner.retiredBootIds ?? []).includes(input.ownerBootId)) {
      return {
        result: {
          ok: false as const,
          reason: 'stale_owner_boot' as const,
          detail: `ownerBootId ${input.ownerBootId} was retired within ownerEpoch ${input.ownerEpoch}`,
        },
      };
    }

    const member = s.members[input.memberId] ?? {
      maxKnownEpoch: 0,
      generationHighWater: 0,
      projections: {},
    };

    // member epoch fencing：低于已知最大 epoch 的投影 = 迟到的旧世代，拒绝。
    if (input.memberEpoch < member.maxKnownEpoch) {
      return {
        result: {
          ok: false as const,
          reason: 'stale_member_epoch' as const,
          detail: `memberEpoch ${input.memberEpoch} < ${member.maxKnownEpoch}`,
        },
      };
    }

    // generation fencing：高水位单调。同 generation 允许幂等重放。
    if (input.membershipGeneration < member.generationHighWater) {
      return {
        result: {
          ok: false as const,
          reason: 'stale_membership_generation' as const,
          detail: `membershipGeneration ${input.membershipGeneration} < ${member.generationHighWater}`,
        },
      };
    }

    // removed epoch 永久失效（§10.1）：同 epoch 只接受 removed 状态的幂等重放。
    const prior = member.projections[String(input.memberEpoch)];
    if (prior?.status === 'removed' && input.status !== 'removed') {
      return { result: { ok: false as const, reason: 'epoch_removed' as const } };
    }

    // 同 (memberEpoch, membershipGeneration)：同内容 = 幂等重放（owner 字段可刷新，
    // 覆盖 owner daemon 重启场景）；异内容 = 冲突——generation 不抬就不允许改写
    // agent / session / status 等 member 语义。
    if (prior && input.membershipGeneration === prior.membershipGeneration
      && !projectionContentEquals(input, prior)) {
      return {
        result: {
          ok: false as const,
          reason: 'projection_conflict' as const,
          detail: `generation ${input.membershipGeneration} already registered with different content`,
        },
      };
    }

    if (prior
      && (input.sinkOwnerGeneration ?? 0) < (prior.sinkOwnerGeneration ?? 0)) {
      return {
        result: {
          ok: false as const,
          reason: 'stale_sink_owner_generation' as const,
          detail: `sinkOwnerGeneration ${input.sinkOwnerGeneration} < ${prior.sinkOwnerGeneration}`,
        },
      };
    }
    const sinkOwnershipChanged = !vcMeetingCanonicalStringListsEqual(
      input.ownedSinks ?? [],
      prior?.ownedSinks ?? [],
    );
    if (prior && sinkOwnershipChanged
      && (input.sinkOwnerGeneration ?? 0) <= (prior.sinkOwnerGeneration ?? 0)) {
      return {
        result: {
          ok: false as const,
          reason: 'stale_sink_owner_generation' as const,
          detail: 'ownedSinks changed without advancing sinkOwnerGeneration',
        },
      };
    }

    // Once generation advances, control-plane fields may change, but agent /
    // role / stream start / receiver session / output route define the stream itself.
    // Never rebind an old cursor or frozen receipt; allocate a fresh epoch.
    if (prior && !projectionStreamIdentityEquals(input, prior)) {
      return {
        result: {
          ok: false as const,
          reason: 'epoch_required' as const,
          detail: `member stream identity changed within memberEpoch ${input.memberEpoch}`,
        },
      };
    }

    const record: VcMeetingMemberProjectionRecord = {
      ...input,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    member.projections[String(input.memberEpoch)] = record;
    member.maxKnownEpoch = Math.max(member.maxKnownEpoch, input.memberEpoch);
    member.generationHighWater = Math.max(member.generationHighWater, input.membershipGeneration);
    s.members[input.memberId] = member;
    if (input.ownerEpoch > s.owner.ownerEpoch) {
      // epoch 抬高：新任期从零开始，旧 epoch 的 boot 整体被 stale_owner_epoch
      // 挡住，退休名单归零。
      s.owner = { ownerEpoch: input.ownerEpoch, ownerBootId: input.ownerBootId, retiredBootIds: [] };
    } else if (input.ownerBootId !== s.owner.ownerBootId) {
      // 同 epoch 顶替：永久退休该任期内被换下的 boot。会议期内数量极小，
      // 不能用有界 FIFO 让第 17 个迟到 boot 构造性复活。
      const retired = s.owner.retiredBootIds ?? [];
      if (s.owner.ownerBootId && !retired.includes(s.owner.ownerBootId)) {
        retired.push(s.owner.ownerBootId);
      }
      s.owner = { ownerEpoch: input.ownerEpoch, ownerBootId: input.ownerBootId, retiredBootIds: retired };
    }

    return { result: { ok: true as const, record }, write: s };
  });
}

export function getVcMeetingMemberProjection(
  dataDir: string,
  key: VcMeetingMemberKey,
): VcMeetingMemberProjectionRecord | undefined {
  const state = readStateFile(meetingFilePath(dataDir, key.listenerAppId, key.meetingId));
  return state?.members[key.memberId]?.projections[String(key.memberEpoch)];
}

export function listVcMeetingMemberProjections(
  dataDir: string,
  scope: { listenerAppId: string; meetingId: string },
): VcMeetingMemberProjectionRecord[] {
  const state = readStateFile(meetingFilePath(dataDir, scope.listenerAppId, scope.meetingId));
  if (!state) return [];
  const out: VcMeetingMemberProjectionRecord[] = [];
  for (const member of Object.values(state.members)) {
    out.push(...Object.values(member.projections));
  }
  return out.sort((a, b) => a.memberId.localeCompare(b.memberId) || a.memberEpoch - b.memberEpoch);
}

// ─── delivery accept（§9.4 规则 1-6）────────────────────────────────────────

export function acceptVcMeetingDelivery(
  dataDir: string,
  input: VcMeetingDeliveryAcceptInput,
  now = Date.now(),
): VcMeetingDeliveryAcceptResult {
  if (
    !nonEmpty(input.listenerAppId, input.meetingId, input.memberId, input.deliveryKey, input.inputHash, input.receiverBootId, input.ownerBootId)
    || !Number.isInteger(input.fromSeq) || input.fromSeq < 1
    || !Number.isInteger(input.toSeq) || input.toSeq < input.fromSeq
    || (input.responseMode !== 'silent' && input.responseMode !== 'listener_thread')
  ) {
    return { kind: 'conflict', reason: 'invalid' };
  }

  return mutateState<VcMeetingDeliveryAcceptResult>(dataDir, input.listenerAppId, input.meetingId, { createIfMissing: false, now }, (state) => {
    // projection 必须先于 delivery 到达（§9.1）；没有会议状态 = 没注册过任何 member。
    if (!state) return { result: { kind: 'conflict' as const, reason: 'unknown_member' as const } };

    // owner fencing：delivery 无权抬高高水位（§9.1）。旧 epoch 拒绝；
    // 比投影更新的 epoch 说明新 owner 还没 re-register，先拒等 projection。
    // ownerEpoch fencing 对同 key 恢复也不放开——跨 epoch 的 frozen envelope
    // 属于上一任 owner 任期，必须由新任期重新决策。
    if (input.ownerEpoch < state.owner.ownerEpoch) {
      return { result: { kind: 'conflict' as const, reason: 'stale_owner_epoch' as const } };
    }
    if (input.ownerEpoch > state.owner.ownerEpoch) {
      return { result: { kind: 'conflict' as const, reason: 'owner_epoch_not_registered' as const } };
    }

    const member = state.members[input.memberId];
    if (!member) return { result: { kind: 'conflict' as const, reason: 'unknown_member' as const } };
    if (input.memberEpoch < member.maxKnownEpoch) {
      return { result: { kind: 'conflict' as const, reason: 'stale_member_epoch' as const } };
    }
    const projection = member.projections[String(input.memberEpoch)];
    if (!projection) return { result: { kind: 'conflict' as const, reason: 'unknown_member' as const } };
    if (projection.status === 'removed') {
      return { result: { kind: 'conflict' as const, reason: 'membership_removed' as const } };
    }
    if (projection.status === 'paused') {
      return { result: { kind: 'conflict' as const, reason: 'membership_paused' as const } };
    }

    const sk = streamKey(input.memberId, input.memberEpoch);
    let stream = state.streams[sk];
    if (stream?.abandoned) {
      return { result: { kind: 'conflict' as const, reason: 'stream_abandoned' as const } };
    }
    if (stream?.poisoned) {
      return {
        result: {
          kind: 'conflict' as const,
          reason: 'stream_poisoned' as const,
          activeDeliveryKey: stream.poisoned.deliveryKey,
          receiverCommittedThrough: stream.receiverCommittedThrough,
        },
      };
    }

    // 1. 同 key frozen recovery（§9.3 冻结 envelope）：receipt 已存在且 inputHash
    //    一致时，这是 hub 重发它崩溃前冻结的同一份 assignment——envelope 里的
    //    ownerBootId / membershipGeneration 是冻结时的历史值，不拿来与当前高水位
    //    比较，否则 owner 重启（换 bootId）或 generation bump 会把 active head
    //    永久卡死：同 key 被 stale 拒、重铸新 key 又 delivery_in_flight。
    //    恢复的前置条件已在上方校验：同 ownerEpoch、该 memberEpoch 仍是当前
    //    epoch 且 active、stream 未 abandoned；再要求 receiver session 绑定未变。
    //    异 hash 永远是冲突（§10.3）。
    const existing = stream?.receipts[input.deliveryKey];
    if (existing && stream) {
      if (existing.inputHash !== input.inputHash) {
        return {
          result: {
            kind: 'conflict' as const,
            reason: 'input_mismatch' as const,
            receipt: existing,
            receiverCommittedThrough: stream.receiverCommittedThrough,
          },
        };
      }
      if (stream.receiverSessionId !== projection.receiverSessionId) {
        return {
          result: {
            kind: 'conflict' as const,
            reason: 'receiver_session_changed' as const,
            receipt: existing,
            receiverCommittedThrough: stream.receiverCommittedThrough,
          },
        };
      }
      return {
        result: {
          kind: 'existing' as const,
          receipt: existing,
          receiverCommittedThrough: stream.receiverCommittedThrough,
        },
      };
    }

    // ── 以下 fencing 只作用于「新 key」：新 delivery 必须携带当前注册值。──
    // 同 ownerEpoch 下 boot fencing：owner daemon 重启会 re-register 刷新 bootId，
    // 崩溃前旧 boot 的在途新 delivery 携带旧 assignment 状态，必须 stale 拒绝。
    if (input.ownerBootId !== state.owner.ownerBootId) {
      return { result: { kind: 'conflict' as const, reason: 'stale_owner_boot' as const } };
    }
    // generation fencing：同 owner fencing，新 delivery 只能携带已注册的当前值。
    if (input.membershipGeneration < member.generationHighWater) {
      return { result: { kind: 'conflict' as const, reason: 'stale_membership_generation' as const } };
    }
    if (input.membershipGeneration > member.generationHighWater) {
      return { result: { kind: 'conflict' as const, reason: 'membership_generation_not_registered' as const } };
    }

    if (!stream) {
      stream = {
        listenerAppId: input.listenerAppId,
        meetingId: input.meetingId,
        memberId: input.memberId,
        memberEpoch: input.memberEpoch,
        receiverSessionId: projection.receiverSessionId,
        receiverCommittedThrough: 0,
        receipts: {},
        createdAt: now,
        updatedAt: now,
      };
      state.streams[sk] = stream;
    }

    // 2. 整批已在 cursor 之下：duplicate（§9.4 规则 3）。
    if (input.toSeq <= stream.receiverCommittedThrough) {
      return {
        result: { kind: 'duplicate' as const, receiverCommittedThrough: stream.receiverCommittedThrough },
      };
    }

    // 3. stream head 已被非终态 receipt 占用：不同 key 一律 delivery_in_flight（§9.3 冻结）。
    if (stream.activeDeliveryKey) {
      const active = stream.receipts[stream.activeDeliveryKey];
      if (active && !TERMINAL_RECEIPT_STATUSES.has(active.status)) {
        return {
          result: {
            kind: 'conflict' as const,
            reason: 'delivery_in_flight' as const,
            activeDeliveryKey: stream.activeDeliveryKey,
            receiverCommittedThrough: stream.receiverCommittedThrough,
          },
        };
      }
    }

    // 4. 连续前缀（§9.4 规则 4）：partial overlap 严格 409，不裁剪——整批共用
    //    一份 instruction / inputHash，裁掉前缀就不是原 turn。
    const expectedFrom = stream.receiverCommittedThrough + 1;
    if (input.fromSeq <= stream.receiverCommittedThrough) {
      return {
        result: {
          kind: 'conflict' as const,
          reason: 'delivery_partial_overlap' as const,
          receiverCommittedThrough: stream.receiverCommittedThrough,
          expectedFromSeq: expectedFrom,
        },
      };
    }
    if (input.fromSeq > expectedFrom) {
      return {
        result: {
          kind: 'conflict' as const,
          reason: 'delivery_gap' as const,
          receiverCommittedThrough: stream.receiverCommittedThrough,
          expectedFromSeq: expectedFrom,
        },
      };
    }

    // 5. durable accept（§9.4 规则 6 前半）：先落 receipt 再由调用方 dispatch。
    const receipt: VcMeetingDeliveryReceiptRecord = {
      deliveryKey: input.deliveryKey,
      stableTurnId: input.deliveryKey,
      inputHash: input.inputHash,
      fromSeq: input.fromSeq,
      toSeq: input.toSeq,
      final: input.final === true,
      responseMode: input.responseMode,
      sinkOwnerGeneration: projection.sinkOwnerGeneration,
      status: 'accepted',
      receiverBootId: input.receiverBootId,
      workerGeneration: 0,
      dispatchAttempt: 0,
      ambiguousReplayCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    stream.receipts[input.deliveryKey] = receipt;
    stream.activeDeliveryKey = input.deliveryKey;
    stream.updatedAt = now;

    return {
      result: {
        kind: 'accepted' as const,
        receipt,
        receiverCommittedThrough: stream.receiverCommittedThrough,
      },
      write: state,
    };
  });
}

// ─── receipt 状态转移 ────────────────────────────────────────────────────────

interface TransitionInput extends VcMeetingMemberKey {
  deliveryKey: string;
}

function transitionReceipt(
  dataDir: string,
  key: TransitionInput,
  now: number,
  fn: (
    stream: VcMeetingReceiverStreamRecord,
    receipt: VcMeetingDeliveryReceiptRecord,
  ) => VcMeetingDeliveryTransitionResult,
): VcMeetingDeliveryTransitionResult {
  return mutateState<VcMeetingDeliveryTransitionResult>(dataDir, key.listenerAppId, key.meetingId, { createIfMissing: false, now }, (state) => {
    const stream = state?.streams[streamKey(key.memberId, key.memberEpoch)];
    if (!state || !stream) return { result: { ok: false as const, reason: 'unknown_stream' as const } };
    const receipt = stream.receipts[key.deliveryKey];
    if (!receipt) return { result: { ok: false as const, reason: 'unknown_receipt' as const } };
    const result = fn(stream, receipt);
    if (result.ok && !result.noop) {
      receipt.updatedAt = now;
      stream.updatedAt = now;
      return { result, write: state };
    }
    return { result };
  });
}

/**
 * accepted / ambiguous / failed_* → dispatched。每次调用代表一次真实派发：
 * dispatchAttempt+1，记录当前 receiverBootId / workerGeneration（§9.5）。
 * 重试预算由调用方掌握；store 只保证转移合法并如实记账。
 */
export function markVcMeetingDeliveryDispatched(
  dataDir: string,
  key: TransitionInput,
  input: { receiverBootId: string; workerGeneration: number },
  now = Date.now(),
): VcMeetingDeliveryTransitionResult {
  return transitionReceipt(dataDir, key, now, (stream, receipt) => {
    if (receipt.status === 'dispatched') {
      return { ok: false, reason: 'already_dispatched', receipt };
    }
    if (receipt.status !== 'accepted' && receipt.status !== 'ambiguous'
      && receipt.status !== 'failed_retryable' && receipt.status !== 'failed_terminal') {
      return { ok: false, reason: 'invalid_transition', receipt };
    }
    if (stream.abandoned) return { ok: false, reason: 'stream_abandoned', receipt };
    receipt.status = 'dispatched';
    receipt.receiverBootId = input.receiverBootId;
    receipt.workerGeneration = input.workerGeneration;
    receipt.dispatchAttempt += 1;
    receipt.dispatchedAt = now;
    delete receipt.manualRetryAuthorizedAtAttempt;
    delete receipt.errorCode;
    return { ok: true, receipt, receiverCommittedThrough: stream.receiverCommittedThrough };
  });
}

/**
 * turn_terminal(completed) → 原子写 completed + 推进 receiverCommittedThrough
 * 到 toSeq（§9.4 规则 7）。携带 workerGeneration / dispatchAttempt 时校验与
 * receipt 记录一致——旧派发的迟到 terminal 不得结算新派发（§9.5）。
 * ambiguous → completed 仅在世代匹配时允许（terminal 在重启判定后迟到）。
 */
export function completeVcMeetingDelivery(
  dataDir: string,
  key: TransitionInput,
  input: { workerGeneration?: number; dispatchAttempt?: number } = {},
  now = Date.now(),
): VcMeetingDeliveryTransitionResult {
  return transitionReceipt(dataDir, key, now, (stream, receipt) => {
    if (receipt.status === 'completed') {
      // 幂等：重复 terminal 不再改状态。
      return { ok: true, receipt, receiverCommittedThrough: stream.receiverCommittedThrough, noop: true };
    }
    if (receipt.status !== 'dispatched' && receipt.status !== 'ambiguous') {
      return { ok: false, reason: 'invalid_transition', receipt };
    }
    if (input.dispatchAttempt !== undefined && input.dispatchAttempt !== receipt.dispatchAttempt) {
      return { ok: false, reason: 'stale_dispatch_attempt', receipt };
    }
    if (input.workerGeneration !== undefined && input.workerGeneration !== receipt.workerGeneration) {
      return { ok: false, reason: 'stale_worker_generation', receipt };
    }
    if (receipt.status === 'ambiguous'
      && (input.dispatchAttempt === undefined || input.workerGeneration === undefined)) {
      // ambiguous 的迟到 terminal 必须自证来自哪次派发，否则不能结算。
      return { ok: false, reason: 'invalid_transition', receipt };
    }
    receipt.status = 'completed';
    stream.receiverCommittedThrough = receipt.toSeq;
    if (stream.activeDeliveryKey === receipt.deliveryKey) delete stream.activeDeliveryKey;
    return { ok: true, receipt, receiverCommittedThrough: stream.receiverCommittedThrough };
  });
}

/**
 * dispatched（或 accepted：dispatch 前同步失败）→ failed_retryable / failed_terminal。
 * cursor 不动，activeDeliveryKey 保留——同 key 重派（§9.4 规则 9）。
 *
 * 无证据（workerGeneration / dispatchAttempt 均缺席）的 fail 只允许从
 * accepted 转移：它只可能来自「dispatch 前同步失败」。同 key 的并发派发里，
 * 另一路可能已经 markDispatched 在飞——一份不带世代证据的失败上报无权
 * 打掉 in-flight 派发（否则其 terminal 到达时 invalid_transition，触发
 * 一轮多余的 hub 重发）。
 */
export function failVcMeetingDelivery(
  dataDir: string,
  key: TransitionInput,
  input: {
    kind: 'retryable' | 'terminal';
    errorCode?: string;
    workerGeneration?: number;
    dispatchAttempt?: number;
    /** Atomically fence the stream after the bounded retry budget is exhausted. */
    pauseStream?: boolean;
  },
  now = Date.now(),
): VcMeetingDeliveryTransitionResult {
  return transitionReceipt(dataDir, key, now, (stream, receipt) => {
    if (receipt.status !== 'dispatched' && receipt.status !== 'accepted' && receipt.status !== 'ambiguous'
      && !(receipt.status === 'failed_retryable' && input.kind === 'terminal')
      && !(receipt.status === 'failed_terminal' && input.kind === 'terminal' && input.pauseStream)) {
      return { ok: false, reason: 'invalid_transition', receipt };
    }
    if (input.workerGeneration === undefined && input.dispatchAttempt === undefined
      && receipt.status !== 'accepted') {
      return { ok: false, reason: 'invalid_transition', receipt };
    }
    if (input.dispatchAttempt !== undefined && input.dispatchAttempt !== receipt.dispatchAttempt) {
      return { ok: false, reason: 'stale_dispatch_attempt', receipt };
    }
    if (input.workerGeneration !== undefined && input.workerGeneration !== receipt.workerGeneration) {
      return { ok: false, reason: 'stale_worker_generation', receipt };
    }
    receipt.status = input.kind === 'retryable' ? 'failed_retryable' : 'failed_terminal';
    if (input.errorCode) receipt.errorCode = input.errorCode;
    if (input.pauseStream) {
      if (input.kind !== 'terminal') return { ok: false, reason: 'invalid_transition', receipt };
      stream.poisoned = {
        deliveryKey: receipt.deliveryKey,
        at: now,
        reason: input.errorCode ?? 'retry_budget_exhausted',
      };
    }
    return { ok: true, receipt, receiverCommittedThrough: stream.receiverCommittedThrough };
  });
}

/**
 * Authorize exactly one additional dispatch of a poison head. The envelope is
 * not stored for privacy, so the hub must re-POST the same deliveryKey/hash
 * after this transition. The authorization is durable and consumed atomically
 * by markVcMeetingDeliveryDispatched.
 */
export function authorizeVcMeetingDeliveryManualRetry(
  dataDir: string,
  key: TransitionInput,
  now = Date.now(),
): VcMeetingDeliveryTransitionResult {
  return transitionReceipt(dataDir, key, now, (stream, receipt) => {
    if (stream.abandoned) return { ok: false, reason: 'stream_abandoned', receipt };
    if (!stream.poisoned || stream.poisoned.deliveryKey !== receipt.deliveryKey) {
      return { ok: false, reason: 'stream_not_poisoned', receipt };
    }
    if (receipt.status !== 'failed_terminal') {
      return { ok: false, reason: 'invalid_transition', receipt };
    }
    receipt.manualRetryAuthorizedAtAttempt = receipt.dispatchAttempt;
    delete stream.poisoned;
    return { ok: true, receipt, receiverCommittedThrough: stream.receiverCommittedThrough };
  });
}

/** dispatched → ambiguous（lease 到期 / worker 丢失，§10.3）。审计计数 +1。 */
export function markVcMeetingDeliveryAmbiguous(
  dataDir: string,
  key: TransitionInput,
  input: { workerGeneration?: number; dispatchAttempt?: number } = {},
  now = Date.now(),
): VcMeetingDeliveryTransitionResult {
  return transitionReceipt(dataDir, key, now, (stream, receipt) => {
    if (receipt.status === 'ambiguous') {
      return { ok: true, receipt, receiverCommittedThrough: stream.receiverCommittedThrough, noop: true };
    }
    if (receipt.status !== 'dispatched') {
      return { ok: false, reason: 'invalid_transition', receipt };
    }
    if (input.dispatchAttempt !== undefined && input.dispatchAttempt !== receipt.dispatchAttempt) {
      return { ok: false, reason: 'stale_dispatch_attempt', receipt };
    }
    if (input.workerGeneration !== undefined && input.workerGeneration !== receipt.workerGeneration) {
      return { ok: false, reason: 'stale_worker_generation', receipt };
    }
    receipt.status = 'ambiguous';
    receipt.ambiguousReplayCount += 1;
    return { ok: true, receipt, receiverCommittedThrough: stream.receiverCommittedThrough };
  });
}

/**
 * 人工放弃整条 stream（§10.3 manual abandon）：非终态 active receipt →
 * abandoned，写耐久 AbandonedStream 标记；cursor 不动、不篡改。该 epoch 此后
 * 拒绝一切新 delivery，继续只能走新 epoch + from-now。
 */
export function abandonVcMeetingDeliveryStream(
  dataDir: string,
  key: VcMeetingMemberKey,
  input: { reason?: string } = {},
  now = Date.now(),
): { ok: true; stream: VcMeetingReceiverStreamRecord } | { ok: false; reason: 'unknown_stream' } {
  return mutateState<{ ok: true; stream: VcMeetingReceiverStreamRecord } | { ok: false; reason: 'unknown_stream' }>(dataDir, key.listenerAppId, key.meetingId, { createIfMissing: false, now }, (state) => {
    const stream = state?.streams[streamKey(key.memberId, key.memberEpoch)];
    if (!state || !stream) return { result: { ok: false as const, reason: 'unknown_stream' as const } };
    if (stream.abandoned) return { result: { ok: true as const, stream } };
    stream.abandoned = { at: now, ...(input.reason ? { reason: input.reason } : {}) };
    if (stream.activeDeliveryKey) {
      const active = stream.receipts[stream.activeDeliveryKey];
      if (active && !TERMINAL_RECEIPT_STATUSES.has(active.status)) {
        active.status = 'abandoned';
        active.updatedAt = now;
      }
      delete stream.activeDeliveryKey;
    }
    stream.updatedAt = now;
    return { result: { ok: true as const, stream }, write: state };
  });
}

// ─── 重启恢复（§9.5）────────────────────────────────────────────────────────

export interface VcMeetingAmbiguousReceiptRef extends VcMeetingMemberKey {
  deliveryKey: string;
  receiverSessionId: string;
  workerGeneration: number;
  dispatchAttempt: number;
  ambiguousReplayCount: number;
}

/**
 * daemon 启动时调用：本 agent 名下所有「dispatched 且 receiverBootId != 当前
 * boot」的 receipt 判为 ambiguous（旧世代无 terminal，§9.5），允许同 key 重派。
 * accepted 未派发的保持 accepted——从未进过 worker，直接派发即可。
 *
 * agentAppId 是硬 scope：dataDir 在多 bot 部署下是全 daemon 进程共享的
 * （SESSION_DATA_DIR / 包内默认目录），一场会议里其它 agent bot 的 in-flight
 * receipt 也躺在同一批文件里。只处理 projection.agentAppId 归属本 daemon 的
 * stream，否则任何一个 bot 重启都会把别的 bot 正在飞的派发误标 ambiguous。
 * 找不到对应 projection 的 stream 一律不动——没有归属证据就没有处置权。
 */
export function reconcileVcMeetingDeliveriesOnBoot(
  dataDir: string,
  input: { receiverBootId: string; agentAppId: string },
  now = Date.now(),
): VcMeetingAmbiguousReceiptRef[] {
  const dir = join(dataDir, DIR_NAME);
  if (!existsSync(dir)) return [];
  const affected: VcMeetingAmbiguousReceiptRef[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const fp = join(dir, name);
    withFileLockSync(fp, () => {
      const state = readStateFileForMutation(fp);
      if (!state) return;
      let changed = false;
      for (const stream of Object.values(state.streams)) {
        const projection = state.members[stream.memberId]?.projections[String(stream.memberEpoch)];
        if (projection?.agentAppId !== input.agentAppId) continue;
        const active = stream.activeDeliveryKey ? stream.receipts[stream.activeDeliveryKey] : undefined;
        if (!active || active.status !== 'dispatched') continue;
        if (active.receiverBootId === input.receiverBootId) continue;
        active.status = 'ambiguous';
        active.ambiguousReplayCount += 1;
        active.updatedAt = now;
        stream.updatedAt = now;
        changed = true;
        affected.push({
          listenerAppId: stream.listenerAppId,
          meetingId: stream.meetingId,
          memberId: stream.memberId,
          memberEpoch: stream.memberEpoch,
          deliveryKey: active.deliveryKey,
          receiverSessionId: stream.receiverSessionId,
          workerGeneration: active.workerGeneration,
          dispatchAttempt: active.dispatchAttempt,
          ambiguousReplayCount: active.ambiguousReplayCount,
        });
      }
      if (changed) writeStateFile(fp, state, now);
    });
  }
  return affected;
}

/**
 * 运行期 lease 到期扫描（§10.3）：本 agent 名下「dispatched 且距最近一次
 * markDispatched 超过 leaseMs」的 receipt 转 ambiguous——覆盖 worker 活着但
 * turn 永远不 terminal 的卡流（submit 静默失败、CLI 卡死等 boot reconcile
 * 与 exit 回调都到不了的场景）。daemon watchdog 周期调用。
 *
 * - agent scope 同 reconcileOnBoot：只处理 projection.agentAppId 匹配的
 *   stream，共享 dataDir 下不越权处置别的 bot 的在途派发。
 * - 锁内读到的 workerGeneration / dispatchAttempt 即本次到期处置的对象；
 *   转移后同 key 重派会 bump attempt，旧派发的迟到 terminal 被世代证据拒。
 * - 幂等：已 ambiguous / 已 terminal / 未到期 / 别的 agent 一律不动，
 *   重复调用返回空增量。
 * - lease 时间锚 = dispatchedAt（老记录缺席时以 updatedAt 兜底——dispatched
 *   期间没有其它转移刷新它，两者等价）。
 */
export function expireVcMeetingDeliveryLeases(
  dataDir: string,
  input: { agentAppId: string; leaseMs: number },
  now = Date.now(),
): VcMeetingAmbiguousReceiptRef[] {
  if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0 || !input.agentAppId.trim()) return [];
  const dir = join(dataDir, DIR_NAME);
  if (!existsSync(dir)) return [];
  const affected: VcMeetingAmbiguousReceiptRef[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const fp = join(dir, name);
    withFileLockSync(fp, () => {
      const state = readStateFileForMutation(fp);
      if (!state) return;
      let changed = false;
      for (const stream of Object.values(state.streams)) {
        const projection = state.members[stream.memberId]?.projections[String(stream.memberEpoch)];
        if (projection?.agentAppId !== input.agentAppId) continue;
        const active = stream.activeDeliveryKey ? stream.receipts[stream.activeDeliveryKey] : undefined;
        if (!active || active.status !== 'dispatched') continue;
        const anchoredAt = active.dispatchedAt ?? active.updatedAt;
        if (now - anchoredAt <= input.leaseMs) continue;
        active.status = 'ambiguous';
        active.ambiguousReplayCount += 1;
        active.updatedAt = now;
        stream.updatedAt = now;
        changed = true;
        affected.push({
          listenerAppId: stream.listenerAppId,
          meetingId: stream.meetingId,
          memberId: stream.memberId,
          memberEpoch: stream.memberEpoch,
          deliveryKey: active.deliveryKey,
          receiverSessionId: stream.receiverSessionId,
          workerGeneration: active.workerGeneration,
          dispatchAttempt: active.dispatchAttempt,
          ambiguousReplayCount: active.ambiguousReplayCount,
        });
      }
      if (changed) writeStateFile(fp, state, now);
    });
  }
  return affected;
}

// ─── 查询与清理 ──────────────────────────────────────────────────────────────

export function getVcMeetingDeliveryReceipt(
  dataDir: string,
  key: VcMeetingMemberKey,
  deliveryKey: string,
): { receipt: VcMeetingDeliveryReceiptRecord; receiverCommittedThrough: number } | undefined {
  const state = readStateFile(meetingFilePath(dataDir, key.listenerAppId, key.meetingId));
  const stream = state?.streams[streamKey(key.memberId, key.memberEpoch)];
  const receipt = stream?.receipts[deliveryKey];
  if (!stream || !receipt) return undefined;
  return { receipt, receiverCommittedThrough: stream.receiverCommittedThrough };
}

export function getVcMeetingReceiverStream(
  dataDir: string,
  key: VcMeetingMemberKey,
): VcMeetingReceiverStreamRecord | undefined {
  const state = readStateFile(meetingFilePath(dataDir, key.listenerAppId, key.meetingId));
  return state?.streams[streamKey(key.memberId, key.memberEpoch)];
}

export interface VcMeetingDeliveryLookupResult {
  memberKey: VcMeetingMemberKey;
  receiverSessionId: string;
  receipt: VcMeetingDeliveryReceiptRecord;
  receiverCommittedThrough: number;
}

/**
 * 按 deliveryKey 全局反查 receipt——`GET /deliveries/:deliveryKey` 与
 * `turn_terminal(sessionId, turnId=deliveryKey)` 都只有 key 没有 member
 * tuple，daemon 需要反查出要推进哪条 stream。deliveryKey 的派生含
 * meeting/member/epoch（§9.3），全局唯一，首个命中即答案。
 *
 * terminal 路径传 `receiverSessionId` 做绑定校验：key 命中但 session 不符
 * 返回 undefined（宁可 ambiguous 也不结算错流）。线性扫描短 TTL metadata
 * 文件，量级 = 活跃会议数；需要时后续再加索引。
 */
export function findVcMeetingDeliveryByKey(
  dataDir: string,
  deliveryKey: string,
  opts: { receiverSessionId?: string } = {},
): VcMeetingDeliveryLookupResult | undefined {
  if (!deliveryKey.trim()) return undefined;
  const dir = join(dataDir, DIR_NAME);
  if (!existsSync(dir)) return undefined;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const state = readStateFile(join(dir, name));
    if (!state) continue;
    for (const stream of Object.values(state.streams)) {
      const receipt = stream.receipts[deliveryKey];
      if (!receipt) continue;
      if (opts.receiverSessionId !== undefined && stream.receiverSessionId !== opts.receiverSessionId) {
        return undefined;
      }
      return {
        memberKey: {
          listenerAppId: stream.listenerAppId,
          meetingId: stream.meetingId,
          memberId: stream.memberId,
          memberEpoch: stream.memberEpoch,
        },
        receiverSessionId: stream.receiverSessionId,
        receipt,
        receiverCommittedThrough: stream.receiverCommittedThrough,
      };
    }
  }
  return undefined;
}

/**
 * Enumerate the non-terminal stream heads bound to one receiver session.
 *
 * Worker exit handling uses this reverse lookup because the exit signal carries
 * a session id (and worker generation), not the meeting/member tuple. Only the
 * durable `activeDeliveryKey` is considered: completed/abandoned receipts have
 * released the stream head and must never be made ambiguous by a later worker
 * exit. The caller still filters by receipt status/generation before applying a
 * transition (for example, only `dispatched` receipts can become ambiguous).
 */
export function listActiveVcMeetingDeliveriesForSession(
  dataDir: string,
  receiverSessionId: string,
): VcMeetingDeliveryLookupResult[] {
  if (!receiverSessionId.trim()) return [];
  const dir = join(dataDir, DIR_NAME);
  if (!existsSync(dir)) return [];

  const out: VcMeetingDeliveryLookupResult[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const state = readStateFile(join(dir, name));
    if (!state) continue;
    for (const stream of Object.values(state.streams)) {
      if (stream.receiverSessionId !== receiverSessionId || !stream.activeDeliveryKey) continue;
      const receipt = stream.receipts[stream.activeDeliveryKey];
      if (!receipt || TERMINAL_RECEIPT_STATUSES.has(receipt.status)) continue;
      out.push({
        memberKey: {
          listenerAppId: stream.listenerAppId,
          meetingId: stream.meetingId,
          memberId: stream.memberId,
          memberEpoch: stream.memberEpoch,
        },
        receiverSessionId: stream.receiverSessionId,
        receipt,
        receiverCommittedThrough: stream.receiverCommittedThrough,
      });
    }
  }

  return out.sort((a, b) =>
    a.memberKey.listenerAppId.localeCompare(b.memberKey.listenerAppId)
    || a.memberKey.meetingId.localeCompare(b.memberKey.meetingId)
    || a.memberKey.memberId.localeCompare(b.memberKey.memberId)
    || a.memberKey.memberEpoch - b.memberKey.memberEpoch
    || a.receipt.deliveryKey.localeCompare(b.receipt.deliveryKey));
}

/**
 * 按 receiverSessionId 全局反查「当前有效」的 membership projection——
 * status === 'active' 且 memberEpoch 是该 member 的最新 epoch（换代后旧 epoch
 * 的投影残留不算数）。daemon 用它判断一个 botmux 会话是否绑定为 durable
 * meeting consumer（例如 silent responseMode 下对 `botmux send` 强制拒发）。
 *
 * 返回数组而非单条：MA-P0 的 chat-scope 兼容会话可能被先后多场会议复用，
 * TTL 清理前同一 session 可挂多个 active projection；调用方按 responseMode
 * 自行归并判断。只读、无锁（与其它读路径一致的快照语义）。
 */
export function listVcMeetingActiveProjectionsForReceiverSession(
  dataDir: string,
  receiverSessionId: string,
): VcMeetingMemberProjectionRecord[] {
  if (!receiverSessionId.trim()) return [];
  const dir = join(dataDir, DIR_NAME);
  if (!existsSync(dir)) return [];

  const out: VcMeetingMemberProjectionRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const state = readStateFile(join(dir, name));
    if (!state) continue;
    for (const member of Object.values(state.members)) {
      const current = member.projections[String(member.maxKnownEpoch)];
      if (!current || current.status !== 'active') continue;
      if (current.receiverSessionId !== receiverSessionId) continue;
      out.push(current);
    }
  }

  return out.sort((a, b) =>
    a.listenerAppId.localeCompare(b.listenerAppId)
    || a.meetingId.localeCompare(b.meetingId)
    || a.memberId.localeCompare(b.memberId)
    || a.memberEpoch - b.memberEpoch);
}

/**
 * TTL 清理：整场会议粒度删除。保留期下限由调用方保证 ≥
 * max(hub assignment TTL, meeting runtime TTL, sender retry horizon) + 时钟偏移
 * （§9.3）——低于该值 GET 404 会被误当 never-accept 证据。
 */
export function pruneVcMeetingDeliveryState(
  dataDir: string,
  input: { ttlMs: number },
  now = Date.now(),
): number {
  const dir = join(dataDir, DIR_NAME);
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const fp = join(dir, name);
    withFileLockSync(fp, () => {
      const state = readStateFile(fp);
      if (!state) return;
      if (now - state.updatedAt <= input.ttlMs) return;
      rmSync(fp, { force: true });
      removed += 1;
    });
  }
  return removed;
}
