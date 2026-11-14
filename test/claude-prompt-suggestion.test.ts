/**
 * Claude Code's prompt suggestion, read from real screens.
 *
 * Fixtures under test/fixtures/claude-prompt-suggestion/ are capture-pane -e -p
 * viewports of live Claude Code 2.1.3xx sessions (see the README there). Each
 * one is replayed through BOTH production paths:
 *   - tmux: the screen sampler's transient terminal (snapshotToText + cells),
 *     fed exactly what TmuxPipeBackend.captureViewport() returns;
 *   - PTY: the worker's long-lived TerminalRenderer.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudePromptSuggestion } from '../src/utils/claude-prompt-suggestion.js';
import { snapshotToText } from '../src/utils/transient-snapshot.js';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';
import { normaliseCaptureLineEndings } from '../src/adapters/backend/tmux-pipe-backend.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import type { ScreenRow } from '../src/utils/terminal-cells.js';

const FIXTURES = join(process.cwd(), 'test/fixtures/claude-prompt-suggestion');
const COLS = 160;
const ROWS = 50;
// What captureWithBounds() puts in front of an alternate-screen pane.
const ALT_SCREEN_SEED = '\x1b[?1049h\x1b[H\x1b[2J';

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

/** The pane's input row typed by hand instead of suggested: same cells, no SGR 2. */
function asTypedDraft(capture: string): string {
  return capture.split('\n').map(row => row.startsWith('\x1b[39m❯') ? row.replace(/\x1b\[2m/g, '') : row).join('\n');
}

async function tmuxCells(capture: string): Promise<ScreenRow[]> {
  const viewport = ALT_SCREEN_SEED + normaliseCaptureLineEndings(capture);
  const backend = {
    captureViewport: () => viewport,
    captureCurrentScreen: () => viewport,
    getPaneSize: () => ({ cols: COLS, rows: ROWS }),
  };
  const snap = await snapshotToText(backend, COLS, ROWS, { filter: true, cells: true });
  expect(snap?.cells).toHaveLength(ROWS);
  return snap!.cells!;
}

async function ptyCells(capture: string): Promise<ScreenRow[]> {
  const renderer = new TerminalRenderer(COLS, ROWS);
  try {
    await renderer.writeAndFlush(ALT_SCREEN_SEED + normaliseCaptureLineEndings(capture));
    return renderer.viewportCells();
  } finally {
    renderer.dispose();
  }
}

const CASES: Array<[string, string | undefined, string]> = [
  ['suggestion-160x50.txt', 'CI 绿了就合', 'a suggestion in the input box'],
  ['suggestion-titled-rule-160x50.txt', '检查通过就推上去', 'the top rule carries the session title'],
  ['suggestion-under-cursor-160x50.txt', '把那 9 个残留会话关掉', "the CLI's inverse cursor sits on the first character"],
  ['meta-no-response-160x50.txt', undefined, 'the suggestion model answered `<no response>`'],
  ['meta-parenthetical-160x50.txt', undefined, 'the suggestion model answered with a parenthetical'],
  ['static-example-160x50.txt', undefined, 'the static `Try "…"` example of an unused input box'],
  ['empty-input-160x50.txt', undefined, 'an empty input box'],
  ['empty-input-cursor-160x50.txt', undefined, 'an empty input box with the drawn cursor'],
];

describe.each([
  ['tmux capture path', tmuxCells],
  ['PTY renderer path', ptyCells],
] as const)('Claude prompt suggestion (%s)', (_path, cells) => {
  it.each(CASES)('%s → %j (%s)', async (file, expected) => {
    expect(claudePromptSuggestion(await cells(fixture(file)))).toBe(expected);
  });

  it('never reads a typed draft as a suggestion', async () => {
    const draft = asTypedDraft(fixture('suggestion-160x50.txt'));
    expect(draft).not.toBe(fixture('suggestion-160x50.txt'));
    expect(claudePromptSuggestion(await cells(draft))).toBeUndefined();
  });
});

describe('prompt suggestion capability', () => {
  it('is what the Claude Code adapter reads', async () => {
    const adapter = createCliAdapterSync('claude-code');
    expect(adapter.promptSuggestion?.(await tmuxCells(fixture('suggestion-160x50.txt')))).toBe('CI 绿了就合');
  });

  it('is absent for a CLI without one, so nothing is offered', () => {
    expect(createCliAdapterSync('codex').promptSuggestion).toBeUndefined();
  });
});
