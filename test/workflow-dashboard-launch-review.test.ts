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
  it('written, crash before its record: the open_id recorded before the grant revokes it, also after the bot left the group', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.hang('grant');
    await h.service.launch(runId, OWNER, {});
    await until(() => launch.count('grant') === 1);
    const chat = launch.onlyChat();
    expect(launch.granted(chat.chatId, MAIN)).toEqual([seenBy(MAIN, DOC)]);
    // Resolved by the receiver (the main bot) in its own app, before writing.
    expect(launch.calls.filter((c) => c.op === 'resolveSubject').map((c) => c.args)).toEqual([[chat.chatId, MAIN, DOC]]);
    expect(record(runId).launch!.grants?.[DOC]).toEqual(expect.objectContaining({ mainPending: seenBy(MAIN, DOC) }));
    const next = restart(h);
    chat.members.delete(DOC);
    await next.setNodeBot(runId, OWNER, 'write', { larkAppId: REVIEW });
    expect(launch.granted(chat.chatId, MAIN)).toEqual([]);
    expect(record(runId).launch!.grants).toBeUndefined();
    await reconfirm(next, runId);
    await next.continueLaunch(runId, OWNER);
    expect((await settled(next, runId)).phase).toBe('started');
    expect(launch.granted(chat.chatId, MAIN)).toEqual([seenBy(MAIN, REVIEW)]);
    expect(launch.granted(chat.chatId, DOC)).toEqual([]);
  });

  it('peer side: resolved by the executing bot\'s own daemon before its grant, revoked by that open_id', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    // First side completes; the second hangs after its effect.
    let calls = 0;
    const realGrant = launch.deps.grant;
    launch.deps.grant = async (...args) => {
      calls += 1;
      if (calls === 2) { await realGrant(...args); return new Promise(() => {}); }
      return realGrant(...args);
    };
    await h.service.launch(runId, OWNER, {});
    await until(() => calls === 2);
    const chat = launch.onlyChat();
    expect(launch.calls.filter((c) => c.op === 'resolveSubject').map((c) => c.args[1])).toEqual([MAIN, DOC]);
    expect(record(runId).launch!.grants?.[DOC]).toEqual(expect.objectContaining({ mainSide: seenBy(MAIN, DOC), peerPending: seenBy(DOC, MAIN) }));
    launch.deps.grant = realGrant;
    const next = restart(h);
    chat.members.delete(DOC);
    await next.setNodeBot(runId, OWNER, 'write', { larkAppId: REVIEW });
    expect(launch.granted(chat.chatId, DOC)).toEqual([]);
    expect(launch.granted(chat.chatId, MAIN)).toEqual([]);
  });

  it('a revoke that cannot go through stops with an actionable reason', async () => {
    const { h, launch } = setup();
    const runId = await grantedThenStopped(h, launch);
    launch.failNext('revoke', new Error('receiver daemon offline: cli_doc'));
    launch.failNext('revoke', new Error('receiver daemon offline: cli_doc'));
    await h.service.setNodeBot(runId, OWNER, 'write', { larkAppId: REVIEW });
    await reconfirm(h.service, runId);
    await h.service.continueLaunch(runId, OWNER);
    const stopped = await settled(h.service, runId);
    expect(stopped.launch).toMatchObject({ error: { step: 'grant', code: 'revoke_failed' } });
    expect(stopped.launch!.error!.message).toContain('daemon 都在线后点「继续」');
    // Once it can go through, 「继续」 finishes.
    await h.service.continueLaunch(runId, OWNER);
    expect((await settled(h.service, runId)).phase).toBe('started');
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

describe('人工确认后重发（root_unverified / 摘要未确认）', () => {
  async function stuckAtRoot() {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.hangBefore('postRootCard');
    await h.service.launch(runId, OWNER, {});
    await until(() => launch.count('postRootCard') === 1);
    const next = restart(h);
    h.advance(LAUNCH_UUID_DEDUP_SAFE_MS + 60_000);
    await next.continueLaunch(runId, OWNER);
    expect((await settled(next, runId)).launch).toMatchObject({ error: { code: 'root_unverified' } });
    return { h, launch, next, runId };
  }

  it('only the initiator, only with confirmedAbsent, only at root_unverified: a new uuid, recorded, then the launch goes on', async () => {
    const { launch, next, runId } = await stuckAtRoot();
    const oldUuid = record(runId).launch!.rootPending!.uuid;
    expect(await code(next.resendRoot(runId, ALICE_LIKE, { confirmedAbsent: true }))).toBe('not_initiator');
    expect(await code(next.resendRoot(runId, OWNER, {}))).toBe('bad_request');
    expect(await code(next.resendRoot(runId, OWNER, { confirmedAbsent: 'yes' }))).toBe('bad_request');
    expect(launch.count('postRootCard')).toBe(1);

    await next.resendRoot(runId, OWNER, { confirmedAbsent: true });
    const done = await settled(next, runId);
    expect(done.phase).toBe('started');
    const posts = launch.calls.filter((c) => c.op === 'postRootCard').map((c) => c.args[2]);
    expect(posts).toHaveLength(2);
    expect(posts[1]).not.toBe(oldUuid);
    expect(done.launch!.rootManualResends).toEqual([expect.objectContaining({ byOpenId: OWNER.openId, uuid: posts[1] })]);
    expect(launch.onlyChat().messages.filter((m) => m.kind === 'root')).toHaveLength(1);
    // Not available any more once the root is recorded.
    expect(await code(next.resendRoot(runId, OWNER, { confirmedAbsent: true }))).toBe('state_conflict');
  });

  it('refused at any other stop', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.failNext('postRootCard', new Error('down'));
    await h.service.launch(runId, OWNER, {});
    expect((await settled(h.service, runId)).launch).toMatchObject({ error: { code: 'post_root_failed' } });
    expect(await code(h.service.resendRoot(runId, OWNER, { confirmedAbsent: true }))).toBe('state_conflict');
  });

  it('summary unconfirmed: resent once with a new uuid after the start, recorded; refused when not unconfirmed', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.hangBefore('postSummary');
    await h.service.launch(runId, OWNER, {});
    await until(() => launch.count('postSummary') === 1);
    const next = restart(h);
    h.advance(LAUNCH_UUID_DEDUP_SAFE_MS + 60_000);
    await next.continueLaunch(runId, OWNER);
    const started = await settled(next, runId);
    expect(started.phase).toBe('started');
    expect(started.launch!.migrate).toMatchObject({ summaryUnverified: true });
    expect(launch.onlyChat().messages.filter((m) => m.kind === 'summary')).toHaveLength(0);
    expect(await code(next.resendSummary(runId, OWNER, {}))).toBe('bad_request');
    expect(await code(next.resendSummary(runId, ALICE_LIKE, { confirmedAbsent: true }))).toBe('not_initiator');

    const oldUuid = launch.calls.find((c) => c.op === 'postSummary')!.args[2];
    const view = await next.resendSummary(runId, OWNER, { confirmedAbsent: true });
    expect(view.phase).toBe('started');
    expect(view.launch).toMatchObject({ state: 'started', running: false });
    expect(view.launch!.migrate).toMatchObject({ summaryManualResend: { byOpenId: OWNER.openId } });
    expect(view.launch!.migrate!.summaryUnverified).toBeUndefined();
    const uuids = launch.calls.filter((c) => c.op === 'postSummary').map((c) => c.args[2]);
    expect(uuids[1]).not.toBe(oldUuid);
    expect(launch.onlyChat().messages.filter((m) => m.kind === 'summary')).toHaveLength(1);
    expect(await code(next.resendSummary(runId, OWNER, { confirmedAbsent: true }))).toBe('state_conflict');
  });

  it('a summary that simply failed to post (not unconfirmed) is not offered for manual resend', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.failNext('postSummary', new Error('lark 500'));
    await h.service.launch(runId, OWNER, {});
    const done = await settled(h.service, runId);
    expect(done.launch!.migrate).toMatchObject({ summaryError: expect.any(String) });
    expect(done.launch!.migrate!.summaryUnverified).toBeUndefined();
    expect(await code(h.service.resendSummary(runId, OWNER, { confirmedAbsent: true }))).toBe('state_conflict');
    expect(launch.count('postSummary')).toBe(1);
  });

  it('a summary resend that fails leaves it unconfirmed and the launch as it was', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.hang('postSummary');
    await h.service.launch(runId, OWNER, {});
    await until(() => launch.count('postSummary') === 1);
    const next = restart(h);
    h.advance(LAUNCH_UUID_DEDUP_SAFE_MS + 60_000);
    await next.continueLaunch(runId, OWNER);
    await settled(next, runId);
    launch.failNext('postSummary', new Error('lark 500'));
    expect(await code(next.resendSummary(runId, OWNER, { confirmedAbsent: true }))).toBe('post_failed');
    expect((await next.view(runId)).launch).toMatchObject({ state: 'started', running: false, migrate: { summaryUnverified: true } });
  });
});

