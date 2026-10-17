import { sendJson } from './dashboard-api.js';
import {
  agentBotDrift,
  agentPushRequests,
  type AgentBotSnapshot,
  type AgentProfile,
  type AgentProfilesDoc,
  type AgentSection,
  type AgentSectionsConfig,
} from '../agent-profiles-model.js';

export type AgentsSnapshot = Pick<AgentProfilesDoc, 'agents' | 'links'>;

export type AgentInput = Omit<AgentProfile, 'id' | 'createdAt' | 'updatedAt'>;

export class AgentsApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

function errorText(body: any, status: number): string {
  return String(body?.message || body?.error || body?.reason || `HTTP ${status}`);
}

async function call(method: string, url: string, body?: unknown): Promise<any> {
  const result = await sendJson(method, url, body);
  if (!result.ok) throw new AgentsApiError(errorText(result.body, result.status), result.status);
  return result.body;
}

function toSnapshot(body: any): AgentsSnapshot {
  return {
    agents: Array.isArray(body?.agents) ? body.agents : [],
    links: body?.links && typeof body.links === 'object' ? body.links : {},
  };
}

export async function fetchAgents(): Promise<AgentsSnapshot> {
  return toSnapshot(await call('GET', '/api/agents'));
}

export async function createAgent(agent: AgentInput, linkBots: string[] = []): Promise<{ agent: AgentProfile; snapshot: AgentsSnapshot }> {
  const body = await call('POST', '/api/agents', { agent, linkBots });
  return { agent: body.agent, snapshot: toSnapshot(body) };
}

export async function updateAgent(id: string, agent: AgentInput): Promise<{ agent: AgentProfile; snapshot: AgentsSnapshot }> {
  const body = await call('PUT', `/api/agents/${encodeURIComponent(id)}`, { agent });
  return { agent: body.agent, snapshot: toSnapshot(body) };
}

export async function deleteAgent(id: string): Promise<AgentsSnapshot> {
  return toSnapshot(await call('DELETE', `/api/agents/${encodeURIComponent(id)}`));
}

export async function linkAgent(id: string, appId: string): Promise<AgentsSnapshot> {
  return toSnapshot(await call('PUT', `/api/agents/${encodeURIComponent(id)}/links/${encodeURIComponent(appId)}`));
}

export async function unlinkAgent(id: string, appId: string): Promise<AgentsSnapshot> {
  return toSnapshot(await call('DELETE', `/api/agents/${encodeURIComponent(id)}/links/${encodeURIComponent(appId)}`));
}

export interface BotSyncFailure {
  section: AgentSection;
  error: string;
}

export interface BotSyncResult {
  larkAppId: string;
  pushed: AgentSection[];
  failures: BotSyncFailure[];
  /** daemon 已保存但附带的提醒（如所选 CLI 当前不可用）。 */
  warnings: string[];
  /** 切换 CLI 时 daemon 关闭的旧 CLI 活跃会话数（与 Bot 设置页改 CLI 同一行为）。 */
  closedSessions: number;
  /** 其中关闭后留有残留、需要人工清理的数量。 */
  residualSessions: number;
}

/**
 * 把 Agent 下发到一个 Bot：只推当前有偏差的分组（没偏差的不碰，避免无谓地触发
 * daemon 侧的会话保护检查）。各分组顺序执行、互不阻断；离线 Bot 直接报失败。
 */
export async function syncAgentToBot(
  agent: AgentSectionsConfig,
  bot: AgentBotSnapshot,
  send: typeof sendJson = sendJson,
): Promise<BotSyncResult> {
  const result: BotSyncResult = { larkAppId: bot.larkAppId, pushed: [], failures: [], warnings: [], closedSessions: 0, residualSessions: 0 };
  const status = agentBotDrift(agent, bot);
  if (status.state === 'offline') {
    result.failures.push({ section: 'exec', error: 'offline' });
    return result;
  }
  for (const request of agentPushRequests(agent, bot.larkAppId, status.sections)) {
    try {
      const response = await send(request.method, request.url, request.body);
      // 关闭旧会话发生在写入之后，失败响应里也可能带着关闭摘要，先计数再判成败。
      result.closedSessions += count(response.body?.closedMismatchedSessions);
      result.residualSessions += count(response.body?.closedMismatchedResidual);
      if (!response.ok) {
        result.failures.push({ section: request.section, error: errorText(response.body, response.status) });
        continue;
      }
      result.pushed.push(request.section);
      const warning = response.body?.availabilityWarning;
      if (typeof warning === 'string' && warning) result.warnings.push(warning);
    } catch (error) {
      result.failures.push({ section: request.section, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

/** 多个 Bot 并发下发（限并发，避免同时打满所有 daemon）。 */
export async function syncAgentToBots(
  agent: AgentSectionsConfig,
  bots: readonly AgentBotSnapshot[],
  concurrency = 4,
): Promise<BotSyncResult[]> {
  const results: BotSyncResult[] = new Array(bots.length);
  let next = 0;
  const worker = async () => {
    while (next < bots.length) {
      const index = next++;
      results[index] = await syncAgentToBot(agent, bots[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, bots.length) }, worker));
  return results;
}
