/**
 * `botmux owner-board …`：本机外部客户端读管家的决策看板、替 owner 提交决定。
 *
 * 和会话里的 `botmux board`（管家写看板，会话鉴权）分开：这里走宿主机 daemon IPC 的 host HMAC
 *（与 `botmux observe` 相同的凭证，沙箱会话读不到），只调看板的几条 owner 路由。输出一律是 JSON，
 * 字段见 core/decision-board/owner-api.ts。
 *
 * 退出码：0 成功；1 daemon 不在线、拒绝或失败（stdout 仍是 `{ok:false,error,…}`）；2 参数错误。
 */
import { fetchDaemonIpc, loadDaemonIpcSecret } from '../core/daemon-ipc-auth.js';
import { listOnlineDaemons, type OnlineDaemonInfo } from '../utils/daemon-discovery.js';
import { OWNER_BOARD_REQUEST_ID_RE, parseOwnerBoardStates } from '../core/decision-board/owner-api.js';

export type OwnerBoardFetch = (port: number, path: string, init?: RequestInit, secret?: string) => Promise<Response>;

export interface OwnerBoardCommandDeps {
  discover?: () => OnlineDaemonInfo[];
  fetch?: OwnerBoardFetch;
  secret?: string;
  /** 读类请求的超时；提交单独用 {@link OWNER_BOARD_DECIDE_TIMEOUT_MS}（要等投递进管家会话）。 */
  timeoutMs?: number;
  decideTimeoutMs?: number;
  write?: (text: string) => void;
  writeError?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
}

export const OWNER_BOARD_READ_TIMEOUT_MS = 10_000;
export const OWNER_BOARD_DECIDE_TIMEOUT_MS = 120_000;

export const OWNER_BOARD_USAGE = `botmux owner-board — 本机外部客户端读管家的决策看板、提交决定（输出 JSON）

用法:
  botmux owner-board boards
        本机在线、开着管家的 bot：larkAppId、名字、是否可投递、管家群、各视图计数
  botmux owner-board list --bot <appId> [--state decide,accept] [--query <关键词>]
        列事项；--state 可写 decide / accept / active / waiting / done / closed 的逗号组合或 all，
        默认 decide,accept（待我拍板）
  botmux owner-board show --bot <appId> <编号>
        一项的全部字段、关联、最近 50 条历史
  botmux owner-board decide --bot <appId> <编号> --ask-key <askKey> --request-id <id>
                            [--choice <选项键>] [--text <说明>]
        提交一项决定（待拍板 / 待验收的项），和网页提交、卡片点击一样建批次并投进管家会话。
        --ask-key 取 list / show 里这一项的 askKey，管家之后改过问题、选项或状态就拒绝（ask_changed）；
        --request-id 是幂等键（8～64 个字母、数字、_、-），同一个 id 带同样的内容重试不会重复提交，
        上次没送达时顺带重投；同一个 id 换了事项或内容会被拒（request_id_reused）。
        --choice 和 --text 至少给一个。在 botmux 会话里（有 BOTMUX_SESSION_ID）运行会被拒绝：
        决定只能由 owner 自己的工具提交，不能由会话里的 Agent 代拍板。

鉴权：宿主机 daemon IPC 的 host HMAC（~/.botmux/.dashboard-secret，与 botmux observe 相同），
只连 127.0.0.1；沙箱会话里读不到这个凭证，调不通。
退出码：0 成功（decide 为 0 只表示决定已记下，是否送进管家会话看 batch.delivery）；
1 daemon 不在线 / 拒绝 / 失败（stdout 是 {"ok":false,"error":…}）；2 参数错误。
`;

type Action = 'boards' | 'list' | 'show' | 'decide';

interface Parsed {
  action: Action;
  bot?: string;
  seq?: number;
  state?: string;
  query?: string;
  askKey?: string;
  choice?: string;
  text?: string;
  requestId?: string;
}

