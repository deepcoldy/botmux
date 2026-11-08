/**
 * 群秘书拆分模式（主群总管 + 话题巡查 + 台账）：
 *   - 落点闸：总管回合不许在主群顶层 @ bot；巡查回合锁在被巡查的话题；
 *   - 引擎：话题会话事件按 thread_root 出巡查摘要，主群只收顶层消息 / 无人认领 / 上报；
 *   - runtime：巡查投进话题会话、并发上限、巡查完关掉新建会话、没写台账兜底、上报交给总管；
 *   - 台账存储与 `botmux secretary report`。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { dataDir } = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  return { dataDir: mkdtempSync(join(tmpdir(), 'secretary-patrol-')) };
});
vi.mock('../src/config.js', () => ({ config: { session: { dataDir } } }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateSecretaryRouting,
  parseSecretaryPatrolRoot,
  secretaryPatrolTurnId,
  validateSecretaryAction,
} from '../src/services/send-policy.js';
import { GroupSecretaryEngine, type SecretaryMessage, type SecretarySessionView } from '../src/services/group-secretary-engine.js';
import { createGroupSecretaryRuntime } from '../src/services/group-secretary-runtime.js';
import { setGroupSecretaryChat, resetGroupSecretaryStoreCache } from '../src/services/group-secretary-store.js';
import {
  recordLedger, listLedger, getLedgerEntry, pendingEscalations, markEscalationsDelivered, MAX_LEDGER_HISTORY,
} from '../src/services/group-secretary-ledger-store.js';
import { renderMainSecretaryPrompt, renderPatrolPrompt } from '../src/services/group-secretary-prompt.js';
import { runSecretaryCommand } from '../src/cli/secretary-command.js';
import type { ObserveSnapshot } from '../src/services/session-observe.js';

const SELF = 'cli_self';
const CHAT = 'oc_chat';
const ROOT_A = 'om_rootA';
const ROOT_B = 'om_rootB';
const BOT_OPEN = 'ou_bot_alex';
const HUMAN = 'ou_human';

let clock = 0;

function clearLedger(): void {
  rmSync(join(dataDir, `group-secretary-ledger-${SELF}.json`), { force: true });
  rmSync(join(dataDir, `group-secretary-watches-${SELF}.json`), { force: true });
}

beforeEach(() => {
  clock = 10_000_000;
  clearLedger();
  resetGroupSecretaryStoreCache();
  setGroupSecretaryChat(CHAT, null);
});

// ─── 落点闸 ──────────────────────────────────────────────────────────────────

describe('validateSecretaryRouting', () => {
  const bots = new Set([BOT_OPEN]);
  const mainTurn = `secretary:${SELF}:${CHAT}:1:1`;
  const patrolTurn = secretaryPatrolTurnId(SELF, CHAT, ROOT_A, 1, 1);

  it('refuses a main-group top-level send that @s a bot', () => {
    const r = validateSecretaryRouting({ turnId: mainTurn, mentionOpenIds: [BOT_OPEN], knownBotOpenIds: bots });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('--into');
  });

  it('lets the main turn @ the human leader, or reach a bot through --into / --quote', () => {
    expect(validateSecretaryRouting({ turnId: mainTurn, mentionOpenIds: [HUMAN], knownBotOpenIds: bots }).ok).toBe(true);
    expect(validateSecretaryRouting({ turnId: mainTurn, mentionOpenIds: [BOT_OPEN], knownBotOpenIds: bots, sendInto: ROOT_A }).ok).toBe(true);
    expect(validateSecretaryRouting({ turnId: mainTurn, mentionOpenIds: [BOT_OPEN], knownBotOpenIds: bots, explicitQuote: 'om_msg' }).ok).toBe(true);
  });

  it('pins a patrol turn to its own topic', () => {
    const base = { turnId: patrolTurn, mentionOpenIds: [BOT_OPEN], knownBotOpenIds: bots, sessionChatId: CHAT };
    expect(validateSecretaryRouting(base).ok).toBe(true);
    expect(validateSecretaryRouting({ ...base, sendInto: ROOT_A }).ok).toBe(true);
    expect(validateSecretaryRouting({ ...base, sendTopLevel: true }).ok).toBe(false);
    expect(validateSecretaryRouting({ ...base, sendInto: ROOT_B }).ok).toBe(false);
    expect(validateSecretaryRouting({ ...base, explicitQuote: 'om_x' }).ok).toBe(false);
    expect(validateSecretaryRouting({ ...base, overrideChatId: 'oc_other' }).ok).toBe(false);
    expect(validateSecretaryRouting({ ...base, overrideChatId: CHAT }).ok).toBe(true);
  });

  it('leaves ordinary turns alone', () => {
    expect(validateSecretaryRouting({ turnId: 'om_turn', mentionOpenIds: [BOT_OPEN], knownBotOpenIds: bots, sendTopLevel: true }).ok).toBe(true);
    expect(validateSecretaryRouting({ turnId: undefined, mentionOpenIds: [BOT_OPEN], knownBotOpenIds: bots }).ok).toBe(true);
  });

  it('patrol turn ids keep the secretary action gate and expose their root', () => {
    expect(parseSecretaryPatrolRoot(patrolTurn)).toBe(ROOT_A);
    expect(parseSecretaryPatrolRoot(mainTurn)).toBeUndefined();
    expect(parseSecretaryPatrolRoot('om_turn')).toBeUndefined();
    expect(validateSecretaryAction({ turnId: patrolTurn }).ok).toBe(false);
  });
});

// ─── 台账 ────────────────────────────────────────────────────────────────────

describe('secretary ledger store', () => {
  it('keeps one row per topic with bounded history, and tracks escalation delivery', () => {
    for (let i = 0; i < MAX_LEDGER_HISTORY + 2; i++) {
      recordLedger(SELF, { chatId: CHAT, threadRoot: ROOT_A, status: 'working', summary: `第 ${i} 次`, at: clock + i });
    }
    const row = getLedgerEntry(SELF, CHAT, ROOT_A, undefined, clock + 10)!;
    expect(row.summary).toBe(`第 ${MAX_LEDGER_HISTORY + 1} 次`);
    expect(row.history).toHaveLength(MAX_LEDGER_HISTORY);
    expect(pendingEscalations(SELF, CHAT, undefined, clock + 10)).toHaveLength(0);

    recordLedger(SELF, { chatId: CHAT, threadRoot: ROOT_A, status: 'blocked', summary: '等 Apple ID', escalate: '要国区 Apple ID', at: clock + 20 });
    // 后续一次不带 --escalate 的写入不会抹掉还没交付的上报
    recordLedger(SELF, { chatId: CHAT, threadRoot: ROOT_A, status: 'blocked', summary: '还在等', at: clock + 30 });
    const pending = pendingEscalations(SELF, CHAT, undefined, clock + 40);
    expect(pending.map(e => e.escalation!.text)).toEqual(['要国区 Apple ID']);
    expect(markEscalationsDelivered(SELF, CHAT, [{ threadRoot: ROOT_A, at: clock + 999 }], clock + 50)).toBe(0);
    expect(markEscalationsDelivered(SELF, CHAT, [{ threadRoot: ROOT_A, at: clock + 20 }], clock + 50)).toBe(1);
    expect(pendingEscalations(SELF, CHAT, undefined, clock + 60)).toHaveLength(0);
  });

  it('rejects unknown statuses', () => {
    expect(() => recordLedger(SELF, { chatId: CHAT, threadRoot: ROOT_A, status: 'great' as any, summary: 'x' })).toThrow();
  });
});

describe('botmux secretary report', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env = { ...env, BOTMUX_LARK_APP_ID: SELF, BOTMUX_CHAT_ID: CHAT };
  });

  it('writes the current topic row (root from the session) and records an escalation', async () => {
    process.env.BOTMUX_ROOT_MESSAGE_ID = ROOT_A;
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runSecretaryCommand(['report', '--status', 'blocked', '--summary', 'Alex 等 leader 给出口', '--escalate', '需要干净出口']);
    out.mockRestore();
    expect(code).toBe(0);
    const row = getLedgerEntry(SELF, CHAT, ROOT_A)!;
    expect(row).toMatchObject({ status: 'blocked', summary: 'Alex 等 leader 给出口' });
    expect(row.escalation?.text).toBe('需要干净出口');
  });

  it('refuses outside a topic session and with a bad status', async () => {
    delete process.env.BOTMUX_ROOT_MESSAGE_ID;
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await runSecretaryCommand(['report', '--status', 'done', '--summary', '做完了啊'])).toBe(2);
    process.env.BOTMUX_ROOT_MESSAGE_ID = ROOT_A;
    expect(await runSecretaryCommand(['report', '--status', 'finished', '--summary', '做完了啊'])).toBe(2);
    err.mockRestore();
    expect(listLedger(SELF, CHAT)).toHaveLength(0);
  });
});

// ─── 引擎拆分 ────────────────────────────────────────────────────────────────

function view(id: string, patch: Partial<SecretarySessionView> = {}): SecretarySessionView {
  return {
    sessionId: id, larkAppId: 'cli_alex', botName: 'Alex', chatId: CHAT, scope: 'thread',
    rootMessageId: ROOT_A, liveness: 'alive', turn: 'working', ...patch,
  };
}

function msg(id: string, patch: Partial<SecretaryMessage> = {}): SecretaryMessage {
  return {
    chatId: CHAT, messageId: id, senderType: 'user', senderOpenId: HUMAN, text: '帮我看下这个问题',
    mentionCount: 1, mentionsSelf: false, fromSelf: false, createTime: clock, ...patch,
  };
}

function splitEngine(busy: (chat: string, root?: string) => boolean = () => false) {
  return new GroupSecretaryEngine({
    selfAppId: SELF, isEnabledChat: id => id === CHAT, now: () => clock,
    debounceMs: 5_000, splitPatrol: true, isSecretaryBusy: busy,
  });
}

describe('engine split mode', () => {
  it('routes a topic session event to a patrol digest for that topic only', () => {
    const e = splitEngine();
    e.observeMessage(msg('om_top', { createTime: clock }));
    e.observeMessage(msg('om_inA', { rootId: ROOT_A, text: '话题 A 里的讨论' }));
    e.observeMessage(msg('om_inB', { rootId: ROOT_B, text: '话题 B 里的讨论' }));
    e.observeSessions([view('s1')]);
    clock += 10_000;
    e.observeSessions([view('s1', { turn: 'idle' })]);
    clock += 10_000;
    const digests = e.takeDigests();
    const patrol = digests.find(d => d.target?.kind === 'patrol')!;
    expect(patrol.target).toEqual({ kind: 'patrol', threadRoot: ROOT_A });
    expect(patrol.events.map(ev => ev.kind)).toEqual(['turn_ended']);
    expect(patrol.context.map(m => m.messageId)).toEqual(['om_inA']);
    const main = digests.find(d => d.target?.kind === 'main')!;
    // 主群只收顶层消息：话题里的消息不叫醒总管
    expect(main.events.map(ev => ev.kind)).toEqual(['new_messages']);
    expect(main.events[0]!.messages!.map(m => m.messageId)).toEqual(['om_top']);
  });

  it('topic messages alone never wake the main secretary', () => {
    const e = splitEngine();
    e.observeMessage(msg('om_inA', { rootId: ROOT_A }));
    clock += 20_000;
    expect(e.takeDigests()).toEqual([]);
  });

  it("ignores the secretary's own sessions (patrol sessions must not trigger patrols)", () => {
    const e = splitEngine();
    e.observeSessions([view('p1', { larkAppId: SELF })]);
    clock += 10_000;
    e.observeSessions([view('p1', { larkAppId: SELF, turn: 'idle' })]);
    clock += 10_000;
    expect(e.takeDigests()).toEqual([]);
  });

  it('a busy patrol holds only its own topic', () => {
    const e = splitEngine((_c, root) => root === ROOT_A);
    e.observeSessions([view('s1'), view('s2', { rootMessageId: ROOT_B })]);
    clock += 10_000;
    e.observeSessions([view('s1', { turn: 'idle' }), view('s2', { rootMessageId: ROOT_B, turn: 'idle' })]);
    clock += 10_000;
    const first = e.takeDigests();
    expect(first.map(d => d.target)).toEqual([{ kind: 'patrol', threadRoot: ROOT_B }]);
    // A 的事件还压着；超过总管的最长等待也不会越过巡查并发
    clock += 4 * 60_000;
    expect(e.takeDigests()).toEqual([]);
  });

  it('escalations go to the main digest', () => {
    const e = splitEngine();
    e.noteEscalation(CHAT, { threadRoot: ROOT_A, text: '要拍板', at: clock });
    clock += 10_000;
    const [d] = e.takeDigests();
    expect(d!.target).toEqual({ kind: 'main' });
    expect(d!.events[0]).toMatchObject({ kind: 'escalation', escalation: { threadRoot: ROOT_A, text: '要拍板' } });
  });
});

// ─── 渲染 ────────────────────────────────────────────────────────────────────

describe('patrol / main prompts', () => {
  it('patrol prompt is scoped to one topic and carries the previous ledger row', () => {
    const entry = recordLedger(SELF, { chatId: CHAT, threadRoot: ROOT_A, status: 'working', summary: 'Alex 在导账号', at: clock });
    const text = renderPatrolPrompt({ chatId: CHAT, target: { kind: 'patrol', threadRoot: ROOT_A }, events: [], context: [] }, {
      enabledByOpenId: HUMAN, threadRoot: ROOT_A, ledgerEntry: entry,
    });
    expect(text).toContain(`role="patrol" thread_root="${ROOT_A}"`);
    expect(text).toContain('Alex 在导账号');
    expect(text).toContain('botmux secretary report');
  });

  it('main prompt lists the ledger and renders escalations', () => {
    const entry = recordLedger(SELF, { chatId: CHAT, threadRoot: ROOT_B, status: 'blocked', summary: '等出口', at: clock });
    const text = renderMainSecretaryPrompt({
      chatId: CHAT, target: { kind: 'main' }, context: [],
      events: [{ kind: 'escalation', at: clock, escalation: { threadRoot: ROOT_B, text: '需要干净出口', at: clock } }],
    }, { enabledByOpenId: HUMAN, ledger: [entry] });
    expect(text).toContain('<ledger>');
    expect(text).toContain('等出口');
    expect(text).toContain('需要干净出口');
  });
});

// ─── runtime 拆分 ────────────────────────────────────────────────────────────

interface SnapSession { id: string; app: string; root: string; turn: string; liveness?: 'alive' | 'not_running' | 'closed'; lastMessageAt?: number }

function snap(sessions: SnapSession[]): ObserveSnapshot {
  return {
    schemaVersion: 1,
    observedAt: 0,
    daemons: [{
      larkAppId: 'cli_any',
      probe: { status: 'ok', source: 'daemon-ipc' },
      sessions: sessions.map(s => ({
        schemaVersion: 1, observedAt: 0, probe: { status: 'ok', source: 'daemon-ipc' },
        identity: { sessionId: s.id, larkAppId: s.app, botName: s.app === SELF ? 'Sec' : 'Alex', chatId: CHAT, scope: 'thread', rootMessageId: s.root },
        cli: {}, backend: { adopted: false },
        liveness: s.liveness ?? 'alive', turn: s.turn as any, phase: 'unknown', queued: false, parkedOrSuspended: false, closed: false,
        ...(s.lastMessageAt !== undefined ? { lastActivityAt: s.lastMessageAt } : {}),
      })),
    }],
  } as any;
}

function splitRuntime(opts: { maxConcurrentPatrols?: number } = {}) {
  let current: SnapSession[] = [];
  const deliver = vi.fn(async () => undefined);
  let n = 0;
  const deliverPatrol = vi.fn(async (input: { threadRoot: string }) => ({ sessionId: `patrol-${input.threadRoot}-${++n}`, created: true }));
  const closePatrolSession = vi.fn(async () => undefined);
  const rt = createGroupSecretaryRuntime({
    enabled: () => true,
    larkAppId: SELF,
    selfOpenId: () => 'ou_self',
    fetchSnapshot: async () => snap(current),
    deliver,
    deliverPatrol,
    closePatrolSession,
    log: () => {},
    canTalk: () => true,
    now: () => clock,
    tickMs: 1e9,
    sessionPollMs: 10_000,
    ...(opts.maxConcurrentPatrols ? { maxConcurrentPatrols: opts.maxConcurrentPatrols } : {}),
  });
  return { rt, deliver, deliverPatrol, closePatrolSession, set: (s: SnapSession[]) => { current = s; } };
}

/** 前进到下一次会话轮询并跑一拍。 */
async function step(rt: { tick(): Promise<void> }, ms = 10_000): Promise<void> {
  clock += ms;
  await rt.tick();
}

