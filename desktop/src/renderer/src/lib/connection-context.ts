import { useAppStore } from '@/store'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { isBotmuxControlPlaneHostId } from '../../../shared/botmux-main-terminal-host'
import {
  getConnectionIdForFileFromState,
  getConnectionIdFromState
} from './connection-owner-resolution'

export { getConnectionIdFromState } from './connection-owner-resolution'

/**
 * Resolve the SSH connectionId for a worktree. Returns null for local repos,
 * the target ID string for remote repos, or undefined if the worktree/repo
 * cannot be found (e.g., store not yet hydrated).
 *
 * Botmux control-plane hosts return the **filesystem** SSH target so
 * FileExplorer can readdir session cwd. Do **not** use this for PTY spawn —
 * use {@link getPtyConnectionId} (always local for botmux).
 */
export function getConnectionId(worktreeId: string | null): string | null | undefined {
  return getConnectionIdFromState(useAppStore.getState(), worktreeId)
}

/**
 * Connection id for terminal PTY spawn / remote provider routing.
 * Botmux agent/session hosts always spawn a **local** PTY and run
 * `ssh -tt … tmux attach` in the shell — never SshPtyProvider.
 */
export function getPtyConnectionId(worktreeId: string | null): string | null | undefined {
  if (worktreeId && isBotmuxControlPlaneHostId(worktreeId)) {
    return null
  }
  return getConnectionId(worktreeId)
}

/**
 * True when we can determine the owning host (local vs. a specific SSH target)
 * for a worktree. False means the backing repo has not landed in the store yet
 * — e.g. right after a session restore while the SSH connection is still
 * establishing. Callers must not fall back to a LOCAL read of a remote path in
 * that window; doing so denies the path with a terminal "access denied" (#6648).
 */
export function isWorktreeConnectionResolved(worktreeId: string | null): boolean {
  if (!worktreeId) {
    return true
  }
  // Botmux control-plane hosts resolve immediately (local PTY; FS may be SSH).
  if (
    worktreeId === 'global-botmux-terminal' ||
    worktreeId.startsWith('botmux:session:') ||
    worktreeId.startsWith('botmux:agent:')
  ) {
    return true
  }
  const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
  if (parsedWorkspaceKey?.type === 'folder') {
    // Folder workspaces resolve per-file; treat them as resolved here and let
    // getConnectionIdForFile decide ownership for the concrete path.
    return true
  }
  // Why: getConnectionId returns undefined only when the backing repo is absent;
  // any found repo yields a string or null, so this mirrors "repo has hydrated".
  return getConnectionId(worktreeId) !== undefined
}

export function getConnectionIdForFile(
  worktreeId: string | null,
  filePath: string
): string | null | undefined {
  return getConnectionIdForFileFromState(useAppStore.getState(), worktreeId, filePath)
}
