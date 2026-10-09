/**
 * 多副本运行所需的最小持久协调合同。
 *
 * 这里刻意只描述语义，不绑定数据库、消息平台或部署系统。调用方负责把平台事件
 * 规范化为 JSON payload；实现负责幂等、租约、fencing 和可恢复状态迁移。
 *
 * 所有时间戳均为 Unix epoch 毫秒。租约判断必须使用 store 自己的权威时钟：本地实现
 * 使用注入时钟，远程数据库实现应在事务内使用数据库时间，不能信任不同 worker 的墙钟。
 */

export const DURABLE_COORDINATION_CONTRACT_VERSION = 1 as const;

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
 * 合同刻意把 inbox claim 与 session lease 分开：inbox 的 partitionKey 保护原始
 * ingress 顺序，SessionLease 则保护解析后的逻辑 session 状态与输出。实现可以把两者
 * 放在同一数据库中，但调用方不能把 inbox claim 当作 session fencing token。
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

export interface DurableCoordinationStore
  extends DurableSessionLeaseStore, DurableSessionStateStore, DurableInboxStore, DurableOutboxStore {
  close(): Promise<void>;
}
