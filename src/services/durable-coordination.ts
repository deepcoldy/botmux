/**
 * 多副本运行所需的最小持久协调合同。
 *
 * 这里刻意只描述语义，不绑定数据库、消息平台或部署系统。调用方负责把平台事件
 * 规范化为 JSON payload；实现负责幂等、租约、fencing 和可恢复状态迁移。
 *
 * 所有时间戳均为 Unix epoch 毫秒。租约判断必须使用 store 自己的权威时钟：本地实现
 * 使用注入时钟，远程数据库实现应在事务内使用数据库时间，不能信任不同 worker 的墙钟。
 */

export const DURABLE_COORDINATION_CONTRACT_VERSION = 3 as const;
export const DURABLE_INBOX_LANE_LARK_MESSAGE = 'lark-message' as const;
export const DURABLE_INBOX_LANE_SESSION_CONTROL = 'session-control' as const;

export type DurableJson =
  | null
  | boolean
  | number
  | string
  | DurableJson[]
  | { [key: string]: DurableJson };

export type DurableInsertResult =
  | { kind: 'inserted' }
  | { kind: 'duplicate' }
  | { kind: 'conflict' };

export interface SessionLease {
  sessionKey: string;
  ownerId: string;
  /** 同一 session 上单调递增的 fencing token。 */
  epoch: number;
  leaseUntil: number;
}

export type SessionLeaseAcquisition =
  | { kind: 'acquired'; lease: SessionLease }
  | { kind: 'occupied'; ownerId: string; epoch: number; leaseUntil: number };

export interface AcquireSessionLeaseInput {
  sessionKey: string;
  /** 必须能区分 worker boot；进程重启不能复用旧 ownerId。 */
  ownerId: string;
  leaseDurationMs: number;
}

export interface RenewSessionLeaseInput {
  lease: SessionLease;
  leaseDurationMs: number;
}

export type LeaseMutationResult =
  | { kind: 'applied'; lease: SessionLease }
  | { kind: 'stale' };

export interface DurableSessionRecord {
  sessionKey: string;
  revision: number;
  value: DurableJson;
  updatedAt: number;
}

export interface WriteSessionInput {
  lease: SessionLease;
  /** `null` 表示只允许首次创建；数字表示 compare-and-set。 */
  expectedRevision: number | null;
  value: DurableJson;
}

export type WriteSessionResult =
  | { kind: 'written'; record: DurableSessionRecord }
  | { kind: 'conflict'; current?: DurableSessionRecord }
  | { kind: 'stale_lease' };

export interface DurableInboxEvent {
  /** 平台稳定事件键；同键不同 payload 必须返回 conflict。 */
  eventId: string;
  /** 隔离不同消费者；同一 lane 内才参与 claim 和 partition FIFO。 */
  lane?: string;
  /** 保序分区。它可以是原始 ingress lane，不要求已经解析出逻辑 session。 */
  partitionKey: string;
  payload: DurableJson;
  visibleAt: number;
  createdAt: number;
}

export interface InboxClaim {
  event: DurableInboxEvent;
  workerId: string;
  claimEpoch: number;
  claimUntil: number;
  attempts: number;
}

export interface ClaimInboxInput {
  workerId: string;
  lane?: string;
  /** 只 claim 当前 worker 可执行的分区；空数组表示没有可 claim 的 owner。 */
  partitionKeys?: string[];
  leaseDurationMs: number;
}

export interface RenewInboxClaimInput {
  claim: InboxClaim;
  leaseDurationMs: number;
}

export interface RetryInboxClaimInput {
  claim: InboxClaim;
  visibleAt: number;
}

export type InboxClaimMutationResult =
  | { kind: 'applied'; claim?: InboxClaim }
  | { kind: 'stale' };

export interface DurableOutboxMessage {
  /** 调用方生成的稳定投递键。 */
  messageId: string;
  sessionKey: string;
  payload: DurableJson;
  visibleAt: number;
  /** 仅用于观测和幂等窗口；同 Session FIFO 必须由 store 的插入序号决定。 */
  createdAt: number;
}

export type OutboxState =
  | 'pending'
  | 'reserved'
  | 'attempting'
  | 'ambiguous'
  | 'delivered';

export interface DurableOutboxRecord extends DurableOutboxMessage {
  state: OutboxState;
  originEpoch: number;
  attempts: number;
  receipt?: DurableJson;
  lastError?: string;
  updatedAt: number;
}

