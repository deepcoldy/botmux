/**
 * 飞书文档订阅注册表 —— 保存「一个被订阅的文档」的监听配置和可选会话绑定。
 *
 * 设计约束（设计拍板）：
 *   • 显式绑定的监听仍指向一条既有会话，一条会话可订阅多个文档。
 *   • 无群聊绑定的 watch-comment 只保存文档级监听配置；运行时按 commentId
 *     创建独立文档原生会话，避免同一文档的并发评论互相合并。
 *
 * 文件按观察者 app 隔离（`doc-subscriptions-<larkAppId>.json`）：飞书 open_id /
 * 文档可见性都是 per-app 的，且生产是「一 bot 一 daemon」，per-app 文件让每个
 * daemon 只读写自己那份，互不串。
 *
 * 写者只有 daemon 进程本身（命令处理 / 事件 / dashboard-IPC 都在 daemon 内），
 * 单写者，原子写（唯一 tmp + rename）即可，无需跨进程锁。
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

/** 评论触发范围：仅 @bot 的评论触发 / 该文档所有新评论都触发。 */
export type CommentTriggerMode = 'mention-only' | 'all';

/** 已通过 WS 的 @/审计门、但 daemon 尚未接纳的评论投递。 */
export interface PendingDocCommentDelivery {
  commentId: string;
  replyId?: string;
  text: string;
  selectedText?: string;
  priorReplies?: Array<{ authorOpenId?: string; text: string }>;
  isWhole?: boolean;
  authorOpenId?: string;
  queuedAt: number;
  /** Delivery crossed the daemon admission boundary; --all keeps this marker until cursor commit. */
  acceptedAt?: number;
}

export interface DocSubscription {
  /** 解析后的底层文档 token（wiki 已换成 obj_token）。主键。 */
  fileToken: string;
  /** 飞书 file_type（docx 等）—— 调评论 / 订阅 API 都要带。 */
  fileType: string;
  /** 显式绑定的会话锚点；文档原生 watch 使用独立的 `doc:{fileToken}:watch`。 */
  sessionAnchor: string;
  /** 显式绑定会话的 sessionId。文档原生 watch 不绑定 session；旧记录会迁移清除。 */
  sessionId?: string;
  /** 会话 scope —— 重订阅 / 落点路由时要知道。 */
  scope: 'thread' | 'chat';
  /** 显式绑定的群；文档原生 watch 与 sessionAnchor 同为内部 watch 地址。 */
  chatId: string;
  /** 评论触发范围。dashboard 可改。 */
  commentTriggerMode: CommentTriggerMode;
  /**
   * 记录由哪个用户命令族管理：
   *   - subscribe-lark-doc：远端既有的逐文件 API 订阅流程
   *   - watch-comment：评论监听 / 自动会话 / 审批流程
   * 旧记录没有该字段，按 subscribe-lark-doc 兼容处理。
   */
  managedBy?: 'subscribe-lark-doc' | 'watch-comment';
  /** 文档标题快照（best-effort，用于卡片 / dashboard 展示）。 */
  docTitle?: string;
  /** 发起订阅的用户 open_id。 */
  ownerOpenId?: string;
  /** 该文档绑定的本地仓库/目录。agent 在此目录下运行（auto-create session 时使用）。 */
  workingDir?: string;
  /** `/watch-comment --all` 应用身份轮询游标（飞书时间戳，秒）。 */
  pollCursorAt?: number;
  /** 同一秒内用 reply_id 打破平局，避免漏掉连续评论。 */
  pollCursorReplyId?: string;
  /** 首次成功读取已建立历史基线；false 时只建基线、不触发历史评论。 */
  pollBaselineReady?: boolean;
  /** WS 已 ACK 但 worker 尚未接纳的评论；daemon 轮询周期负责持久重试。 */
  pendingDocCommentDeliveries?: PendingDocCommentDelivery[];
  createdAt: number;
}

export function docWatchAnchor(fileToken: string): string {
  return `doc:${fileToken}:watch`;
}

export function docCommentThreadAnchor(fileToken: string, commentId: string): string {
  return `doc:${fileToken}:${commentId}`;
}

export function isDocNativeWatchSubscription(sub: DocSubscription): boolean {
  const legacyAnchor = `doc:${sub.fileToken}`;
  const watchAnchor = docWatchAnchor(sub.fileToken);
  return sub.managedBy === 'watch-comment'
    && sub.scope === 'chat'
    && (sub.sessionAnchor === legacyAnchor || sub.sessionAnchor === watchAnchor)
    && (sub.chatId === legacyAnchor || sub.chatId === watchAnchor);
}

