import { describe, it, expect, beforeEach, vi } from 'vitest';

const { dataDir } = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  return { dataDir: mkdtempSync(join(tmpdir(), 'secretary-rt-')) };
});
vi.mock('../src/config.js', () => ({ config: { session: { dataDir } } }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { createGroupSecretaryRuntime, larkEventToSecretaryMessage } from '../src/services/group-secretary-runtime.js';
import { setGroupSecretaryChat, resetGroupSecretaryStoreCache } from '../src/services/group-secretary-store.js';
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
  setGroupSecretaryChat(APP, CHAT, null);
});

function runtime(snapshots: ObserveSnapshot[], deliver = vi.fn(async () => undefined)) {
  const rt = createGroupSecretaryRuntime({
    larkAppId: APP,
    selfOpenId: () => 'ou_self',
    fetchSnapshot: async () => snapshots.shift() ?? snapshots.at(-1) ?? snapshot('idle'),
    deliver,
    log: () => {},
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
      larkAppId: APP, selfOpenId: () => undefined, fetchSnapshot: fetch as any,
      deliver: vi.fn(), log: () => {}, now: () => clock, tickMs: 1e9,
    });
    await rt.tick();
    expect(fetch).not.toHaveBeenCalled();
    rt.stop();
  });

  it('delivers a silent digest turn as the enabler once a watched session goes idle', async () => {
    setGroupSecretaryChat(APP, CHAT, { enabledBy: 'ou_owner', enabledAt: 1 });
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

  it('a failed probe in between does not fabricate a transition', async () => {
    setGroupSecretaryChat(APP, CHAT, { enabledBy: 'ou_owner', enabledAt: 1 });
    const { rt, deliver } = runtime([snapshot('working'), snapshot('idle', 'unreachable'), snapshot('idle')]);
    for (let i = 0; i < 4; i++) { await rt.tick(); clock += 10_000; }
    expect(deliver).not.toHaveBeenCalled();
    rt.stop();
  });

  it('requeues and retries when delivery fails', async () => {
    setGroupSecretaryChat(APP, CHAT, { enabledBy: 'ou_owner', enabledAt: 1 });
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
