import { describe, it, expect, beforeEach, vi } from 'vitest';

const { dataDir } = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  return { dataDir: mkdtempSync(join(tmpdir(), 'secretary-rt-')) };
});
vi.mock('../src/config.js', () => ({ config: { session: { dataDir } } }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { createGroupSecretaryRuntime, larkEventToSecretaryMessage, setGroupSecretaryRuntime, forgetGroupSecretaryChat, observeGroupSecretaryMessage, staggeredGraceMs } from '../src/services/group-secretary-runtime.js';
import { setGroupSecretaryChat, getGroupSecretaryChat, resetGroupSecretaryStoreCache } from '../src/services/group-secretary-store.js';
import type { ObserveSnapshot } from '../src/services/session-observe.js';

const APP = 'cli_self';
const CHAT = 'oc_chat';

function snapshot(turn: string, probe: 'ok' | 'unreachable' = 'ok'): ObserveSnapshot {
  return {
    schemaVersion: 1,
    observedAt: 0,
    daemons: [{
      larkAppId: 'cli_a',
      probe: { status: probe, source: 'daemon-ipc' },
      sessions: probe === 'ok' ? [{
        schemaVersion: 1,
        observedAt: 0,
        probe: { status: 'ok', source: 'daemon-ipc' },
        identity: { sessionId: 's1', larkAppId: 'cli_a', botName: 'A', chatId: CHAT, scope: 'thread', rootMessageId: 'om_root' },
        cli: {}, backend: { adopted: false },
        liveness: 'alive', turn: turn as any, phase: 'unknown', queued: false, parkedOrSuspended: false, closed: false,
      }] : [],
    }],
  };
}

let clock = 0;
beforeEach(() => {
  clock = 1_000_000;
  resetGroupSecretaryStoreCache();
  setGroupSecretaryChat(CHAT, null);
});

function runtime(snapshots: ObserveSnapshot[], deliver = vi.fn(async () => undefined)) {
  const rt = createGroupSecretaryRuntime({
    enabled: () => true,
    larkAppId: APP,
    selfOpenId: () => 'ou_self',
    fetchSnapshot: async () => snapshots.shift() ?? snapshots.at(-1) ?? snapshot('idle'),
    deliver,
    log: () => {},
    canTalk: () => true,
    now: () => clock,
    tickMs: 1e9,
    sessionPollMs: 10_000,
  });
  return { rt, deliver };
}

describe('group secretary runtime', () => {
  it('does nothing (no snapshot fetch) while no chat is enabled', async () => {
    const fetch = vi.fn();
    const rt = createGroupSecretaryRuntime({
      enabled: () => true,
      larkAppId: APP, selfOpenId: () => undefined, fetchSnapshot: fetch as any,
      deliver: vi.fn(), log: () => {}, canTalk: () => true, now: () => clock, tickMs: 1e9,
    });
    await rt.tick();
    expect(fetch).not.toHaveBeenCalled();
    rt.stop();
  });

  it('delivers a silent digest turn as the enabler once a watched session goes idle', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1 });
    const { rt, deliver } = runtime([snapshot('working'), snapshot('idle')]);
    await rt.tick();
    clock += 10_000; await rt.tick();
    expect(deliver).not.toHaveBeenCalled();
    clock += 5_000; await rt.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    const input = (deliver.mock.calls[0] as any[])[0];
    expect(input.chatId).toBe(CHAT);
    expect(input.ownerOpenId).toBe('ou_owner');
    expect(input.turnId).toMatch(/^secretary:cli_self:oc_chat:/);
    expect(input.prompt).toContain('kind="turn_ended"');
    expect(input.prompt).toContain('thread_root="om_root"');
    rt.stop();
  });

  it('a single failed probe keeps the working baseline, so the real working→idle transition is still reported', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1 });
    const { rt, deliver } = runtime([snapshot('working'), snapshot('idle', 'unreachable'), snapshot('idle')]);
    for (let i = 0; i < 4; i++) { await rt.tick(); clock += 10_000; }
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((deliver.mock.calls[0] as any[])[0].prompt).toContain('turn_ended');
    rt.stop();
  });;

  it('requeues and retries when delivery fails', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1 });
    const deliver = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue(undefined);
    const { rt } = runtime([snapshot('working'), snapshot('idle')], deliver as any);
    await rt.tick();
    clock += 10_000; await rt.tick();
    clock += 5_000; await rt.tick();
    clock += 20_000; await rt.tick();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect((deliver.mock.calls[1] as any[])[0].prompt).toContain('turn_ended');
    rt.stop();
  });
});

