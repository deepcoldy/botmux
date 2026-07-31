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
//   - riff 后端没有本地 bin/args（远端执行），返回 null → 接口报 unavailable，
//     绝不伪造一条本地命令误导排障。
// 供 worker 在 ready 时算出、上报给 daemon 只驻内存（含凭证，绝不落盘）。

import type { BackendType } from './types.js';
import { buildBotmuxEnvAssignments } from './tmux-backend.js';
import { buildWrappedLaunch } from '../../setup/cli-selection.js';

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
 *   - wrapperCli 生效**且** sandbox 关闭时 → 返回 wrapper 形态（`aiden x claude …`）。
 *     worker 侧 wrapperCli 与 file sandbox 互斥（sandboxOn 时忽略 wrapper），这里同构。
 *   - 其余（无 wrapper，或 sandbox 开启）→ 返回基础 CLI bin/args 原样。
 * 无论如何都**不**含 sandbox-exec / bwrap 外层——那是机器相关、裸 bash 跑不起来的包装。
 */
export function selectReproduceLaunch(input: {
  baseBin: string;
  baseArgs: string[];
  wrapperCli?: string;
  sandboxOn: boolean;
  binResolver?: (bin: string) => string;
  ttadkModel?: string;
}): { bin: string; args: string[] } {
  const { baseBin, baseArgs, wrapperCli, sandboxOn } = input;
  if (wrapperCli && wrapperCli.trim() && !sandboxOn) {
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
}

// 组装近似复现命令。riff（远端后端）返回 null。其余后端返回：
//   cd '<cwd>' && KEY='v' KEY2='v2' ... '<bin>' '<arg>' ...
// env 前缀取 buildBotmuxEnvAssignments（BOTMUX_* / SESSION_DATA_DIR /
// CLAUDE_CONFIG_DIR / CODEX_HOME / 代理 / per-bot 凭证），每个 VAL 做 bash 单引号转义。
export function buildReproduceCommand(input: ReproduceCommandInput): string | null {
  if (input.backendType === 'riff') return null;
  if (!input.bin) return null;

  const parts: string[] = [];
  // 权威注入 env（KEY=VAL 列表），VAL 做 bash 转义后作为命令前缀。
  for (const assignment of buildBotmuxEnvAssignments(input.env, input.injectEnv)) {
    const eq = assignment.indexOf('=');
    if (eq <= 0) continue;
    const key = assignment.slice(0, eq);
    const val = assignment.slice(eq + 1);
    parts.push(`${key}=${shq(val)}`);
  }
  parts.push(shq(input.bin), ...input.args.map(shq));
  const cmd = parts.join(' ');
  return input.cwd ? `cd ${shq(input.cwd)} && ${cmd}` : cmd;
}
