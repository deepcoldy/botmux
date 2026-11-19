// src/adapters/backend/reproduce-command.ts
//
// Dashboard「复现命令」：把一次 session 冷启的 CLI 调用组装成一条可粘贴进调试终端
// （裸 bash）大致复现的命令。**近似**——不是当前进程的真实启动命令：
//   - 省略外层文件/读隔离 sandbox（bwrap/seatbelt）包装：那是机器相关、装在
//     bash 白板里也跑不起来，且会掩盖真正想复现的 CLI 行为。命令里注明。
//   - 省略 tmux/zellij 的 shell wrapper（rcfile 语义）：调试终端本身就是用户的
//     交互 bash，PATH/HOME/NVM 等由其 rcfile 提供，与 wrapper 目标一致；这里只补
//     botmux 注入的那批权威 env（buildBotmuxEnvAssignments）——正是它们平时靠
//     wrapper 的 `/usr/bin/env KEY=VAL` 注入、裸 bash 不会有。
//   - riff / mojo 后端没有本地 bin/args（远端执行），返回 null → 接口报 unavailable，
//     绝不伪造一条本地命令误导排障。
// 供 worker 在 ready 时算出、上报给 daemon 只驻内存（含凭证，绝不落盘）。

import type { BackendType } from './types.js';
import { buildBotmuxEnvAssignments } from './tmux-backend.js';
import { buildWrappedLaunch } from '../../setup/cli-selection.js';
import { buildForgeTraexLaunch, type CliLaunchMode } from '../../core/cli-launch-mode.js';
import { isRemoteBackendId } from '../../core/remote-cli-ids.js';

/** POSIX 单引号转义，安全用于 bash 粘贴。 */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 选出复现命令应展示的 bin/args——mirror worker.ts spawnCli 里 reproduce 快照的决策，
 * 抽成纯函数便于锁测试（codex review P1：确保绝不含 sandbox wrapper）。
 *
 * 输入是**基础 CLI** 的 bin/args（cliAdapter.resolvedBin + buildArgs 产出，未经任何
 * Seatbelt/bwrap/credential 改写）。规则：
 *   - wrapperCli 生效时 → 返回 wrapper 形态（`aiden x claude …`）。sandbox 关闭时 wrapper
 *     总是生效；sandbox 开启时只有 worker 把 wrapper 放进沙盒执行（wrapperInsideSandbox）
 *     才生效，其余后端在沙盒下仍忽略 wrapper，这里同构。
 *   - 其余 → 返回基础 CLI bin/args 原样。
 * 无论如何都**不**含 sandbox-exec / bwrap 外层——那是机器相关、裸 bash 跑不起来的包装。
 */
export function selectReproduceLaunch(input: {
  baseBin: string;
  baseArgs: string[];
  wrapperCli?: string;
  cliLaunchMode?: CliLaunchMode;
  sandboxOn: boolean;
  /** worker 把 wrapperCli 放进了文件沙盒内执行。 */
  wrapperInsideSandbox?: boolean;
  binResolver?: (bin: string) => string;
  ttadkModel?: string;
}): { bin: string; args: string[] } {
  const { baseBin, baseArgs, wrapperCli, cliLaunchMode, sandboxOn } = input;
  if (cliLaunchMode === 'forge-traex' && !sandboxOn) {
    const launch = buildForgeTraexLaunch(baseArgs, input.binResolver ?? ((b) => b));
    return { bin: launch.bin, args: launch.args };
  }
  if (wrapperCli && wrapperCli.trim() && (!sandboxOn || input.wrapperInsideSandbox)) {
    const launch = buildWrappedLaunch(
      wrapperCli,
      baseArgs,
      input.binResolver ?? ((b) => b),
      { ttadkModel: input.ttadkModel },
    );
    if (launch.bin) return { bin: launch.bin, args: launch.args };
  }
  return { bin: baseBin, args: [...baseArgs] };
}

export interface ReproduceCommandInput {
  backendType: BackendType;
  /** CLI 自身的可执行文件（cliAdapter.resolvedBin，或 wrapperCli 改写后的启动器）。
   *  应为**未被 sandbox 包装**的形态。 */
  bin: string;
  /** CLI argv（buildArgs 产出，或 wrapperCli 改写后）。未被 sandbox 包装。 */
  args: string[];
  /** 工作目录。 */
  cwd?: string;
  /** worker 的完整 childEnv——用于抽取 botmux 注入的权威 env 键。 */
  env?: NodeJS.ProcessEnv;
  /** 每 bot 注入 env（bots.json env，含 provider 凭证）。 */
  injectEnv?: Record<string, string>;
  /** SpawnOpts.unsetEnv：pane/子进程要移除的继承变量。裸 bash 的 `KEY=VAL cmd`
   *  前缀删不掉已导出的变量，因此这里表达成 `env -u KEY …`——与 pane wrapper
   *  在 rcfile 之后的 exec 位置一致。 */
  unsetEnv?: readonly string[];
  /** Turn-authored git `-c` pairs; rebuilt into GIT_CONFIG_* assignments. */
  gitConfigPairs?: ReadonlyArray<readonly [string, string]>;
}

// 组装近似复现命令。riff / mojo（远端后端）返回 null。其余后端返回：
//   cd '<cwd>' && KEY='v' ... /usr/bin/env -u KEY '<bin>' '<arg>' ...
// env 前缀取 buildBotmuxEnvAssignments（BOTMUX_* / SESSION_DATA_DIR /
// CLAUDE_CONFIG_DIR / CODEX_HOME / 代理 / per-bot 凭证），每个 VAL 做 bash 单引号转义。
// 该函数把 `-u KEY` token 识别为「移除」，不再被 `eq <= 0` 静默丢掉：Dashboard
// 复制出来的命令必须和真实 spawn 一致，否则 demoted/fresh 会话会被误 resume。
export function buildReproduceCommand(input: ReproduceCommandInput): string | null {
  if (isRemoteBackendId(input.backendType)) return null;
  if (!input.bin) return null;

  const assignments: string[] = [];
  const removals: string[] = [];
  // buildBotmuxEnvAssignments is the single source of truth for WHICH keys are
  // removable (it applies the same session-env lock rule as the panes).
  const tokens = buildBotmuxEnvAssignments(input.env, input.injectEnv, input.unsetEnv, input.gitConfigPairs);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === '-u') {
      const key = tokens[i + 1];
      i += 1;
      if (key) removals.push(key);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    const key = token.slice(0, eq);
    const val = token.slice(eq + 1);
    assignments.push(`${key}=${shq(val)}`);
  }

  const parts: string[] = [];
  if (removals.length > 0) {
    // `env -u K KEY=VAL cmd` applies the assignments and drops K before exec —
    // exactly what the pane wrapper does for the real child.
    parts.push('/usr/bin/env', ...removals.flatMap(key => ['-u', key]), ...assignments);
  } else {
    parts.push(...assignments);
  }
  parts.push(shq(input.bin), ...input.args.map(shq));
  const cmd = parts.join(' ');
  return input.cwd ? `cd ${shq(input.cwd)} && ${cmd}` : cmd;
}
