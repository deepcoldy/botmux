import { describe, expect, it } from 'vitest';
import {
  ClaudeSwitchConfirmGuard,
  claudeSwitchKindForCommand,
  decideStartupSwitchConfirm,
  detectClaudeSwitchConfirmDialog,
} from '../src/utils/claude-switch-confirm.js';

describe('claudeSwitchKindForCommand', () => {
  it('matches /effort and /model with a single explicit argument', () => {
    expect(claudeSwitchKindForCommand('/effort max')).toBe('effort');
    expect(claudeSwitchKindForCommand('/effort ultracode')).toBe('effort');
    expect(claudeSwitchKindForCommand('  /effort high  ')).toBe('effort');
    expect(claudeSwitchKindForCommand('/model opus')).toBe('model');
    expect(claudeSwitchKindForCommand('/model claude-opus-4-7[1m]')).toBe('model');
  });

  it('does not match the bare forms (they open a picker, unknown target)', () => {
    expect(claudeSwitchKindForCommand('/effort')).toBeNull();
    expect(claudeSwitchKindForCommand('/effort   ')).toBeNull();
    expect(claudeSwitchKindForCommand('/model')).toBeNull();
  });

  it('does not match a multi-token line (anchored to one argument)', () => {
    expect(claudeSwitchKindForCommand('/effort max please')).toBeNull();
    expect(claudeSwitchKindForCommand('/model opus now')).toBeNull();
  });

  it('does not match other commands', () => {
    expect(claudeSwitchKindForCommand('/fast')).toBeNull();
    expect(claudeSwitchKindForCommand('/modelx opus')).toBeNull();
    expect(claudeSwitchKindForCommand('effort max')).toBeNull();
    expect(claudeSwitchKindForCommand('please /effort max')).toBeNull();
  });
});

describe('ClaudeSwitchConfirmGuard', () => {
  it('passes on every chunk until it is armed', () => {
    const guard = new ClaudeSwitchConfirmGuard();
    expect(guard.isArmed()).toBe(false);
    expect(
      guard.inspect('Change effort level?\n❯ 1. Yes, switch to max\n  2. No, go back'),
    ).toBe('pass');
  });

  it('confirms the fully-rendered effort dialog through ANSI', () => {
    const guard = new ClaudeSwitchConfirmGuard();
    guard.arm('effort');
    const dialog =
      '\x1b[2J\x1b[1;1HChange effort level?\x1b[3;1HYour next response will be slower'
      + '\x1b[5;1H\x1b[7m❯ 1. Yes, switch to max\x1b[6;1H  2. No, go back';
    expect(guard.inspect(dialog)).toBe('confirm');
  });

  it('detects the dialog split across PTY chunks', () => {
    const guard = new ClaudeSwitchConfirmGuard();
    guard.arm('effort');
    // Title first, then the two option rows in a later redraw chunk.
    expect(guard.inspect('\x1b[1;1HChange effort level?')).toBe('pass');
    expect(guard.inspect('\x1b[5;1H❯ 1. Yes, switch to ultracode\x1b[6;1H  2. No, go back')).toBe(
      'confirm',
    );
  });

  it('requires BOTH numbered rows: title + only "1. Yes" is not enough', () => {
    const guard = new ClaudeSwitchConfirmGuard();
    guard.arm('effort');
    expect(guard.inspect('Change effort level?\n❯ 1. Yes, switch to max')).toBe('pass');
    expect(guard.isArmed()).toBe(true);
  });

  // Reviewer's reproduction: stale scrollback containing "yes" BEFORE a
  // half-drawn title must never be read as the rendered confirm option.
  it('does not confirm when "yes" is stale scrollback preceding the title', () => {
    const guard = new ClaudeSwitchConfirmGuard();
    guard.arm('effort');
    expect(guard.inspect('Earlier assistant answer: yes, that works\n')).toBe('pass');
    expect(guard.inspect('\x1b[1;1HChange effort level?')).toBe('pass');
    expect(guard.isArmed()).toBe(true);
  });

  it('only matches options AFTER the most recent title', () => {
    const guard = new ClaudeSwitchConfirmGuard();
    guard.arm('effort');
    // "1. Yes / 2. No" appear as prior prose, THEN a bare title redraw — the
    // options are before the title, so they must not count.
    expect(guard.inspect('checklist: 1. yes path 2. no path\n')).toBe('pass');
    expect(guard.inspect('Change effort level?')).toBe('pass');
    expect(guard.isArmed()).toBe(true);
  });

  it('is one-shot: disarms after confirming so a redraw cannot re-fire', () => {
    const guard = new ClaudeSwitchConfirmGuard();
    guard.arm('effort');
    const dialog = 'Change effort level?\n❯ 1. Yes, switch to max\n  2. No, go back';
    expect(guard.inspect(dialog)).toBe('confirm');
    expect(guard.isArmed()).toBe(false);
    expect(guard.inspect(dialog)).toBe('pass');
  });

  it('does not mistake an ordinary composer screen for the dialog', () => {
    const guard = new ClaudeSwitchConfirmGuard();
    guard.arm('effort');
    expect(guard.inspect('❯ yes, please write the tests for @file')).toBe('pass');
    expect(guard.isArmed()).toBe(true);
  });

  it('disarm and reset stop it watching', () => {
    const guard = new ClaudeSwitchConfirmGuard();
    guard.arm('effort');
    guard.disarm();
    expect(guard.isArmed()).toBe(false);
    expect(
      guard.inspect('Change effort level?\n❯ 1. Yes, switch to max\n  2. No, go back'),
    ).toBe('pass');

    guard.arm('effort');
    guard.reset();
    expect(guard.isArmed()).toBe(false);
  });
});

