/** Registered scheduled jobs may outlive a turn; a Unix UID is never a job credential. */
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { sandboxBoolValue } from '../adapters/cli/sandbox-mode.js';
import { getBot, type BotConfig } from '../bot-registry.js';
import { localeForBot } from '../i18n/index.js';
import { canOperate } from '../im/lark/event-dispatcher.js';
import * as scheduleStore from '../services/schedule-store.js';
import type { ScheduleAuthorityRecord } from '../services/schedule-authority-store.js';
import { isAutoCompletedSchedule } from '../services/schedule-until-done.js';
import * as sessionStore from '../services/session-store.js';
import { readCliAuthEpoch } from '../services/cli-auth-epoch.js';
import { readLinuxBootIdentity, readProcessStartIdentity } from '../utils/process-identity.js';
import { cleanupBackgroundJobHome } from '../services/bytedcli-home.js';
import { coordinationModeIsPrimary } from '../services/durable-coordination-runtime.js';
import type { Session } from '../types.js';
import { readIdentityLayout, recallProvenIdentityContent, forgetProvenIdentityContent } from './cli-identity.js';
import { attestCurrentExecutionLoopbackPeer, type ProcessIdentity } from './current-actor-attestation.js';
import { backgroundAuthorityKey, backgroundCredentialPolicyKey, backgroundPeerBelongsToJob, type BackgroundExecutionRegistration } from './background-execution-policy.js';
import { noteSenderUnionId } from './platform-credential-source.js';
import { resolveScheduledRunIdentity, type ScheduledRunIdentity } from './schedule-identity-claim.js';
import { parseScheduledTurnId } from './scheduled-turn-provenance.js';
import * as scheduler from './scheduler.js';
import { publishTurnCliIdentity } from './turn-cli-identity.js';
import { releaseActiveIdentityTurn } from './active-identity-turns.js';
import { larkTransportEnabled, type DaemonSession } from './types.js';
import { findActiveBySessionId, identityStorageModelForDaemonSession } from './worker-pool.js';

export type DetachedIdentityRouteTool = 'lark-cli' | 'bytedcli' | 'codebase';
export interface AuthorizedScheduledSessionContext {
  ds?: DaemonSession; session: Session; larkAppId: string; chatId: string; botConfig: BotConfig;
  scheduledTurnId: string; taskId: string; authority: ScheduleAuthorityRecord; runIdentity: ScheduledRunIdentity;
}
export interface RegisteredBackgroundContext extends AuthorizedScheduledSessionContext { job: BackgroundExecutionRegistration }
export const BACKGROUND_REGISTRATION_ROUTE = '/api/current-execution-background';
export const BACKGROUND_REVOKE_ROUTE = '/api/current-execution-background/revoke';
const inFlightPublishes = new Map<string, Promise<void>>();

/** The fire id comes only from live process attestation or a host registration. */
export function resolveAuthorizedScheduledSession(
  sessionDataDir: string, sessionId: string, scheduledTurnId: string, allowAutomaticCleanup = false,
): AuthorizedScheduledSessionContext | null {
  // This registration's authority and automatic-close protocol are local
  // SQLite state. Distributed primary close does not carry that protocol.
  if (coordinationModeIsPrimary()) return null;
  const ds = findActiveBySessionId(sessionId);
  const session = ds?.session ?? sessionStore.getOwnedSession(sessionId);
  const automaticallyClosed = session?.status === 'closed' && !!session.closedAt
    && session.backgroundExecutionCleanupClosedAt === session.closedAt;
  if (!session || (session.status !== 'active' && !(allowAutomaticCleanup && automaticallyClosed))
    || sandboxBoolValue(session.sandbox) || ds?.reportedIdentityModel?.sandboxEngaged
    || session.adoptedFrom || session.vcMeetingReceiver) return null;
  const larkAppId = ds?.larkAppId ?? session.larkAppId;
  const chatId = ds?.chatId ?? session.chatId;
  if (!larkAppId || !chatId) return null;
  let botConfig: BotConfig;
  try { botConfig = getBot(larkAppId).config; } catch { return null; }
  if (!larkTransportEnabled({ chatId, apiOnly: botConfig.apiOnly })) return null;
  const taskId = parseScheduledTurnId(scheduledTurnId);
  if (!taskId) return null;
  const authority = scheduler.getScheduleAuthorityRecord(taskId, larkAppId);
  if (!authority || authority.kind !== 'direct'
    || (authority.state !== 'active' && !(authority.state === 'completed' && isAutoCompletedSchedule(authority.task)))) return null;
  if ((authority.task.larkAppId && authority.task.larkAppId !== larkAppId)
    || !scheduleStore.effectiveScheduleChatIds(authority.task).includes(chatId)) return null;
  if (ds?.reportedIdentityModel ? identityStorageModelForDaemonSession(ds) !== 'proven'
    : !automaticallyClosed && readIdentityLayout(sessionDataDir, sessionId) !== 'proven') return null;
  return { ds, session, larkAppId, chatId, botConfig, scheduledTurnId, taskId, authority,
    runIdentity: resolveScheduledRunIdentity(authority.task, larkAppId,
      (openId, unionId) => canOperate(larkAppId, chatId, openId, unionId)) };
}

