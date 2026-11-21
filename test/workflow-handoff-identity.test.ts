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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BotRun,
  cleanupBotRuns,
  expectAwaitingExternal,
  expectTerminal,
  reportDag,
  reportFiles,
  snapshotFor,
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
  loadWorkflowHandoffIdentityRun,
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
import { appendEvent, type StoredEvent } from '../src/workflows/v3/journal.js';
import { applyV3RunEdit, decideV3RevisionProposal } from '../src/workflows/v3/run-edit.js';
import { v3RevisionFilePaths } from '../src/workflows/v3/dag-revision.js';
import type { BotSnapshot } from '../src/workflows/v3/contract.js';
import { buildV3HandoffCard, type V3HandoffCardInput } from '../src/im/lark/v3-node-card.js';
import { extractCardContent } from '../src/im/lark/message-parser.js';
import { workflowSidebarEntryLink } from '../src/im/lark/workflow-sidebar-entry.js';
import { handleV3BlockedReassign } from '../src/im/lark/v3-blocked-reassign.js';
import { V3_BLOCKED_REASSIGN_ACTION, V3_BLOCKED_REASSIGN_FIELD, v3BlockedCardNonce } from '../src/im/lark/v3-blocked-card.js';

afterEach(() => cleanupBotRuns());

const FROZEN = { unionId: INITIATOR_UNION, tools: ['lark-cli', 'bytedcli'] as Array<'lark-cli' | 'bytedcli'> };

/** The visible text of the latest handoff card (as patched with its id). */
function handoffText(world: { lark: { replies: Array<{ id: string; card: string }>; patches: Array<{ id: string; card: string }> } }): string {
  const reply = world.lark.replies.at(-1)!;
  const patched = [...world.lark.patches].reverse().find((patch) => patch.id === reply.id);
  return JSON.stringify(JSON.parse((patched ?? reply).card));
}

