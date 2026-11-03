/**
 * 交接带发起人身份 (design 2026-11-03 §10, D5): a bot-executed run that was
 * authorized with the switch on freezes its initiator into run.json, and the
 * main bot's daemon signs EVERY handoff from that record (star issuance) —
 * after the target bot's own check of the initiator, narrowed to the tools the
 * initiator had on the main bot. A target with trigger-user auth that cannot
 * carry the initiator blocks IDENTITY_UNAVAILABLE before anything is sent;
 * the receiver honours a delegation only while its handoff attempt is live.
 * With the switch off nothing is frozen, signed or sent differently.
 *
 * Real components: run envelope + artifacts, runtime, WorkflowNodeDaemon
 * (executor, identity plan, signing), dispatch-user store, handoff binding
 * registry. Fakes: Lark, host IPC, each app's contact directory / members.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BotRun,
  cleanupBotRuns,
  expectAwaitingExternal,
  expectTerminal,
  reportDag,
  reportFiles,
} from './helpers/v3-external-harness.js';
import { handoffWorld, nonceOf } from './helpers/workflow-handoff-harness.js';
import {
  BINDING,
  CHAT,
  INITIATOR_MAIN_OU,
  INITIATOR_OU_IN,
  INITIATOR_UNION,
  MAIN,
  SECRET,
  authorizeRun,
  driveWith,
  identityWorld,
  policy,
} from './helpers/workflow-identity-world.js';
import {
  DISPATCH_USER_WORKFLOW_DOMAIN,
  deliverDispatchWithUser,
  dispatchUserStorePath,
  resolveDispatchUser,
  verifyDispatchUser,
  type DispatchUserPayload,
  type WorkflowDispatchUserPayload,
} from '../src/core/dispatch-user-delegation.js';
import {
  approvedWorkflowBots,
  checkWorkflowHandoffIdentityTarget,
  deliverWorkflowHandoffWithUser,
  planWorkflowHandoffIdentity,
  workflowDelegationRefusal,
  type WorkflowHandoffIdentityRun,
} from '../src/core/workflow-handoff-identity.js';
import { readDispatchRegistryLoose, recordWorkflowHandoffBinding, createWorkflowHandoffBinding, linkWorkflowHandoffMessage } from '../src/core/workflow-handoff-binding.js';
import { workflowNodeMarkerFromBinding } from '../src/core/workflow-node-session.js';
import { lookupWorkflowHandoff } from '../src/core/workflow-handoff-binding.js';
import { reportExternalBlocked } from '../src/workflows/v3/external-control.js';
import { requestV3Retry, requestV3RunCancel } from '../src/workflows/v3/daemon-run.js';
import { validateDag } from '../src/workflows/v3/dag.js';
import {
  frozenHandoffIdentity,
  loadAuthorizedV3Run,
  validateRunEnvelope,
  RunEnvelopeValidationError,
} from '../src/workflows/v3/run-envelope.js';
import type { StoredEvent } from '../src/workflows/v3/journal.js';

afterEach(() => cleanupBotRuns());

const FROZEN = { unionId: INITIATOR_UNION, tools: ['lark-cli', 'bytedcli'] as Array<'lark-cli' | 'bytedcli'> };

function store(dataDir: string): Record<string, unknown> {
  const path = dispatchUserStorePath(dataDir);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {};
}

/** The verified delegation bound to `messageId`, or undefined. */
function boundRecord(dataDir: string, messageId: string): DispatchUserPayload | undefined {
  return verifyDispatchUser(SECRET, store(dataDir)[messageId]);
}

/** What the target daemon sees for the delivered handoff (marker = what its
 *  session registers after verifying the card's binding). */
function receiverInputs(world: { dataDir: string }, run: BotRun, attempt: ReturnType<BotRun['openAttempt']>, target = 'cli_a') {
  const registry = readDispatchRegistryLoose(world.dataDir);
  const found = lookupWorkflowHandoff({ registry, dispatchRoot: attempt.handoffMessageId!, secret: SECRET });
  if (found.kind !== 'workflow') throw new Error(`no binding: ${found.kind}`);
  const record = boundRecord(world.dataDir, attempt.handoffMessageId!) as WorkflowDispatchUserPayload;
  return {
    record,
    turnId: attempt.handoffMessageId!,
    receiverLarkAppId: target,
    chatId: CHAT,
    marker: workflowNodeMarkerFromBinding(found.binding, attempt.handoffMessageId!),
    registry,
    secret: SECRET,
    baseDir: run.base,
  };
}

