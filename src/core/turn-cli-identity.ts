/**
 * Per-turn publication of the acting CLI identity.
 *
 * This is where the three pieces meet: the bot's {@link TriggerUserAuthConfig}
 * policy, the per-person token store, and the per-turn identity snapshot a
 * wrapper sources when that turn executes.
 *
 * The single rule it enforces: **the credentials published for a turn belong to
 * the person who sent that turn, or nothing is published.** There is no path
 * here that reads another person's token — the sender's open_id is the only key
 * ever used. Missing credentials produce a denial in that turn's snapshot.
 */
import { logger } from '../utils/logger.js';
import { resolveUserToken, lookupAuthorizedUserName } from '../utils/user-token.js';
import { t } from '../i18n/index.js';
import type { Locale } from '../i18n/index.js';
import { normalizeBrand } from '../im/lark/lark-hosts.js';
import { beginBytedcliLogin, mintBytedcliJwts, type BytedcliJwts } from '../services/bytedcli-auth.js';
import { resolveLarkCliHomeForTurn, beginLarkCliLogin } from '../services/lark-cli-auth.js';
import { readCliAuthEpoch } from '../services/cli-auth-epoch.js';
import type { BotConfig } from '../bot-registry.js';
import { isLarkToolBound } from './lark-tool-binding.js';
import { rememberLarkToolDelegation, getLarkToolDelegation } from './lark-tool-delegation.js';
import { registerActiveIdentityTurn, releaseActiveIdentityTurn } from './active-identity-turns.js';
import {
  TRIGGER_USER_AUTH_TOOLS,
  type TriggerUserAuthConfig,
  type TriggerUserAuthTool,
} from '../services/trigger-user-auth.js';
import { policyFromConfig, resolveIdentity, capabilityOfTool, type IdentityPolicy } from './identity-policy.js';
import type { IdentityStorageModel } from './lark-tool-binding.js';
import {
  activePlatformCredentialBindingKey,
  resolvePlatformIdentity,
  platformRefusalReason,
  platformAuthorizeUrl,
  reasonTag,
  type PlatformIdentityResolution,
} from './platform-credential-source.js';
import { hasReason } from './refusal-reasons.js';
import {
  writeSessionIdentity,
  meegoStoreShape,
  clearSessionIdentity,
  recallProvenIdentityContent,
  recallProvenIdentitySnapshot,
  type ProvenIdentitySnapshot,
  publishedIdentityShape,
  type BytedCliIdentity,
  type CliIdentity,
} from './cli-identity.js';
import { allowsPersonalIdentityForTurn, isUnattendedIdentityTurnId } from './workflow-event-turn.js';
import { trackBytedcliIdentityRenewal } from './bytedcli-identity-renewal.js';
import { GRANT_WAIT_CAP_MS } from '../platform/credential-grant-budget.js';
import { BYTEDCLI_OVERSEAS_REGIONS, type BytedcliOverseasRegion } from '../platform/bytedcli-grant-regions.js';
import { jwtClaims } from '../utils/bytecloud-jwt-claims.js';

/** What was published for one tool this turn — drives the user-visible notice. */
export interface ToolIdentityOutcome {
  tool: TriggerUserAuthTool;
  /**
   * - `user`: the sender's own credentials are in force.
   * - `needs-authorization`: nothing published; the sender must authorize
   *   before the tool will work. Neither governed tool degrades to a machine
   *   identity anymore, so there is no other "allowed" outcome.
   * - `unavailable`: the provider failed; retain login state without requesting a new login.
   * - `off`: the policy does not govern this tool; nothing was touched.
   */
  state: 'user' | 'needs-authorization' | 'unavailable' | 'off';
}

/** Created only by the daemon after verifying the signed dispatch and resolving
 * its stable user identity in the receiving app. Never accepted from CLI input. */
export interface DelegatedCliIdentity {
  targetOpenId?: string;
  /** The requester as seen by the ISSUING app: the key of their local
   *  credential stores on this machine. Never valid inside the receiving app. */
  credentialOpenId: string;
  /** Tenant-stable id of the same human, from the verified dispatch record.
   *  The platform key: it needs no lookup in either app. */
  unionId: string;
  tools: TriggerUserAuthTool[];
  dispatchRoot: string;
  /** `delegation_inactive`: a workflow handoff's delegation whose run attempt
   *  ended, or whose handoff was withdrawn (design 2026-11-03 §10.3). */
  denialReason?: 'target_chat_membership_required' | 'target_identity_unresolved' | 'target_access_denied' | 'target_validation_unavailable' | 'delegation_inactive'
    /** A workflow delegation passed on from a node session into a session
     *  that keeps identities on disk: it could not be re-checked per use. */
    | 'passed_on_unsupported' | 'task_turn_isolation_required';
  /** A workflow handoff's delegation (design 2026-11-03 §10). */
  workflowHandoff?: true;
  /** Workflow handoff only: re-run its run / attempt / revocation checks
   *  (local reads) and say why it no longer holds. Consulted on every use,
   *  so a stop that never reached this daemon still ends it. Daemon memory
   *  only; never serialized. */
  recheck?: () => string | undefined;
  /** Recheck a cross-chat task's signed user decision before publishing or renewing. */
  taskAuthorized?: () => Promise<boolean>;
}

/** Replace one tool's published identity for `turnId` with the refusal for
 *  `delegated` (its `denialReason` explains it). Used when a workflow
 *  delegation stops holding while its turn is still running. */
export function publishDelegationRefusal(args: {
  sessionDataDir: string;
  sessionId: string;
  turnId: string;
  tool: TriggerUserAuthTool;
  delegated: DelegatedCliIdentity;
  storageModel: IdentityStorageModel;
}): void {
  denyDelegated(args.tool, {
    botConfig: {} as BotConfig,
    sessionDataDir: args.sessionDataDir,
    sessionId: args.sessionId,
    senderOpenId: undefined,
    turnId: args.turnId,
    storageModel: args.storageModel,
  }, args.delegated);
}

export interface PublishTurnIdentityArgs {
  botConfig: BotConfig;
  sessionDataDir: string;
  sessionId: string;
  /** The person who sent THIS turn. Absent for turns with no human sender. */
  senderOpenId: string | undefined;
  delegatedIdentity?: DelegatedCliIdentity;
  /** For the stderr text the wrapper prints when a command is refused. */
  locale?: Locale;
  /**
   * The turn these credentials are for. Stamped into the file so the wrapper can
   * refuse to use them during a different turn — the CLI runs its own queue, so
   * a newer message's credentials can land while an older turn is still going.
   */
  turnId?: string;
  /** Whether publication keeps the identity in daemon memory (proven) or in the
   *  legacy single-snapshot file (single). The caller derives this with the
   *  same predicate the worker uses to render the wrapper. */
  storageModel: IdentityStorageModel;
  /** The turn's chat is a 1:1 chat between the sender and the bot. Only then
   *  may a refusal carry an authorization link for the agent to relay: in a
   *  group, whoever opens the link authorizes as themselves. */
  privateChat?: boolean;
  /** Synchronous final fence for authority that can change while credentials
   *  resolve (owner replacement/revocation, opt-out, terminal or generation
   *  replacement). Checked before credential resolution and again immediately
   *  before each personal-identity write. A publication that becomes invalid
   *  is removed rather than left readable by a later policy flip. */
  validateBeforeWrite?: () => boolean;
}

function publicationValid(validate: (() => boolean) | undefined): boolean {
  try { return validate?.() !== false; } catch { return false; }
}

/**
 * Publish (or withhold) each governed tool's identity for the current turn.
 *
 * Never throws: a credential-publication failure must not take down the turn.
 * The worst case is a withheld identity, which the tool reports as an auth error
 * and the agent can act on.
 */
// ─── Publications in flight: a call that arrives mid-publication waits ───────
//
// A turn's identity is published asynchronously (a platform grant can take its
// whole budget). The opening turn of a new session is published again once the
// worker reports its identity model, and the CLI's first tool call can land in
// that window: it found nothing yet and was refused as if the person had no
// credentials, while the next message — published in time — worked.

/** Longest an identity fetch waits on a publication that is still running.
 *  Outlasts a whole platform grant: a shorter wait refused the tool call while
 *  the grant was still on its way. */
export const PUBLICATION_WAIT_CAP_MS = GRANT_WAIT_CAP_MS;
const publicationsInFlight = new Map<string, Set<Promise<unknown>>>();
const publicationKey = (sessionDataDir: string, sessionId: string) => JSON.stringify([sessionDataDir, sessionId]);

/** Resolves when no publication for this session is running, or after `capMs`. Never throws. */
export async function awaitTurnIdentityPublication(
  sessionDataDir: string,
  sessionId: string,
  capMs = PUBLICATION_WAIT_CAP_MS,
): Promise<void> {
  const pending = publicationsInFlight.get(publicationKey(sessionDataDir, sessionId));
  if (!pending?.size) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...pending]),
    new Promise<void>(resolve => { timer = setTimeout(resolve, capMs); }),
  ]);
  clearTimeout(timer);
}

/** Mark `work` as a publication for this session until it settles. Callers
 *  whose publication starts after other async steps (the model-flip replay
 *  resolves the turn's sender first) register the whole chain up front. */
export function trackTurnIdentityPublication<T>(sessionDataDir: string, sessionId: string, work: Promise<T>): Promise<T> {
  const key = publicationKey(sessionDataDir, sessionId);
  let set = publicationsInFlight.get(key);
  if (!set) publicationsInFlight.set(key, set = new Set());
  set.add(work);
  const settle = () => {
    const current = publicationsInFlight.get(key);
    current?.delete(work);
    if (current && !current.size) publicationsInFlight.delete(key);
  };
  work.then(settle, settle);
  return work;
}

