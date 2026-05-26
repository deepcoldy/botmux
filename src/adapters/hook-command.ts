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
 * 构造 `botmux hook <cliId>` 的完整调用字符串。
 * Node 路径和 cli 路径均加引号，防路径含空格时解析出错。
 */
export function hookCommandFor(cliId: string): string {
  const cliEntry = join(__dirname, '..', 'cli.js');
  return `"${process.execPath}" "${cliEntry}" hook ${cliId}`;
}
