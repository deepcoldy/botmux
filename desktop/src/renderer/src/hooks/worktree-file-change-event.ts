import type { FsChangedPayload } from '../../../shared/types'

export const BOTMUX_WORKTREE_FILE_CHANGE_EVENT = 'botmux:worktree-file-change'

export type WorktreeFileChangeEventDetail = {
  payload: FsChangedPayload
  runtimeEnvironmentId: string | null
}
