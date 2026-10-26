/**
 * Claim card for scheduled tasks without a usable run-as identity.
 *
 * Runs against the real host authority store and scheduler (so the claim is
 * proven to land in the authority record and its projection, and the
 * compare-and-set is the real transaction); only Lark I/O and the access check
 * are scripted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import * as scheduler from '../src/core/scheduler.js';
import * as scheduleStore from '../src/services/schedule-store.js';
import { ScheduleAuthorityStore } from '../src/services/schedule-authority-store.js';
import {
  claimCardLocation,
  createScheduleIdentityClaims,
  resolveScheduledRunIdentity,
  type ScheduleIdentityClaimDeps,
} from '../src/core/schedule-identity-claim.js';
import { trustedCallerForScheduledTask } from '../src/core/scheduled-turn-provenance.js';
import type { ScheduledTask } from '../src/types.js';

const APP = 'cli_claim';
const CHAT = 'oc_chat';
const ALICE = { open: 'ou_alice', union: 'on_alice' };
const BOB = { open: 'ou_bob', union: 'on_bob' };
const CAROL = { open: 'ou_carol', union: 'on_carol' };
const PROMPT = '每天早上汇总昨天的线上告警，用 bytedcli 拉取监控大盘，写进周报文档';

let dataDir: string;
let store: ScheduleAuthorityStore;

beforeEach(() => {
  dataDir = join(mkdtempSync(join(tmpdir(), 'schedule-claim-')), 'data');
  config.session.dataDir = dataDir;
  scheduleStore.setScheduleScope(APP);
  store = ScheduleAuthorityStore.open(dataDir);
  store.initializeApp(APP, []);
  scheduler.setScheduleAuthorityStore(store);
  scheduler.setOwnerFilter(APP, true);
});

afterEach(() => {
  vi.restoreAllMocks();
  scheduler.stopScheduler();
  scheduler.setScheduleAuthorityStore(null);
  store.close();
  rmSync(join(dataDir, '..'), { recursive: true, force: true });
});

class CardGoneError extends Error {}

function addTask(extra: Partial<Parameters<typeof scheduler.addTask>[0]> = {}): ScheduledTask {
  return scheduler.addTask({
    id: 'a1b2c3d4', name: '告警日报', schedule: 'every 30m', prompt: PROMPT,
    workingDir: '/repo', chatId: CHAT, larkAppId: APP, executionPosition: 'top-level', ...extra,
  });
}

function authorityTask(id = 'a1b2c3d4'): ScheduledTask {
  return store.getRecord(APP, id)!.task;
}

function harness(options: { tools?: string[] } = {}) {
  const allowed = new Set([ALICE.open, BOB.open]);
  const sent: Array<{ via: 'chat' | 'thread'; target: string; card: any; messageId: string }> = [];
  const updates: Array<{ messageId: string; card: any }> = [];
  const logs: string[] = [];
  let seq = 0;
  let now = Date.parse('2026-10-26T02:00:00.000Z');
  let updateFailure: Error | undefined;
  const deps: ScheduleIdentityClaimDeps = {
    getAuthority: (appId, taskId) => store.getRecord(appId, taskId),
    getCard: (appId, taskId) => store.getClaimCard(appId, taskId),
    putCard: record => store.putClaimCard(record),
    claimRunAs: (appId, taskId, claim, expected) => scheduler.claimTaskRunAs(taskId, appId, claim, expected),
    runTaskNow: vi.fn((_appId: string, taskId: string) => scheduler.runTaskNow(taskId)),
    canOperate: vi.fn((_appId: string, _chatId: string, openId: string) => allowed.has(openId)),
    // Production passes resolveCardOperatorUnionId; what matters here is that
    // only `operator` is ever consulted.
    resolveOperator: vi.fn(async data => ({
      openId: data.operator?.open_id,
      unionId: typeof data.operator?.union_id === 'string' && data.operator.union_id.startsWith('on_')
        ? data.operator.union_id : undefined,
    })),
    sendCard: vi.fn(async (_appId: string, chatId: string, card: string) => {
      const messageId = `om_card_${++seq}`;
      sent.push({ via: 'chat', target: chatId, card: JSON.parse(card), messageId });
      return messageId;
    }),
    replyCard: vi.fn(async (_appId: string, root: string, card: string) => {
      const messageId = `om_card_${++seq}`;
      sent.push({ via: 'thread', target: root, card: JSON.parse(card), messageId });
      return messageId;
    }),
    updateCard: vi.fn(async (_appId: string, messageId: string, card: string) => {
      if (updateFailure) throw updateFailure;
      updates.push({ messageId, card: JSON.parse(card) });
    }),
    isCardGone: error => error instanceof CardGoneError,
    governedTools: () => options.tools ?? ['bytedcli', 'lark-cli'],
    locale: () => 'zh',
    timeZone: () => 'Asia/Shanghai',
    now: () => new Date(now),
    log: { info: message => logs.push(message), warn: message => logs.push(message) },
  };
  const claims = createScheduleIdentityClaims(deps);
  let turn = 0;
  return {
    deps, claims, sent, updates, logs, allowed,
    tick(ms = 60_000) { now += ms; },
    failUpdates(error?: Error) { updateFailure = error; },
    /** What the daemon does at a fire: decide the identity, report a gap. */
    async fire(taskId = 'a1b2c3d4', turnId = `schedule:${taskId}:0000000${++turn}-0000-4000-8000-000000000000`) {
      const task = authorityTask(taskId);
      const identity = resolveScheduledRunIdentity(task, APP,
        (openId, unionId) => deps.canOperate(APP, CHAT, openId, unionId));
      if (!identity.ok) {
        await claims.noteIdentityGap({
          appId: APP, task, turnId, fireChatId: CHAT, location: { kind: 'chat', chatId: CHAT }, gap: identity,
        });
      }
      return { identity, turnId };
    },
    click(action: string, card: any, who: { open: string; union?: string } | undefined, messageId: string,
      extraValue: Record<string, string> = {}) {
      const value = buttons(card).find(b => b.value.action === action)?.value;
      if (!value) throw new Error(`card has no ${action} button`);
      return claims.handleCardAction({
        ...(who ? { operator: { open_id: who.open, ...(who.union ? { union_id: who.union } : {}) } } : {}),
        action: { value: { ...value, ...extraValue } },
        context: { open_message_id: messageId, open_chat_id: CHAT },
      }, APP);
    },
  };
}