/** The new supervisor registers itself before its verified launcher exits. */
export function registerScheduledBackgroundExecution(input: {
  sessionDataDir: string; sessionId: string; peer: ProcessIdentity; ttlSeconds?: number;
}): BackgroundExecutionRegistration | null {
  if (process.platform !== 'linux') return null;
  const proof = attestCurrentExecutionLoopbackPeer({ sessionId: input.sessionId,
    peer: input.peer, findSession: findActiveBySessionId });
  if (!proof) return null;
  const roots = proof.ds.localProcessAttestation;
  if ([proof.ds.worker?.pid, roots?.cliPid, roots?.enginePid].includes(input.peer.pid)
    || proof.ds.managedTurnOrigin?.preexistingProcessIdentities?.includes(`${input.peer.pid}:${input.peer.procStart}`)) return null;
  const turnId = proof.ds.managedTurnOrigin?.identityTurnId ?? proof.turnId;
  const ctx = resolveAuthorizedScheduledSession(input.sessionDataDir, input.sessionId, turnId);
  const ttl = input.ttlSeconds ?? 86_400;
  if (!ctx?.runIdentity.ok || proof.ds.managedTurnOrigin?.callerOpenId !== ctx.runIdentity.openId
    || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > 7 * 86_400
    || readProcessStartIdentity(input.peer.pid) !== input.peer.procStart) return null;
  const bootId = readLinuxBootIdentity();
  if (!bootId || typeof process.getuid !== 'function'
    || statSync(`/proc/${input.peer.pid}`).uid !== process.getuid()) return null;
  const job: BackgroundExecutionRegistration = { id: randomUUID(), appId: ctx.larkAppId,
    sessionId: input.sessionId, taskId: ctx.taskId, turnId, root: { ...input.peer }, bootId,
    uid: process.getuid(), openId: ctx.runIdentity.openId, unionId: ctx.runIdentity.unionId,
    authEpoch: readCliAuthEpoch(ctx.runIdentity.openId), authorityKey: backgroundAuthorityKey(ctx.authority.task),
    sessionEpoch: ctx.session.backgroundExecutionEpoch ?? 0,
    credentialPolicyKey: backgroundCredentialPolicyKey(ctx.botConfig),
    expiresAt: Date.now() + ttl * 1000 };
  scheduler.registerBackgroundExecution(job);
  return job;
}

export function resolveRegisteredBackgroundContext(input: {
  sessionDataDir: string; sessionId: string; peer: ProcessIdentity; procRoot?: string;
}): RegisteredBackgroundContext | null {
  const ds = findActiveBySessionId(input.sessionId);
  const appId = ds?.larkAppId ?? sessionStore.getOwnedSession(input.sessionId)?.larkAppId;
  if (!appId) return null;
  const jobs = scheduler.backgroundExecutions(appId, input.sessionId)
    .filter(job => backgroundPeerBelongsToJob(job, input.peer, input.procRoot));
  if (jobs.length !== 1) return null;
  const job = jobs[0];
  const retire = () => {
    scheduler.revokeBackgroundExecution(job.id);
    forgetProvenIdentityContent(input.sessionDataDir, input.sessionId, `background:${job.id}`);
    releaseActiveIdentityTurn(input.sessionDataDir, input.sessionId, `background:${job.id}`);
    return null;
  };
  const ctx = resolveAuthorizedScheduledSession(input.sessionDataDir, input.sessionId, job.turnId, true);
  if (!ctx) return retire();
  if (!ctx.runIdentity.ok || ctx.larkAppId !== job.appId || ctx.taskId !== job.taskId
    || ctx.runIdentity.openId !== job.openId || ctx.runIdentity.unionId !== job.unionId
    || (ctx.session.backgroundExecutionEpoch ?? 0) !== (job.sessionEpoch ?? 0)
    || backgroundAuthorityKey(ctx.authority.task) !== job.authorityKey
    || backgroundCredentialPolicyKey(ctx.botConfig) !== job.credentialPolicyKey
    || readCliAuthEpoch(job.openId) !== job.authEpoch) {
    // Once an authority/policy withdrawal is observed, restoring configuration
    // cannot resurrect this already-retired process root.
    return retire();
  }
  return { ...ctx, job };
}

export function backgroundContextStillValid(input: {
  sessionDataDir: string; sessionId: string; peer: ProcessIdentity; procRoot?: string;
}, ctx: RegisteredBackgroundContext): boolean {
  return resolveRegisteredBackgroundContext(input)?.job.id === ctx.job.id;
}

