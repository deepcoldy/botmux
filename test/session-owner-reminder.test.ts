import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'bun:test';
import {
  SessionOwnerReminderController,
  deriveSessionOwnerReminderStates,
  normalizeSessionOwnerReminderConfig,
  sessionOwnerReminderDeliveryUuid,
  type SessionOwnerReminderRecord,
} from '../src/core/session-owner-reminder.js';
import { buildSessionOwnerMention } from '../src/services/session-owner-notification.js';
import {
  loadSessionOwnerReminderRecords,
  saveSessionOwnerReminderRecords,
  sessionOwnerReminderStorePath,
} from '../src/services/session-owner-reminder-store.js';

function session(overrides: Record<string, unknown> = {}): any {
  const base: any = {
    session: {
      sessionId: 's1',
      status: 'active',
      scope: 'thread',
      ownerOpenId: 'ou_owner',
      rootMessageId: 'om_root',
    },
    larkAppId: 'cli_bot',
    chatId: 'oc_chat',
    scope: 'thread',
    worker: { killed: false },
    lastScreenStatus: 'idle',
    lastMessageAt: 1_000,
  };
  return Object.assign(base, overrides);
}

const enabled = {
  enabled: true,
  intervalMinutes: 30,
  text: '请继续跟进。',
  states: ['idle'] as const,
};

describe('session owner reminder configuration', () => {
  it('normalizes a valid per-Bot configuration and rejects unsafe mention markup', () => {
    expect(normalizeSessionOwnerReminderConfig(enabled)).toEqual(enabled);
    expect(normalizeSessionOwnerReminderConfig({
      ...enabled,
      text: '<at user_id="ou_other"></at> ping',
    })).toBeUndefined();
  });

  it('builds the same owner mention used by Locate and a stable cycle delivery id', () => {
    expect(buildSessionOwnerMention('ou_owner')).toBe('<at user_id="ou_owner"></at>');
    expect(buildSessionOwnerMention('ou_owner', '请继续跟进。'))
      .toBe('<at user_id="ou_owner"></at> 请继续跟进。');
    expect(sessionOwnerReminderDeliveryUuid('s1', 'idle', 1_000))
      .toBe(sessionOwnerReminderDeliveryUuid('s1', 'idle', 1_000));
    expect(sessionOwnerReminderDeliveryUuid('s1', 'idle', 1_000))
      .not.toBe(sessionOwnerReminderDeliveryUuid('s1', 'idle', 2_000));
  });
});

describe('session owner reminder state projection', () => {
  it('projects every independently selectable runtime signal', () => {
    const ds = session({
      lastScreenStatus: 'limited',
      tuiPromptCardId: 'om_prompt',
      agentAttention: { kind: 'blocked', reason: 'need input', at: 2_000 },
    });
    expect(deriveSessionOwnerReminderStates(ds)).toEqual([
      'tui_prompt',
      'agent_attention',
      'limited',
    ]);
    expect(deriveSessionOwnerReminderStates(session({ worker: null, pendingRepo: true }))).toEqual(['pending_repo']);
    expect(deriveSessionOwnerReminderStates(session({ worker: null, lastScreenStatus: 'limited' }))).toEqual(['dormant']);
  });
});

