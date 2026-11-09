/**
 * 拉群开始 (design 2026-11-03 workflow-dashboard-orchestration §4.5, §9, D4),
 * daemon side: the real draft service, grill state machine, host Gate-2
 * (authorizeAdHocRun / hostApproveDag), run.json schema and the real start
 * preflight + start intent, on a real run dir. Fakes: Feishu (chats,
 * messages, receiver-scoped grants), the clarify session, the Architect
 * worker.
 *
 * "Crash after step X" = the collaborator of step X+1 (or X itself, after its
 * effect) never returns; a new service on the same dir stands for the next
 * daemon process.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowDraftError, WorkflowDraftService } from '../src/workflows/v3/draft-service.js';
import { listWorkflowDrafts, readWorkflowDraft, writeWorkflowDraft } from '../src/workflows/v3/draft-store.js';
import { readRunEnvelope } from '../src/workflows/v3/run-envelope.js';
import { readGrillState } from '../src/workflows/v3/grill-state.js';
import { readJournal } from '../src/workflows/v3/journal.js';
import { launchGroupName, launchMarker } from '../src/workflows/v3/draft-launch.js';
import {
  ALICE, BOTS, DEFAULT_PROJECT, DOC, MAIN, OWNER, PI, SKETCHES, STEWARD,
  architectSettled, makeService, specMarkdown,
} from './helpers/workflow-draft-fakes.js';
import { fakeLaunch, seenBy } from './helpers/workflow-launch-fakes.js';

const REVIEW = 'cli_review';
const FLEET = [...BOTS, { larkAppId: REVIEW, larkAppSecret: 's-rv', name: 'review', cliId: 'claude-code' }] as any[];
const ONLINE = [MAIN, DOC, REVIEW, STEWARD, PI];

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'wf-launch-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WorkflowDraftError) return error.code;
    throw error;
  }
  return 'ok';
}

function setup() {
  const launch = fakeLaunch(base);
  launch.setOnline(ONLINE);
  const h = makeService(base, { loadBots: () => FLEET, launch: launch.deps });
  h.setOnline(ONLINE);
  return { h, launch };
}

/** The next daemon process on the same dir (same collaborators). */
function restart(h: ReturnType<typeof makeService>): WorkflowDraftService {
  const service = new WorkflowDraftService({ ...h.deps });
  service.recoverInterrupted();
  return service;
}

const specBlock = () => `好的。\n<botmux-spec>\n${specMarkdown(SKETCHES)}\n</botmux-spec>`;

/** A draft through both confirmations (已确认流程). */
async function confirmed(h: ReturnType<typeof makeService>, initiator = OWNER): Promise<string> {
  const created = await h.service.create(initiator, { goal: '帮我出一份代码风险报告' });
  h.clarify.reply(specBlock());
  expect((await h.service.finalizeSpec(created.runId, initiator, {})).ok).toBe(true);
  await h.service.approveSpec(created.runId, initiator);
  await h.service.startArchitect(created.runId, initiator);
  await architectSettled(h.service, created.runId);
  const view = await h.service.view(created.runId);
  await h.service.approveFlow(created.runId, initiator, { flowSummarySha256: view.flow!.flowSummarySha256 });
  expect((await h.service.view(created.runId)).phase).toBe('flow_confirmed');
  return created.runId;
}

async function reconfirm(service: WorkflowDraftService, runId: string, initiator = OWNER): Promise<void> {
  const view = await service.view(runId);
  await service.approveFlow(runId, initiator, { flowSummarySha256: view.flow!.flowSummarySha256 });
}

/** Wait until no launch step runs for `runId` in `service`. */
async function settled(service: WorkflowDraftService, runId: string) {
  for (let i = 0; i < 400; i++) {
    const view = await service.view(runId);
    if (view.launch && !view.launch.running) return view;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`launch of ${runId} did not settle`);
}

/** Wait until `pred` holds (a hung step is "running" forever). */
async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