/** A job can revoke itself; a live original human in the same session can too. */
export function revokeScheduledBackgroundExecution(input: {
  sessionDataDir: string; sessionId: string; peer: ProcessIdentity; jobId: string;
}): boolean {
  const ds = findActiveBySessionId(input.sessionId);
  const appId = ds?.larkAppId ?? sessionStore.getOwnedSession(input.sessionId)?.larkAppId;
  if (!appId) return false;
  const job = scheduler.backgroundExecutions(appId, input.sessionId).find(j => j.id === input.jobId);
  if (!job) return false;
  const live = attestCurrentExecutionLoopbackPeer({ sessionId: input.sessionId, peer: input.peer,
    findSession: findActiveBySessionId });
  if (!backgroundPeerBelongsToJob(job, input.peer)
    && (!live || live.ds.managedTurnOrigin?.callerOpenId !== job.openId)) return false;
  scheduler.revokeBackgroundExecution(job.id);
  releaseActiveIdentityTurn(input.sessionDataDir, input.sessionId, `background:${job.id}`);
  forgetProvenIdentityContent(input.sessionDataDir, input.sessionId, `background:${job.id}`);
  return true;
}

function unquoteEnvAssignment(body: string, key: string): string | undefined {
  for (const line of body.split('\n')) {
    if (!line.startsWith(`${key}=`)) continue;
    const quoted = line.slice(key.length + 1);
    if (!quoted.startsWith("'") || !quoted.endsWith("'")) return undefined;
    return quoted.slice(1, -1).replaceAll("'\\''", "'");
  }
  return undefined;
}

function cachedIdentityNeedsRefresh(env: string | undefined, job: BackgroundExecutionRegistration): boolean {
  if (!env || unquoteEnvAssignment(env, 'BOTMUX_IDENTITY_MODE') === 'denied'
    || unquoteEnvAssignment(env, 'BOTMUX_IDENTITY_OPEN_ID') !== job.openId) return true;
  // Inspect every actual regional field, including i18nbd and tx.
  for (const line of env.split('\n')) {
    const key = line.slice(0, line.indexOf('='));
    if (key !== 'BYTEDCLI_USER_CLOUD_JWT' && key !== 'BYTEDCLI_USER_CODE_JWT'
      && !key.startsWith('BOTMUX_IDENTITY_CLOUD_JWT_')) continue;
    const token = unquoteEnvAssignment(env, key);
    try {
      const exp = JSON.parse(Buffer.from(token?.split('.')[1] ?? '', 'base64url').toString('utf8'))?.exp;
      if (typeof exp !== 'number' || !Number.isFinite(exp) || exp * 1000 - Date.now() <= 40 * 60_000) return true;
    } catch { return true; }
  }
  return false;
}

export async function resolveDetachedScheduledExecutionIdentity(input: {
  sessionDataDir: string; sessionId: string; tool: DetachedIdentityRouteTool;
  peer: ProcessIdentity; procRoot?: string;
}): Promise<{ larkAppId: string; identityTurnId: string; env: string } | null> {
  const ctx = resolveRegisteredBackgroundContext(input);
  if (!ctx) return null;
  const turnId = `background:${ctx.job.id}`;
  const referenceTool = input.tool === 'codebase' ? 'bytedcli' : input.tool;
  const current = () => recallProvenIdentityContent(input.sessionDataDir, input.sessionId, turnId, input.tool);
  // Legacy Lark UATs are opaque (no exp claim); ask the provider each time.
  if (referenceTool === 'lark-cli' || !current() || cachedIdentityNeedsRefresh(
    recallProvenIdentityContent(input.sessionDataDir, input.sessionId, turnId, referenceTool), ctx.job)) {
    const flightKey = JSON.stringify([input.sessionDataDir, ctx.job.id]);
    let pending = inFlightPublishes.get(flightKey);
    if (!pending) {
      pending = (async () => {
        if (!backgroundContextStillValid(input, ctx)) return;
        noteSenderUnionId(ctx.larkAppId, ctx.job.openId, ctx.job.unionId);
        try {
          await publishTurnCliIdentity({ botConfig: ctx.botConfig, sessionDataDir: input.sessionDataDir,
            sessionId: input.sessionId, senderOpenId: ctx.job.openId,
            locale: localeForBot(ctx.larkAppId), turnId, storageModel: 'proven' });
        } finally {
          // This cache is disposable, never an admitted ordinary message turn.
          releaseActiveIdentityTurn(input.sessionDataDir, input.sessionId, turnId);
          // A dead-root row may already have been collected while the provider
          // awaited. Its late publication must not recreate orphan job state.
          let stable = false;
          try { stable = backgroundContextStillValid(input, ctx); }
          finally {
            if (!stable) {
              forgetProvenIdentityContent(input.sessionDataDir, input.sessionId, turnId);
              cleanupBackgroundJobHome(ctx.job.id);
            }
          }
        }
      })().finally(() => {
        if (inFlightPublishes.get(flightKey) === pending) inFlightPublishes.delete(flightKey);
      });
      inFlightPublishes.set(flightKey, pending);
    }
    await pending;
  }
  if (!backgroundContextStillValid(input, ctx)) {
    forgetProvenIdentityContent(input.sessionDataDir, input.sessionId, turnId);
    cleanupBackgroundJobHome(ctx.job.id);
    return null;
  }
  const env = current();
  return env ? { larkAppId: ctx.larkAppId, identityTurnId: ctx.job.turnId, env } : null;
}
