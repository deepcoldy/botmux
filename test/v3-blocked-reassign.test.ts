/**
 * 「改派」 on the blocked card of a bot-executed run (design 2026-11-03 §9.2,
 * §10.3): the card offers the bots approved for the run that can take over
 * now; only the run's initiator may confirm; the engine moves the blocked
 * node to the new bot and the re-drive hands it off there. Ordinary runs get
 * exactly the card they always got.
 *
 * Real run.json / journal / daemon driver / engine; fake transport, Lark
 * membership probe and clock.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  artifactRef,
  makeAdHocRunEnvelope,
  makeSavedDefinitionRunEnvelope,
  publishRunEnvelopeOnce,
} from '../src/workflows/v3/run-envelope.js';
import { blockedInfoFor, createV3GateRunner, requestV3Retry, requestV3RunCancel } from '../src/workflows/v3/daemon-run.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import { validateDag } from '../src/workflows/v3/dag.js';
import type { V3BotEligibilityProbe } from '../src/workflows/v3/node-executor-mode.js';
import type { RunChatBinding } from '../src/workflows/v3/grill-state.js';
import {
  V3_BLOCKED_REASSIGN_ACTION,
  V3_BLOCKED_REASSIGN_FIELD,
  buildV3BlockedCard,
  v3BlockedCardNonce,
  type V3ReassignActionValue,
} from '../src/im/lark/v3-blocked-card.js';
import { handleV3BlockedAction } from '../src/im/lark/v3-blocked-card-handler.js';
import { buildV3BlockedCardForRun, type V3BlockedReassignDeps } from '../src/im/lark/v3-blocked-reassign.js';
import { reassignNode } from '../src/workflows/v3/external-control.js';
import { BotRun, FakeExecutor } from './helpers/v3-external-harness.js';

const MAIN = 'cli_main';
const OWNER = 'ou_owner';
const BINDING: RunChatBinding = {
  larkAppId: MAIN, chatId: 'oc_chat', chatType: 'group', rootMessageId: 'om_root', ownerOpenId: OWNER,
};
const BOTS = [
  { larkAppId: MAIN, name: 'main', cliId: 'claude-code', workingDir: '/tmp' },
  { larkAppId: 'cli_a', name: 'a', cliId: 'claude-code', workingDir: '/tmp' },
  { larkAppId: 'cli_b', name: 'b', cliId: 'codex', workingDir: '/tmp' },
  { larkAppId: 'cli_c', name: 'c', cliId: 'seed', workingDir: '/tmp' },
  { larkAppId: 'cli_x', name: 'x', cliId: 'claude-code', workingDir: '/tmp' },
] as any[];
const NAMES: Record<string, string> = { [MAIN]: '主Bot', cli_a: 'A-Bot', cli_b: 'B-Bot', cli_c: 'C-Bot', cli_x: 'X-Bot' };
const CREATED_AT = '2026-11-01T08:00:00.000Z';
const AUTHORIZED_AT = '2026-11-01T08:01:00.000Z';

const bases: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

const NODES = [
  { id: 'write', type: 'goal', goal: 'write', bot: 'cli_a', depends: [], inputs: [] },
  // Only here to put cli_b and cli_c into the run's approved bot set.
  { id: 'review', type: 'goal', goal: 'review', bot: 'cli_b', depends: ['write'], inputs: [] },
  { id: 'audit', type: 'goal', goal: 'audit', bot: 'cli_c', depends: ['write'], inputs: [] },
];
const SNAPSHOTS = {
  cli_a: { larkAppId: 'cli_a', cliId: 'claude-code', workingDir: '/tmp' },
  cli_b: { larkAppId: 'cli_b', cliId: 'codex', workingDir: '/tmp' },
  cli_c: { larkAppId: 'cli_c', cliId: 'seed', workingDir: '/tmp' },
};

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function seedArtifacts(runDir: string, runId: string) {
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, 'dag.json'), { schemaVersion: 2, runId, nodes: NODES });
  writeJson(join(runDir, 'spec.json'), {
    schemaVersion: 1, runId, title: 'reassign', requirement: 'r',
    nodes: [{ sketchId: 'write', goal: 'write', input_needs: [], expected_outputs: ['r.md'], acceptance: 'ok', risk_gate: false, unknowns: [] }],
  });
  writeJson(join(runDir, 'bots.snapshot.json'), SNAPSHOTS);
  return {
    dag: artifactRef(runDir, 'dag.json'),
    spec: artifactRef(runDir, 'spec.json'),
    botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
  };
}

function seedAdHoc(base: string, runId: string, executor: 'bot' | 'ephemeral', initiator: string | null = OWNER): string {
  const runDir = join(base, runId);
  publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
    runId, createdAt: CREATED_AT, authorizedAt: AUTHORIZED_AT, chatBinding: BINDING,
    ...(initiator ? { authorizedByOpenId: initiator } : {}),
    artifacts: seedArtifacts(runDir, runId),
    ...(executor === 'bot' ? { nodeExecutor: 'bot' as const } : {}),
  }));
  return runDir;
}

/** §6.1 probe over a table; records every question and every grant. */
function tableProbe(notInChat: string[] = []) {
  const asked: string[] = [];
  const probe: V3BotEligibilityProbe = {
    isConfigured: (appId) => BOTS.some((bot) => bot.larkAppId === appId),
    isDaemonOnline: () => true,
    inChat: async (appId) => { asked.push(`inChat:${appId}`); return notInChat.includes(appId) ? 'no' : 'yes'; },
    opensTopicSessions: async () => 'yes',
    ensureGrant: async (appId) => { asked.push(`grant:${appId}`); },
  };
  return { probe, asked };
}

