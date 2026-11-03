/**
 * 交接带发起人身份 (design 2026-11-03 §10, D5): a bot-executed workflow node
 * runs its `triggerUserAuth` tools as the person who started the run.
 *
 * Star-shaped issuance. The initiator (union_id + the tools they had on the
 * main bot) is frozen into `run.json` at authorization. Every handoff is then
 * signed by the main bot's daemon FROM THAT RUN RECORD, for one attempt of one
 * node, to one approved bot, in the run's chat and the node's topic — never
 * from a node's report, which reaches the orchestrator as an untrusted
 * synthetic trigger without any person attached. The record is an ordinary
 * dispatch-user delegation of its own domain (dispatch-user-delegation.ts):
 * same host key, store, pending → bind steps, and the receiving daemon
 * publishes it through the same path a `botmux dispatch` delegation takes.
 *
 * Principle (design §10): permission is asked for only when a tool really
 * needs a person it does not have. No approval, handoff or dispatch is held
 * back for an identity: what cannot carry the initiator goes ahead without
 * them, saying why, and a tool that does need the person refuses and asks for
 * authorization when it is called — never running as the bot or its owner.
 *
 * This module holds the decisions, with every Lark / daemon effect injected:
 *  - the target bot's pre-handoff check (its own talk-permission and chat
 *    membership check, the one dispatch uses) and the main bot's signing plan
 *    built on it — sign, or hand off unsigned with a plain-words reason;
 *  - the receiver's additional workflow checks: the handoff is still this
 *    session's, unrevoked, its attempt still the run's live one, the bot one
 *    the initiator approved (re-checked on every use of the identity);
 *  - passing the initiator on from a node session: only to approved bots in
 *    the run's chat, tied to the same attempt.
 *
 * Runs without a frozen identity never reach any of it: switch off ⟹ no
 * record is signed and every handoff is sent exactly as before.
 */

import { join } from 'node:path';

import {
  deliverDispatchWithUser,
  type DispatchUserAuthority,
  type WorkflowDispatchUserPayload,
  type WorkflowDispatchUserRef,
} from './dispatch-user-delegation.js';
import { lookupWorkflowHandoffByNonce } from './workflow-handoff-binding.js';
import type { WorkflowNodeSessionMarker } from '../types.js';
import type { TriggerUserAuthConfig } from '../services/trigger-user-auth.js';
import { parseFrozenBotSnapshots } from '../workflows/v3/bot-resolve.js';
import { loadEffectiveV3Dag, v3ApprovedBotScope } from '../workflows/v3/dag-revision.js';
import type { BotSnapshot } from '../workflows/v3/contract.js';
import { classifyExternalAttempt } from '../workflows/v3/external-control.js';
import { readJournal, type StoredEvent } from '../workflows/v3/journal.js';
import { isValidRunId } from '../workflows/v3/ops-projection.js';
import {
  V3_HANDOFF_IDENTITY_TOOLS,
  frozenHandoffIdentity,
  handoffIdentityRecordOf,
  loadAuthorizedV3Run,
  readRunEnvelope,
  type LoadedAuthorizedV3Run,
  type V3FrozenHandoffIdentity,
  type V3HandoffIdentityTool,
  type V3HandoffIdentityUnavailableReason,
} from '../workflows/v3/run-envelope.js';
import { V3_HANDOFF_IDENTITY_UNAVAILABLE_TEXT } from '../workflows/v3/node-executor-mode.js';

/** Main bot's daemon → target bot's daemon, before a handoff is sent. */
export const WORKFLOW_HANDOFF_IDENTITY_CHECK_ROUTE = '/api/workflow/handoff-identity-check';

// ─── The run's frozen identity and approved bots ────────────────────────────

export interface WorkflowHandoffIdentityRun {
  /** The frozen initiator; absent when the run was approved without one. */
  identity?: V3FrozenHandoffIdentity;
  /** Why the run carries no identity (set exactly when `identity` is not). */
  unavailableReason?: V3HandoffIdentityUnavailableReason;
  /** Bots that may receive the identity (§10.3). */
  approvedBots: ReadonlySet<string>;
  chatId?: string;
  /** The main bot (owner of the run). */
  sourceLarkAppId?: string;
}

