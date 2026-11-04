/**
 * 拉群开始 (design 2026-11-03 workflow-dashboard-orchestration §4.5, D4):
 * the overlaps found by the independent review — a slow revoke against
 * 「继续」, a grant / bind / post whose result was lost, the idle sweep during
 * a launch, recovery with several marked groups, deleting a stalled launch,
 * Feishu's one-hour uuid window — and the two missing guards (abandon /
 * delete keep a moved session; a run.json that is not this launch's).
 *
 * Real draft service, grill state machine, host Gate-2, run.json schema and
 * start intent on a real run dir; Feishu, the clarify session and the
 * Architect are fakes. "Crash" = a collaborator that never returns, then a
 * new service on the same dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LAUNCH_UUID_DEDUP_SAFE_MS, WorkflowDraftError, WorkflowDraftService } from '../src/workflows/v3/draft-service.js';
import { readWorkflowDraft, writeWorkflowDraft } from '../src/workflows/v3/draft-store.js';
import { readGrillState } from '../src/workflows/v3/grill-state.js';
import { BOTS, DOC, MAIN, OWNER, PI, SKETCHES, STEWARD, architectSettled, makeService, specMarkdown } from './helpers/workflow-draft-fakes.js';
import { fakeLaunch, seenBy } from './helpers/workflow-launch-fakes.js';

const REVIEW = 'cli_review';
const FLEET = [...BOTS, { larkAppId: REVIEW, larkAppSecret: 's-rv', name: 'review', cliId: 'claude-code' }] as any[];
const ONLINE = [MAIN, DOC, REVIEW, STEWARD, PI];

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'wf-launch-review-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

async function code(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { if (error instanceof WorkflowDraftError) return error.code; throw error; }
  return 'ok';
}
function setup() {
  const launch = fakeLaunch(base);
  launch.setOnline(ONLINE);
  const h = makeService(base, { loadBots: () => FLEET, launch: launch.deps });
  h.setOnline(ONLINE);
  return { h, launch };
}
function restart(h: ReturnType<typeof makeService>): WorkflowDraftService {
  const service = new WorkflowDraftService({ ...h.deps });
  service.recoverInterrupted();
  return service;
}
async function confirmed(h: ReturnType<typeof makeService>): Promise<string> {
  const created = await h.service.create(OWNER, { goal: '帮我出一份代码风险报告' });
  h.clarify.reply(`好的。\n<botmux-spec>\n${specMarkdown(SKETCHES)}\n</botmux-spec>`);
  expect((await h.service.finalizeSpec(created.runId, OWNER, {})).ok).toBe(true);
  await h.service.approveSpec(created.runId, OWNER);
  await h.service.startArchitect(created.runId, OWNER);
  await architectSettled(h.service, created.runId);
  const view = await h.service.view(created.runId);
  await h.service.approveFlow(created.runId, OWNER, { flowSummarySha256: view.flow!.flowSummarySha256 });
  return created.runId;
}
async function reconfirm(service: WorkflowDraftService, runId: string) {
  const view = await service.view(runId);
  await service.approveFlow(runId, OWNER, { flowSummarySha256: view.flow!.flowSummarySha256 });
}
async function settled(service: WorkflowDraftService, runId: string) {
  for (let i = 0; i < 400; i++) {
    const view = await service.view(runId);
    if (view.launch && !view.launch.running) return view;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('launch did not settle');
}
async function until(pred: () => boolean) {
  for (let i = 0; i < 400; i++) { if (pred()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error('condition not reached');
}
const record = (runId: string) => readWorkflowDraft(join(base, runId))!;
/** Rewrite the DAG bytes (same content): the commit step then refuses. */
const touchDag = (runId: string) => {
  const grill = readGrillState(join(base, runId))!;
  writeFileSync(grill.dagPath!, `${JSON.stringify(JSON.parse(readFileSync(grill.dagPath!, 'utf-8')))}\n`);
};
/** Launch, stop at the commit with both DOC grants written. */
async function grantedThenStopped(h: ReturnType<typeof makeService>, launch: ReturnType<typeof fakeLaunch>) {
  const runId = await confirmed(h);
  launch.beforeGrantReturn = () => { if (launch.count('grant') === 2) touchDag(runId); };
  await h.service.launch(runId, OWNER, {});
  const stopped = await settled(h.service, runId);
  expect(stopped.launch).toMatchObject({ error: { step: 'commit' }, grantedBots: [DOC] });
  launch.beforeGrantReturn = undefined;
  return runId;
}