describe('group secretary runtime — hardening', () => {
  function textEvent(id: string, createTime: number, chatId = CHAT) {
    return {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_u' } },
      message: { chat_id: chatId, chat_type: 'group', message_id: id, create_time: String(createTime),
        message_type: 'text', content: JSON.stringify({ text: '帮我整理周报' }), mentions: [] },
    };
  }

  it('a slow snapshot fetch is not re-entered by the next tick', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1 });
    let release!: (s: ObserveSnapshot) => void;
    const fetch = vi.fn(() => new Promise<ObserveSnapshot>(r => { release = r; }));
    const rt = createGroupSecretaryRuntime({
      enabled: () => true,
      larkAppId: APP, selfOpenId: () => undefined, fetchSnapshot: fetch, deliver: vi.fn(),
      log: () => {}, canTalk: () => true, now: () => clock, tickMs: 1e9, sessionPollMs: 0,
    });
    const first = rt.tick();
    await rt.tick();
    await rt.tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    release(snapshot('idle'));
    await first;
    rt.stop();
  });

  it('a hung delivery times out without retry and does not block other chats', async () => {
    const CHAT_B = 'oc_b';
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1 });
    setGroupSecretaryChat(CHAT_B, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1 });
    vi.useFakeTimers();
    try {
      const deliver = vi.fn((input: { chatId: string }) => input.chatId === CHAT ? new Promise(() => {}) : Promise.resolve());
      const rt = createGroupSecretaryRuntime({
        enabled: () => true,
        larkAppId: APP, selfOpenId: () => undefined, fetchSnapshot: async () => ({ schemaVersion: 1, observedAt: 0, daemons: [] }),
        deliver, log: () => {}, canTalk: () => true, now: () => clock, tickMs: 1e9, deliverTimeoutMs: 1_000,
      });
      rt.observeMessageEvent(textEvent('om_a', clock, CHAT));
      rt.observeMessageEvent(textEvent('om_b', clock, CHAT_B));
      clock += 60_000;
      const ticking = rt.tick();
      await vi.advanceTimersByTimeAsync(1_000);
      await ticking;
      expect(deliver.mock.calls.map(c => (c[0] as any).chatId).sort()).toEqual([CHAT, CHAT_B].sort());
      clock += 60_000;
      await rt.tick();
      expect(deliver).toHaveBeenCalledTimes(2);
      rt.stop();
    } finally {
      vi.useRealTimers();
      setGroupSecretaryChat(CHAT_B, null);
    }
  });

  it('ignores messages from before the secretary was enabled', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: clock });
    const { rt, deliver } = runtime([]);
    rt.observeMessageEvent(textEvent('om_before', clock - 1_000));
    clock += 60_000;
    await rt.tick();
    expect(deliver).not.toHaveBeenCalled();
    rt.stop();
  });

  it('bot-level switch off: a registered chat gets no snapshot pull, no observation, no delivery; turning it on resumes', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1 });
    let on = false;
    const fetch = vi.fn(async () => snapshot('idle'));
    const deliver = vi.fn(async () => undefined);
    const rt = createGroupSecretaryRuntime({
      larkAppId: APP, enabled: () => on, selfOpenId: () => 'ou_self', fetchSnapshot: fetch,
      deliver, log: () => {}, canTalk: () => true, now: () => clock, tickMs: 1e9, sessionPollMs: 0,
    });
    rt.observeMessageEvent(textEvent('om_while_off', clock));
    clock += 60_000;
    await rt.tick();
    expect(fetch).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();

    on = true;
    clock += 60_000;
    await rt.tick();
    expect(fetch).toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();

    rt.observeMessageEvent(textEvent('om_while_on', clock));
    clock += 60_000;
    await rt.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((deliver.mock.calls[0] as any[])[0].prompt).toContain('om_while_on');
    expect((deliver.mock.calls[0] as any[])[0].prompt).not.toContain('om_while_off');
    rt.stop();
  });

  it('turning the secretary off drops its backlog (off → on does not replay old events)', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1 });
    const { rt, deliver } = runtime([]);
    setGroupSecretaryRuntime(rt);
    observeGroupSecretaryMessage(textEvent('om_1', clock));
    setGroupSecretaryChat(CHAT, null);
    forgetGroupSecretaryChat(CHAT);
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_other', enabledAt: 1 });
    clock += 60_000;
    await rt.tick();
    expect(deliver).not.toHaveBeenCalled();
    setGroupSecretaryRuntime(undefined);
  });
});