const ALICE_LIKE = { openId: 'ou_alice', unionId: 'on_alice', source: 'dashboard-platform' as const };

describe('第二轮：手动重发摘要中途崩溃、删除时改卡后崩溃', () => {
  async function summaryUnverifiedStarted() {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.hangBefore('postSummary');
    await h.service.launch(runId, OWNER, {});
    await until(() => launch.count('postSummary') === 1);
    const next = restart(h);
    h.advance(LAUNCH_UUID_DEDUP_SAFE_MS + 60_000);
    await next.continueLaunch(runId, OWNER);
    expect((await settled(next, runId)).phase).toBe('started');
    return { h, launch, next, runId };
  }

  it('B1: the resend posted, then the daemon died: the launch comes back started; resending again inside the window reuses the uuid (one summary)', async () => {
    const { h, launch, next, runId } = await summaryUnverifiedStarted();
    launch.hang('postSummary');
    void next.resendSummary(runId, OWNER, { confirmedAbsent: true });
    await until(() => launch.count('postSummary') === 2);
    expect(record(runId).launch!.migrate!.summaryPending).toMatchObject({ manual: true });
    const again = restart(h);
    expect((await again.view(runId)).launch).toMatchObject({ state: 'started', running: false });
    expect(record(runId).launch!.error).toBeUndefined();
    await again.resendSummary(runId, OWNER, { confirmedAbsent: true });
    const uuids = launch.calls.filter((c) => c.op === 'postSummary').map((c) => c.args[2]);
    expect(uuids[2]).toBe(uuids[1]);
    expect(launch.onlyChat().messages.filter((m) => m.kind === 'summary')).toHaveLength(1);
    expect(record(runId).launch).toMatchObject({ state: 'started', migrate: { summaryManualResend: { byOpenId: OWNER.openId } } });
  });

  it('B1: a launch left paused after its start is put back to started by 「继续」 without starting again', async () => {
    const { launch, next, runId } = await summaryUnverifiedStarted();
    const draft = record(runId);
    draft.launch!.state = 'paused';
    writeWorkflowDraft(join(base, runId), draft);
    expect((await next.continueLaunch(runId, OWNER)).launch).toMatchObject({ state: 'started' });
    expect(launch.starts).toEqual([runId]);
  });

  it('B3: the root card is noted on the way to a delete without restarting the 30-day clock; a stale launch is abandoned first', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.setOnline([MAIN]);
    await h.service.launch(runId, OWNER, {});
    expect((await settled(h.service, runId)).launch).toMatchObject({ error: { step: 'check' } });
    h.advance(31 * 24 * 3600_000);
    const before = record(runId).updatedAt;
    // The card cannot be updated: not deleted, but abandoned on the way —
    // the card and the record never disagree — and the clock is untouched.
    launch.failNext('updateRootCard', new Error('lark 500'));
    expect(await code(h.service.delete(runId, OWNER))).toBe('root_update_failed');
    expect(record(runId)).toMatchObject({ abandonedAt: expect.any(String), updatedAt: before, launch: { state: 'abandoned' } });
    // The next delete notes the card and dies before removing anything.
    await (h.service as any).noteRootAbandoned(runId);
    expect(record(runId)).toMatchObject({ updatedAt: before, launch: { root: { abandonNoted: true } } });
    const next = restart(h);
    await next.delete(runId, OWNER);
    expect(existsSync(join(base, runId))).toBe(false);
    expect(launch.onlyChat().messages[0]!.updates).toHaveLength(1);
  });
});