describe('P2-1: a swap-out revoke holds the launch', () => {
  it('while the revoke is slow, a second swap and 「继续」 are refused; afterwards swapping back re-grants and the run keeps its grants', async () => {
    const { h, launch } = setup();
    const runId = await grantedThenStopped(h, launch);
    const chat = launch.onlyChat();
    const realRevoke = launch.deps.revoke;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    launch.deps.revoke = async (...args) => { if (!entered) { entered = true; await gate; } return realRevoke(...args); };

    const swapOut = h.service.setNodeBot(runId, OWNER, 'write', { larkAppId: REVIEW });
    await until(() => entered);
    expect(await code(h.service.setNodeBot(runId, OWNER, 'write', { larkAppId: DOC }))).toBe('launch_running');
    expect(await code(h.service.continueLaunch(runId, OWNER))).toBe('launch_running');
    expect((await h.service.view(runId)).launch).toMatchObject({ running: true });
    release();
    await swapOut;
    expect(record(runId).launch!.grants).toBeUndefined();
    expect(launch.granted(chat.chatId, MAIN)).toEqual([]);

    await h.service.setNodeBot(runId, OWNER, 'write', { larkAppId: DOC });
    await reconfirm(h.service, runId);
    await h.service.continueLaunch(runId, OWNER);
    expect((await settled(h.service, runId)).phase).toBe('started');
    expect(launch.granted(chat.chatId, MAIN)).toEqual([seenBy(MAIN, DOC)]);
    expect(launch.granted(chat.chatId, DOC)).toEqual([seenBy(DOC, MAIN)]);
  });

  it('a bot that executes a node again after its grants were revoked loses its record, so the grant step writes them afresh', async () => {
    const { h, launch } = setup();
    const runId = await grantedThenStopped(h, launch);
    const chat = launch.onlyChat();
    const realRevoke = launch.deps.revoke;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    launch.deps.revoke = async (...args) => { if (!entered) { entered = true; await gate; } return realRevoke(...args); };
    const grill = readGrillState(join(base, runId))!;
    const swapOut = h.service.setNodeBot(runId, OWNER, 'write', { larkAppId: REVIEW });
    await until(() => entered);
    // The flow changes back under the revoke (not through the API).
    const dag = JSON.parse(readFileSync(grill.dagPath!, 'utf-8'));
    dag.nodes.find((node: any) => node.id === 'write').bot = DOC;
    writeFileSync(grill.dagPath!, `${JSON.stringify(dag, null, 2)}\n`);
    release();
    await swapOut;
    expect(record(runId).launch!.grants?.[DOC]).toBeUndefined();
    await reconfirm(h.service, runId);
    await h.service.continueLaunch(runId, OWNER);
    expect((await settled(h.service, runId)).phase).toBe('started');
    expect(launch.granted(chat.chatId, MAIN)).toEqual([seenBy(MAIN, DOC)]);
  });
});

describe('P2-2: a grant whose result was lost is still revoked', () => {
  it('written, crash before its record: swapping the bot out revokes it by app id on the receiver', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.hang('grant');
    await h.service.launch(runId, OWNER, {});
    await until(() => launch.count('grant') === 1);
    const chat = launch.onlyChat();
    expect(launch.granted(chat.chatId, MAIN)).toEqual([seenBy(MAIN, DOC)]);
    expect(record(runId).launch!.grants?.[DOC]).toMatchObject({ mainPending: true });
    const next = restart(h);
    await next.setNodeBot(runId, OWNER, 'write', { larkAppId: REVIEW });
    expect(launch.calls.filter((c) => c.op === 'revokeByApp').map((c) => c.args)).toEqual([[chat.chatId, MAIN, DOC]]);
    expect(launch.granted(chat.chatId, MAIN)).toEqual([]);
    await reconfirm(next, runId);
    await next.continueLaunch(runId, OWNER);
    expect((await settled(next, runId)).phase).toBe('started');
    expect(launch.granted(chat.chatId, MAIN)).toEqual([seenBy(MAIN, REVIEW)]);
    expect(launch.granted(chat.chatId, DOC)).toEqual([]);
  });
});