describe('ClaudeSwitchConfirmGuard for /model', () => {
  const modelDialog = 'Switch model?\n❯ 1. Yes, switch to Opus 4.7\n  2. No, go back';

  it('confirms the "Switch model?" dialog when armed for a /model passthrough', () => {
    const guard = new ClaudeSwitchConfirmGuard();
    guard.arm('model');
    expect(guard.inspect(modelDialog)).toBe('confirm');
  });

  // `/model` runs the user's PreModelSwitch hooks; one that asks a person
  // reuses this dialog with its own subtitle. Not ours to answer.
  it('leaves a PreModelSwitch hook\'s confirmation alone and stops watching', () => {
    const guard = new ClaudeSwitchConfirmGuard();
    guard.arm('model');
    const hookDialog = 'Switch model?\nA PreModelSwitch hook asked you to confirm\nOpus is over budget.\n❯ 1. Yes, switch to Opus 4.7\n  2. No, go back';
    expect(guard.inspect(hookDialog)).toBe('pass');
    expect(guard.isArmed()).toBe(false);
  });

  it('only answers the dialog of the kind it was armed for', () => {
    const guard = new ClaudeSwitchConfirmGuard();
    guard.arm('effort');
    expect(guard.inspect(modelDialog)).toBe('pass');
    expect(guard.isArmed()).toBe(true);
  });
});

/** Shape of `tmux capture-pane -e` on Claude Code 2.1.319 after `/effort max`
 *  in a resumed conversation (captured 2026-11-06; conversation text replaced). */
const RULE_TOP = '▔'.repeat(80);
function claudeScreen(dialog: string[], above: string[] = ['● Earlier answer in the resumed conversation.', '✻ Baked for 4m 57s · done 8:48 PM']): string {
  return [...above, RULE_TOP, ...dialog, '', '', ''].join('\n');
}
const EFFORT_CACHE_DIALOG = [
  '\x1b[39m   \x1b[1m\x1b[38;5;220mChange effort level?',
  '\x1b[0m\x1b[39m\x1b[49m   \x1b[38;5;246mYour next response will be slower and use more tokens',
  '\x1b[39m',
  '   This conversation is cached for the current effort level. Switching to \x1b[1mmax\x1b[0m\x1b[39m\x1b[49m means the full history gets re-read.',
  '',
  '   \x1b[38;5;153m❯\x1b[39m \x1b[38;5;246m1. \x1b[38;5;153mYes, switch to max\x1b[39m',
  '     \x1b[38;5;246m2. \x1b[39mNo, go back',
];
const MODEL_CACHE_DIALOG = [
  '   Switch model?',
  '   Your next response will be slower and use more tokens',
  '',
  '   This conversation is cached for the current model. Switching to Opus 4.7 means the full history gets re-read.',
  '',
  '   ❯ 1. Yes, switch to Opus 4.7',
  '     2. No, go back',
];
const EFFORT_HOOK_DIALOG = [
  '   Change effort level?',
  '   A PreModelSwitch hook asked you to confirm',
  '',
  '   max costs more than this team budget allows; confirm with the owner first.',
  '',
  '   ❯ 1. Yes, switch to max',
  '     2. No, go back',
];
const COMPOSER = ['─'.repeat(80), '❯ ', '─'.repeat(80), '  ? for shortcuts'];