function buttons(card: unknown): Array<{ label: string; value: Record<string, string> }> {
  const found: Array<{ label: string; value: Record<string, string> }> = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    const el = node as Record<string, any>;
    if (el.tag === 'button') {
      found.push({ label: el.text?.content, value: el.behaviors?.[0]?.value });
      return;
    }
    Object.values(el).forEach(walk);
  };
  walk(card);
  return found;
}

const text = (card: unknown) => JSON.stringify(card);

describe('resolveScheduledRunIdentity', () => {
  const base = { id: 't1', chatId: CHAT, larkAppId: APP } as ScheduledTask;
  const access = (...openIds: string[]) => (openId: string) => openIds.includes(openId);
  const claim = { openId: BOB.open, unionId: BOB.union, larkAppId: APP, claimedAt: '2026-10-26T02:00:00.000Z' };

  it('names why there is no identity, and who lost access', () => {
    expect(resolveScheduledRunIdentity(base, APP, access(ALICE.open))).toEqual({ ok: false, reason: 'no_creator' });
    const created = { ...base, ownerOpenId: ALICE.open, ownerUnionId: ALICE.union };
    expect(resolveScheduledRunIdentity(created, APP, access(ALICE.open)))
      .toEqual({ ok: true, openId: ALICE.open, unionId: ALICE.union, source: 'creator' });
    expect(resolveScheduledRunIdentity(created, APP, access()))
      .toEqual({ ok: false, reason: 'creator_revoked', lapsedOpenId: ALICE.open });
    // A creator open_id issued to another app is nobody on this bot.
    expect(resolveScheduledRunIdentity({ ...created, creatorLarkAppId: 'cli_other' }, APP, access(ALICE.open)))
      .toEqual({ ok: false, reason: 'no_creator' });
  });

  it('prefers the claimant over a creator who still has access', () => {
    const task = { ...base, ownerOpenId: ALICE.open, ownerUnionId: ALICE.union, runAsClaim: claim };
    expect(resolveScheduledRunIdentity(task, APP, access(ALICE.open, BOB.open)))
      .toEqual({ ok: true, openId: BOB.open, unionId: BOB.union, source: 'claim' });
    // The claim was the explicit decision: losing the claimant does not
    // silently fall back to the creator.
    expect(resolveScheduledRunIdentity(task, APP, access(ALICE.open)))
      .toEqual({ ok: false, reason: 'claimant_revoked', lapsedOpenId: BOB.open });
    expect(trustedCallerForScheduledTask(task, APP)).toMatchObject({
      requestUserOpenId: BOB.open, requestUserUnionId: BOB.union, requestLarkAppId: APP,
      senderType: 'user', source: 'schedule_creator', taskId: 't1',
    });
  });

  it('ignores a malformed claim', () => {
    const task = { ...base, ownerOpenId: ALICE.open, ownerUnionId: ALICE.union,
      runAsClaim: { ...claim, unionId: 'ou_not_a_union' } };
    expect(resolveScheduledRunIdentity(task, APP, access(ALICE.open, BOB.open)))
      .toMatchObject({ ok: true, openId: ALICE.open, source: 'creator' });
  });
});

