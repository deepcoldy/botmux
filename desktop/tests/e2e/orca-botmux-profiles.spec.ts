import { test, expect } from './helpers/orca-botmux-app'

// Why: the multi-profile switcher UI is downscoped behind ORCA_MULTI_PROFILE_UI;
// these specs exercise that full UI, so opt the whole file into the flag.
test.use({ launchEnv: { ORCA_MULTI_PROFILE_UI: '1' } })

test('opens the profile switcher and profile dialogs', async ({ orcaBotmuxPage }) => {
  const switcher = orcaBotmuxPage.getByRole('button', { name: /^Switch profile$/ })
  await expect(switcher).toBeVisible()

  await switcher.click()
  await expect(orcaBotmuxPage.getByText('Personal', { exact: true }).first()).toBeVisible()
  const manageProfiles = orcaBotmuxPage.getByRole('menuitem', { name: /Manage profiles/i })
  await expect(manageProfiles).toBeVisible()
  await expect(orcaBotmuxPage.getByRole('menuitem', { name: /New local profile/i })).toBeVisible()

  await manageProfiles.click()
  const managementDialog = orcaBotmuxPage.getByRole('dialog', { name: /Manage profiles/i })
  await expect(managementDialog).toBeVisible()
  await expect(managementDialog.getByText(/projects/i).first()).toBeVisible()

  await orcaBotmuxPage.keyboard.press('Escape')
  await expect(managementDialog).toBeHidden()

  await switcher.click()
  await orcaBotmuxPage.getByRole('menuitem', { name: /New local profile/i }).click()
  const createDialog = orcaBotmuxPage.getByRole('dialog', { name: /New local profile/i })
  await expect(createDialog).toBeVisible()
  await expect(createDialog.getByPlaceholder(/Profile name/i)).toBeVisible()
  await expect(createDialog.getByRole('button', { name: /Create and Switch/i })).toBeVisible()
})

test('places the profile switcher in sidebar footer and full-page titlebar', async ({
  orcaBotmuxPage
}) => {
  const switcher = orcaBotmuxPage.getByRole('button', { name: /^Switch profile$/ })
  const settingsButton = orcaBotmuxPage.getByRole('button', { name: /^Settings$/ })
  await expect(switcher).toBeVisible()
  await expect(settingsButton).toBeVisible()

  const sidebarSwitchBox = await switcher.boundingBox()
  const settingsBox = await settingsButton.boundingBox()
  const viewport = await orcaBotmuxPage.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }))
  expect(sidebarSwitchBox).not.toBeNull()
  expect(settingsBox).not.toBeNull()

  expect(sidebarSwitchBox!.x + sidebarSwitchBox!.width).toBeLessThanOrEqual(settingsBox!.x + 2)
  expect(Math.abs(sidebarSwitchBox!.y - settingsBox!.y)).toBeLessThanOrEqual(2)
  expect(sidebarSwitchBox!.y).toBeGreaterThan(viewport.height - 64)

  await settingsButton.click()
  await expect
    .poll(() => orcaBotmuxPage.evaluate(() => window.__store?.getState().activeView))
    .toBe('settings')

  const titlebarSwitchBox = await switcher.boundingBox()
  expect(titlebarSwitchBox).not.toBeNull()
  expect(titlebarSwitchBox!.x).toBeGreaterThan(viewport.width - 260)
  expect(titlebarSwitchBox!.y).toBeLessThan(48)
})

test.describe('default single-profile mode', () => {
  // Why: no flag — the default build shows no account trigger on a local-only
  // (cloud-unconfigured) install.
  test.use({ launchEnv: {} })

  test('hides the account trigger when cloud is unconfigured', async ({ orcaBotmuxPage }) => {
    await expect(orcaBotmuxPage.getByRole('button', { name: /^Switch profile$/ })).toHaveCount(0)
    await expect(orcaBotmuxPage.getByRole('button', { name: /^Account$/ })).toHaveCount(0)
  })
})