describe('group secretary runtime — evidence and ownership', () => {
  it('attaches the stalled session\'s recent transcript to the digest', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1 });
    const fetchTranscript = vi.fn(async () => [{ role: 'agent', text: '第一步做完了，接下来我做第二步' }]);
    const deliver = vi.fn(async () => undefined);
    const snaps = [snapshot('working'), snapshot('idle')];
    const rt = createGroupSecretaryRuntime({
      enabled: () => true,
      larkAppId: APP, selfOpenId: () => undefined, fetchSnapshot: async () => snaps.shift() ?? snapshot('idle'),
      fetchTranscript, deliver, log: () => {}, canTalk: () => true, now: () => clock, tickMs: 1e9,
    });
    await rt.tick(); clock += 10_000; await rt.tick(); clock += 5_000; await rt.tick();
    expect(fetchTranscript).toHaveBeenCalledWith('cli_a', 's1', CHAT);
    const prompt = (deliver.mock.calls[0] as any[])[0].prompt as string;
    expect(prompt).toContain('<recent_transcript trusted="false">');
    expect(prompt).toContain('接下来我做第二步');
    rt.stop();
  });

  it('stops acting for a chat once another local bot takes over', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1 });
    const { rt, deliver } = runtime([snapshot('working'), snapshot('idle')]);
    await rt.tick(); clock += 10_000; await rt.tick();
    setGroupSecretaryChat(CHAT, { larkAppId: 'cli_other', enabledBy: 'ou_owner', enabledAt: 2 });
    clock += 5_000; await rt.tick();
    expect(deliver).not.toHaveBeenCalled();
    rt.stop();
  });

  it('staggers the unaddressed grace per bot within 20–35s', () => {
    const values = ['cli_a', 'cli_b', 'cli_aaf586ba90785cc4', 'cli_aa62247d7df8dcb0'].map(staggeredGraceMs);
    for (const v of values) { expect(v).toBeGreaterThanOrEqual(20_000); expect(v).toBeLessThan(35_000); }
    expect(new Set(values).size).toBeGreaterThan(1);
  });
});

describe('larkEventToSecretaryMessage', () => {
  it('maps a Lark receive event, flags self and @self', () => {
    const m = larkEventToSecretaryMessage({
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_u' } },
      message: {
        chat_id: CHAT, chat_type: 'group', message_id: 'om_1', root_id: 'om_r', create_time: '1700000000000',
        message_type: 'text', content: JSON.stringify({ text: 'hi there' }),
        mentions: [{ id: { open_id: 'ou_self' } }],
      },
    }, 'ou_self');
    expect(m).toMatchObject({ chatId: CHAT, messageId: 'om_1', rootId: 'om_r', senderType: 'user', text: 'hi there', mentionCount: 1, mentionsSelf: true, fromSelf: false, createTime: 1700000000000 });
    expect(larkEventToSecretaryMessage({ message: { chat_type: 'p2p', chat_id: 'oc', message_id: 'om' } }, undefined)).toBeUndefined();
  });
});

