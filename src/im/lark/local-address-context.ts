import { localeForBot, t } from '../../i18n/index.js';
import type { LocalAddressContext } from './local-address-policy.js';

/** Host-selected labels; never take policy exemptions from the agent payload. */
export function localAddressContextForBot(appId: string, workingDir?: string): LocalAddressContext {
  const locale = localeForBot(appId);
  return {
    ...(workingDir ? { workspaceRoots: [workingDir] } : {}),
    internalFileLabel: t('card.local_address.internal_file', undefined, locale),
    unavailableLinkLabel: t('card.local_address.unavailable_link', undefined, locale),
  };
}
