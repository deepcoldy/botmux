import { translate } from '@/i18n/i18n'
import type { BotmuxProfileAuthStatus, BotmuxProfileSummary } from '../../../../shared/botmux-profiles'

export function getBotmuxAccountIdentity(
  profile: BotmuxProfileSummary,
  authStatus: BotmuxProfileAuthStatus | null
): { title: string; subtitle: string } {
  // Why: the account-only menu must not present a local execution profile as
  // an authenticated Botmux identity.
  const cloud = authStatus?.cloud ?? profile.cloud
  if (authStatus?.state === 'connected') {
    return {
      title:
        cloud?.displayName?.trim() ||
        cloud?.email ||
        translate('auto.components.botmux.profiles.switcher.accountTitle', 'Botmux account'),
      subtitle:
        cloud?.activeOrgName ||
        (cloud?.displayName && cloud.email
          ? cloud.email
          : translate('auto.components.botmux.profiles.switcher.accountSignedIn', 'Signed in'))
    }
  }
  if (authStatus?.state === 'reconnect-required') {
    return {
      title:
        cloud?.displayName?.trim() ||
        cloud?.email ||
        translate('auto.components.botmux.profiles.switcher.accountTitle', 'Botmux account'),
      subtitle: translate(
        'auto.components.botmux.profiles.switcher.accountSignInRequired',
        'Sign-in required'
      )
    }
  }
  return {
    title: translate('auto.components.botmux.profiles.switcher.accountTitle', 'Botmux account'),
    subtitle: translate('auto.components.botmux.profiles.switcher.accountSignedOut', 'Signed out')
  }
}
