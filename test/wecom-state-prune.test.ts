/**
 * Pruning of the WeCom bridge state document, through the real bridge with an
 * in-process core and transport and a fake clock: what is dropped, what every
 * session keeps, what is never touched while in flight, and how often.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomBridge, type WecomBridgePolicy, type WecomCore } from '../src/im/wecom/gateway/bridge.js';
import {
  WECOM_DEDUPE_RETENTION_MS,
  WECOM_PRUNE_INTERVAL_MS,
  WECOM_TASK_RETENTION_MS,
} from '../src/im/wecom/gateway/bridge/prune.js';
import type { NativeGatewayAskSnapshot } from '../src/core/native-gateway-contract.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import type { WecomInboundMessage, WecomTemplateCard } from '../src/im/wecom/protocol/types.js';
import { blockWecomStateWrites } from './helpers/wecom-state-writes.js';

const T0 = Date.parse('2026-01-05T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The task key (and `seen` key) of a message id. */
const keyOf = (messageId: string) => createHash('sha256').update(JSON.stringify(['bot', messageId])).digest('hex');

/** A delivered private-chat task as an earlier version stored it: no creation time, no session. */
const legacyTask = (id: string) => ({
  message: message(id),
  route: JSON.stringify(['single', 'alice', 'alice']),
  streamId: keyOf(id),
  request: {
    source: { type: 'webhook', connectorId: 'wecom:bot', requestId: id },
    target: { kind: 'turn' },
    envelope: { format: 'text', sourceName: 'x', trusted: false, rawText: 'task' },
  },
  result: 'old answer',
  delivered: true,
});

function message(id: string, options: { text?: string; user?: string; group?: string } = {}): WecomInboundMessage {
  const user = options.user ?? 'alice';
  return {
    messageId: id,
    userId: user,
    conversationId: options.group ?? user,
    chatType: options.group ? 'group' : 'single',
    text: options.text ?? 'task',
    attachments: [],
    replyContext: { requestId: id },
  };
}

function harness(options: { policy?: Partial<WecomBridgePolicy>; state?: unknown; asks?: boolean } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  const root = mkdtempSync(join(tmpdir(), 'wecom-prune-'));
  roots.push(root);
  const stateFile = join(root, 'state.json');
  if (options.state) writeFileSync(stateFile, JSON.stringify(options.state));
  let policy: WecomBridgePolicy = { allowedUsers: ['alice', 'bob'], ...options.policy };
  let policyFails = false;
  let triggerFails = false;
  /** Message ids whose turn is still running. */
  const running = new Set<string>();
  let sessions = 0;
  const turnOf = (triggerId: string) => triggerId.replace(/^turn-/, '');
  const cards: Array<{ to: string; card: WecomTemplateCard }> = [];
  const replies: Array<{ to: string; text: string; finish?: boolean }> = [];
  const transport = {
    reply: vi.fn(async (m: WecomInboundMessage, text: string, o?: { finish?: boolean }) => {
      replies.push({ to: m.conversationId, text, finish: o?.finish });
    }),
    send: vi.fn(async () => {}),
    sendCard: vi.fn(async (to: string, card: WecomTemplateCard) => { cards.push({ to, card }); }),
    updateCard: vi.fn(async () => {}),
  };
  const askOf = (sessionId: string, triggerId: string) => ({
    ask: {
      askId: `ask-${turnOf(triggerId)}`,
      nonce: 'nonce',
      larkAppId: 'bot',
      chatId: 'chat',
      rootMessageId: null,
      sessionId,
      questions: [{ prompt: 'Continue?', multiSelect: false, options: [{ key: 'yes', label: 'Yes' }] }],
      createdAt: T0,
      deadlineAt: 0,
      settled: false,
    },
    origin: { sessionId, turnId: triggerId, workerGeneration: 1 },
  }) as unknown as NativeGatewayAskSnapshot;
  const core: WecomCore = {
    trigger: vi.fn(async (request: TriggerRequest) => {
      if (triggerFails) throw new Error('core unavailable');
      const sessionId = request.target.sessionId ?? `s${++sessions}`;
      return { ok: true, triggerId: `turn-${request.source.requestId}`, target: { kind: 'turn' as const, sessionId } };
    }),
    result: vi.fn(async (_sessionId: string, triggerId: string) => (running.has(turnOf(triggerId))
      ? { ok: true, state: 'running' as const }
      : { ok: true, state: 'completed' as const, output: { content: `answer to ${turnOf(triggerId)}` } })),
    interrupt: vi.fn(async () => {}),
    slash: vi.fn(async () => {}),
    ...(options.asks ? {
      asks: vi.fn(async (sessionId: string, triggerId: string) => running.has(turnOf(triggerId)) ? [askOf(sessionId, triggerId)] : []),
      answerAsk: vi.fn(async () => ({ outcome: 'delivered' })),
    } : {}),
  };
  const create = () => new WecomBridge({
    botId: 'bot',
    allowedUsers: policy.allowedUsers,
    policy: () => {
      if (policyFails) throw new Error('configuration unreadable');
      return policy;
    },
    stateFile,
    transport,
    core,
    peerRoot: root,
    log: () => {},
  });
  let bridge = create();
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  return {
    stateFile, core, transport, cards, replies, running,
    get bridge() { return bridge; },
    restart: () => { bridge = create(); return bridge; },
    state,
    /** Message ids of the tasks in the state file, in their stored order. */
    taskIds: (): string[] => Object.values(state().tasks).map((task: any) => task.message.messageId),
    at: (ms: number) => vi.setSystemTime(T0 + ms),
    /** One message, then one tick. */
    turn: async (id: string, options: { text?: string; user?: string; group?: string } = {}) => {
      await bridge.receive(message(id, options));
      await bridge.tick();
    },
    failPolicy: (fails: boolean) => { policyFails = fails; },
    failTrigger: (fails: boolean) => { triggerFails = fails; },
    setPolicy: (patch: Partial<WecomBridgePolicy>) => { policy = { ...policy, ...patch }; },
  };
}