describe('claimCardLocation', () => {
  it.each([
    ['topic', { chatId: CHAT, rootMessageId: 'om_topic' }, CHAT, { kind: 'thread', rootMessageId: 'om_topic' }],
    ['new-topic', { chatId: CHAT, rootMessageId: 'om_topic' }, CHAT, { kind: 'chat', chatId: CHAT }],
    ['top-level', { chatId: CHAT }, CHAT, { kind: 'chat', chatId: CHAT }],
    ['topic', { chatId: CHAT, rootMessageId: 'om_topic', followActive: true }, CHAT, { kind: 'chat', chatId: CHAT }],
    ['topic', { chatId: CHAT, rootMessageId: 'om_topic' }, 'oc_second', { kind: 'chat', chatId: 'oc_second' }],
    ['topic', { chatId: CHAT, rootMessageId: 'schedule-task:a1' }, CHAT, { kind: 'chat', chatId: CHAT }],
  ] as const)('%s %o fired in %s → %o', (position, task, fireChatId, expected) => {
    expect(claimCardLocation({ position, task, fireChatId })).toEqual(expected);
  });
});

describe('claimTaskRunAs', () => {
  it('compares against the claim the card was rendered for, inside the authority write', () => {
    addTask();
    const T1 = '2026-10-26T02:00:00.000Z';
    const T2 = '2026-10-26T03:00:00.000Z';
    const claim = (who: typeof ALICE, at: string) => ({ openId: who.open, unionId: who.union, larkAppId: APP, claimedAt: at });
    expect(scheduler.claimTaskRunAs('a1b2c3d4', APP, claim(ALICE, T1), T2)).toEqual({ ok: false, error: 'stale' });
    expect(scheduler.claimTaskRunAs('a1b2c3d4', APP, claim(ALICE, T1), null)).toMatchObject({ ok: true });
    expect(scheduler.claimTaskRunAs('a1b2c3d4', APP, claim(BOB, T2), null))
      .toMatchObject({ ok: false, error: 'stale', current: { openId: ALICE.open } });
    expect(scheduler.claimTaskRunAs('a1b2c3d4', APP, claim(ALICE, T2), T1))
      .toMatchObject({ ok: false, error: 'already_claimant' });
    expect(scheduler.claimTaskRunAs('a1b2c3d4', APP, claim(BOB, T2), T1))
      .toMatchObject({ ok: true, previous: { openId: ALICE.open } });
    expect(scheduler.claimTaskRunAs('missing1', APP, claim(BOB, T2), null)).toEqual({ ok: false, error: 'not_found' });
    expect(authorityTask().runAsClaim).toEqual(claim(BOB, T2));
  });
});

