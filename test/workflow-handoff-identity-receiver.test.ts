/**
 * 交接带发起人身份 on the receiving bot's daemon (design 2026-11-03 §10.2
 * items 3–4, §10.3): the REAL daemon.ts turn-identity functions (cut out and
 * run against an injected scope, as the dispatch-delegation tests do) given a
 * handoff the REAL main-bot daemon signed for a real authorized run.
 *
 * - managed-Agent: the node turn runs the initiator's tools, resolved to THIS
 *   app's open_id from the union_id; the issuing app's open_id is only the
 *   local credential-store key and never presented as an identity here;
 * - the dispatch checks still apply (initiator left the chat → refusal that
 *   points the node at its handoff, not at the node topic);
 * - a revoked / ended handoff publishes an explicit refusal and is never
 *   inherited by a dispatch from the node session;
 * - a later human turn in the node topic runs as that human (no carry-over);
 * - the pre-handoff check and the withdrawal on stop use the same functions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const bytedcliJwts = new Map<string, { cloudJwt: string }>();
// The rest of these modules stays real; only the credential providers are scripted.
vi.mock('../src/utils/user-token.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/user-token.js')>()),
  resolveUserToken: vi.fn(async () => null),
}));
vi.mock('../src/services/bytedcli-auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/bytedcli-auth.js')>()),
  renewBytedcliJwts: vi.fn(async () => null),
  mintBytedcliJwts: vi.fn(async (openId: string) => bytedcliJwts.get(openId) ?? null),
  beginBytedcliLogin: vi.fn(async () => ({ authUrl: 'https://cloud.example.com/auth', completeToken: 'tok' })),
}));
vi.mock('../src/services/lark-cli-auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/lark-cli-auth.js')>()),
  resolveLarkCliHomeForTurn: vi.fn(async () => null),
  pendingLarkCliChallenge: vi.fn(() => null),
  beginLarkCliLogin: vi.fn(async () => ({ authUrl: 'https://example.com/lark-device' })),
}));

const ts = (await import('typescript')).default;
const { publishTurnCliIdentity } = await import('../src/core/turn-cli-identity.js');
const { recallProvenIdentityContent, renderIdentityWrapper, publishActiveTurn } = await import('../src/core/cli-identity.js');
const { execFileSync } = await import('node:child_process');
const fs = await import('node:fs');
const nodePath = await import('node:path');
const nodeOs = await import('node:os');
const { parseTriggerUserAuthConfig } = await import('../src/services/trigger-user-auth.js');
const { resolveDispatchUser, dispatchCallerFromReply } = await import('../src/core/dispatch-user-delegation.js');
const { pickTurnReplyTarget } = await import('../src/core/reply-target.js');
const { readDispatchRegistryLoose, revokeWorkflowHandoff, lookupWorkflowHandoff } = await import('../src/core/workflow-handoff-binding.js');
const { workflowDelegationRefusal, checkWorkflowHandoffIdentityTarget, inheritWorkflowDelegation } = await import('../src/core/workflow-handoff-identity.js');
const { authorityForDispatch, deliverDispatchWithUser } = await import('../src/core/dispatch-user-delegation.js');
const { workflowNodeMarkerFromBinding } = await import('../src/core/workflow-node-session.js');
const { BotRun, cleanupBotRuns, reportDag, reportFiles, snapshotFor } = await import('./helpers/v3-external-harness.js');
const { applyV3RunEdit, decideV3RevisionProposal } = await import('../src/workflows/v3/run-edit.js');
const { CHAT, INITIATOR_MAIN_OU, INITIATOR_OU_IN, INITIATOR_UNION, MAIN, SECRET, authorizeRun, driveWith, identityWorld } =
  await import('./helpers/workflow-identity-world.js');
const { nonceOf } = await import('./helpers/workflow-handoff-harness.js');
const { validateDag } = await import('../src/workflows/v3/dag.js');
const { getLarkToolDelegation, currentLarkToolDelegation, clearLarkToolDelegations } = await import('../src/core/lark-tool-delegation.js');
const { parseScheduledTurnId } = await import('../src/core/scheduled-turn-provenance.js');
const { prepareScheduledRecoveryRun } = await import('../src/core/scheduled-send.js');

const SESSION = 'sess-node';
const MAIN_BOT_IN_A = 'ou_main_bot_in_a';

beforeEach(() => bytedcliJwts.clear());
afterEach(() => cleanupBotRuns());

const DAEMON_FUNCTIONS = [
  'triggerUserAuthEnabledFor', 'prepareTurnCliIdentity', 'dispatchUserForTurn', 'workflowDelegationRefusalFor',
  'targetUserForDelegation', 'refreshTurnCliIdentity', 'identityPublicationConflicted', 'identityModelForPublication',
  'workflowHandoffIdentityCheck', 'withdrawWorkflowHandoffIdentity',
];

/** The production functions, evaluated against `scope` (no daemon import). */
function daemonFunctions(scope: Record<string, unknown>) {
  const source = ts.createSourceFile('daemon.ts', readFileSync('src/daemon.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const code = DAEMON_FUNCTIONS.map((name) => {
    const fn = source.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
    if (!fn) throw new Error(`Missing production function ${name}`);
    return ts.transpileModule(fn.getText(source).replace(/^export\s+/, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  }).join('\n');
  return new Function('scope', `with (scope) { ${code}; return { ${DAEMON_FUNCTIONS.join(', ')} }; }`)(scope) as Record<string, (...args: any[]) => any>;
}

function botConfig(appId: string, tools: Array<'lark-cli' | 'bytedcli'> | null) {
  return {
    larkAppId: appId, larkAppSecret: 'secret', brand: 'feishu' as const,
    ...(tools ? { triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools }) ?? undefined } : {}),
  } as any;
}