describe('第三轮', () => {
  it('M4: a manual summary resend on a started launch left paused puts it back to started', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.hangBefore('postSummary');
    await h.service.launch(runId, OWNER, {});
    await until(() => launch.count('postSummary') === 1);
    const next = restart(h);
    h.advance(LAUNCH_UUID_DEDUP_SAFE_MS + 60_000);
    await next.continueLaunch(runId, OWNER);
    await settled(next, runId);
    const draft = record(runId);
    draft.launch!.state = 'paused';
    writeWorkflowDraft(join(base, runId), draft);
    const view = await next.resendSummary(runId, OWNER, { confirmedAbsent: true });
    expect(view.launch).toMatchObject({ state: 'started', running: false });
  });

  it('M13: a resolved open_id that is not an ou_ id stops the grant step before any grant', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.deps.resolveSubject = async () => 'cli_not_an_open_id';
    await h.service.launch(runId, OWNER, {});
    expect((await settled(h.service, runId)).launch).toMatchObject({ error: { step: 'grant', code: 'grant_failed' } });
    expect(launch.count('grant')).toBe(0);
    expect(record(runId).launch!.grants).toBeUndefined();
  });

  it('P3-3: the receiver answered another open_id than it resolved: both are kept and both revoked, on that receiver only', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    const realGrant = launch.deps.grant;
    let first = true;
    launch.deps.grant = async (chatId, receiver, subject) => {
      const answer = await realGrant(chatId, receiver, subject);
      if (first) { first = false; return { subjectOpenId: 'ou_answered_differently' }; }
      return answer;
    };
    launch.beforeGrantReturn = () => { if (launch.count('grant') === 2) touchDag(runId); };
    await h.service.launch(runId, OWNER, {});
    await settled(h.service, runId);
    launch.beforeGrantReturn = undefined;
    expect(record(runId).launch!.grants?.[DOC]).toMatchObject({ mainSide: 'ou_answered_differently', mainPending: seenBy(MAIN, DOC) });
    const chat = launch.onlyChat();
    await h.service.setNodeBot(runId, OWNER, 'write', { larkAppId: REVIEW });
    const revoked = launch.calls.filter((c) => c.op === 'revoke').map((c) => c.args.slice(1));
    expect(revoked).toEqual(expect.arrayContaining([[MAIN, 'ou_answered_differently'], [MAIN, seenBy(MAIN, DOC)], [DOC, seenBy(DOC, MAIN)]]));
    expect(revoked).toHaveLength(3);
    expect(launch.granted(chat.chatId, MAIN)).toEqual([]);
  });
});