describe('claim card on a fire without identity', () => {
  it('posts one card that says which task, why, and what would run as the claimant', async () => {
    const h = harness();
    addTask();
    await h.fire();
    expect(h.sent).toHaveLength(1);
    const { card, target, via } = h.sent[0]!;
    expect({ via, target }).toEqual({ via: 'chat', target: CHAT });
    const body = text(card);
    expect(body).toContain('告警日报');
    expect(body).toContain('a1b2c3d4');
    expect(body).toContain('没有记录可用的创建人身份');
    expect(body).toContain('bytedcli、lark-cli --as user');
    expect(body).toContain('每天早上汇总昨天的线上告警');
    expect(buttons(card)).toEqual([{
      label: '认领，以我的身份执行',
      value: { action: 'schedule_identity_claim', task_id: 'a1b2c3d4', claim_rev: '' },
    }]);
    expect(store.getClaimCard(APP, 'a1b2c3d4')).toMatchObject({ messageId: 'om_card_1', status: 'pending', reason: 'no_creator' });
  });

  it('refreshes the same card on later fires instead of posting again; a replay of one turn is not a fire', async () => {
    const h = harness();
    addTask();
    await h.fire();
    h.tick();
    const second = await h.fire();
    // Restore / identity-model replay re-publishes the same turn.
    await h.claims.noteIdentityGap({
      appId: APP, task: authorityTask(), turnId: second.turnId, fireChatId: CHAT,
      location: { kind: 'chat', chatId: CHAT }, gap: { ok: false, reason: 'no_creator' },
    });
    h.tick();
    await h.fire();
    expect(h.sent).toHaveLength(1);
    expect(h.updates.map(u => u.messageId)).toEqual(['om_card_1', 'om_card_1']);
    expect(text(h.updates[1]!.card)).toContain('2026/10/26 10:02:00');
  });

  it('replies into the topic a task is bound to', async () => {
    const h = harness();
    const task = addTask({ executionPosition: 'topic', rootMessageId: 'om_topic' });
    await h.claims.noteIdentityGap({
      appId: APP, task, turnId: 'schedule:a1b2c3d4:00000001-0000-4000-8000-000000000000', fireChatId: CHAT,
      location: claimCardLocation({ position: 'topic', task, fireChatId: CHAT }), gap: { ok: false, reason: 'no_creator' },
    });
    expect(h.sent.map(s => [s.via, s.target])).toEqual([['thread', 'om_topic']]);
  });

  it('never posts for a task that has a usable identity, or a bot that governs no tool', async () => {
    const h = harness();
    addTask({ ownerOpenId: ALICE.open, ownerUnionId: ALICE.union });
    expect((await h.fire()).identity.ok).toBe(true);
    const inert = harness({ tools: [] });
    addTask({ id: 'b1b2c3d4' });
    await inert.fire('b1b2c3d4');
    expect([...h.sent, ...inert.sent]).toEqual([]);
  });

  it('posts a fresh card only when the old one can no longer be edited', async () => {
    const h = harness();
    addTask();
    await h.fire();
    h.failUpdates(new Error('rate limited'));
    await h.fire();
    expect(h.sent).toHaveLength(1);
    h.failUpdates(new CardGoneError('past the edit window'));
    await h.fire();
    expect(h.sent.map(s => s.messageId)).toEqual(['om_card_1', 'om_card_2']);
    expect(store.getClaimCard(APP, 'a1b2c3d4')?.messageId).toBe('om_card_2');
  });

  it('keeps one card per task across a daemon restart', async () => {
    const h = harness();
    addTask();
    await h.fire();
    store.close();
    store = ScheduleAuthorityStore.open(dataDir);
    scheduler.setScheduleAuthorityStore(store);
    const restarted = harness();
    await restarted.fire('a1b2c3d4', 'schedule:a1b2c3d4:99999999-0000-4000-8000-000000000000');
    expect(restarted.sent).toEqual([]);
    expect(restarted.updates.map(u => u.messageId)).toEqual(['om_card_1']);
  });
});