export interface OutboxReservation {
  record: DurableOutboxRecord;
  workerId: string;
  claimEpoch: number;
  claimUntil: number;
}

export interface OutboxAttempt extends OutboxReservation {
  attempt: number;
}

export interface EnqueueOutboxInput {
  lease: SessionLease;
  message: DurableOutboxMessage;
}

export interface ReserveOutboxInput {
  workerId: string;
  leaseDurationMs: number;
}

export interface BeginOutboxAttemptInput {
  reservation: OutboxReservation;
}

export interface CompleteOutboxAttemptInput {
  attempt: OutboxAttempt;
  receipt: DurableJson;
}

export interface RetryOutboxAttemptInput {
  attempt: OutboxAttempt;
  visibleAt: number;
  error: string;
}

export interface MarkOutboxAmbiguousInput {
  attempt: OutboxAttempt;
  error: string;
}

export type OutboxMutationResult =
  | { kind: 'applied'; record: DurableOutboxRecord }
  | { kind: 'stale' };

export type BeginOutboxAttemptResult =
  | { kind: 'applied'; record: DurableOutboxRecord; attempt: OutboxAttempt }
  | { kind: 'stale' };

/**
 * 会改变 Session 生命周期的外部副作用记录。
 *
 * `operationId` 是调用方为一次语义动作生成的稳定键。重投同一动作必须复用它；
 * 同键不同 session/payload 会被实现拒绝为 conflict。`pending` 尚未越过副作用
 * 边界，可以安全开始或重试；`attempting` 表示 provider 调用可能已经发生；
 * `ambiguous` 绝不能盲重放；`completed` 保存可供 canonical Session 提交使用的结果。
 */
export interface DurableControlOperation {
  operationId: string;
  sessionKey: string;
  payload: DurableJson;
  createdAt: number;
}

export type ControlOperationState =
  | 'pending'
  | 'attempting'
  | 'ambiguous'
  | 'completed';

export interface DurableControlOperationRecord extends DurableControlOperation {
  state: ControlOperationState;
  originEpoch: number;
  attempts: number;
  result?: DurableJson;
  /** 最近一次 backend 对账的结论与证据。 */
  reconciliation?: DurableJson;
  lastError?: string;
  updatedAt: number;
}

export interface EnqueueControlOperationInput {
  lease: SessionLease;
  operation: DurableControlOperation;
}

/**
 * 精确标识一次已经越过副作用边界的尝试。Session lease 后续失效时，只有这个
 * exact token 的迟到成功回执仍可把 attempting/ambiguous 结算为 completed。
 */
export interface ControlOperationAttempt {
  operationId: string;
  sessionKey: string;
  ownerId: string;
  leaseEpoch: number;
  attempt: number;
}

export interface BeginControlOperationAttemptInput {
  lease: SessionLease;
  operationId: string;
}

export type BeginControlOperationAttemptResult =
  | {
      kind: 'applied';
      record: DurableControlOperationRecord;
      attempt: ControlOperationAttempt;
    }
  | { kind: 'not_found' }
  | { kind: 'not_pending'; record: DurableControlOperationRecord }
  | { kind: 'stale_lease' };

export interface CompleteControlOperationAttemptInput {
  attempt: ControlOperationAttempt;
  result: DurableJson;
}

export interface RetryControlOperationAttemptInput {
  attempt: ControlOperationAttempt;
  /** 仅当 provider 明确证明请求未越过副作用边界时才允许 safe retry。 */
  error: string;
}

export interface MarkControlOperationAmbiguousInput {
  attempt: ControlOperationAttempt;
  error: string;
}

export type ControlOperationMutationResult =
  | { kind: 'applied'; record: DurableControlOperationRecord }
  | { kind: 'stale' };

export type ControlOperationReconciliationOutcome =
  | {
      kind: 'completed';
      result: DurableJson;
      /** backend 按稳定 operationId 回读出的非空、可审计证据。 */
      evidence: DurableJson;
    }
  | {
      kind: 'not_applied';
      /**
       * 必须证明旧 attempt 已终止且未来也不会生效；“暂时没查到”不是该证据。
       */
      evidence: DurableJson;
      error: string;
    };

export interface ReconcileControlOperationInput {
  lease: SessionLease;
  operationId: string;
  /** 防止旧对账结果覆盖后来已经开始的新 attempt。 */
  expectedAttempt: number;
  outcome: ControlOperationReconciliationOutcome;
}

