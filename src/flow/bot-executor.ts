/**
 * `bot` 执行器的 runner 侧：把一个 agent attempt 交给某个 bot 的 daemon 跑（设计文档 §6.1「bot 当执行器」）。
 *
 * 一次 attempt 的生命周期：
 *   resolveAgentBot（按 `bot` 选执行 bot，并校验它存在且在线；`cli` 只做断言）
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
import { listConfiguredBots, type ConfiguredBot } from './configured-bots.js';
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
  /** bots.json 里配置的 bot（校验 `bot` 存在用）。返回 null = 读不到，只能按在线 daemon 校验。 */
  listConfiguredBots?: () => ConfiguredBot[] | null;
  fetch: (port: number, path: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<BotHttpResponse>;
  pollIntervalMs?: number;
}

export function defaultBotExecutorDeps(): BotExecutorDeps {
  return {
    listDaemons: () => listOnlineDaemons(),
    listConfiguredBots: () => listConfiguredBots(),
    fetch: (port, path, init) => fetchDaemonIpc(port, path, {
      method: init?.method ?? 'GET',
      ...(init?.body !== undefined ? { body: init.body } : {}),
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    }),
  };
}

export type BotResolution = { ok: true; bot: ResolvedBot } | { ok: false; error: string };

/** bots.json 与在线描述符并成的一条「已知 bot」。 */
export interface KnownBot {
  larkAppId: string;
  /** 展示名：在线描述符的 botName（daemon 的有效展示名）> bots.json 的 displayName > larkAppId。 */
  name: string;
  cliId: string;
  online: OnlineDaemonInfo | null;
  /** 在 bots.json 里有条目（核心态是 env 合成的那一个）。 */
  configured: boolean;
  /** 可用来点名的全部名字（小写）：larkAppId、displayName、在线 botName。 */
  aliases: string[];
}

/** 把 bots.json（可能读不到 → null）与在线 daemon 描述符并成「已知 bot」名单；同一 larkAppId 只一条。 */
export function knownBots(configured: ConfiguredBot[] | null, daemons: OnlineDaemonInfo[]): KnownBot[] {
  const byId = new Map<string, KnownBot>();
  for (const c of configured ?? []) {
    const aliases = [c.larkAppId, ...(c.displayName ? [c.displayName] : [])].map((s) => s.trim().toLowerCase());
    byId.set(c.larkAppId, { larkAppId: c.larkAppId, name: c.displayName ?? c.larkAppId, cliId: c.cliId, online: null, configured: true, aliases });
  }
  for (const d of daemons) {
    if (typeof d.ipcPort !== 'number' || d.ipcPort <= 0) continue;
    const prev = byId.get(d.larkAppId);
    const aliases = new Set([...(prev?.aliases ?? [d.larkAppId.toLowerCase()]), ...(d.botName ? [d.botName.trim().toLowerCase()] : [])]);
    byId.set(d.larkAppId, {
      larkAppId: d.larkAppId,
      name: d.botName ?? prev?.name ?? d.larkAppId,
      cliId: d.cliId ?? prev?.cliId ?? '',
      online: d,
      configured: prev?.configured ?? false,
      aliases: [...aliases],
    });
  }
  return [...byId.values()];
}

function describeKnown(known: KnownBot[]): string {
  if (!known.length) return 'no bot is configured and no daemon is online';
  return `known bots: ${known.map((b) => `${b.name}=${b.cliId || '?'} [${b.online ? 'online' : 'offline'}]`).join(', ')}`;
}

/**
 * 选执行 bot。**只有 `bot` 能选人**：
 *   - 写了 `bot`（larkAppId / bots.json 的 displayName / 在线 botName，忽略大小写）→ 就它；必须存在
 *     （在 bots.json 里，或有在线 daemon 叫这个名）且在线，否则 setup_required；
 *   - 没写 → 本 run 所属 bot（触发话题的那个）；终端起的 run 没有所属 bot：已知 bot 恰好一个时用它，否则必须点名。
 * `cli` 不选人，只做断言：落到的 bot 跑的不是这个 CLI 就拒绝，绝不改去找别的 bot——
 * 多个同 CLI 的 bot 通常是不同角色（工作目录 / skills / 沙箱 / 群各不相同），按 CLI 挑等于把角色抹掉。
 */
export function resolveAgentBot(spec: { bot?: string; cli?: string }, ownAppId: string | null, daemons: OnlineDaemonInfo[], configured: ConfiguredBot[] | null = null): BotResolution {
  const known = knownBots(configured, daemons);
  const toResolved = (b: KnownBot & { online: OnlineDaemonInfo }): ResolvedBot => ({ larkAppId: b.larkAppId, botName: b.name, cliId: b.cliId, ipcPort: b.online.ipcPort });
  const cli = spec.cli === undefined ? undefined : spec.cli.trim();
  if (cli !== undefined && !cli) return { ok: false, error: 'agent `cli` must not be empty' };
  const settle = (b: KnownBot, label: string): BotResolution => {
    if (!b.online) return { ok: false, error: `${label} (${b.larkAppId}, ${b.cliId || '?'}) is configured but its daemon is not online; start it and retry` };
    if (cli && b.cliId && b.cliId !== cli) return { ok: false, error: `${label} runs ${b.cliId}, not ${cli}` };
    return { ok: true, bot: toResolved(b as KnownBot & { online: OnlineDaemonInfo }) };
  };

  if (spec.bot !== undefined) {
    const want = spec.bot.trim().toLowerCase();
    if (!want) return { ok: false, error: 'agent `bot` must not be empty' };
    const hits = known.filter((b) => b.aliases.includes(want));
    if (!hits.length) return { ok: false, error: `bot ${JSON.stringify(spec.bot)} is not a known bot (not in bots.json, and no online daemon has that name); ${describeKnown(known)}` };
    if (hits.length > 1) return { ok: false, error: `bot ${JSON.stringify(spec.bot)} matches more than one bot (${hits.map((b) => b.larkAppId).join(', ')}); use its larkAppId` };
    return settle(hits[0]!, `bot ${JSON.stringify(spec.bot)}`);
  }

  if (ownAppId) {
    const own = known.find((b) => b.larkAppId === ownAppId);
    if (!own?.online) return { ok: false, error: `this run's bot ${ownAppId} is not online; start it, or name another bot with \`bot\`` };
    if (cli && own.cliId && own.cliId !== cli) {
      const sameCli = known.filter((b) => b.cliId === cli);
      const hint = sameCli.length
        ? ` (${cli} bots: ${sameCli.map((b) => `${b.name} [${b.online ? 'online' : 'offline'}]`).join(', ')})`
        : ` (no known bot runs ${cli})`;
      return { ok: false, error: `agent cli ${JSON.stringify(cli)} does not match this run's bot ${own.name} (${own.cliId}); name the executing bot with \`bot\`${hint}` };
    }
    return settle(own, `this run's bot ${own.name}`);
  }

  // 终端起的 run 没有所属 bot：已知 bot 恰好一个时不必点名，否则要求说清楚（不按在线与否猜）
  if (known.length === 1) return settle(known[0]!, `bot ${known[0]!.name}`);
  return { ok: false, error: `agent needs \`bot\` (this run is not bound to a bot; ${describeKnown(known)})` };
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