/** A handoff the main bot really signed, and the receiving bot's view of it. */
async function receiver(opts: { self?: boolean; alsoApproved?: string[]; main?: boolean } = {}) {
  const self = opts.self === true;
  const run = new BotRun(self
    ? validateDag({ schemaVersion: 2, runId: 'rcvd-self', nodes: [{ id: 'write', type: 'goal', goal: 'g', timeoutSec: 600 }] })
    : opts.main ? reportDag('rcvd-main', { placement: 'main' }) : reportDag('rcvd'));
  const world = identityWorld();
  const snapshots = authorizeRun(run, {
    identity: { unionId: INITIATOR_UNION, tools: ['bytedcli'] },
    selectors: [self ? '' : 'cli_a', ...(opts.alsoApproved ?? [])],
  });
  await driveWith(run, world, snapshots);
  const attempt = run.openAttempt('write');
  const handoff = attempt.handoffMessageId!;
  const appId = self ? MAIN : 'cli_a';
  const found = lookupWorkflowHandoff({ registry: readDispatchRegistryLoose(world.dataDir), dispatchRoot: handoff, secret: SECRET });
  if (found.kind !== 'workflow') throw new Error('handoff binding missing');
  // A main-topic handoff (§5.5) lives under the main topic's root.
  const nodeCard = attempt.nodeCardMessageId ?? found.binding.publishRoot;
  const ds: any = {
    larkAppId: appId, chatId: CHAT, chatType: 'group', scope: 'thread',
    session: {
      sessionId: SESSION, rootMessageId: nodeCard,
      workflowNode: workflowNodeMarkerFromBinding(found.binding, handoff),
      // Lark delivers another bot's handoff as a bot message; the main bot's
      // own node has no inbound message at all (§6.5).
      replyTargets: self ? {} : {
        [handoff]: { senderOpenId: MAIN_BOT_IN_A, rootMessageId: nodeCard, participants: [{ openId: MAIN_BOT_IN_A, isBot: true }], updatedAt: new Date().toISOString() },
      },
    },
  };
  const members = new Set([INITIATOR_OU_IN[appId]!]);
  const scope: Record<string, any> = {
    config: { session: { dataDir: world.dataDir } },
    pickTurnReplyTarget, resolveDispatchUser, dispatchCallerFromReply,
    getBot: () => ({ config: botConfig(appId, ['bytedcli', 'lark-cli']) }),
    loadOrCreateDispatchReportBindingSecret: () => SECRET,
    // The target app's own contact directory: union_id → ITS open_id.
    resolveTargetAppOpenId: vi.fn(async (app: string, unionId: string) => unionId === INITIATOR_UNION
      ? { status: 'resolved', openId: INITIATOR_OU_IN[app] } : { status: 'definitive' }),
    evaluateTalk: () => ({ allowed: true }),
    listChatMemberOpenIds: vi.fn(async () => [...members]),
    publishTurnCliIdentity, localeForBot: () => 'en',
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    identityStorageModelForDaemonSession: () => 'proven',
    identityDecisionConflict: () => undefined,
    workflowDelegationRefusal, readDispatchRegistryLoose, v3DefaultBaseDir: () => run.base,
    checkWorkflowHandoffIdentityTarget, workflowSelfAppId: () => appId,
    identityDecisionTurnIsLive: vi.fn(() => true),
    getLarkToolDelegation,
    // prepareTurnCliIdentity took a scheduled-turn guard; the handoff id is a
    // plain message id so recovery stays inert, but the free identifiers must resolve.
    parseScheduledTurnId, prepareScheduledRecoveryRun,
  };
  const fns = daemonFunctions(scope);
  const identity = (turnId = handoff) => recallProvenIdentityContent(world.dataDir, SESSION, turnId, 'bytedcli') ?? '';
  return { run, world, attempt, handoff, nodeCard, ds, scope, fns, members, identity, snapshots };
}

