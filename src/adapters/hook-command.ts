/**
 * hook-command.ts
 *
 * 独立模块：构造 `botmux hook <cliId>` 的完整调用字符串。
 *
 * 之所以从本模块自身位置回推 cli.js，而非使用 process.argv[1]：
 *   - daemon 由 pm2 以 `dist/index-daemon.js` 启动，daemon 进程的 argv[1]
 *     是 index-daemon.js——它只 startDaemon()，不处理 hook 子命令。
 *   - 编译后本文件位于 `<pkgRoot>/dist/adapters/hook-command.js`，
 *     CLI 入口固定在 `<pkgRoot>/dist/cli.js`（package.json `bin.botmux` 指向它），
 *     即 `../cli.js`。源码 checkout 和 npm global 安装都如此——布局一致。
 *
 * ⚠️ 编译版单文件二进制（`bun build --compile`）不满足上面那条「布局一致」：
 * 模块图在虚拟只读的 `/$bunfs/` 下，`__dirname` 是 `/$bunfs/root`，于是
 * `join(__dirname,'..','cli.js')` 得到 `/$bunfs/cli.js`。这条路径**两重坏**，实测：
 *   ① `/$bunfs/` 只在本进程内可见——hook 命令恰恰是**交给别的进程**执行的
 *      （Claude / grok / opencode 从 settings.json 里读出来跑），子进程实测
 *      `CHILD_NO_BUNFS`；
 *   ② 这些字符串由 shell 执行，而双引号内**未转义的 `$bunfs` 被 sh 展开成空串**，
 *      `"/$bunfs/cli.js"` 实测解析成 `//cli.js`——连字面路径都不是。
 * 也就是说编译版写出的 hook 全部失效，且失效方式是「命令找不到」而非报错。
 *
 * 修法与 `src/core/self-spawn.ts` 同构：编译态**不拼路径**，直接 exec 二进制自身
 * 并把子命令当普通参数传（实测编译版 `botmux hook claude-code` /
 * `session-ready` / `user-prompt-hook` 三者都正常 dispatch，exit 0）。Node 态
 * 逐字不变——实测 Node 侧**必须**带 `cli.js` 路径，不带则 MODULE_NOT_FOUND，
 * 所以这里必须分流，不能收敛成同一条。
 *
 * 不从 worker-pool 导入，也不从 adapter 导入 worker-pool——避免循环依赖。
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isStandaloneBinary } from '../core/self-spawn.js';
import { resolveNativeSubagentRuntimeHookWrapperPath } from '../core/botmux-wrapper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 一条 botmux 子命令的 argv 形式。
 *
 * 编译态：`[<binary>, ...subcommand]`——没有脚本路径这一项。
 * Node 态：`[<node>, <dist/cli.js>, ...subcommand]`。
 *
 * 单一出口：三个导出全部经由它，避免「同一个判据三份实现各自漂移」——
 * 本文件此前正是三处各拼一遍 `join(__dirname,'..','cli.js')`。
 */
function botmuxInvocation(
  subcommand: string[],
  standalone: boolean = isStandaloneBinary(),
): { cmd: string; args: string[] } {
  if (standalone) {
    // process.execPath 是**真实磁盘路径**（编译态下也是），所以对别的进程有效。
    return { cmd: process.execPath, args: [...subcommand] };
  }
  return { cmd: process.execPath, args: [join(__dirname, '..', 'cli.js'), ...subcommand] };
}

/**
 * 把一条调用渲染成 **shell 命令字符串**：只给可执行路径与脚本路径加引号（容忍空格），
 * 子命令名与其参数不加引号。
 *
 * 用于「按 shell 字符串执行」的场景（Claude 家族的 settings.json `command` 字段）。
 * 需要 argv 的场景请用 `hookCommandParts`，切勿对本字符串再 `.split(' ')`。
 */
function renderShellCommand(cliId?: string, ...subcommand: string[]): string {
  // 判一次形态两处用：`botmuxInvocation` 决定 argv 里有没有脚本路径，这里决定给不给
  // 它加引号——两者必须看到同一个答案，各调一次 `isStandaloneBinary()` 只是让同一个
  // 判据有两个求值点。
  const standalone = isStandaloneBinary();
  const { cmd, args } = botmuxInvocation(cliId === undefined ? subcommand : [...subcommand, cliId], standalone);
  if (standalone) {
    // 只有可执行路径需要引号；子命令是字面量 token。
    return `"${cmd}" ${args.join(' ')}`;
  }
  return `"${cmd}" "${args[0]}" ${args.slice(1).join(' ')}`;
}

/**
 * 构造 `botmux hook <cliId>` 的 argv 形式 `{ cmd, args }`——规范形态。
 * 调用方用 `spawn(cmd, args)` 直接执行：无需 shell 解析、不怕路径含空格。
 * OpenCode 插件用它（spawnSync），避免「拼成带引号字符串再 split」把路径拆坏。
 */
export function hookCommandParts(cliId: string): { cmd: string; args: string[] } {
  return botmuxInvocation(['hook', cliId]);
}

/**
 * 构造 `botmux hook <cliId>` 的 **shell 命令字符串**。
 * 仅用于「按 shell 字符串执行」的场景，例如写进 Claude Code 的 `~/.claude/settings.json`
 * （其 `command` 字段由 Claude 经 shell 执行）。
 */