describe('拉群开始: the 8 steps', () => {
  it('local token: topic group with the executing bot, owner by open_id, root card, migration, grants, run.json, start', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    const confirmation = readWorkflowDraft(join(base, runId))!.flowConfirmation!;

    const first = await h.service.launch(runId, OWNER, {});
    expect(first.phase).toBe('launching');
    const view = await settled(h.service, runId);
    expect(view.phase).toBe('started');
    expect(view.launch).toMatchObject({ state: 'started', nextStep: 'done', grantedBots: [DOC] });

    // Step 1–2: the name carries the run id's random tail; one topic group;
    // the executing bot; the initiator through the open_id channel only.
    const marker = `#${runId.slice(-8)}`;
    const chat = launch.onlyChat();
    expect(chat.name.endsWith(` ${marker}`)).toBe(true);
    expect([...chat.members].sort()).toEqual([DOC, MAIN].sort());
    expect(chat.owner).toEqual({ channel: 'open_id', id: OWNER.openId });
    expect(chat.users).toEqual([OWNER.openId]);
    expect(chat.unionUsers).toEqual([]);
    expect(launch.count('listChats')).toBe(0);
    // Step 3–4: the root card is the first top-level message; the clarify
    // session moved into that topic; a summary in it.
    expect(chat.messages.map((m) => m.kind)).toEqual(['root', 'summary']);
    expect(chat.messages[0]!.view).toMatchObject({ runId, title: '代码风险报告', initiatorOpenId: OWNER.openId, nodeCount: 2 });
    expect(chat.messages[1]!.view).toMatchObject({ goal: '帮我出一份代码风险报告', nodes: [{ id: 'inspect', goal: '看改动' }, { id: 'write', goal: '写报告' }] });
    expect(launch.binds).toEqual([{ sessionId: 'sess-1', chatId: chat.chatId, rootMessageId: chat.messages[0]!.messageId }]);
    expect(view.clarify.state).toBe('migrated');
    // Step 6: both directions, each in its own app's namespace.
    expect(launch.granted(chat.chatId, MAIN)).toEqual([seenBy(MAIN, DOC)]);
    expect(launch.granted(chat.chatId, DOC)).toEqual([seenBy(DOC, MAIN)]);
    // Step 7: the run.
    const envelope = readRunEnvelope(join(base, runId), runId);
    expect(envelope.kind).toBe('ok');
    const run = (envelope as any).envelope;
    expect(run.chatBinding).toEqual({
      larkAppId: MAIN, chatId: chat.chatId, chatType: 'group', rootMessageId: chat.messages[0]!.messageId,
      sessionId: 'sess-1', ownerOpenId: OWNER.openId,
    });
    expect(run.nodeExecutor).toBe('bot');
    expect(run.authorization).toMatchObject({
      authorizedByOpenId: OWNER.openId,
      initiator: { openId: OWNER.openId, source: 'dashboard-local' },
      flowConfirmation: { confirmedByOpenId: OWNER.openId, confirmedAt: confirmation.confirmedAt, flowSummarySha256: confirmation.flowSummarySha256 },
    });
    expect(run.authorization.initiator.unionId).toBeUndefined();
    expect(readGrillState(join(base, runId))!.status).toBe('dag_approved');
    // Step 8: started once, through the real start intent.
    expect(launch.starts).toEqual([runId]);
    expect(readJournal(join(base, runId, 'journal.ndjson')).filter((e) => e.type === 'runStarted')).toHaveLength(1);
    // A started draft is a run: off the draft list; the launch still answers.
    expect(listWorkflowDrafts(base)).toEqual([]);
    expect((await h.service.continueLaunch(runId, OWNER)).phase).toBe('started');
    expect(launch.starts).toEqual([runId]);
  });

  it('platform login: the initiator joins and becomes owner by union_id only', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h, ALICE);
    await h.service.launch(runId, ALICE, { extraMembers: ['bob@example.com', 'on_carol'] });
    expect((await settled(h.service, runId)).phase).toBe('started');
    const chat = launch.onlyChat();
    expect(chat.owner).toEqual({ channel: 'union_id', id: ALICE.unionId });
    expect(chat.unionUsers).toEqual([ALICE.unionId, 'on_carol']);
    // The open_id channel carries only the extra member the main bot resolved.
    expect(chat.users).toEqual(['ou_bob']);
    const run = (readRunEnvelope(join(base, runId), runId) as any).envelope;
    expect(run.authorization.initiator).toEqual({ openId: ALICE.openId, unionId: ALICE.unionId, source: 'dashboard-platform' });
  });

  it('the initiator refused by Feishu: stops at the join step (group kept, nothing posted); 「继续」 retries until they are in', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.refusedPeople.add(OWNER.openId);
    await h.service.launch(runId, OWNER, {});
    const stopped = await settled(h.service, runId);
    expect(stopped.launch).toMatchObject({
      state: 'paused', nextStep: 'join',
      chat: { initiator: 'rejected' },
      error: { step: 'join', code: 'initiator_not_joined' },
    });
    const chat = launch.onlyChat();
    expect(chat.messages).toEqual([]);
    await h.service.continueLaunch(runId, OWNER);
    expect((await settled(h.service, runId)).launch).toMatchObject({ error: { step: 'join' } });
    launch.refusedPeople.delete(OWNER.openId);
    await h.service.continueLaunch(runId, OWNER);
    const done = await settled(h.service, runId);
    expect(done.phase).toBe('started');
    expect(done.launch!.chat).toMatchObject({ initiator: 'joined' });
    expect(chat.users).toEqual([OWNER.openId]);
    expect(chat.owner).toEqual({ channel: 'open_id', id: OWNER.openId });
    expect(launch.chats.size).toBe(1);
  });

  it('the initiator joined but could not be made owner: recorded and shown, the launch goes on', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h, ALICE);
    launch.noOwner.add(ALICE.unionId!);
    await h.service.launch(runId, ALICE, {});
    const done = await settled(h.service, runId);
    expect(done.phase).toBe('started');
    expect(done.launch!.chat).toMatchObject({ initiator: 'joined', ownerTransferError: 'transfer_failed' });
    expect(launch.count('joinInitiator')).toBe(0);
  });

  it('group name: a long title is cut, the marker never; the marker is the random tail, not the slug', () => {
    expect(launchMarker('run-261105-1000-0a1b2c3d')).toBe('#0a1b2c3d');
    expect(launchMarker('no-random-tail')).toBeUndefined();
    const name = launchGroupName('很长的标题'.repeat(30), '#0a1b2c3d');
    expect(Array.from(name).length).toBeLessThanOrEqual(50);
    expect(name.endsWith('… #0a1b2c3d')).toBe(true);
  });

  it('extra members: an open_id is refused before anything is written; an unknown email stops before the group', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    const refused = await h.service.launch(runId, OWNER, { extraMembers: ['ou_foreign_app_user'] }).catch((e) => e);
    expect(refused).toMatchObject({ code: 'bad_request', details: { reason: 'open_id_refused', item: 'ou_foreign_app_user' } });
    const unknown = await h.service.launch(runId, OWNER, { extraMembers: ['zzz'] }).catch((e) => e);
    expect(unknown).toMatchObject({ code: 'bad_request', details: { reason: 'unrecognized' } });
    expect(readWorkflowDraft(join(base, runId))!.launch).toBeUndefined();

    await h.service.launch(runId, OWNER, { extraMembers: ['nobody@example.com'] });
    const view = await settled(h.service, runId);
    expect(view.launch).toMatchObject({ state: 'paused', error: { step: 'members', code: 'members_unresolved' } });
    expect(launch.count('createGroup')).toBe(0);
  });

  it('a start failure carrying a credential is masked in the launch record and the view', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    const secret = 'abcdefghijklmnopqrstuvwxyz0123456789SECRET';
    launch.failNext('startRun', new Error(`upstream said Authorization: Bearer ${secret} rejected`));
    await h.service.launch(runId, OWNER, {});
    const view = await settled(h.service, runId);
    expect(view.launch!.error).toMatchObject({ step: 'start', retryable: true });
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(readFileSync(join(base, runId, 'draft.json'), 'utf8')).not.toContain(secret);
  });

  it('a clarify session that cannot be moved does not hold the launch up: run.json then names no session', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.setUnbindable('sess-1');
    await h.service.launch(runId, OWNER, {});
    const view = await settled(h.service, runId);
    expect(view.phase).toBe('started');
    expect(view.launch!.migrate).toMatchObject({ status: 'unavailable' });
    expect((launch.onlyChat().messages[1]!.view as any).sessionNote).toContain('没能迁入');
    expect((readRunEnvelope(join(base, runId), runId) as any).envelope.chatBinding.sessionId).toBeUndefined();
  });
});

