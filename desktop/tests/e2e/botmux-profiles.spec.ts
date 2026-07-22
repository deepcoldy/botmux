import { test, expect } from './helpers/botmux-app'

// Why: the multi-profile switcher UI is downscoped behind BOTMUX_MULTI_PROFILE_UI;
// these specs exercise that full UI, so opt the whole file into the flag.
test.use({ launchEnv: { BOTMUX_MULTI_PROFILE_UI: '1' } })

test('opens the profile switcher and profile dialogs', async ({ botmuxPage }) => {
  const switcher = botmuxPage.getByRole('button', { name: /^Switch profile$/ })
  await expect(switcher).toBeVisible()

  await switcher.click()
  await expect(botmuxPage.getByText('Personal', { exact: true }).first()).toBeVisible()
  const manageProfiles = botmuxPage.getByRole('menuitem', { name: /Manage profiles/i })
  await expect(manageProfiles).toBeVisible()
  await expect(botmuxPage.getByRole('menuitem', { name: /New local profile/i })).toBeVisible()

  await manageProfiles.click()
  const managementDialog = botmuxPage.getByRole('dialog', { name: /Manage profiles/i })
  await expect(managementDialog).toBeVisible()
  await expect(managementDialog.getByText(/projects/i).first()).toBeVisible()

  await botmuxPage.keyboard.press('Escape')
  await expect(managementDialog).toBeHidden()

  await switcher.click()
  await botmuxPage.getByRole('menuitem', { name: /New local profile/i }).click()
  const createDialog = botmuxPage.getByRole('dialog', { name: /New local profile/i })
  await expect(createDialog).toBeVisible()
  await expect(createDialog.getByPlaceholder(/Profile name/i)).toBeVisible()
  await expect(createDialog.getByRole('button', { name: /Create and Switch/i })).toBeVisible()
})

test('places the profile switcher in sidebar footer and full-page titlebar', async ({
  botmuxPage
}) => {
  const switcher = botmuxPage.getByRole('button', { name: /^Switch profile$/ })
  const settingsButton = botmuxPage.getByRole('button', { name: /^Settings$/ })
  await expect(switcher).toBeVisible()
  await expect(settingsButton).toBeVisible()

  const sidebarSwitchBox = await switcher.boundingBox()
  const settingsBox = await settingsButton.boundingBox()
  const viewport = await botmuxPage.evaluate(() => ({
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
    .poll(() => botmuxPage.evaluate(() => window.__store?.getState().activeView))
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

  test('hides the account trigger when cloud is unconfigured', async ({ botmuxPage }) => {
    await expect(botmuxPage.getByRole('button', { name: /^Switch profile$/ })).toHaveCount(0)
    await expect(botmuxPage.getByRole('button', { name: /^Account$/ })).toHaveCount(0)
  })
})