/** Separate the document watch from both legacy and per-comment sessions. */
export function normalizeDocNativeWatchSubscription(sub: DocSubscription): DocSubscription {
  if (!isDocNativeWatchSubscription(sub)) return sub;
  const watchAnchor = docWatchAnchor(sub.fileToken);
  if (!sub.sessionId && sub.sessionAnchor === watchAnchor && sub.chatId === watchAnchor) return sub;
  return {
    ...sub,
    sessionAnchor: watchAnchor,
    sessionId: undefined,
    scope: 'chat',
    chatId: watchAnchor,
  };
}

type FileShape = Record<string, DocSubscription>;

function filePath(dataDir: string, larkAppId: string): string {
  return join(dataDir, `doc-subscriptions-${larkAppId}.json`);
}

function readFile(dataDir: string, larkAppId: string): FileShape {
  const fp = filePath(dataDir, larkAppId);
  if (!existsSync(fp)) return {};
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as FileShape;
  } catch { /* corrupt — 当空处理 */ }
  return {};
}

function writeFile(dataDir: string, larkAppId: string, data: FileShape): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  atomicWriteFileSync(filePath(dataDir, larkAppId), JSON.stringify(data, null, 2) + '\n');
}

/**
 * 新增 / 覆盖一条订阅（fileToken 主键）。显式绑定模式下会覆盖旧会话绑定；
 * 文档原生 watch 模式下只覆盖文档级监听配置。返回旧订阅供调用方提示。
 */
export function putDocSubscription(
  dataDir: string,
  larkAppId: string,
  sub: DocSubscription,
): { previous?: DocSubscription } {
  const data = readFile(dataDir, larkAppId);
  const previous = data[sub.fileToken];
  data[sub.fileToken] = previous?.pendingDocCommentDeliveries
    && sub.pendingDocCommentDeliveries === undefined
    ? { ...sub, pendingDocCommentDeliveries: previous.pendingDocCommentDeliveries }
    : sub;
  writeFile(dataDir, larkAppId, data);
  return { previous };
}

/** 取某文档的订阅（评论事件来后据 fileToken 定位会话）。无则 null。 */
export function getDocSubscription(
  dataDir: string,
  larkAppId: string,
  fileToken: string,
): DocSubscription | null {
  return readFile(dataDir, larkAppId)[fileToken] ?? null;
}

/** 删一条订阅，返回被删的那条（无则 undefined）。 */
export function removeDocSubscription(
  dataDir: string,
  larkAppId: string,
  fileToken: string,
): DocSubscription | undefined {
  const data = readFile(dataDir, larkAppId);
  const removed = data[fileToken];
  if (!removed) return undefined;
  delete data[fileToken];
  writeFile(dataDir, larkAppId, data);
  return removed;
}

/** 列某会话锚点上的所有订阅（/doc list、/close 退订时用）。 */
export function listDocSubscriptionsForSession(
  dataDir: string,
  larkAppId: string,
  sessionAnchor: string,
): DocSubscription[] {
  return Object.values(readFile(dataDir, larkAppId)).filter(s => s.sessionAnchor === sessionAnchor);
}

/** 列本 app 下全部订阅（daemon 重启恢复 + dashboard 展示）。 */
export function listAllDocSubscriptions(dataDir: string, larkAppId: string): DocSubscription[] {
  return Object.values(readFile(dataDir, larkAppId));
}

/** 改某文档订阅的触发范围（dashboard）。返回是否命中。 */
export function setCommentTriggerMode(
  dataDir: string,
  larkAppId: string,
  fileToken: string,
  mode: CommentTriggerMode,
): boolean {
  const data = readFile(dataDir, larkAppId);
  const sub = data[fileToken];
  if (!sub) return false;
  sub.commentTriggerMode = mode;
  writeFile(dataDir, larkAppId, data);
  return true;
}

/** 更新 `/watch-comment --all` 的持久化轮询游标。 */
export function setDocCommentPollCursor(
  dataDir: string,
  larkAppId: string,
  fileToken: string,
  cursor: { createdAt: number; replyId: string } | undefined,
  baselineReady = true,
): boolean {
  const data = readFile(dataDir, larkAppId);
  const sub = data[fileToken];
  if (!sub) return false;
  sub.pollCursorAt = cursor?.createdAt;
  sub.pollCursorReplyId = cursor?.replyId;
  sub.pollBaselineReady = baselineReady;
  writeFile(dataDir, larkAppId, data);
  return true;
}