/** Handed off as usual: sent, no delegation bound, the reason on the card. */
function expectUnsignedHandoff(run: BotRun, world: Parameters<typeof handoffText>[0] & { dataDir: string }, reason: string | RegExp) {
  const attempt = run.openAttempt('write');
  expect(attempt.phase).toBe('sent');
  expect(run.of('nodeBlocked')).toEqual([]);
  expect(boundRecord(world.dataDir, attempt.handoffMessageId!)).toBeUndefined();
  const text = handoffText(world);
  expect(text).toContain('未带发起人身份：');
  expect(text).toMatch(typeof reason === 'string' ? new RegExp(reason) : reason);
  expect(text).toContain('需要个人授权的工具会在调用时提示授权');
  expect(text).not.toContain('IDENTITY_UNAVAILABLE');
}

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
    ['the target governs none of the frozen tools', (world: ReturnType<typeof identityWorld>) => { world.policies.set('cli_a', policy(['bytedcli'])); }, '没有可交给'],
    ['the main bot no longer governs the frozen tool', (world: ReturnType<typeof identityWorld>) => { world.policies.set(MAIN, policy(['bytedcli'])); }, '没有可交给'],
  ])('%s: handed off as usual without the initiator, the reason on the card', async (_label, arrange, text) => {
    const run = new BotRun(reportDag(`id-unsigned-${_label.length}`));
    const world = identityWorld();
    const snapshots = authorizeRun(run, { identity: { unionId: INITIATOR_UNION, tools: ['lark-cli'] } });
    arrange(world);
    expectAwaitingExternal(await driveWith(run, world, snapshots));
    expectUnsignedHandoff(run, world, text);
    expect(store(world.dataDir)).toEqual({});
  });

  it('a run approved without the initiator hands off as usual and says why where it matters', async () => {
    const governing = new BotRun(reportDag('id-approved-without'));
    const world = identityWorld();
    await driveWith(governing, world, authorizeRun(governing, { identity: { unavailable: 'not_human_turn' } }));
    expectUnsignedHandoff(governing, world, '批准时没有取得发起人身份（这次批准不是发起人本人在群里发来的消息');
    expect(world.identityChecks).toEqual([]);
    // A bot that runs no tool as its trigger user has nothing to be told.
    const plain = new BotRun(reportDag('id-approved-without-plain', { bot: 'cli_b' }));
    const plainWorld = identityWorld();
    await driveWith(plain, plainWorld, authorizeRun(plain, { identity: { unavailable: 'lookup_failed' }, selectors: ['cli_b'] }));
    expect(plain.openAttempt('write').phase).toBe('sent');
    expect(handoffText(plainWorld)).not.toContain('未带发起人身份');
  });

  it('only the run\'s own main bot signs, and only for the run\'s own chat', async () => {
    const run = new BotRun(reportDag('id-wrong-signer'));
    const world = identityWorld();
    const snapshots = authorizeRun(run, { identity: FROZEN });
    // Another bot's daemon driving this run (it does not own it) …
    expectAwaitingExternal(await run.drive(world.daemons.get('cli_b')!.executor, {
      opts: { chatBinding: BINDING, authorizedArtifacts: true, frozenBotSnapshots: snapshots },
    }));
    expectUnsignedHandoff(run, world, '群或主 Bot 与批准时的不一致');
    // … and the owner handing off into a chat that is not the run's.
    const other = new BotRun(reportDag('id-wrong-chat'));
    const otherSnapshots = authorizeRun(other, { identity: FROZEN });
    expectAwaitingExternal(await other.drive(world.main.executor, {
      opts: { chatBinding: { ...BINDING, chatId: 'oc_elsewhere' }, authorizedArtifacts: true, frozenBotSnapshots: otherSnapshots },
    }));
    expectUnsignedHandoff(other, world, '群或主 Bot 与批准时的不一致');
    expect(world.identityChecks).toEqual([]);
    expect(store(world.dataDir)).toEqual({});
  });

  it('a self node of a run frozen without an identity starts its turn with no identity step', async () => {
    const run = new BotRun(validateDag({
      schemaVersion: 2, runId: 'id-self-off', nodes: [{ id: 'write', type: 'goal', goal: 'summarize', timeoutSec: 600 }],
    }));
    const world = identityWorld();
    await driveWith(run, world, authorizeRun(run, { identity: null, selectors: [''] }));
    expect(world.selfTurns).toHaveLength(1);
    expect(world.selfTurns[0]).not.toHaveProperty('prepareTurnIdentity');
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
    // The in-process turn publishes its identity (the daemon's per-turn
    // preparation, which resolves the signed record) before the CLI gets it.
    expect(world.selfTurns).toEqual([expect.objectContaining({ handoffMessageId: attempt.handoffMessageId })]);
    expect(world.selfTurns[0]!.prepareTurnIdentity).toBe(world.prepareTurnIdentity);
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
    expectAwaitingExternal(await driveWith(run, world, snapshots));
    const second = run.openAttempt('write');
    expect(boundRecord(world.dataDir, second.handoffMessageId!)).toBeUndefined(); // went out unsigned
    expect(reportExternalBlocked(run.runDir, { attemptId: second.attemptId, reason: 'needs the person' })).toEqual({ ok: true });
    expect(expectTerminal(await driveWith(run, world, snapshots)).runStatus).toBe('blocked');

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

// ─── a check that cannot run ───────────────────────────────────────────────

describe('a target check that cannot run is retried for about a minute, then the node goes out without the initiator', () => {
  async function stuck(runId: string) {
    const run = new BotRun(reportDag(runId));
    // The executor stamps handoff bindings with this clock too; the registry
    // prunes entries by real time, so the fake clock starts at real time.
    run.clock.t = Date.now();
    const world = identityWorld({}, { clock: run.clock });
    const snapshots = authorizeRun(run, { identity: FROZEN });
    world.directoryDown.add('cli_a');
    return { run, world, snapshots, drive: () => driveWith(run, world, snapshots) };
  }

  it('clears within the window: the handoff goes out with the delegation', async () => {
    const { run, world, drive } = await stuck('id-retry-clears');
    const t0 = run.clock.t;
    // Fails, waits 5 s in the call, fails again; the next try is due at +20 s.
    expectAwaitingExternal(await drive());
    expect(world.identityChecks).toHaveLength(2);
    expect(run.clock.t - t0).toBe(5_000);
    expect(run.openAttempt('write').phase).toBe('prepared');
    expect(world.lark.sent).toEqual([]);
    world.directoryDown.delete('cli_a');
    run.clock.t = t0 + 35_000; // the engine's next same-key re-send
    expectAwaitingExternal(await drive());
    const attempt = run.openAttempt('write');
    expect(attempt.phase).toBe('sent');
    expect(boundRecord(world.dataDir, attempt.handoffMessageId!)).toMatchObject({ targetAppIds: ['cli_a'] });
  });

  it('a re-send before the next try is due does not check again', async () => {
    const { run, world, drive } = await stuck('id-retry-early');
    const t0 = run.clock.t;
    await drive();
    run.clock.t = t0 + 6_000; // a drive for something else, 14 s before the next try
    expectAwaitingExternal(await drive());
    expect(world.identityChecks).toHaveLength(2);
  });

  it('still failing after the schedule: handed off without the initiator, saying it retried', async () => {
    const { run, world, drive } = await stuck('id-retry-exhausted');
    const t0 = run.clock.t;
    await drive(); // checks at +0 s, +5 s
    run.clock.t = t0 + 35_000;
    expectAwaitingExternal(await drive()); // check at +35 s; the last is due at +60 s
    expect(world.identityChecks).toHaveLength(3);
    expect(world.lark.sent).toEqual([]);
    run.clock.t = t0 + 65_000;
    expectAwaitingExternal(await drive());
    expect(world.identityChecks).toHaveLength(4);
    expectUnsignedHandoff(run, world, /暂时无法.*contact lookup unavailable.*已自动重试 3 次/);
    expect(store(world.dataDir)).toEqual({});
  });

  it('a definite answer during the retries decides at once', async () => {
    const { run, world, drive } = await stuck('id-retry-then-denied');
    await drive();
    world.directoryDown.delete('cli_a');
    world.members.get('cli_a')!.clear();
    run.clock.t += 30_000;
    expectAwaitingExternal(await drive());
    expect(world.identityChecks).toHaveLength(3);
    expectUnsignedHandoff(run, world, '已不在本群');
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
  // No flow revision in these journals: nothing is read from the run dir.
  const loaded = { botSnapshots: { cli_a: { larkAppId: 'cli_a', cliId: 'claude-code', workingDir: '/tmp' } }, dag: reportDag('approved-set') };
  const reassigned = (by: string): StoredEvent => ({ type: 'nodeReassigned', nodeId: 'write', from: 'cli_a', to: 'cli_x', by, seq: 1, ts: '' } as unknown as StoredEvent);
  const approved = (events: StoredEvent[]) => [...approvedWorkflowBots('/nonexistent-run-dir', loaded, events, INITIATOR_MAIN_OU)];

  it('are the bots approval assigned, plus a bot the initiator reassigned a node to themselves', () => {
    expect(approved([])).toEqual(['cli_a']);
    expect(approved([reassigned(INITIATOR_MAIN_OU)])).toEqual(['cli_a', 'cli_x']);
  });

  it('anyone else\'s reassignment never adds a bot', () => {
    expect(approved([reassigned('ou_someone_else'), reassigned('main_bot')])).toEqual(['cli_a']);
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
      targetGovernsTools: true,
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

  it('a run approved without the initiator: unsigned for a governing target (no check), nothing for another', async () => {
    const without: WorkflowHandoffIdentityRun = { unavailableReason: 'lookup_unavailable', approvedBots: new Set(['cli_a']), chatId: CHAT, sourceLarkAppId: MAIN };
    const governing = plan({ run: without });
    expect(await governing.result).toEqual({ kind: 'unsigned', note: expect.stringContaining('批准时没有取得发起人身份（主 Bot 查不到发起人的跨应用身份') });
    expect(governing.offered).toEqual([]);
    expect(await plan({ run: without, targetGovernsTools: false }).result).toEqual({ kind: 'none' });
  });

  it('a bot outside the approved set is offered nothing: it goes out unsigned', async () => {
    const offered: string[][] = [];
    const { result } = plan({
      targetLarkAppId: 'cli_x',
      check: async (tools) => { offered.push(tools); return tools.length ? { status: 'ok', tools } : { status: 'denied', reason: 'no_shared_tool' }; },
    });
    expect(await result).toEqual({ kind: 'unsigned', note: expect.stringContaining('不在本 run 发起人批准的 Bot 范围内') });
    expect(offered).toEqual([[]]);
  });

  it('a target answering with more than it was offered is narrowed back', async () => {
    const { result } = plan({ sourceBotTools: ['lark-cli'], check: async () => ({ status: 'ok', tools: ['lark-cli', 'bytedcli'] }) });
    expect(await result).toMatchObject({ kind: 'sign', authority: { tools: ['lark-cli'] } });
  });

  it('a failing check never signs: unsigned, marked for the retry', async () => {
    const { result } = plan({ check: async () => { throw new Error('ipc down'); } });
    expect(await result).toEqual({ kind: 'unsigned', transient: true, note: expect.stringContaining('ipc down') });
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

// ─── with #2728 (blocked-card reassignment) and #2750 (sidebar entry) ──────

describe('the initiator reassigning a blocked node on its card (#2728)', () => {
  it('a handoff to the approved bot they picked carries their identity', async () => {
    const run = new BotRun(reportDag('id-card-reassign'));
    const world = identityWorld();
    world.policies.set('cli_b', policy(['lark-cli', 'bytedcli']));
    const snapshots = authorizeRun(run, { identity: FROZEN, selectors: ['cli_a', 'cli_b'] });
    await driveWith(run, world, snapshots);
    const first = run.openAttempt('write');
    expect(reportExternalBlocked(run.runDir, { attemptId: first.attemptId, reason: 'cannot' })).toEqual({ ok: true });
    expect(expectTerminal(await driveWith(run, world, snapshots)).runStatus).toBe('blocked');

    const drives: string[] = [];
    const clicked = await handleV3BlockedReassign(
      { action: V3_BLOCKED_REASSIGN_ACTION, runId: run.dag.runId, nodeId: 'write', attemptId: first.attemptId,
        nonce: v3BlockedCardNonce(run.dag.runId, 'write', first.attemptId) },
      INITIATOR_MAIN_OU, MAIN, { [V3_BLOCKED_REASSIGN_FIELD]: 'cli_b' },
      {
        baseDir: run.base, driveRun: (runId) => { drives.push(runId); }, canResolve: () => true,
        reassign: {
          probe: () => ({ isConfigured: () => true, isDaemonOnline: () => true, inChat: async () => 'yes', opensTopicSessions: async () => 'yes', ensureGrant: async () => {} }),
          nameOf: (appId) => appId,
          executor: world.main.executor,
        },
      },
    );
    expect(drives).toEqual([run.dag.runId]);
    expect(run.of('nodeReassigned')).toEqual([expect.objectContaining({ to: 'cli_b', by: INITIATOR_MAIN_OU })]);
    expect(clicked).not.toHaveProperty('toast');

    await driveWith(run, world, snapshots);
    const second = run.openAttempt('write');
    expect(second.targetLarkAppId).toBe('cli_b');
    expect(boundRecord(world.dataDir, second.handoffMessageId!)).toMatchObject({
      targetAppIds: ['cli_b'], workflow: { attemptId: second.attemptId },
      authority: { openId: INITIATOR_MAIN_OU, unionId: INITIATOR_UNION },
    });
    expect(workflowDelegationRefusal(receiverInputs(world, run, second, 'cli_b'))).toBeUndefined();
  });
});

describe('a bot a flow edit brought in (#2763)', () => {
  /** A started run whose `write` has not been handed off yet; cli_c, a bot
   *  outside its approval, would carry the initiator's tools. */
  function startedRun(id: string) {
    const run = new BotRun(reportDag(id));
    const world = identityWorld();
    world.policies.set('cli_c', policy(['lark-cli', 'bytedcli']));
    const snapshots = authorizeRun(run, { identity: FROZEN });
    appendEvent(run.journalPath, { type: 'runStarted', runId: run.dag.runId, nodeExecutor: 'bot' });
    return { run, world, snapshots };
  }
  const editRun = (run: BotRun, openId: string, patch: unknown[]) => applyV3RunEdit({
    baseDir: run.base, runId: run.dag.runId, baseRevision: 1, caller: { openId, origin: 'human' }, patch, resolveNewBotSnapshot: snapshotFor,
  });
  const moveWriteToC = (run: BotRun, openId: string) => editRun(run, openId, [{ op: 'reassign', nodeId: 'write', bot: 'cli_c' }]);
  // A new node records no reassignment: only the revision's own bots bring cli_c in.
  const addCheckOnC = (run: BotRun, openId: string) => editRun(run, openId, [{ op: 'addNode', node: {
    id: 'check', type: 'goal', goal: 'check the report', bot: 'cli_c', depends: [], inputs: [], timeoutSec: 600,
    outputs: { review: { path: 'review.md', kind: 'markdown' } },
  } }]);
  async function expectSignedToC(run: BotRun, world: ReturnType<typeof identityWorld>, snapshots: Map<string, BotSnapshot>, nodeId: string) {
    await driveWith(run, world, snapshots);
    const attempt = run.openAttempt(nodeId);
    expect(attempt.targetLarkAppId).toBe('cli_c');
    expect(boundRecord(world.dataDir, attempt.handoffMessageId!)).toMatchObject({
      targetAppIds: ['cli_c'], workflow: { attemptId: attempt.attemptId },
      authority: { openId: INITIATOR_MAIN_OU, unionId: INITIATOR_UNION, tools: ['lark-cli', 'bytedcli'] },
    });
    expect(workflowDelegationRefusal(receiverInputs(world, run, attempt, 'cli_c'))).toBeUndefined();
  }

  it('someone else\'s edit, confirmed by the initiator on the revision card: the handoff carries their identity', async () => {
    const { run, world, snapshots } = startedRun('id-edit-confirmed');
    expect(moveWriteToC(run, 'ou_member_in_main')).toMatchObject({ kind: 'proposed', reasons: ['callerNotInitiator', 'newBot'] });
    // Unconfirmed, it widens nothing.
    expect([...loadWorkflowHandoffIdentityRun(run.runDir)!.approvedBots]).toEqual(['cli_a']);
    expect(decideV3RevisionProposal({ baseDir: run.base, runId: run.dag.runId, revision: 2, decision: 'approve', by: INITIATOR_MAIN_OU }))
      .toMatchObject({ kind: 'approved' });
    await expectSignedToC(run, world, snapshots, 'write');
  });

  it('the initiator\'s own edit, applied directly: the handoff carries their identity', async () => {
    const { run, world, snapshots } = startedRun('id-edit-direct');
    expect(addCheckOnC(run, INITIATOR_MAIN_OU)).toMatchObject({ kind: 'applied', revision: 2 });
    await expectSignedToC(run, world, snapshots, 'check');
  });

  it('a revision that no longer verifies never widens the scope: the approval\'s bots only', () => {
    const { run } = startedRun('id-edit-tampered');
    expect(addCheckOnC(run, INITIATOR_MAIN_OU)).toMatchObject({ kind: 'applied', revision: 2 });
    expect([...loadWorkflowHandoffIdentityRun(run.runDir)!.approvedBots]).toEqual(['cli_a', 'cli_c']);
    writeFileSync(v3RevisionFilePaths(run.runDir, 2).bots, `${JSON.stringify({ cli_c: snapshotFor('cli_b') })}\n`);
    expect([...loadWorkflowHandoffIdentityRun(run.runDir)!.approvedBots]).toEqual(['cli_a']);
  });
});

describe('the handoff card with the sidebar entry (#2750)', () => {
  const input: V3HandoffCardInput = {
    runTitle: '代码风险报告', nodeId: 'write', attemptNumber: 1, goal: 'write the report', inputs: [], omitted: [],
    outputs: [{ key: 'report', path: 'report.md', kind: 'markdown' }], resultFields: [], timeoutSec: 600,
    handoffRef: 'om_handoff', nonce: `wfh_${'a'.repeat(24)}`, target: { kind: 'bot', openId: 'ou_bot_a' },
    entry: workflowSidebarEntryLink({ dashboardOrigin: 'https://dash.example.test', mainLarkAppId: MAIN, runId: 'r1', brand: 'feishu', sidebar: true })!,
  };
  const NOTE = '发起人已不在本群';

  it('the executing bot reads exactly one more line: the reason it carries no identity', () => {
    const plain = extractCardContent(buildV3HandoffCard(input));
    const withNote = extractCardContent(buildV3HandoffCard({ ...input, identityNote: NOTE }));
    const noteLine = `未带发起人身份：${NOTE}；需要个人授权的工具会在调用时提示授权，用不到就照常做。`;
    expect(withNote).toContain(noteLine);
    // Take the line (and the blank line after it) out again: what is left is
    // exactly what the bot reads without it.
    expect(withNote.replace(`${noteLine}\n\n`, '')).toBe(plain);
    expect(withNote).not.toContain('/workflow/');
  });

  it('the signature row (the @ that wakes the bot, and the entry) is untouched by the note', () => {
    const footer = (card: string) => JSON.stringify(JSON.parse(card).body.elements.at(-1));
    expect(footer(buildV3HandoffCard({ ...input, identityNote: NOTE }))).toBe(footer(buildV3HandoffCard(input)));
    expect(footer(buildV3HandoffCard(input))).toContain('<at id=ou_bot_a>');
  });
});
