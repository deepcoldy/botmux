/**
 * 从 worker 持有的会话后端解析「CLI 宿主进程是否存活」。
 *
 * 为什么需要它：opencode2 等适配器以 CLI 自身的状态库（SQLite）判定回合是否
 * 结束，但前台长工具期间状态库可以数分钟零写入（实测 opencode 2.0.32 前台
 * `sleep 150`：工具 running 的 149s 内零行创建/更新，tool.progress 为
 * ephemeral 不落库），因此「DB 静默超时」不能作为回合结束依据。适配器在
 * 回合结构未闭合时调用本探针：
 *
 *  - true：宿主进程存活，等待（长工具 / relay / 服务重启后续跑）属于回合的
 *    一部分，应继续判忙；
 *  - false：宿主进程已退出，未闭合结构按崩溃 / 孤儿 fail-open；
 *  - undefined：拿不到 pid（无 pid 的 adopt 等），适配器回退到自身的状态库
 *    时效窗口。
 *
 * pid 取自 worker 同步绑定的 backend.cliPid（spawn）或 tmux pane 的实时
 * pane_pid（getChildPid）。对 opencode2 的托管服务拓扑而言，该 pid 是 TUI
 * 客户端：执行服务（serve --service）崩溃时 TUI 会在约 8s 内自动重启服务、
 * 对账残留 running part 并注入 synthetic 消息续跑（实测），所以「客户端
 * 存活」正是续跑承诺的边界；探测 serve pid 反而会在重启窗口内误报死亡。
 */
import { pidIsSignalable } from '../../utils/process-alive.js';

export interface BackendPidSource {
  cliPid?: number;
  getChildPid?: () => number | null | undefined;
}

/** 见模块注释。惰性求值：适配器在一次 busy 查询内可多次调用。 */
export function cliProcessAliveFromBackend(
  be: BackendPidSource | null | undefined,
): boolean | undefined {
  const pid = be?.cliPid ?? be?.getChildPid?.() ?? undefined;
  // 0 / 负数（process group 语义）/ 非整数 / NaN 都不是有效单进程 pid。
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  // 与 worker 内既有的 isPidAlive 同策略：ESRCH=已退出→false；
  // EPERM（pid 被其他用户复用，已非我们的 CLI）同样按 false fail-open，
  // 避免在永远不会写 idle 标记的陌生进程上永久假忙碌。
  return pidIsSignalable(pid);
}
