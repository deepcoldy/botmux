/**
 * Which `--as user` credential a bound lark-cli gets when the bot's own
 * application has none for this person.
 *
 * A bound session pins lark-cli to the bot's application. `--as user` used to
 * mean "this person's OAuth grant to the bot's application" only. That works
 * for the bot owner, but nobody else can grant it: a self-built bot app's
 * availability range normally covers just its owner, so everyone else gets
 * "you have no permission to use <bot>" on the authorization page. For them the
 * only workable source is the central platform, which holds each person's grant
 * to the platform's own Feishu application.
 *
 * Order:
 *   credentialSource = local            → the bot app's grant only (unchanged)
 *   credentialSource = auto (default)   → the bot app's grant when the person has
 *                                         one (keeps the owner's wider scopes);
 *                                         otherwise the platform grant
 *   credentialSource = platform         → the platform grant only
 * `triggerUserAuth` must cover lark-cli for the platform to be consulted at all.
 *
 * Who the credential belongs to is decided by the daemon (the turn's sender or
 * a verified delegation target), never by the CLI.
 */
import type { BotConfig } from '../bot-registry.js';
import { credentialSourceOf, triggerUserAuthApplies } from '../services/trigger-user-auth.js';
import {
  platformAuthorizeUrl,
  resolvePlatformIdentity,
  type PlatformIdentityResolution,
} from './platform-credential-source.js';

export type BoundLarkPlatformPolicy = 'off' | 'prefer-bot-app' | 'platform-only';

/** How the platform participates in a bound session's `--as user` for this bot. */
export function boundLarkPlatformPolicy(bot: Pick<BotConfig, 'triggerUserAuth'>): BoundLarkPlatformPolicy {
  if (!triggerUserAuthApplies(bot.triggerUserAuth, 'lark-cli')) return 'off';
  const source = credentialSourceOf(bot.triggerUserAuth);
  if (source === 'local') return 'off';
  return source === 'platform' ? 'platform-only' : 'prefer-bot-app';
}

export type BoundLarkUserCredential =
  /** Use this token with this application id. `issuer` marks a platform grant,
   *  whose application differs from the bound one by design. */
  | { ok: true; appId: string; credential: string; issuer?: 'platform' }
  /** Nothing from the platform side: the caller keeps its bot-app guidance. */
  | { ok: false; reason: 'bot_app_missing' }
  /** The platform decided; `error` tells the agent what the human must do. */
  | { ok: false; reason: 'platform'; error: string; authorizeUrl?: string };

export interface ResolveBoundLarkUserCredentialInput {
  bot: BotConfig;
  /** App-scoped open_id of the person whose credential is wanted. */
  openId: string;
  sessionId: string;
  turnId?: string;
  /** Delegated (cross-bot dispatch) target rather than the turn's own sender. */
  delegated: boolean;
  /** The grant to the bot's own application for the given person, if any.
   *  Called with {@link openId} so the check and the credential cannot drift
   *  to different people. */
  botAppToken: (openId: string) => Promise<string | null>;
}

export async function resolveBoundLarkUserCredential(
  input: ResolveBoundLarkUserCredentialInput,
): Promise<BoundLarkUserCredential> {
  const policy = boundLarkPlatformPolicy(input.bot);
  if (policy !== 'platform-only') {
    const token = await input.botAppToken(input.openId);
    if (token) return { ok: true, appId: input.bot.larkAppId, credential: token };
    if (policy === 'off') return { ok: false, reason: 'bot_app_missing' };
  }
  const platform = await resolvePlatformIdentity({
    botConfig: input.bot,
    tool: 'lark-cli',
    openId: input.openId,
    sessionId: input.sessionId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
  });
  if (platform.state === 'granted') {
    if (platform.identity.tool === 'lark-cli' && 'userAccessToken' in platform.identity && platform.identity.userAccessToken) {
      return { ok: true, appId: platform.identity.appId, credential: platform.identity.userAccessToken, issuer: 'platform' };
    }
    // Not transient: retrying returns the same unusable shape.
    return { ok: false, reason: 'platform', error: 'The botmux platform returned a lark-cli credential this machine cannot use. Do not retry; report it to the operator.' };
  }
  // Auto mode on a machine that is not bound to a platform: nothing changes.
  if (platform.state === 'unbound' && policy === 'prefer-bot-app') return { ok: false, reason: 'bot_app_missing' };
  return platformRefusal(platform, input.delegated);
}

