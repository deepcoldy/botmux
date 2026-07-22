import { test, expect } from './helpers/botmux-app'
import { getStoreState, waitForSessionReady } from './helpers/store'

test.describe('usage overview', () => {
  test.beforeEach(async ({ botmuxPage }) => {
    await waitForSessionReady(botmuxPage)
  })

  test('Stats & Usage opens on the combined overview with provider controls', async ({
    botmuxPage
  }) => {
    await botmuxPage.evaluate(() => {
      const state = window.__store!.getState()
      state.openSettingsPage()
    })

    await expect
      .poll(async () => getStoreState<string>(botmuxPage, 'activeView'), { timeout: 5_000 })
      .toBe('settings')
    await botmuxPage.getByRole('button', { name: 'Stats & Usage' }).click()
    await expect(botmuxPage.getByRole('heading', { name: 'Usage Analytics' })).toBeVisible()
    const providerDropdown = botmuxPage.getByTestId('usage-provider-select')
    await expect(providerDropdown).toHaveAttribute(
      'aria-label',
      'Usage analytics provider: Overview'
    )
    await expect(botmuxPage.getByTestId('usage-overview-pane')).toBeVisible()
    await expect(botmuxPage.getByRole('heading', { name: 'Usage Overview' })).toBeVisible()
    await expect(botmuxPage.getByRole('heading', { name: 'Providers' })).toBeVisible()
    await expect(botmuxPage.getByRole('button', { name: 'Enable Claude' })).toBeVisible()
    await expect(botmuxPage.getByRole('button', { name: 'Enable Codex' })).toBeVisible()
    await expect(botmuxPage.getByRole('button', { name: 'Enable OpenCode' })).toBeVisible()

    await providerDropdown.click()
    await botmuxPage.getByRole('menuitem', { name: 'Codex', exact: true }).click()
    await expect(botmuxPage.getByRole('heading', { name: 'Codex Usage Tracking' })).toBeVisible()
    await expect(providerDropdown).toHaveAttribute('aria-label', 'Usage analytics provider: Codex')

    await providerDropdown.click()
    await botmuxPage.getByRole('menuitem', { name: 'OpenCode', exact: true }).click()
    await expect(botmuxPage.getByRole('heading', { name: 'OpenCode Usage Tracking' })).toBeVisible()
    await expect(providerDropdown).toHaveAttribute(
      'aria-label',
      'Usage analytics provider: OpenCode'
    )
  })
})