describe('SessionOwnerReminderController', () => {
  it('waits one interval, repeats, and resets after inbound activity', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
    });
    const ds = session();

    await controller.scan([ds], enabled, 10_000);
    await controller.scan([ds], enabled, 10_000 + 30 * 60_000 - 1);
    expect(send).not.toHaveBeenCalled();

    await controller.scan([ds], enabled, 10_000 + 30 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(ds, '请继续跟进。', expect.stringMatching(/^owner-reminder-/));

    await controller.scan([ds], enabled, 10_000 + 60 * 60_000);
    expect(send).toHaveBeenCalledTimes(2);

    ds.lastMessageAt = 10_000 + 61 * 60_000;
    await controller.scan([ds], enabled, 10_000 + 61 * 60_000);
    await controller.scan([ds], enabled, 10_000 + 90 * 60_000);
    expect(send).toHaveBeenCalledTimes(2);
    await controller.scan([ds], enabled, 10_000 + 91 * 60_000);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('resets the quiet period when any projected runtime state changes', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
    });
    const ds = session();
    await controller.scan([ds], enabled, 1_000);
    ds.tuiPromptCardId = 'om_prompt'; // unselected, but still a state transition
    await controller.scan([ds], enabled, 1_000 + 30 * 60_000);
    expect(send).not.toHaveBeenCalled();
    await controller.scan([ds], enabled, 1_000 + 60 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('resets the quiet period when a NEW agent_attention instance replaces a resolved one', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
    });
    const cfg = { enabled: true, intervalMinutes: 30, text: 'ping', states: ['agent_attention'] as const };
    const ds = session({
      lastScreenStatus: 'working',
      lastMessageAt: 0,
      agentAttention: { kind: 'blocked', reason: 'first', at: 0 },
    });
    await controller.scan([ds], cfg, 0);
    // t+29m: the first attention was resolved and a genuinely new one raised
    // (new `.at`). The label is still 'agent_attention', but this is a fresh
    // actionable item — the timer must restart, not inherit the old 29m.
    ds.agentAttention = { kind: 'blocked', reason: 'second', at: 29 * 60_000 };
    await controller.scan([ds], cfg, 30 * 60_000);
    expect(send).not.toHaveBeenCalled(); // reset observed at this scan → fresh timer
    // A full interval after the reset scan (t=30m) → now it fires.
    await controller.scan([ds], cfg, 60 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('resets the quiet period when a NEW tui_prompt card replaces a resolved one', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
    });
    const cfg = { enabled: true, intervalMinutes: 30, text: 'ping', states: ['tui_prompt'] as const };
    const ds = session({ lastScreenStatus: 'working', lastMessageAt: 0, tuiPromptCardId: 'om_prompt_1' });
    await controller.scan([ds], cfg, 0);
    ds.tuiPromptCardId = 'om_prompt_2'; // old prompt answered, a new one appeared
    await controller.scan([ds], cfg, 30 * 60_000);
    expect(send).not.toHaveBeenCalled();
    await controller.scan([ds], cfg, 60 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps firing for a STABLE instance and reuses the cycle UUID across a failed retry', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockRejectedValueOnce(new Error('lark down')).mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
    });
    const cfg = { enabled: true, intervalMinutes: 30, text: 'ping', states: ['agent_attention'] as const };
    // A single, unchanged attention instance (same `.at`) across the whole run.
    const ds = session({
      lastScreenStatus: 'working',
      lastMessageAt: 0,
      agentAttention: { kind: 'blocked', reason: 'stable', at: 0 },
    });
    await controller.scan([ds], cfg, 0);
    await controller.scan([ds], cfg, 30 * 60_000);       // first attempt fails → backs off
    // Backoff = max(60s, min(interval, 5m)) = 5m, so the retry must land after
    // t=35m (the 60s bump alone would still be inside the backoff window).
    await controller.scan([ds], cfg, 35 * 60_000 + 1);   // retry succeeds
    expect(send).toHaveBeenCalledTimes(2);
    // Same cycle (dueBase unchanged by a failed send) + same instance fingerprint
    // ⇒ the failed attempt and its retry MUST carry the identical delivery UUID
    // so Lark's dedupe window suppresses a double @.
    expect(send.mock.calls[0][2]).toBe(send.mock.calls[1][2]);
  });

  it('filters non-thread and unselected states and backs off failed sends', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockRejectedValueOnce(new Error('lark unavailable')).mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
    });
    const due = session();
    const chatScope = session({ session: { ...session().session, sessionId: 'chat', scope: 'chat' }, scope: 'chat' });
    const working = session({ session: { ...session().session, sessionId: 'working' }, lastScreenStatus: 'working' });

    await controller.scan([due, chatScope, working], enabled, 1_000);
    await controller.scan([due, chatScope, working], enabled, 1_000 + 30 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(Object.keys(records)).toEqual(['s1']);

    await controller.scan([due], enabled, 1_000 + 30 * 60_000 + 60_000);
    expect(send).toHaveBeenCalledTimes(1);
    await controller.scan([due], enabled, 1_000 + 35 * 60_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][2]).toBe(send.mock.calls[1][2]);
  });

  it('filters every ineligible session shape and clears records when disabled', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: ds => ds.chatId !== 'http_async_1' && ds.larkAppId !== 'api_only',
    });
    const eligiblePty = session({ backend: { type: 'pty' } });
    const eligibleTmux = session({
      session: { ...session().session, sessionId: 'tmux' },
      backend: { type: 'tmux' },
    });
    const queued = session({ session: { ...session().session, sessionId: 'queued', queued: true } });
    const ownerless = session({ session: { ...session().session, sessionId: 'ownerless', ownerOpenId: undefined } });
    const closed = session({ session: { ...session().session, sessionId: 'closed', status: 'closed' } });
    const noTransport = session({
      session: { ...session().session, sessionId: 'http' },
      chatId: 'http_async_1',
    });
    const apiOnly = session({
      session: { ...session().session, sessionId: 'api' },
      larkAppId: 'api_only',
    });

    const all = [eligiblePty, eligibleTmux, queued, ownerless, closed, noTransport, apiOnly];
    await controller.scan(all, enabled, 1_000);
    await controller.scan(all, enabled, 1_000 + 30 * 60_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(call => call[0].session.sessionId)).toEqual(['s1', 'tmux']);
    expect(Object.keys(records).sort()).toEqual(['s1', 'tmux']);

    await controller.scan(all, { ...enabled, enabled: false }, 1_000 + 31 * 60_000);
    expect(records).toEqual({});
  });
});

describe('session owner reminder durable store', () => {
  it('round-trips valid records with private permissions and ignores corrupt input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-owner-reminder-'));
    try {
      const records = {
        s1: {
          sessionId: 's1',
          stateFingerprint: 'idle',
          actionableSince: 1_000,
          lastObservedActivityAt: 900,
          lastRemindedAt: 2_000,
        },
      };
      saveSessionOwnerReminderRecords(dir, 'cli_app', records);
      expect(loadSessionOwnerReminderRecords(dir, 'cli_app')).toEqual(records);
      expect(readFileSync(sessionOwnerReminderStorePath(dir, 'cli_app'), 'utf8')).toContain('"stateFingerprint": "idle"');

      writeFileSync(sessionOwnerReminderStorePath(dir, 'cli_app'), '{broken');
      expect(loadSessionOwnerReminderRecords(dir, 'cli_app')).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
