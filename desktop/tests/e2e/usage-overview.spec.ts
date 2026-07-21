import { test, expect } from './helpers/orca-botmux-app'
import { getStoreState, waitForSessionReady } from './helpers/store'

test.describe('usage overview', () => {
  test.beforeEach(async ({ orcaBotmuxPage }) => {
    await waitForSessionReady(orcaBotmuxPage)
  })

  test('Stats & Usage opens on the combined overview with provider controls', async ({
    orcaBotmuxPage
  }) => {
    await orcaBotmuxPage.evaluate(() => {
      const state = window.__store!.getState()
      state.openSettingsPage()
    })

    await expect
      .poll(async () => getStoreState<string>(orcaBotmuxPage, 'activeView'), { timeout: 5_000 })
      .toBe('settings')
    await orcaBotmuxPage.getByRole('button', { name: 'Stats & Usage' }).click()
    await expect(orcaBotmuxPage.getByRole('heading', { name: 'Usage Analytics' })).toBeVisible()
    const providerDropdown = orcaBotmuxPage.getByTestId('usage-provider-select')
    await expect(providerDropdown).toHaveAttribute(
      'aria-label',
      'Usage analytics provider: Overview'
    )
    await expect(orcaBotmuxPage.getByTestId('usage-overview-pane')).toBeVisible()
    await expect(orcaBotmuxPage.getByRole('heading', { name: 'Usage Overview' })).toBeVisible()
    await expect(orcaBotmuxPage.getByRole('heading', { name: 'Providers' })).toBeVisible()
    await expect(orcaBotmuxPage.getByRole('button', { name: 'Enable Claude' })).toBeVisible()
    await expect(orcaBotmuxPage.getByRole('button', { name: 'Enable Codex' })).toBeVisible()
    await expect(orcaBotmuxPage.getByRole('button', { name: 'Enable OpenCode' })).toBeVisible()

    await providerDropdown.click()
    await orcaBotmuxPage.getByRole('menuitem', { name: 'Codex', exact: true }).click()
    await expect(orcaBotmuxPage.getByRole('heading', { name: 'Codex Usage Tracking' })).toBeVisible()
    await expect(providerDropdown).toHaveAttribute('aria-label', 'Usage analytics provider: Codex')

    await providerDropdown.click()
    await orcaBotmuxPage.getByRole('menuitem', { name: 'OpenCode', exact: true }).click()
    await expect(orcaBotmuxPage.getByRole('heading', { name: 'OpenCode Usage Tracking' })).toBeVisible()
    await expect(providerDropdown).toHaveAttribute(
      'aria-label',
      'Usage analytics provider: OpenCode'
    )
  })
})
