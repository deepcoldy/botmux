/**
 * Keep-alive write gate: the injected line is submitted with Enter, so it may
 * only land in Claude's real composer — never on a permission dialog or an
 * AskUserQuestion picker, which also read as "idle".
 *
 * Run: bun run vitest run test/prompt-cache-keepalive-gate.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  composerScreenLogTail,
  promptCacheKeepaliveRefusal,
  type PromptCacheKeepaliveWriteProbe,
} from '../src/core/prompt-cache-keepalive-gate.js';
import { parseCapturedScreenRows } from '../src/utils/captured-screen-rows.js';
import type { ScreenRow } from '../src/utils/terminal-cells.js';

/** A plain-text screen as cells: nothing dim, nothing inverse. */
function cells(text: string): ScreenRow[] {
  return text.split('\n').map(line => Array.from(line).map(ch => ({ ch, dim: false, inverse: false })));
}

const READY = /❯/;
const RULE = '─'.repeat(80);

const COMPOSER = [
  '⏺ 记住了，暗号是 MANGO-7341。',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

const PERMISSION_DIALOG = [
  '⏺ BOTMUX_NOTHING_TO_SEND',
  '',
  RULE,
  ' Bash command',
  '',
  '   rm -rf build',
  '   Clean the build directory',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for rm commands in this project",
  '   3. No, and tell Claude what to do differently (esc)',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n');

// A permission dialog whose wrapped question used to be invisible while the
// empty composer box is still painted below it: the last readyPattern hit then
// sits inside a framed composer, so without the wrap fix the gate ALLOWED the
// keep-alive — an Enter landing on the dialog selects the highlighted choice
// unattended.
const WRAPPED_PERMISSION_DIALOG_OVER_COMPOSER = [
  RULE,
  ' Edit file',
  ' │ const x = 1;',
  '',
  ' Do you want to make this edit to a-very-long-component-file-name-for-the-',
  ' settings-panel-of-account.tsx?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel',
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

// Same regression with the real Edit layout: the diff's last line sits
// DIRECTLY above the wrapped question with no blank row.
const WRAPPED_DIALOG_DIRECTLY_ABOVE_COMPOSER = [
  RULE,
  ' Edit file',
  ' │ -  const x;',
  ' │ +  const x = 1;',
  ' Do you want to make this edit to a-very-long-component-file-name-for-the-',
  ' settings-panel-of-account.tsx?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel',
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

const ASK_USER_QUESTION = [
  RULE,
  ' ☐ Deploy',
  '',
  'Which environment should I deploy to?',
  '',
  '❯ 1. staging',
  '     Safe to break',
  '  2. production',
  '     Real traffic',
  '  3. Type something.',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

const ok: PromptCacheKeepaliveWriteProbe = {
  hasBackend: true,
  restarting: false,
  promptReady: true,
  tuiPromptOpen: false,
  bareShell: false,
  inputPending: false,
  screen: cells(COMPOSER),
  readyPattern: READY,
};

describe('promptCacheKeepaliveRefusal', () => {
  it('allows the write only with the cursor in the framed composer', () => {
    expect(promptCacheKeepaliveRefusal(ok)).toBeUndefined();
  });

  it('refuses a permission dialog even though it matches the ready pattern', () => {
    expect(READY.test(PERMISSION_DIALOG)).toBe(true);
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: cells(PERMISSION_DIALOG) })).toBe('action_prompt_open');
  });

  it('refuses a wrapped permission dialog even with the composer box still painted', () => {
    expect(READY.test(WRAPPED_PERMISSION_DIALOG_OVER_COMPOSER)).toBe(true);
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: cells(WRAPPED_PERMISSION_DIALOG_OVER_COMPOSER) })).toBe('action_prompt_open');
  });

  it('refuses a wrapped dialog whose last diff row is directly above the question', () => {
    expect(READY.test(WRAPPED_DIALOG_DIRECTLY_ABOVE_COMPOSER)).toBe(true);
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: cells(WRAPPED_DIALOG_DIRECTLY_ABOVE_COMPOSER) })).toBe('action_prompt_open');
  });

  it('refuses a one-line permission question with the composer still painted below', () => {
    const screen = [PERMISSION_DIALOG, RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n');
    expect(READY.test(screen)).toBe(true);
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: cells(screen) })).toBe('action_prompt_open');
  });

  it('refuses a dialog wrapped beyond the join window (the notification parser stays silent)', () => {
    // Head + 4 continuations: claudeActionPrompt deliberately does not
    // reconstruct it, but the hard choices+footer evidence is on screen.
    // Failing closed here is what keeps the keep-alive Enter off the dialog.
    const screen = [
      RULE,
      ' Edit file',
      ` Do you want to make this edit to components-${'a'.repeat(40)}`,
      ` panel-${'b'.repeat(40)}`,
      ` section-${'c'.repeat(40)}`,
      ` view-${'d'.repeat(40)}`,
      ' final.tsx?',
      ' ❯ 1. Yes',
      '   2. No',
      '',
      ' Esc to cancel',
      RULE,
      '❯ ',
      RULE,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    expect(READY.test(screen)).toBe(true);
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: cells(screen) })).toBe('action_prompt_open');
  });

  it('refuses the 80-col 4-choice variant with a 5-row wrapped question', () => {
    // Head -> footer spans 11 rows (5 question rows, a wrapped option 3); the
    // compact-block gate window must still cover it.
    const question = `Do you want to make this edit to ${'a'.repeat(200)}/really-long-directory-path-to-a-component-file-in-a-monorepo/packages/editor/src/components/panel.tsx?`;
    const qRows: string[] = [];
    for (let i = 0; i < question.length; i += 78) qRows.push(` ${question.slice(i, i + 78)}`);
    const screen = [
      RULE,
      ' Edit file',
      ...qRows,
      ' ❯ 1. Yes',
      '   2. No, skip for now',
      "   3. Yes, and don't ask again for Bash(rm -rf /home/tiger/work/monorepo/packages)",
      '      editor/src/components',
      '   4. No, and tell Claude what to do differently (esc)',
      '',
      ' Esc to cancel',
      RULE,
      '❯ ',
      RULE,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    expect(qRows.length).toBe(5);
    expect(READY.test(screen)).toBe(true);
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: cells(screen) })).toBe('action_prompt_open');
  });

  it('refuses an AskUserQuestion picker (prompt not inside an input box)', () => {
    expect(READY.test(ASK_USER_QUESTION)).toBe(true);
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: cells(ASK_USER_QUESTION) })).toBe('prompt_not_framed');
  });

  it('refuses a composer holding an unsent draft, allows an empty one', () => {
    const withLine = (line: string) => cells(COMPOSER.replace('❯ ', line));
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: withLine('❯ 帮我把这个函数重') })).toBe('composer_not_empty');
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: withLine('  ❯ half typed') })).toBe('composer_not_empty');
    // The live empty composer: prompt followed by a non-breaking space.
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: withLine('❯\u00a0') })).toBeUndefined();
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: withLine('❯') })).toBeUndefined();
  });

  it('fails closed without an authoritative screen', () => {
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: undefined })).toBe('no_screen_evidence');
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: [] })).toBe('no_screen_evidence');
    expect(promptCacheKeepaliveRefusal({ ...ok, readyPattern: undefined })).toBe('no_screen_evidence');
    // A snapshot taken without preserveFormatting has the box rules blanked out.
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: cells(COMPOSER.replaceAll('─', ' ')) })).toBe('prompt_not_framed');
  });

  it.each([
    [{ hasBackend: false }, 'no_backend'],
    [{ restarting: true }, 'restarting'],
    [{ promptReady: false }, 'prompt_not_ready'],
    [{ tuiPromptOpen: true }, 'tui_prompt_open'],
    [{ bareShell: true }, 'bare_shell'],
    [{ inputPending: true }, 'input_pending'],
  ] as const)('refuses %j', (override, reason) => {
    expect(promptCacheKeepaliveRefusal({ ...ok, ...override })).toBe(reason);
  });
});

