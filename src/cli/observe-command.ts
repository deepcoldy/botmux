// `botmux observe` — read-only worker/session runtime observe CLI.
//
// Shape (v1):
//   botmux observe [--session <id>] [--lark-app <appId>] [--include-raw]
//
// The command shells out to `fetchObserveSnapshot` / `fetchObserveSession`,
// which reuse the daemon HMAC loopback IPC. It never talks to backends, tmux,
// or persistent stores directly — the daemon has already composed the
// canonical SessionRow that this CLI is a stdout shim over.
//
// Exit codes:
//   0  every probe returned `ok` (or session-level `not_found`, which is a
//      legitimate answer, not an error).
//   1  at least one probe surfaced `unauthorized`/`unreachable`/`daemon_offline`.
//   2  argument parsing failure.

import {
  fetchObserveSession,
  fetchObserveSnapshot,
} from '../services/session-observe-command-fetch.js';
import type { ObserveProbeStatus } from '../services/session-observe.js';

interface ParsedArgs {
  sessionId?: string;
  larkAppId?: string;
  includeRaw: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): { ok: true; args: ParsedArgs } | { ok: false; error: string } {
  const args: ParsedArgs = { includeRaw: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '--help' || raw === '-h') { args.help = true; continue; }
    if (raw === '--include-raw') { args.includeRaw = true; continue; }
    if (raw === '--session') {
      const v = argv[++i];
      if (!v) return { ok: false, error: `${raw} 需要一个值` };
      args.sessionId = v;
      continue;
    }
    if (raw?.startsWith('--session=')) { args.sessionId = raw.slice('--session='.length); continue; }
    if (raw === '--lark-app') {
      const v = argv[++i];
      if (!v) return { ok: false, error: `${raw} 需要一个值` };
      args.larkAppId = v;
      continue;
    }
    if (raw?.startsWith('--lark-app=')) { args.larkAppId = raw.slice('--lark-app='.length); continue; }
    return { ok: false, error: `未知参数：${raw}` };
  }
  return { ok: true, args };
}

const HELP_TEXT = `botmux observe — 读取 daemon 实时 SessionRow 投影（v1，只读）

用法：
  botmux observe                       # 列出所有在线 daemon 的所有会话
  botmux observe --session <id>        # 单个会话
  botmux observe --lark-app <appId>    # 仅指定 daemon
  botmux observe --include-raw         # 附加原始 SessionRow 供诊断

字段（v1 canonical）：
  identity/cli/backend, liveness (alive|not_running|closed|unknown),
  turn (working|idle|starting|analyzing|limited|stalled|interrupted|unknown),
  phase (仅 'unknown'), queued/parkedOrSuspended/closed (boolean|'unknown'),
  pendingRepo, lastActivityAt, workingDirectory, rawStatus, context.
  probe.status: ok|unauthorized|unreachable|not_found|daemon_offline。

context（上下文占用，仅 --session 单会话查询；Claude Code / Codex）：
  { usedTokens, windowTokens|null, compactions|null, measuredAt, source }
  usedTokens    最近一次请求的提示大小（不是累计 token）。
  windowTokens  CLI 自己报的上下文窗口；Claude 取 statusline 快照（超过 10 分钟即
                null），Codex 取 rollout 的 model_context_window；从不按模型名猜。
  compactions   上下文被压缩的次数；无法可靠统计时为 null（不是 0）。
  measuredAt    usedTokens 所在 transcript 条目的时间（epoch ms）。
  source        claude-transcript | codex-rollout。
  拿不到（别的 CLI、无 transcript、尚无用量、transcript 过大）时整块缺省——
  不会填 0 或猜测值。列表模式为避免批量扫 transcript 不带 context，要读请用 --session。

Probe 失败不回退旧缓存；phase 目前只报 unknown。
`;

function isFailureProbe(status: ObserveProbeStatus): boolean {
  return status === 'unauthorized' || status === 'unreachable' || status === 'daemon_offline';
}

export async function runObserveCommand(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n\n${HELP_TEXT}`);
    return 2;
  }
  if (parsed.args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  const { sessionId, larkAppId, includeRaw } = parsed.args;
  try {
    if (sessionId) {
      const session = await fetchObserveSession(sessionId, { larkAppId, includeRaw });
      process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
      return isFailureProbe(session.probe.status) ? 1 : 0;
    }
    const snapshot = await fetchObserveSnapshot({ larkAppId, includeRaw });
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    const anyFailure = snapshot.daemons.some(d => isFailureProbe(d.probe.status));
    return anyFailure ? 1 : 0;
  } catch (err) {
    process.stderr.write(`observe 失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