describe('a node turn under a workflow delegation', () => {
  it('managed-Agent: runs the initiator\'s tools under this app\'s own open_id for them', async () => {
    const h = await receiver();
    // The issuing app's open_id keys the initiator's local credentials.
    bytedcliJwts.set(INITIATOR_MAIN_OU, { cloudJwt: 'alice-cloud' });
    await h.fns.refreshTurnCliIdentity(h.ds, h.handoff);
    expect(h.scope.resolveTargetAppOpenId).toHaveBeenCalledExactlyOnceWith('cli_a', INITIATOR_UNION);
    const body = h.identity();
    expect(body).toContain('alice-cloud');
    expect(body).toContain(INITIATOR_OU_IN.cli_a);
    expect(body).not.toContain(INITIATOR_MAIN_OU);
    expect(h.scope.logger.info).toHaveBeenCalledWith(expect.stringMatching(
      new RegExp(`^\\[dispatch-user:audit\\] receive source=${MAIN} target=cli_a union=${INITIATOR_UNION} .*turn=${h.handoff} .*result=delegated$`),
    ));
  });

  it('the initiator left the chat: refused, and the refusal points the node at its handoff', async () => {
    const h = await receiver();
    h.members.clear();
    bytedcliJwts.set(INITIATOR_MAIN_OU, { cloudJwt: 'must-not-leak' });
    await h.fns.refreshTurnCliIdentity(h.ds, h.handoff);
    const body = h.identity();
    expect(body).not.toContain('must-not-leak');
    expect(body).toContain(`report --dispatch-root ${h.handoff}`);
    expect(body).not.toContain(`--dispatch-root ${h.nodeCard}`);
  });

  it('a revoked handoff: explicit refusal, no lookup, and nothing for a dispatch from the node session to inherit', async () => {
    const h = await receiver();
    await revokeWorkflowHandoff(h.world.dataDir, SECRET, nonceOf(h.attempt), 'runCancelled');
    bytedcliJwts.set(INITIATOR_MAIN_OU, { cloudJwt: 'must-not-leak' });
    await h.fns.refreshTurnCliIdentity(h.ds, h.handoff);
    const body = h.identity();
    expect(body).not.toContain('must-not-leak');
    expect(body).toContain('no longer active');
    expect(h.scope.resolveTargetAppOpenId).not.toHaveBeenCalled();
    expect(await h.fns.dispatchUserForTurn(h.ds, h.handoff)).toBeUndefined();
  });

  it('while it holds, a dispatch from the node session inherits it (the multi-hop rules then narrow it)', async () => {
    const h = await receiver();
    expect(await h.fns.dispatchUserForTurn(h.ds, h.handoff)).toMatchObject({ workflow: { attemptId: h.attempt.attemptId } });
  });

  it('a later human turn in the node topic runs as that human, never as the initiator', async () => {
    const h = await receiver();
    h.ds.session.replyTargets.om_human = {
      senderOpenId: 'ou_bob_in_a', rootMessageId: h.nodeCard, participants: [{ openId: 'ou_bob_in_a', isBot: false }],
      updatedAt: new Date().toISOString(),
    };
    bytedcliJwts.set(INITIATOR_MAIN_OU, { cloudJwt: 'must-not-leak' });
    bytedcliJwts.set('ou_bob_in_a', { cloudJwt: 'bob-cloud' });
    await h.fns.refreshTurnCliIdentity(h.ds, 'om_human');
    expect(h.identity('om_human')).toContain('bob-cloud');
    expect(h.identity('om_human')).not.toContain('must-not-leak');
  });

  it('the main bot\'s own node turn (no inbound message) carries the delegation too', async () => {
    const h = await receiver({ self: true });
    bytedcliJwts.set(INITIATOR_MAIN_OU, { cloudJwt: 'alice-cloud' });
    await h.fns.prepareTurnCliIdentity(h.ds, h.handoff);
    expect(h.identity()).toContain('alice-cloud');
    expect(h.scope.resolveTargetAppOpenId).toHaveBeenCalledExactlyOnceWith(MAIN, INITIATOR_UNION);
  });

  it('stopping the handoff withdraws the identity its turn was given', async () => {
    const h = await receiver();
    bytedcliJwts.set(INITIATOR_MAIN_OU, { cloudJwt: 'alice-cloud' });
    await h.fns.refreshTurnCliIdentity(h.ds, h.handoff);
    expect(h.identity()).toContain('alice-cloud');
    await revokeWorkflowHandoff(h.world.dataDir, SECRET, nonceOf(h.attempt), 'timeout');
    await h.fns.withdrawWorkflowHandoffIdentity(h.ds, h.handoff);
    expect(h.identity()).not.toContain('alice-cloud');
    expect(h.identity()).toContain('no longer active');
  });

  it('a turn that already ended is not re-published on stop', async () => {
    const h = await receiver();
    bytedcliJwts.set(INITIATOR_MAIN_OU, { cloudJwt: 'alice-cloud' });
    await h.fns.refreshTurnCliIdentity(h.ds, h.handoff);
    h.scope.identityDecisionTurnIsLive.mockReturnValue(false);
    await h.fns.withdrawWorkflowHandoffIdentity(h.ds, h.handoff);
    expect(h.identity()).toContain('alice-cloud');
  });
});

