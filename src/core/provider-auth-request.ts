/**
 * `botmux auth request --provider meego|bytedcli`: the bytedcli wrapper asks
 * here when a command needs the person's own login, instead of printing a
 * link (or a how-to) for the agent to relay.
 *
 * botmux delivers the link itself through {@link deliverAuthLink} — inline in
 * the person's DM with the bot, else a DM plus one line in the conversation,
 * else a card only they can see, else only a pointer to where they can get it.
 * The agent is told what happened and never sees the link, so nothing it says
 * can carry one into a group.
 */
import { t, type Locale } from '../i18n/index.js';
import type { AuthLinkDelivery } from './auth-link-delivery.js';
import type { MeegoTenant } from '../services/bytedcli-home.js';
import type { MeegoLoginRequest } from '../services/meego-auth.js';

export type AuthProvider = 'meego' | 'bytedcli';

export const AUTH_PROVIDERS: readonly AuthProvider[] = ['meego', 'bytedcli'];

/** A refused command is often retried in a burst; the same link (or the same
 *  "could not reach you") goes out once per this interval and conversation,
 *  not per command. Another conversation still gets its own line. */
export const LINK_RESEND_MS = 3 * 60_000;

export type ProviderAuthStatus = 'ready' | 'delivered' | 'pending' | 'undeliverable' | 'unavailable';

export interface ProviderAuthResult {
  status: ProviderAuthStatus;
  delivery?: AuthLinkDelivery;
  /** For the agent. Never carries the link. */
  message: string;
}

export interface ProviderAuthDeps {
  requestMeegoLogin: (openId: string, tenant?: MeegoTenant) => Promise<MeegoLoginRequest>;
  /** True once the person's ByteCloud login works (finishing one they approved
   *  meanwhile); 'unknown' when the provider cannot be asked. */
  bytedcliAuthorized: (openId: string) => Promise<boolean | 'unknown'>;
  beginBytedcliLogin: (openId: string) => Promise<{ authUrl: string } | null>;
  /** {@link deliverAuthLink} bound to this conversation and person. */
  deliver: (text: string, privateCommand: string) => Promise<AuthLinkDelivery>;
  now?: () => number;
}

const PROVIDER_LABEL: Record<AuthProvider, string> = { meego: 'Meego', bytedcli: 'ByteCloud' };

/** What the person sends elsewhere when the link cannot reach them privately.
 *  meegle keeps one login per tenant, so the tenant is part of the command. */
export function meegoLoginCommand(tenant?: MeegoTenant): string {
  return tenant ? `/login meego ${tenant}` : '/login meego';
}

const recent = new Map<string, { authUrl: string; at: number; reached: boolean }>();

export async function requestProviderAuth(
  input: { provider: AuthProvider; openId: string; locale?: Locale; chatId?: string; tenant?: MeegoTenant },
  deps: ProviderAuthDeps,
): Promise<ProviderAuthResult> {
  const { provider, openId, locale, chatId, tenant } = input;
  const vars = { provider: PROVIDER_LABEL[provider] };
  const now = deps.now ?? Date.now;
  let link: { authUrl: string; text: string; command: string };
  if (provider === 'meego') {
    const login = await deps.requestMeegoLogin(openId, tenant);
    if (login.state === 'ready') return { status: 'ready', message: t('provider_auth.ready_meego', undefined, locale) };
    if (login.state === 'unavailable') {
      return { status: 'unavailable', message: t('provider_auth.unavailable', { ...vars, detail: login.detail }, locale) };
    }
    link = {
      authUrl: login.authUrl,
      text: [t('auth_link.meego_title', undefined, locale), login.authUrl, '', t('auth_link.meego_footer', undefined, locale)].join('\n'),
      command: meegoLoginCommand(tenant),
    };
  } else {
    if (await deps.bytedcliAuthorized(openId) === true) {
      return { status: 'ready', message: t('provider_auth.ready_bytedcli', undefined, locale) };
    }
    const started = await deps.beginBytedcliLogin(openId);
    if (!started) {
      return { status: 'unavailable', message: t('provider_auth.unavailable', { ...vars, detail: 'bytedcli auth login --begin' }, locale) };
    }
    link = {
      authUrl: started.authUrl,
      text: [
        t('cmd.login.bytedcli_title', undefined, locale), '',
        t('cmd.login.bytedcli_step1', undefined, locale), started.authUrl, '',
        t('auth_link.bytedcli_step2', undefined, locale), '',
        t('cmd.login.bytedcli_note', undefined, locale),
      ].join('\n'),
      command: '/login bytedcli',
    };
  }
  const key = JSON.stringify([provider, tenant ?? '', openId, chatId ?? '']);
  const last = recent.get(key);
  if (last?.authUrl === link.authUrl && now() - last.at < LINK_RESEND_MS) {
    return last.reached
      ? { status: 'pending', message: t('provider_auth.pending', vars, locale) }
      : { status: 'undeliverable', delivery: 'dm_failed', message: t('provider_auth.undeliverable', vars, locale) };
  }
  const delivery = await deps.deliver(link.text, link.command);
  const at = now();
  for (const [k, v] of recent) if (at - v.at >= LINK_RESEND_MS) recent.delete(k);
  recent.set(key, { authUrl: link.authUrl, at, reached: delivery !== 'dm_failed' });
  switch (delivery) {
    case 'inline': return { status: 'delivered', delivery, message: t('provider_auth.delivered_inline', vars, locale) };
    case 'dm': return { status: 'delivered', delivery, message: t('provider_auth.delivered_dm', vars, locale) };
    case 'ephemeral': return { status: 'delivered', delivery, message: t('provider_auth.delivered_ephemeral', vars, locale) };
    case 'dm_failed': return { status: 'undeliverable', delivery, message: t('provider_auth.undeliverable', vars, locale) };
  }
}

/** @internal test-only */
export function __resetProviderAuthForTest(): void {
  recent.clear();
}

/** @internal test-only */
export function __providerAuthTrackedForTest(): number {
  return recent.size;
}