/**
 * Bots the initiator approved to act for them (design §10.3, §13.5): the
 * run's approved bot scope ({@link v3ApprovedBotScope}: the frozen snapshot
 * Gate-2 / `/workflow run` approved, plus every bot an applied flow revision
 * brought in — applied directly in the initiator's own turn, or after the
 * initiator confirmed the revision card), plus any bot the initiator
 * reassigned a node to themselves on a blocked card (`nodeReassigned` whose
 * `by` is their own open_id). A proposal still waiting for confirmation adds
 * nothing, and anyone else's reassignment never adds a bot.
 *
 * Fail closed: when an applied revision's files do not verify, the scope is
 * the frozen snapshot alone — a broken revision never widens it.
 */
export function approvedWorkflowBots(
  runDir: string,
  loaded: Pick<LoadedAuthorizedV3Run, 'botSnapshots' | 'dag'>,
  events: readonly StoredEvent[],
  initiatorOpenId: string | undefined,
): Set<string> {
  const frozen = parseFrozenBotSnapshots(loaded.botSnapshots);
  let scope: ReadonlyMap<string, BotSnapshot>;
  try {
    scope = v3ApprovedBotScope(frozen, loadEffectiveV3Dag(runDir, loaded.dag, events).botAdditions);
  } catch {
    return new Set([...frozen.values()].map((snapshot) => snapshot.larkAppId));
  }
  const approved = new Set([...scope.values()].map((snapshot) => snapshot.larkAppId));
  for (const event of events) {
    if (event.type === 'nodeReassigned' && initiatorOpenId !== undefined && event.by === initiatorOpenId) approved.add(event.to);
  }
  return approved;
}

/**
 * The run's 交接带发起人身份 record — its frozen initiator, or why it was
 * approved without one — or undefined when the switch was off at
 * authorization (or there is no run.json at all). An existing but unreadable
 * / tampered run.json or artifact throws: a run's record is never guessed.
 */
export function loadWorkflowHandoffIdentityRun(runDir: string): WorkflowHandoffIdentityRun | undefined {
  const read = readRunEnvelope(runDir);
  if (read.kind === 'missing') return undefined;
  if (read.kind === 'invalid') throw new Error(`run.json is invalid: ${read.problems.join('; ')}`);
  // Cheap common case: switch off, nothing else to verify.
  if (!handoffIdentityRecordOf(read.envelope)) return undefined;
  const loaded = loadAuthorizedV3Run(runDir);
  const record = handoffIdentityRecordOf(loaded.envelope);
  if (!record) return undefined;
  const identity = frozenHandoffIdentity(loaded.envelope);
  const events = readJournal(join(runDir, 'journal.ndjson'));
  return {
    ...(identity ? { identity } : { unavailableReason: 'unavailable' in record ? record.unavailable : 'no_initiator' }),
    approvedBots: approvedWorkflowBots(runDir, loaded, events, identity?.openId),
    ...(loaded.envelope.chatBinding?.chatId ? { chatId: loaded.envelope.chatBinding.chatId } : {}),
    ...(loaded.envelope.chatBinding?.larkAppId ? { sourceLarkAppId: loaded.envelope.chatBinding.larkAppId } : {}),
  };
}

// ─── Target side: would this bot accept the initiator here? ─────────────────

export type WorkflowHandoffIdentityCheck =
  /** The bot runs no tool as its trigger user: nothing to delegate. */
  | { status: 'not_required' }
  /** Accepted; `tools` = offered ∩ governed (never wider than offered). */
  | { status: 'ok'; tools: V3HandoffIdentityTool[] }
  | { status: 'denied'; reason: 'no_shared_tool' | 'target_access_denied'; governed?: V3HandoffIdentityTool[] }
  /** The check itself could not run (lookup failure, daemon unreachable). */
  | { status: 'unavailable'; detail: string };

/**
 * The target bot's verdict on carrying `offeredTools` for the initiator into
 * this chat. `targetUser` is the receiving daemon's own delegation check
 * (union_id → this app's open_id, talk permission, current chat membership:
 * the one every dispatch delegation passes); it throws when that check is
 * unavailable. Run by the target's daemon itself.
 */
