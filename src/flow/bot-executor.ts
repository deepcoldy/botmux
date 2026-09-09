/**
 * `bot` 执行器的 runner 侧：把一个 agent attempt 交给某个 bot 的 daemon 跑（设计文档 §6.1「bot 当执行器」）。
 *
 * 一次 attempt 的生命周期：
 *   resolveAgentBot（在线 daemon 里按 bot / cli 选执行 bot）
 *   → dispatchTurn（`POST /api/flow/agent-turn`：daemon 开 headless 虚拟会话，立刻返回 sessionId + triggerId）
 *   → pollTurn（`GET /api/sessions/:id/trigger-result?triggerId=`，直到 completed / failed / 超时）
 *   → （schema 修复轮：同一 sessionId 再 dispatch 一次）
 *   → closeSession（`POST /api/sessions/:id/close`：虚拟会话不会自己关）
 *
 * 本 bot 与别的 bot 走完全同一条 loopback IPC 路——runner 不区分「自己人」；只要 daemon 在线就能用。
 * 所有网络与 daemon 访问都经 `BotExecutorDeps` 注入，单测不起 daemon。
 */
import { fetchDaemonIpc } from '../core/daemon-ipc-auth.js';
import { listOnlineDaemons, type OnlineDaemonInfo } from '../utils/daemon-discovery.js';
import { FLOW_AGENT_TURN_ROUTE, type FlowAgentTurnRequest, type FlowAgentTurnResponse } from './types.js';

export interface ResolvedBot {
  larkAppId: string;
  botName: string;
  cliId: string;
  ipcPort: number;
}

export interface BotHttpResponse {
  status: number;
  json(): Promise<unknown>;
}

