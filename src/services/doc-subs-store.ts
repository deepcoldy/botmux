/**
 * 飞书文档订阅注册表 —— 把「一个被订阅的文档」绑到「一条会话」。
 *
 * 设计约束（申晗拍板）：
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
  /** 文档标题快照（best-effort，用于卡片 / dashboard 展示）。 */
  docTitle?: string;
  /** 发起订阅的用户 open_id。 */
  ownerOpenId?: string;
  createdAt: number;
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