describe('P3-2: self-healing is not activity', () => {
  it('a draft whose only write in 31 days was dropping a dead reservation is deletable; on day 29 it is not', async () => {
    const { h } = setup();
    const created = await h.service.create(OWNER, { goal: 'g' });
    h.clarify.reply('先确认范围。');
    await h.service.view(created.runId);
    const draft = record(created.runId);
    draft.clarify.pending = { triggerId: 'reserve:dead-one', sentAt: draft.updatedAt };
    writeWorkflowDraft(join(base, created.runId), draft);
    const before = record(created.runId).updatedAt;
    h.advance(29 * 24 * 3600_000);
    const next = restart(h);
    await next.view(created.runId);
    expect(record(created.runId).clarify.pending).toBeUndefined();
    expect(record(created.runId).updatedAt).toBe(before);
    expect(await code(next.delete(created.runId, OWNER))).toBe('draft_not_stale');
    h.advance(2 * 24 * 3600_000);
    await next.delete(created.runId, OWNER);
    expect(existsSync(join(base, created.runId))).toBe(false);
  });

  it('day 31, deleted directly (the dead reservation is dropped inside the delete itself): deletable', async () => {
    const { h } = setup();
    const created = await h.service.create(OWNER, { goal: 'g' });
    h.clarify.reply('先确认范围。');
    await h.service.view(created.runId);
    const draft = record(created.runId);
    draft.clarify.pending = { triggerId: 'reserve:dead-one', sentAt: draft.updatedAt };
    writeWorkflowDraft(join(base, created.runId), draft);
    h.advance(31 * 24 * 3600_000);
    const next = restart(h);
    await next.delete(created.runId, OWNER);
    expect(existsSync(join(base, created.runId))).toBe(false);
  });

  it('a reply landing is activity', async () => {
    const { h } = setup();
    const created = await h.service.create(OWNER, { goal: 'g' });
    const before = record(created.runId).updatedAt;
    h.advance(60_000);
    h.clarify.reply('一个问题');
    await h.service.view(created.runId);
    expect(record(created.runId).updatedAt).not.toBe(before);
  });
});