describe('断点续做: crash after each step, then 「继续」', () => {
  const cases: Array<{ name: string; hang: Parameters<ReturnType<typeof fakeLaunch>['hang']>[0]; at: (l: ReturnType<typeof fakeLaunch>) => boolean }> = [
    { name: 'group built, nothing recorded', hang: 'createGroup', at: (l) => l.chats.size === 1 },
    { name: 'root card posted, not recorded', hang: 'postRootCard', at: (l) => l.count('postRootCard') === 1 },
    { name: 'session bound, not recorded', hang: 'bindSession', at: (l) => l.binds.length === 1 },
    { name: 'summary posted, not recorded', hang: 'postSummary', at: (l) => l.count('postSummary') === 1 },
    { name: 'one grant side written, not recorded', hang: 'grant', at: (l) => l.count('grant') === 1 },
    { name: 'run started, not recorded', hang: 'startRun', at: (l) => l.starts.length === 1 },
  ];

  for (const testCase of cases) {
    it(`${testCase.name}: no duplicate group, root card, binding, summary or start`, async () => {
      const { h, launch } = setup();
      const runId = await confirmed(h);
      launch.hang(testCase.hang);
      await h.service.launch(runId, OWNER, {});
      await until(() => testCase.at(launch));

      // The next process: the launch is not resumed by itself.
      const next = restart(h);
      const callsAtBoot = launch.calls.length;
      const paused = await next.view(runId);
      expect(paused.launch).toMatchObject({ state: 'paused', running: false, error: { step: 'interrupted', code: 'daemon_restarted' } });
      expect(paused.phase).toBe('launching');
      expect(launch.calls.length).toBe(callsAtBoot);

      await next.continueLaunch(runId, OWNER);
      const done = await settled(next, runId);
      expect(done.phase).toBe('started');
      const chat = launch.onlyChat();
      expect(chat.messages.filter((m) => m.kind === 'root')).toHaveLength(1);
      expect(chat.messages.filter((m) => m.kind === 'summary')).toHaveLength(1);
      expect(launch.binds).toHaveLength(1);
      expect(launch.granted(chat.chatId, MAIN)).toEqual([seenBy(MAIN, DOC)]);
      expect(readJournal(join(base, runId, 'journal.ndjson')).filter((e) => e.type === 'runStarted')).toHaveLength(1);
      if (testCase.hang === 'createGroup') {
        // Recovered by its marker, not built again.
        expect(done.launch!.chat).toMatchObject({ chatId: chat.chatId, recovered: true, initiator: 'joined' });
        expect(launch.count('createGroup')).toBe(1);
        // Unknown for a recovered group: joined (and made owner) again.
        expect(launch.count('joinInitiator')).toBe(1);
      }
    });
  }

  it('run.json written but its record lost: 「继续」 re-records the same run and starts it', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.failNext('startRun', new Error('boom'));
    await h.service.launch(runId, OWNER, {});
    const stopped = await settled(h.service, runId);
    expect(stopped.launch).toMatchObject({ state: 'paused', error: { step: 'start' } });
    const runJson = readFileSync(join(base, runId, 'run.json'), 'utf-8');
    // As if the process died right after publishing run.json.
    const record = readWorkflowDraft(join(base, runId))!;
    delete record.launch!.commit;
    writeWorkflowDraft(join(base, runId), record);
    expect(listWorkflowDrafts(base).map((d) => [d.runId, d.phase])).toEqual([[runId, 'launching']]);
    // Only the launch may go on now.
    expect(await code(h.service.reviseSpec(runId, OWNER))).toBe('run_committed');
    expect(await code(h.service.abandon(runId, OWNER))).toBe('run_committed');

    const next = restart(h);
    await next.continueLaunch(runId, OWNER);
    expect((await settled(next, runId)).phase).toBe('started');
    expect(readFileSync(join(base, runId, 'run.json'), 'utf-8')).toBe(runJson);
    expect(readWorkflowDraft(join(base, runId))!.launch!.commit).toBeDefined();
    expect(launch.count('createGroup')).toBe(1);
  });

  it('the group was built and its record lost, then its name was changed: listed as a possible orphan, a new group built', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.hang('createGroup');
    await h.service.launch(runId, OWNER, {});
    await until(() => launch.chats.size === 1);
    launch.onlyChat().name = '有人改了群名';
    const next = restart(h);
    await next.continueLaunch(runId, OWNER);
    const view = await settled(next, runId);
    expect(view.phase).toBe('started');
    expect(launch.count('listChats')).toBe(1);
    expect(launch.chats.size).toBe(2);
    expect(view.launch!.orphanSuspects).toEqual([expect.objectContaining({ attemptAt: expect.any(String) })]);
  });

  it('a group-list failure after an unrecorded create never builds a second group', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.hang('createGroup');
    await h.service.launch(runId, OWNER, {});
    await until(() => launch.chats.size === 1);
    const next = restart(h);
    launch.failNext('listChats', new Error('lark 500'));
    await next.continueLaunch(runId, OWNER);
    expect((await settled(next, runId)).launch).toMatchObject({ state: 'paused', error: { step: 'group', code: 'list_chats_failed' } });
    expect(launch.count('createGroup')).toBe(1);
    await next.continueLaunch(runId, OWNER);
    expect((await settled(next, runId)).phase).toBe('started');
    expect(launch.chats.size).toBe(1);
  });
});

