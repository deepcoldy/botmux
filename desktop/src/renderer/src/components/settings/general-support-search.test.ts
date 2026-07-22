import { describe, expect, it } from 'vitest'
import { getGeneralSupportSearchEntries } from './general-support-search'
import { getGeneralPaneSearchEntries } from './general-search'

describe('general support search (promo governance)', () => {
  it('does not expose Star on GitHub or open-stargazers settings entries', () => {
    expect(getGeneralSupportSearchEntries()).toEqual([])

    const general = getGeneralPaneSearchEntries()
    const blob = JSON.stringify(general).toLowerCase()
    expect(blob).not.toMatch(/star (botmux) on github/)
    expect(blob).not.toMatch(/github star/)
    expect(blob).not.toMatch(/stargazers/)
  })
})
