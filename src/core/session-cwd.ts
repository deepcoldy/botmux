/**
 * Shared helper for repinning a topic session's working directory.
 * Extracted from the `/cd` command handler so the upcoming dashboard IPC
 * `cd` route (Task 9) can reuse the exact same daemon-record write path.
 */
import type { DaemonSession } from './types.js';
import * as sessionStore from '../services/session-store.js';

/**
 * 重钉一个话题会话的工作目录（daemon 记录 = 唯一事实源）：
 * 内存（ds.workingDir / ds.session.workingDir）+ sessions 文件落盘。
 * 注意统一存 resolvedPath（修正 /cd 历史行为：曾存用户原始输入如 "~/x"，
 * 现改为 validateWorkingDir 产出的已展开/已归一化绝对路径）。
 */
export function repinSessionWorkingDir(ds: DaemonSession, resolvedPath: string): void {
  ds.workingDir = resolvedPath;
  ds.session.workingDir = resolvedPath;
  // cwd 变了，riff 多仓 stamp（选择卡多选时写入）随之失效——保留会让下次
  // refork 仍按旧仓库组合推导、无视新目录。IM /cd 与 IPC cd 路由共用本函数，
  // 两条改 cwd 的路径都必须清。
  ds.session.riffRepoDirs = undefined;
  sessionStore.updateSession(ds.session);
}
