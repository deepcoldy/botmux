import { describe, expect, it } from 'bun:test';
import {
  EffortConfirmDialogGuard,
  isEffortLevelCommand,
} from '../src/utils/effort-confirm-dialog.js';

describe('isEffortLevelCommand', () => {
  it('matches /effort with a single explicit level', () => {
    expect(isEffortLevelCommand('/effort max')).toBe(true);
    expect(isEffortLevelCommand('/effort ultracode')).toBe(true);
    expect(isEffortLevelCommand('  /effort high  ')).toBe(true);
  });

  it('does not match bare /effort (opens a picker, unknown target)', () => {
    expect(isEffortLevelCommand('/effort')).toBe(false);
    expect(isEffortLevelCommand('/effort   ')).toBe(false);
  });

  it('does not match a multi-token line (anchored to one argument)', () => {
    expect(isEffortLevelCommand('/effort max please')).toBe(false);
    expect(isEffortLevelCommand('/effort max now')).toBe(false);
  });

  it('does not match other commands', () => {
    expect(isEffortLevelCommand('/model opus')).toBe(false);
    expect(isEffortLevelCommand('/fast')).toBe(false);
    expect(isEffortLevelCommand('effort max')).toBe(false);
    expect(isEffortLevelCommand('please /effort max')).toBe(false);
  });
});

describe('EffortConfirmDialogGuard', () => {
  it('passes on every chunk until it is armed', () => {
    const guard = new EffortConfirmDialogGuard();
    expect(guard.isArmed()).toBe(false);
    expect(
      guard.inspect('Change effort level?\n❯ 1. Yes, switch to max\n  2. No, go back'),
    ).toBe('pass');
  });

  it('confirms the fully-rendered effort dialog through ANSI', () => {
    const guard = new EffortConfirmDialogGuard();
    guard.arm();
    const dialog =
      '\x1b[2J\x1b[1;1HChange effort level?\x1b[3;1HYour next response will be slower'
      + '\x1b[5;1H\x1b[7m❯ 1. Yes, switch to max\x1b[6;1H  2. No, go back';
    expect(guard.inspect(dialog)).toBe('confirm');
  });

  it('detects the dialog split across PTY chunks', () => {
    const guard = new EffortConfirmDialogGuard();
    guard.arm();
    // Title first, then the two option rows in a later redraw chunk.
    expect(guard.inspect('\x1b[1;1HChange effort level?')).toBe('pass');
    expect(guard.inspect('\x1b[5;1H❯ 1. Yes, switch to ultracode\x1b[6;1H  2. No, go back')).toBe(
      'confirm',
    );
  });

  it('requires BOTH numbered rows: title + only "1. Yes" is not enough', () => {
    const guard = new EffortConfirmDialogGuard();
    guard.arm();
    expect(guard.inspect('Change effort level?\n❯ 1. Yes, switch to max')).toBe('pass');
    expect(guard.isArmed()).toBe(true);
  });

  // Reviewer's reproduction: stale scrollback containing "yes" BEFORE a
  // half-drawn title must never be read as the rendered confirm option.
  it('does not confirm when "yes" is stale scrollback preceding the title', () => {
    const guard = new EffortConfirmDialogGuard();
    guard.arm();
    expect(guard.inspect('Earlier assistant answer: yes, that works\n')).toBe('pass');
    expect(guard.inspect('\x1b[1;1HChange effort level?')).toBe('pass');
    expect(guard.isArmed()).toBe(true);
  });

  it('only matches options AFTER the most recent title', () => {
    const guard = new EffortConfirmDialogGuard();
    guard.arm();
    // "1. Yes / 2. No" appear as prior prose, THEN a bare title redraw — the
    // options are before the title, so they must not count.
    expect(guard.inspect('checklist: 1. yes path 2. no path\n')).toBe('pass');
    expect(guard.inspect('Change effort level?')).toBe('pass');
    expect(guard.isArmed()).toBe(true);
  });

  it('is one-shot: disarms after confirming so a redraw cannot re-fire', () => {
    const guard = new EffortConfirmDialogGuard();
    guard.arm();
    const dialog = 'Change effort level?\n❯ 1. Yes, switch to max\n  2. No, go back';
    expect(guard.inspect(dialog)).toBe('confirm');
    expect(guard.isArmed()).toBe(false);
    expect(guard.inspect(dialog)).toBe('pass');
  });

  it('does not mistake an ordinary composer screen for the dialog', () => {
    const guard = new EffortConfirmDialogGuard();
    guard.arm();
    expect(guard.inspect('❯ yes, please write the tests for @file')).toBe('pass');
    expect(guard.isArmed()).toBe(true);
  });

  it('disarm and reset stop it watching', () => {
    const guard = new EffortConfirmDialogGuard();
    guard.arm();
    guard.disarm();
    expect(guard.isArmed()).toBe(false);
    expect(
      guard.inspect('Change effort level?\n❯ 1. Yes, switch to max\n  2. No, go back'),
    ).toBe('pass');

    guard.arm();
    guard.reset();
    expect(guard.isArmed()).toBe(false);
  });
});