const VALUE_FLAGS: Record<string, keyof Parsed> = {
  '--bot': 'bot',
  '--state': 'state',
  '--query': 'query',
  '--ask-key': 'askKey',
  '--choice': 'choice',
  '--text': 'text',
  '--request-id': 'requestId',
};

const FLAGS_BY_ACTION: Record<Action, ReadonlySet<keyof Parsed>> = {
  boards: new Set(),
  list: new Set(['bot', 'state', 'query']),
  show: new Set(['bot']),
  decide: new Set(['bot', 'askKey', 'choice', 'text', 'requestId']),
};

export function parseOwnerBoardArgs(argv: string[]): { ok: true; help: true } | { ok: true; parsed: Parsed } | { ok: false; error: string } {
  const [action, ...rest] = argv;
  if (!action || action === '--help' || action === '-h' || action === 'help') return { ok: true, help: true };
  if (action !== 'boards' && action !== 'list' && action !== 'show' && action !== 'decide') {
    return { ok: false, error: `未知子命令：${action}` };
  }
  const parsed: Parsed = { action };
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--help' || arg === '-h') return { ok: true, help: true };
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    const field = VALUE_FLAGS[name];
    if (field) {
      const value = eq > 0 && arg.startsWith('--') ? arg.slice(eq + 1) : rest[++i];
      if (value === undefined) return { ok: false, error: `${name} 需要一个值` };
      if (!FLAGS_BY_ACTION[action].has(field)) return { ok: false, error: `${action} 不接受 ${name}` };
      (parsed as unknown as Record<string, unknown>)[field] = value;
      continue;
    }
    if (arg.startsWith('--')) return { ok: false, error: `未知参数：${arg}` };
    positional.push(arg);
  }
  if (action === 'boards') {
    if (positional.length) return { ok: false, error: 'boards 不接受位置参数' };
    return { ok: true, parsed };
  }
  if (!parsed.bot?.trim()) return { ok: false, error: `${action} 要用 --bot <appId> 指定管家 bot` };
  parsed.bot = parsed.bot.trim();
  if (action === 'list') {
    if (positional.length) return { ok: false, error: 'list 不接受位置参数' };
    if (parsed.state !== undefined && !parseOwnerBoardStates(parsed.state)) return { ok: false, error: `--state 无效：${parsed.state}` };
    return { ok: true, parsed };
  }
  if (positional.length !== 1) return { ok: false, error: `${action} 要给一个事项编号` };
  const ref = positional[0]!.replace(/^#/, '');
  if (!/^\d{1,9}$/.test(ref)) return { ok: false, error: `事项编号无效：${positional[0]}` };
  parsed.seq = Number(ref);
  if (action === 'decide') {
    if (!parsed.askKey) return { ok: false, error: 'decide 要带 --ask-key（list / show 里的 askKey）' };
    if (!parsed.requestId || !OWNER_BOARD_REQUEST_ID_RE.test(parsed.requestId)) {
      return { ok: false, error: 'decide 要带 --request-id（8～64 个字母、数字、_、-）' };
    }
    if (!parsed.choice?.trim() && !parsed.text?.trim()) return { ok: false, error: 'decide 要给 --choice 或 --text' };
  }
  return { ok: true, parsed };
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as unknown;
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

interface CallResult { status: number; body: Record<string, unknown> }

export async function runOwnerBoardCommand(argv: string[], deps: OwnerBoardCommandDeps = {}): Promise<number> {
  const write = deps.write ?? (text => { process.stdout.write(text); });
  const writeError = deps.writeError ?? (text => { process.stderr.write(text); });
  const parsed = parseOwnerBoardArgs(argv);
  if (!parsed.ok) {
    writeError(`botmux owner-board: ${parsed.error}\n\n${OWNER_BOARD_USAGE}`);
    return 2;
  }
  if ('help' in parsed) {
    write(OWNER_BOARD_USAGE);
    return 0;
  }
  const args = parsed.parsed;
  const emit = (value: unknown) => write(`${JSON.stringify(value, null, 2)}\n`);
  const fail = (error: string, extra: Record<string, unknown> = {}) => { emit({ ok: false, error, ...extra }); return 1; };
  if (args.action === 'decide' && (deps.env ?? process.env).BOTMUX_SESSION_ID) {
    return fail('inside_botmux_session', { message: '在 botmux 会话里不能替 owner 提交决定；请从 owner 自己的工具里调用（不要继承 BOTMUX_SESSION_ID）' });
  }

  let secret = deps.secret;
  if (secret === undefined) {
    try { secret = loadDaemonIpcSecret(); }
    catch { return fail('host_secret_unavailable', { message: '读不到宿主机 daemon IPC 凭证（沙箱会话里不能用这个命令）' }); }
  }
  const fetchFn = deps.fetch ?? (fetchDaemonIpc as OwnerBoardFetch);
  const online = (deps.discover ?? (() => listOnlineDaemons()))();
  const readTimeout = deps.timeoutMs ?? OWNER_BOARD_READ_TIMEOUT_MS;
  const call = async (daemon: OnlineDaemonInfo, path: string, init: RequestInit = {}, ms = readTimeout): Promise<CallResult> => {
    return withTimeout(ms, async signal => {
      const res = await fetchFn(daemon.ipcPort, path, { ...init, signal }, secret);
      return { status: res.status, body: await readBody(res) };
    });
  };
  const relay = ({ status, body }: CallResult): number => {
    if (status >= 200 && status < 300 && body.ok === true) {
      emit(body);
      return 0;
    }
    const error = typeof body.error === 'string' ? body.error : `http_${status}`;
    const message = typeof body.message === 'string' ? body.message : undefined;
    // 旧 daemon 没有这组路由：外层闸放过之后路由表里找不到。
    const hint = status === 404 && error === 'not_found' ? { message: 'daemon 版本过旧，还没有 owner-board 接口；重启 daemon 后再试' } : {};
    return fail(error, { status, ...(message ? { message } : {}), ...hint });
  };

  try {
    if (args.action === 'boards') {
      const boards = await Promise.all(online.map(async daemon => {
        try {
          const { status, body } = await call(daemon, '/api/decision-board/meta');
          const steward = body.steward as { enabled?: unknown; ready?: unknown; chatId?: unknown } | undefined;
          if (status !== 200 || body.ok !== true || steward?.enabled !== true) return undefined;
          return {
            larkAppId: daemon.larkAppId,
            ...(daemon.botName ? { botName: daemon.botName } : {}),
            ready: steward.ready === true,
            ...(typeof steward.chatId === 'string' ? { chatId: steward.chatId } : {}),
            ...(body.counts && typeof body.counts === 'object' ? { counts: body.counts } : {}),
          };
        } catch {
          return undefined;
        }
      }));
      emit({ ok: true, boards: boards.filter(b => b !== undefined) });
      return 0;
    }
    const daemon = online.find(d => d.larkAppId === args.bot);
    if (!daemon) return fail('daemon_offline', { larkAppId: args.bot });
    if (args.action === 'list') {
      const qs = new URLSearchParams();
      if (args.state) qs.set('state', args.state);
      if (args.query) qs.set('q', args.query);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return relay(await call(daemon, `/api/decision-board/owner/items${suffix}`));
    }
    if (args.action === 'show') {
      return relay(await call(daemon, `/api/decision-board/owner/items/${args.seq}`));
    }
    return relay(await call(daemon, `/api/decision-board/owner/items/${args.seq}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        askKey: args.askKey,
        requestId: args.requestId,
        ...(args.choice?.trim() ? { choice: args.choice.trim() } : {}),
        ...(args.text !== undefined ? { text: args.text } : {}),
      }),
    }, deps.decideTimeoutMs ?? OWNER_BOARD_DECIDE_TIMEOUT_MS));
  } catch (error) {
    const timedOut = error instanceof Error && error.message === 'timeout';
    return fail(timedOut ? 'timeout' : 'unreachable', timedOut && args.action === 'decide'
      ? { message: '等投递超时；决定可能已经记下，用同一个 --request-id 重试即可（不会重复提交）' }
      : {});
  }
}