describe('pruning delivered tasks', () => {
  // Case 1.
  it('drops delivered tasks past the retention period, keeps younger ones and the order of the rest', async () => {
    const h = harness();
    h.running.add('b1');
    await h.turn('b1', { user: 'bob' });
    h.at(DAY);
    await h.turn('a1');
    // b1 ran for 20 days: its retention counts from its completion.
    h.at(20 * DAY);
    h.running.delete('b1');
    await h.bridge.tick();
    h.at(21 * DAY);
    await h.turn('b2', { user: 'bob' });
    h.at(25 * DAY);
    await h.turn('a2');
    expect(h.taskIds()).toEqual(['b1', 'a1', 'b2', 'a2']);

    h.at(DAY + WECOM_TASK_RETENTION_MS + 1);
    await h.bridge.tick();
    expect(h.taskIds()).toEqual(['b1', 'b2', 'a2']);

    h.at(20 * DAY + WECOM_TASK_RETENTION_MS + 1);
    await h.bridge.tick();
    expect(h.taskIds()).toEqual(['b2', 'a2']);
  });

  // Case 2. Mutation P1: dropping the latest-task anchor turns this red.
  it('keeps every session\'s latest task and latest task with a turn, so the session stays controllable', async () => {
    const h = harness();
    await h.turn('a1');
    await h.turn('a2');
    // Stopped before it was dispatched: the session's latest task, without a turn of its own.
    await h.bridge.receive(message('a3'));
    await h.bridge.receive(message('stop-a3', { text: '/stop' }));
    await h.bridge.tick();
    const a3 = h.state().tasks[keyOf('a3')];
    expect(a3).toMatchObject({ delivered: true, request: { target: { sessionId: 's1' } } });
    expect(a3.triggerId).toBeUndefined();

    h.at(WECOM_TASK_RETENTION_MS + 10 * DAY);
    await h.bridge.tick();
    expect(h.taskIds()).toEqual(['a2', 'a3']);

    const action = vi.fn(async () => ({ ok: true }));
    await expect(h.bridge.controlSession(
      { sessionId: 's1', operation: 'restart', requestId: 'after-prune', expectedGeneration: 'turn-a2' },
      action,
    )).resolves.toEqual({ ok: true, status: 'completed' });
    expect(action).toHaveBeenCalledTimes(1);
  });

  // Case 3. Mutation P2: pruning without looking at `delivered` turns this red.
  it('never drops an undelivered task, however old; it is still dispatched and delivered later', async () => {
    const h = harness();
    h.failTrigger(true);
    await h.turn('a1');
    h.at(WECOM_TASK_RETENTION_MS + 10 * DAY);
    await h.bridge.tick();
    expect(h.taskIds()).toEqual(['a1']);

    h.failTrigger(false);
    await h.bridge.tick();
    expect(h.state().tasks[keyOf('a1')].delivered).toBe(true);
    expect(h.replies).toContainEqual(expect.objectContaining({ to: 'alice', text: expect.stringContaining('answer to a1'), finish: true }));
  });

  // Case 4. Mutation P6: keeping the receipt of a dropped task turns this red.
  it('drops the quota receipt of a dropped task with it and leaves the grants as they are', async () => {
    const h = harness({ policy: { allowedUsers: ['alice'] } });
    await h.bridge.receive(message('grant', { text: '/grant bob talk', group: 'room' }));
    await h.turn('b1', { user: 'bob', group: 'room' });
    await h.turn('b2', { user: 'bob', group: 'room' });
    const before = h.state().native;
    expect(Object.keys(before.receipts)).toEqual([keyOf('b1'), keyOf('b2')]);

    h.at(WECOM_TASK_RETENTION_MS + DAY);
    await h.bridge.tick();
    const after = h.state().native;
    expect(h.taskIds()).toEqual(['b2']);
    expect(Object.keys(after.receipts)).toEqual([keyOf('b2')]);
    expect(after.grants).toEqual(before.grants);
  });

  // Case 5. Mutation P3: a retention that ignores the /summary window turns this red.
  it('keeps tasks inside a /summary window longer than the retention period', async () => {
    const sinceHours = (WECOM_TASK_RETENTION_MS + 30 * DAY) / 3_600_000;
    const h = harness({ policy: { summaryRange: { sinceHours } } });
    await h.turn('a1');
    await h.turn('a2');
    h.at(WECOM_TASK_RETENTION_MS + 10 * DAY);
    await h.bridge.tick();
    expect(h.taskIds()).toEqual(['a1', 'a2']);

    h.at(sinceHours * 3_600_000 + DAY);
    await h.bridge.tick();
    expect(h.taskIds()).toEqual(['a2']);
  });

  // Case 6. Mutation P4: dropping tasks when the policy cannot be read turns this red.
  it('drops no task while the policy cannot be read, but prunes the rest as usual', async () => {
    const h = harness();
    await h.turn('a1');
    await h.turn('a2');
    h.at(WECOM_TASK_RETENTION_MS + 10 * DAY);
    h.failPolicy(true);
    await h.bridge.tick();
    expect(h.taskIds()).toEqual(['a1', 'a2']);
    // The handled-message records are pruned all the same.
    expect(h.state().seen).toEqual({});

    h.failPolicy(false);
    h.at(WECOM_TASK_RETENTION_MS + 10 * DAY + WECOM_PRUNE_INTERVAL_MS);
    await h.bridge.tick();
    expect(h.taskIds()).toEqual(['a2']);
  });

  // Mutation M11: pruning a task that has no creation time turns this red.
  it('never drops, nor stamps, a delivered task of an earlier version that has no creation time', async () => {
    const h = harness({ state: { version: 1, botId: 'bot', routes: {}, seen: {}, tasks: { [keyOf('legacy')]: legacyTask('legacy') } } });
    // A later task in a session of its own: the earlier version's task is no session's latest.
    await h.turn('a1');
    h.at(10 * WECOM_TASK_RETENTION_MS);
    await h.bridge.tick();
    expect(h.taskIds()).toEqual(['legacy', 'a1']);
    expect(h.state().tasks[keyOf('legacy')]).not.toHaveProperty('createdAt');
  });
});

