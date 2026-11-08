import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IDLE_SUSPEND_OLDER_THAN_MS,
  formatIdleSuspendCandidate,
  parseIdleDurationMs,
  parseMaintenanceCommandArgs,
  safeIdleSuspendCliText,
} from '../src/cli/idle-suspend-command.js';

describe('maintenance suspend-idle CLI parsing', () => {
  it.each([
    ['750ms', 750],
    ['30s', 30_000],
    ['15m', 15 * 60_000],
    ['12h', 12 * 60 * 60_000],
    ['0.5d', 12 * 60 * 60_000],
    ['7d', 7 * 24 * 60 * 60_000],
    ['2w', 14 * 24 * 60 * 60_000],
  ])('parses %s', (raw, expected) => {
    expect(parseIdleDurationMs(raw)).toBe(expected);
  });

  it.each(['', '7', '0d', '-1h', 'tomorrow', 'Infinityd', '0.1ms']) (
    'rejects invalid duration %j',
    raw => expect(parseIdleDurationMs(raw)).toBeUndefined(),
  );

  it('defaults to seven days and accepts value flags in both forms', () => {
    expect(parseMaintenanceCommandArgs(['suspend-idle', '--dry-run'])).toEqual({
      ok: true,
      command: {
        action: 'suspend-idle',
        execute: false,
        olderThanMs: DEFAULT_IDLE_SUSPEND_OLDER_THAN_MS,
        json: false,
      },
    });
    expect(parseMaintenanceCommandArgs([
      'suspend-idle', '--older-than=12h', '--bot=cli_a', '--yes', '--json',
    ])).toEqual({
      ok: true,
      command: {
        action: 'suspend-idle',
        execute: true,
        olderThanMs: 12 * 60 * 60_000,
        botAppId: 'cli_a',
        json: true,
      },
    });
  });

  it('requires exactly one acknowledgement and rejects duplicates', () => {
    expect(parseMaintenanceCommandArgs(['suspend-idle'])).toMatchObject({ ok: false });
    expect(parseMaintenanceCommandArgs(['suspend-idle', '--dry-run', '--yes'])).toMatchObject({ ok: false });
    expect(parseMaintenanceCommandArgs(['suspend-idle', '--dry-run', '--dry-run'])).toEqual({
      ok: false,
      error: '参数重复: --dry-run',
    });
    expect(parseMaintenanceCommandArgs([
      'suspend-idle', '--dry-run', '--older-than', '7d', '--older-than=8d',
    ])).toEqual({ ok: false, error: '参数重复: --older-than' });
  });

  it('rejects unknown flags and control-bearing bot ids', () => {
    expect(parseMaintenanceCommandArgs(['other', '--dry-run'])).toEqual({
      ok: false,
      error: '未知 maintenance 子命令: other',
    });
    expect(parseMaintenanceCommandArgs(['suspend-idle', '--dry-run', '--force'])).toEqual({
      ok: false,
      error: '未知参数: --force',
    });
    expect(parseMaintenanceCommandArgs(['suspend-idle', '--dry-run', '--bot', 'cli_a\nspoof'])).toMatchObject({
      ok: false,
    });
  });
});

describe('maintenance suspend-idle output safety', () => {
  it('strips terminal controls and keeps each label on one bounded line', () => {
    expect(safeIdleSuspendCliText('\x1b]0;owned\x07title\nnext\x1b[31mred')).toBe('title nextred');
    expect(safeIdleSuspendCliText('x'.repeat(300))).toHaveLength(240);

    const rendered = formatIdleSuspendCandidate({
      sessionId: 'session-old',
      larkAppId: 'cli_a',
      title: '\x1b[2Jspoof\nsecond line',
      lastActivityAt: Date.UTC(2026, 9, 1),
      idleForMs: 8 * 24 * 60 * 60_000,
      workerPid: 4242,
      backendType: 'tmux',
      backendTarget: 'bmx-session-old',
      processTypes: ['botmux __worker', 'tmux session', 'traex'],
    }, '\x1b[31mBot\x1b[0m');

    expect(rendered).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(rendered).toContain('bot=Bot');
    expect(rendered).toContain('title=spoof second line');
  });
});