describe('第 5–6 步: live check, swapping a bot, grants', () => {
  it('a bot that cannot join stops at the check with no grant written; swapping it voids the confirmation, then the new bot is invited, checked and granted', async () => {
    const { h, launch } = setup();
    launch.uninvitable.add(DOC);
    const runId = await confirmed(h);
    await h.service.launch(runId, OWNER, {});
    const stopped = await settled(h.service, runId);
    expect(stopped.launch).toMatchObject({
      state: 'paused', nextStep: 'check',
      error: { step: 'check', code: 'bots_ineligible' },
      check: { ok: false, problems: [{ nodeId: 'write', larkAppId: DOC, code: 'BOT_NOT_IN_CHAT' }] },
    });
    // 「重试拉人」 happened once inside the check.
    expect(launch.calls.filter((c) => c.op === 'addBots').map((c) => c.args[1])).toEqual([[DOC]]);
    const chat = launch.onlyChat();
    expect(launch.count('grant')).toBe(0);
    expect(existsSync(join(base, runId, 'run.json'))).toBe(false);

    // Past the requirement stage: only a bot swap or abandon.
    expect(await code(h.service.reviseSpec(runId, OWNER))).toBe('state_conflict');
    expect(await code(h.service.startArchitect(runId, OWNER))).toBe('state_conflict');
    expect(await code(h.service.sendMessage(runId, OWNER, { text: 'x' }))).toBe('state_conflict');
    await h.service.setNodeBot(runId, OWNER, 'write', { larkAppId: REVIEW });
    const swapped = await h.service.view(runId);
    expect(swapped.phase).toBe('dag_ready');
    expect(swapped.flowConfirmation?.valid ?? false).toBe(false);
    expect(await code(h.service.continueLaunch(runId, OWNER))).toBe('flow_changed');
    await reconfirm(h.service, runId);
    expect((await h.service.view(runId)).phase).toBe('launching');
    await h.service.continueLaunch(runId, OWNER);
    const done = await settled(h.service, runId);
    expect(done.phase).toBe('started');
    expect(chat.members.has(REVIEW)).toBe(true);
    expect(launch.granted(chat.chatId, MAIN)).toEqual([seenBy(MAIN, REVIEW)]);
    expect(launch.granted(chat.chatId, DOC)).toEqual([]);
    const run = (readRunEnvelope(join(base, runId), runId) as any).envelope;
    expect(run.chatBinding.chatId).toBe(chat.chatId);
    expect(launch.chats.size).toBe(1);
  });

  it('swap after grants: DOC is revoked on both receivers without being in the group; a failed revoke is retried by 「继续」', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    // Stop at the commit: the run's DAG changes on disk between grant and
    // commit, so step 7 refuses (covered below); here we only need grants.
    launch.beforeGrantReturn = () => {
      if (launch.count('grant') === 2) {
        const grill = readGrillState(join(base, runId))!;
        const dag = JSON.parse(readFileSync(grill.dagPath!, 'utf-8'));
        writeFileSync(grill.dagPath!, `${JSON.stringify(dag)}\n`);
      }
    };
    await h.service.launch(runId, OWNER, {});
    const stopped = await settled(h.service, runId);
    expect(stopped.launch).toMatchObject({ error: { step: 'commit', code: 'flow_changed' }, grantedBots: [DOC] });
    launch.beforeGrantReturn = undefined;
    const chat = launch.onlyChat();
    chat.members.delete(DOC);

    launch.failNext('revoke', new Error('receiver daemon offline'));
    await h.service.setNodeBot(runId, OWNER, 'write', { larkAppId: REVIEW });
    // The first revoke failed: still recorded, retried below.
    expect(readWorkflowDraft(join(base, runId))!.launch!.grants?.[DOC]).toBeDefined();
    await reconfirm(h.service, runId);
    await h.service.continueLaunch(runId, OWNER);
    expect((await settled(h.service, runId)).phase).toBe('started');
    expect(launch.granted(chat.chatId, MAIN)).toEqual([seenBy(MAIN, REVIEW)]);
    expect(launch.granted(chat.chatId, DOC)).toEqual([]);
    expect(readWorkflowDraft(join(base, runId))!.launch!.grants).toEqual({ [REVIEW]: expect.objectContaining({ mainSide: seenBy(MAIN, REVIEW), peerSide: seenBy(REVIEW, MAIN) }) });
  });
});