function reassignDeps(probe: V3BotEligibilityProbe): V3BlockedReassignDeps {
  return { probe: () => probe, nameOf: (appId) => NAMES[appId] ?? appId };
}

/** A bot run driven through the daemon gate runner until `write` is blocked
 *  (its first handoff is refused). Cards are composed as the daemon does. */
async function blockedBotRun(runId: string, notInChat: string[] = [], opts: { initiator?: string | null } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'v3-reassign-'));
  bases.push(base);
  const runDir = seedAdHoc(base, runId, 'bot', opts.initiator === undefined ? OWNER : opts.initiator);
  const executor = new FakeExecutor();
  executor.onDispatch = (req) => (req.attemptNumber === 1 && req.nodeId === 'write'
    ? { kind: 'rejected', code: 'BOT_OFFLINE' }
    : { kind: 'sent', handoffMessageId: `om_${req.attemptId}` });
  const { probe, asked } = tableProbe(notInChat);
  const deps = reassignDeps(probe);
  const cards: string[] = [];
  const runner = createV3GateRunner({
    baseDir: base,
    loadBots: () => BOTS,
    makeRunNode: () => async () => { throw new Error('bot mode never spawns a worker'); },
    externalExecutor: executor,
    now: () => 10_000,
    postCard: async () => {},
    postBlockedCard: async (_binding, info, id) => {
      cards.push(await buildV3BlockedCardForRun({ runDir: join(base, id), runId: id, info, reassign: deps }));
    },
    scheduleWake: () => {},
  });
  await runner.drive(runId);
  expect(cards).toHaveLength(1);
  const drives: string[] = [];
  const click = (operator: string | undefined, target: string | undefined, value?: Partial<V3ReassignActionValue>) =>
    handleV3BlockedAction(
      { ...reassignValueOf(cards[0]!), ...value },
      operator,
      { baseDir: base, driveRun: (id) => { drives.push(id); }, canResolve: () => true, reassign: deps },
      target === undefined ? {} : { [V3_BLOCKED_REASSIGN_FIELD]: target },
      MAIN,
    );
  return { base, runDir, runId, executor, runner, cards, asked, click, drives, deps };
}

function reassignForm(card: string): any {
  const elements = JSON.parse(card).elements as any[];
  return elements.find((element) => element.tag === 'form' && element.name === 'v3_blocked_reassign_form');
}

function reassignValueOf(card: string): V3ReassignActionValue {
  const form = reassignForm(card);
  expect(form).toBeDefined();
  return form.elements.find((element: any) => element.tag === 'button').value;
}

function optionsOf(card: string): string[] {
  const select = reassignForm(card).elements.find((element: any) => element.tag === 'select_static');
  return select.options.map((option: any) => option.value);
}

