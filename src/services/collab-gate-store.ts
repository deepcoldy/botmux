/**
 * per-chat 协作 gate 持久化（design 2026-11-20-dm-collab-group §8.1）。
 *
 * 文件 `{dataDir}/collab-gates/{chatId}.json`，类型复用 PR-1 的 CollabGateFile。
 * 单 writer（creator orchestrator 写），所有 participant daemon 只读；不做多进程
 * Map 读改写。原子写 0600 + fsync，patch 时 revision+1。
 *
 * 时序铁律：gate 写盘**先于** bot 邀请，消除「peer 已能收消息但还没 gate」的窗口。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { collabGateFilePath, type CollabGateFile } from './collab-group-config.js';

/** 原子写 gate（整文件覆盖），mode 0600 + durable。revision 由调用方/本函数归一。 */
export function writeCollabGate(dataDir: string, gate: CollabGateFile): void {
  const fp = collabGateFilePath(dataDir, gate.chatId);
  mkdirSync(dirname(fp), { recursive: true });
  atomicWriteFileSync(fp, `${JSON.stringify(gate, null, 2)}\n`, { mode: 0o600, durable: true });
}

/** 读取 gate；不存在/损坏返回 undefined。 */
export function readCollabGate(dataDir: string, chatId: string): CollabGateFile | undefined {
  const fp = collabGateFilePath(dataDir, chatId);
  if (!existsSync(fp)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as CollabGateFile;
  } catch {
    return undefined;
  }
}

/**
 * 读-改-写 patch（单 writer）。`patch` 返回新的 gate 字段；未写时（不存在）由 caller
 * 决定是否用 writeCollabGate 建首版。每次 patch 强制 revision+1。
 */
export function patchCollabGate(
  dataDir: string,
  chatId: string,
  patch: (gate: CollabGateFile) => CollabGateFile,
): CollabGateFile | undefined {
  const existing = readCollabGate(dataDir, chatId);
  if (!existing) return undefined;
  const next = patch(existing);
  next.revision = (existing.revision ?? 0) + 1;
  writeCollabGate(dataDir, next);
  return next;
}

/** 建全关闭 gate（phase='initializing'，participants 全 false，revision 0）。 */
export function buildInitialCollabGate(init: {
  initId: string;
  configVersion: string;
  creatorAppId: string;
  chatId: string;
  participantAppIds: string[];
}): CollabGateFile {
  const participants: CollabGateFile['participants'] = {};
  for (const appId of init.participantAppIds) {
    participants[appId] = { roleReady: false, kickoffState: 'pending', acceptingUserTasks: false };
  }
  return {
    schemaVersion: 1,
    initId: init.initId,
    configVersion: init.configVersion,
    creatorAppId: init.creatorAppId,
    chatId: init.chatId,
    phase: 'initializing',
    participants,
    revision: 0,
  };
}