describe('第 7 步: run.json only for exactly the confirmed flow', () => {
  const drift: Array<{ name: string; tamper: (runDir: string, fleet: any[]) => void }> = [
    {
      name: 'the DAG bytes changed',
      tamper: (runDir) => {
        const grill = readGrillState(runDir)!;
        writeFileSync(grill.dagPath!, `${JSON.stringify(JSON.parse(readFileSync(grill.dagPath!, 'utf-8')))}\n`);
      },
    },
    {
      name: 'the spec bytes changed',
      tamper: (runDir) => {
        const grill = readGrillState(runDir)!;
        writeFileSync(grill.specJsonPath, `${JSON.stringify(JSON.parse(readFileSync(grill.specJsonPath, 'utf-8')))}\n`);
      },
    },
    {
      name: 'only the flow summary changed (an executing bot switched CLI)',
      tamper: (_runDir, fleet) => { fleet.find((bot) => bot.larkAppId === DOC).cliId = 'codex'; },
    },
  ];
  for (const testCase of drift) {
    it(`${testCase.name}: refused, back to 待确认流程, no run.json`, async () => {
      const fleet = FLEET.map((bot) => ({ ...bot }));
      const launch = fakeLaunch(base);
      launch.setOnline(ONLINE);
      const h = makeService(base, { loadBots: () => fleet, launch: launch.deps });
      h.setOnline(ONLINE);
      const runId = await confirmed(h);
      launch.beforeGrantReturn = () => { if (launch.count('grant') === 2) testCase.tamper(join(base, runId), fleet); };
      await h.service.launch(runId, OWNER, {});
      const view = await settled(h.service, runId);
      expect(view.launch).toMatchObject({ state: 'paused', error: { step: 'commit', code: 'flow_changed' } });
      expect(view.phase).toBe('dag_ready');
      expect(view.flowConfirmation).toBeUndefined();
      expect(existsSync(join(base, runId, 'run.json'))).toBe(false);
      expect(launch.starts).toEqual([]);
    });
  }
});