const reassignedEvents = (runDir: string) =>
  readJournal(join(runDir, 'journal.ndjson')).filter((event) => event.type === 'nodeReassigned');

describe('blocked card of a bot-executed run', () => {
  it('offers the approved bots that can take over now, without writing any chat grant', async () => {
    const run = await blockedBotRun('rs-offer', ['cli_c']);
    const card = run.cards[0]!;
    expect(optionsOf(card)).toEqual(['cli_b']);
    const text = JSON.stringify(JSON.parse(card));
    expect(text).toContain('C-Bot');            // listed as unavailable, with its reason
    expect(text).not.toContain('X-Bot');        // never approved for this run
    expect(run.asked.filter((entry) => entry.startsWith('grant:'))).toEqual([]);
  });

  it('the initiator reassigns; the re-drive hands the node to the new bot', async () => {
    const run = await blockedBotRun('rs-ok');
    const frozen = await run.click(OWNER, 'cli_b') as any;
    expect(frozen.header.title.content).toContain('已改派');
    expect(JSON.stringify(frozen)).not.toContain(V3_BLOCKED_REASSIGN_ACTION);
    expect(run.drives).toEqual([run.runId]);
    expect(reassignedEvents(run.runDir)).toEqual([
      expect.objectContaining({ nodeId: 'write', from: 'cli_a', to: 'cli_b', by: OWNER }),
    ]);
    expect(run.asked).toContain('grant:cli_b');

    await run.runner.drive(run.runId);
    const handoff = run.executor.dispatches.filter((req) => req.nodeId === 'write').at(-1)!;
    expect(handoff).toMatchObject({ targetLarkAppId: 'cli_b', reassignedFrom: 'cli_a', attemptNumber: 2 });
  });

  it('refuses anyone but the initiator, and leaves the journal alone', async () => {
    const run = await blockedBotRun('rs-other');
    const result = await run.click('ou_someone_else', 'cli_b') as any;
    expect(result.toast.content).toContain('只有发起');
    expect(reassignedEvents(run.runDir)).toEqual([]);
    expect(run.drives).toEqual([]);
  });

  it('refuses a click delivered to another bot\'s app (open_id is app-scoped)', async () => {
    const run = await blockedBotRun('rs-wrong-app');
    const result = await handleV3BlockedAction(
      reassignValueOf(run.cards[0]!),
      OWNER,
      { baseDir: run.base, driveRun: () => {}, canResolve: () => true, reassign: run.deps },
      { [V3_BLOCKED_REASSIGN_FIELD]: 'cli_b' },
      'cli_a',
    ) as any;
    expect(result.toast.content).toContain('不属于');
    expect(reassignedEvents(run.runDir)).toEqual([]);
  });

  it('refuses a bot outside the approved set before touching its chat grant', async () => {
    const run = await blockedBotRun('rs-outside');
    const result = await run.click(OWNER, 'cli_x') as any;
    expect(result.toast.content).toContain('批准时');
    expect(run.asked).not.toContain('grant:cli_x');
    expect(reassignedEvents(run.runDir)).toEqual([]);
  });

  it('re-checks the target at click time', async () => {
    const run = await blockedBotRun('rs-gone');
    // cli_b left the chat after the card was posted.
    const { probe } = tableProbe(['cli_b']);
    const result = await handleV3BlockedAction(
      reassignValueOf(run.cards[0]!),
      OWNER,
      { baseDir: run.base, driveRun: () => {}, canResolve: () => true, reassign: reassignDeps(probe) },
      { [V3_BLOCKED_REASSIGN_FIELD]: 'cli_b' },
      MAIN,
    ) as any;
    expect(result.toast.content).toContain('不在本群');
    expect(reassignedEvents(run.runDir)).toEqual([]);
  });

  it('a click on a card whose attempt already moved on is stale', async () => {
    const run = await blockedBotRun('rs-stale');
    expect(requestV3Retry(run.base, run.runId, { nodeId: 'write' })).toMatchObject({ kind: 'requested' });
    await run.runner.drive(run.runId); // attempt 002 handed to cli_a
    const result = await run.click(OWNER, 'cli_b') as any;
    expect(result.toast.content).toContain('新一轮');
    expect(reassignedEvents(run.runDir)).toEqual([]);
    expect(run.executor.stops).toEqual([]);
  });

  it('a repeated click after the node moved is a no-op', async () => {
    const run = await blockedBotRun('rs-twice');
    await run.click(OWNER, 'cli_b');
    const again = await run.click(OWNER, 'cli_b') as any;
    expect(again.toast.type).toBe('info');
    expect(reassignedEvents(run.runDir)).toHaveLength(1);
  });

  it('refuses a forged nonce and a missing selection', async () => {
    const run = await blockedBotRun('rs-forged');
    expect(((await run.click(OWNER, 'cli_b', { nonce: 'forged' })) as any).toast.content).toContain('nonce');
    expect(((await run.click(OWNER, undefined)) as any).toast.content).toContain('选择');
    expect(reassignedEvents(run.runDir)).toEqual([]);
  });
});

