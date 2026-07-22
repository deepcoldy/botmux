/**
 * E2E tests for inline tab renaming (double-click a tab to rename).
 *
 * User Prompt:
 * - double-click a tab to rename it inline
 */

import { test, expect } from './helpers/botmux-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabId,
  getWorktreeTabs,
  ensureTerminalVisible
} from './helpers/store'

test.describe('Tab Rename (Inline)', () => {
  test.beforeEach(async ({ botmuxPage }) => {
    await waitForSessionReady(botmuxPage)
    await waitForActiveWorktree(botmuxPage)
    await ensureTerminalVisible(botmuxPage)
    // Why: clear any custom titles left by a previous test (the Electron app
    // persists across tests in the worker) so tab locators key off the default
    // title, not a stale rename like "My Custom Title".
    await botmuxPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        return
      }
      const state = store.getState()
      for (const tabs of Object.values(state.tabsByWorktree)) {
        for (const tab of tabs) {
          if (tab.customTitle != null) {
            state.setTabCustomTitle(tab.id, null)
          }
        }
      }
    })
  })

  async function getActiveTabTitle(
    page: Parameters<typeof getActiveTabId>[0],
    worktreeId: string
  ): Promise<string> {
    const activeId = await getActiveTabId(page)
    expect(activeId).not.toBeNull()
    const tabs = await getWorktreeTabs(page, worktreeId)
    const tab = tabs.find((entry) => entry.id === activeId)
    expect(tab).toBeDefined()
    // Why: mirror what the UI renders (customTitle ?? title) so locators that
    // key off the tab's visible text match what's actually on screen.
    return tab!.customTitle ?? tab!.title ?? ''
  }

  function tabLocatorByTitle(
    page: Parameters<typeof getActiveTabId>[0],
    title: string
  ): ReturnType<Parameters<typeof getActiveTabId>[0]['locator']> {
    // Why: backslash first so the backslashes we introduce when escaping the
    // double-quote aren't themselves re-escaped; both chars are CSS-selector
    // metacharacters inside a double-quoted attribute value.
    const escaped = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return page.locator(`[data-testid="sortable-tab"][data-tab-title="${escaped}"]`).first()
  }

  async function dispatchMiddleClickSequence(
    locator: ReturnType<Parameters<typeof getActiveTabId>[0]['locator']>
  ): Promise<void> {
    await locator.evaluate((element) => {
      const eventInit = { bubbles: true, cancelable: true, button: 1 }
      element.dispatchEvent(new MouseEvent('mousedown', { ...eventInit, buttons: 4 }))
      element.dispatchEvent(new MouseEvent('mouseup', eventInit))
      element.dispatchEvent(new MouseEvent('auxclick', eventInit))
    })
  }

  async function getActiveCustomTitle(
    page: Parameters<typeof getActiveTabId>[0],
    worktreeId: string
  ): Promise<string | null> {
    return page.evaluate((targetWorktreeId) => {
      const store = window.__store
      if (!store) {
        return null
      }

      const state = store.getState()
      const activeId = state.activeTabIdByWorktree[targetWorktreeId] ?? state.activeTabId
      const tab = (state.tabsByWorktree[targetWorktreeId] ?? []).find((t) => t.id === activeId)
      return tab?.customTitle ?? null
    }, worktreeId)
  }

  test('double-clicking a tab opens an inline rename input and Enter commits', async ({
    botmuxPage
  }) => {
    const worktreeId = (await getActiveWorktreeId(botmuxPage))!
    const originalTitle = await getActiveTabTitle(botmuxPage, worktreeId)
    expect(originalTitle.length).toBeGreaterThan(0)

    const tabLocator = tabLocatorByTitle(botmuxPage, originalTitle)
    await tabLocator.dblclick()

    const renameInput = botmuxPage.getByRole('textbox', {
      name: `Rename tab ${originalTitle}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()

    await renameInput.fill('My Custom Title')
    await renameInput.press('Enter')

    await expect
      .poll(async () => getActiveCustomTitle(botmuxPage, worktreeId), { timeout: 3_000 })
      .toBe('My Custom Title')
    await expect(renameInput).toBeHidden()
    await expect(tabLocatorByTitle(botmuxPage, 'My Custom Title')).toBeVisible()
  })

  test('context-menu Change Title opens a focused select-all rename input', async ({
    botmuxPage
  }) => {
    const worktreeId = (await getActiveWorktreeId(botmuxPage))!
    const originalTitle = await getActiveTabTitle(botmuxPage, worktreeId)
    expect(originalTitle.length).toBeGreaterThan(0)

    await tabLocatorByTitle(botmuxPage, originalTitle).click({ button: 'right' })
    await botmuxPage.getByRole('menuitem', { name: 'Change Title', exact: true }).click()

    const renameInput = botmuxPage.getByRole('textbox', {
      name: `Rename tab ${originalTitle}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()
    await expect(renameInput).toBeFocused()

    // Why: after the context-menu path proves focus lands in the inline input,
    // fill avoids per-keystroke timing races in the shared full-suite browser.
    await renameInput.fill('Context Menu Title')
    await renameInput.press('Enter')

    await expect
      .poll(async () => getActiveCustomTitle(botmuxPage, worktreeId), { timeout: 3_000 })
      .toBe('Context Menu Title')
    await expect(tabLocatorByTitle(botmuxPage, 'Context Menu Title')).toBeVisible()
  })

  test('Escape during inline rename discards the edit', async ({ botmuxPage }) => {
    const worktreeId = (await getActiveWorktreeId(botmuxPage))!
    const originalTitle = await getActiveTabTitle(botmuxPage, worktreeId)

    const tabLocator = tabLocatorByTitle(botmuxPage, originalTitle)
    await tabLocator.dblclick()

    const renameInput = botmuxPage.getByRole('textbox', {
      name: `Rename tab ${originalTitle}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()

    await renameInput.fill('Should Be Discarded')
    await renameInput.press('Escape')

    await expect(renameInput).toBeHidden()
    // Why: the final assertion must be on user-observable DOM, not the store's
    // customTitle field. A render-layer bug where the tab silently paints the
    // in-progress "Should Be Discarded" text would leave customTitle null
    // (Escape cleared it) yet flash the discarded label to the user — the
    // original title must still be the one rendered on the tab.
    await expect(tabLocatorByTitle(botmuxPage, originalTitle)).toBeVisible()
    await expect
      .poll(async () => getActiveCustomTitle(botmuxPage, worktreeId), { timeout: 3_000 })
      .toBe(null)
  })

  test('renaming to an empty string resets the tab to its default title', async ({ botmuxPage }) => {
    const worktreeId = (await getActiveWorktreeId(botmuxPage))!

    // Snapshot the default (non-custom) title first so the DOM assertion later
    // can verify the tab reverts to *this exact* rendered text — a store-only
    // `customTitle === null` check would pass even if the rendered label was
    // stuck on "Seeded Custom".
    const defaultTitle = await getActiveTabTitle(botmuxPage, worktreeId)
    expect(defaultTitle.length).toBeGreaterThan(0)

    // Why: seed a custom title directly via the store so this test asserts the
    // "empty string → reset" behavior independently from the double-click flow.
    await botmuxPage.evaluate((targetWorktreeId) => {
      const store = window.__store
      if (!store) {
        return
      }

      const state = store.getState()
      const activeId = state.activeTabIdByWorktree[targetWorktreeId] ?? state.activeTabId
      if (activeId) {
        state.setTabCustomTitle(activeId, 'Seeded Custom')
      }
    }, worktreeId)

    await expect
      .poll(async () => getActiveCustomTitle(botmuxPage, worktreeId), { timeout: 3_000 })
      .toBe('Seeded Custom')

    const tabLocator = tabLocatorByTitle(botmuxPage, 'Seeded Custom')
    await tabLocator.dblclick()

    const renameInput = botmuxPage.getByRole('textbox', {
      name: 'Rename tab Seeded Custom',
      exact: true
    })
    await expect(renameInput).toBeVisible()

    await renameInput.fill('')
    await renameInput.press('Enter')

    // User-observable DOM assertion: the tab element must re-render with the
    // original default title, not the "Seeded Custom" override.
    await expect(tabLocatorByTitle(botmuxPage, defaultTitle)).toBeVisible()
    await expect
      .poll(async () => getActiveCustomTitle(botmuxPage, worktreeId), { timeout: 3_000 })
      .toBe(null)
  })

  test('clicking away (blur) commits the rename', async ({ botmuxPage }) => {
    const worktreeId = (await getActiveWorktreeId(botmuxPage))!

    // Why: need a second tab so we have something to click that isn't the
    // rename input itself. Seed both with known titles so we can locate them.
    await botmuxPage.evaluate((targetWorktreeId) => {
      const store = window.__store
      if (!store) {
        return
      }
      const state = store.getState()
      const existing = state.tabsByWorktree[targetWorktreeId] ?? []
      if (existing.length < 2) {
        state.createTab(targetWorktreeId)
      }
    }, worktreeId)

    await expect
      .poll(async () => (await getWorktreeTabs(botmuxPage, worktreeId)).length, { timeout: 3_000 })
      .toBeGreaterThanOrEqual(2)

    const tabs = await getWorktreeTabs(botmuxPage, worktreeId)
    const activeId = await getActiveTabId(botmuxPage)
    const activeTab = tabs.find((t) => t.id === activeId)!
    const otherTab = tabs.find((t) => t.id !== activeId)!

    const tabLocator = tabLocatorByTitle(botmuxPage, activeTab.title!)
    await tabLocator.dblclick()

    const renameInput = botmuxPage.getByRole('textbox', {
      name: `Rename tab ${activeTab.title}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()

    await renameInput.fill('Committed By Blur')
    // Why: clicking the other tab triggers blur on the input, which should
    // run commitRename and save the typed title before the focus shifts.
    await tabLocatorByTitle(botmuxPage, otherTab.title!).click()

    await expect(renameInput).toBeHidden()
    await expect(tabLocatorByTitle(botmuxPage, 'Committed By Blur')).toBeVisible()
    expect(
      await botmuxPage.evaluate(
        ({ targetWorktreeId, targetTabId }) => {
          const store = window.__store
          const state = store!.getState()
          const tab = (state.tabsByWorktree[targetWorktreeId] ?? []).find(
            (t) => t.id === targetTabId
          )
          return tab?.customTitle ?? null
        },
        { targetWorktreeId: worktreeId, targetTabId: activeTab.id }
      )
    ).toBe('Committed By Blur')
  })

  test('right-clicking during inline rename commits and opens context menu', async ({
    botmuxPage
  }) => {
    const worktreeId = (await getActiveWorktreeId(botmuxPage))!
    const originalTitle = await getActiveTabTitle(botmuxPage, worktreeId)

    const tabLocator = tabLocatorByTitle(botmuxPage, originalTitle)
    await tabLocator.dblclick()

    const renameInput = botmuxPage.getByRole('textbox', {
      name: `Rename tab ${originalTitle}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()

    await renameInput.fill('Committed By Right Click')
    // Why: right-clicking the tab blurs the input (commitRename runs) and
    // opens the context menu. We assert the rename was saved; the menu
    // assertion is intentionally light because the menu markup is shared
    // with other specs.
    await tabLocator.click({ button: 'right' })

    await expect
      .poll(async () => getActiveCustomTitle(botmuxPage, worktreeId), { timeout: 3_000 })
      .toBe('Committed By Right Click')
    await expect(renameInput).toBeHidden()
  })

  test('rename input stays at a usable width when many tabs are open', async ({ botmuxPage }) => {
    const worktreeId = (await getActiveWorktreeId(botmuxPage))!
    const targetTabId = await getActiveTabId(botmuxPage)
    expect(targetTabId).not.toBeNull()
    const targetTitle = 'Width Target Tab'

    // Why: create enough terminal tabs that flex space runs out. 15 is well
    // above the threshold at which the pre-fix input collapsed, and it keeps
    // the test fast. The width fix pins the input to 72px (matching the
    // slimmer tab title box), so even saturated, it should stay near that
    // size — we assert ≥60px to allow a bit of slack for fonts/padding/
    // containers differing between environments. The meaningful guarantee is
    // that the input does not collapse to ~0 when flex space is saturated.
    await botmuxPage.evaluate(
      ({ targetWorktreeId, targetTabId, targetTitle }) => {
        const store = window.__store
        if (!store) {
          return
        }
        const state = store.getState()
        const existing = state.tabsByWorktree[targetWorktreeId] ?? []
        for (const [index, tab] of existing.entries()) {
          // Why: shell-driven terminal title updates can race this crowded-tab
          // assertion; custom titles keep the rename target stable.
          state.setTabCustomTitle(
            tab.id,
            tab.id === targetTabId ? targetTitle : `Width Filler ${index + 1}`
          )
        }
        for (let i = existing.length; i < 15; i++) {
          const tab = state.createTab(targetWorktreeId, undefined, undefined, { activate: false })
          state.setTabCustomTitle(tab.id, `Width Filler ${i + 1}`)
        }
      },
      { targetWorktreeId: worktreeId, targetTabId, targetTitle }
    )

    await expect
      .poll(async () => (await getWorktreeTabs(botmuxPage, worktreeId)).length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(15)
    await expect
      .poll(async () => getActiveCustomTitle(botmuxPage, worktreeId), { timeout: 3_000 })
      .toBe(targetTitle)

    const tabLocator = tabLocatorByTitle(botmuxPage, targetTitle)
    await tabLocator.scrollIntoViewIfNeeded()
    await expect(tabLocator).toBeVisible()
    // Why: once 15 tabs are packed into the strip, the tab center can overlap
    // the close affordance. Target the visible title text, which is the rename
    // hit area users aim for.
    const tabTitle = tabLocator.getByText(targetTitle, { exact: true })
    await expect(tabTitle).toBeVisible()
    // Why: this spec is about saturated-tab input width. The real pointer
    // double-click path is covered above; dispatching the tab's own dblclick
    // handler avoids pixel-level overlap flakes in the crowded strip.
    await tabLocator.evaluate((element) => {
      element.dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          cancelable: true,
          button: 0
        })
      )
    })

    const renameInput = botmuxPage.getByRole('textbox', {
      name: `Rename tab ${targetTitle}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()

    const width = await renameInput.evaluate((element) => element.getBoundingClientRect().width)
    expect(width).toBeGreaterThanOrEqual(60)
  })

  test('middle-clicking inside the rename input does not close the tab', async ({ botmuxPage }) => {
    const worktreeId = (await getActiveWorktreeId(botmuxPage))!
    const tabsBefore = (await getWorktreeTabs(botmuxPage, worktreeId)).length
    const originalTitle = await getActiveTabTitle(botmuxPage, worktreeId)

    const tabLocator = tabLocatorByTitle(botmuxPage, originalTitle)
    await tabLocator.dblclick()

    const renameInput = botmuxPage.getByRole('textbox', {
      name: `Rename tab ${originalTitle}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()

    // Why: the outer tab's middle-click handler closes the tab. The rename
    // input stops propagation + preventDefaults middle-click so the tab
    // isn't closed while the user is editing.
    await dispatchMiddleClickSequence(renameInput)

    // The tab must still exist — no regression where editing-then-middle-click
    // accidentally closes the tab out from under the input.
    await expect(renameInput).toBeVisible()
    await expect(tabLocatorByTitle(botmuxPage, originalTitle)).toBeVisible()
    expect((await getWorktreeTabs(botmuxPage, worktreeId)).length).toBe(tabsBefore)
  })
})