describe('a published workflow delegation is re-checked on every use', () => {
  it('holds while the attempt is live', async () => {
    const h = await receiver();
    await h.fns.refreshTurnCliIdentity(h.ds, h.handoff);
    expect(currentLarkToolDelegation(h.world.dataDir, SESSION, h.handoff))
      .toMatchObject({ workflowHandoff: true, targetOpenId: INITIATOR_OU_IN.cli_a, denialReason: undefined });
    clearLarkToolDelegations(h.world.dataDir, SESSION);
  });

  it.each([
    ['the stop never reached this daemon', async (h: Awaited<ReturnType<typeof receiver>>) => {
      await revokeWorkflowHandoff(h.world.dataDir, SECRET, nonceOf(h.attempt), 'runCancelled');
    }],
    ['the node already completed', async (h: Awaited<ReturnType<typeof receiver>>) => {
      h.run.accept(h.attempt.attemptId, SESSION);
      expect(await h.run.submit(h.attempt.attemptId, { sessionId: SESSION, ...reportFiles() })).toMatchObject({ ok: true });
    }],
  ])('%s: the next use gets a refusal, for good', async (_label, end) => {
    const h = await receiver();
    await h.fns.refreshTurnCliIdentity(h.ds, h.handoff);
    await end(h);
    const denied = currentLarkToolDelegation(h.world.dataDir, SESSION, h.handoff);
    expect(denied).toMatchObject({ workflowHandoff: true, denialReason: 'delegation_inactive', tools: [] });
    expect(denied).not.toHaveProperty('targetOpenId');
    expect(getLarkToolDelegation(h.world.dataDir, SESSION, h.handoff)).toEqual(denied);
    clearLarkToolDelegations(h.world.dataDir, SESSION);
  });

  it('an ordinary dispatch delegation is served as remembered (no workflow re-check)', async () => {
    const { rememberLarkToolDelegation } = await import('../src/core/lark-tool-delegation.js');
    const h = await receiver();
    const plain = { credentialOpenId: 'ou_x', unionId: 'on_x', targetOpenId: 'ou_y', tools: ['lark-cli' as const], dispatchRoot: 'om_r' };
    rememberLarkToolDelegation(h.world.dataDir, SESSION, 'om_plain', plain);
    expect(currentLarkToolDelegation(h.world.dataDir, SESSION, 'om_plain')).toEqual(plain);
    clearLarkToolDelegations(h.world.dataDir, SESSION);
  });
});

describe('the pre-handoff check runs the dispatch delegation check of this bot', () => {
  const request = { chatId: CHAT, unionId: INITIATOR_UNION, tools: ['bytedcli' as const], sourceLarkAppId: MAIN };

  it('accepts a member it can resolve, narrowed to what it governs', async () => {
    const h = await receiver();
    h.scope.getBot = () => ({ config: botConfig('cli_a', ['bytedcli']) });
    expect(await h.fns.workflowHandoffIdentityCheck({ ...request, tools: ['lark-cli', 'bytedcli'] }))
      .toEqual({ status: 'ok', tools: ['bytedcli'] });
    expect(h.scope.resolveTargetAppOpenId).toHaveBeenCalledWith('cli_a', INITIATOR_UNION);
  });

  it('denies someone who left the chat; unavailable when membership cannot be read; not required without trigger-user auth', async () => {
    const h = await receiver();
    h.members.clear();
    expect(await h.fns.workflowHandoffIdentityCheck(request)).toEqual({ status: 'denied', reason: 'target_access_denied' });
    h.scope.listChatMemberOpenIds.mockRejectedValueOnce(new Error('member list exceeds 2000 members'));
    expect(await h.fns.workflowHandoffIdentityCheck(request)).toMatchObject({ status: 'unavailable' });
    h.scope.getBot = () => ({ config: botConfig('cli_a', null) });
    expect(await h.fns.workflowHandoffIdentityCheck(request)).toEqual({ status: 'not_required' });
  });
});