// ─── run.json ──────────────────────────────────────────────────────────────

describe('run.json freezes the initiator next to the approval', () => {
  function authorizedEnvelope(run: BotRun) {
    return loadAuthorizedV3Run(run.runDir).envelope;
  }

  it('reads back the initiator (main-app open_id from the approval) with union_id and tools', () => {
    const run = new BotRun(reportDag('env-frozen'));
    authorizeRun(run, { identity: FROZEN });
    expect(frozenHandoffIdentity(authorizedEnvelope(run))).toEqual({
      openId: INITIATOR_MAIN_OU, unionId: INITIATOR_UNION, tools: ['lark-cli', 'bytedcli'],
    });
  });

  it('an envelope authorized with the switch off has no identity (and still validates)', () => {
    const run = new BotRun(reportDag('env-off'));
    authorizeRun(run, { identity: null });
    const envelope = authorizedEnvelope(run);
    expect(frozenHandoffIdentity(envelope)).toBeUndefined();
    expect(envelope.authorization).not.toHaveProperty('handoffIdentity');
  });

  it('an identity without a bot executor or without the authenticated initiator is invalid', () => {
    const run = new BotRun(reportDag('env-invalid'));
    authorizeRun(run, { identity: FROZEN });
    const raw = JSON.parse(readFileSync(join(run.runDir, 'run.json'), 'utf-8'));
    const { nodeExecutor: _drop, ...noExecutor } = raw;
    expect(() => validateRunEnvelope(noExecutor)).toThrow(RunEnvelopeValidationError);
    const noInitiator = { ...raw, authorization: { ...raw.authorization } };
    delete noInitiator.authorization.authorizedByOpenId;
    expect(() => validateRunEnvelope(noInitiator)).toThrow(RunEnvelopeValidationError);
    expect(() => validateRunEnvelope({ ...raw, authorization: { ...raw.authorization, handoffIdentity: { unionId: 'ou_not_union', tools: [] } } }))
      .toThrow(RunEnvelopeValidationError);
  });
});

// ─── signing at the main bot ───────────────────────────────────────────────