describe('group secretary runtime — startup backfill', () => {
  it('backfills recent chat messages as context only, flags own messages, skips pre-enable history', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1_000 });
    const items = [
      { message_id: 'om_old', create_time: '500', msg_type: 'text', sender: { id: 'ou_u', id_type: 'open_id', sender_type: 'user' }, body: { content: JSON.stringify({ text: '开启前' }) } },
      { message_id: 'om_mine', root_id: 'om_root', create_time: String(clock - 5_000), msg_type: 'interactive', sender: { id: APP, id_type: 'app_id', sender_type: 'app' }, body: { content: JSON.stringify({ title: null, elements: [[{ tag: 'text', text: '请升级至最新版本客户端，以查看内容' }]] }) } },
      { message_id: 'om_task', create_time: String(clock - 1_000), msg_type: 'text', sender: { id: 'ou_u', id_type: 'open_id', sender_type: 'user' }, body: { content: JSON.stringify({ text: '帮我整理一下周报' }) } },
    ];
    const deliver = vi.fn(async () => undefined);
    const rt = createGroupSecretaryRuntime({
      enabled: () => true,
      larkAppId: APP, selfOpenId: () => 'ou_self', fetchSnapshot: async () => ({ schemaVersion: 1, observedAt: 0, daemons: [] }),
      fetchRecentMessages: async () => items, deliver, log: () => {}, canTalk: () => true, now: () => clock, tickMs: 1e9,
    });
    await rt.tick();
    clock += 120_000;
    await rt.tick();
    // 补拉的消息不产生「无人认领」事件
    expect(deliver).not.toHaveBeenCalled();
    // 但会作为上下文出现在下一次摘要里
    rt.observeMessageEvent({
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_u' } },
      message: { chat_id: CHAT, chat_type: 'group', message_id: 'om_new', create_time: String(clock), message_type: 'text', content: JSON.stringify({ text: '新任务：查一下日志' }), mentions: [] },
    });
    clock += 60_000;
    await rt.tick();
    const prompt = (deliver.mock.calls[0] as any[])[0].prompt as string;
    expect(prompt).toContain('om_task');
    expect(prompt).not.toContain('开启前');
    expect(prompt).toContain('from_you="true"');
    expect(prompt).toContain('botmux quoted om_mine');
    rt.stop();
  });
});

