import { describe, expect, it } from 'vitest';
import {
  buildDashboardSummary,
  parseDashboardSummaryRows,
  unavailableDashboardSummary,
} from '../src/dashboard/dashboard-summary.js';

describe('buildDashboardSummary', () => {
  it('returns only the redacted aggregate contract', () => {
    const summary = buildDashboardSummary({
      generatedAt: new Date('2026-08-08T09:30:00.000Z'),
      configuredBotAppIds: ['cli_a', 'cli_b', 'cli_c'],
      onlineBotAppIds: ['cli_a', 'cli_b', 'cli_c'],
      sessions: [
        {
          sessionId: 'secret-session',
          status: 'working',
          title: 'private prompt',
          workingDir: '/private/repo',
          chatId: 'oc_private',
          larkAppId: 'cli_private',
        },
        { status: 'idle', agentAttention: { reason: 'private reason' } },
        { status: 'limited' },
        { status: 'closed', agentAttention: { reason: 'closed is not attention' } },
      ],
      schedules: [
        { enabled: true, nextRunAt: '2026-08-09T08:00:00+08:00', prompt: 'private schedule prompt' },
        { enabled: true, nextRunAt: '2026-08-08T19:00:00.000Z' },
        { enabled: false, nextRunAt: '2026-08-08T18:00:00.000Z' },
        { enabled: true, nextRunAt: 'not-a-date' },
      ],
    });

    expect(summary).toEqual({
      schemaVersion: 1,
      generatedAt: '2026-08-08T09:30:00.000Z',
      service: { status: 'healthy' },
      bots: { online: 3 },
      sessions: { active: 3, attention: 2 },
      schedules: { enabled: 3, nextRunAt: '2026-08-08T19:00:00.000Z' },
      dashboard: { href: '/' },
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /secret-session|private prompt|private\/repo|oc_private|cli_private|private reason|schedule prompt/,
    );
  });

  it('marks a partial bot fleet degraded and uses null when no enabled task has a valid next run', () => {
    expect(buildDashboardSummary({
      generatedAt: new Date('2026-08-08T09:30:00.000Z'),
      configuredBotAppIds: ['cli_a', 'cli_b', 'cli_c'],
      onlineBotAppIds: ['cli_a', 'cli_b'],
      sessions: [],
      schedules: [{ enabled: false, nextRunAt: '2026-08-09T00:00:00.000Z' }],
    })).toEqual({
      schemaVersion: 1,
      generatedAt: '2026-08-08T09:30:00.000Z',
      service: { status: 'degraded' },
      bots: { online: 2 },
      sessions: { active: 0, attention: 0 },
      schedules: { enabled: 0, nextRunAt: null },
      dashboard: { href: '/' },
    });
  });

  it('marks an equal-sized replacement fleet degraded without exposing bot identities', () => {
    const summary = buildDashboardSummary({
      generatedAt: new Date('2026-08-08T09:30:00.000Z'),
      configuredBotAppIds: ['cli_a', 'cli_c'],
      onlineBotAppIds: ['cli_a', 'cli_b'],
      sessions: [],
      schedules: [],
    });

    expect(summary.service).toEqual({ status: 'degraded' });
    expect(summary.bots).toEqual({ online: 2 });
    expect(JSON.stringify(summary)).not.toMatch(/cli_[abc]/);
  });

  it('stays healthy when every configured bot is online alongside an extra descriptor', () => {
    const summary = buildDashboardSummary({
      generatedAt: new Date('2026-08-08T09:30:00.000Z'),
      configuredBotAppIds: ['cli_a'],
      onlineBotAppIds: ['cli_a', 'cli_orphan'],
      sessions: [],
      schedules: [],
    });

    expect(summary.service).toEqual({ status: 'healthy' });
    expect(summary.bots).toEqual({ online: 2 });
  });

  it('counts a stalled active session as needing attention', () => {
    expect(buildDashboardSummary({
      generatedAt: new Date('2026-08-08T09:30:00.000Z'),
      configuredBotAppIds: ['cli_a'],
      onlineBotAppIds: ['cli_a'],
      sessions: [{ status: 'stalled' }],
      schedules: [],
    }).sessions).toEqual({ active: 1, attention: 1 });
  });

  it('does not invent aggregate zeroes when the live snapshot is unavailable', () => {
    expect(unavailableDashboardSummary(new Date('2026-08-08T09:30:00.000Z'))).toEqual({
      schemaVersion: 1,
      generatedAt: '2026-08-08T09:30:00.000Z',
      service: { status: 'degraded' },
    });
  });
});

describe('parseDashboardSummaryRows', () => {
  it('rejects a session row without a status instead of counting it as active', () => {
    expect(() => parseDashboardSummaryRows({
      sessions: [{}],
      schedules: [],
    })).toThrow(/session status/i);
  });

  it('rejects a schedule row without an enabled flag instead of silently dropping it', () => {
    expect(() => parseDashboardSummaryRows({
      sessions: [],
      schedules: [{}],
    })).toThrow(/schedule enabled/i);
  });

  it.each([
    ['pendingRepo', { status: 'idle', pendingRepo: 'false' }],
    ['tuiPromptActive', { status: 'idle', tuiPromptActive: 1 }],
    ['agentAttention', { status: 'idle', agentAttention: 'blocked' }],
  ])('rejects a malformed session %s signal', (field, row) => {
    expect(() => parseDashboardSummaryRows({
      sessions: [row],
      schedules: [],
    })).toThrow(new RegExp(`session ${field}`, 'i'));
  });

  it('rejects an unknown session status instead of treating it as active', () => {
    expect(() => parseDashboardSummaryRows({
      sessions: [{ status: 'unknown-from-malformed-snapshot' }],
      schedules: [],
    })).toThrow(/session status/i);
  });

  it('rejects a malformed next run timestamp instead of publishing a misleading null', () => {
    expect(() => parseDashboardSummaryRows({
      sessions: [],
      schedules: [{ enabled: true, nextRunAt: 'not-a-date' }],
    })).toThrow(/schedule nextRunAt/i);
  });
});