describe('blocked card of a Saved Workflow bot run', () => {
  it('the initiator is the person who started it (chat binding owner)', async () => {
    const dag = validateDag({ schemaVersion: 2, runId: 'rs-saved', nodes: NODES });
    const run = new BotRun(dag);
    const artifacts = seedArtifacts(run.runDir, 'rs-saved');
    writeJson(join(run.runDir, 'params.resolved.json'), { params: {}, context: {} });
    writeJson(join(run.runDir, 'definition.snapshot.json'), {
      workflowId: 'wf_0123456789abcdef0123456789abcdef', revisionId: `rev_${'a'.repeat(64)}`, humanVersion: 1,
    });
    publishRunEnvelopeOnce(run.runDir, makeSavedDefinitionRunEnvelope({
      runId: 'rs-saved',
      workflowId: 'wf_0123456789abcdef0123456789abcdef',
      revisionId: `rev_${'a'.repeat(64)}`,
      humanVersion: 1,
      createdAt: CREATED_AT,
      authorizedAt: AUTHORIZED_AT,
      chatBinding: { ...BINDING, ownerOpenId: 'ou_runner' },
      nodeExecutor: 'bot',
      artifacts: {
        ...artifacts,
        resolvedParams: artifactRef(run.runDir, 'params.resolved.json'),
        definitionSnapshot: artifactRef(run.runDir, 'definition.snapshot.json'),
      },
    }));
    const executor = new FakeExecutor();
    executor.onDispatch = () => ({ kind: 'rejected', code: 'BOT_OFFLINE' });
    await run.drive(executor, {
      opts: { authorizedArtifacts: true, frozenBotSnapshots: new Map(Object.entries(SNAPSHOTS)) },
    });
    const info = blockedInfoFor(run.events(), 'write');
    const { probe } = tableProbe();
    const value: V3ReassignActionValue = {
      action: V3_BLOCKED_REASSIGN_ACTION, runId: 'rs-saved', nodeId: 'write', attemptId: info.attemptId,
      nonce: v3BlockedCardNonce('rs-saved', 'write', info.attemptId),
    };
    const deps = { baseDir: run.base, driveRun: () => {}, canResolve: () => true, reassign: reassignDeps(probe) };
    const form = { [V3_BLOCKED_REASSIGN_FIELD]: 'cli_b' };
    expect(((await handleV3BlockedAction(value, OWNER, deps, form, MAIN)) as any).toast.content).toContain('只有发起');
    expect(((await handleV3BlockedAction(value, 'ou_runner', deps, form, MAIN)) as any).header.title.content).toContain('已改派');
  });
});