describe('#2811: the join step reads before it writes', () => {
  /** Group built, record lost: 「继续」 recovers it by its marker. */
  async function recovered(prepare: (launch: ReturnType<typeof fakeLaunch>) => void = () => {}) {
    const { h, launch } = setup();
    prepare(launch);
    const runId = await confirmed(h);
    launch.hang('createGroup');
    await h.service.launch(runId, OWNER, {});
    await until(() => launch.chats.size === 1);
    return { h, launch, runId, next: restart(h) };
  }
  const joinOps = (launch: ReturnType<typeof fakeLaunch>) => ['joinOwnerCheck', 'joinMemberCheck', 'joinInvite', 'joinTransfer']
    .map((op) => launch.count(op as any));

  it('recovered, the initiator already owns it: joined with no write at all (a repeated invite would fail)', async () => {
    const { launch, runId, next } = await recovered();
    expect(launch.switches.duplicateInviteFails).toBe(true);
    await next.continueLaunch(runId, OWNER);
    const done = await settled(next, runId);
    expect(done.phase).toBe('started');
    expect(done.launch!.chat).toMatchObject({ recovered: true, initiator: 'joined' });
    expect(joinOps(launch)).toEqual([1, 0, 0, 0]);
  });

  it('recovered, a member but not the owner: no invite, only the transfer', async () => {
    const { launch, runId, next } = await recovered((l) => l.noOwner.add(OWNER.openId));
    launch.noOwner.delete(OWNER.openId);
    await next.continueLaunch(runId, OWNER);
    expect((await settled(next, runId)).phase).toBe('started');
    expect(joinOps(launch)).toEqual([1, 1, 0, 1]);
    expect(launch.onlyChat().owner).toEqual({ channel: 'open_id', id: OWNER.openId });
  });

  it('not a member, the invite says "not added" but the member list shows them: joined', async () => {
    const { h, launch } = setup();
    launch.refusedPeople.add(OWNER.openId);
    const runId = await confirmed(h);
    await h.service.launch(runId, OWNER, {});
    expect((await settled(h.service, runId)).launch).toMatchObject({ error: { code: 'initiator_not_joined' } });
    launch.refusedPeople.delete(OWNER.openId);
    launch.switches.inviteReportsInvalid = true;
    const before = joinOps(launch);
    await h.service.continueLaunch(runId, OWNER);
    expect((await settled(h.service, runId)).phase).toBe('started');
    const after = joinOps(launch);
    expect(after.map((n, i) => n - before[i]!)).toEqual([1, 2, 1, 1]);
  });

  it('really refused: still initiator_not_joined, after checking the member list again', async () => {
    const { h, launch } = setup();
    launch.refusedPeople.add(OWNER.openId);
    const runId = await confirmed(h);
    await h.service.launch(runId, OWNER, {});
    await settled(h.service, runId);
    const before = joinOps(launch);
    await h.service.continueLaunch(runId, OWNER);
    expect((await settled(h.service, runId)).launch).toMatchObject({ error: { step: 'join', code: 'initiator_not_joined' } });
    expect(joinOps(launch).map((n, i) => n - before[i]!)).toEqual([1, 2, 1, 0]);
  });

  it('the member list cannot be read after an invite that says "not added": not joined, the reason says why', async () => {
    const { h, launch } = setup();
    launch.refusedPeople.add(OWNER.openId);
    const runId = await confirmed(h);
    await h.service.launch(runId, OWNER, {});
    await settled(h.service, runId);
    launch.switches.memberCheckFails = true;
    await h.service.continueLaunch(runId, OWNER);
    const stopped = await settled(h.service, runId);
    expect(stopped.launch).toMatchObject({ error: { code: 'initiator_not_joined' } });
    expect(stopped.launch!.error!.message).toContain('membership could not be checked');
  });
});
