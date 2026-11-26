import { attestCurrentExecutionLoopbackPeer, currentTurnPeerAttestationStable,
  type CurrentTurnPeerAttestationInput, type ProcessIdentity } from './current-actor-attestation.js';
import { resolveDaemonCurrentExecution } from './current-execution.js';
import { bytecloudBrokerEnabled } from './identity-policy.js';
import { credentialSourceOf, type TriggerUserAuthConfig } from '../services/trigger-user-auth.js';
import { normalizeActorEmail } from '../cli/current-actor.js';
import { registryEntryProvesHumanSender, registryTurnMayAuthenticateHuman } from './reply-target.js';
import { isOwnerActorTurnId } from './workflow-event-turn.js';
import { currentLarkToolDelegation } from './lark-tool-delegation.js';
import { readCliAuthEpoch } from '../services/cli-auth-epoch.js';
import { activePlatformCredentialBindingKey } from './platform-credential-source.js';
import { assertScheduledAuthorityCurrent, authorizeScheduledTurn, parseScheduledTurnId,
  trustedCallerForScheduledTask } from './scheduled-turn-provenance.js';
import type { ScheduleAuthorityRecord } from '../services/schedule-authority-store.js';
import type { BytedcliFrozenAuthority } from './bytedcli-executor.js';
import type { BytedcliOperation } from './bytedcli-operation-policy.js';
import type { BytedcliExecErrorCode } from '../cli/bytedcli-exec-protocol.js';
import type { DaemonSession } from './types.js';
import type { TrustedCaller } from '../types.js';
export interface BytedcliAuthorityDependencies {
  readonly daemonBootId: string; readonly dataDir: string;
  readonly findSession: CurrentTurnPeerAttestationInput['findSession'];
  readonly policy: (ds: DaemonSession) => TriggerUserAuthConfig | undefined;
  readonly contains: (ds: DaemonSession) => boolean;
  readonly canTalk: (ds: DaemonSession, openId?: string, memberUnionId?: string) => boolean;
  readonly identity: (app: string, openId: string) => Promise<{openId:string;type:'user';email?:string} | undefined>;
  readonly unionIdentity: (app: string, unionId: string) => Promise<{openId:string;email?:string} | undefined>;
  readonly schedule: (app: string, taskId: string) => ScheduleAuthorityRecord | undefined;
  readonly procRoot?: string;
  readonly authEpoch?: typeof readCliAuthEpoch; readonly bindingKey?: typeof activePlatformCredentialBindingKey;
}
export type BytedcliAuthorityResult = {ok:true; authority:BytedcliFrozenAuthority} | {ok:false;errorCode:BytedcliExecErrorCode};
const fail = (errorCode:BytedcliExecErrorCode):BytedcliAuthorityResult => ({ok:false,errorCode});
function callerFor(ds:DaemonSession, identityTurn:string):TrustedCaller | undefined {
  const trusted = ds.managedTurnOrigin?.trustedCaller;
  // Explicit callerless publication cannot borrow an older human registry row.
  if (trusted !== undefined) return trusted ?? undefined;
  if (ds.activeInteractiveTurn?.turnId === identityTurn) return ds.activeInteractiveTurn.caller;
  const entry = ds.session.replyTargets?.[identityTurn];
  if (entry && registryTurnMayAuthenticateHuman(ds.session,identityTurn) && registryEntryProvesHumanSender(entry)) {
    return {senderType:'user', requestUserOpenId:entry.senderOpenId};
  }
  return undefined;
}
const stable = (value:unknown):string => JSON.stringify(value);
/** Snapshot before the first async contact/task lookup; recheck never captures
 * a request-owned signal, so an authorized replay has independent cancellation. */