describe('pruning de-duplication records', () => {
  // Case 7.
  it('keeps an old command from replaying within the retention period and forgets it after', async () => {
    const h = harness();
    await h.turn('a1');
    await h.turn('restart', { text: '/restart' });
    await h.turn('a2');
    const route = JSON.stringify(['single', 'alice', 'alice']);
    expect(h.state().routes[route]).toBe('s2');

    h.at(WECOM_DEDUPE_RETENTION_MS - DAY);
    await h.bridge.tick();
    // The platform delivers the old /restart again: nothing happens.
    await h.turn('restart', { text: '/restart' });
    expect(h.state().routes[route]).toBe('s2');
    await h.turn('a3');
    expect(vi.mocked(h.core.trigger).mock.calls.at(-1)?.[0].target.sessionId).toBe('s2');
    expect(h.state().seen).toHaveProperty(keyOf('restart'));

    h.at(WECOM_DEDUPE_RETENTION_MS + DAY);
    await h.bridge.tick();
    expect(h.state().seen).not.toHaveProperty(keyOf('restart'));
  });

  // Case 8. Mutation P5: dropping `true` records on the first prune turns this red.
  it('keeps a handled-message record of an earlier version for a full period from the first prune', async () => {
    const legacy = keyOf('legacy');
    const h = harness({ state: { version: 1, botId: 'bot', routes: {}, seen: { [legacy]: true }, tasks: {} } });
    await h.bridge.tick();
    expect(h.state().seen).toHaveProperty(legacy);
    // Still a duplicate.
    await h.turn('legacy');
    expect(h.core.trigger).not.toHaveBeenCalled();
    expect(h.taskIds()).toEqual([]);

    h.at(WECOM_DEDUPE_RETENTION_MS + WECOM_PRUNE_INTERVAL_MS);
    await h.bridge.tick();
    expect(h.state().seen).not.toHaveProperty(legacy);
  });

  // Case 9. Mutation P7: dropping a pending control turns this red.
  it('answers a replayed control from its record within the period, forgets it after, and never drops a pending one', async () => {
    const h = harness();
    await h.turn('a1');
    const action = vi.fn(async () => ({ ok: true }));
    const suspend = { sessionId: 's1', operation: 'suspend' as const, requestId: 'c1' };
    await expect(h.bridge.controlSession(suspend, action)).resolves.toEqual({ ok: true, status: 'completed' });

    h.at(DAY);
    await h.bridge.tick();
    await expect(h.bridge.controlSession(suspend, action)).resolves.toEqual({ ok: true, status: 'completed' });
    expect(action).toHaveBeenCalledTimes(1);

    h.at(WECOM_DEDUPE_RETENTION_MS + DAY);
    await h.bridge.tick();
    expect(h.state().controls).not.toHaveProperty('c1');

    // A control committed while a tick holds the lane stays pending until the
    // tick ends; that tick's prune runs a full period later.
    const ticking = h.bridge.tick();
    const resume = h.bridge.controlSession({ sessionId: 's1', operation: 'resume', requestId: 'p1' }, action);
    h.at(2 * WECOM_DEDUPE_RETENTION_MS + 2 * DAY);
    await ticking;
    await expect(resume).resolves.toEqual({ ok: true, status: 'completed' });
    expect(h.state().controls.p1).toMatchObject({ status: 'completed', operation: 'resume' });
  });

  // Case 10. Mutation P8: dropping the ask of a running task turns this red.
  it('keeps the ask of a running task (no second card) and drops it once its task ended a period ago', async () => {
    const h = harness({ asks: true });
    h.running.add('a1');
    await h.turn('a1');
    expect(h.cards).toHaveLength(1);
    expect(Object.keys(h.state().nativeAsks)).toHaveLength(1);

    h.at(WECOM_DEDUPE_RETENTION_MS + DAY);
    await h.bridge.tick();
    h.at(WECOM_DEDUPE_RETENTION_MS + DAY + 60_000);
    await h.bridge.tick();
    expect(h.cards).toHaveLength(1);
    expect(Object.keys(h.state().nativeAsks)).toHaveLength(1);

    h.running.delete('a1');
    await h.bridge.tick();
    expect(h.state().tasks[keyOf('a1')].delivered).toBe(true);
    expect(Object.keys(h.state().nativeAsks)).toHaveLength(1);

    h.at(2 * WECOM_DEDUPE_RETENTION_MS + 2 * DAY);
    await h.bridge.tick();
    expect(h.state().nativeAsks).toEqual({});
  });

  // Case 11.
  it('drops settled feedback webhook rows after the period and never a pending one', async () => {
    const row = (status: string, nextAttemptAt: number) => ({
      event: { eventId: `wecom_${status}`, type: 'turn.completed', version: 1, time: new Date(T0).toISOString(), data: {} },
      destination: { id: 'd1', url: 'https://example.invalid/hook', secretRef: 'feedback-webhook:none', timeoutMs: 1000 },
      attempts: 1,
      nextAttemptAt,
      status,
    });
    const h = harness({
      state: {
        version: 1, botId: 'bot', routes: {}, seen: {}, tasks: {},
        nativeFeedbackOutbox: {
          delivered: row('delivered', T0),
          failed: row('failed', T0),
          // Due only after the prune below: nothing is sent.
          pending: row('pending', T0 + WECOM_DEDUPE_RETENTION_MS + 2 * DAY),
        },
      },
    });
    h.at(WECOM_DEDUPE_RETENTION_MS + DAY);
    await h.bridge.tick();
    expect(Object.keys(h.state().nativeFeedbackOutbox)).toEqual(['pending']);
  });
});

