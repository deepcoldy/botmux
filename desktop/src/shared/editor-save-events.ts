export const BOTMUX_EDITOR_SAVE_DIRTY_FILES_EVENT = 'botmux:editor-save-dirty-files'
export const BOTMUX_EDITOR_PREPARE_HOT_EXIT_EVENT = 'botmux:editor-prepare-hot-exit'

export type EditorSaveDirtyFilesDetail = {
  claim: () => void
  resolve: () => void
  reject: (message: string) => void
}

export type EditorPrepareHotExitDetail = EditorSaveDirtyFilesDetail
