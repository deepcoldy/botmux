import { test, expect } from './helpers/botmux-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

test.describe('Windows terminal env and shell identity', () => {
  test.beforeEach(async ({ botmuxPage }) => {
    await waitForSessionReady(botmuxPage)
    await waitForActiveWorktree(botmuxPage)
    await ensureTerminalVisible(botmuxPage)
  })

  test('dev terminal preserves parent PATH so PATH commands resolve', async ({ botmuxPage }) => {
    await waitForActiveTerminalManager(botmuxPage)

    const ptyId = await waitForActivePanePtyId(botmuxPage)
    const marker = `__BOTMUX_E2E_NODE_PATH_${Date.now()}__`

    // Why: before the dev PATH fallback, daemon-spawned PTYs could get PATH set
    // to only Botmux's dev CLI bin. A real terminal command catches that failure.
    await execInTerminal(botmuxPage, ptyId, `node -e "console.log('${marker}')"`)

    await waitForTerminalOutput(botmuxPage, marker, 15_000)
  })

  test('Windows tab icons stay pinned to the shell used at tab creation', async ({ botmuxPage }) => {
    test.skip(process.platform !== 'win32', 'Windows shell icons only render on Windows')

    const tabIds = await botmuxPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const state = store.getState()
      const worktreeId = state.activeWorktreeId
      if (!worktreeId) {
        throw new Error('No active worktree')
      }

      store.setState({
        settings: { ...state.settings!, terminalWindowsShell: 'wsl.exe' }
      })
      const wslTab = store.getState().createTab(worktreeId, undefined, undefined, {
        activate: false
      })

      store.setState({
        settings: { ...store.getState().settings!, terminalWindowsShell: 'cmd.exe' }
      })
      const cmdTab = store.getState().createTab(worktreeId, undefined, undefined, {
        activate: false
      })

      return { wslTabId: wslTab.id, cmdTabId: cmdTab.id }
    })

    const tabSnapshot = await botmuxPage.evaluate(({ wslTabId, cmdTabId }) => {
      const state = window.__store!.getState()
      const tabs = Object.values(state.tabsByWorktree).flat()
      return {
        wslShell: tabs.find((tab) => tab.id === wslTabId)?.shellOverride,
        cmdShell: tabs.find((tab) => tab.id === cmdTabId)?.shellOverride
      }
    }, tabIds)

    expect(tabSnapshot).toEqual({
      wslShell: 'wsl.exe',
      cmdShell: 'cmd.exe'
    })

    const wslTab = botmuxPage.locator(
      `[data-testid="sortable-tab"][data-tab-id="${tabIds.wslTabId}"]`
    )
    const cmdTab = botmuxPage.locator(
      `[data-testid="sortable-tab"][data-tab-id="${tabIds.cmdTabId}"]`
    )
    await expect(wslTab).toBeVisible()
    await expect(cmdTab).toBeVisible()

    await expect(wslTab.locator('[data-shell-icon]')).toHaveAttribute('data-shell-icon', 'wsl.exe')
    await expect(cmdTab.locator('[data-shell-icon]')).toHaveAttribute('data-shell-icon', 'cmd.exe')
  })
})