describe('detectClaudeSwitchConfirmDialog', () => {
  it('reads the cache warning of the captured 2.1.319 effort dialog through ANSI', () => {
    expect(detectClaudeSwitchConfirmDialog(claudeScreen(EFFORT_CACHE_DIALOG))).toEqual({
      kind: 'effort', target: 'max', reason: 'cache', acceptFocused: true,
    });
  });

  it('reads the model variant of the same dialog', () => {
    expect(detectClaudeSwitchConfirmDialog(claudeScreen(MODEL_CACHE_DIALOG))).toEqual({
      kind: 'model', target: 'Opus 4.7', reason: 'cache', acceptFocused: true,
    });
  });

  it('tells a PreModelSwitch hook asking a person apart from the cache warning', () => {
    expect(detectClaudeSwitchConfirmDialog(claudeScreen(EFFORT_HOOK_DIALOG))).toMatchObject({ kind: 'effort', reason: 'hook' });
  });

  it('reports wording it does not know as unknown rather than as the cache warning', () => {
    const reworded = ['   Change effort level?', '   Switching now restarts the session.', '', '   ❯ 1. Yes, switch to max', '     2. No, go back'];
    expect(detectClaudeSwitchConfirmDialog(claudeScreen(reworded))).toMatchObject({ reason: 'unknown' });
  });

  it('matches loosely reworded titles and rows (no list numbers, other marker)', () => {
    const loose = ['  Switch effort level?', '  This conversation is cached; switching means the history gets re-read.', '  › Yes, change to xhigh', '    No'];
    expect(detectClaudeSwitchConfirmDialog(claudeScreen(loose))).toEqual({
      kind: 'effort', target: 'xhigh', reason: 'cache', acceptFocused: true,
    });
  });

  it('notices when the selection marker is not on the accept row', () => {
    const movedToNo = [...EFFORT_CACHE_DIALOG.slice(0, 5), '     1. Yes, switch to max', '   ❯ 2. No, go back'];
    expect(detectClaudeSwitchConfirmDialog(claudeScreen(movedToNo))).toMatchObject({ acceptFocused: false });
  });

  // A resumed conversation can quote this very dialog (e.g. a capture-pane
  // output); the composer drawn below it shows it is history, not a dialog.
  it('ignores the dialog quoted in history above the composer', () => {
    const quoted = ['● The pane showed:', ...EFFORT_CACHE_DIALOG];
    expect(detectClaudeSwitchConfirmDialog([...quoted, ...COMPOSER].join('\n'))).toBeNull();
  });

  // Only the dialog's own height counts: option-like rows at the bottom with a
  // title far up the screen are not one dialog.
  it('ignores a title too far above the option rows to be the same dialog', () => {
    const body = Array.from({ length: 20 }, (_, i) => `   line ${i + 1} of an answer about effort levels`);
    const spread = ['   Change effort level?', '   This conversation is cached.', ...body, '   ❯ 1. Yes, switch to max', '     2. No, go back'];
    expect(detectClaudeSwitchConfirmDialog(claudeScreen(spread))).toBeNull();
  });

  it('ignores other startup dialogs and an ordinary composer', () => {
    const autoMode = [
      '   Make auto mode your default permission mode?',
      '   ❯ 1. Yes, set auto mode as my default permission mode',
      '     2. No, keep bypass permissions',
    ];
    expect(detectClaudeSwitchConfirmDialog(claudeScreen(autoMode))).toBeNull();
    expect(detectClaudeSwitchConfirmDialog(['● Done.', ...COMPOSER].join('\n'))).toBeNull();
    expect(detectClaudeSwitchConfirmDialog('')).toBeNull();
  });
});

describe('decideStartupSwitchConfirm', () => {
  it('accepts the cache warning for the switch the startup command asked for', () => {
    expect(decideStartupSwitchConfirm(claudeScreen(EFFORT_CACHE_DIALOG), '/effort max')).toMatchObject({ accept: true });
    expect(decideStartupSwitchConfirm(claudeScreen(MODEL_CACHE_DIALOG), '/model opus')).toMatchObject({ accept: true });
  });

  it('leaves a hook\'s request, unknown wording or a moved marker to a person', () => {
    expect(decideStartupSwitchConfirm(claudeScreen(EFFORT_HOOK_DIALOG), '/effort max')).toMatchObject({ accept: false });
    const reworded = ['   Change effort level?', '   Switching now restarts the session.', '', '   ❯ 1. Yes, switch to max', '     2. No, go back'];
    expect(decideStartupSwitchConfirm(claudeScreen(reworded), '/effort max')).toMatchObject({ accept: false });
    const movedToNo = [...EFFORT_CACHE_DIALOG.slice(0, 5), '     1. Yes, switch to max', '   ❯ 2. No, go back'];
    expect(decideStartupSwitchConfirm(claudeScreen(movedToNo), '/effort max')).toMatchObject({ accept: false });
  });

  it('answers nothing for a dialog of another kind or a line that is not a switch', () => {
    expect(decideStartupSwitchConfirm(claudeScreen(MODEL_CACHE_DIALOG), '/effort max')).toBeNull();
    expect(decideStartupSwitchConfirm(claudeScreen(EFFORT_CACHE_DIALOG), '/model opus')).toBeNull();
    expect(decideStartupSwitchConfirm(claudeScreen(EFFORT_CACHE_DIALOG), '/effort')).toBeNull();
    expect(decideStartupSwitchConfirm(claudeScreen(EFFORT_CACHE_DIALOG), '/compact')).toBeNull();
  });
});