export function hookCommandFor(cliId: string): string {
  return renderShellCommand(cliId, 'hook');
}

/**
 * 构造 Claude 家族 `SessionStart` hook 的 **shell 命令字符串** → `botmux session-ready`。
 * 与 `hookCommandFor` 同源的路径解析与加引号策略，
 * 因为它被写进 Claude 进程级 `--settings` 的 `command` 字段、由 Claude 经 shell 执行。
 *
 * 无 cliId 参数：session-ready 只靠 hook 子进程继承的 `BOTMUX_SESSION_ID` /
 * `BOTMUX_LARK_APP_ID` env 定位会话与 daemon，不需要 CLI 类型。
 */
export function sessionReadyHookCommand(): string {
  return renderShellCommand(undefined, 'session-ready');
}

/**
 * 构造 dsh-tui 结构化回合空闲上报的 **shell 命令字符串** → `botmux __turn-idle-v2`。
 * 与 `sessionReadyHookCommand` 同源的路径解析与加引号策略：同样写进 CLI 进程的
 * env（`BOTMUX_TURN_IDLE_COMMAND`），由 dsh-tui 的 cordis wrapper 插件在
 * `agent/status` 落到 idle 时按 shell 字符串执行一次。CLI 侧靠子进程继承的
 * `BOTMUX_SESSION_ID` / `BOTMUX_LARK_APP_ID` 定位会话与 owning daemon，
 * 不需要 cliId。
 *
 * 子命令名带协议版本是**跨版本混装的 fail-closed 开关**，不是装饰：
 * 长命的 dsh-tui 进程里跑的是生成时那份 wrapper 插件（v2，会把事件时冻结的
 * turn/attempt/token 放进 payload），而命令指向的 `<dist>/cli.js` 会被 in-place
 * update / rollback 换成**任意版本**。若沿用不带版本的 `turn-idle`，v1 CLI 会
 * 完全不看 payload 里的 v2 身份，改读**执行时**的 marker/capability —— 那时 worker
 * 可能已经旋到下一轮 B，于是 A 轮的 idle 报告自称 B，tuple 与 token 都「确实是当前
 * B」，worker 的精确匹配 fence 通过，B 还在跑就 fireIdle()（真实提前放行）。
 * 仅靠 payload 里的 `v` 字段挡不住：v1 parser 根本不解析它。
 * 换成 v1 不认识的子命令后，混装只会「命令无法解释 → 一个请求都不发」（插件
 * fire-and-forget，静默 fail-closed），该轮退回既有兜底路径，绝不误判空闲。
 *
 * 名字用 `__` 前缀（本仓库内部子命令的既有形态，如 `__pty-smoke`）是为了**结构上
 * 不可能被插件命中**：v1 CLI 的 default 分支是 `runPluginCommandByName(command, …)`
 * 按**精确名**匹配已安装插件声明的 CLI 命令，而插件命令名的语法是
 * `^[a-z][a-z0-9._:-]{0,63}$`（core/plugins/convention-scanner.ts:114，首字符必须是
 * 小写字母）——`__` 开头的名字插件无法声明，因此这条命令在任何插件环境下都只会落到
 * `showHelp()`。若沿用 `turn-idle-v2` 这种合规名字，理论上存在「插件恰好声明同名
 * 命令」时被执行的余地（实测本机无插件、无同名，但那是环境事实，不是语法保证）。
 */
export function turnIdleHookCommand(): string {
  return renderShellCommand(undefined, '__turn-idle-v2');
}

/**
 * 构造 Claude 家族 `UserPromptSubmit` hook 的 shell 命令字符串 → `botmux user-prompt-hook`。
 * 与 sessionReadyHookCommand 同策略：写进全局 settings.json（aiden wrapper 会剥进程级
 * --settings，全局是唯一可靠渠道）。hook 子进程靠继承的 BOTMUX_SESSION_ID /
 * SESSION_DATA_DIR 定位 per-turn sidecar；缺 env / 读不到 sidecar 时空输出 exit 0
 * （fail-open：上下文丢失 < 卡住 prompt），且结构性保证永不 exit 2。
 */
export function userPromptHookCommand(): string {
  return renderShellCommand(undefined, 'user-prompt-hook');
}

/**
 * 构造 Claude Code `statusLine.command` 的 shell 命令字符串 → `botmux statusline`。
 * 与 sessionReadyHookCommand 同策略，但写进**进程级** `--settings`（不写全局：全局只能
 * 有一个 statusLine，写进去会覆盖用户自己的；被 wrapperCli 剥掉时卡片省略即可）。
 * 子进程靠继承的 BOTMUX_SESSION_ID 定位落盘目录、靠 BOTMUX_STATUSLINE_CHAIN 转发
 * 用户原有的 statusline 命令；缺 env 时静默 exit 0。
 */
export function statuslineHookCommand(): string {
  return renderShellCommand(undefined, 'statusline');
}

/**
 * Construct the process-scoped TraeCode `spawn_agent` runtime-policy hook.
 * The stable daemon-written wrapper lets a long-lived pane pick up the current
 * Node or standalone build instead of retaining a checkout-local entrypoint.
 */
export function nativeSubagentRuntimeHookCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return `"${resolveNativeSubagentRuntimeHookWrapperPath(env, platform)}"`;
}