describe('pruning records of earlier versions and of settled actions', () => {
  // Mutation M10: dropping a control record without a time on the first prune turns this red.
  it('keeps control records of an earlier version a full period from the first prune, and a crashed one leaves its session locked', async () => {
    const task = (id: string, user: string, sessionId: string) => ({
      ...legacyTask(id),
      message: message(id, { user }),
      route: JSON.stringify(['single', user, user]),
      sessionId,
      triggerId: `turn-${id}`,
      createdAt: T0,
    });
    const h = harness({
      state: {
        version: 1, botId: 'bot', seen: {},
        routes: { [JSON.stringify(['single', 'alice', 'alice'])]: 's1', [JSON.stringify(['single', 'bob', 'bob'])]: 's2' },
        tasks: { [keyOf('a1')]: task('a1', 'alice', 's1'), [keyOf('b1')]: task('b1', 'bob', 's2') },
        sessionLocks: { s1: 'suspended', s2: 'pending' },
        controls: {
          old: { sessionId: 's1', operation: 'suspend', status: 'completed' },
          crashed: { sessionId: 's2', operation: 'restart', status: 'pending' },
        },
      },
    });
    const action = vi.fn(async () => ({ ok: true }));
    await h.bridge.tick();
    expect(h.state().controls).toMatchObject({ old: { status: 'completed', at: T0 }, crashed: { status: 'uncertain', at: T0 } });
    await expect(h.bridge.controlSession({ sessionId: 's1', operation: 'suspend', requestId: 'old' }, action))
      .resolves.toEqual({ ok: true, status: 'completed' });

    h.at(WECOM_DEDUPE_RETENTION_MS - DAY);
    await h.bridge.tick();
    await expect(h.bridge.controlSession({ sessionId: 's1', operation: 'suspend', requestId: 'old' }, action))
      .resolves.toEqual({ ok: true, status: 'completed' });
    await expect(h.bridge.controlSession({ sessionId: 's2', operation: 'restart', requestId: 'crashed' }, action))
      .resolves.toEqual({ ok: false, status: 'uncertain' });
    expect(action).not.toHaveBeenCalled();

    h.at(WECOM_DEDUPE_RETENTION_MS + WECOM_PRUNE_INTERVAL_MS);
    await h.bridge.tick();
    expect(h.state().controls).toEqual({});
    expect(h.state().sessionLocks).toEqual({ s1: 'suspended', s2: 'uncertain' });
  });

  // Mutation M3: dropping a compact record while its task is kept turns this red.
  it('keeps the compact record of a kept task, so a second click does not compact again, and drops it with its task', async () => {
    const h = harness({
      policy: { replyCardActions: true },
      state: { version: 1, botId: 'bot', routes: {}, seen: {}, tasks: {}, native: { actions: { 'other-shape': 'completed' } } },
    });
    await h.turn('a1');
    const card = `${keyOf('a1')}-controls`;
    expect(h.cards.map(sent => sent.card.task_id)).toContain(card);
    const click = (id: string) => h.bridge.receiveCardEvent({
      messageId: id, botId: 'bot', userId: 'alice', conversationId: 'alice', chatType: 'single',
      requestId: id, taskId: card, eventKey: 'action:compact', receivedAt: Date.now(),
    });
    await click('click-1');
    expect(h.core.slash).toHaveBeenCalledExactlyOnceWith('s1', '/compact');

    h.at(WECOM_PRUNE_INTERVAL_MS);
    await h.bridge.tick();
    expect(h.state().native.actions).toEqual({ 'other-shape': 'completed', [`compact:${card}`]: 'completed' });
    await click('click-2');
    expect(h.core.slash).toHaveBeenCalledTimes(1);

    // A later task in the session: a1 is no longer its latest and goes once old enough.
    await h.turn('a2');
    h.at(WECOM_TASK_RETENTION_MS + DAY);
    await h.bridge.tick();
    expect(h.taskIds()).toEqual(['a2']);
    expect(h.state().native.actions).toEqual({ 'other-shape': 'completed' });
  });

  // Mutation M4: dropping a grant request as soon as it expires turns this red.
  it('keeps an expired grant request for a full period after it expired, and one without an expiry for good', async () => {
    const legacy = { id: 'legacy', userId: 'zed', scope: 'single:zed', status: 'pending', revision: 'r' };
    const h = harness({
      policy: { allowedUsers: ['alice'], autoGrantRequestCards: true },
      state: { version: 1, botId: 'bot', routes: {}, seen: {}, tasks: {}, native: { requests: { legacy } } },
    });
    await h.turn('hello', { user: 'mallory' });
    const request = Object.values(h.state().native.requests as Record<string, { id: string; userId: string; expiresAt: number }>)
      .find(item => item.userId === 'mallory')!;
    expect(request.expiresAt).toBeGreaterThan(T0);

    vi.setSystemTime(request.expiresAt + DAY);
    await h.bridge.tick();
    expect(Object.keys(h.state().native.requests).sort()).toEqual([request.id, 'legacy'].sort());

    vi.setSystemTime(request.expiresAt + WECOM_DEDUPE_RETENTION_MS);
    await h.bridge.tick();
    expect(h.state().native.requests).toEqual({ legacy });
  });

  // Mutation M5: keeping the ask of a task that is gone turns this red.
  it('drops the ask of a task that was itself dropped, and keeps a row it cannot attribute', async () => {
    const malformed = {
      snapshot: { ask: { askId: 'no-origin', nonce: 'n', questions: [] } },
      conversationId: 'zed', recipient: 'zed', requester: 'zed', chatType: 'single', status: 'sent', eventIds: {},
    };
    const h = harness({
      asks: true,
      state: { version: 1, botId: 'bot', routes: {}, seen: {}, tasks: {}, nativeAsks: { malformed } },
    });
    h.running.add('a1');
    await h.turn('a1');
    h.running.delete('a1');
    await h.bridge.tick();
    await h.turn('a2');
    expect(Object.keys(h.state().nativeAsks)).toHaveLength(2);

    // One prune, well past both periods: a1 goes, and its ask with it.
    h.at(WECOM_TASK_RETENTION_MS + DAY);
    await h.bridge.tick();
    expect(h.taskIds()).toEqual(['a2']);
    expect(h.state().nativeAsks).toEqual({ malformed });
  });
});