export interface BotExecutorDeps {
  listDaemons: () => OnlineDaemonInfo[];
  fetch: (port: number, path: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<BotHttpResponse>;
  pollIntervalMs?: number;
}

export function defaultBotExecutorDeps(): BotExecutorDeps {
  return {
    listDaemons: () => listOnlineDaemons(),
    fetch: (port, path, init) => fetchDaemonIpc(port, path, {
      method: init?.method ?? 'GET',
      ...(init?.body !== undefined ? { body: init.body } : {}),
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    }),
  };
}

export type BotResolution = { ok: true; bot: ResolvedBot } | { ok: false; error: string };

/**
 * 选执行 bot。顺序：显式 `bot`（larkAppId 或 bots.json 的 displayName，忽略大小写）→ `cli`
 * （本 run 所属 bot 的 CLI 相同时优先它，否则第一个在线的同 CLI bot）→ 本 run 所属 bot。
 * 只在**在线** daemon 里找：离线的 bot 本来就跑不了。
 */
export function resolveAgentBot(spec: { bot?: string; cli?: string }, ownAppId: string | null, daemons: OnlineDaemonInfo[]): BotResolution {
  const online = daemons.filter((d) => typeof d.ipcPort === 'number' && d.ipcPort > 0);
  const toResolved = (d: OnlineDaemonInfo): ResolvedBot => ({ larkAppId: d.larkAppId, botName: d.botName ?? d.larkAppId, cliId: d.cliId ?? '', ipcPort: d.ipcPort });
  const own = ownAppId ? online.find((d) => d.larkAppId === ownAppId) ?? null : null;
  if (spec.bot !== undefined) {
    const want = spec.bot.trim().toLowerCase();
    if (!want) return { ok: false, error: 'agent `bot` must not be empty' };
    const hit = online.find((d) => d.larkAppId.toLowerCase() === want || (d.botName ?? '').trim().toLowerCase() === want);
    if (!hit) return { ok: false, error: `bot ${JSON.stringify(spec.bot)} is not online (no daemon descriptor matches it by larkAppId or displayName)` };
    if (spec.cli && hit.cliId && hit.cliId !== spec.cli) return { ok: false, error: `bot ${JSON.stringify(spec.bot)} runs ${hit.cliId}, not ${spec.cli}` };
    return { ok: true, bot: toResolved(hit) };
  }
  if (spec.cli !== undefined) {
    const cli = spec.cli.trim();
    if (!cli) return { ok: false, error: 'agent `cli` must not be empty' };
    if (own && own.cliId === cli) return { ok: true, bot: toResolved(own) };
    const hit = online.find((d) => d.cliId === cli);
    if (!hit) return { ok: false, error: `no online bot runs cli ${JSON.stringify(cli)}${online.length ? ` (online: ${online.map((d) => `${d.botName ?? d.larkAppId}=${d.cliId ?? '?'}`).join(', ')})` : ' (no daemon is online)'}` };
    return { ok: true, bot: toResolved(hit) };
  }
  if (own) return { ok: true, bot: toResolved(own) };
  if (ownAppId) return { ok: false, error: `this run's bot ${ownAppId} is not online and the agent names neither \`bot\` nor \`cli\`` };
  // 终端起的 run 没有所属 bot：只有一个 bot 在线时不必点名，否则要求说清楚
  if (online.length === 1) return { ok: true, bot: toResolved(online[0]!) };
  return { ok: false, error: `agent needs \`bot\` or \`cli\` (this run is not bound to a bot${online.length ? `; online: ${online.map((d) => `${d.botName ?? d.larkAppId}=${d.cliId ?? '?'}`).join(', ')}` : ' and no daemon is online'})` };
}

export type DispatchFailureCode = 'bot_offline' | 'http_error' | Extract<FlowAgentTurnResponse, { ok: false }>['code'];

export type DispatchResult =
  | { ok: true; sessionId: string; triggerId: string; botName: string; cliId: string }
  | { ok: false; code: DispatchFailureCode; error: string };

export async function dispatchTurn(deps: BotExecutorDeps, bot: ResolvedBot, req: FlowAgentTurnRequest): Promise<DispatchResult> {
  let res: BotHttpResponse;
  try {
    res = await deps.fetch(bot.ipcPort, FLOW_AGENT_TURN_ROUTE, { method: 'POST', body: JSON.stringify(req) });
  } catch (err) {
    return { ok: false, code: 'bot_offline', error: `daemon of ${bot.botName} (port ${bot.ipcPort}) unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, code: 'http_error', error: `daemon of ${bot.botName} answered HTTP ${res.status} without a JSON body` };
  }
  const b = (body ?? {}) as Partial<Extract<FlowAgentTurnResponse, { ok: true }>> & Partial<Extract<FlowAgentTurnResponse, { ok: false }>>;
  if (res.status === 200 && b.ok === true && typeof b.sessionId === 'string' && typeof b.triggerId === 'string') {
    return { ok: true, sessionId: b.sessionId, triggerId: b.triggerId, botName: b.botName ?? bot.botName, cliId: b.cliId ?? bot.cliId };
  }
  if (res.status === 401) return { ok: false, code: 'http_error', error: `daemon of ${bot.botName} rejected the runner's IPC credentials (HTTP 401)` };
  if (res.status === 404 && !b.code) return { ok: false, code: 'flow_not_enabled', error: `daemon of ${bot.botName} has no ${FLOW_AGENT_TURN_ROUTE} route (older botmux; upgrade that bot)` };
  const code: DispatchFailureCode =
    b.code === 'bad_request' || b.code === 'session_not_found' || b.code === 'dispatch_failed' || b.code === 'flow_not_enabled' ? b.code : 'http_error';
  return { ok: false, code, error: typeof b.error === 'string' ? b.error : `daemon of ${bot.botName} answered HTTP ${res.status}` };
}

export type PollResult =
  | { status: 'completed'; content: string }
  /** 会话结束但没有产出（worker 退出 / 被关闭 / CLI 起不来）。 */
  | { status: 'failed'; error: string; errorCode: string | null }
  | { status: 'timeout' }
  /** 轮询自身被 `stop()` 打断（runner 取消 / 结束）。 */
  | { status: 'aborted' }
  /** daemon 不可达或 not_found（会话记录没了）。 */
  | { status: 'lost'; error: string };

export interface PollHandle {
  result: Promise<PollResult>;
  /** 停止轮询（不动 daemon 侧会话）。 */
  stop(): void;
}

const DEFAULT_POLL_INTERVAL_MS = 1_500;
/** 连续这么多次 daemon 不可达才判 lost（心跳抖动 / daemon 重启中不至于立刻失败）。 */
const UNREACHABLE_STRIKES = 8;

export function pollTurn(deps: BotExecutorDeps, bot: ResolvedBot, sessionId: string, triggerId: string, timeoutMs: number): PollHandle {
  let stopped = false;
  let wake: (() => void) | null = null;
  const interval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  const sleep = (ms: number) => new Promise<void>((resolve) => {
    wake = resolve;
    setTimeout(resolve, ms);
  });
  const result = (async (): Promise<PollResult> => {
    let strikes = 0;
    for (;;) {
      if (stopped) return { status: 'aborted' };
      if (Date.now() > deadline) return { status: 'timeout' };
      let res: BotHttpResponse | null = null;
      try {
        res = await deps.fetch(bot.ipcPort, `/api/sessions/${encodeURIComponent(sessionId)}/trigger-result?triggerId=${encodeURIComponent(triggerId)}`);
      } catch {
        res = null;
      }
      if (res) {
        let body: { ok?: boolean; state?: string; output?: { content?: string }; error?: string; errorCode?: string } = {};
        try {
          body = (await res.json()) as typeof body;
        } catch {
          body = {};
        }
        if (res.status === 200 && body.ok) {
          strikes = 0;
          if (body.state === 'completed') return { status: 'completed', content: typeof body.output?.content === 'string' ? body.output.content : '' };
          if (body.state === 'failed') return { status: 'failed', error: body.error ?? 'session terminated without output', errorCode: body.errorCode ?? null };
          if (body.state === 'not_found') return { status: 'lost', error: `daemon of ${bot.botName} has no record of session ${sessionId}` };
          // running → 继续
        } else if (res.status === 401) {
          return { status: 'lost', error: `daemon of ${bot.botName} rejected the runner's IPC credentials while polling (HTTP 401)` };
        } else {
          strikes++;
        }
      } else {
        strikes++;
      }
      if (strikes >= UNREACHABLE_STRIKES) return { status: 'lost', error: `daemon of ${bot.botName} (port ${bot.ipcPort}) stopped answering trigger-result polls` };
      if (stopped) return { status: 'aborted' };
      await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
    }
  })();
  return {
    result,
    stop: () => {
      stopped = true;
      wake?.();
    },
  };
}

/** 关掉虚拟会话（取消在途回合 / 结算后清理）。尽力而为：daemon 不在就算了，它重启时会自己回收。 */
export async function closeBotSession(deps: BotExecutorDeps, bot: ResolvedBot, sessionId: string, reason: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await deps.fetch(bot.ipcPort, `/api/sessions/${encodeURIComponent(sessionId)}/close`, { method: 'POST', body: JSON.stringify({ reason }) });
    if (res.status === 200) return { ok: true };
    let error = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === 'string') error = body.error;
    } catch {
      // keep status text
    }
    return { ok: false, error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