export async function checkWorkflowHandoffIdentityTarget(input: {
  policy: TriggerUserAuthConfig | null | undefined;
  offeredTools: readonly V3HandoffIdentityTool[];
  targetUser: () => Promise<string | undefined>;
}): Promise<WorkflowHandoffIdentityCheck> {
  const policy = input.policy;
  if (!policy?.enabled || policy.tools.length === 0) return { status: 'not_required' };
  const governed = V3_HANDOFF_IDENTITY_TOOLS.filter((tool) => policy.tools.includes(tool));
  const tools = governed.filter((tool) => input.offeredTools.includes(tool));
  if (tools.length === 0) return { status: 'denied', reason: 'no_shared_tool', governed };
  let openId: string | undefined;
  try {
    openId = await input.targetUser();
  } catch (err) {
    return { status: 'unavailable', detail: err instanceof Error ? err.message : String(err) };
  }
  return openId ? { status: 'ok', tools } : { status: 'denied', reason: 'target_access_denied' };
}

export interface WorkflowHandoffIdentityCheckRequest {
  chatId: string;
  unionId: string;
  tools: V3HandoffIdentityTool[];
  sourceLarkAppId: string;
}

function parseTools(raw: unknown): V3HandoffIdentityTool[] | undefined {
  if (!Array.isArray(raw) || raw.length > V3_HANDOFF_IDENTITY_TOOLS.length) return undefined;
  const tools: V3HandoffIdentityTool[] = [];
  for (const tool of raw) {
    if (!V3_HANDOFF_IDENTITY_TOOLS.includes(tool as V3HandoffIdentityTool) || tools.includes(tool as V3HandoffIdentityTool)) {
      return undefined;
    }
    tools.push(tool as V3HandoffIdentityTool);
  }
  return tools;
}

export function parseWorkflowHandoffIdentityCheckRequest(raw: unknown): WorkflowHandoffIdentityCheckRequest | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const body = raw as Record<string, unknown>;
  const tools = parseTools(body.tools);
  if (typeof body.chatId !== 'string' || !/^oc_[A-Za-z0-9_-]{1,128}$/.test(body.chatId)
    || typeof body.unionId !== 'string' || !/^on_[A-Za-z0-9_-]{1,128}$/.test(body.unionId)
    || typeof body.sourceLarkAppId !== 'string' || !/^cli_[A-Za-z0-9_-]{1,128}$/.test(body.sourceLarkAppId)
    || !tools) return undefined;
  return { chatId: body.chatId, unionId: body.unionId, tools, sourceLarkAppId: body.sourceLarkAppId };
}

/** Read the target's answer; anything malformed is an unavailable check. */
export function parseWorkflowHandoffIdentityCheck(raw: unknown): WorkflowHandoffIdentityCheck {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const check = body.check && typeof body.check === 'object' && !Array.isArray(body.check)
    ? body.check as Record<string, unknown>
    : undefined;
  if (check?.status === 'not_required') return { status: 'not_required' };
  if (check?.status === 'ok') {
    const tools = parseTools(check.tools);
    if (tools && tools.length > 0) return { status: 'ok', tools };
  }
  if (check?.status === 'denied' && (check.reason === 'no_shared_tool' || check.reason === 'target_access_denied')) {
    const governed = parseTools(check.governed);
    return { status: 'denied', reason: check.reason, ...(governed ? { governed } : {}) };
  }
  if (check?.status === 'unavailable') {
    return { status: 'unavailable', detail: typeof check.detail === 'string' ? check.detail.slice(0, 300) : 'unknown' };
  }
  return { status: 'unavailable', detail: typeof body.error === 'string' ? body.error : 'malformed identity check answer' };
}

export interface WorkflowIdentityRouteResult {
  status: number;
  body: Record<string, unknown>;
}

