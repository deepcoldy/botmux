import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../config.js';
import { localeForBot, t } from '../../i18n/index.js';
import { isHostCapabilityLink, type HostLinkScope } from '../../core/host-capability-link.js';
import {
  LocalAddressOutboundError, localJumpTargets, sanitizeLocalAddressNode, type LocalAddressContext,
} from './local-address-policy.js';

const vettedReplay = new AsyncLocalStorage<ReadonlySet<string>>();

function read(path: string): string {
  try { return existsSync(path) ? readFileSync(path, 'utf8').trim() : ''; } catch { return ''; }
}

/** A missing config section allows nothing; it must not fail the card render. */
function hostLinkScope(): HostLinkScope {
  const { web, dashboard } = config as Partial<typeof config>;
  return {
    hosts: [web?.externalHost ?? '', dashboard?.externalHost ?? ''],
    dashboardPorts: [read(join(homedir(), '.botmux', '.dashboard-port')), String(dashboard?.port ?? '')].filter(Boolean),
  };
}

function hostIssuedLink(): (url: string) => boolean {
  let scope: HostLinkScope | undefined;
  return url => isHostCapabilityLink(url, scope ??= hostLinkScope()) || !!vettedReplay.getStore()?.has(url);
}

/** Where model output enters. Host-selected labels; never take policy
 * exemptions from the agent payload. */
export function localAddressContextForBot(appId: string, workingDir?: string): LocalAddressContext {
  const locale = localeForBot(appId);
  return {
    ...(workingDir ? { workspaceRoots: [workingDir] } : {}),
    internalFileLabel: t('card.local_address.internal_file', undefined, locale),
    unavailableLinkLabel: t('card.local_address.unavailable_link', undefined, locale),
    hostIssuedLink: hostIssuedLink(),
  };
}

/** Every outbound body, whoever wrote it: a card link field must be one of the
 * host's own link shapes. Host-written prose such as a resume command, a cwd
 * or a Dashboard link sent to an admin is not rewritten. */
export function linkFieldContext(): LocalAddressContext {
  return { linkFieldsOnly: true, hostIssuedLink: hostIssuedLink() };
}

/** Whether a card link field holding `url` would be sent, for builders that
 * would rather leave a button out than have the whole card rejected. */
export function sendableCardLink(url: string): boolean {
  try {
    sanitizeLocalAddressNode({ url }, linkFieldContext());
    return true;
  } catch (error) {
    if (error instanceof LocalAddressOutboundError) return false;
    throw error;
  }
}

/** Sends again a body that passed the policy before it was persisted for
 * replay. Its own local link fields stay trusted for this send, so a frozen
 * body is not re-judged against a Dashboard port or host that changed since. */
export function replayVettedBody<T>(content: string, msgType: string, send: () => T): T {
  return vettedReplay.run(new Set(localJumpTargets(content, msgType)), send);
}