/** The composer row `❯ <text>` with every character of <text> dim (ghost). */
function withComposerRow(screen: string, row: ScreenRow): ScreenRow[] {
  const rows = cells(screen);
  const y = rows.findIndex(r => r.map(c => c.ch).join('') === '❯ ');
  rows[y] = row;
  return rows;
}
function promptRow(text: string, attrs: (index: number) => { dim?: boolean; inverse?: boolean }): ScreenRow {
  return [
    { ch: '❯', dim: false, inverse: false },
    { ch: ' ', dim: false, inverse: false },
    ...Array.from(text).map((ch, i) => ({ ch, dim: !!attrs(i).dim, inverse: !!attrs(i).inverse })),
  ];
}

describe('input box shapes Claude Code 2.1.3xx draws', () => {
  const titled = (top: string) => cells(COMPOSER.replace(`${RULE}\n❯ `, `${top}\n❯ `));

  it('the top rule may carry the session name, tags or the history position', () => {
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: titled(`${'─'.repeat(60)} 修复Kimi后台唤醒后回复不转发飞书 ─`) })).toBeUndefined();
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: titled(`${'─'.repeat(60)} ↯ fast  xhigh ─`) })).toBeUndefined();
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: titled(`─── History 3/10 ${'─'.repeat(60)}`) })).toBeUndefined();
  });

  it('still refuses text that only looks like a rule', () => {
    // No rule after the text, text glued to the rule, or barely any rule.
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: titled(`${'─'.repeat(60)} 标题`) })).toBe('prompt_not_framed');
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: titled(`${'─'.repeat(60)}标题─`) })).toBe('prompt_not_framed');
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: titled('── a ─') })).toBe('prompt_not_framed');
    // Text in the BOTTOM rule is never Claude's input box.
    const bottomTitled = cells(COMPOSER.replace(`❯ \n${RULE}`, `❯ \n${'─'.repeat(60)} 标题 ─`));
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: bottomTitled })).toBe('prompt_not_framed');
  });

  it('dim ghost text in the input box is not a draft; typed text is', () => {
    const suggestion = '好，复核完直接推，CI 绿了发链接';
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: withComposerRow(COMPOSER, promptRow(suggestion, () => ({ dim: true }))) })).toBeUndefined();
    // Claude's own cursor: one inverse, non-dim cell on the suggestion's first character.
    expect(promptCacheKeepaliveRefusal({
      ...ok, screen: withComposerRow(COMPOSER, promptRow(suggestion, i => (i === 0 ? { inverse: true } : { dim: true }))),
    })).toBeUndefined();
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: withComposerRow(COMPOSER, promptRow(suggestion, () => ({}))) })).toBe('composer_not_empty');
    // A typed draft that merely ends in a dim autocomplete tail.
    expect(promptCacheKeepaliveRefusal({
      ...ok, screen: withComposerRow(COMPOSER, promptRow('/compact', i => (i < 5 ? {} : { dim: true }))),
    })).toBe('composer_not_empty');
    // A one-letter draft under the cursor has nothing dim: still a draft.
    expect(promptCacheKeepaliveRefusal({ ...ok, screen: withComposerRow(COMPOSER, promptRow('y', () => ({ inverse: true }))) })).toBe('composer_not_empty');
  });
});

