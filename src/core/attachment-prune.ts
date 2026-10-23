/**
 * 附件目录 TTL 回收。
 *
 * 入站消息的图片/文件/视频下载到 dataDir/attachments/<appId>/<messageId>/，
 * 仅供产生它的那一个 CLI turn 引用；turn 结束后没有后续读者，旧实现永不清理，
 * 随消息量线性增长（现网单个 app 桶已达 976MB，且私聊文件长期留存有隐私面）。
 *
 * 回收策略：daemon 启动时对整个 attachments 根做一次 sweep，删除最后修改时间
 * 超过 maxAgeMs 的 messageId 目录。按目录 mtime（目录内文件写入会更新它），
 * 不依赖消息 id 编码时间；appId 桶目录本身保留。默认 14 天——远长于任何 turn
 * 的生命周期，活跃会话绝不会引用到这么旧的下载。
 *
 * 例外：长期挂起的会话会把附件路径持久化下来，这类会话被无限期保护、
 * 不会被回收（见 session-mutation-guard），用户可能在 14 天之后才继续：
 *  - pendingRepoSetup.attachments：选仓卡挂起；
 *  - queuedAttachments：Dashboard backlog 待办（queued === true 同样被
 *    queued_todo 无限期保护），激活时原样注入首轮；
 *  - dashboardAttachments：Dashboard 创建会话时上传、活跃期间保留的图片。
 * 调用方用 collectProtectedAttachmentDirs 从会话快照收集这些仍被引用的
 * 目录，sweep 时跳过——即使它已经超过 TTL。
 *
 * 任何单个目录删除失败都跳过；不存在的根直接返回 0。fail-open，不阻断启动。
 */
import { readdirSync, statSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export const DEFAULT_ATTACHMENT_MAX_AGE_MS = 14 * 24 * 60 * 60_000;

export interface PruneAttachmentsResult {
  removedDirs: number;
  appBuckets: number;
}

/** 会话里持久化持有附件路径的最小结构。 */
type SessionWithProtectedAttachments = {
  pendingRepoSetup?: {
    attachments?: ReadonlyArray<{ path?: string }>;
  };
  queuedAttachments?: ReadonlyArray<{ path?: string }>;
  dashboardAttachments?: ReadonlyArray<{ path?: string }>;
};

/**
 * 从全部会话快照收集仍被持久化引用、TTL sweep 不得删除的附件 messageId
 * 目录（绝对路径）。三类持有者都是「路径持久化、重启后注入、会话被无限期
 * 保护」的同一机制，缺一个就留一个已知同型空洞。只接纳位于 attachmentsRoot
 * 之内的路径：根目录本身与根外路径都不保护，附件路径损坏不影响其余回收。
 */
export function collectProtectedAttachmentDirs(
  sessions: Iterable<SessionWithProtectedAttachments>,
  attachmentsRoot: string,
): Set<string> {
  const root = resolve(attachmentsRoot);
  const protectedDirs = new Set<string>();
  for (const session of sessions) {
    const holders: ReadonlyArray<{ path?: string }> = [
      ...(session.pendingRepoSetup?.attachments ?? []),
      ...(session.queuedAttachments ?? []),
      ...(session.dashboardAttachments ?? []),
    ];
    for (const attachment of holders) {
      if (!attachment.path) continue;
      const dir = resolve(dirname(attachment.path));
      if (dir === root) continue;
      const rel = relative(root, dir);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
      protectedDirs.add(dir);
    }
  }
  return protectedDirs;
}

export function pruneOldAttachments(
  attachmentsRoot: string,
  maxAgeMs: number = DEFAULT_ATTACHMENT_MAX_AGE_MS,
  now: () => number = () => Date.now(),
  protectedDirs: ReadonlySet<string> = new Set(),
): PruneAttachmentsResult {
  const root = resolve(attachmentsRoot);
  const protectedAbsolute = new Set(
    [...protectedDirs].map(dir => resolve(dir)),
  );
  let appBuckets: string[];
  try {
    appBuckets = readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return { removedDirs: 0, appBuckets: 0 };
  }

  const cutoff = now() - maxAgeMs;
  let removedDirs = 0;
  for (const appId of appBuckets) {
    const bucket = resolve(root, appId);
    let messageDirs: string[];
    try {
      messageDirs = readdirSync(bucket, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch {
      continue;
    }
    for (const messageId of messageDirs) {
      const dir = resolve(bucket, messageId);
      // 仍被选仓卡/backlog 待办等持久化状态引用的目录跳过，无论多旧——
      // 删了用户日后继续会话时注入的就是失效路径（静默降级）。
      if (protectedAbsolute.has(dir)) continue;
      try {
        if (statSync(dir).mtimeMs < cutoff) {
          rmSync(dir, { recursive: true, force: true });
          removedDirs += 1;
        }
      } catch {
        /* 单个旧目录删除失败不阻断其余回收 */
      }
    }
  }
  return { removedDirs, appBuckets: appBuckets.length };
}
