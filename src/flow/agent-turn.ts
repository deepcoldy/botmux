/**
 * `bot` 执行器的 daemon 侧：`POST /api/flow/agent-turn`（设计文档 §6.1「bot 当执行器」）。
 *
 * runner 为一个 agent attempt 找到执行 bot 的 daemon 后打这条路，daemon 用自己的会话链路
 * （`triggerSessionTurn`）开一个 **headless 虚拟会话**（`http_wait_*` / `http_async_*`：不进任何群、
 * 不发飞书消息、不需要 bot 在群里），bots.json 里这个 bot 的 CLI / 模型 / env / 沙箱 / 插件全部沿用。
 * 这里只做「一轮的派发」并立刻返回 sessionId + triggerId；结果由 runner 用现成的
 * `GET /api/sessions/:id/trigger-result` 轮询，取消 / 清理用现成的 `POST /api/sessions/:id/close`。
 *
 * 身份：虚拟会话 ownerless（两个 owner 变量都不注入）。runner 不把触发话题的 open_id 带过来——
 * `ou_` 是 app-scoped，跨 bot 复制是 CLAUDE.md 明令禁止的路径；同 bot 也不需要（会话无群、无卡片）。
 */
import type { DaemonSession } from '../core/types.js';
import type { TriggerSessionDeps, TriggerSessionInternalOptions } from '../core/trigger-session.js';
import type { TriggerRequest, TriggerResponse } from '../services/trigger-types.js';
import type { FlowAgentTurnRequest, FlowAgentTurnResponse } from './types.js';

export interface FlowAgentTurnDeps {
  larkAppId: string;
  activeSessions: () => Map<string, DaemonSession> | null;
  bot: () => { botName: string; cliId: string };
  trigger: (req: TriggerRequest, deps: TriggerSessionDeps, internal: TriggerSessionInternalOptions) => Promise<TriggerResponse>;
}

const PROMPT_MAX_BYTES = 512 * 1024;

export function parseFlowAgentTurnRequest(raw: unknown): { ok: true; req: FlowAgentTurnRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'body must be an object' };
  const r = raw as Record<string, unknown>;
  const str = (k: string): string | null => (typeof r[k] === 'string' && (r[k] as string).length > 0 ? (r[k] as string) : null);
  const int = (k: string): number | null => (typeof r[k] === 'number' && Number.isSafeInteger(r[k] as number) && (r[k] as number) >= 0 ? (r[k] as number) : null);
  const runId = str('runId');
  const identity = str('identity');
  const prompt = str('prompt');
  const workingDir = str('workingDir');
  const attempt = int('attempt');
  const gen = int('gen');
  const turn = int('turn');
  const timeoutMs = int('timeoutMs');
  if (!runId || !identity || !prompt || !workingDir) return { ok: false, error: 'runId, identity, prompt and workingDir are required non-empty strings' };
  if (attempt === null || gen === null || turn === null || turn < 1) return { ok: false, error: 'attempt, gen and turn (>= 1) must be non-negative integers' };
  if (timeoutMs === null || timeoutMs < 1000) return { ok: false, error: 'timeoutMs must be an integer >= 1000' };
  if (Buffer.byteLength(prompt, 'utf8') > PROMPT_MAX_BYTES) return { ok: false, error: `prompt exceeds ${PROMPT_MAX_BYTES} bytes` };
  if (r.sessionId !== null && r.sessionId !== undefined && typeof r.sessionId !== 'string') return { ok: false, error: 'sessionId must be a string or null' };
  if (r.model !== undefined && typeof r.model !== 'string') return { ok: false, error: 'model must be a string' };
  return {
    ok: true,
    req: {
      runId, identity, attempt, gen, turn, prompt, workingDir, timeoutMs,
      sessionId: typeof r.sessionId === 'string' && r.sessionId ? r.sessionId : null,
      ...(typeof r.model === 'string' && r.model.trim() ? { model: r.model.trim() } : {}),
    },
  };
}

/** 一轮 agent 回合的 TriggerRequest：任务块 = 脚本给的 prompt；无外部事件；异步派发。 */
export function buildFlowAgentTriggerRequest(req: FlowAgentTurnRequest): TriggerRequest {
  return {
    source: { type: 'workflow', connectorId: 'flow', requestId: `${req.runId}/${req.identity}/${req.gen}-${req.attempt}/${req.turn}` },
    target: { kind: 'turn', ...(req.sessionId ? { sessionId: req.sessionId } : {}) },
    envelope: { format: 'botmux.flow.agent', sourceName: `flow ${req.runId}`, trusted: false },
    instruction: req.prompt,
    options: { asyncReturnSessionId: true, ...(req.model ? { model: req.model } : {}) },
  };
}

export async function handleFlowAgentTurn(raw: unknown, deps: FlowAgentTurnDeps): Promise<{ status: number; body: FlowAgentTurnResponse }> {
  const parsed = parseFlowAgentTurnRequest(raw);
  if (!parsed.ok) return { status: 400, body: { ok: false, code: 'bad_request', error: parsed.error } };
  const activeSessions = deps.activeSessions();
  if (!activeSessions) return { status: 503, body: { ok: false, code: 'dispatch_failed', error: 'active session registry unavailable' } };
  const req = parsed.req;
  let res: TriggerResponse;
  try {
    res = await deps.trigger(buildFlowAgentTriggerRequest(req), { larkAppId: deps.larkAppId, activeSessions }, {
      promptMode: 'task',
      ...(req.sessionId ? {} : { workingDir: req.workingDir }),
    });
  } catch (err) {
    return { status: 500, body: { ok: false, code: 'dispatch_failed', error: err instanceof Error ? err.message : String(err) } };
  }
  const sessionId = res.target?.sessionId;
  if (!res.ok || !res.triggerId || !sessionId) {
    const code: Extract<FlowAgentTurnResponse, { ok: false }>['code'] =
      res.errorCode === 'session_not_found' ? 'session_not_found' : res.errorCode === 'bad_request' ? 'bad_request' : 'dispatch_failed';
    const status = code === 'session_not_found' ? 404 : code === 'bad_request' ? 400 : 502;
    return { status, body: { ok: false, code, error: res.error ?? `dispatch did not return a session (${res.errorCode ?? res.action ?? 'unknown'})` } };
  }
  const bot = deps.bot();
  return { status: 200, body: { ok: true, sessionId, triggerId: res.triggerId, bot: deps.larkAppId, botName: bot.botName, cliId: bot.cliId } };
}