describe('each handoff is signed by the main bot from the run (star issuance)', () => {
  it('managed-Agent: the record carries the union_id and the issuer-app open_id only; the target resolves its own', async () => {
    const run = new BotRun(reportDag('id-sign'));
    const world = identityWorld();
    const snapshots = authorizeRun(run, { identity: FROZEN });
    expectAwaitingExternal(await driveWith(run, world, snapshots));
    const attempt = run.openAttempt('write');

    // The target's own check got the union_id, never the main app's open_id.
    expect(world.identityChecks).toEqual([{
      target: 'cli_a',
      body: { chatId: CHAT, unionId: INITIATOR_UNION, tools: ['lark-cli', 'bytedcli'], sourceLarkAppId: MAIN },
    }]);
    expect(JSON.stringify(world.identityChecks)).not.toContain('ou_');

    const record = boundRecord(world.dataDir, attempt.handoffMessageId!);
    expect(record).toMatchObject({
      domain: DISPATCH_USER_WORKFLOW_DOMAIN,
      sourceAppId: MAIN,
      chatId: CHAT,
      rootId: attempt.nodeCardMessageId,
      targetAppIds: ['cli_a'],
      messageId: attempt.handoffMessageId,
      workflow: {
        runId: 'id-sign', nodeId: 'write', attemptId: attempt.attemptId, revision: 1, nonce: nonceOf(attempt),
      },
      // openId is the issuing (main) app's view: a credential-store key there,
      // never presented to cli_a, which resolves the union_id itself.
      authority: { appId: MAIN, openId: INITIATOR_MAIN_OU, unionId: INITIATOR_UNION, tools: ['lark-cli', 'bytedcli'] },
    });
    expect(JSON.stringify(store(world.dataDir))).not.toContain(INITIATOR_OU_IN.cli_a);

    // The receiver finds it for exactly this message, chat and topic …
    expect(await resolveDispatchUser({
      dataDir: world.dataDir, secret: SECRET, appId: 'cli_a', chatId: CHAT,
      rootId: attempt.nodeCardMessageId, turnId: attempt.handoffMessageId!, waitMs: 0,
    })).toMatchObject({ messageId: attempt.handoffMessageId });
    // … and the workflow checks hold while the attempt is live.
    expect(workflowDelegationRefusal(receiverInputs(world, run, attempt))).toBeUndefined();
  });

  it('switch off at approval: nothing is signed and the cards are byte-identical to the feature-less path', async () => {
    const run = new BotRun(reportDag('id-off'));
    const world = identityWorld();
    const snapshots = authorizeRun(run, { identity: null });
    await driveWith(run, world, snapshots);
    expect(world.identityChecks).toEqual([]);
    expect(existsSync(dispatchUserStorePath(world.dataDir))).toBe(false);

    // The same authorized run through an executor built without the feature.
    const baselineRun = new BotRun(reportDag('id-off'));
    const baselineSnapshots = authorizeRun(baselineRun, { identity: null });
    const baseline = handoffWorld();
    baseline.members.set('cli_a', { ok: true, openId: 'ou_bot_cli_a' });
    await baselineRun.drive(baseline.executor, {
      opts: { chatBinding: BINDING, authorizedArtifacts: true, frozenBotSnapshots: baselineSnapshots },
    });
    const shape = (lark: typeof world.lark) => ({
      sent: lark.sent.map(({ chatId, card }) => ({ chatId, card })),
      replies: lark.replies.map(({ card }) => card),
      patches: lark.patches.map(({ card }) => card),
    });
    // uuids / nonces differ per run; compare with them normalized away.
    const norm = (value: unknown, run_: BotRun) => JSON.stringify(value)
      .replaceAll(run_.openAttempt('write').idempotency!.handoff, 'UUID')
      .replaceAll(nonceOf(run_.openAttempt('write')), 'NONCE');
    expect(norm(shape(world.lark), run)).toBe(norm(shape(baseline.lark), baselineRun));
  });

  it('a target that runs no tool as its trigger user is handed off without any delegation', async () => {
    const run = new BotRun(reportDag('id-not-required', { bot: 'cli_b' }));
    const world = identityWorld();
    const snapshots = authorizeRun(run, { identity: FROZEN, selectors: ['cli_b'] });
    expectAwaitingExternal(await driveWith(run, world, snapshots));
    expect(run.openAttempt('write').phase).toBe('sent');
    expect(world.identityChecks).toEqual([]);
    expect(existsSync(dispatchUserStorePath(world.dataDir))).toBe(false);
  });

  it.each([
    ['the initiator left the chat', (world: ReturnType<typeof identityWorld>) => { world.members.get('cli_a')!.clear(); }, '已不在本群'],
    ['the target cannot check right now', (world: ReturnType<typeof identityWorld>) => { world.directoryDown.add('cli_a'); }, '暂时无法'],
    ['the target governs none of the frozen tools', (world: ReturnType<typeof identityWorld>) => { world.policies.set('cli_a', policy(['bytedcli'])); }, '没有可交给'],
  ])('%s: IDENTITY_UNAVAILABLE before anything is sent, never a send without the initiator', async (_label, arrange, text) => {
    const run = new BotRun(reportDag(`id-refuse-${text.length}`));
    const world = identityWorld();
    const snapshots = authorizeRun(run, { identity: { unionId: INITIATOR_UNION, tools: ['lark-cli'] } });
    arrange(world);
    expect(expectTerminal(await driveWith(run, world, snapshots)).runStatus).toBe('blocked');
    expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({
      errorCode: 'IDENTITY_UNAVAILABLE', message: expect.stringContaining(text),
    })]);
    expect(world.lark.sent).toEqual([]);
    expect(world.lark.replies).toEqual([]);
    expect(store(world.dataDir)).toEqual({});
  });

  it('tools only narrow: frozen ceiling ∩ what the main bot governs now ∩ what the target governs', async () => {
    const run = new BotRun(reportDag('id-narrow'));
    const world = identityWorld();
    const snapshots = authorizeRun(run, { identity: FROZEN });
    world.policies.set(MAIN, policy(['lark-cli'])); // the main bot dropped bytedcli after approval
    await driveWith(run, world, snapshots);
    const attempt = run.openAttempt('write');
    expect(world.identityChecks[0]!.body.tools).toEqual(['lark-cli']);
    expect(boundRecord(world.dataDir, attempt.handoffMessageId!)!.authority.tools).toEqual(['lark-cli']);
  });

  it('the main bot\'s own node carries the delegation into its in-process turn (own check, no IPC)', async () => {
    const run = new BotRun(validateDag({
      schemaVersion: 2, runId: 'id-self', nodes: [{ id: 'write', type: 'goal', goal: 'summarize', timeoutSec: 600 }],
    }));
    const world = identityWorld();
    const snapshots = authorizeRun(run, { identity: FROZEN, selectors: [''] });
    // snapshotFor('') maps the default selector to the main bot.
    await driveWith(run, world, snapshots);
    const attempt = run.openAttempt('write');
    expect(attempt.targetLarkAppId).toBe(MAIN);
    expect(world.identityChecks).toEqual([]);
    expect(world.selfTurns).toEqual([expect.objectContaining({ handoffMessageId: attempt.handoffMessageId, identityDelegated: true })]);
    expect(boundRecord(world.dataDir, attempt.handoffMessageId!)).toMatchObject({ targetAppIds: [MAIN] });
    expect(workflowDelegationRefusal(receiverInputs(world, run, attempt, MAIN))).toBeUndefined();
  });

  it('a same-key re-send after an unknown failure binds one record to the one delivered handoff', async () => {
    const run = new BotRun(reportDag('id-resend'));
    const world = identityWorld();
    const snapshots = authorizeRun(run, { identity: FROZEN });
    world.lark.failNextReply = true;
    await driveWith(run, world, snapshots);
    expect(run.openAttempt('write').phase).toBe('prepared');
    run.clock.t += 60_000;
    await driveWith(run, world, snapshots);
    const attempt = run.openAttempt('write');
    expect(attempt.phase).toBe('sent');
    const records = Object.keys(store(world.dataDir));
    expect(records).toEqual([attempt.handoffMessageId]); // no pending left behind
  });

  it('a Lark re-send answered with an already-bound message re-binds that same handoff (and only it)', async () => {
    const run = new BotRun(reportDag('id-rebind'));
    const world = identityWorld();
    const snapshots = authorizeRun(run, { identity: FROZEN });
    await driveWith(run, world, snapshots);
    const attempt = run.openAttempt('write');
    const first = boundRecord(world.dataDir, attempt.handoffMessageId!) as WorkflowDispatchUserPayload;
    const again = {
      dataDir: world.dataDir, secret: SECRET, sourceLarkAppId: MAIN, targetLarkAppId: 'cli_a', chatId: CHAT,
      rootId: first.rootId, workflow: first.workflow, authority: first.authority,
      send: async () => attempt.handoffMessageId!,
    };
    await deliverWorkflowHandoffWithUser(again);
    expect(Object.keys(store(world.dataDir))).toEqual([attempt.handoffMessageId]);
    // Another attempt (or a plain dispatch) can never take over that message.
    await expect(deliverWorkflowHandoffWithUser({ ...again, workflow: { ...first.workflow, attemptId: 'write#001/attempts/009' } }))
      .rejects.toThrow('duplicate dispatch message identity');
    await expect(deliverDispatchWithUser({
      dataDir: world.dataDir, secret: SECRET,
      payload: { sourceAppId: MAIN, sourceSessionId: 's', sourceTurnId: 't', rootId: first.rootId, chatId: CHAT, targetAppIds: ['cli_a'], authority: first.authority },
      send: async () => attempt.handoffMessageId!,
    })).rejects.toThrow('duplicate dispatch message identity');
  });

  it('multi-hop: a retry after the node reported blocked is signed afresh from the run, never from the report', async () => {
    const run = new BotRun(reportDag('id-retry'));
    const world = identityWorld();
    const snapshots = authorizeRun(run, { identity: FROZEN });
    await driveWith(run, world, snapshots);
    const first = run.openAttempt('write');
    const firstInputs = receiverInputs(world, run, first);
    expect(reportExternalBlocked(run.runDir, { attemptId: first.attemptId, reason: 'need data' })).toEqual({ ok: true });
    expect(expectTerminal(await driveWith(run, world, snapshots)).runStatus).toBe('blocked');
    // The first handoff's delegation ended with its attempt.
    expect(workflowDelegationRefusal(firstInputs)).toBe('attempt_inactive');

    world.members.get('cli_a')!.clear(); // revoked in between: the next hop re-checks
    expect(requestV3Retry(run.base, run.dag.runId, { nodeId: 'write' })).toMatchObject({ kind: 'requested' });
    expect(expectTerminal(await driveWith(run, world, snapshots)).runStatus).toBe('blocked');
    expect(run.of('nodeBlocked').at(-1)).toMatchObject({ errorCode: 'IDENTITY_UNAVAILABLE' });

    world.members.get('cli_a')!.add(INITIATOR_OU_IN.cli_a!);
    expect(requestV3Retry(run.base, run.dag.runId, { nodeId: 'write' })).toMatchObject({ kind: 'requested' });
    await driveWith(run, world, snapshots);
    const third = run.openAttempt('write');
    const record = boundRecord(world.dataDir, third.handoffMessageId!) as WorkflowDispatchUserPayload;
    expect(record.workflow.attemptId).toBe(third.attemptId);
    expect(record.workflow.nonce).toBe(nonceOf(third));
    expect(record.authority).toEqual(boundRecord(world.dataDir, first.handoffMessageId!)!.authority);
    expect(workflowDelegationRefusal(receiverInputs(world, run, third))).toBeUndefined();
  });
});