/** The target daemon's route (trusted host only; the caller enforces that). */
export async function handleWorkflowHandoffIdentityCheck(
  raw: unknown,
  check: (request: WorkflowHandoffIdentityCheckRequest) => Promise<WorkflowHandoffIdentityCheck>,
): Promise<WorkflowIdentityRouteResult> {
  const request = parseWorkflowHandoffIdentityCheckRequest(raw);
  if (!request) return { status: 400, body: { ok: false, error: 'invalid_identity_check' } };
  return { status: 200, body: { ok: true, check: await check(request) } };
}

// ─── Main bot side: sign, skip or refuse this handoff ───────────────────────

export type WorkflowHandoffIdentityPlan =
  /** No delegation and nothing to say: the run froze none and the switch was
   *  off, or the target runs no tool as its trigger user. The handoff is
   *  sent exactly as without the feature. */
  | { kind: 'none' }
  /** Sent WITHOUT the initiator (design §10 principle: a node is never held
   *  back for an identity it may not need). `note` says why, in plain words,
   *  on the handoff; a tool that does need the person asks for authorization
   *  when it is called. `transient`: the target's check could not run — the
   *  sender retries it for a while first. */
  | { kind: 'unsigned'; note: string; transient?: true }
  | { kind: 'sign'; authority: DispatchUserAuthority };

/**
 * Decide one handoff's identity (design §10.2 items 2–5, §10.3). Only a run
 * with a frozen identity can yield a delegation, always built from that
 * record; tools only narrow — the frozen ceiling ∩ what the main bot governs
 * now ∩ what the target governs — and a bot outside the approved set is
 * offered none. The target's own check decides. Whatever keeps the initiator
 * from going along never stops the handoff: it goes out unsigned, saying why,
 * and never runs as the bot or its owner instead (3.10).
 */
export async function planWorkflowHandoffIdentity(input: {
  run: WorkflowHandoffIdentityRun | undefined;
  sourceLarkAppId: string;
  targetLarkAppId: string;
  /** The main bot's `triggerUserAuth` tools right now. */
  sourceBotTools: readonly V3HandoffIdentityTool[];
  /** Whether the target runs any tool as its trigger user (bots.json). */
  targetGovernsTools: boolean;
  botName: (larkAppId: string) => string;
  check: (offered: V3HandoffIdentityTool[]) => Promise<WorkflowHandoffIdentityCheck>;
}): Promise<WorkflowHandoffIdentityPlan> {
  const run = input.run;
  if (!run) return { kind: 'none' };
  if (!run.identity) {
    return input.targetGovernsTools
      ? { kind: 'unsigned', note: `批准时没有取得发起人身份（${V3_HANDOFF_IDENTITY_UNAVAILABLE_TEXT[run.unavailableReason ?? 'no_initiator']}）` }
      : { kind: 'none' };
  }
  const name = input.botName(input.targetLarkAppId);
  const approved = run.approvedBots.has(input.targetLarkAppId);
  const offered = approved ? run.identity.tools.filter((tool) => input.sourceBotTools.includes(tool)) : [];
  let checked: WorkflowHandoffIdentityCheck;
  try {
    checked = await input.check(offered);
  } catch (err) {
    checked = { status: 'unavailable', detail: err instanceof Error ? err.message : String(err) };
  }
  if (checked.status === 'not_required') return { kind: 'none' };
  if (checked.status === 'unavailable') {
    return { kind: 'unsigned', transient: true, note: `暂时无法在 ${name} 这边校验发起人身份（${checked.detail}）` };
  }
  if (checked.status === 'denied') {
    if (!approved) return { kind: 'unsigned', note: `${name} 不在本 run 发起人批准的 Bot 范围内` };
    if (checked.reason === 'no_shared_tool') {
      return { kind: 'unsigned', note: `发起人在主 Bot 上没有可交给 ${name} 的工具身份` };
    }
    return { kind: 'unsigned', note: `发起人没有通过 ${name} 的身份校验（已不在本群、对它没有对话权限，或查不到发起人）` };
  }
  const tools = checked.tools.filter((tool) => offered.includes(tool));
  if (tools.length === 0) return { kind: 'unsigned', note: `发起人在主 Bot 上没有可交给 ${name} 的工具身份` };
  return {
    kind: 'sign',
    authority: {
      appId: input.sourceLarkAppId,
      openId: run.identity.openId,
      unionId: run.identity.unionId,
      tools,
    },
  };
}