describe('P2-3 / P3-1: a session being moved into the main topic is never the draft\'s to close or suspend', () => {
  it('bound, crash before the record: abandon and delete leave the session alone', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.hang('bindSession');
    await h.service.launch(runId, OWNER, {});
    await until(() => launch.binds.length === 1);
    expect(record(runId).launch!.migrate).toMatchObject({ status: 'binding', sessionId: 'sess-1' });
    const next = restart(h);
    await next.abandonLaunch(runId, OWNER);
    expect(h.clarify.sessions.get('sess-1')!.closed).toBe(false);
    await next.delete(runId, OWNER);
    expect(h.clarify.sessions.get('sess-1')!.closed).toBe(false);
    expect(existsSync(join(base, runId))).toBe(false);
  });

  it('bound, crash before the record: 「继续」 reconciles the move (no second bind) and goes on', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.hang('bindSession');
    await h.service.launch(runId, OWNER, {});
    await until(() => launch.binds.length === 1);
    const next = restart(h);
    await next.continueLaunch(runId, OWNER);
    const done = await settled(next, runId);
    expect(done.phase).toBe('started');
    expect(done.launch!.migrate).toMatchObject({ status: 'bound', sessionId: 'sess-1' });
    expect(launch.binds).toHaveLength(1);
  });

  it('the idle sweep suspends no clarify session of a draft whose launch began (before, during and after the move)', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.failNext('postRootCard', new Error('down'));
    await h.service.launch(runId, OWNER, {});
    await settled(h.service, runId);
    h.advance(31 * 60_000);
    expect(await h.service.sweepIdleClarify()).toEqual([]);
    launch.hang('bindSession');
    await h.service.continueLaunch(runId, OWNER);
    await until(() => launch.binds.length === 1);
    const next = restart(h);
    h.advance(31 * 60_000);
    expect(await next.sweepIdleClarify()).toEqual([]);
    expect(h.clarify.suspended).toEqual([]);
  });

  it('M2: abandon and then delete after the move keep the main-topic session', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.failNext('grant', new Error('down'));
    await h.service.launch(runId, OWNER, {});
    expect((await settled(h.service, runId)).clarify.state).toBe('migrated');
    await h.service.abandonLaunch(runId, OWNER);
    await h.service.delete(runId, OWNER);
    expect(existsSync(join(base, runId))).toBe(false);
    expect(h.clarify.sessions.get('sess-1')!.closed).toBe(false);
  });
});

describe('P3-2: recovering the group by its marker', () => {
  it('a group that only carries the marker (another owner, or not a topic group) is not taken', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.hang('createGroup');
    await h.service.launch(runId, OWNER, {});
    await until(() => launch.chats.size === 1);
    const real = launch.onlyChat();
    const marker = `#${runId.slice(-8)}`;
    launch.chats.delete(real.chatId);
    launch.chats.set('oc_foreign', { chatId: 'oc_foreign', name: `别人的群 ${marker}`, members: new Set([MAIN]), users: [], unionUsers: [], owner: { channel: 'open_id', id: 'ou_stranger' }, messages: [] });
    launch.chats.set('oc_plain', { chatId: 'oc_plain', name: `普通群 ${marker}`, chatMode: 'group', members: new Set([MAIN]), users: [], unionUsers: [], messages: [] });
    launch.chats.set(real.chatId, real);
    const next = restart(h);
    await next.continueLaunch(runId, OWNER);
    const done = await settled(next, runId);
    expect(done.phase).toBe('started');
    expect(done.launch!.chat).toMatchObject({ chatId: real.chatId, recovered: true });
  });

  it('two groups this launch could have built: stops, lists both, picks neither', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.hang('createGroup');
    await h.service.launch(runId, OWNER, {});
    await until(() => launch.chats.size === 1);
    const real = launch.onlyChat();
    launch.chats.set('oc_twin', { ...real, chatId: 'oc_twin', messages: [] });
    const next = restart(h);
    await next.continueLaunch(runId, OWNER);
    const stopped = await settled(next, runId);
    expect(stopped.launch).toMatchObject({ state: 'paused', error: { step: 'group', code: 'recover_ambiguous' } });
    expect(stopped.launch!.chat).toBeUndefined();
    expect(stopped.launch!.orphanSuspects!.map((o) => o.chatId).sort()).toEqual([real.chatId, 'oc_twin'].sort());
    expect(launch.count('createGroup')).toBe(1);
  });
});

describe('P3-3: deleting a stalled launch', () => {
  it('30 days later the delete first marks the root card abandoned; a card update that fails keeps the draft', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.failNext('grant', new Error('down'));
    await h.service.launch(runId, OWNER, {});
    await settled(h.service, runId);
    h.advance(31 * 24 * 3600_000);
    launch.failNext('updateRootCard', new Error('lark 500'));
    expect(await code(h.service.delete(runId, OWNER))).toBe('root_update_failed');
    expect(existsSync(join(base, runId))).toBe(true);
    await h.service.delete(runId, OWNER);
    expect(existsSync(join(base, runId))).toBe(false);
    expect(launch.onlyChat().messages[0]!.updates).toEqual([expect.objectContaining({ abandoned: true })]);
  });
});