function pendingDeliveryKey(delivery: Pick<PendingDocCommentDelivery, 'commentId' | 'replyId'>): string {
  return delivery.replyId || delivery.commentId;
}

/** Persist one WS delivery that must survive daemon restart until accepted. */
export function upsertPendingDocCommentDelivery(
  dataDir: string,
  larkAppId: string,
  fileToken: string,
  delivery: PendingDocCommentDelivery,
): boolean {
  const data = readFile(dataDir, larkAppId);
  const sub = data[fileToken];
  if (!sub) return false;
  const pending = sub.pendingDocCommentDeliveries ?? [];
  const key = pendingDeliveryKey(delivery);
  const index = pending.findIndex(candidate => pendingDeliveryKey(candidate) === key);
  if (index >= 0) {
    const existing = pending[index]!;
    pending[index] = existing.acceptedAt !== undefined && delivery.acceptedAt === undefined
      ? { ...delivery, acceptedAt: existing.acceptedAt }
      : delivery;
  } else pending.push(delivery);
  sub.pendingDocCommentDeliveries = pending;
  writeFile(dataDir, larkAppId, data);
  return true;
}

/** Record or clear one WS delivery according to its final daemon admission. */
export function settleDocCommentWsDelivery(
  dataDir: string,
  larkAppId: string,
  fileToken: string,
  delivery: PendingDocCommentDelivery,
  accepted: boolean,
): 'accepted' | 'queued' | 'stopped' {
  const sub = getDocSubscription(dataDir, larkAppId, fileToken);
  if (!sub) return 'stopped';
  if (accepted) {
    if (sub.managedBy === 'watch-comment' && sub.commentTriggerMode === 'all') {
      upsertPendingDocCommentDelivery(dataDir, larkAppId, fileToken, {
        ...delivery,
        acceptedAt: Date.now(),
      });
    } else {
      removePendingDocCommentDelivery(dataDir, larkAppId, fileToken, delivery);
    }
    return 'accepted';
  }
  return upsertPendingDocCommentDelivery(dataDir, larkAppId, fileToken, delivery)
    ? 'queued'
    : 'stopped';
}

/** Atomically advance the --all cursor and retire the exact accepted pending marker. */
export function commitDocCommentPollCursor(
  dataDir: string,
  larkAppId: string,
  fileToken: string,
  cursor: { createdAt: number; replyId: string },
  opts: { clearAcceptedBaseline?: boolean } = {},
): boolean {
  const data = readFile(dataDir, larkAppId);
  const sub = data[fileToken];
  if (!sub) return false;
  sub.pollCursorAt = cursor.createdAt;
  sub.pollCursorReplyId = cursor.replyId;
  sub.pollBaselineReady = true;
  const pending = sub.pendingDocCommentDeliveries ?? [];
  const next = opts.clearAcceptedBaseline
    ? pending.filter(candidate => candidate.acceptedAt === undefined)
    : pending.filter(candidate => pendingDeliveryKey(candidate) !== cursor.replyId);
  if (next.length > 0) sub.pendingDocCommentDeliveries = next;
  else delete sub.pendingDocCommentDeliveries;
  writeFile(dataDir, larkAppId, data);
  return true;
}

/** Remove one accepted/stopped WS delivery. */
export function removePendingDocCommentDelivery(
  dataDir: string,
  larkAppId: string,
  fileToken: string,
  delivery: Pick<PendingDocCommentDelivery, 'commentId' | 'replyId'>,
): boolean {
  const data = readFile(dataDir, larkAppId);
  const sub = data[fileToken];
  if (!sub) return false;
  const key = pendingDeliveryKey(delivery);
  const pending = (sub.pendingDocCommentDeliveries ?? [])
    .filter(candidate => pendingDeliveryKey(candidate) !== key);
  if (pending.length === (sub.pendingDocCommentDeliveries?.length ?? 0)) return false;
  if (pending.length > 0) sub.pendingDocCommentDeliveries = pending;
  else delete sub.pendingDocCommentDeliveries;
  writeFile(dataDir, larkAppId, data);
  return true;
}
