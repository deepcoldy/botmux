/**
 * 日志文件轮转：以 append 模式打开日志前，对超过大小上限的文件做一次滚动。
 *
 * 背景：fleet supervisor 把子进程 stdout/stderr 直接 append 到固定 fd，
 * 全程无大小上限、无 pm2 logrotate——高频 WARN（如曾连续 19 天的 230002）
 * 会把 error.log 写到几十 MB 直至吃满磁盘。写入时跟踪大小要侵入热路径且
 * 多进程下不准；在「每次（重）启动打开 fd 前」滚动一次即可把单个文件钉在
 * 有界大小：daemon 重启（含每日升级/崩溃自愈）天然提供滚动时机。
 *
 * 策略（与常见 logrotate 一致的最小版）：
 *   file.log ≥ maxBytes → file.log 重命名为 file.1.log（覆盖旧 .1），
 *   调用方随后以 'a' 新建空 file.log。只保留 1 份历史，避免无限归档。
 * 失败一律 fail-open（返回 false，调用方照常 append），轮转绝不阻断 daemon 启动。
 */
import { openSync, statSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_LOG_MAX_BYTES = 20 * 1024 * 1024; // 20 MiB

export function rotateLogIfNeeded(path: string, maxBytes: number = DEFAULT_LOG_MAX_BYTES): boolean {
  try {
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      return false; // 文件不存在：无需轮转
    }
    if (size < maxBytes) return false;
    const rolled = `${path}.1`;
    // 覆盖上一份归档（先删再 rename，避免 EXDEV 之外的平台差异）。
    renameSync(path, rolled);
    return true;
  } catch {
    return false;
  }
}

/**
 * 轮转后以 append 打开；轮转发生时创建新空文件。mkdir/轮转失败都退回普通 append。
 */
export function openRotatedAppendLog(path: string, maxBytes: number = DEFAULT_LOG_MAX_BYTES): number {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch { /* 目录通常已存在；openSync 会再兜底 */ }
  try {
    rotateLogIfNeeded(path, maxBytes);
  } catch { /* fail-open */ }
  // openSync 'a' 在文件被 rename 走后会创建新文件。
  return openSync(path, 'a');
}
