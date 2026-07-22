/**
 * Stress test for dead-terminal reproduction (setup-split flow).
 *
 * Why @headful: the dead-terminal bug is a WebGL canvas staleness issue — after
 * wrapInSplit() reparents the existing pane's container, the WebGL canvas can
 * fail to repaint. In headless mode WebGL is NEVER active, so the DOM fallback
 * renderer is used and the bug cannot manifest. Running headful ensures real
 * WebGL contexts matching production.
 *
 * See helpers/dead-terminal.ts for the shared worktree-creation helper that
 * replicates the exact activateAndRevealWorktree + ensureWorktreeHasInitialTerminal
 * production flow.
 */

import { test, expect } from './helpers/botmux-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  switchToWorktree,
  ensureTerminalVisible
} from './helpers/store'
import { waitForActiveTerminalManager, waitForPaneCount } from './helpers/terminal'
import {
  createAndActivateWorktreeWithSetup,
  removeWorktreeViaStore,
  waitForAllPanesToHaveContent,
  checkWebglState
} from './helpers/dead-terminal'

const STRESS_ITERATIONS = 5

test.describe('Dead Terminal Reproduction @headful', () => {
  const createdWorktreeIds: string[] = []

  test.beforeEach(async ({ botmuxPage }) => {
    await waitForSessionReady(botmuxPage)
    await waitForActiveWorktree(botmuxPage)
    await ensureTerminalVisible(botmuxPage)

    await botmuxPage.evaluate(async () => {
      const state = window.__store?.getState()
      if (!state) {
        return
      }
      state.updateSettings({ setupScriptLaunchMode: 'split-vertical' })
    })
  })

  test.afterEach(async ({ botmuxPage }) => {
    for (const id of createdWorktreeIds) {
      await removeWorktreeViaStore(botmuxPage, id)
    }
    createdWorktreeIds.length = 0
  })

  test('@headful setup-split flow does not produce dead terminals', async ({ botmuxPage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(botmuxPage)
    await waitForActiveTerminalManager(botmuxPage, 30_000)
    await checkWebglState(botmuxPage, 'home-initial')

    for (let i = 0; i < STRESS_ITERATIONS; i++) {
      const direction = i % 2 === 0 ? 'vertical' : 'horizontal'
      const newId = await createAndActivateWorktreeWithSetup(botmuxPage, `setup-${i}`, direction)
      createdWorktreeIds.push(newId)

      await expect.poll(async () => getActiveWorktreeId(botmuxPage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(botmuxPage)
      await waitForActiveTerminalManager(botmuxPage, 30_000)
      await waitForPaneCount(botmuxPage, 2, 15_000)
      await checkWebglState(botmuxPage, `setup-${i}`)
      await waitForAllPanesToHaveContent(botmuxPage, `setup-${i} both panes`)

      await switchToWorktree(botmuxPage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(botmuxPage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await removeWorktreeViaStore(botmuxPage, newId)
      createdWorktreeIds.pop()
    }
  })

  test('@headful setup-split then switch-back does not leave panes dead', async ({ botmuxPage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(botmuxPage)
    await waitForActiveTerminalManager(botmuxPage, 30_000)

    for (let i = 0; i < STRESS_ITERATIONS; i++) {
      const newId = await createAndActivateWorktreeWithSetup(
        botmuxPage,
        `switchback-${i}`,
        'vertical'
      )
      createdWorktreeIds.push(newId)

      await expect.poll(async () => getActiveWorktreeId(botmuxPage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(botmuxPage)
      await waitForActiveTerminalManager(botmuxPage, 30_000)
      await waitForPaneCount(botmuxPage, 2, 15_000)
      await waitForAllPanesToHaveContent(botmuxPage, `switchback-${i} initial`)

      await switchToWorktree(botmuxPage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(botmuxPage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await ensureTerminalVisible(botmuxPage)
      await waitForActiveTerminalManager(botmuxPage, 15_000)

      await switchToWorktree(botmuxPage, newId)
      await expect.poll(async () => getActiveWorktreeId(botmuxPage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(botmuxPage)
      await waitForActiveTerminalManager(botmuxPage, 15_000)
      await waitForAllPanesToHaveContent(botmuxPage, `switchback-${i} after return`)

      await switchToWorktree(botmuxPage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(botmuxPage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await removeWorktreeViaStore(botmuxPage, newId)
      createdWorktreeIds.pop()
    }
  })

  test('@headful rapid switching between many setup-split worktrees', async ({ botmuxPage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(botmuxPage)
    await waitForActiveTerminalManager(botmuxPage, 30_000)

    const worktreeIds = [homeWorktreeId]
    for (let i = 0; i < 4; i++) {
      const newId = await createAndActivateWorktreeWithSetup(botmuxPage, `multi-${i}`, 'vertical')
      createdWorktreeIds.push(newId)
      worktreeIds.push(newId)

      await expect.poll(async () => getActiveWorktreeId(botmuxPage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(botmuxPage)
      await waitForActiveTerminalManager(botmuxPage, 30_000)
      await waitForPaneCount(botmuxPage, 2, 15_000)
      await waitForAllPanesToHaveContent(botmuxPage, `multi-create-${i}`)
    }

    for (let round = 0; round < 3; round++) {
      for (const wId of worktreeIds) {
        await switchToWorktree(botmuxPage, wId)
        await expect.poll(async () => getActiveWorktreeId(botmuxPage), { timeout: 10_000 }).toBe(wId)
        await ensureTerminalVisible(botmuxPage)
        await waitForActiveTerminalManager(botmuxPage, 15_000)
        await waitForAllPanesToHaveContent(botmuxPage, `multi-r${round}-${wId.slice(0, 8)}`)
      }
    }
  })
})
