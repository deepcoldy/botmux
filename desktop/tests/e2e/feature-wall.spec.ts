import { test, expect } from './helpers/orca-botmux-app'
import { waitForSessionReady } from './helpers/store'

test.describe('Feature tour modal (disabled for orca_botmux)', () => {
  test.beforeEach(async ({ orcaBotmuxPage }) => {
    await waitForSessionReady(orcaBotmuxPage)
  })

  test('Help menu does not register Explore product UG entry', async ({ electronApp }) => {
    const helpLabels = await electronApp.evaluate(({ Menu }) => {
      const help = Menu.getApplicationMenu()?.items.find((item) => item.label === 'Help')
      return (help?.submenu?.items ?? []).map((item) => item.label ?? null)
    })
    expect(helpLabels).not.toContain('Explore OrcaBotmux')
    expect(helpLabels).not.toContain('Explore orca_botmux')
    expect(helpLabels.some((l) => l?.includes('Getting Started'))).toBe(true)
  })
})