export function publishTurnCliIdentity(
  args: PublishTurnIdentityArgs,
): Promise<ToolIdentityOutcome[]> {
  return trackTurnIdentityPublication(args.sessionDataDir, args.sessionId, publishTurnCliIdentityNow(args));
}

async function publishTurnCliIdentityNow(
  args: PublishTurnIdentityArgs,
): Promise<ToolIdentityOutcome[]> {
  const personalIdentityAllowedAtStart = allowsPersonalIdentityForTurn(args.turnId, args.botConfig.triggerUserAuth);
  if (!personalIdentityAllowedAtStart || !publicationValid(args.validateBeforeWrite)) {
    args = { ...args, senderOpenId: undefined, delegatedIdentity: undefined };
  }
  const { sessionDataDir, sessionId, turnId } = args;
  const privateChat = args.privateChat === true;
  const outcomes: ToolIdentityOutcome[] = [];
  // Record before the new-entry shortcut (and before first worker spawn).
  // The daemon has already verified the signed dispatch and target access.
  rememberLarkToolDelegation(sessionDataDir, sessionId, turnId, args.delegatedIdentity);
  // Anchor the published turn in the terminal-GC retention ledger for the whole
  // accept→queue→execute window. The worker's own queue marker is CLI-writable
  // and cannot serve as that anchor.
  if (turnId) registerActiveIdentityTurn(sessionDataDir, sessionId, turnId);

  // The tools are prepared side by side: they share no credential state (each
  // has its own provider queue and its own identity file / proven entry), and a
  // bytedcli mint is several CLI runs that must not hold back lark-cli. The
  // outcomes keep the TRIGGER_USER_AUTH_TOOLS order, each tool still fails
  // closed on its own, and this settles only after every tool has settled, so
  // a turn is never released with one identity still being written.
  const settled = await Promise.allSettled(TRIGGER_USER_AUTH_TOOLS.map(tool => publishToolIdentity(tool, args, privateChat)));
  // Only an initially eligible personal publication is revoked here. A turn
  // that started with owner credentials disabled keeps its ordinary denial.
  if (personalIdentityAllowedAtStart && args.validateBeforeWrite && !publicationValid(args.validateBeforeWrite)) {
    for (const tool of TRIGGER_USER_AUTH_TOOLS) {
      clearSessionIdentity(sessionDataDir, sessionId, tool, turnId, args.storageModel);
      if (turnId) transientRefusals.delete(transientKey(sessionDataDir, sessionId, turnId, tool));
    }
    if (turnId) releaseActiveIdentityTurn(sessionDataDir, sessionId, turnId);
    return TRIGGER_USER_AUTH_TOOLS.map(tool => ({ tool, state: 'off' as const }));
  }
  for (const result of settled) {
    if (result.status === 'rejected') throw result.reason;
    outcomes.push(result.value);
  }
  return outcomes;
}

async function publishToolIdentity(
  tool: TriggerUserAuthTool,
  args: PublishTurnIdentityArgs,
  privateChat: boolean,
): Promise<ToolIdentityOutcome> {
  const { botConfig, sessionDataDir, sessionId, senderOpenId, locale, turnId, storageModel } = args;
  if (tool === 'lark-cli' && isLarkToolBound(botConfig, sessionDataDir, sessionId)) {
    return { tool, state: 'off' }; // the new session entry resolves this itself
  }
  const policy = policyFromConfig(botConfig.triggerUserAuth);
  const delegated = args.delegatedIdentity;
  const principal = delegated ? { openId: delegated.credentialOpenId } : senderOpenId ? { openId: senderOpenId } : null;
  try {
    if (!policy.capabilities.has(capabilityOfTool(tool))) {
      // ByteCloud native, Meego on: the person's Meego store only.
      return tool === 'bytedcli' && policy.capabilities.has('meego')
        ? await publishMeegoOnly(args, principal, policy)
        : { tool, state: 'off' };
    }
    if (delegated) return await publishDelegated(tool, args, delegated, policy);
    if (!principal) {
      // No human sender (scheduled run, hook, meeting event, bot-to-bot handoff):
      // there is no "trigger user" to act as. Withhold — never reach for the
      // session creator's or the owner's credentials to fill the gap.
      return await withholdIdentity(tool, botConfig, sessionDataDir, sessionId, senderOpenId, locale, turnId, storageModel, privateChat);
    }
    return await publishOne(tool, botConfig, sessionDataDir, sessionId, principal.openId, locale, turnId, storageModel, privateChat, policy, args.validateBeforeWrite);
  } catch (e) {
    // Fail closed through the SAME policy as an ordinary missing token, so a
    // credential-store outage and "this person never authorized" cannot end
    // up with different identities in force.
    logger.warn(
      `[trigger-user-auth] withheld ${tool} identity for session ${sessionId}: `
      + `${e instanceof Error ? e.message : String(e)}`,
    );
    if (tool === 'bytedcli') {
      try {
        writeSessionIdentity(sessionDataDir, sessionId, {
          tool, mode: 'denied', ...(turnId ? { turnId } : {}),
          ...(!delegated && senderOpenId ? { openId: senderOpenId } : {}),
          message: locale === 'en'
            ? `botmux: bytedcli authorization service is unavailable. Stop automatic retries and repeated login requests; retry after the service recovers. Existing authorization is retained.\n${reasonTag('provider_unavailable')}`
            : `botmux: bytedcli 授权服务暂时不可用。请停止自动重试和重复要求用户登录；服务恢复后再重试，已有授权会保留。\n${reasonTag('provider_unavailable')}`,
        }, storageModel);
      } catch { clearSessionIdentity(sessionDataDir, sessionId, tool, turnId, storageModel); }
      if (!delegated && senderOpenId && turnId && storageModel === 'proven'
        && policy.capabilities.has('bytecloud') && localCredentialSourceAllowed(policy)) {
        rememberTransientRefusal({
          source: 'local', botConfig, tool, sessionDataDir, sessionId, senderOpenId, locale, turnId,
          validateBeforeWrite: args.validateBeforeWrite, kind: 'unavailable',
        });
      }
      return { tool, state: 'unavailable' };
    }
    return args.delegatedIdentity
      ? denyDelegated(tool, args, args.delegatedIdentity)
      : await withholdIdentity(tool, botConfig, sessionDataDir, sessionId, senderOpenId, locale, turnId, storageModel, privateChat);
  }
}

function denyDelegated(tool: TriggerUserAuthTool, args: PublishTurnIdentityArgs, user: DelegatedCliIdentity): ToolIdentityOutcome {
  const reasons = {
    target_validation_unavailable: 'Target user or group membership verification is unavailable. Restore verification before retrying.',
    target_access_denied: 'The target bot does not allow this requester to talk in the destination context.',
    target_identity_unresolved: 'The target bot could not resolve the requester in its own application.',
    target_chat_membership_required: 'The requester is outside the internal dispatch chat. Its membership rule blocked this task before credential issuance. Report to the original topic; another login will not change membership.',
    task_turn_isolation_required: 'This task requires a thread session with proven per-turn identity isolation.',
    delegation_inactive: 'This workflow handoff is no longer active (its run attempt ended or the handoff was withdrawn).',
    passed_on_unsupported: 'This workflow identity was passed on by another bot; it can only be used in a session that re-checks it on every call.',
  } satisfies Record<NonNullable<DelegatedCliIdentity['denialReason']>, string>;
  const reason = user.denialReason ? reasons[user.denialReason] : 'The source must ask the original human to authorize.';
  try {
    writeSessionIdentity(args.sessionDataDir, args.sessionId, {
      tool, mode: 'denied', ...(args.turnId ? { turnId: args.turnId } : {}),
      message: `botmux: delegated ${tool} execution refused for the requesting user. `
        + `Report this blocker with botmux report --dispatch-root ${user.dispatchRoot}; `
        + reason + ' Do not ask a bot to log in or use another identity.',
    }, args.storageModel);
  } catch {
    clearSessionIdentity(args.sessionDataDir, args.sessionId, tool, args.turnId, args.storageModel);
  }
  return { tool, state: 'needs-authorization' };
}