describe('a main-topic handoff (§5.5): the delegation is the handoff turn\'s, nothing more', () => {
  it('a turn folded into or following the handoff turn in the shared session gets no delegation; passing on stays inside the approved set', async () => {
    const h = await receiver({ main: true, alsoApproved: ['cli_b'] });
    expect(h.ds.session.workflowNode).toMatchObject({ placement: 'main' });
    const inherited = await h.fns.dispatchUserForTurn(h.ds, h.handoff);
    expect(inherited).toMatchObject({ workflow: { attemptId: h.attempt.attemptId } });
    // A person's message in the main topic (another turn of the same session).
    h.ds.session.replyTargets.om_person = {
      senderOpenId: 'ou_person_in_a', rootMessageId: h.nodeCard, participants: [{ openId: 'ou_person_in_a', isBot: false }],
      updatedAt: new Date().toISOString(),
    };
    const other = await h.fns.dispatchUserForTurn(h.ds, 'om_person');
    expect(other === undefined || !('workflow' in (other as object))).toBe(true);
    // Passing on from the handoff turn: only to the run's approved bots.
    expect(await inheritWorkflowDelegation({
      inherited, targetAppIds: ['cli_c'], chatId: CHAT, baseDir: h.run.base, targetUserAllowed: async () => true,
    })).toEqual({ inherit: false });
    expect(await inheritWorkflowDelegation({
      inherited, targetAppIds: ['cli_b'], chatId: CHAT, baseDir: h.run.base, targetUserAllowed: async () => true,
    })).toMatchObject({ inherit: true, workflow: { hop: 1 } });
    // The attempt over (cancelled): the handoff turn's delegation ends too.
    await revokeWorkflowHandoff(h.world.dataDir, SECRET, nonceOf(h.attempt), 'runCancelled');
    expect(await h.fns.dispatchUserForTurn(h.ds, h.handoff)).toBeUndefined();
  });
});