// ─── receiver checks ───────────────────────────────────────────────────────

describe('the receiver honours a workflow delegation only while its handoff holds', () => {
  async function delivered(runId: string) {
    const run = new BotRun(reportDag(runId));
    const world = identityWorld();
    const snapshots = authorizeRun(run, { identity: FROZEN });
    await driveWith(run, world, snapshots);
    const attempt = run.openAttempt('write');
    return { run, world, snapshots, attempt, inputs: receiverInputs(world, run, attempt) };
  }

  it('a cancelled run revokes the handoff: its delegation ends', async () => {
    const { run, world, snapshots, inputs } = await delivered('rcv-cancel');
    requestV3RunCancel(run.base, run.dag.runId, { by: INITIATOR_MAIN_OU });
    expect(expectTerminal(await driveWith(run, world, snapshots)).runStatus).toBe('cancelled');
    expect(workflowDelegationRefusal({ ...inputs, registry: readDispatchRegistryLoose(world.dataDir) })).toBe('handoff_revoked');
  });

  it('a timed-out attempt ends it too', async () => {
    const { run, world, snapshots, attempt, inputs } = await delivered('rcv-timeout');
    run.accept(attempt.attemptId, 'sess-a');
    run.clock.t = run.openAttempt('write').deadlineAt!;
    expect(expectTerminal(await driveWith(run, world, snapshots)).runStatus).toBe('blocked');
    expect(workflowDelegationRefusal({ ...inputs, registry: readDispatchRegistryLoose(world.dataDir) })).toBe('handoff_revoked');
  });

  it('a completed node ends it (the run attempt is no longer live)', async () => {
    const { run, attempt, inputs } = await delivered('rcv-done');
    run.accept(attempt.attemptId, 'sess-a');
    expect(await run.submit(attempt.attemptId, { sessionId: 'sess-a', ...reportFiles() })).toMatchObject({ ok: true });
    expect(workflowDelegationRefusal(inputs)).toBe('attempt_inactive');
  });

  it.each([
    ['another session\'s handoff', { marker: undefined }],
    ['a different message', { turnId: 'om_other' }],
    ['another chat', { chatId: 'oc_other' }],
    ['another bot', { receiverLarkAppId: 'cli_b' }],
  ])('refuses %s', async (_label, patch) => {
    const { inputs } = await delivered(`rcv-${_label.length}`);
    expect(workflowDelegationRefusal({ ...inputs, ...patch } as typeof inputs)).toBe('not_this_handoff');
  });

  it('refuses a record for another topic of the run', async () => {
    const { inputs } = await delivered('rcv-topic');
    expect(workflowDelegationRefusal({ ...inputs, record: { ...inputs.record, rootId: 'om_other_topic' } })).toBeDefined();
  });

  it('refuses a record that names a different initiator or a tool beyond the frozen ones', async () => {
    const { inputs } = await delivered('rcv-identity');
    expect(workflowDelegationRefusal({ ...inputs, record: { ...inputs.record, authority: { ...inputs.record.authority, unionId: 'on_mallory' } } }))
      .toBe('identity_mismatch');
    const narrowRun = new BotRun(reportDag('rcv-tools'));
    const world = identityWorld();
    const snapshots = authorizeRun(narrowRun, { identity: { unionId: INITIATOR_UNION, tools: ['lark-cli'] } });
    await driveWith(narrowRun, world, snapshots);
    const narrow = receiverInputs(world, narrowRun, narrowRun.openAttempt('write'));
    expect(workflowDelegationRefusal({ ...narrow, record: { ...narrow.record, authority: { ...narrow.record.authority, tools: ['lark-cli', 'bytedcli'] } } }))
      .toBe('identity_mismatch');
  });

  it('refuses a bot the initiator did not approve, even with a matching handoff binding', async () => {
    // cli_a is the only approved bot; forge (with the host key) a full set of
    // records naming cli_b for the same attempt, as a buggy future path might.
    const { run, world, attempt, inputs } = await delivered('rcv-approved');
    const nonce = 'wfh_' + 'b'.repeat(24);
    const binding = createWorkflowHandoffBinding(SECRET, {
      nonce, publishRoot: attempt.nodeCardMessageId!, targetLarkAppId: 'cli_b', targetChatId: CHAT, sourceLarkAppId: MAIN,
      workflow: {
        runId: run.dag.runId, nodeId: 'write', attemptId: attempt.attemptId, revision: 1,
        ...(attempt.instanceId ? { instanceId: attempt.instanceId } : {}),
      },
    });
    await recordWorkflowHandoffBinding(world.dataDir, SECRET, binding);
    await linkWorkflowHandoffMessage(world.dataDir, SECRET, nonce, 'om_forged');
    const record = { ...inputs.record, messageId: 'om_forged', targetAppIds: ['cli_b'], workflow: { ...inputs.record.workflow, nonce } };
    expect(workflowDelegationRefusal({
      ...inputs,
      record,
      turnId: 'om_forged',
      receiverLarkAppId: 'cli_b',
      marker: workflowNodeMarkerFromBinding(binding.payload, 'om_forged'),
      registry: readDispatchRegistryLoose(world.dataDir),
    })).toBe('bot_not_approved');
  });
});