describe('concurrency: two tabs, a swap mid-launch, abandon', () => {
  it('while a step runs, every write of the initiator is refused deterministically; afterwards they work', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.hang('postRootCard');
    const [a, b] = await Promise.all([code(h.service.launch(runId, OWNER, {})), code(h.service.launch(runId, OWNER, {}))]);
    expect([a, b].sort()).toEqual(['launch_exists', 'ok']);
    await until(() => launch.count('postRootCard') === 1);
    expect(await code(h.service.continueLaunch(runId, OWNER))).toBe('launch_running');
    expect(await code(h.service.setNodeBot(runId, OWNER, 'write', { larkAppId: REVIEW }))).toBe('launch_running');
    expect(await code(h.service.abandon(runId, OWNER))).toBe('launch_running');
    expect(await code(h.service.abandonLaunch(runId, OWNER))).toBe('launch_running');
    expect(await code(h.service.reviseSpec(runId, OWNER))).toBe('launch_running');
    expect(await code(h.service.continueLaunch(runId, ALICE))).toBe('not_initiator');
    expect((await h.service.view(runId)).launch).toMatchObject({ state: 'running', running: true, nextStep: 'root' });

    const next = restart(h);
    const [c, d] = await Promise.all([code(next.continueLaunch(runId, OWNER)), code(next.continueLaunch(runId, OWNER))]);
    expect([c, d].sort()).toEqual(['launch_running', 'ok']);
    expect((await settled(next, runId)).phase).toBe('started');
    expect(launch.onlyChat().messages.filter((m) => m.kind === 'root')).toHaveLength(1);
  });

  it('「拉群开始」 needs the second confirmation (and the initiator)', async () => {
    const { h } = setup();
    const created = await h.service.create(OWNER, { goal: 'g' });
    expect(await code(h.service.launch(created.runId, OWNER, {}))).toBe('state_conflict');
    const runId = await confirmed(h);
    expect(await code(h.service.launch(runId, ALICE, {}))).toBe('not_initiator');
    await h.service.setNodeBot(runId, OWNER, 'write', { larkAppId: REVIEW });
    expect(await code(h.service.launch(runId, OWNER, {}))).toBe('flow_changed');
    expect(await code(h.service.continueLaunch(runId, OWNER))).toBe('no_launch');
  });

  it('abandon after the root card: the group stays, the card says so, the moved session stays; nothing continues', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.failNext('grant', new Error('grant endpoint down'));
    await h.service.launch(runId, OWNER, {});
    expect((await settled(h.service, runId)).launch).toMatchObject({ error: { step: 'grant' } });
    const view = await h.service.abandonLaunch(runId, OWNER);
    expect(view).toMatchObject({ phase: 'abandoned', launch: { state: 'abandoned' }, clarify: { state: 'migrated' } });
    const root = launch.onlyChat().messages[0]!;
    expect(root.updates).toEqual([expect.objectContaining({ abandoned: true, runId })]);
    expect(h.clarify.sessions.get('sess-1')!.closed).toBe(false);
    expect(readWorkflowDraft(join(base, runId))!.launch!.root!.abandonNoted).toBe(true);
    expect(await code(h.service.continueLaunch(runId, OWNER))).toBe('draft_abandoned');
    expect(await code(h.service.abandonLaunch(runId, OWNER))).toBe('draft_abandoned');
    expect(launch.chats.size).toBe(1);
  });

  it('a root card update that failed is retried by abandoning again', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.failNext('grant', new Error('down'));
    await h.service.launch(runId, OWNER, {});
    await settled(h.service, runId);
    launch.failNext('updateRootCard', new Error('lark 500'));
    await h.service.abandon(runId, OWNER);
    expect(readWorkflowDraft(join(base, runId))!.launch!.root!.abandonNoted).toBeUndefined();
    await h.service.abandon(runId, OWNER);
    expect(readWorkflowDraft(join(base, runId))!.launch!.root!.abandonNoted).toBe(true);
  });

  it('abandon before any group: no card to update; the clarify session is closed as for any draft', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.failNext('createGroup', new Error('quota'));
    await h.service.launch(runId, OWNER, {});
    expect((await settled(h.service, runId)).launch).toMatchObject({ error: { step: 'group', code: 'create_group_failed' } });
    const view = await h.service.abandonLaunch(runId, OWNER);
    expect(view).toMatchObject({ phase: 'abandoned', clarify: { state: 'closed' } });
    expect(launch.count('updateRootCard')).toBe(0);
  });

  it('without launch collaborators the daemon answers launch_unavailable', async () => {
    const h = makeService(base, { loadBots: () => FLEET });
    h.setOnline(ONLINE);
    const runId = await confirmed(h);
    expect(await code(h.service.launch(runId, OWNER, {}))).toBe('launch_unavailable');
    expect(readWorkflowDraft(join(base, runId))!.launch).toBeUndefined();
  });
});

