import { homedir } from 'node:os';
import { join } from 'node:path';

function expandHome(path: string): string {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path;
}

/** OpenCode 的数据根目录：跟随 XDG_DATA_HOME，默认 ~/.local/share/opencode。
 *  保持动态解析（不在模块加载时固化），测试/子进程改 env 后仍能命中。 */
export function opencodeDataRoot(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const base = xdg ? expandHome(xdg) : join(homedir(), '.local', 'share');
  return join(base, 'opencode');
}

/** OpenCode 1.17+ 的全局 SQLite 库（session/message/part 表，所有项目共用一个）。
 *  作为 resume 目标探测、submit 验证与 cliSessionId 捕获的数据源。 */
export function opencodeDbPath(): string {
  return join(opencodeDataRoot(), 'opencode.db');
}
