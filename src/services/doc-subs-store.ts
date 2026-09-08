/**
 * 飞书文档订阅注册表 —— 把「一个被订阅的文档」绑到「一条会话」。
 *
 * 设计约束（设计拍板）：
 *   • 一条会话可订阅多个文档（N 行同 sessionAnchor）。
 *   • **一个文档只绑一条活跃会话**：本表以 fileToken 为主键，重复订阅直接覆盖，
 *     天然保证「一条评论事件只命中一条会话」。
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

export interface DocSubscription {
  /** 解析后的底层文档 token（wiki 已换成 obj_token）。主键。 */
  fileToken: string;
  /** 飞书 file_type（docx 等）—— 调评论 / 订阅 API 都要带。 */
  fileType: string;
  /** 绑定会话的路由锚点：thread-scope=rootMessageId / chat-scope=chatId。 */
  sessionAnchor: string;
  /** 绑定会话的 sessionId。daemon 重启恢复时据此查持久化会话状态判定保留/退订
   *  （不依赖内存 activeSessions，避免误删活跃会话的订阅）。旧订阅可能缺此字段。 */
  sessionId?: string;
  /** 会话 scope —— 重订阅 / 落点路由时要知道。 */
  scope: 'thread' | 'chat';
  /** 会话所在群（回飞书侧卡片、dashboard 展示用）。 */
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
  createdAt: number;

  // ─── 运行态可观测（只读展示，不参与任何路由/授权判定） ──────────────────
  //
  // 为什么和上面的 pollCursor* 分开：游标是**功能状态**（丢了会重放/漏评论），
  // 这一组是**诊断快照**（丢了只是看不见）。所以它们的写入规则刻意不同 ——
  // 诊断字段的写入失败一律 best-effort 咽掉，绝不能让「记不下日志」阻断一条
  // 真实的评论投递；而游标写入失败必须让调用方知道。
  //
  // ⚠️ 全部 optional：线上已有订阅记录（实测 1 条）没有这些字段，读到 undefined
  // 是正常态，不是「异常」。UI 必须能渲染「—」而不是崩掉或显示 NaN/1970。

  /** 最近一次评论事件/轮询**尝试**处理该文档的时刻（ms）。注意是尝试，不是成功。 */
  lastActivityAt?: number;
  /**
   * 最近一次尝试的结局。取值刻意与 `processCommentEvent` 的各个出口一一对应，
   * 便于把「为什么没回复」直接读出来，而不用去翻 daemon 日志：
   *   • 'dispatched'      —— 过了所有闸，已喂给会话（成功）
   *   • 'no-comment'      —— 拉不到评论正文
   *   • 'trigger-missing' —— 触发回复不在拉到的回复串里（分页未补全）
   *   • 'empty-text'      —— 纯 @bot 无正文
   *   • 'not-mentioned'   —— mention-only 但没 @ 到本 bot（最常见的正常丢弃）
   *   • 'self-authored'   —— bot 自己的回复，自触发拦截
   *   • 'audit-rejected'  —— 非 owner 触发且通知 owner 失败，审计门拒绝
   *   • 'poll-failed'     —— 轮询读取该文档失败
   */
  lastOutcome?: DocWatchOutcome;
  /** `lastOutcome` 的补充说明（如异常 message）。仅诊断，不参与判定。 */
  lastError?: string;
  /** 最近一次真正投递给会话（lastOutcome==='dispatched'）的时刻（ms）。 */
  lastDispatchAt?: number;
  /** 累计投递成功次数。用来分辨「配好了但从没触发过」与「一直在用」。 */
  dispatchCount?: number;

  // ─── auto-sub 溯源（这条订阅是不是「陌生人 @ 一下自动建出来的」） ────────
  //
  // 为什么必须单独记：`processCommentEvent` 里陌生人 @bot 会**自动**建一条
  // mention-only 订阅，owner 只在当时收到一条 DM，事后没有任何界面能复查。
  // 这两个字段就是给 dashboard 提供「这条是谁 @ 出来的、什么时候」的凭据，
  // 让 owner 能事后审计而不是只能凭那条 DM 的记忆。

  /** true = 由文档里的 @bot 自动创建（非 owner 主动 /watch-comment 登记）。 */
  autoCreated?: boolean;
  /** 触发 auto-sub 的那个人的 open_id（即 `parsed.operatorOpenId`）。 */
  autoCreatedBy?: string;
  /** auto-sub 创建时刻（ms）。与 createdAt 分开：重绑定会保留原 createdAt。 */
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

/** `lastError` 落盘上限。评论正文/接口报错可能很长，截断避免把订阅表撑大。 */
export const DOC_WATCH_LAST_ERROR_MAX = 300;

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
 * 新增 / 覆盖一条订阅（fileToken 主键 → 重订阅覆盖旧绑定 = 1 文档:1 会话）。
 * 返回被覆盖掉的旧订阅（如果该文档此前绑在别的会话上），调用方据此退订旧的 /
 * 提示用户。
 */
export function putDocSubscription(
  dataDir: string,
  larkAppId: string,
  sub: DocSubscription,
): { previous?: DocSubscription } {
  const data = readFile(dataDir, larkAppId);
  const previous = data[sub.fileToken];
  data[sub.fileToken] = sub;
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

/**
 * 记一条运行态诊断快照（`lastActivityAt` / `lastOutcome` / …）。
 *
 * ⚠️ **绝不抛异常，也绝不影响调用方的控制流**。这是刻意的：调用点全在
 * `processCommentEvent` / poller 的热路径上，而这些字段只是给人看的。如果
 * 「记不下诊断」能让一条真实评论投递失败，那这个可观测特性就成了新的故障源
 * —— 比没有它更糟。所以返回值只表示「记上了没」，调用方一律忽略即可。
 *
 * 同样刻意的是它**读后写**而不是接受整条 sub：调用方手里的 `sub` 可能是几十毫秒前
 * 的快照（auto-sub 占位、poller 的 snapshot），拿它整体覆盖会把这期间别处的合法
 * 修改（比如 dashboard 刚改的 mode、poller 刚推进的游标）悄悄回退掉。
 * 订阅已被删除（退订/回滚）时直接不写 —— 不要把一条已经不存在的订阅复活。
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
      // 成功/正常丢弃时清掉上一次的错误，否则一条早已修好的旧报错会永远挂在
      // 界面上，让人以为现在还坏着。
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
