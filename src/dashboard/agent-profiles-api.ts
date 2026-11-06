/**
 * Dashboard HTTP API：Agent 配置模板与 Bot 关联。
 *
 * GET    /api/agents                        — { agents, links }
 * POST   /api/agents                        — { agent, linkBots?: string[] } 新建（可同时关联）
 * PUT    /api/agents/:id                    — { agent } 更新定义（不负责下发）
 * DELETE /api/agents/:id                    — 删除定义及其全部关联
 * PUT    /api/agents/:id/links/:appId       — 关联（覆盖该 Bot 原有关联）
 * DELETE /api/agents/:id/links/:appId       — 解除关联
 *
 * 只管 agents.json。把 Agent 的值写进 Bot 由浏览器调用现有 `PUT /api/bots/:appId/<x>`
 * 完成（校验、热更新、写入不变量全部沿用），这里不做第二条 bots.json 写入路径。
 *
 * 鉴权：/api/agents 不在 PUBLIC_READ_PATHS，未认证请求已被 dashboard.ts 的全局闸 401；
 * 写操作在此再要求 canManageHost。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonRes } from './http.js';
import {
  AGENTS_MAX,
  agentLinkedBots,
  normalizeAgentInput,
  type AgentProfile,
  type AgentProfilesDoc,
} from './agent-profiles-model.js';
import {
  AgentProfilesFileError,
  defaultAgentProfilesPath,
  mutateAgentProfiles,
  newAgentId,
  readAgentProfiles,
} from './agent-profiles-store.js';
import { lookupCliSelection } from '../setup/cli-selection.js';
import { cliModelSupportsReasoningEffort, isCodexReasoningEffort } from '../services/codex-reasoning-effort.js';
import { validateWorkingDir } from '../core/working-dir.js';
import { cliSupportsConfigDir } from '../core/cli-config-dir.js';
import { supportsZeroPromptInjection } from '../core/prompt-injection.js';

const MAX_BODY_BYTES = 64 * 1024;

export interface AgentProfilesApiDeps {
  canManageHost: boolean;
  /** 当前 bots.json 里的全部 larkAppId；关联目标必须在其中。 */
  knownBotIds: () => ReadonlySet<string>;
  agentsPath?: () => string;
  now?: () => number;
  /** 测试注入；缺省走 core/working-dir 的真实目录校验。 */
  checkWorkingDir?: (dir: string) => string | null;
}

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail?: string) {
    super(code);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new ApiError(413, 'body_too_large');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf-8').trim();
  if (!text) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ApiError(400, 'bad_json'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError(400, 'bad_json');
  return parsed as Record<string, unknown>;
}

function defaultCheckWorkingDir(dir: string): string | null {
  const result = validateWorkingDir(dir);
  return result.ok ? null : result.error;
}

/** 结构归一化之后的语义校验：CLI 选择键已知、推理强度与模型匹配、目录真实存在。 */
function validateAgent(raw: unknown, deps: AgentProfilesApiDeps): Omit<AgentProfile, 'id' | 'createdAt' | 'updatedAt'> {
  const normalized = normalizeAgentInput(raw);
  if (!normalized.ok) throw new ApiError(400, normalized.error);
  const agent = normalized.value;
  if (agent.exec) {
    const selection = lookupCliSelection(agent.exec.cliId);
    if (!selection) throw new ApiError(400, 'exec:invalid_cli');
    const effort = agent.exec.reasoningEffort;
    if (effort && (!isCodexReasoningEffort(effort)
      || !cliModelSupportsReasoningEffort(selection.cliId, agent.exec.model || undefined, effort))) {
      throw new ApiError(400, 'exec:reasoning_effort_not_supported_by_model');
    }
    if (agent.exec.configDir) {
      if (!cliSupportsConfigDir(selection.cliId)) throw new ApiError(400, 'exec:config_dir_unsupported');
      const error = (deps.checkWorkingDir ?? defaultCheckWorkingDir)(agent.exec.configDir);
      if (error) throw new ApiError(400, 'exec:invalid_config_dir', error);
    }
  }
  if (agent.workspace && agent.workspace.mode !== 'off') {
    const error = (deps.checkWorkingDir ?? defaultCheckWorkingDir)(agent.workspace.workingDir);
    if (error) throw new ApiError(400, 'workspace:invalid_working_dir', error);
  }
  // 零注入只有部分 CLI / 后端 / 沙箱组合支持。Agent 统一了 CLI 时提前拒绝；没统一 CLI
  // 时由同步前的组合校验与各 Bot 的 daemon 把关（失败计入同步失败）。
  if (agent.promptInjection?.mode === 'none' && agent.exec) {
    const cliId = lookupCliSelection(agent.exec.cliId)!.cliId;
    if (!supportsZeroPromptInjection(cliId, {
      backendType: agent.backend?.backendType || undefined,
      sandbox: agent.sandbox?.mode,
    })) {
      throw new ApiError(400, 'promptInjection:unsupported');
    }
  }
  return agent;
}

function snapshot(doc: AgentProfilesDoc, knownBotIds: ReadonlySet<string>) {
  // 已从 bots.json 删除的 Bot 不再展示其关联；文件里的残留在下次写入相关 Agent 时自然覆盖。
  const links = Object.fromEntries(Object.entries(doc.links).filter(([appId]) => knownBotIds.has(appId)));
  return { agents: doc.agents, links };
}

function requireAgent(doc: AgentProfilesDoc, id: string): AgentProfile {
  const agent = doc.agents.find(entry => entry.id === id);
  if (!agent) throw new ApiError(404, 'agent_not_found');
  return agent;
}

function requireKnownBot(deps: AgentProfilesApiDeps, appId: string): void {
  if (!deps.knownBotIds().has(appId)) throw new ApiError(404, 'bot_not_found');
}

function decodeSegment(segment: string): string {
  try { return decodeURIComponent(segment); } catch { throw new ApiError(400, 'bad_path'); }
}

/** 处理了请求返回 true。 */
export async function handleAgentProfilesApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: AgentProfilesApiDeps,
): Promise<boolean> {
  const path = url.pathname;
  if (path !== '/api/agents' && !path.startsWith('/api/agents/')) return false;
  const agentsPath = (deps.agentsPath ?? defaultAgentProfilesPath)();
  const now = deps.now ?? Date.now;
  const linkMatch = /^\/api\/agents\/([^/]+)\/links\/([^/]+)$/.exec(path);
  const agentMatch = /^\/api\/agents\/([^/]+)$/.exec(path);

  try {
    if (req.method === 'GET' && path === '/api/agents') {
      const doc = await readAgentProfiles(agentsPath);
      jsonRes(res, 200, { ok: true, ...snapshot(doc, deps.knownBotIds()) });
      return true;
    }

    const isWrite = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE';
    if (!isWrite || (path !== '/api/agents' && !agentMatch && !linkMatch)) {
      jsonRes(res, 404, { ok: false, error: 'not_found' });
      return true;
    }
    if (!deps.canManageHost) throw new ApiError(403, 'forbidden');

    if (req.method === 'POST' && path === '/api/agents') {
      const body = await readJsonBody(req);
      const input = validateAgent(body.agent, deps);
      const linkBots = Array.isArray(body.linkBots)
        ? [...new Set(body.linkBots.filter((id): id is string => typeof id === 'string' && !!id))]
        : [];
      for (const appId of linkBots) requireKnownBot(deps, appId);
      const result = await mutateAgentProfiles(agentsPath, doc => {
        if (doc.agents.length >= AGENTS_MAX) throw new ApiError(409, 'too_many_agents');
        const ts = now();
        const agent: AgentProfile = { id: newAgentId(), ...input, createdAt: ts, updatedAt: ts };
        doc.agents.push(agent);
        for (const appId of linkBots) doc.links[appId] = agent.id;
        return { write: true, result: { agent, doc } };
      });
      jsonRes(res, 200, { ok: true, agent: result.agent, ...snapshot(result.doc, deps.knownBotIds()) });
      return true;
    }

    if (agentMatch && req.method === 'PUT') {
      const id = decodeSegment(agentMatch[1]);
      const body = await readJsonBody(req);
      const input = validateAgent(body.agent, deps);
      const result = await mutateAgentProfiles(agentsPath, doc => {
        const current = requireAgent(doc, id);
        const next: AgentProfile = { id, ...input, createdAt: current.createdAt, updatedAt: now() };
        doc.agents = doc.agents.map(entry => (entry.id === id ? next : entry));
        return { write: true, result: { agent: next, doc } };
      });
      jsonRes(res, 200, { ok: true, agent: result.agent, ...snapshot(result.doc, deps.knownBotIds()) });
      return true;
    }

    if (agentMatch && req.method === 'DELETE') {
      const id = decodeSegment(agentMatch[1]);
      const result = await mutateAgentProfiles(agentsPath, doc => {
        requireAgent(doc, id);
        const unlinked = agentLinkedBots(doc, id);
        doc.agents = doc.agents.filter(entry => entry.id !== id);
        for (const appId of unlinked) delete doc.links[appId];
        return { write: true, result: { unlinked, doc } };
      });
      jsonRes(res, 200, { ok: true, unlinked: result.unlinked, ...snapshot(result.doc, deps.knownBotIds()) });
      return true;
    }

    if (linkMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const id = decodeSegment(linkMatch[1]);
      const appId = decodeSegment(linkMatch[2]);
      if (req.method === 'PUT') requireKnownBot(deps, appId);
      const result = await mutateAgentProfiles(agentsPath, doc => {
        requireAgent(doc, id);
        const previous = doc.links[appId] ?? null;
        if (req.method === 'PUT') {
          if (previous === id) return { write: false, result: { previous, doc } };
          doc.links[appId] = id;
          return { write: true, result: { previous, doc } };
        }
        // 只解除「确实关联到这个 Agent」的边：并发下已改关联到别的 Agent 时不误删。
        if (previous !== id) return { write: false, result: { previous, doc } };
        delete doc.links[appId];
        return { write: true, result: { previous, doc } };
      });
      jsonRes(res, 200, { ok: true, previous: result.previous, ...snapshot(result.doc, deps.knownBotIds()) });
      return true;
    }

    jsonRes(res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  } catch (error) {
    if (error instanceof ApiError) {
      jsonRes(res, error.status, { ok: false, error: error.code, ...(error.detail ? { message: error.detail } : {}) });
    } else if (error instanceof AgentProfilesFileError) {
      jsonRes(res, 500, { ok: false, error: 'agents_file_invalid', message: error.message });
    } else {
      jsonRes(res, 500, { ok: false, error: 'agents_api_failed', message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
}