// ─── pieces ────────────────────────────────────────────────────────────────

describe('approved bots', () => {
  const loaded = { botSnapshots: { cli_a: { larkAppId: 'cli_a', cliId: 'claude-code', workingDir: '/tmp' } } };
  const reassigned = (by: string): StoredEvent => ({ type: 'nodeReassigned', nodeId: 'write', from: 'cli_a', to: 'cli_x', by, seq: 1, ts: '' } as unknown as StoredEvent);

  it('are the bots approval assigned, plus a bot the initiator reassigned a node to themselves', () => {
    expect([...approvedWorkflowBots(loaded, [], INITIATOR_MAIN_OU)]).toEqual(['cli_a']);
    expect([...approvedWorkflowBots(loaded, [reassigned(INITIATOR_MAIN_OU)], INITIATOR_MAIN_OU)]).toEqual(['cli_a', 'cli_x']);
  });

  it('anyone else\'s reassignment never adds a bot', () => {
    expect([...approvedWorkflowBots(loaded, [reassigned('ou_someone_else'), reassigned('main_bot')], INITIATOR_MAIN_OU)]).toEqual(['cli_a']);
  });
});

describe('the signing plan', () => {
  const run: WorkflowHandoffIdentityRun = {
    identity: { openId: INITIATOR_MAIN_OU, unionId: INITIATOR_UNION, tools: ['lark-cli', 'bytedcli'] },
    approvedBots: new Set(['cli_a']),
    chatId: CHAT,
    sourceLarkAppId: MAIN,
  };
  const plan = (overrides: Partial<Parameters<typeof planWorkflowHandoffIdentity>[0]> = {}) => {
    const offered: string[][] = [];
    const result = planWorkflowHandoffIdentity({
      run,
      sourceLarkAppId: MAIN,
      targetLarkAppId: 'cli_a',
      sourceBotTools: ['lark-cli', 'bytedcli'],
      botName: (appId) => appId,
      check: async (tools) => { offered.push(tools); return { status: 'ok', tools }; },
      ...overrides,
    });
    return { result, offered };
  };

  it('nothing frozen: no delegation and no check', async () => {
    const { result, offered } = plan({ run: undefined });
    expect(await result).toEqual({ kind: 'none' });
    expect(offered).toEqual([]);
  });

  it('a bot outside the approved set is offered nothing, so a governing target refuses', async () => {
    const offered: string[][] = [];
    const { result } = plan({
      targetLarkAppId: 'cli_x',
      check: async (tools) => { offered.push(tools); return tools.length ? { status: 'ok', tools } : { status: 'denied', reason: 'no_shared_tool' }; },
    });
    expect(await result).toMatchObject({ kind: 'reject', message: expect.stringContaining('不是发起人批准时选定的 Bot') });
    expect(offered).toEqual([[]]);
  });

  it('a target answering with more than it was offered is narrowed back', async () => {
    const { result } = plan({ sourceBotTools: ['lark-cli'], check: async () => ({ status: 'ok', tools: ['lark-cli', 'bytedcli'] }) });
    expect(await result).toMatchObject({ kind: 'sign', authority: { tools: ['lark-cli'] } });
  });

  it('a failing check refuses (fail closed)', async () => {
    const { result } = plan({ check: async () => { throw new Error('ipc down'); } });
    expect(await result).toMatchObject({ kind: 'reject', message: expect.stringContaining('ipc down') });
  });
});