describe('group secretary runtime — group marker and federation', () => {
  it('stands down and clears its local registration when the marker points at another bot (no resurrection)', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1, markerConfirmedAt: 1 });
    let marker: string | undefined = 'cli_other';
    const writeMarker = vi.fn(async () => ({ ok: true }));
    const deliver = vi.fn(async () => undefined);
    const rt = createGroupSecretaryRuntime({
      enabled: () => true,
      larkAppId: APP, selfOpenId: () => undefined, fetchSnapshot: async () => ({ schemaVersion: 1, observedAt: 0, daemons: [] }),
      readMarker: async () => marker, writeMarker,
      deliver, log: () => {}, canTalk: () => true, now: () => clock, tickMs: 1e9, markerRefreshMs: 60_000,
    });
    await rt.tick();
    expect(getGroupSecretaryChat(APP, CHAT)).toBeUndefined();
    marker = undefined;
    clock += 61_000; await rt.tick();
    rt.observeMessageEvent({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_u' } },
      message: { chat_id: CHAT, chat_type: 'group', message_id: 'om_2', create_time: String(clock), message_type: 'text', content: JSON.stringify({ text: '现在呢' }), mentions: [] } });
    clock += 30_000; await rt.tick();
    expect(deliver).not.toHaveBeenCalled();
    expect(writeMarker).not.toHaveBeenCalled();
    rt.stop();
  });

  it('a confirmed registration whose marker disappeared (turned off elsewhere) is cleared, not re-written', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1, markerConfirmedAt: 5 });
    const writeMarker = vi.fn(async () => ({ ok: true }));
    const rt = createGroupSecretaryRuntime({
      enabled: () => true,
      larkAppId: APP, selfOpenId: () => undefined, fetchSnapshot: async () => ({ schemaVersion: 1, observedAt: 0, daemons: [] }),
      readMarker: async () => undefined, writeMarker,
      deliver: vi.fn(), log: () => {}, canTalk: () => true, now: () => clock, tickMs: 1e9,
    });
    await rt.tick();
    expect(writeMarker).not.toHaveBeenCalled();
    expect(getGroupSecretaryChat(APP, CHAT)).toBeUndefined();
    rt.stop();
  });

  it('legacy migration retries after a failed marker write and keeps working meanwhile', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1 });
    const writeMarker = vi.fn().mockResolvedValueOnce({ ok: false, reason: 'description_too_long' }).mockResolvedValue({ ok: true });
    const deliver = vi.fn(async () => undefined);
    const rt = createGroupSecretaryRuntime({
      enabled: () => true,
      larkAppId: APP, selfOpenId: () => undefined, fetchSnapshot: async () => ({ schemaVersion: 1, observedAt: 0, daemons: [] }),
      readMarker: async () => undefined, writeMarker: writeMarker as any,
      deliver, log: () => {}, canTalk: () => true, now: () => clock, tickMs: 1e9, markerRefreshMs: 60_000,
    });
    await rt.tick();
    rt.observeMessageEvent({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_u' } },
      message: { chat_id: CHAT, chat_type: 'group', message_id: 'om_3', create_time: String(clock), message_type: 'text', content: JSON.stringify({ text: '有人吗' }), mentions: [] } });
    clock += 30_000; await rt.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    clock += 61_000; await rt.tick();
    expect(writeMarker).toHaveBeenCalledTimes(2);
    expect(getGroupSecretaryChat(APP, CHAT)?.markerConfirmedAt).toBeDefined();
    rt.stop();
  });

  it('does not take over a marker another machine wrote during legacy migration, then stands down', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1 });
    let marker: string | undefined;
    // The remote takeover lands between our read and our conditional write.
    const writeMarker = vi.fn(async () => { marker = 'cli_remote'; return { ok: false, reason: 'marker_changed', previous: 'cli_remote' }; });
    const deliver = vi.fn(async () => undefined);
    const rt = createGroupSecretaryRuntime({
      enabled: () => true,
      larkAppId: APP, selfOpenId: () => undefined, fetchSnapshot: async () => ({ schemaVersion: 1, observedAt: 0, daemons: [] }),
      readMarker: async () => marker, writeMarker: writeMarker as any,
      deliver, log: () => {}, canTalk: () => true, now: () => clock, tickMs: 1e9, markerRefreshMs: 60_000,
    });
    rt.observeMessageEvent({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_u' } },
      message: { chat_id: CHAT, chat_type: 'group', message_id: 'om_tk', create_time: String(clock), message_type: 'text', content: JSON.stringify({ text: '有人吗' }), mentions: [] } });
    clock += 30_000;
    await rt.tick();
    expect(writeMarker).toHaveBeenCalledWith(CHAT, APP, { expect: null });
    expect(getGroupSecretaryChat(APP, CHAT)?.markerConfirmedAt).toBeUndefined();
    expect(deliver).not.toHaveBeenCalled(); // the takeover is honoured in the same tick
    await rt.tick(); // re-read right away, not a full refresh interval later
    expect(getGroupSecretaryChat(APP, CHAT)).toBeUndefined();
    expect(writeMarker).toHaveBeenCalledTimes(1);
    rt.stop();
  });

  it('a hanging marker read times out instead of freezing the loop', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1, markerConfirmedAt: 1 });
    vi.useFakeTimers();
    try {
      const rt = createGroupSecretaryRuntime({
        enabled: () => true,
        larkAppId: APP, selfOpenId: () => undefined, fetchSnapshot: async () => ({ schemaVersion: 1, observedAt: 0, daemons: [] }),
        readMarker: () => new Promise(() => {}), deliver: vi.fn(), log: () => {}, canTalk: () => true,
        now: () => clock, tickMs: 1e9, markerTimeoutMs: 1_000,
      });
      const t = rt.tick();
      await vi.advanceTimersByTimeAsync(1_000);
      await t;
      clock += 61_000;
      const t2 = rt.tick();
      await vi.advanceTimersByTimeAsync(1_000);
      await t2;
      rt.stop();
    } finally { vi.useRealTimers(); }
  });;

  it('migrates a legacy local-only registration by writing the marker once', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1 });
    const writeMarker = vi.fn(async () => ({ ok: true }));
    const rt = createGroupSecretaryRuntime({
      enabled: () => true,
      larkAppId: APP, selfOpenId: () => undefined, fetchSnapshot: async () => ({ schemaVersion: 1, observedAt: 0, daemons: [] }),
      readMarker: async () => undefined, writeMarker,
      deliver: vi.fn(), log: () => {}, canTalk: () => true, now: () => clock, tickMs: 1e9, markerRefreshMs: 60_000,
    });
    await rt.tick(); clock += 61_000; await rt.tick();
    expect(writeMarker).toHaveBeenCalledTimes(1);
    expect(writeMarker).toHaveBeenCalledWith(CHAT, APP, { expect: null });
    rt.stop();
  });

  it('merges remote (federated) sessions so their transitions raise events too', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1 });
    const remote = [{ sessionId: 'r1', larkAppId: 'cli_fox', botName: 'fox', chatId: CHAT, scope: 'thread' as const, rootMessageId: 'om_r', liveness: 'alive' as const, turn: 'working' }];
    const deliver = vi.fn(async () => undefined);
    const rt = createGroupSecretaryRuntime({
      enabled: () => true,
      larkAppId: APP, selfOpenId: () => undefined, fetchSnapshot: async () => ({ schemaVersion: 1, observedAt: 0, daemons: [] }),
      fetchRemoteViews: async () => remote.map(r => ({ ...r })),
      deliver, log: () => {}, canTalk: () => true, now: () => clock, tickMs: 1e9, sessionPollMs: 10_000,
    });
    await rt.tick();
    remote[0]!.turn = 'idle';
    clock += 10_000; await rt.tick();
    clock += 5_000; await rt.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((deliver.mock.calls[0] as any[])[0].prompt).toContain('bot_name="fox"');
    rt.stop();
  });
});

