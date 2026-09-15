/**
 * Operator-facing copy for "running daemon version vs disk version".
 *
 * Presence-based only: compare equality, never semver precedence. `0.0.0` (source
 * checkout / compiled binary without a baked version) is undetermined and must
 * not claim that anyone is ahead or behind.
 */
export const UNDETERMINED_BOTMUX_VERSION = '0.0.0';

export const SESSION_STORE_PROTOCOL = 'occupancy-v1' as const;
export type SessionStoreProtocol = typeof SESSION_STORE_PROTOCOL;

export function isComparableBotmuxVersion(version: string | undefined | null): version is string {
  const v = version?.trim();
  return !!v && v !== UNDETERMINED_BOTMUX_VERSION;
}

export function stripBotmuxVersionPrefix(version: string): string {
  return version.trim().replace(/^v/i, '');
}

/** True only when both sides are comparable and the strings differ. */
export function daemonVersionDiffersFromDisk(
  running: string | undefined | null,
  disk: string | undefined | null,
): boolean {
  return isComparableBotmuxVersion(running)
    && isComparableBotmuxVersion(disk)
    && running !== disk;
}

/** Shared operator sentence for history staleHint and the version card. */
export function formatDaemonVersionRestartHint(running: string, disk: string): string {
  return `运行中的 daemon v${stripBotmuxVersionPrefix(running)} 与磁盘 v${stripBotmuxVersionPrefix(disk)} 不一致，运行 botmux restart 应用`;
}

export type DaemonVersionGroup = { version: string; count: number };

export function groupDaemonVersions(
  versions: Array<string | undefined | null>,
): DaemonVersionGroup[] {
  const counts = new Map<string, number>();
  for (const raw of versions) {
    const key = isComparableBotmuxVersion(raw) ? raw : UNDETERMINED_BOTMUX_VERSION;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([version, count]) => ({ version, count }))
    .sort((a, b) => a.version.localeCompare(b.version));
}

/**
 * Footer / update-card line when at least one running daemon differs from disk.
 * Groups that are `0.0.0` or missing are omitted (undetermined, not a mismatch).
 */
export function formatRunningDaemonsRestartSummary(
  versions: Array<string | undefined | null>,
  disk: string | undefined | null,
): string | undefined {
  if (!isComparableBotmuxVersion(disk)) return undefined;
  const mismatched = groupDaemonVersions(versions)
    .filter(g => daemonVersionDiffersFromDisk(g.version, disk));
  if (mismatched.length === 0) return undefined;
  const parts = mismatched.map(g => `${g.count} 个 v${stripBotmuxVersionPrefix(g.version)}`).join(' / ');
  return `运行中的 daemon：${parts}（磁盘 v${stripBotmuxVersionPrefix(disk)}），运行 botmux restart 应用`;
}

export const INSTALL_RESTART_HINT = '若 daemon 正在运行，请执行 botmux restart 应用新版本';