async function publishDelegated(tool: TriggerUserAuthTool, args: PublishTurnIdentityArgs, user: DelegatedCliIdentity, policy: IdentityPolicy): Promise<ToolIdentityOutcome> {
  if (!user.tools.includes(tool)) return denyDelegated(tool, args, user);
  let identity: CliIdentity | null = null;
  // Platform first, keyed by the union_id in the verified dispatch record. The
  // issuer-scoped credentialOpenId means nothing to this bot's app, and
  // re-deriving the union_id from targetOpenId would hang the grant on a
  // contact lookup that need not be reachable. On a bound host a non-grant is
  // final and local stores are never read; an unbound `auto` host still
  // honours an already-provisioned local HOME below.
  const source = policy.credentialSource;
  if (source !== 'local') {
    const platform = await resolvePlatformIdentity({
      botConfig: args.botConfig, tool, unionId: user.unionId,
      sessionId: args.sessionId, ...(args.turnId ? { turnId: args.turnId } : {}),
    });
    if (platform.state === 'granted') identity = platform.identity;
    else if (source === 'platform' || platform.state !== 'unbound') return denyDelegated(tool, args, user);
  }
  let localMint = false;
  if (!identity && tool === 'bytedcli') {
    // Keep the issuer-scoped credential key; do not copy a source open_id into
    // the target app or duplicate/extend the lifetime of the user's login.
    const jwt = await mintBytedcliJwts(user.credentialOpenId);
    if (jwt) identity = locallyMintedBytedcliIdentity(jwt);
    localMint = !!jwt;
  } else if (!identity && tool === 'lark-cli') {
    const home = await resolveLarkCliHomeForTurn(user.credentialOpenId);
    if (home) identity = { tool, mode: 'user-home', home };
    else if (user.targetOpenId && args.botConfig.larkAppId && args.botConfig.larkAppSecret) {
      // Legacy bot-app OAuth is application-bound: only a target-app token is
      // valid here. A source-app OAuth token is never presented as a target one.
      const token = await resolveUserToken(args.botConfig.larkAppId, args.botConfig.larkAppSecret,
        normalizeBrand(args.botConfig.brand), user.targetOpenId);
      if (token) identity = { tool, appId: args.botConfig.larkAppId, userAccessToken: token };
    }
  }
  let taskHolds = true;
  if (user.taskAuthorized) {
    try {
      taskHolds = await user.taskAuthorized();
    } catch {
      // Transient validation unavailability fails closed at publication; the
      // renewal sweep treats the same throw as retryable rather than dropping.
      taskHolds = false;
    }
  }
  if (!identity || !taskHolds) return denyDelegated(tool, args, user);
  const stamped = withMeegoStore({
    ...identity,
    ...(args.turnId ? { turnId: args.turnId } : {}),
    ...(user.targetOpenId ? { openId: user.targetOpenId } : {}),
  }, policy);
  if (!publicationValid(args.validateBeforeWrite)) return { tool, state: 'off' };
  writeSessionIdentity(args.sessionDataDir, args.sessionId, stamped, args.storageModel);
  if (localMint && args.turnId && args.storageModel === 'proven' && stamped.tool === 'bytedcli' && !('mode' in stamped)) {
    trackBytedcliIdentityRenewal({
      sessionDataDir: args.sessionDataDir, sessionId: args.sessionId,
      credentialOpenId: user.credentialOpenId, identity: { ...stamped, turnId: args.turnId },
      taskAuthorized: user.taskAuthorized,
    });
  }
  return { tool, state: 'user' };
}

/** The turn's Meego store for a bot whose ByteCloud is native: a bytedcli
 *  identity that carries no ByteCloud credential. */
async function publishMeegoOnly(
  args: PublishTurnIdentityArgs,
  principal: { openId: string } | null,
  policy: IdentityPolicy,
): Promise<ToolIdentityOutcome> {
  const { sessionDataDir, sessionId, locale, turnId, storageModel } = args;
  const delegated = args.delegatedIdentity;
  const openId = delegated ? delegated.targetOpenId : principal?.openId;
  if (delegated && (!openId || !delegated.tools.includes('bytedcli'))) return denyDelegated('bytedcli', args, delegated);
  if (!openId) {
    // Only Meego is the person's here: the refusal must not mention ByteCloud.
    writeSessionIdentity(sessionDataDir, sessionId, {
      tool: 'bytedcli', mode: 'denied', ...(turnId ? { turnId } : {}),
      message: `${t('trigger_user_auth.meego_no_sender', undefined, locale)}\n${reasonTag('no_sender')}`,
    }, storageModel);
    return { tool: 'bytedcli', state: 'needs-authorization' };
  }
  if (!publicationValid(args.validateBeforeWrite)) return { tool: 'bytedcli', state: 'off' };
  writeSessionIdentity(sessionDataDir, sessionId, withMeegoStore({
    tool: 'bytedcli', cloudJwt: '', meegoOnly: true, ...(turnId ? { turnId } : {}), openId,
  }, policy), storageModel);
  return { tool: 'bytedcli', state: 'user' };
}

async function publishOne(
  tool: TriggerUserAuthTool,
  botConfig: BotConfig,
  sessionDataDir: string,
  sessionId: string,
  senderOpenId: string,
  locale: Locale | undefined,
  turnId: string | undefined,
  storageModel: IdentityStorageModel,
  privateChat: boolean,
  policy: IdentityPolicy,
  validateBeforeWrite?: () => boolean,
): Promise<ToolIdentityOutcome> {
  const withheld = async () =>
    withholdIdentity(tool, botConfig, sessionDataDir, sessionId, senderOpenId, locale, turnId, storageModel, privateChat);

  const publish = (identity: CliIdentity, localMint = false, platformGrant?: PlatformGrantAuthority): ToolIdentityOutcome => {
    if (!publicationValid(validateBeforeWrite)) return { tool, state: 'off' };
    const stamped = withMeegoStore({ ...identity, ...(turnId ? { turnId } : {}), openId: senderOpenId }, policy);
    if (platformGrant && turnId && storageModel === 'proven') {
      writeProvenPlatformIdentity({
        sessionDataDir, sessionId, botConfig, turnId, senderOpenId, validateBeforeWrite,
      }, stamped, platformGrant);
    } else {
      writeSessionIdentity(sessionDataDir, sessionId, stamped, storageModel);
    }
    if (localMint && turnId && storageModel === 'proven' && stamped.tool === 'bytedcli' && !('mode' in stamped)) {
      trackBytedcliIdentityRenewal({
        sessionDataDir, sessionId, credentialOpenId: senderOpenId, identity: { ...stamped, turnId }, validateBeforeWrite,
      });
    }
    return { tool, state: 'user' };
  };

  // Credential source matrix (docs/lark-tool-identity.md, 凭据来源) — the facts
  // are gathered here, the decision is resolveIdentity's:
  //   local            → this machine's per-person HOME only.
  //   auto, unbound    → same as local, including auto-starting a local login.
  //   auto, bound      → platform grant or a refusal that has the platform send
  //                      the person its authorization card; local is never consulted.
  //   platform         → platform grant or refusal; local is never consulted.
  const { platform, local, decision } = await gatherCredentials(tool, botConfig, policy, senderOpenId, sessionId, turnId);
  if (decision.kind === 'person') {
    if (decision.source !== 'platform') return publish(local!, true);
    const grant = platform as Extract<PlatformIdentityResolution, { state: 'granted' }>;
    return publish(grant.identity, false, grant);
  }
  if (decision.entry === 'private-link') return await withheld();

  const refusal = platform as Exclude<PlatformIdentityResolution, { state: 'granted' }>;
  // Proven model only: the wrapper asks the daemon on every invocation, so
  // a refusal that can change during the turn (the platform was down, or
  // the person has not authorized yet) can be re-asked there (see
  // retryTransientTurnIdentity).
  const retryable = (refusal.state === 'unavailable' || (refusal.state === 'not_authorized' && !isUnattendedIdentityTurnId(turnId)))
    && !!turnId && storageModel === 'proven';
  const outcome = refuseViaPlatform(tool, botConfig, sessionDataDir, sessionId, senderOpenId, locale, turnId, storageModel, refusal, retryable);
  if (retryable) {
    rememberTransientRefusal({
      source: 'platform',
      botConfig, tool, sessionDataDir, sessionId, senderOpenId, locale, turnId: turnId!, validateBeforeWrite,
      ...refusalKindOf(refusal as Extract<PlatformIdentityResolution, { state: 'unavailable' | 'not_authorized' }>),
    });
  }
  return outcome;
}

/** The credential facts for one person and tool, and the matrix's verdict on them. */
async function gatherCredentials(
  tool: TriggerUserAuthTool,
  botConfig: BotConfig,
  policy: IdentityPolicy,
  openId: string,
  sessionId: string,
  turnId?: string,
) {
  const source = policy.credentialSource;
  const platform = source !== 'local'
    ? await resolvePlatformIdentity({ botConfig, tool, openId, sessionId, ...(turnId ? { turnId } : {}) })
    : undefined;
  const granted = platform?.state === 'granted';
  const platformBound = !!platform && platform.state !== 'unbound';
  const local = (source === 'local' || (source === 'auto' && !platformBound)) && !granted
    ? await resolveIdentityFor(tool, botConfig, openId) : null;
  const decision = resolveIdentity(source, {
    platformBound,
    platformGrant: granted,
    localLogin: !!local,
  });
  return { platform, local, decision };
}

interface PlatformGrantContext {
  sessionDataDir: string;
  sessionId: string;
  turnId: string;
  botConfig: BotConfig;
  senderOpenId: string;
  validateBeforeWrite?: () => boolean;
}

interface RegionalGrantAttempt {
  count: number;
  retryAfter: number;
  inFlight?: Promise<void>;
}

type PlatformGrantAuthority = Pick<Extract<PlatformIdentityResolution, { state: 'granted' }>, 'unionId' | 'bindingKey'>;

type DefaultGrantFailure = 'unavailable' | 'not_authorized' | 'consent_missing' | 'denied';

interface PlatformBytedcliPublication extends PlatformGrantContext, PlatformGrantAuthority {
  identity: BytedCliIdentity;
  snapshot: ProvenIdentitySnapshot;
  authEpoch: number;
  attempts: Map<BytedcliOverseasRegion, RegionalGrantAttempt>;
  renewal: { retryAfter: number; inFlight?: Promise<void>; inFlightForced?: boolean; failure?: DefaultGrantFailure };
}

// Once a publication is superseded, revoked or collected, its retry state
// follows it out of the proven store. Never retain a second cache of a turn's JWTs.
const platformBytedcliPublications = new WeakMap<ProvenIdentitySnapshot, PlatformBytedcliPublication>();
const PLATFORM_GRANT_RETRY_INTERVAL_MS = 10_000;
const REGIONAL_GRANT_MAX_ATTEMPTS = 2;

