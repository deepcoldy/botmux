/**
 * agents.json 持久化：与当前 bots.json 同目录、0600、跨进程文件锁 + 原子 rename。
 *
 * 只有 Dashboard 进程读写本文件；Bot 真正生效的配置仍在 bots.json（由各 daemon 的
 * 逐字段 IPC 写入），这里只存 Agent 模板与 larkAppId → agentId 的关联。
 *
 * 读盘失败（JSON 损坏、非对象）时**拒绝写入**：宁可让 Dashboard 报错，也不能用空
 * 文档覆盖掉用户手里唯一一份 Agent 定义。
 */
import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getLoadedConfigPath } from '../bot-registry.js';
import { resolveBotsConfigFile } from '../core/config-dir.js';
import { withFileLock } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';
import {
  AGENT_PROFILES_VERSION,
  emptyAgentProfilesDoc,
  normalizeAgentProfilesDoc,
  type AgentProfilesDoc,
} from './agent-profiles-model.js';

export const AGENTS_FILE_NAME = 'agents.json';

export function defaultAgentProfilesPath(): string {
  return join(dirname(getLoadedConfigPath() ?? resolveBotsConfigFile()), AGENTS_FILE_NAME);
}

export class AgentProfilesFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentProfilesFileError';
  }
}

export async function readAgentProfiles(path: string): Promise<AgentProfilesDoc> {
  let text: string;
  try {
    text = await fsp.readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyAgentProfilesDoc();
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AgentProfilesFileError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AgentProfilesFileError(`${path} must be a JSON object`);
  }
  const version = (raw as { version?: unknown }).version;
  if (version !== undefined && version !== AGENT_PROFILES_VERSION) {
    throw new AgentProfilesFileError(`${path} has unsupported version ${String(version)}`);
  }
  const { doc, dropped } = normalizeAgentProfilesDoc(raw);
  if (dropped.length) logger.warn(`[agent-profiles] ignoring invalid agents in ${path}: ${dropped.join(', ')}`);
  return doc;
}

async function writeAgentProfilesAtomic(path: string, doc: AgentProfilesDoc): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  await fsp.rename(tmp, path);
}

/**
 * 锁内读-改-写。`mutate` 直接修改拿到的文档并返回结果；返回 `{ write: false }` 时不落盘。
 * `mutate` 抛出的错误原样上抛（调用方据此映射 HTTP 状态）。
 */
export async function mutateAgentProfiles<T>(
  path: string,
  mutate: (doc: AgentProfilesDoc) => { write: boolean; result: T },
): Promise<T> {
  return withFileLock(path, async () => {
    const doc = await readAgentProfiles(path);
    const { write, result } = mutate(doc);
    if (write) await writeAgentProfilesAtomic(path, doc);
    return result;
  });
}

export function newAgentId(): string {
  return `ag_${randomBytes(9).toString('base64url')}`;
}