/**
 * Send one handoff with its signed delegation: pending record (grants
 * nothing) → the send → bind to the exact message id, the steps every
 * `botmux dispatch` delegation takes. The record names the run's attempt,
 * the single target, the chat and the node topic.
 */
export function deliverWorkflowHandoffWithUser(input: {
  dataDir: string;
  secret: string;
  sourceLarkAppId: string;
  targetLarkAppId: string;
  chatId: string;
  /** The node topic (node card) the handoff is posted under. */
  rootId: string;
  workflow: WorkflowDispatchUserRef;
  authority: DispatchUserAuthority;
  send: () => Promise<string>;
}): Promise<string> {
  return deliverDispatchWithUser({
    dataDir: input.dataDir,
    secret: input.secret,
    payload: {
      sourceAppId: input.sourceLarkAppId,
      // Audit labels only: a run, not a session turn, signs this record.
      sourceSessionId: `workflow:${input.workflow.runId}`,
      sourceTurnId: `workflow:${input.workflow.runId}:${input.workflow.attemptId}`,
      rootId: input.rootId,
      chatId: input.chatId,
      targetAppIds: [input.targetLarkAppId],
      authority: input.authority,
      workflow: input.workflow,
    },
    send: input.send,
  });
}

// ─── Receiver side: is this delegation still in force? ──────────────────────

export type WorkflowDelegationRefusal =
  | 'not_this_handoff'
  | 'handoff_unbound'
  | 'handoff_revoked'
  | 'binding_mismatch'
  | 'run_unreadable'
  | 'identity_mismatch'
  | 'chat_mismatch'
  | 'bot_not_approved'
  | 'attempt_inactive';

/**
 * Checks a receiving daemon applies to a workflow delegation on top of the
 * dispatch ones (signature, exact message, target, chat, topic; then its own
 * union_id → open_id, talk and membership check). It is valid only:
 *  - for the handoff this session registered (marker = message = nonce);
 *  - while that handoff's host-signed binding stands unrevoked and names the
 *    same target, chat, topic and attempt;
 *  - for the identity the run froze, with no tool beyond the frozen ones;
 *  - for a bot the initiator approved;
 *  - while that attempt is still the run's live one (a terminal run, a
 *    cancelled / timed-out / retried / reassigned / superseded attempt, or a
 *    completed node ends it).
 * Returns why it is not, or undefined when it holds.
 */