describe('blocked card of an ordinary run', () => {
  it('is exactly today\'s card and never consults bots', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-reassign-plain-'));
    bases.push(base);
    const runDir = seedAdHoc(base, 'rs-plain', 'ephemeral');
    const probeFactory = vi.fn(() => tableProbe().probe);
    const info = {
      nodeId: 'write', attemptId: 'write#001/attempts/001', errorClass: 'workerError' as const,
      errorCode: 'AUTH_REQUIRED', message: '需要登录',
    };
    const card = await buildV3BlockedCardForRun({
      runDir, runId: 'rs-plain', info, reassign: { probe: probeFactory, nameOf: (id) => id },
    });
    expect(card).toBe(buildV3BlockedCard({ runId: 'rs-plain', ...info }));
    expect(card).not.toContain(V3_BLOCKED_REASSIGN_ACTION);
    expect(probeFactory).not.toHaveBeenCalled();
  });

  it('refuses a reassign click', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-reassign-plain-'));
    bases.push(base);
    seedAdHoc(base, 'rs-plain-click', 'ephemeral');
    const value: V3ReassignActionValue = {
      action: V3_BLOCKED_REASSIGN_ACTION, runId: 'rs-plain-click', nodeId: 'write', attemptId: 'write/attempts/001',
      nonce: v3BlockedCardNonce('rs-plain-click', 'write', 'write/attempts/001'),
    };
    const result = await handleV3BlockedAction(value, OWNER, {
      baseDir: base, driveRun: () => {}, canResolve: () => true, reassign: reassignDeps(tableProbe().probe),
    }, { [V3_BLOCKED_REASSIGN_FIELD]: 'cli_b' }, MAIN) as any;
    expect(result.toast.content).toContain('不是交给群里的 Bot');
  });
});

// ─── Review follow-ups ───────────────────────────────────────────────────