describe('group secretary runtime — busy detection', () => {
  it('holds message batches while its own chat session is working, then delivers when it is idle', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1 });
    let ownTurn = 'working';
    const own = () => ({
      schemaVersion: 1 as const, observedAt: 0,
      daemons: [{ larkAppId: APP, probe: { status: 'ok' as const, source: 'daemon-ipc' as const }, sessions: [{
        schemaVersion: 1 as const, observedAt: 0, probe: { status: 'ok' as const, source: 'daemon-ipc' as const },
        identity: { sessionId: 'own', larkAppId: APP, chatId: CHAT, scope: 'chat' as const },
        cli: {}, backend: { adopted: false }, liveness: 'alive' as const, turn: ownTurn as any, phase: 'unknown' as const, queued: false, parkedOrSuspended: false, closed: false,
      }] }],
    });
    const deliver = vi.fn(async () => undefined);
    const rt = createGroupSecretaryRuntime({
      enabled: () => true,
      larkAppId: APP, selfOpenId: () => undefined, fetchSnapshot: async () => own(),
      deliver, log: () => {}, canTalk: () => true, now: () => clock, tickMs: 1e9, sessionPollMs: 0,
    });
    await rt.tick();
    rt.observeMessageEvent({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_u' } },
      message: { chat_id: CHAT, chat_type: 'group', message_id: 'om_b', create_time: String(clock), message_type: 'text', content: JSON.stringify({ text: '有新情况' }), mentions: [] } });
    clock += 30_000; await rt.tick();
    expect(deliver).not.toHaveBeenCalled();
    ownTurn = 'idle';
    clock += 5_000; await rt.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    rt.stop();
  });
});

