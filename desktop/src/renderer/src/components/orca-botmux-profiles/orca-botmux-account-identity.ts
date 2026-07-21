import { translate } from '@/i18n/i18n'
import type { OrcaProfileAuthStatus, OrcaProfileSummary } from '../../../../shared/orca-botmux-profiles'

export function getOrcaAccountIdentity(
  profile: OrcaProfileSummary,
  authStatus: OrcaProfileAuthStatus | null
): { title: string; subtitle: string } {
  // Why: the account-only menu must not present a local execution profile as
  // an authenticated OrcaBotmux identity.
  const cloud = authStatus?.cloud ?? profile.cloud
  if (authStatus?.state === 'connected') {
    return {
      title:
        cloud?.displayName?.trim() ||
        cloud?.email ||
        translate('auto.components.orca_botmux.profiles.switcher.accountTitle', 'OrcaBotmux account'),
      subtitle:
        cloud?.activeOrgName ||
        (cloud?.displayName && cloud.email
          ? cloud.email
          : translate('auto.components.orca_botmux.profiles.switcher.accountSignedIn', 'Signed in'))
    }
  }
  if (authStatus?.state === 'reconnect-required') {
    return {
      title:
        cloud?.displayName?.trim() ||
        cloud?.email ||
        translate('auto.components.orca_botmux.profiles.switcher.accountTitle', 'OrcaBotmux account'),
      subtitle: translate(
        'auto.components.orca_botmux.profiles.switcher.accountSignInRequired',
        'Sign-in required'
      )
    }
  }
  return {
    title: translate('auto.components.orca_botmux.profiles.switcher.accountTitle', 'OrcaBotmux account'),
    subtitle: translate('auto.components.orca_botmux.profiles.switcher.accountSignedOut', 'Signed out')
  }
}