describe('第 7 步: the draft\'s project goes into run.json for the nodes (nodeProjectDir)', () => {
  /** `reads`: whose daemons advertise reading it (absent = the dep is not wired). */
  function launchWith(reads: ((appId: string) => boolean) | undefined, logs: string[] = []) {
    const launch = fakeLaunch(base);
    launch.setOnline(ONLINE);
    const h = makeService(base, {
      loadBots: () => FLEET,
      launch: launch.deps,
      ...(reads ? { daemonReadsNodeProjectDir: reads } : {}),
      log: (message) => { logs.push(message); },
    });
    h.setOnline(ONLINE);
    return h;
  }

  async function launchedRun(h: ReturnType<typeof makeService>, runId: string) {
    await h.service.launch(runId, OWNER, {});
    expect((await settled(h.service, runId)).phase).toBe('started');
    const read = readRunEnvelope(join(base, runId), runId);
    expect(read.kind).toBe('ok');
    return (read as any).envelope;
  }

  it('every executing bot\'s daemon reads it: run.json carries the draft\'s project, and nothing else changes', async () => {
    const asked: string[] = [];
    const h = launchWith((appId) => { asked.push(appId); return true; });
    const runId = await confirmed(h);
    const projectDir = readWorkflowDraft(join(base, runId))!.projectDir;
    expect(projectDir).toBe(DEFAULT_PROJECT);
    const run = await launchedRun(h, runId);
    expect(run.nodeProjectDir).toBe(DEFAULT_PROJECT);
    expect(run.nodeWorkingDir).toBeUndefined();
    // Only the other executing bots are asked: the main bot is this daemon.
    expect([...new Set(asked)]).toEqual([DOC]);
    // The frozen snapshots are as before (the project is not every node's directory).
    expect(readFileSync(join(base, runId, 'bots.snapshot.json'), 'utf-8')).not.toContain(DEFAULT_PROJECT);
  });

  it('an executing bot\'s daemon is an older version, or the check is not wired: the project is left out and the run starts as before', async () => {
    for (const reads of [(appId: string) => appId !== DOC, () => { throw new Error('registry unreadable'); }, undefined]) {
      const logs: string[] = [];
      const h = launchWith(reads, logs);
      const runId = await confirmed(h);
      const run = await launchedRun(h, runId);
      // Exactly the keys an older daemon's strict reader accepts.
      expect(run).not.toHaveProperty('nodeProjectDir');
      expect(JSON.parse(readFileSync(join(base, runId, 'run.json'), 'utf-8'))).not.toHaveProperty('nodeProjectDir');
      if (reads) expect(logs.join('\n')).toContain(`older daemon: ${DOC}`);
      rmSync(join(base, runId), { recursive: true, force: true });
    }
  });

  it('a draft from before projects (no project recorded) launches as before: no project in run.json', async () => {
    const h = launchWith(() => true);
    const runId = await confirmed(h);
    const dir = join(base, runId);
    const draft = readWorkflowDraft(dir)!;
    delete draft.projectDir;
    writeWorkflowDraft(dir, draft);
    const run = await launchedRun(h, runId);
    expect(run).not.toHaveProperty('nodeProjectDir');
  });
});
