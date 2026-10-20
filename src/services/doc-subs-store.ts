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

/**
 * 评论触发范围：
 * - mention-only：仅评论里 @ 了本机器人时触发（靠飞书 WS 推送，飞书只推 @bot 的评论）。
 * - owner-mention：仅评论里 @ 了**订阅负责人**（sub.ownerOpenId）时触发，类似替身：
 *   别人在文档里 @ 负责人，bot 代为响应。飞书不会把「@ 了别人、没 @bot」的评论推给
 *   应用，所以本模式与 all 一样靠应用身份**轮询**，只是投递前多一道 owner 提及过滤。
 * - all：该文档所有新评论都触发（同样走轮询）。
 */
export type CommentTriggerMode = 'mention-only' | 'owner-mention' | 'all';

/**
 * 哪些模式需要应用身份**轮询**评论列表（而非只等飞书 WS 推送）。
 * mention-only 只覆盖 @bot（WS 已推送）；owner-mention 与 all 都要靠轮询才能读到
 * 「没 @bot」的评论，因此共用轮询游标与基线。切进/切出这组模式时基线语义一致。
 */
export function isPollingDocTriggerMode(mode: CommentTriggerMode | undefined): boolean {
  return mode === 'all' || mode === 'owner-mention';
}

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

  // ─── 运行态可观测（只读展示，不参与任何路由/授权判定） ──────────────────
  // 游标/pending 是**功能状态**（丢了会重放/漏评论），这一组是**诊断快照**
  // （丢了只是看不见），所以写入规则刻意不同：诊断写失败一律 best-effort 咽掉。
  // 全部 optional：旧记录没有这些字段，读到 undefined 是正常态，UI 显示「—」。

  /** 最近一次评论事件/轮询**尝试**处理该文档的时刻（ms）。是尝试，不是成功。 */
  lastActivityAt?: number;
  /** 最近一次尝试的结局，取值与 processCommentEvent 各出口 / poller 对应。 */
  lastOutcome?: DocWatchOutcome;
  /** `lastOutcome` 的补充说明（异常 message）。仅诊断，不参与判定。 */
  lastError?: string;
  /** 最近一次真正投递给会话（lastOutcome==='dispatched'）的时刻（ms）。 */
  lastDispatchAt?: number;
  /** 累计投递成功次数：分辨「配好了没触发过」与「一直在用」。 */
  dispatchCount?: number;

  // ─── auto-sub 溯源（这条是不是「陌生人 @ 一下自动建出来的」） ────────
  /** true = 由文档里的 @bot 自动创建（非 owner 主动登记）。 */
  autoCreated?: boolean;
  /** 触发 auto-sub 的人的 open_id（即 parsed.operatorOpenId）。 */
  autoCreatedBy?: string;
  /** auto-sub 创建时刻（ms）。 */
  autoCreatedAt?: number;
}

/** 见 {@link DocSubscription.lastOutcome}。 */
export type DocWatchOutcome =
  | 'dispatched'
  | 'no-comment'
  | 'trigger-missing'
  | 'empty-text'
  | 'not-mentioned'
  | 'self-authored'
  | 'audit-rejected'
  | 'poll-failed';

const DOC_WATCH_OUTCOMES: ReadonlySet<string> = new Set<DocWatchOutcome>([
  'dispatched', 'no-comment', 'trigger-missing', 'empty-text',
  'not-mentioned', 'self-authored', 'audit-rejected', 'poll-failed',
]);

/** 收窄未知字符串到 `DocWatchOutcome`。读旧文件/跨版本时用。 */
export function asDocWatchOutcome(raw: unknown): DocWatchOutcome | undefined {
  return typeof raw === 'string' && DOC_WATCH_OUTCOMES.has(raw)
    ? raw as DocWatchOutcome
    : undefined;
}

/** `lastError` 落盘上限，避免一条长报错把订阅表撑大。 */
export const DOC_WATCH_LAST_ERROR_MAX = 300;

/**
 * 运行态诊断字段（{@link recordDocWatchActivity} 写的那一组）。描述**这篇文档的
 * 投递历史**，重新登记（换绑定/改模式/改目录）时应延续。刻意**不含** autoCreated*
 * 溯源三字段——那三个描述「这一行怎么产生」，重新登记可能改变它（owner 接管后
 * 不再是 auto-sub），必须由写入方显式决定，不能盲目继承。
 */
