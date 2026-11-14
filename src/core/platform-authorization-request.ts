/**
 * Asks the central platform to send a person its authorization card.
 *
 * On a platform-bound host every refusal that the person ends by authorizing on
 * the platform (a missing grant, a missing consent for this machine, a missing
 * scope) goes through here. The platform decides what the person lacks, stores
 * the request and delivers one card from its own bot; botmux never holds or
 * relays a link, so nothing it says to the agent or to a group can carry one.
 */
import type { BotConfig } from '../bot-registry.js';
import {
  requestCredentialAuthorization,
  type CredentialRequest,
  type CredentialRequestResult,
} from '../platform/credential-request-client.js';
import type { TriggerUserAuthTool } from '../services/trigger-user-auth.js';
import { logger } from '../utils/logger.js';
import { policyFromConfig } from './identity-policy.js';
import { platformUnionIdFor } from './platform-credential-source.js';
import { LINK_RESEND_MS } from './provider-auth-request.js';

export type PlatformAuthorizationRequestResult =
  /** The platform sent the card (`deduped`: an earlier card still covers this). */
  | { kind: 'sent'; deduped: boolean }
  /** The person lacks nothing on this machine. */
  | { kind: 'ready' }
  /** The platform could not deliver the card to the person (`repeat`: already reported within the last minutes). */
  | { kind: 'undeliverable'; repeat?: true }
  /** The platform has no authorization-request endpoint: use the plain credentials page. */
  | { kind: 'legacy' }
  /** Several cards were already sent to the person today; nothing was sent. */
  | { kind: 'request_cap'; repeat?: true }
  /** The platform did not take the request; nothing was sent. */
  | { kind: 'unavailable' };

export interface PlatformAuthorizationRequestArgs {
  botConfig: Pick<BotConfig, 'larkAppId' | 'triggerUserAuth'>;
  /** The person's open_id for this bot's app; its union_id is looked up unless given. */
  openId?: string;
  unionId?: string;
  /** Extra lark-cli scopes the refused command needs. */
  scopes?: readonly string[];
}

interface Deps {
  request: (req: CredentialRequest) => Promise<CredentialRequestResult>;
  unionIdFor: (larkAppId: string, openId: string) => Promise<string | null>;
  now: () => number;
}

const realDeps: Deps = {
  request: req => requestCredentialAuthorization(req),
  unionIdFor: platformUnionIdFor,
  now: () => Date.now(),
};

/** Answers remembered per app, person and scopes; the in-flight request is shared by concurrent refusals. */
type Remembered = Extract<PlatformAuthorizationRequestResult, { kind: 'sent' | 'undeliverable' | 'request_cap' }>;
const recent = new Map<string, { at: number; answer?: Remembered; pending?: Promise<PlatformAuthorizationRequestResult> }>();

/** The same answer again within the window: a sent card is deduped, a failure is marked as a repeat. */
function asRepeat(answer: PlatformAuthorizationRequestResult): PlatformAuthorizationRequestResult {
  return answer.kind === 'sent' ? { kind: 'sent', deduped: true }
    : answer.kind === 'undeliverable' || answer.kind === 'request_cap' ? { kind: answer.kind, repeat: true } : answer;
}

/** Every platform-backed tool the bot runs as the person: one card covers all of them. */
function platformTools(botConfig: Pick<BotConfig, 'triggerUserAuth'>): TriggerUserAuthTool[] {
  const { capabilities } = policyFromConfig(botConfig.triggerUserAuth);
  return [
    ...(capabilities.has('lark-user') ? ['lark-cli' as const] : []),
    ...(capabilities.has('bytecloud') ? ['bytedcli' as const] : []),
  ];
}

export async function askPlatformToAuthorize(
  args: PlatformAuthorizationRequestArgs,
  deps: Partial<Deps> = {},
): Promise<PlatformAuthorizationRequestResult> {
  const d = { ...realDeps, ...deps };
  const who = args.unionId ?? args.openId ?? '';
  const scopes = [...new Set(args.scopes ?? [])].sort();
  const key = JSON.stringify([args.botConfig.larkAppId, who, scopes]);
  const now = d.now();
  const hit = recent.get(key);
  if (hit?.pending) return asRepeat(await hit.pending);
  if (hit?.answer && now - hit.at < LINK_RESEND_MS) return asRepeat(hit.answer);
  for (const [k, v] of recent) if (!v.pending && now - v.at >= LINK_RESEND_MS) recent.delete(k);
  const pending = ask(args, scopes, d);
  recent.set(key, { at: now, pending });
  const result = await pending;
  if (result.kind === 'sent' || result.kind === 'undeliverable' || result.kind === 'request_cap') recent.set(key, { at: d.now(), answer: result });
  else recent.delete(key);
  return result;
}

async function ask(
  args: PlatformAuthorizationRequestArgs, scopes: string[], d: Deps,
): Promise<PlatformAuthorizationRequestResult> {
  const tools = platformTools(args.botConfig);
  const unionId = args.unionId ?? (args.openId ? await d.unionIdFor(args.botConfig.larkAppId, args.openId) : null);
  if (!unionId) return unavailable('sender union_id unresolved');
  const result = await d.request({
    unionId, appId: args.botConfig.larkAppId, tools,
    ...(scopes.length ? { scopes } : {}),
  });
  if (result.ok) {
    switch (result.status) {
      case 'sent': return { kind: 'sent', deduped: result.deduped };
      case 'ready': return { kind: 'ready' };
      case 'undeliverable':
        logger.warn(`[platform-auth] platform could not deliver the authorization card: ${result.detail}`);
        return { kind: 'undeliverable' };
    }
  }
  switch (result.reason) {
    case 'not_deployed': return { kind: 'legacy' };
    case 'request_cap': return { kind: 'request_cap' };
    case 'unbound': return unavailable('machine is not bound to a platform');
    case 'failed': return unavailable(result.detail);
  }
}

function unavailable(detail: string): PlatformAuthorizationRequestResult {
  logger.warn(`[platform-auth] authorization card not requested: ${detail}`);
  return { kind: 'unavailable' };
}

/** @internal test-only */
export function __resetPlatformAuthorizationRequestForTest(): void {
  recent.clear();
}
