/**
 * Lightweight zh/en copy for the mobile Botmux screen.
 * Mobile does not yet have a full i18n framework; keep this surface bilingual
 * via the device locale until a shared mobile catalog exists.
 */
import { NativeModules, Platform } from 'react-native'
import type { MobileLocale } from '../i18n/mobile-i18n'

function deviceLanguageTag(): string {
  try {
    if (Platform.OS === 'ios') {
      const settings = NativeModules.SettingsManager?.settings
      const raw =
        settings?.AppleLocale ??
        (Array.isArray(settings?.AppleLanguages) ? settings.AppleLanguages[0] : null)
      if (typeof raw === 'string' && raw.trim()) return raw
    }
    const locale =
      NativeModules.I18nManager?.localeIdentifier ??
      NativeModules.I18nManager?.locale ??
      // Intl is available on modern Hermes.
      (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().locale : 'en')
    return String(locale || 'en')
  } catch {
    return 'en'
  }
}

export function isChineseLocale(tag = deviceLanguageTag()): boolean {
  return /^zh\b/i.test(tag)
}

/** Strip HTML dashboard error pages into short plain text. */
export function formatBotmuxOpenError(
  message: string | null | undefined,
  locale?: MobileLocale
): string {
  const raw = (message ?? '').trim()
  if (!raw) return ''
  const plain = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const zh = locale ? locale === 'zh-CN' : isChineseLocale()
  if (
    /token expired/i.test(plain) ||
    /write-link HTTP 401/i.test(plain) ||
    /unauthorized/i.test(plain)
  ) {
    return zh
      ? 'Dashboard token 无效或已过期。请在 d2 上执行 `botmux dashboard` 刷新，然后在 Desktop 里重新连接 Botmux 主机。'
      : 'Dashboard token expired or missing. On the Botmux host run `botmux dashboard`, then reconnect the bridge endpoint in Desktop.'
  }
  return plain.slice(0, 240)
}

const EN = {
  title: 'Botmux sessions',
  subtitlePaired: 'Paired desktop bridge',
  subtitleAllHosts: 'All connected hosts',
  subtitleWorktree: (name: string) => `This worktree · ${name}`,
  filterPlaceholder: 'Filter sessions…',
  showAll: 'Show all sessions',
  thisWorktreeOnly: 'This worktree only',
  openFailedTitle: 'Open failed',
  openFailedFallback: 'Could not open the session on this device',
  openedOnDesktop: (label: string) => `Opened · ${label}`,
  openedOnMobile: (label: string) => `Opening · ${label}`,
  emptyQuery: (q: string) => `No sessions match "${q}"`,
  emptyWorktree: 'No Botmux sessions under this worktree. Connect the host on desktop if needed.',
  emptyAll: 'No Botmux sessions. Connect a host in Desktop → Botmux connection.',
  back: 'Back',
  showClosed: 'Show closed sessions',
  hideClosed: 'Hide closed sessions',
  clearFilter: 'Clear filter',
  workingCount: (n: number) => `${n} working · `,
  groupByHosts: 'Hosts',
  groupByAgents: 'Agents',
  filterTitle: 'Filter sessions',
  resetFilters: 'Reset filters',
  filterShowClosed: 'Show closed'
} as const

const ZH = {
  title: 'Botmux 会话',
  subtitlePaired: '已配对的桌面桥接',
  subtitleAllHosts: '全部已连接主机',
  subtitleWorktree: (name: string) => `当前 worktree · ${name}`,
  filterPlaceholder: '筛选会话…',
  showAll: '显示全部会话',
  thisWorktreeOnly: '仅当前 worktree',
  openFailedTitle: '打开失败',
  openFailedFallback: '无法在本机打开该会话',
  openedOnDesktop: (label: string) => `已打开 · ${label}`,
  openedOnMobile: (label: string) => `正在打开 · ${label}`,
  emptyQuery: (q: string) => `没有匹配 “${q}” 的会话`,
  emptyWorktree: '该 worktree 下没有 Botmux 会话。请确认 Desktop 已连接 Botmux 主机。',
  emptyAll: '没有 Botmux 会话。请在 Desktop → Botmux connection 连接主机。',
  back: '返回',
  showClosed: '显示已关闭会话',
  hideClosed: '隐藏已关闭会话',
  clearFilter: '清除筛选',
  workingCount: (n: number) => `${n} 工作中 · `,
  groupByHosts: '主机',
  groupByAgents: '智能体',
  filterTitle: '筛选会话',
  resetFilters: '重置筛选',
  filterShowClosed: '显示已关闭'
} as const

export type BotmuxMobileCopy = {
  readonly title: string
  readonly subtitlePaired: string
  readonly subtitleAllHosts: string
  readonly subtitleWorktree: (name: string) => string
  readonly filterPlaceholder: string
  readonly showAll: string
  readonly thisWorktreeOnly: string
  readonly openFailedTitle: string
  readonly openFailedFallback: string
  readonly openedOnDesktop: (label: string) => string
  readonly openedOnMobile: (label: string) => string
  readonly emptyQuery: (q: string) => string
  readonly emptyWorktree: string
  readonly emptyAll: string
  readonly back: string
  readonly showClosed: string
  readonly hideClosed: string
  readonly clearFilter: string
  readonly groupByHosts: string
  readonly groupByAgents: string
  readonly filterTitle: string
  readonly resetFilters: string
  readonly filterShowClosed: string
  readonly workingCount: (n: number) => string
}

export function getBotmuxMobileCopy(locale?: MobileLocale): BotmuxMobileCopy {
  return locale ? (locale === 'zh-CN' ? ZH : EN) : isChineseLocale() ? ZH : EN
}
