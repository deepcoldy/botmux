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
import { withHardTimeout } from '../platform/credential-grant-client.js';
import { TRIGGER_USER_AUTH_TOOLS, type TriggerUserAuthTool } from '../services/trigger-user-auth.js';
import { logger } from '../utils/logger.js';
import { capabilityOfTool, policyFromConfig } from './identity-policy.js';
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
  /** The platform did not take the request; nothing was sent. `guardRefused`
   * distinguishes a caller's turn fence from a platform/lookup failure so a
   * different, still-valid caller sharing the request can try on its own. */
  | { kind: 'unavailable'; guardRefused?: true };

export interface PlatformAuthorizationRequestArgs {
  botConfig: Pick<BotConfig, 'larkAppId' | 'triggerUserAuth'>;
  /** The person's open_id for this bot's app; its union_id is looked up unless given. */
  openId?: string;
  unionId?: string;
  /** Extra lark-cli scopes the refused command needs. */
  scopes?: readonly string[];
  /** Check this caller before reusing an answer and again after resolving the
   * person, before sending a card. */
  stillAllowed?: () => boolean;
  /** Recheck the caller and its authorization policy after resolving union_id. */
  isCurrent?: () => boolean;
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

/** Answers remembered per app, person, tools and scopes for a few minutes. */
type Remembered = Extract<PlatformAuthorizationRequestResult, { kind: 'sent' | 'undeliverable' | 'request_cap' }>;
const recent = new Map<string, { at: number; answer: Remembered }>();
/** The request in flight per app, person, tools and scopes, shared by concurrent refusals. */
const inFlight = new Map<string, Promise<PlatformAuthorizationRequestResult>>();
/** However the union_id lookup or the platform hangs, a refusal is answered within this. */
const ASK_TIMEOUT_MS = 15_000;

/** The same answer again within the window: a sent card is deduped, a failure is marked as a repeat. */
function asRepeat(answer: PlatformAuthorizationRequestResult): PlatformAuthorizationRequestResult {
  return answer.kind === 'sent' ? { kind: 'sent', deduped: true }
    : answer.kind === 'undeliverable' || answer.kind === 'request_cap' ? { kind: answer.kind, repeat: true } : answer;
}

/** Every platform-backed tool the bot runs as the person: one card covers all of them. */
function platformTools(botConfig: Pick<BotConfig, 'triggerUserAuth'>): TriggerUserAuthTool[] {
  const { capabilities, credentialSources } = policyFromConfig(botConfig.triggerUserAuth);
  return TRIGGER_USER_AUTH_TOOLS.filter(tool => {
    const capability = capabilityOfTool(tool);
    return capabilities.has(capability) && credentialSources[capability] !== 'local';
  });
}

function callerAllowed(args: PlatformAuthorizationRequestArgs): boolean {
  try {
    if (args.isCurrent && args.isCurrent() === false) return false;
    if (args.stillAllowed && args.stillAllowed() !== true) return false;
    return true;
  } catch { return false; }
}

export async function askPlatformToAuthorize(
  args: PlatformAuthorizationRequestArgs,
  deps: Partial<Deps> = {},
): Promise<PlatformAuthorizationRequestResult> {
  const d = { ...realDeps, ...deps };
  const who = args.unionId ?? args.openId ?? '';
  while (true) {
    // A cached/shared answer is never a substitute for this caller's own fence.
    if (!callerAllowed(args)) return { kind: 'unavailable' };
    const tools = platformTools(args.botConfig);
    if (!tools.length) return { kind: 'unavailable' };
    const scopes = tools.includes('lark-cli') ? [...new Set(args.scopes ?? [])].sort() : [];
    const key = JSON.stringify([args.botConfig.larkAppId, who, tools, scopes]);
    const now = d.now();
    const hit = recent.get(key);
    if (hit && now - hit.at < LINK_RESEND_MS) return asRepeat(hit.answer);
    for (const [k, v] of recent) if (now - v.at >= LINK_RESEND_MS) recent.delete(k);
    const shared = inFlight.get(key);
    if (shared) {
      const result = asRepeat(await shared);
      if (result.kind === 'unavailable' && result.guardRefused) {
        // The owner became invalid while resolving the person. That says
        // nothing about this caller: let valid joiners start or share a new
        // request instead of inheriting another turn's stopped authorization.
        if (inFlight.get(key) === shared) inFlight.delete(key);
        continue;
      }
      return result;
    }
    const pending = withHardTimeout(() => ask(args, tools, scopes, d), ASK_TIMEOUT_MS)
      .catch(() => unavailable(`no answer within ${ASK_TIMEOUT_MS}ms`));
    inFlight.set(key, pending);
    let result: PlatformAuthorizationRequestResult;
    try { result = await pending; } finally {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    }
    if (result.kind === 'sent' || result.kind === 'undeliverable' || result.kind === 'request_cap') recent.set(key, { at: d.now(), answer: result });
    return result;
  }
}

async function ask(
  args: PlatformAuthorizationRequestArgs, tools: TriggerUserAuthTool[], scopes: string[], d: Deps,
): Promise<PlatformAuthorizationRequestResult> {
  const unionId = args.unionId ?? (args.openId ? await d.unionIdFor(args.botConfig.larkAppId, args.openId) : null);
  if (!unionId) return unavailable('sender union_id unresolved');
  if (!callerAllowed(args)) return { kind: 'unavailable', guardRefused: true };
  // A hot edit can change another tool's route without cancelling the Lark
  // request. Do not send a card with a tool set that belongs to the old policy.
  const liveTools = platformTools(args.botConfig);
  if (liveTools.length !== tools.length || liveTools.some((tool, index) => tool !== tools[index])) {
    return { kind: 'unavailable' };
  }
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
  inFlight.clear();
}
