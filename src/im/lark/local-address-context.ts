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

function hostLinkScope(): HostLinkScope {
  return {
    hosts: [config.web.externalHost, config.dashboard.externalHost],
    dashboardPorts: [read(join(homedir(), '.botmux', '.dashboard-port')), String(config.dashboard.port)].filter(Boolean),
  };
}

function hostIssuedLink(): (url: string) => boolean {
  let scope: HostLinkScope | undefined;
  return url => isHostCapabilityLink(url, scope ??= hostLinkScope()) || !!vettedReplay.getStore()?.has(url);
}

/** Host-selected labels; never take policy exemptions from the agent payload. */
export function localAddressContextForBot(appId: string, workingDir?: string): LocalAddressContext {
  const locale = localeForBot(appId);
  return {
    ...(workingDir ? { workspaceRoots: [workingDir] } : {}),
    internalFileLabel: t('card.local_address.internal_file', undefined, locale),
    unavailableLinkLabel: t('card.local_address.unavailable_link', undefined, locale),
    hostIssuedLink: hostIssuedLink(),
  };
}

/** Whether a card link field holding `url` would be sent, for builders that
 * would rather leave a button out than have the whole card rejected. */
export function sendableCardLink(url: string): boolean {
  try {
    sanitizeLocalAddressNode({ url }, { hostIssuedLink: hostIssuedLink() });
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
