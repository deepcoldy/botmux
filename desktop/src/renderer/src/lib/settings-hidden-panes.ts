/**
 * Settings panes hidden from product chrome while code paths remain for later.
 * Why: botmux temporarily hides Computer Use and Remote Botmux Servers
 * without deleting the implementation.
 */
export const HIDDEN_SETTINGS_PANE_IDS = new Set(['computer-use', 'servers'] as const)

export type HiddenSettingsPaneId = 'computer-use' | 'servers'

export function isSettingsPaneHidden(paneId: string): boolean {
  return HIDDEN_SETTINGS_PANE_IDS.has(paneId as HiddenSettingsPaneId)
}
