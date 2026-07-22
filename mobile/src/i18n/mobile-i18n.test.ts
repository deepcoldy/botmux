import { describe, expect, it, vi } from 'vitest'
import { isMobileLanguagePreference, resolveMobileLocale, translateMobile } from './mobile-i18n'

vi.mock('react-native', () => ({
  NativeModules: {},
  Platform: { OS: 'ios' }
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined)
  }
}))

describe('mobile i18n', () => {
  it('resolves supported system locales with an English fallback', () => {
    expect(resolveMobileLocale('system', 'zh-Hans-CN')).toBe('zh-CN')
    expect(resolveMobileLocale('system', 'zh_TW')).toBe('zh-CN')
    expect(resolveMobileLocale('system', 'ja-JP')).toBe('en')
    expect(resolveMobileLocale('en', 'zh-CN')).toBe('en')
  })

  it('falls back to the English source and interpolates values', () => {
    expect(translateMobile('zh-CN', 'Settings')).toBe('设置')
    expect(translateMobile('zh-CN', 'Uncatalogued copy')).toBe('Uncatalogued copy')
    expect(
      translateMobile(
        'zh-CN',
        "Couldn't confirm cleanup for {{count}} credentials on this device.",
        {
          count: 3
        }
      )
    ).toBe('无法确认此设备上的 3 个凭据已清理。')
  })

  it('accepts only persisted language preference values', () => {
    expect(isMobileLanguagePreference('system')).toBe(true)
    expect(isMobileLanguagePreference('zh-CN')).toBe(true)
    expect(isMobileLanguagePreference('fr')).toBe(false)
  })
})
