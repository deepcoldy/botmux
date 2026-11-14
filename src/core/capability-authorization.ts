/**
 * Authorization for runs nobody attends (scheduled turns, background jobs).
 *
 * A person who creates a schedule is offered an authorization entry for what
 * the bot will run as them ({@link offerAuthorizationAtCreation}). At fire time
 * nothing interactive happens: a governed command that finds no credentials is
 * refused, and the wrapper asks the daemon for the one private notice
 * ({@link requestUnattendedAuthorization}).
 */
import { logger } from '../utils/logger.js';
import { t, type Locale } from '../i18n/index.js';
import type { BotConfig } from '../bot-registry.js';
import { beginBytedcliLogin, describeBytedcliAuth } from '../services/bytedcli-auth.js';
import { beginLarkCliLogin, describeLarkCliAuth } from '../services/lark-cli-auth.js';
import { requestMeegoLogin } from '../services/meego-auth.js';
import type { MeegoTenant } from '../services/bytedcli-home.js';
import { capabilityOn, TRIGGER_USER_AUTH_TOOLS, type TriggerUserAuthTool } from '../services/trigger-user-auth.js';
import type { ToolIdentityOutcome } from './turn-cli-identity.js';
import { capabilityOfTool, policyFromConfig } from './identity-policy.js';
import { platformAuthorizeUrl } from './platform-credential-source.js';
import { askPlatformToAuthorize } from './platform-authorization-request.js';
import { userTokenAuthState } from '../utils/user-token.js';
import * as scheduler from './scheduler.js';
import { parseScheduledTurnId } from './scheduled-turn-provenance.js';
import { normalizeBrand } from '../im/lark/lark-hosts.js';
import { sendEphemeralCard, sendUserMessage } from '../im/lark/client.js';
import { directOrEphemeral } from './auth-link-delivery.js';
import { hasReason, NOT_AUTHORIZED_REASONS } from './refusal-reasons.js';

type SendDirect = (openId: string, text: string) => Promise<unknown>;

/** The sender of a task's authorization notices: a direct message, else a card only that person sees in the task's chat (none in a one-to-one chat). */
export function privateNoticeSender(appId: string, chat: { chatId?: string; chatType?: string }): SendDirect {
  const { chatId } = chat;
  return directOrEphemeral(
    (to, text) => sendUserMessage(appId, to, text),
    chatId && chat.chatType !== 'p2p' ? (to, card) => sendEphemeralCard(appId, chatId, to, card) : undefined,
  );
}

/** What an unattended refusal can ask botmux to notify about. */
export type UnattendedProvider = TriggerUserAuthTool | 'meego';

/** Whether the platform issues this provider's credentials on this host: the host is bound and the bot's source is not local. */
function platformBacked(botConfig: BotConfig, provider: UnattendedProvider): boolean {
  return provider !== 'meego' && policyFromConfig(botConfig.triggerUserAuth).credentialSource !== 'local' && !!platformAuthorizeUrl();
}

/**
 * Where a person who has no credentials gets them when the platform does not
 * issue them: a device login link (the same one until its challenge expires,
 * then a fresh one). Undefined when the credentials can only come from a
 * platform this host is not bound to.
 */
async function authorizationLink(tool: TriggerUserAuthTool, botConfig: BotConfig, openId: string): Promise<string | undefined> {
  if (botConfig.triggerUserAuth?.credentialSource === 'platform') return undefined;
  return (tool === 'bytedcli' ? await beginBytedcliLogin(openId) : await beginLarkCliLogin(openId))?.authUrl;
}

/** Whether the person holds credentials here, read-only: a ByteCloud login, or for lark-cli a device login HOME or a stored bot-app user token. An outage or unreadable state is `unknown`, never a lapse. */
async function localLoginState(tool: TriggerUserAuthTool, botConfig: BotConfig, openId: string): Promise<'authorized' | 'needs-login' | 'unknown'> {
  if (tool === 'bytedcli') return (await describeBytedcliAuth(openId)).state;
  const home = describeLarkCliAuth(openId).state;
  if (home === 'authorized' || !botConfig.larkAppId) return home;
  const token = userTokenAuthState(botConfig.larkAppId, normalizeBrand(botConfig.brand), openId).state;
  if (token === 'authorized') return 'authorized';
  return home === 'unknown' || token === 'unknown' ? 'unknown' : 'needs-login';
}