const RUNTIME_DIAGNOSTIC_KEYS = [
  'lastActivityAt', 'lastOutcome', 'lastError', 'lastDispatchAt', 'dispatchCount',
] as const satisfies ReadonlyArray<keyof DocSubscription>;

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
/**
 * 新增 / 覆盖一条订阅（fileToken 主键）。显式绑定模式下会覆盖旧会话绑定；
 * 文档原生 watch 模式下只覆盖文档级监听配置。返回旧订阅供调用方提示。
 *
 * 默认整行覆盖（只额外保住未决 WS 投递，那是功能状态不能丢）。
 * `inheritRuntime: true` 时再把上一行的**运行态诊断字段**补进新行（仅当新行未
 * 显式给出）——「重新登记同一篇文档」的路径用它，换绑定不代表投递历史归零。
 * 溯源三字段（autoCreated*）刻意不在此列，由写入方自己传。
 */
export function putDocSubscription(
  dataDir: string,
  larkAppId: string,
  sub: DocSubscription,
  opts?: { inheritRuntime?: boolean },
): { previous?: DocSubscription } {
  const data = readFile(dataDir, larkAppId);
  const previous = data[sub.fileToken];
  const next: DocSubscription = { ...sub };
  // 未决 WS 投递是功能状态：调用方没显式带时一律保住，不能因一次重写而丢重试队列。
  if (previous?.pendingDocCommentDeliveries && next.pendingDocCommentDeliveries === undefined) {
    next.pendingDocCommentDeliveries = previous.pendingDocCommentDeliveries;
  }
  if (opts?.inheritRuntime && previous) {
    for (const key of RUNTIME_DIAGNOSTIC_KEYS) {
      if (next[key] === undefined && previous[key] !== undefined) {
        (next as unknown as Record<string, unknown>)[key] = previous[key];
      }
    }
  }
  data[sub.fileToken] = next;
  writeFile(dataDir, larkAppId, data);
  return { previous };
}

/**
 * 记一条运行态诊断快照。**绝不抛、绝不影响调用方控制流**：调用点全在评论事件 /
 * poller 热路径，这些字段只是给人看，「记不下诊断」不能升级成一条真实评论投递
 * 失败。读后写而非接受整条 sub，避免调用方的旧快照覆盖掉别处刚推进的游标/pending/
 * mode。订阅已被删除（退订/auto-sub 回滚）时直接不写，不复活不存在的行。
 */
export function recordDocWatchActivity(
  dataDir: string,
  larkAppId: string,
  fileToken: string,
  patch: {
    outcome: DocWatchOutcome;
    at?: number;
    error?: string;
  },
): boolean {
  try {
    const data = readFile(dataDir, larkAppId);
    const sub = data[fileToken];
    if (!sub) return false;
    const at = patch.at ?? Date.now();
    sub.lastActivityAt = at;
    sub.lastOutcome = patch.outcome;
    if (patch.error) {
      sub.lastError = patch.error.slice(0, DOC_WATCH_LAST_ERROR_MAX);
    } else {
      // 成功/正常丢弃时清掉旧报错，否则一条早已修好的错误会永远挂在界面上。
      delete sub.lastError;
    }
    if (patch.outcome === 'dispatched') {
      sub.lastDispatchAt = at;
      sub.dispatchCount = (sub.dispatchCount ?? 0) + 1;
    }
    writeFile(dataDir, larkAppId, data);
    return true;
  } catch {
    return false; // 诊断字段，写不进去就算了，绝不影响评论投递
  }
}

/** 补记文档标题快照（best-effort）。标题没变时不写盘，避免每条评论都重写文件。 */
export function setDocTitle(
  dataDir: string,
  larkAppId: string,
  fileToken: string,
  title: string,
): boolean {
  const trimmed = title.trim();
  if (!trimmed) return false;
  try {
    const data = readFile(dataDir, larkAppId);
    const sub = data[fileToken];
    if (!sub || sub.docTitle === trimmed) return false;
    sub.docTitle = trimmed;
    writeFile(dataDir, larkAppId, data);
    return true;
  } catch {
    return false;
  }
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
