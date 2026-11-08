import { localeForBot, t } from '../../i18n/index.js';
import { isHostIssuedLink, issueHostLink } from '../../core/host-issued-links.js';
import { localJumpTargets, type LocalAddressContext } from './local-address-policy.js';

/** Host-selected labels; never take policy exemptions from the agent payload. */
export function localAddressContextForBot(appId: string, workingDir?: string): LocalAddressContext {
  const locale = localeForBot(appId);
  return {
    ...(workingDir ? { workspaceRoots: [workingDir] } : {}),
    internalFileLabel: t('card.local_address.internal_file', undefined, locale),
    unavailableLinkLabel: t('card.local_address.unavailable_link', undefined, locale),
    hostIssuedLink: isHostIssuedLink,
  };
}

/** Only for a body that passed the policy before it was persisted for replay:
 * the registry is per process, so after a restart the frozen body's own host
 * links would otherwise be judged against an empty registry. */
export function admitVettedHostLinks(content: string, msgType: string): void {
  for (const url of localJumpTargets(content, msgType)) issueHostLink(url);
}