describe('P3-4: Feishu deduplicates a uuid for about an hour', () => {
  it('root card posted, record lost, resumed within the window: the same uuid is resent (one card)', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.hang('postRootCard');
    await h.service.launch(runId, OWNER, {});
    await until(() => launch.count('postRootCard') === 1);
    const next = restart(h);
    h.advance(LAUNCH_UUID_DEDUP_SAFE_MS - 60_000);
    await next.continueLaunch(runId, OWNER);
    expect((await settled(next, runId)).phase).toBe('started');
    const uuids = launch.calls.filter((c) => c.op === 'postRootCard').map((c) => c.args[2]);
    expect(uuids).toHaveLength(2);
    expect(new Set(uuids).size).toBe(1);
    expect(launch.onlyChat().messages.filter((m) => m.kind === 'root')).toHaveLength(1);
  });

  it('past the window: the card is found in the group and adopted, nothing is sent again', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.hang('postRootCard');
    await h.service.launch(runId, OWNER, {});
    await until(() => launch.count('postRootCard') === 1);
    const next = restart(h);
    h.advance(LAUNCH_UUID_DEDUP_SAFE_MS + 60_000);
    await next.continueLaunch(runId, OWNER);
    const done = await settled(next, runId);
    expect(done.phase).toBe('started');
    expect(launch.count('postRootCard')).toBe(1);
    expect(done.launch!.root!.messageId).toBe(launch.onlyChat().messages[0]!.messageId);
  });

  it('past the window, not found or the lookup failed: stops for a person, sends nothing', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.hangBefore('postRootCard');
    await h.service.launch(runId, OWNER, {});
    await until(() => launch.count('postRootCard') === 1);
    const next = restart(h);
    h.advance(LAUNCH_UUID_DEDUP_SAFE_MS + 60_000);
    await next.continueLaunch(runId, OWNER);
    expect((await settled(next, runId)).launch).toMatchObject({ error: { step: 'root', code: 'root_unverified' } });
    launch.failNext('findRootCards', new Error('lark 500'));
    await next.continueLaunch(runId, OWNER);
    expect((await settled(next, runId)).launch).toMatchObject({ error: { step: 'root', code: 'root_unverified' } });
    expect(launch.count('postRootCard')).toBe(1);
    expect(launch.onlyChat().messages).toEqual([]);
  });

  it('summary never posted (crash before it): 「继续」 posts it', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.hangBefore('postSummary');
    await h.service.launch(runId, OWNER, {});
    await until(() => launch.count('postSummary') === 1);
    const next = restart(h);
    await next.continueLaunch(runId, OWNER);
    const done = await settled(next, runId);
    expect(done.phase).toBe('started');
    expect(done.launch!.migrate!.summaryMessageId).toBeDefined();
    expect(launch.onlyChat().messages.filter((m) => m.kind === 'summary')).toHaveLength(1);
  });

  it('a summary recorded as pending but lost past the window is not sent twice', async () => {
    const { h: h2, launch: launch2 } = setup();
    const other = await confirmed(h2);
    launch2.hang('postSummary');
    await h2.service.launch(other, OWNER, {});
    await until(() => launch2.count('postSummary') === 1);
    const next2 = restart(h2);
    h2.advance(LAUNCH_UUID_DEDUP_SAFE_MS + 60_000);
    await next2.continueLaunch(other, OWNER);
    const done2 = await settled(next2, other);
    expect(done2.phase).toBe('started');
    expect(done2.launch!.migrate!.summaryError).toBeDefined();
    expect(launch2.count('postSummary')).toBe(1);
  });
});

describe('M6: a run.json already there must be this launch\'s', () => {
  const tampers: Array<[string, (envelope: any) => void]> = [
    ['another group', (e) => { e.chatBinding.chatId = 'oc_other'; }],
    ['another root', (e) => { e.chatBinding.rootMessageId = 'om_other'; }],
    ['another bot', (e) => { e.chatBinding.larkAppId = DOC; }],
    ['another initiator', (e) => { e.authorization.initiator.openId = 'ou_other'; }],
  ];
  for (const [name, tamper] of tampers) {
    it(`${name}: refused, not adopted, not started`, async () => {
      const { h, launch } = setup();
      const runId = await confirmed(h);
      launch.failNext('startRun', new Error('boom'));
      await h.service.launch(runId, OWNER, {});
      await settled(h.service, runId);
      const path = join(base, runId, 'run.json');
      const envelope = JSON.parse(readFileSync(path, 'utf-8'));
      tamper(envelope);
      writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`);
      const draft = record(runId);
      delete draft.launch!.commit;
      writeWorkflowDraft(join(base, runId), draft);
      await h.service.continueLaunch(runId, OWNER);
      const stopped = await settled(h.service, runId);
      expect(stopped.launch!.commit).toBeUndefined();
      expect(stopped.launch).toMatchObject({ state: 'paused', error: { code: 'internal_error' } });
      expect(stopped.launch!.error!.message).toContain('不是这次拉群写的');
      expect(launch.starts).toEqual([]);
    });
  }
});