describe('the target\'s own check', () => {
  const run = (policyTools: Array<'lark-cli' | 'bytedcli'> | null, offered: Array<'lark-cli' | 'bytedcli'>, targetUser: () => Promise<string | undefined>) =>
    checkWorkflowHandoffIdentityTarget({ policy: policy(policyTools), offeredTools: offered, targetUser });

  it('no trigger-user auth: nothing required, nothing looked up', async () => {
    let asked = 0;
    expect(await run(null, ['lark-cli'], async () => { asked++; return 'ou_x'; })).toEqual({ status: 'not_required' });
    expect(asked).toBe(0);
  });

  it('accepts only governed ∩ offered tools for a resolvable member', async () => {
    expect(await run(['bytedcli'], ['lark-cli', 'bytedcli'], async () => 'ou_x')).toEqual({ status: 'ok', tools: ['bytedcli'] });
  });

  it('denies without a shared tool, or when the person does not pass; unavailable when the check throws', async () => {
    expect(await run(['bytedcli'], ['lark-cli'], async () => 'ou_x')).toMatchObject({ status: 'denied', reason: 'no_shared_tool' });
    expect(await run(['lark-cli'], ['lark-cli'], async () => undefined)).toEqual({ status: 'denied', reason: 'target_access_denied' });
    expect(await run(['lark-cli'], ['lark-cli'], async () => { throw new Error('members > 2000'); }))
      .toEqual({ status: 'unavailable', detail: 'members > 2000' });
  });
});

describe('the identity-check route', () => {
  it('rejects a request carrying anything but a union_id, chat, tools and source app', async () => {
    const world = identityWorld();
    for (const body of [
      { chatId: CHAT, unionId: INITIATOR_MAIN_OU, tools: [], sourceLarkAppId: MAIN }, // an open_id is not accepted
      { chatId: 'x', unionId: INITIATOR_UNION, tools: [], sourceLarkAppId: MAIN },
      { chatId: CHAT, unionId: INITIATOR_UNION, tools: ['lark-cli', 'lark-cli'], sourceLarkAppId: MAIN },
    ]) {
      expect(await world.main.identityCheckRoute(body)).toMatchObject({ status: 400 });
    }
    expect(await world.main.identityCheckRoute({ chatId: CHAT, unionId: INITIATOR_UNION, tools: ['lark-cli'], sourceLarkAppId: MAIN }))
      .toEqual({ status: 200, body: { ok: true, check: { status: 'ok', tools: ['lark-cli'] } } });
  });
});