describe('claim card buttons', () => {
  async function pending(h: ReturnType<typeof harness>, extra = {}) {
    addTask(extra);
    await h.fire();
    return h.sent.at(-1)!;
  }

  it('records the clicking operator as the run-as identity, never identity fields in the button value', async () => {
    const h = harness();
    const card = await pending(h);
    const result = await h.click('schedule_identity_claim', card.card, ALICE, card.messageId,
      { open_id: 'ou_mallory', union_id: 'on_mallory' });

    const claim = authorityTask().runAsClaim;
    expect(claim).toEqual({ openId: ALICE.open, unionId: ALICE.union, larkAppId: APP, claimedAt: '2026-10-26T02:00:00.000Z' });
    // The JSON projection carries it too, so every reader sees one identity.
    const projected = JSON.parse(readFileSync(join(dataDir, '..', 'bots', APP, 'schedules.json'), 'utf8'));
    expect(projected.a1b2c3d4.runAsClaim).toEqual(claim);
    expect(trustedCallerForScheduledTask(authorityTask(), APP)).toMatchObject({
      requestUserOpenId: ALICE.open, requestUserUnionId: ALICE.union, requestLarkAppId: APP,
    });
    // Later fires run as the claimant and leave the card alone.
    expect((await h.fire()).identity).toMatchObject({ ok: true, openId: ALICE.open, source: 'claim' });
    expect(h.updates).toEqual([]);

    expect(result.toast).toMatchObject({ type: 'success' });
    const claimed = result.card.data;
    expect(text(claimed)).toContain(`<at id=${ALICE.open}></at>`);
    expect(text(claimed)).toContain('每天早上汇总昨天的线上告警');
    expect(buttons(claimed).map(b => [b.label, b.value.action, b.value.claim_rev])).toEqual([
      ['改为我认领', 'schedule_identity_reclaim', '2026-10-26T02:00:00.000Z'],
      ['重新执行', 'schedule_identity_rerun', '2026-10-26T02:00:00.000Z'],
    ]);
    expect(store.getClaimCard(APP, 'a1b2c3d4')?.status).toBe('claimed');
    expect(h.logs.find(l => l.includes('outcome=claimed'))).toMatch(
      /action=schedule_identity_claim outcome=claimed task=a1b2c3d4 chat=oc_chat operator_union=on_alice operator_open=ou_alice previous_union=none at=2026-10-26T02:00:00.000Z/,
    );
  });

  it('refuses someone who cannot operate the bot, privately and without any change', async () => {
    const h = harness();
    const card = await pending(h);
    const result = await h.click('schedule_identity_claim', card.card, CAROL, card.messageId);
    expect(result).toEqual({ toast: { type: 'error', content: expect.stringContaining('没有操作本 Bot 的权限') } });
    expect(authorityTask().runAsClaim).toBeUndefined();
    expect(store.getClaimCard(APP, 'a1b2c3d4')?.status).toBe('pending');
    expect(h.logs.some(l => l.includes('outcome=denied') && l.includes('operator_union=on_carol'))).toBe(true);
  });

  it('refuses a click whose operator union_id Lark did not verify', async () => {
    const h = harness();
    const card = await pending(h);
    const result = await h.click('schedule_identity_claim', card.card, { open: ALICE.open }, card.messageId,
      { union_id: ALICE.union });
    expect(result.toast).toMatchObject({ type: 'error' });
    expect(authorityTask().runAsClaim).toBeUndefined();
  });

  it('lets another operator take over the claim, and tells the claimant they already hold it', async () => {
    const h = harness();
    const card = await pending(h);
    const claimed = (await h.click('schedule_identity_claim', card.card, ALICE, card.messageId)).card.data;
    h.tick();
    const mine = await h.click('schedule_identity_reclaim', claimed, ALICE, card.messageId);
    expect(mine.toast.content).toContain('你已经是这个任务的认领人');
    const taken = await h.click('schedule_identity_reclaim', claimed, BOB, card.messageId);
    expect(taken.toast).toMatchObject({ type: 'success' });
    expect(authorityTask().runAsClaim).toMatchObject({ openId: BOB.open, unionId: BOB.union });
    expect(h.logs.some(l => l.includes('outcome=claimed') && l.includes('operator_union=on_bob')
      && l.includes('previous_union=on_alice'))).toBe(true);
    expect(text(taken.card.data)).toContain(`<at id=${BOB.open}></at>`);
  });

  it('a click on an out-of-date card refreshes it instead of overwriting the newer claim', async () => {
    const h = harness();
    const card = await pending(h);
    const aliceCard = (await h.click('schedule_identity_claim', card.card, ALICE, card.messageId)).card.data;
    h.tick();
    await h.click('schedule_identity_reclaim', aliceCard, BOB, card.messageId);
    // Alice's stale copy still shows her own claim; acting on it must not win.
    h.allowed.add(CAROL.open);
    const stale = await h.click('schedule_identity_reclaim', aliceCard, CAROL, card.messageId);
    expect(stale.toast.content).toContain('已刷新');
    expect(authorityTask().runAsClaim).toMatchObject({ openId: BOB.open });
    expect(text(stale.card.data)).toContain(`<at id=${BOB.open}></at>`);
    // Same for a second click on the original unclaimed card.
    const late = await h.click('schedule_identity_claim', card.card, CAROL, card.messageId);
    expect(late.toast.content).toContain('已刷新');
    expect(authorityTask().runAsClaim).toMatchObject({ openId: BOB.open });
  });

  it('of two simultaneous claims only the first lands', async () => {
    const h = harness();
    const card = await pending(h);
    const [a, b] = await Promise.all([
      h.click('schedule_identity_claim', card.card, ALICE, card.messageId),
      h.click('schedule_identity_claim', card.card, BOB, card.messageId),
    ]);
    expect(a.toast.type).toBe('success');
    expect(b.toast.content).toContain('已刷新');
    expect(authorityTask().runAsClaim).toMatchObject({ openId: ALICE.open });
  });

  it('runs the task again for an operator, and refuses others and paused tasks', async () => {
    const h = harness();
    const card = await pending(h);
    const claimed = (await h.click('schedule_identity_claim', card.card, ALICE, card.messageId)).card.data;
    const before = authorityTask().nextRunAt;

    const denied = await h.click('schedule_identity_rerun', claimed, CAROL, card.messageId);
    expect(denied.toast.type).toBe('error');
    expect(h.deps.runTaskNow).not.toHaveBeenCalled();

    h.tick();
    const queued = await h.click('schedule_identity_rerun', claimed, BOB, card.messageId);
    expect(queued).toEqual({ toast: { type: 'success', content: expect.stringContaining('立即执行') } });
    expect(h.deps.runTaskNow).toHaveBeenCalledWith(APP, 'a1b2c3d4');
    expect(Date.parse(authorityTask().nextRunAt!)).toBeLessThan(Date.parse(before!));
    expect(h.logs.some(l => l.includes('action=schedule_identity_rerun outcome=queued')
      && l.includes('operator_union=on_bob') && l.includes('run_as_union=on_alice'))).toBe(true);

    scheduler.disableTask('a1b2c3d4');
    const paused = await h.click('schedule_identity_rerun', claimed, BOB, card.messageId);
    expect(paused.toast.content).toContain('任务已暂停');
    expect(h.deps.runTaskNow).toHaveBeenCalledTimes(1);
  });

  it('a stale card cannot start a run either', async () => {
    const h = harness();
    const card = await pending(h);
    const aliceCard = (await h.click('schedule_identity_claim', card.card, ALICE, card.messageId)).card.data;
    h.tick();
    await h.click('schedule_identity_reclaim', aliceCard, BOB, card.messageId);
    const stale = await h.click('schedule_identity_rerun', aliceCard, ALICE, card.messageId);
    expect(stale.toast.content).toContain('已刷新');
    expect(h.deps.runTaskNow).not.toHaveBeenCalled();
  });

  it('a claimant who loses access gets a new card that can hand the task to someone else', async () => {
    const h = harness();
    const card = await pending(h);
    await h.click('schedule_identity_claim', card.card, ALICE, card.messageId);
    h.allowed.delete(ALICE.open);
    h.tick();
    await h.fire();
    expect(h.sent).toHaveLength(2);
    const lapsed = h.sent[1]!;
    expect(text(lapsed.card)).toContain(`认领人 <at id=${ALICE.open}></at> 已无权操作本 Bot`);
    const result = await h.click('schedule_identity_claim', lapsed.card, BOB, lapsed.messageId);
    expect(result.toast.type).toBe('success');
    expect(authorityTask().runAsClaim).toMatchObject({ openId: BOB.open });
  });

  it('does not hand over a task whose creator has meanwhile regained access', async () => {
    const h = harness();
    h.allowed.delete(ALICE.open);
    const card = await pending(h, { ownerOpenId: ALICE.open, ownerUnionId: ALICE.union });
    expect(text(card.card)).toContain(`创建人 <at id=${ALICE.open}></at> 已无权操作本 Bot`);
    h.allowed.add(ALICE.open);
    const result = await h.click('schedule_identity_claim', card.card, BOB, card.messageId);
    expect(result.toast.content).toContain('已刷新');
    expect(authorityTask().runAsClaim).toBeUndefined();
  });

  it('patches the task’s current card too when an older copy is clicked', async () => {
    const h = harness();
    const card = await pending(h);
    h.failUpdates(new CardGoneError('expired'));
    await h.fire();
    h.failUpdates();
    const result = await h.click('schedule_identity_claim', card.card, ALICE, card.messageId);
    expect(typeof result.afterAck).toBe('function');
    await result.afterAck();
    expect(h.updates.map(u => u.messageId)).toEqual(['om_card_2']);
    expect(text(h.updates[0]!.card)).toContain(`<at id=${ALICE.open}></at>`);
  });

  it('answers privately when the authority store cannot be read', async () => {
    const h = harness();
    const card = await pending(h);
    h.deps.getAuthority = () => { throw new Error('schedule_authority_store_unavailable'); };
    const result = await h.click('schedule_identity_claim', card.card, ALICE, card.messageId);
    expect(result).toEqual({ toast: { type: 'error', content: expect.stringContaining('schedule_authority_store_unavailable') } });
  });

  it('answers clicks for a removed task without touching anything', async () => {
    const h = harness();
    const card = await pending(h);
    scheduler.removeTask('a1b2c3d4');
    const result = await h.click('schedule_identity_claim', card.card, ALICE, card.messageId);
    expect(result.toast.content).toContain('任务已被删除');
    expect(buttons(result.card.data)).toEqual([]);
  });
});
