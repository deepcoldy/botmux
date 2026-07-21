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

import { test, expect } from './helpers/orca-botmux-app'
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

  test.beforeEach(async ({ orcaBotmuxPage }) => {
    await waitForSessionReady(orcaBotmuxPage)
    await waitForActiveWorktree(orcaBotmuxPage)
    await ensureTerminalVisible(orcaBotmuxPage)

    await orcaBotmuxPage.evaluate(async () => {
      const state = window.__store?.getState()
      if (!state) {
        return
      }
      state.updateSettings({ setupScriptLaunchMode: 'split-vertical' })
    })
  })

  test.afterEach(async ({ orcaBotmuxPage }) => {
    for (const id of createdWorktreeIds) {
      await removeWorktreeViaStore(orcaBotmuxPage, id)
    }
    createdWorktreeIds.length = 0
  })

  test('@headful setup-split flow does not produce dead terminals', async ({ orcaBotmuxPage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(orcaBotmuxPage)
    await waitForActiveTerminalManager(orcaBotmuxPage, 30_000)
    await checkWebglState(orcaBotmuxPage, 'home-initial')

    for (let i = 0; i < STRESS_ITERATIONS; i++) {
      const direction = i % 2 === 0 ? 'vertical' : 'horizontal'
      const newId = await createAndActivateWorktreeWithSetup(orcaBotmuxPage, `setup-${i}`, direction)
      createdWorktreeIds.push(newId)

      await expect.poll(async () => getActiveWorktreeId(orcaBotmuxPage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(orcaBotmuxPage)
      await waitForActiveTerminalManager(orcaBotmuxPage, 30_000)
      await waitForPaneCount(orcaBotmuxPage, 2, 15_000)
      await checkWebglState(orcaBotmuxPage, `setup-${i}`)
      await waitForAllPanesToHaveContent(orcaBotmuxPage, `setup-${i} both panes`)

      await switchToWorktree(orcaBotmuxPage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(orcaBotmuxPage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await removeWorktreeViaStore(orcaBotmuxPage, newId)
      createdWorktreeIds.pop()
    }
  })

  test('@headful setup-split then switch-back does not leave panes dead', async ({ orcaBotmuxPage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(orcaBotmuxPage)
    await waitForActiveTerminalManager(orcaBotmuxPage, 30_000)

    for (let i = 0; i < STRESS_ITERATIONS; i++) {
      const newId = await createAndActivateWorktreeWithSetup(
        orcaBotmuxPage,
        `switchback-${i}`,
        'vertical'
      )
      createdWorktreeIds.push(newId)

      await expect.poll(async () => getActiveWorktreeId(orcaBotmuxPage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(orcaBotmuxPage)
      await waitForActiveTerminalManager(orcaBotmuxPage, 30_000)
      await waitForPaneCount(orcaBotmuxPage, 2, 15_000)
      await waitForAllPanesToHaveContent(orcaBotmuxPage, `switchback-${i} initial`)

      await switchToWorktree(orcaBotmuxPage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(orcaBotmuxPage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await ensureTerminalVisible(orcaBotmuxPage)
      await waitForActiveTerminalManager(orcaBotmuxPage, 15_000)

      await switchToWorktree(orcaBotmuxPage, newId)
      await expect.poll(async () => getActiveWorktreeId(orcaBotmuxPage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(orcaBotmuxPage)
      await waitForActiveTerminalManager(orcaBotmuxPage, 15_000)
      await waitForAllPanesToHaveContent(orcaBotmuxPage, `switchback-${i} after return`)

      await switchToWorktree(orcaBotmuxPage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(orcaBotmuxPage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await removeWorktreeViaStore(orcaBotmuxPage, newId)
      createdWorktreeIds.pop()
    }
  })

  test('@headful rapid switching between many setup-split worktrees', async ({ orcaBotmuxPage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(orcaBotmuxPage)
    await waitForActiveTerminalManager(orcaBotmuxPage, 30_000)

    const worktreeIds = [homeWorktreeId]
    for (let i = 0; i < 4; i++) {
      const newId = await createAndActivateWorktreeWithSetup(orcaBotmuxPage, `multi-${i}`, 'vertical')
      createdWorktreeIds.push(newId)
      worktreeIds.push(newId)

      await expect.poll(async () => getActiveWorktreeId(orcaBotmuxPage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(orcaBotmuxPage)
      await waitForActiveTerminalManager(orcaBotmuxPage, 30_000)
      await waitForPaneCount(orcaBotmuxPage, 2, 15_000)
      await waitForAllPanesToHaveContent(orcaBotmuxPage, `multi-create-${i}`)
    }

    for (let round = 0; round < 3; round++) {
      for (const wId of worktreeIds) {
        await switchToWorktree(orcaBotmuxPage, wId)
        await expect.poll(async () => getActiveWorktreeId(orcaBotmuxPage), { timeout: 10_000 }).toBe(wId)
        await ensureTerminalVisible(orcaBotmuxPage)
        await waitForActiveTerminalManager(orcaBotmuxPage, 15_000)
        await waitForAllPanesToHaveContent(orcaBotmuxPage, `multi-r${round}-${wId.slice(0, 8)}`)
      }
    }
  })
})