function platformRefusal(resolution: PlatformIdentityResolution, delegated: boolean): BoundLarkUserCredential {
  const who = delegated ? 'The original user' : 'This user';
  const url = (resolution.state === 'not_authorized' ? resolution.authorizeUrl : undefined) ?? platformAuthorizeUrl() ?? undefined;
  const link = url ? ` at ${url}` : '';
  const withUrl = (error: string) => ({ ok: false as const, reason: 'platform' as const, error, ...(url ? { authorizeUrl: url } : {}) });
  const noBotApp = 'Do not ask them to authorize the bot application or run botmux auth request for it.';
  switch (resolution.state) {
    case 'not_authorized':
      return withUrl(resolution.consent
        ? `${who} authorized lark-cli on the botmux platform but has not allowed this machine's team to use it. Send them the platform page${link} to allow it, then retry with --as user. ${noBotApp}`
        : `${who} has not authorized lark-cli on the botmux platform. Send them the platform page${link}; one authorization works on every bound machine and renews itself. Retry with --as user after they confirm. ${noBotApp}`);
    case 'denied':
      return withUrl(resolution.reason === 'not_teammate'
        ? `${who} is not in a botmux platform team with this machine's owner, so the platform will not issue their credentials here. The machine owner must invite them into a team on the platform first; then they authorize on the platform page${link}. ${noBotApp}`
        : `The botmux platform refused ${delegated ? "the original user's" : "this user's"} lark-cli credentials (${resolution.detail}). Do not retry automatically.`);
    case 'unbound':
      return withUrl('This bot takes lark-cli user credentials only from the botmux platform, but this machine is not bound to it. Ask the operator to run botmux bind on the host. Do not ask the user to log in.');
    case 'unavailable':
    default:
      return withUrl('The botmux platform is temporarily unavailable, so the user\'s lark-cli credentials cannot be fetched. Stop automatic retries and do not ask the user to log in again; retry later.');
  }
}

/**
 * `botmux auth request` for a person who has no grant to the bot's application:
 * a device-code link for the bot app would only show them "no permission to use
 * <bot>". Point at the platform instead. Returns null when the bot-app flow
 * should proceed as before.
 */
export async function platformAuthRequestRedirect(input: {
  bot: BotConfig;
  /** The person the authorization is for (the sender, or a verified delegation target). */
  openId: string;
  delegated: boolean;
  botAppToken: (openId: string) => Promise<string | null>;
}): Promise<{ error: string; authorizeUrl?: string } | null> {
  const policy = boundLarkPlatformPolicy(input.bot);
  if (policy === 'off') return null;
  const url = platformAuthorizeUrl();
  if (!url) {
    if (policy === 'prefer-bot-app') return null;
    return { error: 'This bot takes lark-cli user credentials only from the botmux platform, but this machine is not bound to it. Ask the operator to run botmux bind on the host.' };
  }
  if (policy === 'prefer-bot-app' && await input.botAppToken(input.openId)) return null;
  const who = input.delegated ? 'The original user' : 'This user';
  return {
    error: `${who}'s lark-cli authorization comes from the botmux platform, not from application ${input.bot.larkAppId}. `
      // The platform application cannot hold every scope (some need tenant-wide
      // approval), but the bot's own identity often covers the same data.
      + 'For a READ of data in a chat or document this bot can access (for example messages of a group the bot is in), '
      + 'retry that read with --as bot first; it needs no user authorization. Never switch a write to --as bot. '
      + `If the read also fails as bot, or the action must be done as this user, send them the platform page at ${url} `
      + 'to authorize (or re-authorize). If a scope is still missing afterwards, '
      + 'the platform application itself must enable it first; tell the user which scope is needed instead of retrying.',
    authorizeUrl: url,
  };
}