/** Whether the person definitely has no credentials. The platform has no read-only probe, so where credentials can come from it nothing is judged. */
async function definitelyUnauthorized(tool: TriggerUserAuthTool, botConfig: BotConfig, openId: string): Promise<boolean> {
  const source = policyFromConfig(botConfig.triggerUserAuth).credentialSource;
  if (source === 'platform' || (source === 'auto' && platformAuthorizeUrl())) return false;
  return await localLoginState(tool, botConfig, openId) === 'needs-login';
}

/** Whether published identity text or a refusal carries a definite "not authorized" tag; an outage, an unavailable platform or no publication at all does not. */
export const definitelyNotAuthorized = (text: string | undefined): boolean => hasReason(text, NOT_AUTHORIZED_REASONS);

/** One enabled capability whose credential is missing. `platform`: the platform
 *  sends the person its own authorization card, so there is no link here. */
export interface AuthorizationEntry { provider: UnattendedProvider; url?: string; platform?: true }

/**
 * The one builder of authorization entries, used by the creation offer, the
 * unattended notice and the attended refusal: every enabled capability whose
 * credential is definitely missing (read-only), each with its link, so a person
 * who lacks several is told once. `known` is the provider whose refusal led
 * here (included without re-checking; `url` when the caller already has its
 * link); `except` leaves one provider out (the caller delivers it itself).
 * Links come from the login flows, which hand back the live challenge until it
 * expires, so asking again mints nothing new.
 */
export async function missingAuthorizationEntries(botConfig: BotConfig, openId: string, opts: {
  known?: { provider: UnattendedProvider; url?: string | null }; except?: UnattendedProvider; tenant?: MeegoTenant;
  /** The identity this person's current turn already published, per tool; when given it replaces the local login check. */
  published?: (tool: TriggerUserAuthTool) => string | undefined;
} = {}): Promise<AuthorizationEntry[]> {
  const { known, except, published } = opts;
  const policy = policyFromConfig(botConfig.triggerUserAuth);
  const entries: AuthorizationEntry[] = [];
  for (const tool of TRIGGER_USER_AUTH_TOOLS) {
    if (tool === except || !policy.capabilities.has(capabilityOfTool(tool))) continue;
    if (known?.provider !== tool) {
      // A session bound to the lark tool resolves lark-cli itself.
      if (tool === 'lark-cli' && botConfig.larkToolBinding !== false) continue;
      if (!await (published ? definitelyNotAuthorized(published(tool)) : definitelyUnauthorized(tool, botConfig, openId))) continue;
    }
    entries.push(platformBacked(botConfig, tool) ? { provider: tool, platform: true }
      : { provider: tool, url: known?.provider === tool && known.url !== undefined
        ? known.url ?? undefined : await authorizationLink(tool, botConfig, openId).catch(() => undefined) });
  }
  if (except !== 'meego' && capabilityOn(botConfig.triggerUserAuth, 'meego')) {
    if (known?.provider === 'meego') entries.push({ provider: 'meego', url: known.url ?? undefined });
    else {
      const login = await requestMeegoLogin(openId, opts.tenant).catch(() => undefined);
      if (login?.state === 'link') entries.push({ provider: 'meego', url: login.authUrl });
    }
  }
  return entries;
}

/**
 * Platform-backed entries become one platform authorization card (the platform
 * delivers it, botmux never sees a link); a platform without that endpoint
 * leaves them as plain credentials-page entries. `rest` is what botmux still
 * delivers itself; `platformOk` is false when the platform could not take the
 * request (nothing reached the person).
 */