describe('when pruning runs', () => {
  // Case 12. Mutation P9: pruning on every tick turns this red.
  it('prunes at most once per interval', async () => {
    const h = harness();
    await h.turn('a1');
    h.at(WECOM_DEDUPE_RETENTION_MS - WECOM_PRUNE_INTERVAL_MS / 2);
    await h.bridge.tick();
    expect(h.state().seen).toHaveProperty(keyOf('a1'));

    // Expired now, but the last prune was less than an interval ago.
    h.at(WECOM_DEDUPE_RETENTION_MS + 1);
    await h.bridge.tick();
    expect(h.state().seen).toHaveProperty(keyOf('a1'));

    h.at(WECOM_DEDUPE_RETENTION_MS + WECOM_PRUNE_INTERVAL_MS / 2);
    await h.bridge.tick();
    expect(h.state().seen).not.toHaveProperty(keyOf('a1'));
  });

  // Case 13.
  it('poisons the bridge when the prune cannot be saved, leaves the file as it was, and a restart carries on', async () => {
    const h = harness();
    await h.turn('a1');
    await h.turn('a2');
    h.at(WECOM_TASK_RETENTION_MS + DAY);
    const before = readFileSync(h.stateFile, 'utf8');
    const unblock = blockWecomStateWrites(h.stateFile);
    await expect(h.bridge.tick()).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(h.bridge.tick()).rejects.toThrow(/状态写入失败/);
    unblock();
    expect(readFileSync(h.stateFile, 'utf8')).toBe(before);

    const restored = h.restart();
    await restored.tick();
    expect(h.taskIds()).toEqual(['a2']);
    await h.turn('a3');
    expect(vi.mocked(h.core.trigger).mock.calls.at(-1)?.[0].target.sessionId).toBe('s1');
    expect(h.state().tasks[keyOf('a3')].delivered).toBe(true);
  });
});