export function workflowDelegationRefusal(input: {
  record: WorkflowDispatchUserPayload;
  turnId: string;
  receiverLarkAppId: string;
  chatId: string;
  marker: Pick<WorkflowNodeSessionMarker, 'runId' | 'attemptId' | 'handoffMessageId' | 'nonce' | 'publishRoot' | 'orchestratorAppId'> | undefined;
  registry: Record<string, unknown>;
  secret: string;
  baseDir: string;
}): WorkflowDelegationRefusal | undefined {
  const { record, marker } = input;
  const ref = record.workflow;
  // A record a node bot passed on (`hop`) names its own message, target and
  // thread; it stays tied to the handoff's attempt through `ref`.
  const passedOn = (ref.hop ?? 0) > 0;
  if (record.messageId !== input.turnId || record.chatId !== input.chatId
    || !record.targetAppIds.includes(input.receiverLarkAppId)) return 'not_this_handoff';
  if (!passedOn && (!marker || marker.handoffMessageId !== input.turnId || marker.nonce !== ref.nonce
    || marker.runId !== ref.runId || marker.attemptId !== ref.attemptId
    || marker.publishRoot !== record.rootId || marker.orchestratorAppId !== record.sourceAppId)) return 'not_this_handoff';

  const found = lookupWorkflowHandoffByNonce({ registry: input.registry, nonce: ref.nonce, secret: input.secret });
  if (found.kind !== 'workflow') return 'handoff_unbound';
  if (found.revoked) return 'handoff_revoked';
  const binding = found.binding;
  if ((!passedOn && ((found.messageId && found.messageId !== input.turnId)
    || binding.targetLarkAppId !== input.receiverLarkAppId
    || binding.targetChatId !== record.chatId
    || binding.publishRoot !== record.rootId
    || binding.sourceLarkAppId !== record.sourceAppId))
    || binding.workflow.runId !== ref.runId
    || binding.workflow.nodeId !== ref.nodeId
    || binding.workflow.instanceId !== ref.instanceId
    || binding.workflow.attemptId !== ref.attemptId
    || binding.workflow.revision !== ref.revision) return 'binding_mismatch';

  if (!isValidRunId(ref.runId)) return 'run_unreadable';
  const runDir = join(input.baseDir, ref.runId);
  let run: WorkflowHandoffIdentityRun | undefined;
  try {
    run = loadWorkflowHandoffIdentityRun(runDir);
  } catch {
    return 'run_unreadable';
  }
  const authority = record.authority;
  if (!run?.identity || run.identity.unionId !== authority.unionId || run.identity.openId !== authority.openId
    || authority.appId !== run.sourceLarkAppId
    || authority.tools.some((tool) => !run!.identity!.tools.includes(tool))) return 'identity_mismatch';
  if (run.chatId !== record.chatId || (!passedOn && run.sourceLarkAppId !== record.sourceAppId)) return 'chat_mismatch';
  if (!run.approvedBots.has(input.receiverLarkAppId)) return 'bot_not_approved';

  let current: ReturnType<typeof classifyExternalAttempt>;
  try {
    current = classifyExternalAttempt(
      readJournal(join(runDir, 'journal.ndjson')),
      ref.attemptId,
      ref.instanceId !== undefined ? { instanceId: ref.instanceId } : {},
    );
  } catch {
    return 'run_unreadable';
  }
  if (!current.ok) return 'attempt_inactive';
  if (current.attempt.nodeId !== ref.nodeId
    || (!passedOn && current.attempt.targetLarkAppId !== input.receiverLarkAppId)) return 'binding_mismatch';
  return undefined;
}

// ─── Passing the initiator on from a node session ───────────────────────────

/** Most hops a workflow delegation may be passed on (the record allows 16). */
const MAX_WORKFLOW_DELEGATION_HOPS = 16;

/**
 * Whether a `botmux dispatch` / `send --mention` from a node session passes
 * on the turn's workflow delegation (design §10.3: passing on is allowed,
 * every hop only narrows — the caller still narrows tools to its own bot).
 * `inherited` is the turn's own still-valid workflow delegation;
 * `targetUserAllowed` is this bot's dispatch check of the person in its chat.
 *
 * It goes on only to bots of the run's approved set, in the run's chat, as a
 * record tied to the same attempt (`workflow`, one more hop) — so it ends
 * when that attempt or the run does. Otherwise the dispatch goes ahead
 * WITHOUT the initiator: nothing is inherited and nothing is refused (design
 * §10 principle). An ordinary dispatch delegation never comes here.
 */
export async function inheritWorkflowDelegation(input: {
  inherited: WorkflowDispatchUserPayload;
  targetAppIds: readonly string[];
  chatId: string;
  baseDir: string;
  targetUserAllowed: (authority: DispatchUserAuthority) => Promise<boolean>;
}): Promise<{ inherit: true; workflow: WorkflowDispatchUserRef } | { inherit: false }> {
  const hop = (input.inherited.workflow.hop ?? 0) + 1;
  if (hop > MAX_WORKFLOW_DELEGATION_HOPS) return { inherit: false };
  let run: WorkflowHandoffIdentityRun | undefined;
  try {
    run = isValidRunId(input.inherited.workflow.runId)
      ? loadWorkflowHandoffIdentityRun(join(input.baseDir, input.inherited.workflow.runId))
      : undefined;
  } catch {
    run = undefined;
  }
  if (!run?.identity || input.chatId !== run.chatId || input.targetAppIds.length === 0
    || input.targetAppIds.some((appId) => !run!.approvedBots.has(appId))) return { inherit: false };
  if (!await input.targetUserAllowed(input.inherited.authority)) return { inherit: false };
  return { inherit: true, workflow: { ...input.inherited.workflow, hop } };
}