describe('a node bot passing the initiator on (`botmux dispatch` from the node session)', () => {
  /** cli_a's node session dispatches to `target` with what its turn inherits. */
  async function passOn(h: Awaited<ReturnType<typeof receiver>>, target: string, opts: { chatId?: string; allowed?: boolean } = {}) {
    const inherited = await h.fns.dispatchUserForTurn(h.ds, h.handoff);
    expect(inherited).toMatchObject({ workflow: { attemptId: h.attempt.attemptId } });
    return inheritWorkflowDelegation({
      inherited, targetAppIds: [target], chatId: opts.chatId ?? CHAT, baseDir: h.run.base,
      targetUserAllowed: async () => opts.allowed ?? true,
    });
  }

  it('to an approved bot in the run\'s chat: one more hop, tied to the same attempt, ending with it', async () => {
    const h = await receiver({ alsoApproved: ['cli_b'] });
    const passed = await passOn(h, 'cli_b');
    expect(passed).toEqual({ inherit: true, workflow: expect.objectContaining({ attemptId: h.attempt.attemptId, nonce: nonceOf(h.attempt), hop: 1 }) });
    if (!passed.inherit) throw new Error('unreachable');
    const inherited = await h.fns.dispatchUserForTurn(h.ds, h.handoff);
    // The dispatching bot narrows to its own tools, exactly as any dispatch.
    const authority = await authorityForDispatch({
      sourceAppId: 'cli_a', tools: ['bytedcli'], inherited: inherited.authority, resolveUnionId: async () => null,
    });
    await deliverDispatchWithUser({
      dataDir: h.world.dataDir, secret: SECRET,
      payload: { sourceAppId: 'cli_a', sourceSessionId: SESSION, sourceTurnId: h.handoff, rootId: 'om_grand_root',
        chatId: CHAT, targetAppIds: ['cli_b'], authority: authority!, workflow: passed.workflow },
      send: async () => 'om_grand',
    });
    const grand = await resolveDispatchUser({ dataDir: h.world.dataDir, secret: SECRET, appId: 'cli_b', chatId: CHAT, rootId: 'om_grand_root', turnId: 'om_grand', waitMs: 0 });
    expect(grand).toMatchObject({ domain: 'botmux.dispatch-user.workflow.v1', workflow: { hop: 1 }, authority: { appId: MAIN, unionId: INITIATOR_UNION } });
    const holds = () => workflowDelegationRefusal({
      record: grand as any, turnId: 'om_grand', receiverLarkAppId: 'cli_b', chatId: CHAT, marker: undefined,
      registry: readDispatchRegistryLoose(h.world.dataDir), secret: SECRET, baseDir: h.run.base,
    });
    expect(holds()).toBeUndefined();
    // The grandchild's delegation ends with the node's attempt.
    h.run.accept(h.attempt.attemptId, SESSION);
    expect(await h.run.submit(h.attempt.attemptId, { sessionId: SESSION, ...reportFiles() })).toMatchObject({ ok: true });
    expect(holds()).toBe('attempt_inactive');
  });

  it('the grandchild\'s turn publishes from it, and a refusal points at its dispatch root', async () => {
    const h = await receiver({ alsoApproved: ['cli_b'] });
    const passed = await passOn(h, 'cli_b');
    if (!passed.inherit) throw new Error('unreachable');
    const inherited = await h.fns.dispatchUserForTurn(h.ds, h.handoff);
    await deliverDispatchWithUser({
      dataDir: h.world.dataDir, secret: SECRET,
      payload: { sourceAppId: 'cli_a', sourceSessionId: SESSION, sourceTurnId: h.handoff, rootId: 'om_groot',
        chatId: CHAT, targetAppIds: ['cli_b'], authority: { ...inherited.authority }, workflow: passed.workflow },
      send: async () => 'om_gmsg',
    });
    const grandchild: any = {
      larkAppId: 'cli_b', chatId: CHAT, chatType: 'group', scope: 'thread',
      session: { sessionId: SESSION, rootMessageId: 'om_groot', replyTargets: {
        om_gmsg: { senderOpenId: 'ou_a_in_b', rootMessageId: 'om_groot', participants: [{ openId: 'ou_a_in_b', isBot: true }], updatedAt: new Date().toISOString() },
      } },
    };
    // The initiator is not among cli_b's members in this world: refused.
    await h.fns.refreshTurnCliIdentity(grandchild, 'om_gmsg');
    expect(h.scope.resolveTargetAppOpenId).toHaveBeenCalledWith('cli_b', INITIATOR_UNION);
    const body = recallProvenIdentityContent(h.world.dataDir, SESSION, 'om_gmsg', 'bytedcli') ?? '';
    expect(body).toContain('--dispatch-root om_groot');
    expect(body).not.toContain('--dispatch-root om_gmsg');
  });

  it('… and with the run cancelled (the handoff revoked)', async () => {
    const h = await receiver({ alsoApproved: ['cli_b'] });
    const passed = await passOn(h, 'cli_b');
    if (!passed.inherit) throw new Error('unreachable');
    const inherited = await h.fns.dispatchUserForTurn(h.ds, h.handoff);
    await deliverDispatchWithUser({
      dataDir: h.world.dataDir, secret: SECRET,
      payload: { sourceAppId: 'cli_a', sourceSessionId: SESSION, sourceTurnId: h.handoff, chatId: CHAT,
        targetAppIds: ['cli_b'], authority: { ...inherited.authority }, workflow: passed.workflow },
      send: async () => 'om_grand_mention',
    });
    const grand = await resolveDispatchUser({ dataDir: h.world.dataDir, secret: SECRET, appId: 'cli_b', chatId: CHAT, turnId: 'om_grand_mention', waitMs: 0 });
    await revokeWorkflowHandoff(h.world.dataDir, SECRET, nonceOf(h.attempt), 'runCancelled');
    expect(workflowDelegationRefusal({
      record: grand as any, turnId: 'om_grand_mention', receiverLarkAppId: 'cli_b', chatId: CHAT, marker: undefined,
      registry: readDispatchRegistryLoose(h.world.dataDir), secret: SECRET, baseDir: h.run.base,
    })).toBe('handoff_revoked');
  });

  it.each([
    ['a bot outside the approved set', 'cli_c', {}],
    ['another chat', 'cli_b', { chatId: 'oc_elsewhere' }],
    ['a person this bot cannot vouch for here', 'cli_b', { allowed: false }],
  ] as const)('to %s: the dispatch goes ahead without the initiator (not refused)', async (_label, target, opts) => {
    const h = await receiver({ alsoApproved: ['cli_b'] });
    expect(await passOn(h, target, opts)).toEqual({ inherit: false });
  });

  it('to a bot in someone else\'s unconfirmed flow edit: not passed on, not honoured; once the initiator confirms it, both', async () => {
    const h = await receiver();
    expect(applyV3RunEdit({
      baseDir: h.run.base, runId: h.run.dag.runId, baseRevision: 1, caller: { openId: 'ou_member_in_main', origin: 'human' },
      patch: [{ op: 'addNode', node: { id: 'check', type: 'goal', goal: 'check the report', bot: 'cli_c', depends: [], inputs: [] } }],
      resolveNewBotSnapshot: snapshotFor,
    })).toMatchObject({ kind: 'proposed', reasons: ['callerNotInitiator', 'newBot'] });
    expect(await passOn(h, 'cli_c')).toEqual({ inherit: false });
    // A record passed on to cli_c regardless is refused there, by the same scope.
    const inherited = await h.fns.dispatchUserForTurn(h.ds, h.handoff);
    await deliverDispatchWithUser({
      dataDir: h.world.dataDir, secret: SECRET,
      payload: { sourceAppId: 'cli_a', sourceSessionId: SESSION, sourceTurnId: h.handoff, rootId: 'om_c_root', chatId: CHAT,
        targetAppIds: ['cli_c'], authority: { ...inherited.authority }, workflow: { ...inherited.workflow, hop: 1 } },
      send: async () => 'om_c_msg',
    });
    const record = await resolveDispatchUser({ dataDir: h.world.dataDir, secret: SECRET, appId: 'cli_c', chatId: CHAT, rootId: 'om_c_root', turnId: 'om_c_msg', waitMs: 0 });
    const refusal = () => workflowDelegationRefusal({
      record: record as any, turnId: 'om_c_msg', receiverLarkAppId: 'cli_c', chatId: CHAT, marker: undefined,
      registry: readDispatchRegistryLoose(h.world.dataDir), secret: SECRET, baseDir: h.run.base,
    });
    expect(refusal()).toBe('bot_not_approved');

    expect(decideV3RevisionProposal({ baseDir: h.run.base, runId: h.run.dag.runId, revision: 2, decision: 'approve', by: INITIATOR_MAIN_OU }))
      .toMatchObject({ kind: 'approved' });
    expect(await passOn(h, 'cli_c')).toEqual({ inherit: true, workflow: expect.objectContaining({ attemptId: h.attempt.attemptId, hop: 1 }) });
    expect(refusal()).toBeUndefined();
  });

  it('stops passing on after 16 hops', async () => {
    const h = await receiver({ alsoApproved: ['cli_b'] });
    const inherited = await h.fns.dispatchUserForTurn(h.ds, h.handoff);
    expect(await inheritWorkflowDelegation({
      inherited: { ...inherited, workflow: { ...inherited.workflow, hop: 16 } }, targetAppIds: ['cli_b'], chatId: CHAT,
      baseDir: h.run.base, targetUserAllowed: async () => true,
    })).toEqual({ inherit: false });
  });
});