export type ReconcileControlOperationResult =
  | { kind: 'applied'; record: DurableControlOperationRecord }
  | { kind: 'stale' }
  | { kind: 'stale_lease' };

/**
 * 合同刻意把 inbox claim 与 session lease 分开：inbox 的 partitionKey 保护原始
 * ingress 顺序，lane 隔离消息入口与 owner-routed control 等消费者，SessionLease 则保护
 * 解析后的逻辑 session 状态与输出。实现可以把它们放在同一数据库中，但调用方不能把
 * inbox claim 当作 session fencing token；control consumer 仍需单独验证 SessionLease。
 */
export interface DurableSessionLeaseStore {
  acquireSessionLease(input: AcquireSessionLeaseInput): Promise<SessionLeaseAcquisition>;
  renewSessionLease(input: RenewSessionLeaseInput): Promise<LeaseMutationResult>;
  releaseSessionLease(lease: SessionLease): Promise<LeaseMutationResult>;
}

export interface DurableSessionStateStore {
  readSession(sessionKey: string): Promise<DurableSessionRecord | undefined>;
  writeSession(input: WriteSessionInput): Promise<WriteSessionResult>;
}

export interface DurableInboxStore {
  enqueueInbox(event: DurableInboxEvent): Promise<DurableInsertResult>;
  claimNextInbox(input: ClaimInboxInput): Promise<InboxClaim | undefined>;
  renewInboxClaim(input: RenewInboxClaimInput): Promise<InboxClaimMutationResult>;
  completeInboxClaim(claim: InboxClaim): Promise<InboxClaimMutationResult>;
  retryInboxClaim(input: RetryInboxClaimInput): Promise<InboxClaimMutationResult>;
}

export interface DurableOutboxStore {
  enqueueOutbox(input: EnqueueOutboxInput): Promise<DurableInsertResult | { kind: 'stale_lease' }>;
  reserveNextOutbox(input: ReserveOutboxInput): Promise<OutboxReservation | undefined>;
  beginOutboxAttempt(input: BeginOutboxAttemptInput): Promise<BeginOutboxAttemptResult>;
  /** 精确 attempt 的 delivered receipt 可以结算 attempting 或 ambiguous。 */
  completeOutboxAttempt(input: CompleteOutboxAttemptInput): Promise<OutboxMutationResult>;
  /** 自动 safe-retry 只允许从 attempting 回到 pending；绝不能重开 ambiguous。 */
  retryOutboxAttempt(input: RetryOutboxAttemptInput): Promise<OutboxMutationResult>;
  /** 只有当前 attempting attempt 可以进入 ambiguous。 */
  markOutboxAmbiguous(input: MarkOutboxAmbiguousInput): Promise<OutboxMutationResult>;
  readOutbox(messageId: string): Promise<DurableOutboxRecord | undefined>;
}

export interface DurableControlOperationStore {
  enqueueControlOperation(
    input: EnqueueControlOperationInput,
  ): Promise<DurableInsertResult | { kind: 'stale_lease' }>;
  /**
   * 该调用就是副作用边界：调用方必须先完成所有本地 preflight，再调用它，然后
   * 最多执行一次 provider 请求。失去 Session lease 的旧 attempting 会先被冻结为
   * ambiguous，绝不会被新 owner 自动重开。
   */
  beginControlOperationAttempt(
    input: BeginControlOperationAttemptInput,
  ): Promise<BeginControlOperationAttemptResult>;
  completeControlOperationAttempt(
    input: CompleteControlOperationAttemptInput,
  ): Promise<ControlOperationMutationResult>;
  retryControlOperationAttempt(
    input: RetryControlOperationAttemptInput,
  ): Promise<ControlOperationMutationResult>;
  markControlOperationAmbiguous(
    input: MarkControlOperationAmbiguousInput,
  ): Promise<ControlOperationMutationResult>;
  /** ambiguous 只有拿到 backend 的稳定 operationId 对账证据后才能离开。 */
  reconcileControlOperation(
    input: ReconcileControlOperationInput,
  ): Promise<ReconcileControlOperationResult>;
  readControlOperation(operationId: string): Promise<DurableControlOperationRecord | undefined>;
}

export interface DurableCoordinationStore
  extends DurableSessionLeaseStore,
    DurableSessionStateStore,
    DurableInboxStore,
    DurableOutboxStore,
    DurableControlOperationStore {
  close(): Promise<void>;
}