describe('改派 hardening', () => {
  const clickWith = (run: Awaited<ReturnType<typeof blockedBotRun>>, value: V3ReassignActionValue, extra: {
    canResolve?: () => boolean;
    probe?: V3BotEligibilityProbe;
  } = {}) => handleV3BlockedAction(
    value,
    OWNER,
    {
      baseDir: run.base,
      driveRun: (id) => { run.drives.push(id); },
      canResolve: extra.canResolve ?? (() => true),
      reassign: extra.probe ? reassignDeps(extra.probe) : run.deps,
    },
    { [V3_BLOCKED_REASSIGN_FIELD]: 'cli_b' },
    MAIN,
  );

  it('a callback without an attempt is refused before anything is written', async () => {
    const run = await blockedBotRun('rh-no-attempt');
    const { attemptId: _dropped, ...rest } = reassignValueOf(run.cards[0]!);
    const forged = { ...rest, nonce: v3BlockedCardNonce(run.runId, 'write', undefined as unknown as string) } as V3ReassignActionValue;
    const result = await clickWith(run, forged) as any;
    expect(result.toast.content).toContain('缺少');
    expect(reassignedEvents(run.runDir)).toEqual([]);
    expect(run.asked).not.toContain('grant:cli_b');
  });

  it('a callback naming the running attempt never retargets it', async () => {
    const run = await blockedBotRun('rh-running');
    requestV3Retry(run.base, run.runId, { nodeId: 'write' });
    await run.runner.drive(run.runId);
    const running = run.executor.dispatches.filter((req) => req.nodeId === 'write').at(-1)!.attemptId;
    const forged: V3ReassignActionValue = {
      action: V3_BLOCKED_REASSIGN_ACTION, runId: run.runId, nodeId: 'write', attemptId: running,
      nonce: v3BlockedCardNonce(run.runId, 'write', running),
    };
    const result = await clickWith(run, forged) as any;
    expect(result.toast).toBeDefined();
    expect(reassignedEvents(run.runDir)).toEqual([]);
    expect(run.executor.stops).toEqual([]);
    expect(run.asked).not.toContain('grant:cli_b');
  });

  it('the engine re-checks "still blocked" under the journal lock', async () => {
    const run = await blockedBotRun('rh-race');
    // A retry lands while the target's chat grant is being made.
    const { probe } = tableProbe();
    const racing: V3BotEligibilityProbe = {
      ...probe,
      ensureGrant: async () => { requestV3Retry(run.base, run.runId, { nodeId: 'write' }); },
    };
    const result = await clickWith(run, reassignValueOf(run.cards[0]!), { probe: racing }) as any;
    expect(result.toast).toBeDefined();
    expect(reassignedEvents(run.runDir)).toEqual([]);
  });

  it('the engine re-checks the card\'s attempt: a node blocked again meanwhile is not moved by the old card', async () => {
    const run = await blockedBotRun('rh-race-reblocked');
    run.executor.onDispatch = () => ({ kind: 'rejected', code: 'BOT_OFFLINE' });
    const { probe } = tableProbe();
    const racing: V3BotEligibilityProbe = {
      ...probe,
      ensureGrant: async () => {
        requestV3Retry(run.base, run.runId, { nodeId: 'write' });
        await run.runner.drive(run.runId); // attempt 002 is refused too → blocked again
      },
    };
    const result = await clickWith(run, reassignValueOf(run.cards[0]!), { probe: racing }) as any;
    expect(result.toast).toBeDefined();
    expect(reassignedEvents(run.runDir)).toEqual([]);
  });

  it('no 改派 section when the run has no recorded initiator', async () => {
    const run = await blockedBotRun('rh-no-initiator', [], { initiator: null });
    expect(reassignForm(run.cards[0]!)).toBeUndefined();
  });

  it('a half-written reassignment (no retry yet) is finished by clicking the same bot again', async () => {
    const run = await blockedBotRun('rh-half');
    appendEvent(join(run.runDir, 'journal.ndjson'), {
      type: 'nodeReassigned', nodeId: 'write', instanceId: 'write#001', from: 'cli_a', to: 'cli_b', by: OWNER,
    });
    const frozen = await run.click(OWNER, 'cli_b') as any;
    expect(frozen.header?.title.content).toContain('已改派');
    expect(readJournal(join(run.runDir, 'journal.ndjson')).filter((event) => event.type === 'nodeRetryRequested')).toHaveLength(1);
    await run.runner.drive(run.runId);
    expect(run.executor.dispatches.filter((req) => req.nodeId === 'write').at(-1))
      .toMatchObject({ targetLarkAppId: 'cli_b', attemptNumber: 2 });
  });

  it('a cancelled run refuses before any chat grant is written', async () => {
    const run = await blockedBotRun('rh-cancelled');
    expect(requestV3RunCancel(run.base, run.runId, { by: OWNER })).toMatchObject({ kind: 'requested' });
    const result = await run.click(OWNER, 'cli_b') as any;
    expect(result.toast.content).toContain('结束');
    expect(run.asked).not.toContain('grant:cli_b');
    expect(reassignedEvents(run.runDir)).toEqual([]);
  });

  it('the initiator still needs the card\'s operate permission', async () => {
    const run = await blockedBotRun('rh-no-permission');
    const result = await clickWith(run, reassignValueOf(run.cards[0]!), { canResolve: () => false }) as any;
    expect(result.toast.content).toContain('权限');
    expect(run.asked).not.toContain('grant:cli_b');
    expect(reassignedEvents(run.runDir)).toEqual([]);
  });

  it.each([
    ['a contract error that needs a revised workflow', { retryForbidden: 'revise-workflow-required' as const }],
    ['a human-ask', { ask: { question: 'Q?', options: ['a'] } }],
  ])('no 改派 section on %s, and no bot is probed for it', async (_label, extra) => {
    const run = await blockedBotRun('rh-forbidden');
    const info = { ...blockedInfoFor(readJournal(join(run.runDir, 'journal.ndjson')), 'write'), ...extra };
    const probeFactory = vi.fn(() => tableProbe().probe);
    const card = await buildV3BlockedCardForRun({
      runDir: run.runDir, runId: run.runId, info, reassign: { ...run.deps, probe: probeFactory },
    });
    expect(card).not.toContain(V3_BLOCKED_REASSIGN_ACTION);
    expect(probeFactory).not.toHaveBeenCalled();
  });
});

describe('engine: reassignNode(requireBlocked)', () => {
  it('refuses a running attempt even when the caller names it exactly', async () => {
    const dag = validateDag({ schemaVersion: 2, runId: 'rq-running', nodes: NODES });
    const run = new BotRun(dag);
    const executor = new FakeExecutor();
    await run.drive(executor);
    const open = run.openAttempt('write');
    const snapshots = new Map(Object.entries(SNAPSHOTS));
    const ctx = { ...run.ctx(), botSnapshots: snapshots, nodeExecutor: 'bot' as const, executor };
    expect(await reassignNode(run.runDir, {
      nodeId: 'write', toLarkAppId: 'cli_b', by: OWNER, expectedAttemptId: open.attemptId, requireBlocked: true,
    }, ctx)).toEqual({ kind: 'rejected', reason: 'not-reassignable' });
    expect(run.of('nodeReassigned')).toEqual([]);
    expect(executor.stops).toEqual([]);
  });
});
