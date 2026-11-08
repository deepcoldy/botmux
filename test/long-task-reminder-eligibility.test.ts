import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ config: { cliId: 'codex', larkAppId: 'cli_probe', apiOnly: false } }),
  getBotClient: () => ({ im: { v1: { message: { create: vi.fn() } } } }),
  getAllBots: () => [], loadBotConfigs: () => [], formatLarkError: String,
}));
vi.mock('../src/services/group-context-settings-store.js', () => ({ getGroupContextSettings: () => ({ enabled: false }) }));
vi.mock('../src/services/hook-runner.js', () => ({ emitHookEvent: vi.fn() }));

import { canSendLongTaskReminder } from '../src/core/long-task-reminder-eligibility.js';
import type { DaemonSession } from '../src/core/types.js';

/** Real role-meta store proves the private-reply boundary like production does. */
const dir = mkdtempSync(join(tmpdir(), 'ltr-gate-'));
beforeEach(() => { process.env.SESSION_DATA_DIR = dir; });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

function session(overrides: { scope?: string; adoptedFrom?: unknown; sessionAdoptedFrom?: unknown; replyTargets?: unknown } = {}): DaemonSession {
  return {
    larkAppId: 'cli_probe', chatId: 'oc_probe', chatType: 'group', scope: overrides.scope ?? 'chat',
    worker: { killed: false }, workerGeneration: 1,
    ...(overrides.adoptedFrom ? { adoptedFrom: overrides.adoptedFrom } : {}),
    session: {
      sessionId: 's', status: 'active', workerGeneration: 1, title: 'task', rootMessageId: 'om_root',
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
});
