/**
 * per-chat 协作 gate 持久化（design §8.1）。
 *
 * 文件 `{dataDir}/collab-gates/{chatId}.json`，类型复用 PR-1 的 CollabGateFile。
 * 单 writer（creator orchestrator 写），所有 participant daemon 只读；不做多进程
 * Map 读改写。原子写 0600 + fsync，patch 时 revision+1。
 *
 * 时序铁律：gate 写盘**先于** bot 邀请，消除「peer 已能收消息但还没 gate」的窗口。
 * 只有 ENOENT 表示普通非 collab 群；任何损坏都必须显式 fail-closed，绝不能当 gate 缺失。
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { collabGateFilePath, type CollabGateFile } from './collab-group-config.js';

export type CollabGateReadResult =
  | { kind: 'missing' }
  | { kind: 'corrupted'; message: string }
  | { kind: 'ok'; gate: CollabGateFile };

export class CollabGateCorruptedError extends Error {
  constructor(public readonly filePath: string, message: string) {
    super(`collab gate corrupted at ${filePath}: ${message}`);
    this.name = 'CollabGateCorruptedError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseGate(raw: string, chatId: string): CollabGateFile {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) throw new Error('schemaVersion 不符或 gate 非对象');
  const gate = parsed as unknown as CollabGateFile;
  if (gate.chatId !== chatId || typeof gate.initId !== 'string' || !gate.initId
    || typeof gate.configVersion !== 'string' || !gate.configVersion
    || typeof gate.creatorAppId !== 'string' || !gate.creatorAppId
    || !['initializing', 'active', 'awaiting-input', 'failed', 'cancelled', 'done'].includes(gate.phase)
    || !isRecord(gate.participants) || typeof gate.revision !== 'number'
    || !Number.isFinite(gate.revision) || gate.revision < 0) {
    throw new Error('gate 身份、阶段或 revision 非法');
  }
  for (const [appId, participant] of Object.entries(gate.participants)) {
    if (!appId || !isRecord(participant)
      || typeof participant.roleReady !== 'boolean'
      || typeof participant.acceptingUserTasks !== 'boolean'
      || !['pending', 'prepared', 'started', 'failed', 'cancelled'].includes(participant.kickoffState)) {
      throw new Error(`gate participant ${appId} 结构非法`);
    }
  }
  return gate;
}

/** 严格读：只有 ENOENT 是 missing，其余读取/JSON/schema 错误都是 corrupted。 */
export function readCollabGateStrict(dataDir: string, chatId: string): CollabGateReadResult {
  const fp = collabGateFilePath(dataDir, chatId);
  let raw: string;
  try { raw = readFileSync(fp, 'utf-8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'corrupted', message: err instanceof Error ? err.message : String(err) };
  }
  try { return { kind: 'ok', gate: parseGate(raw, chatId) }; }
  catch (err) { return { kind: 'corrupted', message: err instanceof Error ? err.message : String(err) }; }
}

/** 常规读：不存在返回 undefined；损坏抛错，禁止覆盖旧 gate 或降级成 not-collab。 */
export function readCollabGate(dataDir: string, chatId: string): CollabGateFile | undefined {
  const read = readCollabGateStrict(dataDir, chatId);
  if (read.kind === 'missing') return undefined;
  if (read.kind === 'corrupted') throw new CollabGateCorruptedError(collabGateFilePath(dataDir, chatId), read.message);
  return read.gate;
}

/** 原子写 gate（整文件覆盖），mode 0600 + durable。写入前拒绝非法结构。 */
export function writeCollabGate(dataDir: string, gate: CollabGateFile): void {
  // 统一读写 schema，避免调用方先写出随后自己也无法严格读取的文件。
  parseGate(JSON.stringify(gate), gate.chatId);
  const fp = collabGateFilePath(dataDir, gate.chatId);
  mkdirSync(dirname(fp), { recursive: true });
  atomicWriteFileSync(fp, `${JSON.stringify(gate, null, 2)}\n`, { mode: 0o600, durable: true });
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
