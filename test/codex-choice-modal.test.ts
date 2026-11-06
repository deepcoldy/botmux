/**
 * Structured detection of Codex interactive selection surfaces.
 *
 * Why this exists: the effort controller used to decide "can I type /model and
 * press Enter?" from `hasEmptyCodexComposer()` alone. Codex paints a CENTERED
 * confirmation dialog (`SelectionViewParams::confirmation()`) as an override of
 * the previous view stack: the backdrop's composer row stays on screen and
 * `list_selection_view::cursor_pos()` returns None, so the physical cursor does
 * not move either. That shape is indistinguishable from "empty composer, safe to
 * type" by composer inspection alone, while the dialog's highlighted row is what
 * an Enter activates.
 *
 * Fixtures under test/fixtures/codex-choice-modal/ are byte-exact captures from
 * codex-cli 0.164.0 running in a private tmux server (capture-pane -p -e) and
 * from a real PTY stream — including a narrow pane and a tall pane, because the
 * dialog is clamped to ≤72 columns and wraps.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';
import { detectCodexChoiceModal } from '../src/utils/codex-choice-modal.js';
import { hasEmptyCodexComposer } from '../src/utils/codex-effort-menu.js';

const FIXTURES = join(process.cwd(), 'test/fixtures/codex-choice-modal');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

/** Feed a captured screen through the SAME renderer the worker uses, at the
 *  geometry it was captured with — replaying at another size reflows the text
 *  and stops being the screen a real pane produces. */
async function render(fixtureName: string, cols: number, rows: number): Promise<string> {
  const renderer = new TerminalRenderer(cols, rows);
  try {
    await renderer.writeAndFlush(fixture(fixtureName));
    return renderer.rawSnapshot();
  } finally {
    renderer.dispose();
  }
}

describe('Codex choice-surface detection (real 0.164 captures)', () => {
  it.each([
    ['tmux-pane-full-access-160x30.txt', 160, 30, 'full access'],
    ['tmux-pane-archive-confirm-160x30.txt', 160, 30, 'archive confirm'],
    ['tmux-pane-archive-tall-160x60.txt', 160, 60, 'archive confirm in a tall pane'],
    ['tmux-pane-archive-native-60x40.txt', 60, 40, 'archive confirm opened in a narrow pane'],
    ['tmux-pane-tool-approval-160x30.txt', 160, 30, 'tool approval'],
  ])('recognises %j (%s) as a modal surface', async (file, cols, rows) => {
    const screen = await render(file, cols, rows);
    const modal = detectCodexChoiceModal(screen);
    expect(modal?.kind).toBe('choice-list');
  });

  it('sees the composer row behind a centered dialog instead of an empty composer', async () => {
    // The whole point: the backdrop composer is visible, so `hasEmptyCodexComposer`
    // alone cannot distinguish this from an idle prompt.
    const screen = await render('tmux-pane-full-access-160x30.txt', 160, 30);
    const modal = detectCodexChoiceModal(screen);
    expect(modal?.composerBehind).toBe(true);
    expect(modal?.selected).toContain('Yes, continue anyway');
  });

  it('recognises the dialog in a real PTY stream, where rows land mid-line', async () => {
    // PTY bytes are cursor-addressed: the overlay's rectangle begins in the
    // middle of the backdrop's text, so option rows are not line-anchored.
    const screen = await render('pty-stream-full-access.bin', 160, 30);
    expect(detectCodexChoiceModal(screen)?.kind).toBe('choice-list');
  });

  it('recognises a dialog whose repaint left the composer BELOW it (real resize)', async () => {
    // Captured from a real 0.164 session: the "Enable full access?" dialog was
    // open at 160 columns, then the pane was resized to 60. Codex's repaint put
    // the dialog mid-screen and the backdrop composer + status rows underneath:
    //
    //   › 1. Yes, continue anyway …   /   2. Cancel …
    //   enter select · esc back
    //   › Ask Codex to do anything
    //   GPT-6.1-Sol xhigh · /tmp/botmux · ← for agents
    //
    // This is the shape a composer-only check cannot see: the LAST prompt row in
    // the viewport is a genuinely empty composer, so `hasEmptyCodexComposer()`
    // is true and the dialog's highlighted row is what an Enter would activate.
    const renderer = new TerminalRenderer(160, 40);
    let screen: string;
    try {
      await renderer.writeAndFlush(fixture('pty-resize-while-open-full-access.bin'));
      renderer.resize(60, 40);
      await renderer.writeAndFlush('');
      screen = renderer.rawSnapshot();
    } finally {
      renderer.dispose();
    }
    expect(hasEmptyCodexComposer(screen)).toBe(true);
    const modal = detectCodexChoiceModal(screen);
    expect(modal?.kind).toBe('choice-list');
    expect(modal?.selected).toContain('Yes, continue anyway');
  });

  it.each([
    [160, 30],
    [160, 50],
    [120, 24],
  ])('leaves a genuine idle composer clear at %ix%i', async (cols, rows) => {
    const screen = await render('idle-composer-full.txt', cols, rows);
    expect(detectCodexChoiceModal(screen)).toBeUndefined();
    expect(hasEmptyCodexComposer(screen)).toBe(true);
  });
});

/**
 * Baseline for the review record: does the OLD composer-only predicate, on its
 * own, already refuse these screens?
 *
 * Both answers are recorded because they answer different questions:
 *  - "was the pre-PR behaviour actually exploitable at this geometry?" → the
 *    old predicate's own verdict here;
 *  - "is the new gate still needed?" → the gate's verdict above. It is, because
 *    the composer-only answer flips with pane geometry, and because a resize
 *    performed while the dialog is open really does leave an empty composer BELOW
 *    the dialog (see pty-resize-while-open-full-access.bin, where the old
 *    predicate reports `true`).
 *
 * Keep this table in sync with the fixtures: it is the reproducible record that
 * the two layers disagree, rather than a claim made only in a review comment.
 */