describe('runtime split mode (patrol)', () => {
  beforeEach(() => {
    setGroupSecretaryChat(CHAT, { larkAppId: SELF, enabledBy: HUMAN, enabledAt: 1 });
  });

  it('delivers a topic event as a patrol into that topic, then closes the one-shot session and backfills the ledger', async () => {
    const h = splitRuntime();
    h.set([{ id: 's1', app: 'cli_alex', root: ROOT_A, turn: 'working' }]);
    await h.rt.tick();
    h.set([{ id: 's1', app: 'cli_alex', root: ROOT_A, turn: 'idle' }]);
    await step(h.rt);
    await step(h.rt);
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.deliverPatrol).toHaveBeenCalledTimes(1);
    const input = (h.deliverPatrol.mock.calls[0] as any[])[0];
    expect(input.threadRoot).toBe(ROOT_A);
    expect(parseSecretaryPatrolRoot(input.turnId)).toBe(ROOT_A);
    expect(input.prompt).toContain('role="patrol"');
    const sid = `patrol-${ROOT_A}-1`;

    // 巡查会话跑一轮再回到空闲 → 收尾：没写台账就兜底，新建的会话关掉
    h.set([{ id: 's1', app: 'cli_alex', root: ROOT_A, turn: 'idle' }, { id: sid, app: SELF, root: ROOT_A, turn: 'working', lastMessageAt: clock }]);
    await step(h.rt);
    expect(h.closePatrolSession).not.toHaveBeenCalled();
    h.set([{ id: 's1', app: 'cli_alex', root: ROOT_A, turn: 'idle' }, { id: sid, app: SELF, root: ROOT_A, turn: 'idle', lastMessageAt: clock - 10_000 }]);
    await step(h.rt);
    expect(h.closePatrolSession).toHaveBeenCalledWith(sid);
    const row = getLedgerEntry(SELF, CHAT, ROOT_A, undefined, clock)!;
    expect(row).toMatchObject({ status: 'idle', auto: true, botName: 'Alex' });
    h.rt.stop();
  });

  it('keeps the patrol session when a human came into it during the patrol', async () => {
    const h = splitRuntime();
    h.set([{ id: 's1', app: 'cli_alex', root: ROOT_A, turn: 'working' }]);
    await h.rt.tick();
    h.set([{ id: 's1', app: 'cli_alex', root: ROOT_A, turn: 'idle' }]);
    await step(h.rt); await step(h.rt);
    const sid = `patrol-${ROOT_A}-1`;
    h.set([{ id: sid, app: SELF, root: ROOT_A, turn: 'working' }]);
    await step(h.rt);
    // 巡查开始一分钟后有人在话题里 @ 了秘书
    h.set([{ id: sid, app: SELF, root: ROOT_A, turn: 'idle', lastMessageAt: clock + 60_000 }]);
    await step(h.rt, 60_000);
    expect(h.closePatrolSession).not.toHaveBeenCalled();
    h.rt.stop();
  });

  /** 话题里的一条消息事件（不 @ 任何人）。 */
  function topicEvent(id: string, root: string, senderType: 'user' | 'app' = 'user') {
    return {
      sender: { sender_type: senderType, sender_id: { open_id: senderType === 'user' ? HUMAN : 'ou_bot' } },
      message: { chat_id: CHAT, chat_type: 'group', message_id: id, root_id: root, parent_id: root,
        create_time: String(clock), message_type: 'text', content: JSON.stringify({ text: '我来看一下' }), mentions: [] },
    };
  }

  /** 跑到巡查会话开始执行，返回它的 sessionId。 */
  async function startPatrol(h: ReturnType<typeof splitRuntime>): Promise<string> {
    h.set([{ id: 's1', app: 'cli_alex', root: ROOT_A, turn: 'working' }]);
    await h.rt.tick();
    h.set([{ id: 's1', app: 'cli_alex', root: ROOT_A, turn: 'idle' }]);
    await step(h.rt); await step(h.rt);
    const sid = `patrol-${ROOT_A}-1`;
    expect(h.deliverPatrol).toHaveBeenCalledTimes(1);
    h.set([{ id: sid, app: SELF, root: ROOT_A, turn: 'working', lastMessageAt: clock }]);
    await step(h.rt);
    return sid;
  }

  it('keeps the patrol session when a human spoke in the topic within the first 30s, even without @', async () => {
    const h = splitRuntime();
    const sid = await startPatrol(h);
    // 会话自己的 lastActivityAt 还在 30 秒宽限内：只靠旁听到的真人消息判断
    h.rt.observeMessageEvent(topicEvent('om_human_early', ROOT_A));
    h.set([{ id: sid, app: SELF, root: ROOT_A, turn: 'idle', lastMessageAt: clock - 10_000 }]);
    await step(h.rt);
    expect(h.closePatrolSession).not.toHaveBeenCalled();
    h.rt.stop();
  });

  it('keeps the patrol session when a human spoke while the patrol delivery was still pending', async () => {
    const h = splitRuntime();
    let release!: (v: { sessionId: string; created: boolean }) => void;
    h.deliverPatrol.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    h.set([{ id: 's1', app: 'cli_alex', root: ROOT_A, turn: 'working' }]);
    await h.rt.tick();
    h.set([{ id: 's1', app: 'cli_alex', root: ROOT_A, turn: 'idle' }]);
    // 推进到巡查投递发出；投递挂起时 tick 也挂着，所以每拍只等一小会儿
    const pendingTicks: Promise<void>[] = [];
    for (let i = 0; i < 4 && h.deliverPatrol.mock.calls.length === 0; i++) {
      clock += 10_000;
      const t = h.rt.tick();
      pendingTicks.push(t);
      await Promise.race([t, new Promise(r => setTimeout(r, 20))]);
    }
    expect(h.deliverPatrol).toHaveBeenCalledTimes(1);
    // 投递还没返回（patrols 里尚未登记），真人此时在话题里说话
    h.rt.observeMessageEvent(topicEvent('om_human_inflight', ROOT_A));
    const sid = 'patrol-inflight';
    release({ sessionId: sid, created: true });
    await Promise.all(pendingTicks);
    h.set([{ id: sid, app: SELF, root: ROOT_A, turn: 'working', lastMessageAt: clock }]);
    await step(h.rt);
    h.set([{ id: sid, app: SELF, root: ROOT_A, turn: 'idle', lastMessageAt: clock - 10_000 }]);
    await step(h.rt);
    expect(h.closePatrolSession).not.toHaveBeenCalled();
    h.rt.stop();
  });

  it('still closes the patrol session when only bots, or humans in another topic, spoke during the patrol', async () => {
    const h = splitRuntime();
    const sid = await startPatrol(h);
    h.rt.observeMessageEvent(topicEvent('om_bot', ROOT_A, 'app'));
    h.rt.observeMessageEvent(topicEvent('om_other_topic', ROOT_B));
    h.set([{ id: sid, app: SELF, root: ROOT_A, turn: 'idle', lastMessageAt: clock - 10_000 }]);
    await step(h.rt);
    expect(h.closePatrolSession).toHaveBeenCalledWith(sid);
    h.rt.stop();
  });

  it('does not let more patrols run than the cap', async () => {
    const h = splitRuntime({ maxConcurrentPatrols: 1 });
    h.set([{ id: 'a', app: 'cli_alex', root: ROOT_A, turn: 'working' }, { id: 'b', app: 'cli_alex', root: ROOT_B, turn: 'working' }]);
    await h.rt.tick();
    h.set([{ id: 'a', app: 'cli_alex', root: ROOT_A, turn: 'idle' }, { id: 'b', app: 'cli_alex', root: ROOT_B, turn: 'idle' }]);
    await step(h.rt); await step(h.rt);
    expect(h.deliverPatrol).toHaveBeenCalledTimes(1);
    const firstRoot = (h.deliverPatrol.mock.calls[0] as any[])[0].threadRoot;
    const sid = `patrol-${firstRoot}-1`;
    // 第一个巡查结束前，第二个话题一直排着
    h.set([{ id: 'a', app: 'cli_alex', root: ROOT_A, turn: 'idle' }, { id: 'b', app: 'cli_alex', root: ROOT_B, turn: 'idle' }, { id: sid, app: SELF, root: firstRoot, turn: 'working' }]);
    await step(h.rt);
    expect(h.deliverPatrol).toHaveBeenCalledTimes(1);
    h.set([{ id: 'a', app: 'cli_alex', root: ROOT_A, turn: 'idle' }, { id: 'b', app: 'cli_alex', root: ROOT_B, turn: 'idle' }, { id: sid, app: SELF, root: firstRoot, turn: 'idle' }]);
    await step(h.rt); await step(h.rt);
    expect(h.deliverPatrol).toHaveBeenCalledTimes(2);
    expect((h.deliverPatrol.mock.calls[1] as any[])[0].threadRoot).not.toBe(firstRoot);
    h.rt.stop();
  });

  it('hands a ledger escalation to the main secretary once and marks it delivered', async () => {
    const h = splitRuntime();
    recordLedger(SELF, { chatId: CHAT, threadRoot: ROOT_A, status: 'blocked', summary: '等 Apple ID', escalate: '需要国区 Apple ID', at: clock });
    await h.rt.tick();
    await step(h.rt);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    const input = (h.deliver.mock.calls[0] as any[])[0];
    expect(input.prompt).toContain('role="main"');
    expect(input.prompt).toContain('需要国区 Apple ID');
    expect(pendingEscalations(SELF, CHAT, undefined, clock)).toHaveLength(0);
    await step(h.rt); await step(h.rt);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    h.rt.stop();
  });

  it('skips patrols for automatic check-ins that show progress', async () => {
    const h = splitRuntime();
    let lines = [{ role: 'agent', text: 'step 1' }];
    const rt = createGroupSecretaryRuntime({
      enabled: () => true,
      larkAppId: SELF, selfOpenId: () => 'ou_self',
      fetchSnapshot: async () => snap([{ id: 's1', app: 'cli_alex', root: ROOT_A, turn: 'working' }]),
      deliver: h.deliver, deliverPatrol: h.deliverPatrol, closePatrolSession: h.closePatrolSession,
      fetchTranscript: async () => lines,
      log: () => {}, canTalk: () => true, now: () => clock, tickMs: 1e9, sessionPollMs: 10_000,
    });
    await rt.tick();
    // 第一次回访只记基线；第二次对话有变化 → 不巡查；第三次没变化 → 巡查
    await step(rt, 5 * 60_000); await step(rt);
    expect(h.deliverPatrol).not.toHaveBeenCalled();
    lines = [{ role: 'agent', text: 'step 2' }];
    await step(rt, 10 * 60_000); await step(rt);
    expect(h.deliverPatrol).not.toHaveBeenCalled();
    await step(rt, 20 * 60_000); await step(rt);
    expect(h.deliverPatrol).toHaveBeenCalledTimes(1);
    expect((h.deliverPatrol.mock.calls[0] as any[])[0].prompt).toContain('check_in');
    rt.stop();
    h.rt.stop();
  });
});
