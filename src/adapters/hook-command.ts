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
 * 不从 worker-pool 导入，也不从 adapter 导入 worker-pool——避免循环依赖。
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 构造 `botmux hook <cliId>` 的 argv 形式 `{ cmd, args }`——规范形态。
 * 调用方用 `spawn(cmd, args)` 直接执行：无需 shell 解析、不怕路径含空格。
 * OpenCode 插件用它（spawnSync），避免「拼成带引号字符串再 split」把路径拆坏。
 */
export function hookCommandParts(cliId: string): { cmd: string; args: string[] } {
  const cliEntry = join(__dirname, '..', 'cli.js');
  return { cmd: process.execPath, args: [cliEntry, 'hook', cliId] };
}

/**
 * 构造 `botmux hook <cliId>` 的 **shell 命令字符串**（仅可执行路径与 cli.js 路径加引号，
 * 容忍空格；`hook` 子命令名与 cliId 不加引号）。
 * 仅用于「按 shell 字符串执行」的场景，例如写进 Claude Code 的 `~/.claude/settings.json`
 * （其 `command` 字段由 Claude 经 shell 执行）。需要 argv 的场景请用 `hookCommandParts`，
 * 切勿对本字符串再 `.split(' ')`。
 */
export function hookCommandFor(cliId: string): string {
  const { cmd, args } = hookCommandParts(cliId);
  return `"${cmd}" "${args[0]}" ${args.slice(1).join(' ')}`;
}