describe('real Claude Code input boxes (capture-pane -e -p of live panes)', () => {
  const FIXTURES = join(process.cwd(), 'test/fixtures');
  const capture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
  const judge = (text: string) => promptCacheKeepaliveRefusal({ ...ok, screen: parseCapturedScreenRows(text) });
  /** Same row typed by hand: the cells without SGR 2. */
  const typed = (text: string) => text.split('\n').map(row => (row.startsWith('\x1b[39m❯') ? row.replace(/\x1b\[2m/g, '') : row)).join('\n');

  it.each([
    'claude-prompt-suggestion/empty-input-160x50.txt',
    'claude-prompt-suggestion/empty-input-cursor-160x50.txt',
    'claude-prompt-suggestion/suggestion-160x50.txt',
    'claude-prompt-suggestion/suggestion-under-cursor-160x50.txt',
    'claude-prompt-suggestion/suggestion-titled-rule-160x50.txt',
    'claude-prompt-suggestion/static-example-160x50.txt',
    'claude-prompt-suggestion/meta-no-response-160x50.txt',
    'claude-composer-resize/pane-capture-214x62.txt',
  ])('an empty input box (at most ghost text) admits the write: %s', name => {
    expect(judge(capture(name))).toBeUndefined();
  });

  it.each([
    'claude-prompt-suggestion/suggestion-160x50.txt',
    'claude-prompt-suggestion/suggestion-titled-rule-160x50.txt',
  ])('the same text typed by hand is refused as a draft: %s', name => {
    expect(judge(typed(capture(name)))).toBe('composer_not_empty');
  });
});

describe('composerScreenLogTail', () => {
  it('keeps the shape the gate read, never the text in the input box', () => {
    const draft = withComposerRow(COMPOSER, promptRow('my secret draft', () => ({})));
    const tail = composerScreenLogTail(draft, READY);
    expect(tail.join('\n')).not.toContain('secret');
    // Every non-blank row is accounted for, the box rules included.
    expect(tail).toHaveLength(COMPOSER.split('\n').filter(line => line.trim()).length);
    const ghost = composerScreenLogTail(withComposerRow(COMPOSER, promptRow('建议', () => ({ dim: true }))), READY);
    expect(ghost.join('\n')).not.toContain('建议');
    // The two cases a refusal has to tell apart stay distinguishable.
    expect(ghost[2]).not.toBe(tail[2]);
    const empty = composerScreenLogTail(cells(COMPOSER), READY);
    expect(empty[2]).toBe('❯');
  });
});