describe('old composer-only predicate vs the same real captures', () => {
  it.each([
    ['tmux-pane-full-access-160x30.txt', 160, 30, false],
    ['tmux-pane-archive-confirm-160x30.txt', 160, 30, false],
    ['tmux-pane-archive-tall-160x60.txt', 160, 60, false],
    ['tmux-pane-archive-native-60x40.txt', 60, 40, false],
    ['tmux-pane-tool-approval-160x30.txt', 160, 30, false],
    ['pty-stream-full-access.bin', 160, 30, false],
  ])('hasEmptyCodexComposer(%j) === %s', async (file, cols, rows, expected) => {
    // A static dialog leaves its own marked option as the LAST prompt row, so
    // the old predicate rejects it — this is why the pre-PR code was not
    // exploitable at these geometries.
    expect(hasEmptyCodexComposer(await render(file, cols, rows))).toBe(expected);
  });

  it('fails open when the dialog was open across a pane resize', async () => {
    // And this is why the gate is still required: after the repaint the live
    // composer sits BELOW the dialog, so the old predicate admits the screen
    // while the dialog still owns Enter.
    const renderer = new TerminalRenderer(160, 40);
    let screen: string;
    try {
      await renderer.writeAndFlush(fixture('pty-resize-while-open-full-access.bin'));
      renderer.resize(60, 40);
      await renderer.writeAndFlush('');
      screen = renderer.rawSnapshot();
    } finally {
      renderer.dispose();
    }
    expect(hasEmptyCodexComposer(screen)).toBe(true);
    expect(detectCodexChoiceModal(screen)?.kind).toBe('choice-list');
  });
});

describe('Codex choice-surface detection (structure, not substrings)', () => {
  const idle = 'Working\n› Ask Codex to do anything\n\n  GPT-6.1-Sol xhigh · /tmp/project · ← for agents';
  const dialog = (selected: number) => [
    '                         Enable full access?',
    '› Ask Codex to do anything  When Codex runs with full access, it can edit any file',
    '',
    `${selected === 0 ? '›' : ' '} 1. Yes, continue anyway  Apply full access for this session`,
    `${selected === 1 ? '›' : ' '} 2. Cancel                Go back without enabling full access`,
    '',
    '                          enter select · esc back',
  ].join('\n');

  it('does not treat a composer footer or ordinary numbered prose as a menu', () => {
    expect(detectCodexChoiceModal(idle)).toBeUndefined();
    // A plan / numbered answer, with no control footer below it.
    expect(detectCodexChoiceModal([
      'Here is a plan:',
      '1. Read the file',
      '2. Change the parser',
      '3. Run the tests',
      '',
      idle,
    ].join('\n'))).toBeUndefined();
  });

  it('ignores a menu footer quoted higher in the transcript', () => {
    // The footer must be the LAST viewport row; quoting an old screen above a
    // live composer is exactly the resumed-transcript false positive.
    const quoted = [
      'Earlier the CLI showed:',
      '› 1. Yes, proceed',
      '  2. No, and tell Codex what to do differently',
      'enter select · esc back',
      '',
      idle,
    ].join('\n');
    expect(detectCodexChoiceModal(quoted)).toBeUndefined();
  });

  it('ignores option rows mentioned in a draft, which have no control footer', () => {
    expect(detectCodexChoiceModal([
      '› 1. Yes, continue anyway',
      '  2. Cancel',
      '',
      '  GPT-6.1-Sol xhigh · /tmp/project',
    ].join('\n'))).toBeUndefined();
  });

  it('needs a marker: unmarked numbered rows under a footer do not qualify', () => {
    expect(detectCodexChoiceModal([
      'Choose one',
      '  1. First',
      '  2. Second',
      '',
      'enter select · esc back',
    ].join('\n'))).toBeUndefined();
  });

  it('keeps a single option with a marker out (one row is not a choice surface)', () => {
    expect(detectCodexChoiceModal([
      '› 1. Only',
      '',
      'enter select · esc back',
    ].join('\n'))).toBeUndefined();
  });

  it('follows a rebinding footer instead of the default enter/esc wording', () => {
    // Codex renders the CONFIGURED keymap, so the words "enter"/"esc" can be
    // absent entirely (see permission_picker_retry_and_confirmation_follow_…).
    expect(detectCodexChoiceModal([
      '        Enable full access?',
      '› 1. Yes, continue anyway  Apply full access for this session',
      '  2. Cancel                Go back without enabling full access',
      '',
      'f3 select · f2 back',
    ].join('\n'))?.kind).toBe('choice-list');
  });

  it('reports the marked option so diagnostics can name the surface', () => {
    expect(detectCodexChoiceModal(dialog(0))?.selected).toContain('Yes, continue anyway');
    expect(detectCodexChoiceModal(dialog(1))?.selected).toContain('Cancel');
  });

  it('reuses each picker-specific parser so a known menu keeps its own kind', () => {
    expect(detectCodexChoiceModal('Select Model and Effort\n› 1. GPT-6-Sol\n  2. GPT-6-Astra\nenter select · esc back')?.kind)
      .toBe('effort-menu');
    expect(detectCodexChoiceModal('  Meet GPT-6 Sol\n\n› 1. Try new model\n  2. Use existing model\n\n  enter/esc confirm · ^c quit')?.kind)
      .toBe('model-migration');
  });
});