function writeProvenPlatformIdentity(
  context: PlatformGrantContext,
  identity: CliIdentity,
  grant: PlatformGrantAuthority,
): void {
  const { sessionDataDir, sessionId, turnId, senderOpenId } = context;
  if (identity.tool !== 'bytedcli' || 'mode' in identity
    || isUnattendedIdentityTurnId(turnId)) {
    writeSessionIdentity(sessionDataDir, sessionId, identity, 'proven');
    return;
  }
  const retryRegionalCloudJwts = identity.regionalCloudJwtSource === 'platform'
    && BYTEDCLI_OVERSEAS_REGIONS.some(region => !identity.regionalCloudJwts?.[region]);
  const shaped = publishedIdentityShape(sessionDataDir, sessionId, {
    ...identity, ...(retryRegionalCloudJwts ? { retryRegionalCloudJwts: true } : {}),
  });
  writeSessionIdentity(sessionDataDir, sessionId, shaped, 'proven');
  const snapshot = recallProvenIdentitySnapshot(sessionDataDir, sessionId, turnId, 'bytedcli')!;
  platformBytedcliPublications.set(snapshot, {
    ...context, snapshot, identity: shaped, unionId: grant.unionId, bindingKey: grant.bindingKey,
    authEpoch: readCliAuthEpoch(senderOpenId), attempts: new Map(), renewal: { retryAfter: 0 },
  });
}

interface RefreshPlatformGrantArgs {
  sessionDataDir: string;
  sessionId: string;
  turnId: string;
  speakerOpenId?: string;
  currentPolicy: () => TriggerUserAuthConfig | undefined;
  executionStillCurrent: () => boolean;
  waitMs: number;
}

function publishedPlatformBytedcli({ sessionDataDir, sessionId, turnId }: RefreshPlatformGrantArgs) {
  const snapshot = recallProvenIdentitySnapshot(sessionDataDir, sessionId, turnId, 'bytedcli');
  return snapshot && platformBytedcliPublications.get(snapshot);
}

function platformPublicationStillAllowed(entry: PlatformBytedcliPublication, args: RefreshPlatformGrantArgs): boolean {
  const { sessionDataDir, sessionId, turnId } = entry;
  if (recallProvenIdentitySnapshot(sessionDataDir, sessionId, turnId, 'bytedcli') !== entry.snapshot
    || readCliAuthEpoch(entry.senderOpenId) !== entry.authEpoch
    || activePlatformCredentialBindingKey() !== entry.bindingKey
    || getLarkToolDelegation(sessionDataDir, sessionId, turnId)
    || !publicationValid(entry.validateBeforeWrite) || !args.executionStillCurrent()) return false;
  const policy = args.currentPolicy();
  const effective = policyFromConfig(policy);
  return effective.capabilities.has('bytecloud') && effective.credentialSource !== 'local'
    && allowsPersonalIdentityForTurn(turnId, policy);
}

function replacePlatformBytedcliPublication(entry: PlatformBytedcliPublication, identity: BytedCliIdentity): void {
  const { sessionDataDir, sessionId, turnId } = entry;
  writeSessionIdentity(sessionDataDir, sessionId, identity, 'proven');
  const replacement = recallProvenIdentitySnapshot(sessionDataDir, sessionId, turnId, 'bytedcli')!;
  platformBytedcliPublications.delete(entry.snapshot);
  entry.snapshot = replacement;
  entry.identity = identity;
  platformBytedcliPublications.set(replacement, entry);
}

