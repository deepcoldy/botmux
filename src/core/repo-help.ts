/** Shared wire/display semantics for the recoverable "missing repo" help flow. */
export const MISSING_REPO_BLOCKER_PREFIX = '缺少项目环境：';

export function buildMissingRepoBlocker(repo: string, detail?: string): string {
  const suffix = detail?.trim();
  return `${MISSING_REPO_BLOCKER_PREFIX}${repo.trim()}${suffix ? `（${suffix}）` : ''}`;
}

export function isMissingRepoBlocker(blocker: string): boolean {
  return blocker.trim().startsWith(MISSING_REPO_BLOCKER_PREFIX);
}
