/**
 * 会话相位 —— 命令合法性矩阵的行坐标（设计 docs/design/2026-09-11-command-router.md R6 / §5）。
 *
 * **由现有状态推导，不新增持久化字段。** 输入分两层：
 *   - 内存 `DaemonSession` 上的运行旗标：`worker`、`pendingRepo`、`pendingRepoCommitInFlight`、
 *     `worktreeCreating`、`cliReady`（后者由 worker 的 `prompt_ready` IPC 置位，见 types.ts）；
 *   - 持久化 `Session` 上刻意落盘以扛 daemon 重启的状态：`status`、`queued`、
 *     `initialUserTurnPending`。
 *
 * 相位之间是**互斥且全覆盖**的，判定顺序就是优先级：先看终态（closed），再看"worker 还没起"
 * 的几种等待态，最后按 CLI 提示符是否就绪、首轮是否已发分 spawning / ready / running。
 *
 *   none             无会话（新话题第一条、thread 里尚无 owner）
 *   pendingRepo      等选仓 / 建 worktree，worker 未起（持久化镜像 Session.pendingRepoSetup）
 *   worktreeCreating pendingRepo 之上正在建 worktree 或提交选仓（会话内 /repo wt 在无 pendingRepo 时也会置位）
 *   queued           停起态（Session.queued，worker:null，等 dashboard「开始」/ 群里第一条消息激活）
 *   dormant          会话在、worker 不在（restore 后等 refork、开场 fork 尚未发生）——今天透传会被
 *                    deliverPassthroughToExistingSession 的"worker 不在线"分支拒绝，正文触发 refork
 *   spawning         worker 已起、CLI 提示符未就绪（!cliReady）
 *   ready            提示符就绪、首轮未发（Session.initialUserTurnPending）
 *   running          正常运行
 *   closed           持久化 status = closed
 *
 * 纯函数：只读旗标，不碰 I/O。`ready`/`running` 在 riff / mojo 后端上只用于合法性判定
 * （它们的 prompt_ready 不含就绪证据，见设计 §5），级联另有后端门（§6）。
 */
import type { DaemonSession } from './types.js';

export type SessionPhase =
  | 'none'
  | 'pendingRepo'
  | 'worktreeCreating'
  | 'queued'
  | 'dormant'
  | 'spawning'
  | 'ready'
  | 'running'
  | 'closed';

export const SESSION_PHASES: readonly SessionPhase[] = [
  'none', 'pendingRepo', 'worktreeCreating', 'queued', 'dormant', 'spawning', 'ready', 'running', 'closed',
];

/** 相位里"会话记录存在"的那些（除 none）。 */
export function phaseHasSession(phase: SessionPhase): boolean {
  return phase !== 'none';
}

/** 相位里"有活的 worker 进程"的那些——今天透传能立即写入的前提。 */
export function phaseHasLiveWorker(phase: SessionPhase): boolean {
  return phase === 'spawning' || phase === 'ready' || phase === 'running';
}

export function deriveSessionPhase(ds: DaemonSession | undefined | null): SessionPhase {
  if (!ds) return 'none';
  if (ds.session.status === 'closed') return 'closed';
  if (ds.worktreeCreating || ds.pendingRepoCommitInFlight) return 'worktreeCreating';
  if (ds.pendingRepo) return 'pendingRepo';
  if (ds.session.queued) return 'queued';
  if (!ds.worker || ds.worker.killed) return 'dormant';
  if (!ds.cliReady) return 'spawning';
  if (ds.session.initialUserTurnPending) return 'ready';
  return 'running';
}