// ─── passed on into a session that keeps identities in files ────────────────

/** Run the REAL rendered single-model bytedcli wrapper of `sessionId` with a
 *  fake binary that prints the JWT it was handed. */
function runFileWrapper(dataDir: string, sessionId: string): string {
  const dir = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'wf-id-wrap-'));
  try {
    const fake = nodePath.join(dir, 'real-bytedcli');
    fs.writeFileSync(fake, '#!/bin/sh\necho "RAN jwt=${BYTEDCLI_USER_CLOUD_JWT:-none}"\n', { mode: 0o755 });
    const wrapper = nodePath.join(dir, 'bytedcli');
    fs.writeFileSync(wrapper, renderIdentityWrapper('bytedcli', fake, 'single'), { mode: 0o755 });
    try {
      return execFileSync('/bin/sh', [wrapper, 'tce', 'list'], {
        env: { PATH: '/usr/bin:/bin', HOME: dir, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (err: any) {
      return `${String(err.stdout ?? '')}${String(err.stderr ?? '')}`.trim();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('a passed-on workflow delegation is only honoured where every use is re-checked', () => {
  /** cli_a's node session dispatches to cli_b (approved, a member); cli_b's
   *  session stores identities as `model`. */
  async function grandchild(model: 'single' | 'proven') {
    const h = await receiver({ alsoApproved: ['cli_b'] });
    h.members.add(INITIATOR_OU_IN.cli_b!);
    h.scope.getBot = (appId: string) => ({ config: botConfig(appId, ['lark-cli', 'bytedcli']) });
    const inherited = await h.fns.dispatchUserForTurn(h.ds, h.handoff);
    const passed = await inheritWorkflowDelegation({
      inherited, targetAppIds: ['cli_b'], chatId: CHAT, baseDir: h.run.base, targetUserAllowed: async () => true,
    });
    if (!passed.inherit) throw new Error('expected the delegation to be passed on');
    const authority = await authorityForDispatch({
      sourceAppId: 'cli_a', tools: ['lark-cli', 'bytedcli'], inherited: inherited.authority, resolveUnionId: async () => null,
    });
    await deliverDispatchWithUser({
      dataDir: h.world.dataDir, secret: SECRET,
      payload: { sourceAppId: 'cli_a', sourceSessionId: SESSION, sourceTurnId: h.handoff, rootId: 'om_groot',
        chatId: CHAT, targetAppIds: ['cli_b'], authority: authority!, workflow: passed.workflow },
      send: async () => 'om_gmsg',
    });
    const sessionId = `sess-grand-${model}`;
    const ds: any = {
      larkAppId: 'cli_b', chatId: CHAT, chatType: 'group', scope: 'thread',
      session: { sessionId, rootMessageId: 'om_groot', replyTargets: {
        om_gmsg: { senderOpenId: 'ou_a_in_b', rootMessageId: 'om_groot', participants: [{ openId: 'ou_a_in_b', isBot: true }], updatedAt: new Date().toISOString() },
      } },
    };
    h.scope.identityStorageModelForDaemonSession = () => model;
    bytedcliJwts.set(INITIATOR_MAIN_OU, { cloudJwt: 'JWT-ALICE' });
    return { h, ds, sessionId };
  }

  it('file-stored session: an explicit refusal is published, never the credentials (nothing could withdraw them later)', async () => {
    const { h, ds, sessionId } = await grandchild('single');
    await h.fns.refreshTurnCliIdentity(ds, 'om_gmsg');
    publishActiveTurn(h.world.dataDir, sessionId, 'om_gmsg', 1, 'ou_a_in_b');
    const out = runFileWrapper(h.world.dataDir, sessionId);
    expect(out).not.toContain('JWT-ALICE');
    expect(out).not.toMatch(/RAN/);
    expect(out).toContain('passed on by another bot');
    expect(h.scope.resolveTargetAppOpenId).not.toHaveBeenCalledWith('cli_b', INITIATOR_UNION);
  });

  it('file-stored session: the node bot\'s own handoff still carries the identity there (only passed-on records are refused)', async () => {
    const h = await receiver();
    h.scope.identityStorageModelForDaemonSession = () => 'single';
    bytedcliJwts.set(INITIATOR_MAIN_OU, { cloudJwt: 'JWT-ALICE' });
    await h.fns.refreshTurnCliIdentity(h.ds, h.handoff);
    publishActiveTurn(h.world.dataDir, SESSION, h.handoff, 1, MAIN_BOT_IN_A);
    expect(runFileWrapper(h.world.dataDir, SESSION)).toContain('RAN jwt=JWT-ALICE');
  });

  it('re-checked session: honoured, and ends the moment the handoff is revoked', async () => {
    const { h, ds, sessionId } = await grandchild('proven');
    await h.fns.refreshTurnCliIdentity(ds, 'om_gmsg');
    expect(currentLarkToolDelegation(h.world.dataDir, sessionId, 'om_gmsg')).toMatchObject({ targetOpenId: INITIATOR_OU_IN.cli_b });
    expect(recallProvenIdentityContent(h.world.dataDir, sessionId, 'om_gmsg', 'bytedcli')).toContain('JWT-ALICE');
    await revokeWorkflowHandoff(h.world.dataDir, SECRET, nonceOf(h.attempt), 'runCancelled');
    expect(currentLarkToolDelegation(h.world.dataDir, sessionId, 'om_gmsg')).toMatchObject({ denialReason: 'delegation_inactive', tools: [] });
    clearLarkToolDelegations(h.world.dataDir, sessionId);
  });
});

describe('passing on: every target must be approved, and the identity must still be the main bot\'s', () => {
  it('one unapproved bot among the targets: nothing is passed on', async () => {
    const h = await receiver({ alsoApproved: ['cli_b'] });
    const inherited = await h.fns.dispatchUserForTurn(h.ds, h.handoff);
    expect(await inheritWorkflowDelegation({
      inherited, targetAppIds: ['cli_b', 'cli_c'], chatId: CHAT, baseDir: h.run.base, targetUserAllowed: async () => true,
    })).toEqual({ inherit: false });
    expect(await inheritWorkflowDelegation({
      inherited, targetAppIds: ['cli_c', 'cli_b'], chatId: CHAT, baseDir: h.run.base, targetUserAllowed: async () => true,
    })).toEqual({ inherit: false });
  });

  it('a passed-on record whose authority is not the main bot\'s frozen one is refused on receipt', async () => {
    const h = await receiver({ alsoApproved: ['cli_b'] });
    const inherited = await h.fns.dispatchUserForTurn(h.ds, h.handoff);
    await deliverDispatchWithUser({
      dataDir: h.world.dataDir, secret: SECRET,
      payload: { sourceAppId: 'cli_a', sourceSessionId: SESSION, sourceTurnId: h.handoff, rootId: 'om_r4', chatId: CHAT,
        targetAppIds: ['cli_b'], authority: { ...inherited.authority, appId: 'cli_a' }, workflow: { ...inherited.workflow, hop: 1 } },
      send: async () => 'om_m4',
    });
    const record = await resolveDispatchUser({ dataDir: h.world.dataDir, secret: SECRET, appId: 'cli_b', chatId: CHAT, rootId: 'om_r4', turnId: 'om_m4', waitMs: 0 });
    expect(workflowDelegationRefusal({
      record: record as any, turnId: 'om_m4', receiverLarkAppId: 'cli_b', chatId: CHAT, marker: undefined,
      registry: readDispatchRegistryLoose(h.world.dataDir), secret: SECRET, baseDir: h.run.base,
    })).toBe('identity_mismatch');
  });
});