describe('group secretary runtime — registration re-checked after awaits', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
  }
  function migratingRuntime(writeMarker: (chatId: string, appId: string | null) => Promise<{ ok: boolean; reason?: string }>) {
    return createGroupSecretaryRuntime({
      enabled: () => true,
      larkAppId: APP, selfOpenId: () => undefined, fetchSnapshot: async () => ({ schemaVersion: 1, observedAt: 0, daemons: [] }),
      readMarker: async () => undefined, writeMarker,
      deliver: vi.fn(), log: () => {}, canTalk: () => true, now: () => clock, tickMs: 1e9, markerRefreshMs: 60_000,
    });
  }

  it('legacy migration does not resurrect a registration turned off while the marker write was in flight', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1 });
    const write = deferred<{ ok: boolean }>();
    const writeMarker = vi.fn().mockReturnValueOnce(write.promise).mockResolvedValue({ ok: true });
    const rt = migratingRuntime(writeMarker as any);
    const pending = rt.tick();
    await vi.waitFor(() => expect(writeMarker).toHaveBeenCalledTimes(1));
    setGroupSecretaryChat(CHAT, null); // /secretary off 落盘
    write.resolve({ ok: true });
    await pending;
    expect(getGroupSecretaryChat(APP, CHAT)).toBeUndefined();
    // 迟到的迁移写把标记写回了自己：撤回，群里不留没人当的秘书标记。
    expect(writeMarker).toHaveBeenLastCalledWith(CHAT, null, { expect: APP });
    rt.stop();
  });

  it('legacy migration does not overwrite a local takeover that landed while the marker write was in flight', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1 });
    const write = deferred<{ ok: boolean }>();
    const writeMarker = vi.fn().mockReturnValueOnce(write.promise).mockResolvedValue({ ok: true });
    const rt = migratingRuntime(writeMarker as any);
    const pending = rt.tick();
    await vi.waitFor(() => expect(writeMarker).toHaveBeenCalledTimes(1));
    setGroupSecretaryChat(CHAT, { larkAppId: 'cli_other', enabledBy: 'ou_owner', enabledAt: 2, markerConfirmedAt: 2 });
    write.resolve({ ok: true });
    await pending;
    resetGroupSecretaryStoreCache();
    expect(getGroupSecretaryChat('cli_other', CHAT)?.enabledAt).toBe(2);
    expect(getGroupSecretaryChat(APP, CHAT)).toBeUndefined();
    expect(writeMarker).toHaveBeenLastCalledWith(CHAT, 'cli_other', { expect: APP });
    rt.stop();
  });

  for (const [label, change] of [
    ['turned off', () => setGroupSecretaryChat(CHAT, null)],
    ['taken over', () => setGroupSecretaryChat(CHAT, { larkAppId: 'cli_other', enabledBy: 'ou_owner', enabledAt: 2 })],
  ] as const) {
    it(`does not deliver a digest for a chat ${label} while its transcript was being fetched`, async () => {
      setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1 });
      const lines = deferred<Array<{ role: string; text: string }>>();
      const fetchTranscript = vi.fn(() => lines.promise);
      const deliver = vi.fn(async () => undefined);
      const snaps = [snapshot('working'), snapshot('idle')];
      const rt = createGroupSecretaryRuntime({
        enabled: () => true,
        larkAppId: APP, selfOpenId: () => undefined, fetchSnapshot: async () => snaps.shift() ?? snapshot('idle'),
        fetchTranscript: fetchTranscript as any, deliver, log: () => {}, canTalk: () => true, now: () => clock, tickMs: 1e9,
      });
      await rt.tick(); clock += 10_000; await rt.tick(); clock += 5_000;
      const pending = rt.tick();
      await vi.waitFor(() => expect(fetchTranscript).toHaveBeenCalledTimes(1));
      change();
      lines.resolve([{ role: 'agent', text: '做完了' }]);
      await pending;
      expect(deliver).not.toHaveBeenCalled();
      rt.stop();
    });
  }

  it('off then on again during the transcript fetch drops the digest from before the reopen', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1 });
    const lines = deferred<Array<{ role: string; text: string }>>();
    const fetchTranscript = vi.fn(() => lines.promise);
    const deliver = vi.fn(async () => undefined);
    const snaps = [snapshot('working'), snapshot('idle')];
    const rt = createGroupSecretaryRuntime({
      enabled: () => true,
      larkAppId: APP, selfOpenId: () => undefined, fetchSnapshot: async () => snaps.shift() ?? snapshot('idle'),
      fetchTranscript: fetchTranscript as any, deliver, log: () => {}, canTalk: () => true, now: () => clock, tickMs: 1e9,
    });
    await rt.tick(); clock += 10_000; await rt.tick(); clock += 5_000;
    const pending = rt.tick();
    await vi.waitFor(() => expect(fetchTranscript).toHaveBeenCalledTimes(1));
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_new', enabledAt: 2 });
    lines.resolve([]);
    await pending;
    // 关了又开（新的一次开启）：关之前的旧事件不该投递。
    expect(deliver).not.toHaveBeenCalled();
    rt.stop();
  });
});

