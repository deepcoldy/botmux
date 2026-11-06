import {expect, it} from 'vitest';
import {claudeActionPrompt} from '../src/services/claude-action-prompt.js';

/** 2026-10-02 incident screen (paths swapped for placeholders): a background
 * fork agent's Bash permission dialog sat on a session the main turn had
 * already left, with zero Lark-side signal for hours. */
const INCIDENT_SCREEN = [
  '⏺ BOTMUX_NOTHING_TO_SEND',
  '',
  '✻ Waiting for 1 background agent to finish',
  '',
  '────────────────────────────────────────────────────────────────',
  ' Bash command · from the fork agent',
  ' Extract end-of-beat frames into a contact sheet',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  ' │ cd /tmp/example/video && mkdir -p frames && rm -f frames/* && echo ok',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  ' │ Dangerous rm operation on statically-unresolvable target: /tmp/example/frames/*',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n');

it('projects a fork-agent permission dialog without its command or targets', () => {
  const prompt = claudeActionPrompt(INCIDENT_SCREEN);
  expect(prompt).toContain('Claude 正等待你确认「Bash command · from the fork agent」');
  expect(prompt).toContain('Do you want to proceed?');
  expect(prompt).toContain('1. Yes');
  expect(prompt).toContain('2. No');
  expect(prompt).toContain('请在原终端核对具体操作后选择');
  // Dialog body must stay in the terminal: command text, task summary, and
  // the warning detail carrying the rm target path.
  expect(prompt).not.toContain('rm -f');
  expect(prompt).not.toContain('cd /tmp/example');
  expect(prompt).not.toContain('/tmp/example/frames/*');
  expect(prompt).not.toContain('Dangerous rm operation');
  expect(prompt).not.toContain('Extract end-of-beat');
});

it('projects the three-choice variant (don\'t ask again) with a plain title', () => {
  const prompt = claudeActionPrompt([
    '──────────────────────────────────────',
    ' Bash command',
    '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
    ' │ ls -la /tmp/example',
    '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and don\'t ask again for this session',
    '   3. No, and tell Claude what to do differently (esc)',
    '',
    ' Esc to cancel',
  ].join('\n'));
  expect(prompt).toContain('「Bash command」');
  expect(prompt).toContain('2. Yes, and don\'t ask again for this session');
  expect(prompt).toContain('3. No, and tell Claude what to do differently (esc)');
  expect(prompt).not.toContain('ls -la');
});

it('falls back to a generic title when the dialog body pushed it out of reach', () => {
  // An 18-line command body pushes the title 24 lines above the question,
  // beyond the 15-line scan window — the dialog must still notify.
  const longCommand = Array.from({length: 18}, (_, i) => ` │ ffmpeg -ss 00:0${i}:00 -i /tmp/example/input.mp4 -frames:v 1 frames/${i}.png`);
  const prompt = claudeActionPrompt([
    '──────────────────────────────────────',
    ' Bash command · from the fork agent',
    ' Extract end-of-beat frames into a contact sheet',
    '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
    ...longCommand,
    '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
    ' │ Dangerous rm operation on statically-unresolvable target: /tmp/example/frames/*',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel · Tab to amend',
  ].join('\n'));
  expect(prompt).toContain('「权限确认」');
  expect(prompt).toContain('Do you want to proceed?');
  expect(prompt).not.toContain('ffmpeg');
  expect(prompt).not.toContain('Bash command · from the fork agent');
});

it('falls back to a generic title for a tool title outside the known list', () => {
  const prompt = claudeActionPrompt([
    '──────────────────────────────────────',
    ' NotebookEdit file',
    '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
    ' │ jupyter nbconvert --to notebook /tmp/example/nb.ipynb',
    '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel',
  ].join('\n'));
  expect(prompt).toContain('「权限确认」');
  expect(prompt).not.toContain('nbconvert');
  expect(prompt).not.toContain('NotebookEdit file');
});

it('ignores chat text quoting a dialog: no footer hint means no dialog', () => {
  // Quoted title + question + choices, but conversation output never carries
  // the interactive footer — the deciding evidence.
  expect(claudeActionPrompt([
    '  Earlier in this session Claude asked:',
    '  Bash command',
    '  Do you want to proceed?',
    '  ❯ 1. Yes',
    '    2. No',
    '  and the user picked Yes.',
  ].join('\n'))).toBeUndefined();
  expect(claudeActionPrompt('Do you want to proceed?\n1. Yes\n2. No')).toBeUndefined();
});

it('ignores the screen after the dialog was answered and is gone', () => {
  expect(claudeActionPrompt([
    '⏺ Bash command',
    '',
    '  ⎿  ok',
    '',
    '✻ Waiting for 1 background agent to finish',
    '',
    ' ╭──────────────────────────────────────────────╮',
    ' │ > ❯                                          │',
    ' ╰──────────────────────────────────────────────╯',
  ].join('\n'))).toBeUndefined();
});
