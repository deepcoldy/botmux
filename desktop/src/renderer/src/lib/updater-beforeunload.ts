import {
  BOTMUX_APP_RESTART_ABORTED_EVENT,
  BOTMUX_APP_RESTART_STARTED_EVENT,
  BOTMUX_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT,
  BOTMUX_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT
} from '../../../shared/updater-renderer-events'

let intentionalAppRestartInProgress = false

export function isUpdaterQuitAndInstallInProgress(): boolean {
  return isIntentionalAppRestartInProgress()
}

export function isIntentionalAppRestartInProgress(): boolean {
  return intentionalAppRestartInProgress
}

export function registerUpdaterBeforeUnloadBypass(): () => void {
  const markInProgress = (): void => {
    intentionalAppRestartInProgress = true
  }
  const clearInProgress = (): void => {
    intentionalAppRestartInProgress = false
  }

  window.addEventListener(BOTMUX_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT, markInProgress)
  window.addEventListener(BOTMUX_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT, clearInProgress)
  window.addEventListener(BOTMUX_APP_RESTART_STARTED_EVENT, markInProgress)
  window.addEventListener(BOTMUX_APP_RESTART_ABORTED_EVENT, clearInProgress)

  return () => {
    window.removeEventListener(BOTMUX_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT, markInProgress)
    window.removeEventListener(BOTMUX_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT, clearInProgress)
    window.removeEventListener(BOTMUX_APP_RESTART_STARTED_EVENT, markInProgress)
    window.removeEventListener(BOTMUX_APP_RESTART_ABORTED_EVENT, clearInProgress)
    // Why: hot reloads can re-register this listener inside the same renderer.
    // Reset the module flag on cleanup so a failed earlier restart attempt
    // cannot silently suppress future unsaved-change prompts.
    intentionalAppRestartInProgress = false
  }
}
