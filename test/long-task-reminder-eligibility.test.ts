import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const botConfigState = {
  cliId: 'codex' as string,
  env: undefined as Record<string, string> | undefined,
};

vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({
    config: {
      cliId: botConfigState.cliId,
      larkAppId: 'cli_probe',
      apiOnly: false,
      ...(botConfigState.env ? { env: botConfigState.env } : {}),
    },
  }),
  getBotClient: () => ({ im: { v1: { message: { create: vi.fn() } } } }),
  getAllBots: () => [], loadBotConfigs: () => [], formatLarkError: String,
}));
vi.mock('../src/services/group-context-settings-store.js', () => ({ getGroupContextSettings: () => ({ enabled: false }) }));
vi.mock('../src/services/hook-runner.js', () => ({ emitHookEvent: vi.fn() }));

import { canSendLongTaskReminder } from '../src/core/long-task-reminder-eligibility.js';
import type { DaemonSession } from '../src/core/types.js';
import { recordBridgeReplyMarker } from '../src/services/bridge-reply-marker.js';

/** Real role-meta store proves the private-reply boundary like production does. */
const dir = mkdtempSync(join(tmpdir(), 'ltr-gate-'));
beforeEach(() => {
  process.env.SESSION_DATA_DIR = dir;
  botConfigState.cliId = 'codex';
  botConfigState.env = undefined;
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

function session(overrides: {
  sessionId?: string;
  scope?: string;
  adoptedFrom?: unknown;
  sessionAdoptedFrom?: unknown;
  replyTargets?: unknown;
  cliId?: string;
  lastScreenStatus?: DaemonSession['lastScreenStatus'];
  backgroundTaskCount?: number;
  replyExecutionStarts?: DaemonSession['replyExecutionStarts'];
} = {}): DaemonSession {
  return {
    larkAppId: 'cli_probe', chatId: 'oc_probe', chatType: 'group', scope: overrides.scope ?? 'chat',
    worker: { killed: false }, workerGeneration: 1,
    ...(overrides.adoptedFrom ? { adoptedFrom: overrides.adoptedFrom } : {}),
    ...(overrides.lastScreenStatus !== undefined ? { lastScreenStatus: overrides.lastScreenStatus } : {}),
    ...(overrides.backgroundTaskCount !== undefined ? { backgroundTaskCount: overrides.backgroundTaskCount } : {}),
    ...(overrides.replyExecutionStarts ? { replyExecutionStarts: overrides.replyExecutionStarts } : {}),
    session: {
      sessionId: overrides.sessionId ?? 's', status: 'active', workerGeneration: 1, title: 'task', rootMessageId: 'om_root',
      ...(overrides.cliId ? { cliId: overrides.cliId } : {}),
      ...(overrides.sessionAdoptedFrom ? { adoptedFrom: overrides.sessionAdoptedFrom } : {}),
      ...(overrides.replyTargets ? { replyTargets: overrides.replyTargets } : {}),
    },
  } as unknown as DaemonSession;
}

describe('long-task reminder eligibility mirrors the per-turn auxiliary-card gates', () => {
  it.each([
    ['om_real_inbound', true],
    ['join_auto_start', true],
  ] as const)('human-inbound turn %s is eligible', (prefix, expected) => {
    expect(canSendLongTaskReminder(session(), `${prefix}_abc`)).toBe(expected);
  });

  it.each([
    'auto-compact:idle:lzz0001',
    'auto-compact:lzz0001',
    'schedule:job-1:uuid',
    'trg_external',
    'workflow-event:run-1:2',
    'background:job-1',
    'cct_card_click',
    'failedTurnRecovery:om_x',
  ])('daemon-minted/non-human turn %s never qualifies', turnId => {
    expect(canSendLongTaskReminder(session(), turnId)).toBe(false);
  });

  it('suppresses a chat-scope substitute turn just like the streaming card gates', () => {
    const ds = session({ replyTargets: { om_sub: { substitute: true, rootMessageId: 'om_root' } } });
    expect(canSendLongTaskReminder(ds, 'om_sub')).toBe(false);
    // A normal direct turn in the same shared session still qualifies.
    expect(canSendLongTaskReminder(ds, 'om_direct')).toBe(true);
  });

  it('suppresses reminders for a group whose role is configured for private replies', async () => {
    mkdirSync(join(dir, 'roles', 'cli_probe'), { recursive: true });
    const { writeRoleReplyPrivately } = await import('../src/core/role-resolver.js');
    const ds = session({ scope: 'thread' });
    expect(canSendLongTaskReminder(ds, 'om_human')).toBe(true);
    writeRoleReplyPrivately('cli_probe', 'oc_probe', true);
    expect(canSendLongTaskReminder(ds, 'om_human')).toBe(false);
  });

  it('suppresses adopted sessions, which own no Lark turn surface', () => {
    expect(canSendLongTaskReminder(session({ adoptedFrom: { cwd: '/tmp/x' } }), 'om_human')).toBe(false);
    expect(canSendLongTaskReminder(session({ sessionAdoptedFrom: { cwd: '/tmp/x' } }), 'om_human')).toBe(false);
  });

  it('suppresses trigger turns whose final result is isolated', async () => {
    const { armTriggerFinalSuppression } = await import('../src/core/trigger-final-suppression.js');
    const ds = session();
    expect(canSendLongTaskReminder(ds, 'om_isolated')).toBe(true);
    armTriggerFinalSuppression(ds, 'om_isolated');
    expect(canSendLongTaskReminder(ds, 'om_isolated')).toBe(false);
  });

  it('suppresses idle non-turn-terminal PTY sessions while keeping working, background-task, and turn-terminal sessions eligible', () => {
    botConfigState.cliId = 'antigravity';
    expect(canSendLongTaskReminder(session({ cliId: 'antigravity', lastScreenStatus: 'idle' }), 'om_human')).toBe(false);
    expect(canSendLongTaskReminder(session({ cliId: 'antigravity', lastScreenStatus: 'working' }), 'om_human')).toBe(true);
    expect(canSendLongTaskReminder(session({ cliId: 'antigravity', lastScreenStatus: 'idle', backgroundTaskCount: 1 }), 'om_human')).toBe(true);

    // Structured-bridge / turn-terminal CLI keeps transient idle eligible until turn_terminal.
    botConfigState.cliId = 'codex';
    expect(canSendLongTaskReminder(session({ cliId: 'codex', lastScreenStatus: 'idle' }), 'om_human')).toBe(true);
  });

  it('suppresses a turn after explicit own-thread final delivery while ignoring progress, cross-chat finals, and older attempts', () => {
    const sid = 's_explicit_final';
    const starts = new Map([
      [JSON.stringify(['om_done', null]), { startedAtMs: 1_000, workerGeneration: 1 }],
      [JSON.stringify(['om_prog', null]), { startedAtMs: 1_000, workerGeneration: 1 }],
      [JSON.stringify(['om_xchat', null]), { startedAtMs: 1_000, workerGeneration: 1 }],
      [JSON.stringify(['om_retried', 2]), { startedAtMs: 5_000, workerGeneration: 1 }],
    ]);
    const ds = session({ sessionId: sid, replyExecutionStarts: starts });

    // Progress send does not close reminders.
    recordBridgeReplyMarker({
      dataDir: dir, sessionId: sid, sentAtMs: 2_000, deliveryKind: 'current_session_send',
      content: 'still checking...', responseKind: 'progress', turnId: 'om_prog',
      targetChatId: 'oc_probe', targetRootMessageId: 'om_root',
    });
    expect(canSendLongTaskReminder(ds, 'om_prog')).toBe(true);

    // Cross-chat final does not prove own-thread completion.
    recordBridgeReplyMarker({
      dataDir: dir, sessionId: sid, sentAtMs: 2_000, deliveryKind: 'detoured_send',
      content: 'sent elsewhere', responseKind: 'final', turnId: 'om_xchat',
      targetChatId: 'oc_other_chat', targetRootMessageId: 'om_other_root',
    });
    expect(canSendLongTaskReminder(ds, 'om_xchat')).toBe(true);

    // Own-thread explicit final suppresses reminders for that turn.
    recordBridgeReplyMarker({
      dataDir: dir, sessionId: sid, sentAtMs: 2_000, deliveryKind: 'current_session_send',
      content: 'all done', responseKind: 'final', turnId: 'om_done',
      targetChatId: 'oc_probe', targetRootMessageId: 'om_root',
    });
    expect(canSendLongTaskReminder(ds, 'om_done')).toBe(false);

    // Earlier attempt's final (sentAtMs < retry startedAtMs) must not silence attempt 2.
    recordBridgeReplyMarker({
      dataDir: dir, sessionId: sid, sentAtMs: 2_000, deliveryKind: 'current_session_send',
      content: 'old attempt', responseKind: 'final', turnId: 'om_retried',
      dispatchAttempt: 1, targetChatId: 'oc_probe', targetRootMessageId: 'om_root',
    });
    expect(canSendLongTaskReminder(ds, 'om_retried', 2)).toBe(true);

    // Attempt-less marker must not suppress a versioned attempt when start time is unknown.
    recordBridgeReplyMarker({
      dataDir: dir, sessionId: sid, sentAtMs: 2_000, deliveryKind: 'current_session_send',
      content: 'legacy marker', responseKind: 'final', turnId: 'om_untracked_retry',
      targetChatId: 'oc_probe', targetRootMessageId: 'om_root',
    });
    expect(canSendLongTaskReminder(ds, 'om_untracked_retry', 2)).toBe(true);
  });
});