async function waitForPlatformGrant(attempt: Promise<void> | undefined, waitMs: number): Promise<void> {
  if (!attempt || waitMs <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([attempt, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
  clearTimeout(timer);
}

function bytecloudJwtExpiry(jwt: string): number | undefined {
  const exp = jwtClaims(jwt)?.exp;
  return typeof exp === 'number' && Number.isFinite(exp * 1_000) ? exp * 1_000 : undefined;
}

/** Re-ask the original platform for an expired default ByteCloud credential.
 * Only a live, later-expiring JWT can replace it. Keep regional, Codebase and
 * Meego fields from the latest publication, including any concurrent regional fill. */
export async function refreshExpiredPlatformBytedcliDefault(
  args: RefreshPlatformGrantArgs & { region?: 'default' | 'cn'; force?: boolean },
): Promise<'untracked' | 'ready' | 'superseded' | DefaultGrantFailure> {
  const entry = publishedPlatformBytedcli(args);
  if (!entry) return 'untracked';
  const stillAllowed = () => args.speakerOpenId === entry.senderOpenId && platformPublicationStillAllowed(entry, args);
  if (!publicationValid(stillAllowed)) return 'superseded';
  const originalRegion = jwtClaims(entry.identity.cloudJwt)?.region;
  // CN can use the default JWT only when there is no dedicated CN ticket.
  if (args.region === 'cn' && (entry.identity.regionalCloudJwts?.cn || originalRegion !== 'cn')) return 'untracked';
  const expiresAt = bytecloudJwtExpiry(entry.identity.cloudJwt);
  if (expiresAt === undefined || expiresAt > Date.now()) return 'ready';

  const attempt = entry.renewal;
  const waitDeadline = Date.now() + args.waitMs;
  let startedAttempt = false;
  while (true) {
    const waitMs = waitDeadline - Date.now();
    if (!attempt.inFlight && waitMs > 0 && ((args.force && !startedAttempt) || Date.now() >= attempt.retryAfter)) {
      startedAttempt = true;
      attempt.failure = undefined;
      attempt.inFlightForced = args.force === true;
      attempt.inFlight = (async () => {
        const grant = await resolvePlatformIdentity({
          botConfig: entry.botConfig, tool: 'bytedcli', unionId: entry.unionId,
          sessionId: entry.sessionId, turnId: entry.turnId, cloudJwtRegions: [],
        });
        if (!stillAllowed()) return;
        if (grant.state !== 'granted') {
          attempt.failure = grant.state === 'not_authorized'
            ? grant.consent ? 'consent_missing' : 'not_authorized'
            : grant.state === 'denied' ? grant.state : 'unavailable';
          return;
        }
        if (grant.bindingKey !== entry.bindingKey || grant.identity.tool !== 'bytedcli') return;
        const nextJwt = grant.identity.cloudJwt;
        if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(nextJwt)
          || (typeof originalRegion === 'string' && jwtClaims(nextJwt)?.region !== originalRegion)) return;
        const nextExpiry = bytecloudJwtExpiry(nextJwt);
        const now = Date.now();
        if (nextExpiry === undefined || nextExpiry <= Math.max(now, expiresAt) || grant.expiresAt <= now) return;
        replacePlatformBytedcliPublication(entry, { ...entry.identity, cloudJwt: nextJwt });
      })().catch(() => {
        logger.warn('[trigger-user-auth] could not renew the turn\'s default ByteCloud JWT');
      }).finally(() => {
        attempt.retryAfter = Date.now() + PLATFORM_GRANT_RETRY_INTERVAL_MS;
        attempt.inFlight = undefined;
      });
    }
    const joinedAttempt = attempt.inFlight;
    const joinedForced = joinedAttempt ? attempt.inFlightForced : false;
    await waitForPlatformGrant(joinedAttempt, waitMs);
    if (!publicationValid(stillAllowed)) return 'superseded';
    const updatedExpiry = bytecloudJwtExpiry(entry.identity.cloudJwt);
    if (updatedExpiry !== undefined && updatedExpiry > Date.now()) return 'ready';
    // A ready-authorized caller that joined an older ordinary attempt gets one
    // forced attempt of its own after that stale refusal. Callers that joined
    // an already-forced attempt share its result instead of forcing in series.
    if (args.force && !startedAttempt && joinedAttempt && !joinedForced
      && !attempt.inFlight && waitDeadline - Date.now() > 0) continue;
    return attempt.failure ?? 'unavailable';
  }
}

/** Refresh one missing partition for the already-proven speaker. Concurrent
 * calls for a partition share a grant. Distinct partitions merge into the
 * same publication without replacing any of the original credentials. */
export async function retryMissingRegionalGrant(args: RefreshPlatformGrantArgs & { region: BytedcliOverseasRegion }): Promise<void> {
  const { sessionId, turnId, region } = args;
  const entry = publishedPlatformBytedcli(args);
  if (!entry || !entry.identity.retryRegionalCloudJwts || entry.identity.regionalCloudJwts?.[region]
    || (args.speakerOpenId !== undefined && args.speakerOpenId !== entry.senderOpenId)) return;
  const state = entry.identity.regionalCloudJwtStates?.[region];
  if (state === 'not_authorized' || state === 'reauth_required' || state === 'retry_exhausted') return;

  const stillAllowed = () => platformPublicationStillAllowed(entry, args);
  if (!publicationValid(stillAllowed)) return;
  let attempt = entry.attempts.get(region);
  if (!attempt) {
    attempt = { count: 0, retryAfter: 0 };
    entry.attempts.set(region, attempt);
  }
  const active = attempt;
  const commit = (identity: BytedCliIdentity) => replacePlatformBytedcliPublication(entry, identity);
  const commitExhausted = () => {
    if (active.count < REGIONAL_GRANT_MAX_ATTEMPTS || entry.identity.regionalCloudJwts?.[region]) return;
    const state = entry.identity.regionalCloudJwtStates?.[region];
    if (state === 'retry_exhausted' || state === 'not_authorized' || state === 'reauth_required') return;
    if (!publicationValid(stillAllowed)) return;
    // The retry flag is shared by all regions. Keep it for their remaining
    // attempts and mark only this exhausted region terminal. This local cleanup
    // is retryable: a policy change may have suppressed the request's finally.
    try {
      commit({
        ...entry.identity,
        regionalCloudJwtStates: { ...entry.identity.regionalCloudJwtStates, [region]: 'retry_exhausted' },
      });
    } catch { /* keep the old identity; a later capped call can retry this cleanup */ }
  };
  if (!active.inFlight) {
    if (active.count >= REGIONAL_GRANT_MAX_ATTEMPTS) {
      commitExhausted();
      return;
    }
    if (Date.now() < active.retryAfter) return;
    active.count++;
    active.inFlight = (async () => {
      const grant = await resolvePlatformIdentity({
        botConfig: entry.botConfig, tool: 'bytedcli', unionId: entry.unionId,
        sessionId, turnId, cloudJwtRegions: [region],
      });
      if (grant.state !== 'granted' || grant.bindingKey !== entry.bindingKey || grant.identity.tool !== 'bytedcli' || !stillAllowed()) return;
      const jwt = grant.identity.regionalCloudJwts?.[region];
      const reportedState = grant.identity.regionalCloudJwtStates?.[region];
      const nextState = jwt ? 'minted'
        : reportedState === 'not_authorized' || reportedState === 'reauth_required' ? reportedState
          : active.count >= REGIONAL_GRANT_MAX_ATTEMPTS ? 'retry_exhausted'
            : reportedState === 'minted' ? 'failed' : reportedState;
      if (!jwt && !nextState) return;
      // Read the latest identity at commit: another partition may have
      // finished while this request was in flight.
      const merged: BytedCliIdentity = {
        ...entry.identity,
        ...(jwt ? { regionalCloudJwts: { ...entry.identity.regionalCloudJwts, [region]: jwt } } : {}),
        regionalCloudJwtStates: { ...entry.identity.regionalCloudJwtStates, [region]: nextState },
      };
      commit(merged);
    })().catch(() => {
      logger.warn(`[trigger-user-auth] bytedcli regional grant retry failed for partition ${region}`);
    }).finally(() => {
      commitExhausted();
      active.retryAfter = Date.now() + PLATFORM_GRANT_RETRY_INTERVAL_MS;
      active.inFlight = undefined;
    });
  }
  await waitForPlatformGrant(active.inFlight, args.waitMs);
}

/** Gives a bytedcli identity the person's Meego store, only while Meego is a
 *  switched-on capability: with it off no store is created for the bot. */
function withMeegoStore<T extends CliIdentity>(identity: T, policy: IdentityPolicy): T {
  return identity.tool === 'bytedcli' && !('mode' in identity) && policy.capabilities.has('meego')
    ? { ...identity, ...meegoStoreShape(identity.openId) }
    : identity;
}

// ─── Transient platform refusals: give the turn's next call another chance ───
//
// A grant is fetched once when the turn is prepared. If the platform could not
// be reached at that moment, the refusal published for the turn used to stand
// for the whole turn, so one network blip spoiled every bytedcli / lark-cli
// call the turn made. For the proven model (the wrapper asks the daemon for
// each invocation) the daemon instead re-asks the platform when the wrapper
// next fetches that refusal — rate-limited, and only while the refusal it
// published is still what is in force (compare-and-set right before writing,
// so a newer publication or a revocation is never overwritten).
//
// Two refusals qualify, each on its own pace:
//  - `unavailable` (the platform could not be reached): first re-ask right
//    away, then at most once per TRANSIENT_REFUSAL_RETRY_INTERVAL_MS;
//  - `not_authorized` (incl. missing consent): the person can authorize on the
//    platform page while the turn runs, and the refusal tells them to then just
//    retry. Without a re-ask that retry could never succeed in the same turn:
//    the turn kept the refusal it began with, and a reply mid-turn is steered
//    into the running turn by Codex, so no new turn picks the grant up
//    (deepcoldy/botmux#3312). Re-asked at most once per
//    NOT_AUTHORIZED_RETRY_INTERVAL_MS, counted from the refusal itself.
// The other answers about the person (not a teammate, forbidden) are final for
// the turn.

/** Minimum spacing between re-asks for one turn/tool. The FIRST re-ask is not
 *  spaced: preparing the turn already waited out a full grant budget, and the
 *  agent's first tool call is usually the only one before it gives up. */
export const TRANSIENT_REFUSAL_RETRY_INTERVAL_MS = 10_000;
/** Longest a wrapper's identity fetch waits on a re-ask: long enough for the
 *  union_id lookup plus a whole grant, and inside the wrapper's own timeout
 *  (`GRANT_ROUTE_CLIENT_TIMEOUT_MS`). Past this the current refusal is served
 *  and the attempt finishes in the background for the next call. */
export const TRANSIENT_REFUSAL_WAIT_CAP_MS = GRANT_WAIT_CAP_MS;
/** Re-asks per turn/tool; an agent stuck in a retry loop cannot hammer the platform. */
export const TRANSIENT_REFUSAL_MAX_RETRIES = 5;
/** Spacing between re-asks of a "not authorized yet" refusal. Authorizing takes
 *  a person a while, and every re-ask is a grant request the platform records,
 *  so this is slower than the outage pace and the first one waits too. */
export const NOT_AUTHORIZED_RETRY_INTERVAL_MS = 30_000;
/** Re-asks per turn/tool of a "not authorized yet" refusal: with the spacing
 *  above, about ten minutes of a turn that keeps calling the tool. */
export const NOT_AUTHORIZED_MAX_RETRIES = 20;
/** Forget an entry after this long even if its turn's material is still held. */
const TRANSIENT_REFUSAL_TTL_MS = 2 * 60 * 60 * 1000;
const TRANSIENT_REFUSAL_MAX_ENTRIES = 1000;

type RetryableRefusalSource = 'platform' | 'local';
type RetryableRefusalKind = 'unavailable' | 'not_authorized';

/** Refusal reasons that {@link adoptLocalBytedcliAuthorization} may replace
 *  with the turn sender's freshly minted local ByteCloud identity. Policy,
 *  membership, unattended, and delegation denials are deliberately excluded. */
const LOCAL_ADOPTABLE_BYTEDCLI_REASONS = ['not_authorized', 'provider_unavailable'] as const;

function localCredentialSourceAllowed(policy: IdentityPolicy): boolean {
  return policy.credentialSource === 'local'
    || (policy.credentialSource === 'auto' && !platformAuthorizeUrl());
}

function stampedOpenIdOf(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const prefix = 'BOTMUX_IDENTITY_OPEN_ID=';
  for (const line of body.split('\n')) {
    if (!line.startsWith(prefix)) continue;
    const quoted = line.slice(prefix.length);
    if (quoted.length < 2 || !quoted.startsWith("'") || !quoted.endsWith("'")) return undefined;
    return quoted.slice(1, -1).replaceAll("'\\''", "'");
  }
  return undefined;
}

interface TransientRefusal {
  source: RetryableRefusalSource;
  botConfig: BotConfig;
  tool: TriggerUserAuthTool;
  /** Which refusal was published; decides the pace and what a re-ask may keep. */
  kind: RetryableRefusalKind;
  /** For `not_authorized`: whether it was the missing-consent variant. A re-ask
   *  that gets the other variant republishes, so the person reads the right step. */
  consent?: boolean;
  sessionDataDir: string;
  sessionId: string;
  senderOpenId: string;
  locale: Locale | undefined;
  turnId: string;
  /** The write fence of the publication that left this refusal; checked again
   *  right before a retry writes a granted credential. */
  validateBeforeWrite?: () => boolean;
  /** The refusal body this module published; the CAS token. */
  body: string;
  /** The person's local credential epoch when the refusal was published; a
   *  revocation (`/logout`, Dashboard revoke) bumps it and ends the re-asks. */
  authEpoch: number;
  createdAt: number;
  lastAttemptAt: number;
  retries: number;
  inFlight?: Promise<void>;
}

const transientRefusals = new Map<string, TransientRefusal>();

function refusalKindOf(
  platform: Extract<PlatformIdentityResolution, { state: 'unavailable' | 'not_authorized' }>,
): Pick<TransientRefusal, 'kind' | 'consent'> {
  return platform.state === 'not_authorized' ? { kind: 'not_authorized', consent: platform.consent } : { kind: 'unavailable' };
}

const retryIntervalOf = (entry: TransientRefusal) =>
  entry.kind === 'not_authorized' ? NOT_AUTHORIZED_RETRY_INTERVAL_MS : TRANSIENT_REFUSAL_RETRY_INTERVAL_MS;
const maxRetriesOf = (entry: TransientRefusal) =>
  entry.kind === 'not_authorized' ? NOT_AUTHORIZED_MAX_RETRIES : TRANSIENT_REFUSAL_MAX_RETRIES;

function transientKey(sessionDataDir: string, sessionId: string, turnId: string, tool: TriggerUserAuthTool): string {
  return JSON.stringify([sessionDataDir, sessionId, turnId, tool]);
}

function rememberTransientRefusal(entry: Omit<TransientRefusal, 'body' | 'authEpoch' | 'createdAt' | 'lastAttemptAt' | 'retries'>): void {
  const body = recallProvenIdentityContent(entry.sessionDataDir, entry.sessionId, entry.turnId, entry.tool);
  if (!body) return; // the refusal did not land; nothing to compare against
  const now = Date.now();
  const key = transientKey(entry.sessionDataDir, entry.sessionId, entry.turnId, entry.tool);
  transientRefusals.delete(key);
  transientRefusals.set(key, {
    ...entry, body, authEpoch: readCliAuthEpoch(entry.senderOpenId),
    // A platform outage is re-asked on the turn's first call; "not authorized yet"
    // and a local bytedcli outage start their cooldown from the refusal itself so
    // a fresh 30s local CLI timeout is not repeated immediately on the next second.
    createdAt: now,
    lastAttemptAt: (entry.kind === 'not_authorized' || entry.source === 'local') ? now : Number.NEGATIVE_INFINITY,
    retries: 0,
  });
  while (transientRefusals.size > TRANSIENT_REFUSAL_MAX_ENTRIES) {
    const oldest = transientRefusals.keys().next().value;
    if (oldest === undefined) break;
    transientRefusals.delete(oldest);
  }
}

/**
 * Called by the proven identity route before it serves a turn's identity. When
 * what is in force is a transient refusal this module published (platform outage,
 * platform "not authorized yet", or local `bytedcli` provider outage), ask the
 * credential source again and publish the answer if the refusal is still the
 * one in force. Each refusal keeps its own pace: a platform `unavailable`
 * refusal is re-asked right away and then at most once per
 * {@link TRANSIENT_REFUSAL_RETRY_INTERVAL_MS}; a local `bytedcli` `unavailable`
 * refusal waits {@link TRANSIENT_REFUSAL_RETRY_INTERVAL_MS} from the refusal
 * itself; a `not_authorized` refusal waits
 * {@link NOT_AUTHORIZED_RETRY_INTERVAL_MS} from the refusal itself. Concurrent
 * callers share one attempt; no caller waits longer than
 * {@link TRANSIENT_REFUSAL_WAIT_CAP_MS}. Never throws.
 *
 * `currentPolicy` — not `botConfig` — is what decides whether a re-ask may run
 * and whether its answer may be written: a bot policy changed mid-turn (tool no
 * longer governed, source switched away) ends the re-asks instead of
 * publishing under the policy the turn started with. `botConfig` is only the
 * fallback for a caller with no registry reader.
 */
export async function retryTransientTurnIdentity(args: {
  sessionDataDir: string;
  sessionId: string;
  turnId: string;
  tool: TriggerUserAuthTool;
  botConfig?: BotConfig;
  /** Reads the LIVE policy for this bot. Must be supplied by whoever holds the
   *  bot registry: a mid-turn Dashboard edit replaces the whole config object,
   *  so any snapshot (including `botConfig`) stays stale and would let an
   *  in-flight attempt publish under a policy the operator already left. */
  currentPolicy?: () => TriggerUserAuthConfig | undefined;
  /** Re-ask now even if the refusal's pacing interval has not passed (the platform just said the person lacks nothing). */
  force?: boolean;
}): Promise<void> {
  const key = transientKey(args.sessionDataDir, args.sessionId, args.turnId, args.tool);
  const entry = transientRefusals.get(key);
  if (!entry) return;
  if (!entry.inFlight) {
    const now = Date.now();
    if (!stillInForce(entry)
      || now - entry.createdAt > TRANSIENT_REFUSAL_TTL_MS
      || entry.retries >= maxRetriesOf(entry)
      || !policyStillWants(args.currentPolicy, entry, args.botConfig)) {
      transientRefusals.delete(key);
      return;
    }
    if (!args.force && now - entry.lastAttemptAt < retryIntervalOf(entry)) return;
    entry.lastAttemptAt = now;
    entry.retries++;
    entry.inFlight = runTransientRetry(key, entry, args.currentPolicy, args.botConfig)
      .finally(() => { entry.inFlight = undefined; });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    entry.inFlight,
    new Promise<void>(resolve => { timer = setTimeout(resolve, TRANSIENT_REFUSAL_WAIT_CAP_MS); }),
  ]);
  clearTimeout(timer);
}

/** The refusal this entry published is still what the turn has, and the
 *  person has not revoked their credentials since. */
function stillInForce(entry: TransientRefusal): boolean {
  return recallProvenIdentityContent(entry.sessionDataDir, entry.sessionId, entry.turnId, entry.tool) === entry.body
    && readCliAuthEpoch(entry.senderOpenId) === entry.authEpoch;
}

/** Does the bot's policy — read NOW, not when the refusal was published — still
 *  take this tool's credentials from the entry's source?
 *
 *  Dashboard writes replace the whole bot config object
 *  (`bots.set(appId, { config: cfg, … })`), so a snapshot taken at publication
 *  time (the entry's `botConfig`) can never observe a mid-turn edit: only a
 *  reader supplied by whoever holds the registry can.
 *
 *  A reader that throws means the bot is gone; that is "no longer governed", so
 *  the re-ask stops rather than publishing under a policy nobody stated. */
function policyStillWants(
  live: (() => TriggerUserAuthConfig | undefined) | undefined,
  entry: TransientRefusal,
  fallbackConfig: BotConfig | undefined,
): IdentityPolicy | undefined {
  let policy: TriggerUserAuthConfig | undefined;
  if (live) {
    try { policy = live(); } catch { return undefined; }
  } else {
    policy = (fallbackConfig ?? entry.botConfig).triggerUserAuth;
  }
  const current = policyFromConfig(policy);
  if (!current.capabilities.has(capabilityOfTool(entry.tool))) return undefined;
  return entry.source === 'local'
    ? (localCredentialSourceAllowed(current) ? current : undefined)
    : (current.credentialSource !== 'local' ? current : undefined);
}

function localBytedcliPolicy(
  live: (() => TriggerUserAuthConfig | undefined) | undefined,
  fallbackConfig: BotConfig,
): IdentityPolicy | undefined {
  let policy: TriggerUserAuthConfig | undefined;
  if (live) {
    try { policy = live(); } catch { return undefined; }
  } else {
    policy = fallbackConfig.triggerUserAuth;
  }
  const current = policyFromConfig(policy);
  return current.capabilities.has('bytecloud') && localCredentialSourceAllowed(current) ? current : undefined;
}

async function runLocalTransientRetry(
  key: string,
  entry: TransientRefusal,
  live: (() => TriggerUserAuthConfig | undefined) | undefined,
  fallbackConfig: BotConfig | undefined,
  drop: () => void,
): Promise<void> {
  try {
    const identity = await resolveIdentityFor(entry.tool, entry.botConfig, entry.senderOpenId);
    // Compare-and-set: synchronous from here to the write.
    const wanted = policyStillWants(live, entry, fallbackConfig);
    if (transientRefusals.get(key) !== entry || !stillInForce(entry) || !wanted || !publicationValid(entry.validateBeforeWrite)) {
      drop();
      return;
    }
    if (identity) {
      const stamped = withMeegoStore(
        { ...identity, turnId: entry.turnId, openId: entry.senderOpenId },
        wanted,
      );
      writeSessionIdentity(entry.sessionDataDir, entry.sessionId, stamped, 'proven');
      if (stamped.tool === 'bytedcli' && !('mode' in stamped)) {
        trackBytedcliIdentityRenewal({
          sessionDataDir: entry.sessionDataDir, sessionId: entry.sessionId,
          credentialOpenId: entry.senderOpenId, identity: { ...stamped, turnId: entry.turnId },
          validateBeforeWrite: entry.validateBeforeWrite,
        });
      }
      drop();
      logger.info(`[trigger-user-auth] local ${entry.tool} identity recovered for session ${entry.sessionId} on retry`);
      return;
    }
    // The local provider is reachable again and definitively reports that this
    // person has no active authorization: replace the outage refusal with the
    // ordinary refusal so the wrapper/user sees the right next step.
    if (isUnattendedIdentityTurnId(entry.turnId)) {
      denyUnattended(entry.tool, entry.botConfig, entry.sessionDataDir, entry.sessionId,
        entry.senderOpenId, entry.locale, entry.turnId, 'proven');
    } else {
      writeDenial(entry.sessionDataDir, entry.sessionId, entry.tool, entry.senderOpenId,
        entry.botConfig, entry.locale, entry.turnId, 'proven', undefined, undefined, 'not_authorized');
    }
    drop();
  } catch (e) {
    // Anchor the next cooldown to when the failed CLI call finished, so a 30s
    // timeout cannot immediately trigger another 30s timeout on the next call.
    entry.lastAttemptAt = Date.now();
    logger.warn(`[trigger-user-auth] local retry of ${entry.tool} identity failed for session ${entry.sessionId}: `
      + `${e instanceof Error ? e.message : String(e)}`);
  }
}

async function runTransientRetry(
  key: string,
  entry: TransientRefusal,
  live: (() => TriggerUserAuthConfig | undefined) | undefined,
  fallbackConfig: BotConfig | undefined,
): Promise<void> {
  // Only ever drop THIS entry: a republication of the same turn registers a
  // fresh one under the same key, which an older attempt must not erase.
  const drop = () => { if (transientRefusals.get(key) === entry) transientRefusals.delete(key); };
  if (entry.source === 'local') {
    await runLocalTransientRetry(key, entry, live, fallbackConfig, drop);
    return;
  }
  try {
    const platform = await resolvePlatformIdentity({
      botConfig: entry.botConfig, tool: entry.tool, openId: entry.senderOpenId,
      sessionId: entry.sessionId, turnId: entry.turnId,
    });
    // Compare-and-set: synchronous from here to the write. The policy check
    // belongs INSIDE this window: the attempt took a whole grant budget, and an
    // operator switching this bot to local credentials (or turning the tool off)
    // during it must not end with platform credentials on disk.
    const wanted = policyStillWants(live, entry, fallbackConfig);
    if (transientRefusals.get(key) !== entry || !stillInForce(entry) || !wanted) {
      drop();
      return;
    }
    if (platform.state === 'granted') {
      // The publication fence of the original publication decides again: a person
      // turn whose person lost access meanwhile gets no credential, only the refusal.
      if (!publicationValid(entry.validateBeforeWrite)) {
        drop();
        return;
      }
      writeProvenPlatformIdentity(entry, withMeegoStore(
        { ...platform.identity, turnId: entry.turnId, openId: entry.senderOpenId },
        wanted), platform);
      drop();
      logger.info(`[trigger-user-auth] platform ${entry.tool} grant recovered for session ${entry.sessionId} on retry`);
      return;
    }
    if (platform.state === 'unavailable') return; // keep the refusal; retry later
    if (platform.state === 'not_authorized' && entry.kind === 'not_authorized' && platform.consent === entry.consent) {
      return; // still the same refusal: they have not authorized yet; ask again later
    }
    if (platform.state === 'unbound') {
      // Unbound mid-turn: what applies now depends on the source (auto falls
      // back to local logins) and is the next turn's decision. Keep the
      // refusal the turn has; stop asking a platform that is gone.
      drop();
      return;
    }
    // The platform now answered about the person: publish that answer. A "not
    // authorized yet" answer stays re-askable (now on its own pace); the other
    // answers about the person are final for the turn.
    refuseViaPlatform(entry.tool, entry.botConfig, entry.sessionDataDir, entry.sessionId, entry.senderOpenId,
      entry.locale, entry.turnId, 'proven', platform);
    drop();
    if (platform.state === 'not_authorized' && !isUnattendedIdentityTurnId(entry.turnId)) {
      const { botConfig, tool, sessionDataDir, sessionId, senderOpenId, locale, turnId, validateBeforeWrite } = entry;
      rememberTransientRefusal({
        source: 'platform',
        botConfig, tool, sessionDataDir, sessionId, senderOpenId, locale, turnId, validateBeforeWrite, ...refusalKindOf(platform),
      });
    }
  } catch (e) {
    logger.warn(`[trigger-user-auth] retry of ${entry.tool} identity failed for session ${entry.sessionId}: `
      + `${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The person finished a local ByteCloud login (or the local bytedcli provider
 * recovered from a transient outage) while this turn runs: replace the turn's
 * adoptable refusal (`not_authorized` or `provider_unavailable`) with their
 * identity so the retry of the refused command succeeds in this turn.
 *
 * Returns `'none'` (leaving the turn as is) when the turn does not hold an
 * adoptable refusal, belongs to another principal/delegation/unattended run,
 * or the person definitely has no local login; returns `'superseded'` when a
 * live policy, delegation, credential epoch, or published snapshot changed
 * around the mint; returns `'unavailable'` when minting fails transiently so
 * the caller does not report ready or throw HTTP 500.
 */
export async function adoptLocalBytedcliAuthorization(args: {
  sessionDataDir: string;
  sessionId: string;
  turnId: string;
  botConfig: BotConfig;
  senderOpenId: string;
  currentPolicy?: () => TriggerUserAuthConfig | undefined;
}): Promise<AdoptResult> {
  const { sessionDataDir, sessionId, turnId, botConfig, senderOpenId, currentPolicy } = args;
  if (isUnattendedIdentityTurnId(turnId) || getLarkToolDelegation(sessionDataDir, sessionId, turnId)) {
    return 'none';
  }
  const initialPolicy = localBytedcliPolicy(currentPolicy, botConfig);
  // With no live reader this is simply a caller whose static policy is not
  // locally adoptable. A live reader, however, means the request's config was
  // already superseded (or can no longer be read): never promise next-turn use.
  if (!initialPolicy) return currentPolicy ? 'superseded' : 'none';
  const before = recallProvenIdentityContent(sessionDataDir, sessionId, turnId, 'bytedcli');
  const stampedOwner = stampedOpenIdOf(before);
  if (stampedOwner && stampedOwner !== senderOpenId) return 'none';
  if (before?.includes("BOTMUX_IDENTITY_MODE='user'")) return 'already';
  if (!hasReason(before, LOCAL_ADOPTABLE_BYTEDCLI_REASONS)) return 'none';
  const epochBefore = readCliAuthEpoch(senderOpenId);
  let identity: CliIdentity | null;
  try {
    identity = await resolveIdentityFor('bytedcli', botConfig, senderOpenId);
  } catch (e) {
    logger.warn(
      `[trigger-user-auth] could not adopt local bytedcli identity for session ${sessionId}: `
      + `${e instanceof Error ? e.message : String(e)}`,
    );
    return 'unavailable';
  }
  const after = recallProvenIdentityContent(sessionDataDir, sessionId, turnId, 'bytedcli');
  const livePolicy = localBytedcliPolicy(currentPolicy, botConfig);
  if (!livePolicy || getLarkToolDelegation(sessionDataDir, sessionId, turnId)) return 'superseded';
  if (readCliAuthEpoch(senderOpenId) !== epochBefore) return 'superseded';
  if (after !== before) {
    // Another concurrent adoption or local transient retry already installed
    // this same person's identity for this turn.
    if (after?.includes("BOTMUX_IDENTITY_MODE='user'") && stampedOpenIdOf(after) === senderOpenId) {
      return 'already';
    }
    return 'superseded';
  }
  if (!identity) return 'none';
  const stamped = withMeegoStore({ ...identity, turnId, openId: senderOpenId }, livePolicy);
  writeSessionIdentity(sessionDataDir, sessionId, stamped, 'proven');
  transientRefusals.delete(transientKey(sessionDataDir, sessionId, turnId, 'bytedcli'));
  if (stamped.tool === 'bytedcli' && !('mode' in stamped)) {
    trackBytedcliIdentityRenewal({ sessionDataDir, sessionId, credentialOpenId: senderOpenId, identity: stamped });
  }
  return 'adopted';
}

/**
 * - `adopted`: the turn's refusal was replaced with the person's identity.
 * - `already`: the turn already holds the person's identity, so there is nothing to take up.
 * - `unavailable`: minting the turn's personal JWT failed transiently; do not report ready.
 * - `superseded`: policy, delegation, credential epoch, or the published snapshot changed around the mint.
 * - `none`: the turn does not hold an adoptable refusal, or the person definitely has no local login.
 */
export type AdoptResult = 'adopted' | 'already' | 'none' | 'unavailable' | 'superseded';

/** @internal test-only */
export function __resetTransientRefusalsForTest(): void {
  transientRefusals.clear();
}

/**
 * The refusal a bound machine publishes: it names the platform, not a local
 * device login, as the way to authorize. `unavailable` is reported as such so
 * the agent stops retrying instead of asking the person to authorize again.
 */
function refuseViaPlatform(
  tool: TriggerUserAuthTool,
  botConfig: BotConfig,
  sessionDataDir: string,
  sessionId: string,
  senderOpenId: string,
  locale: Locale | undefined,
  turnId: string | undefined,
  storageModel: IdentityStorageModel,
  platform: Exclude<PlatformIdentityResolution, { state: 'granted' }>,
  /** The daemon will re-ask on the turn's next call (proven model). */
  retryable = false,
): ToolIdentityOutcome {
  if (platform.state === 'not_authorized' && isUnattendedIdentityTurnId(turnId)) {
    return denyUnattended(tool, botConfig, sessionDataDir, sessionId, senderOpenId, locale, turnId, storageModel);
  }
  const provider = tool === 'bytedcli' ? 'ByteCloud' : t('trigger_user_auth.provider_lark', undefined, locale);
  const vars = { tool, provider };
  let tail: string[];
  let state: ToolIdentityOutcome['state'] = 'needs-authorization';
  switch (platform.state) {
    case 'unbound':
      tail = [t('trigger_user_auth.denied_platform_unbound', vars, locale)];
      break;
    case 'not_authorized':
      tail = [t(platform.consent ? 'trigger_user_auth.denied_platform_consent' : 'trigger_user_auth.denied_platform_login', vars, locale)];
      break;
    case 'denied':
      tail = [platform.reason === 'not_teammate'
        ? t('trigger_user_auth.denied_platform_not_teammate', vars, locale)
        : t('trigger_user_auth.denied_platform_forbidden', { ...vars, detail: platform.detail }, locale)];
      break;
    case 'unavailable':
      tail = [t(retryable
        ? 'trigger_user_auth.denied_platform_unavailable_retryable'
        : 'trigger_user_auth.denied_platform_unavailable', vars, locale)];
      state = 'unavailable';
      break;
  }
  writeDenial(sessionDataDir, sessionId, tool, senderOpenId, botConfig, locale, turnId, storageModel, undefined, tail,
    platformRefusalReason(platform));
  return { tool, state };
}

/** The refusal of an unattended turn whose person lacks credentials: it carries no link, because the wrapper asks the daemon for the private notice. */
function denyUnattended(
  tool: TriggerUserAuthTool, botConfig: BotConfig, sessionDataDir: string, sessionId: string,
  senderOpenId: string | undefined, locale: Locale | undefined, turnId: string | undefined, storageModel: IdentityStorageModel,
): ToolIdentityOutcome {
  writeDenial(sessionDataDir, sessionId, tool, senderOpenId, botConfig, locale, turnId, storageModel,
    undefined, undefined, 'unattended');
  return { tool, state: 'needs-authorization' };
}

/**
 * What "no usable credentials for this turn's sender" resolves to.
 *
 * The one place that decision is made, so every route into it — no sender, no
 * token, a store outage — lands on the same identity.
 *
 * Neither outcome can be expressed by deleting the file. The wrapper reads an
 * absent file as a refusal, so running as the bot has to be published
 * explicitly (with app id + secret; lark-cli given nothing picks up the
 * operator's on-disk login instead). And a refusal is published too, because it
 * carries the text the refused person reads.
 */
async function withholdIdentity(
  tool: TriggerUserAuthTool,
  botConfig: BotConfig,
  sessionDataDir: string,
  sessionId: string,
  senderOpenId: string | undefined,
  locale: Locale | undefined,
  turnId: string | undefined,
  storageModel: IdentityStorageModel,
  privateChat: boolean,
): Promise<ToolIdentityOutcome> {
  if (isUnattendedIdentityTurnId(turnId)) {
    return denyUnattended(tool, botConfig, sessionDataDir, sessionId, senderOpenId, locale, turnId, storageModel);
  }
  // Outside a 1:1 chat no link is minted for the agent: it would relay it into
  // the group. The refusal points at /login instead, whose reply goes to the
  // sender privately.
  if (!privateChat) {
    writeDenial(sessionDataDir, sessionId, tool, senderOpenId, botConfig, locale, turnId, storageModel,
      undefined, undefined, senderOpenId ? 'not_authorized' : 'no_sender');
    return { tool, state: 'needs-authorization' };
  }
  // Pre-fetch a ready, valid authorization link for either tool so the moment a
  // governed command is actually refused, the agent has a link to relay instead
  // of asking the person to type a command. Beginning only mints a link and
  // messages nobody, so non-CLI turns are not disturbed. Uses a fresh, still
  // unexpired challenge when one exists.
  let authUrl: string | undefined;
  if (senderOpenId) {
    try {
      authUrl = tool === 'bytedcli'
        ? (await beginBytedcliLogin(senderOpenId))?.authUrl
        : (await beginLarkCliLogin(senderOpenId))?.authUrl;
      if (tool === 'bytedcli' && !authUrl) throw new Error('bytedcli login provider unavailable');
    } catch (e) {
      if (tool === 'bytedcli') throw e;
      logger.warn(
        `[trigger-user-auth] could not pre-fetch ${tool} auth link for session ${sessionId}: `
        + `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  writeDenial(sessionDataDir, sessionId, tool, senderOpenId, botConfig, locale, turnId, storageModel, authUrl,
    undefined, senderOpenId ? 'not_authorized' : 'no_sender');
  return { tool, state: 'needs-authorization' };
}

/**
 * Publish a refusal the wrapper prints verbatim on stderr.
 *
 * Names the person whose authorization is missing when we know it, and always
 * says how to supply it. Without the "how", someone whose command just failed
 * has no way to discover that /login is the answer — they retry, fail again,
 * and conclude the bot is broken.
 *
 * Best-effort by construction: if this write fails the file stays absent, which
 * the wrapper also reads as a denial. Safety does not depend on it landing —
 * only the quality of the message does.
 */
function writeDenial(
  sessionDataDir: string,
  sessionId: string,
  tool: TriggerUserAuthTool,
  senderOpenId: string | undefined,
  botConfig: BotConfig,
  locale: Locale | undefined,
  turnId: string | undefined,
  storageModel: IdentityStorageModel,
  authUrl?: string,
  /** Replaces the local-login tail (auto-link or /login how-to) when the
   *  authorization lives elsewhere — e.g. on the central platform. */
  tailOverride?: string[],
  /** Machine-readable cause, printed as the last line (`[reason=…]`). */
  reason?: string,
): void {
  if (reason === 'unattended') {
    // Nobody is here to authorize: no link, no how-to, just the state and what ends it.
    try {
      writeSessionIdentity(sessionDataDir, sessionId, {
        tool, mode: 'denied', ...(turnId ? { turnId } : {}), ...(senderOpenId ? { openId: senderOpenId } : {}),
        message: `${t('trigger_user_auth.denied_unattended', { capability: capabilityOfTool(tool) }, locale)}\n${reasonTag('unattended')}`,
      }, storageModel);
    } catch { clearSessionIdentity(sessionDataDir, sessionId, tool, turnId, storageModel); }
    return;
  }
  try {
    const name = senderOpenId && botConfig.larkAppId
      // Brand matters: the lookup checks it, so a Lark-brand bot with the
      // default 'feishu' finds nothing and the refusal loses the person's name.
      ? lookupAuthorizedUserName(botConfig.larkAppId, senderOpenId, normalizeBrand(botConfig.brand))
      : undefined;
    // Name the right provider. bytedcli authenticates against ByteCloud, so
    // saying "Feishu authorization" would send the reader to authorize the
    // wrong thing — the same mistake as naming the wrong /login command.
    const provider = tool === 'bytedcli'
      ? 'ByteCloud'
      : t('trigger_user_auth.provider_lark', undefined, locale);
    // With no name, address the reader directly rather than printing a raw
    // open_id at them. The name comes from a stored Lark token, which someone
    // being refused for lack of authorization usually does not have — so the
    // nameless case is the COMMON one here, not an edge case, and `「ou_5f3a…」
    // 本人` reads as a machine talking to itself.
    const head = !senderOpenId
      ? t('trigger_user_auth.denied_anonymous', { tool, provider }, locale)
      : name
        ? t('trigger_user_auth.denied_known_user', { name, tool, provider }, locale)
        : t('trigger_user_auth.denied_you', { tool, provider }, locale);
    writeSessionIdentity(sessionDataDir, sessionId, {
      tool,
      mode: 'denied',
      ...(turnId ? { turnId } : {}),
      ...(senderOpenId ? { openId: senderOpenId } : {}),
      message: [
        head,
        // A ready device-code link for either tool: lead with the self-serve,
        // one-tap instruction and a clear "authorize once" framing so it reads
        // as "one step left", not as a broken bot. Without a link (fetch failed
        // or no human sender), fall back to the /login instructions.
        ...(tailOverride ? tailOverride : authUrl
          ? [
              t('trigger_user_auth.denied_auto_login', { tool, provider }, locale),
              authUrl,
              t('trigger_user_auth.denied_auto_retry', undefined, locale),
            ]
          : [t(
              'trigger_user_auth.denied_howto',
              { command: tool === 'bytedcli' ? '/login bytedcli' : '/login' },
              locale,
            ),
            t('trigger_user_auth.denied_howto_status', undefined, locale)]),
        ...(reason ? [reasonTag(reason)] : []),
      ].join('\n'),
    }, storageModel);
  } catch (e) {
    clearSessionIdentity(sessionDataDir, sessionId, tool, turnId, storageModel);
    logger.debug(
      `[trigger-user-auth] could not publish the ${tool} denial (absent file denies too): `
      + `${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function resolveIdentityFor(
  tool: TriggerUserAuthTool,
  botConfig: BotConfig,
  senderOpenId: string,
): Promise<CliIdentity | null> {
  if (tool === 'lark-cli') {
    // Preferred path: the per-person HOME created by the lark-cli device-code
    // flow. lark-cli then acts as that person using the provisioned app bound
    // inside that HOME — no token is injected into the environment, and the
    // acting identity is a directory isolated per sender (mirrors bytedcli).
    // No appId is passed: the HOME's own lark-cli config already names the app.
    //
    // The resolver polls a pending device login once before deciding: a browser
    // approval writes nothing locally, so without that poll "tap the link, then
    // retry" could never succeed on the turn path.
    const home = await resolveLarkCliHomeForTurn(senderOpenId);
    if (home) {
      return { tool: 'lark-cli', mode: 'user-home', home };
    }
    // Back-compat: a bot-app OAuth user token already stored server-side.
    if (!botConfig.larkAppId || !botConfig.larkAppSecret) return null;
    const token = await resolveUserToken(
      botConfig.larkAppId,
      botConfig.larkAppSecret,
      normalizeBrand(botConfig.brand),
      senderOpenId,
    );
    if (!token) return null;
    // The app id travels with the token: lark-cli refuses a token without it
    // ("blocked by env: …USER_ACCESS_TOKEN is set but …APP_ID is missing").
    return { tool: 'lark-cli', appId: botConfig.larkAppId, userAccessToken: token };
  }

  // bytedcli authenticates against ByteCloud SSO, a different provider from
  // Lark OAuth — a Lark user token is not convertible into a ByteCloud JWT. So
  // this person's credentials come from their own bytedcli login, minted fresh
  // per turn: the ByteCloud JWT lives ~2 hours while the login behind it lives
  // ~3 weeks, and bytedcli refreshes it internally, so asking each time is what
  // keeps people from being sent back to a QR code every couple of hours.
  //
  // Null when they have not authorized (or their login has ended), which the
  // caller turns into the ordinary "authorize, then retry" refusal rather than
  // falling back to the machine's own SSO session.
  const jwts = await mintBytedcliJwts(senderOpenId);
  if (!jwts) return null;
  return locallyMintedBytedcliIdentity(jwts);
}

/** The bytedcli identity for JWTs this machine minted from the person's login. */
function locallyMintedBytedcliIdentity(jwts: BytedcliJwts): BytedCliIdentity {
  return {
    tool: 'bytedcli',
    cloudJwt: jwts.cloudJwt,
    ...(jwts.codeJwt ? { codeJwt: jwts.codeJwt } : {}),
    ...(jwts.regionalCloudJwts ? { regionalCloudJwts: jwts.regionalCloudJwts } : {}),
    regionalCloudJwtSource: 'local',
  };
}
