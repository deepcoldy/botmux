export const ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT = 'orca_botmux:editor-save-dirty-files'
export const ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT = 'orca_botmux:editor-prepare-hot-exit'

export type EditorSaveDirtyFilesDetail = {
  claim: () => void
  resolve: () => void
  reject: (message: string) => void
}

export type EditorPrepareHotExitDetail = EditorSaveDirtyFilesDetail