async function deliverPlatformEntries(args: {
  botConfig: BotConfig; openId: string; entries: readonly AuthorizationEntry[];
}): Promise<{ rest: AuthorizationEntry[]; platformOk: boolean }> {
  const rest = args.entries.filter(e => !e.platform);
  if (rest.length === args.entries.length) return { rest, platformOk: true };
  const result = await askPlatformToAuthorize({ botConfig: args.botConfig, openId: args.openId });
  if (result.kind === 'legacy') {
    const url = platformAuthorizeUrl() ?? undefined;
    return { rest: [...args.entries.filter(e => e.platform).map(({ provider }) => ({ provider, url })), ...rest], platformOk: true };
  }
  if (result.kind === 'undeliverable' || result.kind === 'unavailable' || result.kind === 'request_cap') {
    logger.warn(`[unattended-auth] platform authorization card not sent: ${result.kind}`);
    return { rest, platformOk: false };
  }
  return { rest, platformOk: true };
}

/**
 * Sends `openId` ONE private message with an authorization entry for every
 * capability the bot will run as them that they definitely have no credentials
 * for (platform-backed ones arrive as the platform's own card). Reads state only
 * and never blocks or fails the creation: problems are logged.
 */
export async function offerAuthorizationAtCreation(args: {
  botConfig: BotConfig; openId: string; locale: Locale | undefined; sendDirect: SendDirect;
  /** Set when the person is the sender of the turn that creates the task: what that turn published for them. */
  published?: (tool: TriggerUserAuthTool) => string | undefined;
}): Promise<void> {
  const { botConfig, openId, locale } = args;
  try {
    const { rest: entries } = await deliverPlatformEntries({
      botConfig, openId,
      entries: await missingAuthorizationEntries(botConfig, openId, { published: args.published }),
    });
    if (entries.some(e => e.url)) {
      const lines = entries.flatMap(({ provider, url }) =>
        url ? [t('unattended.lapse_entry', { capability: capabilityOfProvider(provider), where: url }, locale)] : []);
      await args.sendDirect(openId, [t('creation.auth_entry', undefined, locale), ...lines].join('\n'));
    }
  } catch (e) {
    logger.warn(`[unattended-auth] could not offer authorization at creation: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const capabilityOfProvider = (provider: UnattendedProvider) => provider === 'meego' ? 'meego' : capabilityOfTool(provider);

/** Last link delivered per task, person and provider; a different link means the earlier one expired. */
const lastSent = new Map<string, string>();

/** Forgets the lapse notices (tests). */
export function __resetUnattendedNoticesForTest(): void { lastSent.clear(); }

const lapseKey = (appId: string, taskId: string, openId: string, provider: string) => JSON.stringify([appId, taskId, openId, provider]);

/**
 * The task an unattended turn belongs to, for the lapse key and text: a
 * scheduled turn names it, a background job knows it; any other unattended turn
 * (external trigger, workflow event) is keyed by its session and called by a fixed label.
 */
export function unattendedTask(appId: string, sessionId: string, turnId: string, locale: Locale | undefined): { taskId: string; taskName: string } {
  const taskId = parseScheduledTurnId(turnId)
    ?? scheduler.backgroundExecutions(appId, sessionId).find(job => `background:${job.id}` === turnId)?.taskId;
  if (!taskId) return { taskId: sessionId, taskName: t('unattended.run_label', undefined, locale) };
  return { taskId, taskName: scheduler.getScheduleAuthorityRecord(taskId, appId)?.task.name || taskId };
}

/**
 * The one private notice for an unattended run whose command was refused for a
 * missing credential, with an authorization entry for every capability the
 * person lacks. Private to the principal only: a direct message, or a card only
 * they see in the task's chat when that fails; never a plain group message, the
 * agent or a claim card. A link is delivered once per task, person and
 * provider: the keys are recorded before the send, so concurrent refusals give
 * one message, and dropped again when the send fails, so the next refusal
 * retries. A changed link (the earlier challenge expired) is sent again.
 * Resolves true once the notice is delivered or already was.
 */
export async function deliverUnattendedLapse(args: {
  appId: string; taskId: string; taskName: string; openId: string; locale: Locale | undefined;
  botConfig: BotConfig;
  entries: readonly AuthorizationEntry[]; sendDirect: SendDirect;
}): Promise<boolean> {
  const { appId, taskId, openId, locale, entries } = args;
  const marker = (e: AuthorizationEntry) => e.platform ? 'platform' : e.url ?? '';
  const keyOf = (e: AuthorizationEntry) => lapseKey(appId, taskId, openId, e.provider);
  const changed = entries.filter(e => lastSent.get(keyOf(e)) !== marker(e));
  if (!changed.length) return true;
  for (const e of changed) lastSent.set(keyOf(e), marker(e));
  const { rest, platformOk } = await deliverPlatformEntries({
    botConfig: args.botConfig, openId, entries: entries.filter(e => !e.platform || changed.includes(e)),
  });
  if (!platformOk) for (const e of changed.filter(e => e.platform)) lastSent.delete(keyOf(e));
  if (!rest.length) return platformOk;
  const lines = rest.map(e => t('unattended.lapse_entry', {
    capability: capabilityOfProvider(e.provider),
    where: e.url ?? t(e.provider === 'meego' ? 'unattended.how_meego' : e.provider === 'bytedcli' ? 'unattended.how_bytecloud' : 'unattended.how_lark', undefined, locale),
  }, locale));
  const text = [t('unattended.lapse_notice', { task: args.taskName, capabilities: rest.map(e => capabilityOfProvider(e.provider)).join(', ') }, locale), ...lines].join('\n');
  try { await args.sendDirect(openId, text); return platformOk; }
  catch (error) {
    for (const e of rest) lastSent.delete(keyOf(e));
    logger.warn(`[unattended-auth] lapse notice not delivered: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Credentials are back for this person: the next lapse is a new one. */
export function clearUnattendedLapse(appId: string, taskId: string, openId: string, provider: UnattendedProvider): void {
  lastSent.delete(lapseKey(appId, taskId, openId, provider));
}

/** Called after an unattended run's identity was published: tools whose credentials are in force end their lapse. */
export function clearRestoredLapses(args: {
  appId: string; taskId: string; openId: string; outcomes: readonly ToolIdentityOutcome[];
}): void {
  for (const { tool, state } of args.outcomes) if (state === 'user') clearUnattendedLapse(args.appId, args.taskId, args.openId, tool);
}

/**
 * The daemon's answer to a refusal in an unattended run: nothing interactive,
 * answered at once. `ready` when the person does have credentials (no notice),
 * `unavailable` when the provider cannot be asked, else the private notice
 * with every missing entry in it: `delivered` or `undelivered`.
 */
export async function requestUnattendedAuthorization(args: {
  appId: string; taskId: string; taskName: string; openId: string; locale: Locale | undefined; botConfig: BotConfig;
  provider: UnattendedProvider; tenant?: MeegoTenant; sendDirect: SendDirect;
}): Promise<'ready' | 'unavailable' | 'delivered' | 'undelivered'> {
  const { provider, botConfig, openId } = args;
  let url: string | undefined;
  if (provider === 'meego') {
    const login = await requestMeegoLogin(openId, args.tenant);
    if (login.state === 'unavailable') return 'unavailable';
    if (login.state === 'ready') { clearUnattendedLapse(args.appId, args.taskId, openId, provider); return 'ready'; }
    url = login.authUrl;
  } else if (policyFromConfig(botConfig.triggerUserAuth).credentialSource !== 'platform'
    && !platformBacked(botConfig, provider)
    && await localLoginState(provider, botConfig, openId) === 'authorized') {
    // The refusal that led here is the evidence of a lapse; a login that has appeared since ends it.
    clearUnattendedLapse(args.appId, args.taskId, openId, provider);
    return 'ready';
  }
  return await noticeUnattendedLapse({ ...args, url });
}

/**
 * The private notice for a refusal already known to be a lapse of `provider`:
 * its own entry (`url` when the caller has the link) and one for every other
 * enabled capability the person lacks, in one message.
 */
export async function noticeUnattendedLapse(args: {
  appId: string; taskId: string; taskName: string; openId: string; locale: Locale | undefined; botConfig: BotConfig;
  provider: UnattendedProvider; url?: string | null; tenant?: MeegoTenant; sendDirect: SendDirect;
}): Promise<'delivered' | 'undelivered'> {
  const entries = await missingAuthorizationEntries(args.botConfig, args.openId, {
    known: { provider: args.provider, url: args.url }, tenant: args.tenant,
  });
  return await deliverUnattendedLapse({ ...args, entries }) ? 'delivered' : 'undelivered';
}
