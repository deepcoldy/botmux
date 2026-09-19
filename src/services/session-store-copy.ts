/**
 * Operator vs session-subprocess copy for session-store hold / unmigrated.
 *
 * A process with BOTMUX_SESSION_ID or an origin channel only states the
 * situation — never a fleet-level `botmux restart`, and never pid / port /
 * version. Those subprocesses can be a legal host inside an unsandboxed
 * session; an agent that follows a restart instruction would bounce the
 * whole bot.
 */

export type HolderReason =
  | 'lease'
  | 'daemon_without_lease'
  | 'legacy_daemon'
  | 'store_unreadable';

export const UNMIGRATED_OPERATOR_HINT =
  '会话库尚未迁移到 SQLite，请重启 daemon（`botmux restart`）后重试';

export const LEGACY_DAEMON_OPERATOR_HINT =
  '后台 daemon 是升级前的旧进程，请先运行 `botmux restart`';

export const DAEMON_ONLINE_OPERATOR_HINT = 'daemon 在线';

export const DAEMON_WITHOUT_LEASE_OPERATOR_HINT =
  'daemon 在线但暂未持有会话库租约';

export const STORE_UNREADABLE_OPERATOR_HINT = '会话库不可读';

export const SESSION_STORE_WRITE_BLOCKED =
  'daemon 当前不接受会话库写入，本次未做任何修改';

export const SESSION_STORE_UNMIGRATED =
  '会话库尚未迁移到 SQLite，本次未做任何修改';

export function isSessionScopedCliProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.BOTMUX_SESSION_ID || env.BOTMUX_ORIGIN_CHANNEL_ID);
}

export function formatUnmigratedMessage(opts: { sessionScoped?: boolean } = {}): string {
  return opts.sessionScoped ? SESSION_STORE_UNMIGRATED : UNMIGRATED_OPERATOR_HINT;
}

export function formatStoreHoldMessage(
  heldBy: HolderReason,
  opts: { sessionScoped?: boolean } = {},
): string {
  if (opts.sessionScoped) return SESSION_STORE_WRITE_BLOCKED;
  switch (heldBy) {
    case 'lease':
      return DAEMON_ONLINE_OPERATOR_HINT;
    case 'daemon_without_lease':
      return DAEMON_WITHOUT_LEASE_OPERATOR_HINT;
    case 'legacy_daemon':
      return LEGACY_DAEMON_OPERATOR_HINT;
    case 'store_unreadable':
      return STORE_UNREADABLE_OPERATOR_HINT;
  }
}