export async function resolveBytedcliAuthority(deps:BytedcliAuthorityDependencies,
  sessionId:string, peer:ProcessIdentity, operation:BytedcliOperation):Promise<BytedcliAuthorityResult> {
  const input = {sessionId,peer,findSession:deps.findSession,procRoot:deps.procRoot};
  const proof = attestCurrentExecutionLoopbackPeer(input);
  const execution = resolveDaemonCurrentExecution(input);
  if (!proof || !execution) return fail('execution_unverified');
  const ds = proof.ds, worker = ds.worker;
  const identityTurn = execution.identityTurnId ?? execution.turnId;
  const policy = deps.policy(ds), fingerprint = stable(policy);
  if (!bytecloudBrokerEnabled(policy)) return fail('broker_disabled');
  if (!deps.contains(ds)) return fail('broker_containment_unavailable');
  const caller = callerFor(ds,identityTurn), callerKey = stable(caller);
  const delegated = currentLarkToolDelegation(deps.dataDir,sessionId,identityTurn), delegationKey = stable(delegated);
  const taskId = parseScheduledTurnId(identityTurn);
  const record = taskId ? deps.schedule(ds.larkAppId,taskId) : undefined;
  const schedule = record ? structuredClone(record) : undefined;
  const scheduledCaller = schedule ? trustedCallerForScheduledTask(schedule.task,ds.larkAppId) : undefined;
  const scheduleGate = () => {
    if (!taskId) return true;
    if (!schedule) return false;
    const current = deps.schedule(ds.larkAppId,taskId);
    try { assertScheduledAuthorityCurrent(schedule,current,{turnId:identityTurn,allowCompleted:true}); }
    catch { return false; }
    const admission = authorizeScheduledTurn({turnId:identityTurn, sessionLarkAppId:ds.larkAppId,sessionChatId:ds.chatId,
      loadTask:()=>current?.task,isOwnerAllowed:(_app,id)=>deps.canTalk(ds,id),
      isScheduledTurnLive:()=>currentTurnPeerAttestationStable(proof,input)});
    return !('error' in admission);
  };
  const conversationGate = () => deps.canTalk(ds,delegated?.targetOpenId ?? scheduledCaller?.requestUserOpenId ?? caller?.requestUserOpenId,
    delegated?.unionId ?? scheduledCaller?.requestUserUnionId ?? caller?.requestUserUnionId);
  if (!scheduleGate() || !conversationGate()) return fail('permission_denied');
  if (delegated && (delegated.denialReason || !delegated.targetOpenId || !delegated.tools.includes('bytedcli'))) return fail('delegation_revoked');
  const source = credentialSourceOf(policy,'bytecloud');
  const credentialOpenId = delegated?.credentialOpenId ?? (taskId && schedule
    ? schedule.credentialOpenId || trustedCallerForScheduledTask(schedule.task,ds.larkAppId)?.requestUserOpenId
    : caller?.requestUserOpenId);
  const epochReader = deps.authEpoch ?? readCliAuthEpoch;
  const bindingReader = deps.bindingKey ?? activePlatformCredentialBindingKey;
  const epoch = operation.effect === 'write' && credentialOpenId ? epochReader(credentialOpenId) : undefined;
  const binding = bindingReader();
  const synchronousCheck = ():BytedcliExecErrorCode | undefined => {
    if (!currentTurnPeerAttestationStable(proof,input) || ds.worker !== worker
      || (ds.managedTurnOrigin?.identityTurnId ?? ds.managedTurnOrigin?.turnId) !== identityTurn
      || stable(callerFor(ds,identityTurn)) !== callerKey) return 'execution_stale';
    if (stable(deps.policy(ds)) !== fingerprint || credentialSourceOf(deps.policy(ds),'bytecloud') !== source) return 'policy_changed';
    if (!deps.contains(ds)) return 'broker_containment_unavailable';
    if (!conversationGate()) return 'permission_denied';
    if (!scheduleGate()) return 'delegation_revoked';
    const currentDelegation=currentLarkToolDelegation(deps.dataDir,sessionId,identityTurn);
    if (stable(currentDelegation) !== delegationKey || currentDelegation?.recheck !== delegated?.recheck
      || currentDelegation?.taskAuthorized !== delegated?.taskAuthorized) return 'delegation_revoked';
    if (operation.effect === 'write' && credentialOpenId && epochReader(credentialOpenId) !== epoch) return 'authorization_revoked';
    if (operation.effect === 'write' && bindingReader() !== binding) return 'binding_changed';
  };
  const recheck = async ():Promise<BytedcliExecErrorCode | undefined> => {
    const error = synchronousCheck(); if (error) return error;
    if (delegated?.taskAuthorized && !await delegated.taskAuthorized()) return 'delegation_revoked';
    return synchronousCheck();
  };
  const initial = await recheck(); if (initial) return fail(initial);
  let actor:BytedcliFrozenAuthority['actor'];
  if (operation.effect === 'write') {
    if (isOwnerActorTurnId(identityTurn) || (!delegated && (scheduledCaller ?? caller)?.senderType !== 'user')
      || (taskId && (!schedule?.runScopes.includes('bytedcli') || !trustedCallerForScheduledTask(schedule.task,ds.larkAppId)))) return fail('actor_required');
    const unionId = delegated?.unionId ?? scheduledCaller?.requestUserUnionId ?? caller?.requestUserUnionId;
    if (!credentialOpenId) return fail('actor_required');
    const identity = delegated && unionId
      ? await deps.unionIdentity(ds.larkAppId,unionId)
      : await deps.identity(ds.larkAppId,credentialOpenId);
    const after = await recheck(); if (after) return fail(after);
    if (!identity || identity.openId !== (delegated?.targetOpenId ?? credentialOpenId)) return fail('actor_identity_unverified');
    let verifiedEmail:string;
    try { verifiedEmail=normalizeActorEmail(identity.email); } catch { return fail('actor_identity_unverified'); }
    actor=Object.freeze({verifiedEmail,credentialOpenId,source,...(unionId?{unionId}:{})});
  }
  return {ok:true,authority:Object.freeze({daemonBootId:deps.daemonBootId,botAppId:ds.larkAppId,sessionId,
    turnId:execution.turnId,identityTurnId:identityTurn,workerGeneration:execution.workerGeneration,
    // Authenticated sentinel: ordinary topics do not have dispatch attempts.
    dispatchAttempt:execution.dispatchAttempt ?? 0,policyFingerprint:fingerprint,...(actor?{actor}:{}),recheck})};
}