describe('group secretary runtime — unaddressed candidates under the real 5s tick', () => {
  const TICK = 5_000;
  function humanTopLevel(id: string, createTime: number) {
    return {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_u' } },
      message: { chat_id: CHAT, chat_type: 'group', message_id: id, create_time: String(createTime),
        message_type: 'text', content: JSON.stringify({ text: '谁帮我查下昨天的报错' }), mentions: [] },
    };
  }
  function botReplyUnder(id: string, rootId: string, createTime: number) {
    return {
      sender: { sender_type: 'app', sender_id: { open_id: 'ou_bot_b', app_id: 'cli_b' } },
      message: { chat_id: CHAT, chat_type: 'group', message_id: id, root_id: rootId, parent_id: rootId,
        create_time: String(createTime), message_type: 'text', content: JSON.stringify({ text: '我来查' }), mentions: [] },
    };
  }
  const prompts = (deliver: ReturnType<typeof vi.fn>) => deliver.mock.calls.map(c => (c[0] as any).prompt as string);

  it('an unclaimed message is held out of the ordinary batch and wakes the secretary only once its grace expires', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1 });
    const { rt, deliver } = runtime([]);
    const grace = staggeredGraceMs(APP);
    const sentAt = clock;
    rt.observeMessageEvent(humanTopLevel('om_q', sentAt));
    // 按真实 5 秒节拍推进，宽限到期前任何一拍都不能把这条消息投给秘书。
    while (clock + TICK < sentAt + grace) {
      clock += TICK; await rt.tick();
      expect(prompts(deliver).filter(p => p.includes('"om_q"'))).toEqual([]);
    }
    for (let i = 0; i < 3; i++) { clock += TICK; await rt.tick(); }
    const hits = prompts(deliver).filter(p => p.includes('"om_q"'));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('kind="unaddressed_task"');
    expect(hits[0]).toContain('message_id="om_q"');
    rt.stop();
  });

  it('a bot claiming the message during grace cancels the wake-up; the message is still perceived with the reply', async () => {
    setGroupSecretaryChat(CHAT, { larkAppId: APP, enabledBy: 'ou_owner', enabledAt: 1 });
    const { rt, deliver } = runtime([]);
    const sentAt = clock;
    rt.observeMessageEvent(humanTopLevel('om_q', sentAt));
    clock += TICK; await rt.tick();
    clock += TICK; await rt.tick();
    rt.observeMessageEvent(botReplyUnder('om_r', 'om_q', clock));
    for (let i = 0; i < 12; i++) { clock += TICK; await rt.tick(); }
    const all = prompts(deliver);
    expect(all.some(p => p.includes('kind="unaddressed_task"'))).toBe(false);
    const batch = all.filter(p => p.includes('"om_r"'));
    expect(batch).toHaveLength(1);
    expect(batch[0]).toContain('kind="new_messages"');
    expect(batch[0]).toContain('id="om_q"');
    rt.stop();
  });
});
