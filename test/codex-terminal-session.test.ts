import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { PtyHandle } from '../src/adapters/cli/types.js';
import { findCodexRolloutSetByPid } from '../src/services/codex-transcript.js';
import {
  refreshCodexTerminalSession,
  prepareCodexTerminalStatusLine,
  codexTerminalSessionIsBound,
} from '../src/services/codex-terminal-session.js';

import { codexConfigPathForPid, ensureCodexStatusLineConfig } from '../src/services/codex-statusline-config.js';

vi.mock('../src/services/codex-statusline-config.js', () => ({
  codexConfigPathForPid: vi.fn(),
  ensureCodexStatusLineConfig: vi.fn(),
}));

vi.mock('../src/services/codex-transcript.js', () => ({ findCodexRolloutSetByPid: vi.fn() }));

const sid = '01a0ec3d-3751-7882-9b25-49bc90078561';
const other = '01a0ec3d-3751-7882-9b25-49bc90078562';
const idle = '\n› Ask Codex to do anything\n\n  GPT-6 · Context 79% used\n  ← for agents · ? for shortcuts';
const card = (id: string) => `/status\n╭────────────╮\n│ >_ OpenAI Codex (v0.158.0) │\n│ Server: Local background server │\n│ Model: GPT-6 │\n│ Session: ${id} │\n╰────────────╯\n${idle}`;

function terminal(id = sid) {
  let screen = idle;
  const input = id ? `\n› Ask Codex to do anything\n\n  ${id} · GPT-6 · Context 79% used` : idle;
  const sendText = vi.fn();
  const sendSpecialKeys = vi.fn();
  const pty: PtyHandle = {
    cliPid: 43212, write: vi.fn(), sendText, sendSpecialKeys,
    captureCurrentScreen: () => screen,
    captureInputState: () => ({ viewport: input, cursor: { x: 2, y: 1 } }),
  };
  return { pty, sendText, sendSpecialKeys, setScreen: (value: string) => { screen = value; } };
}

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe('Codex terminal session identity', () => {
  it('requires a visible thread ID without injecting a status command', async () => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal('');
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
    expect(t.sendText).not.toHaveBeenCalled();
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
    expect(t.pty.write).not.toHaveBeenCalled();
  });

  it('reads the current thread from the native footer on every refresh without writing /status', async () => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    let current = sid;
    t.pty.captureInputState = () => ({
      viewport: `\n› Ask Codex to do anything\n\n  ${current} · GPT-6 · Context 79% used`,
      cursor: { x: 2, y: 1 },
    });
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'terminal', sessionId: sid });
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'terminal', sessionId: sid });
    current = other;
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'terminal', sessionId: other });
    expect(codexTerminalSessionIsBound(t.pty, sid)).toBe(false);
    expect(codexTerminalSessionIsBound(t.pty, other)).toBe(true);
    expect(t.sendText).not.toHaveBeenCalled();
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
  });

  // Two-row layouts reproduced from the Linux 0.158 review captures.
  it.each([
    `  GPT-6-Astra xhigh · /tmp · ${sid}\n  ← for agents · ? for shortcuts`,
    `  GPT-6-Astra xhigh · /tmp · ${sid} ⠋\n  ← for agents · ? for shortcuts`,
    `  ⠙ ${sid} · GPT-6 · ⠋\n  ← for agents · ? for shortcuts`,
    `  /tmp/${other} · ${sid}\n  ← for agents · ? for shortcuts`,
    // A right-aligned `⚠ N warnings · f2 to view` notice is space-padded onto
    // the SAME status segment (no ` · ` between id and warning). Reproduced on
    // codex 0.160 with a live warning present.
    `  GPT-6-Astra xhigh · /tmp · ${sid}                                 ⚠ 1 warning · f2 to view`,
    `  ${sid} ⠋                                  ⚠ 2 warnings · f2 to view`,
    // When hints are hidden the warning can also occupy the second row alone.
    `  GPT-6 · ${sid}\n  ⚠ 1 warning · f2 to view`,
    // Codex degrades the notice by width (warning_notice.rs): compact and
    // minimal shapes share only the `⚠ N` prefix and no longer say "warnings".
    `  GPT-6 · ${sid}\n  ⚠ 3 · f2`,
    `  GPT-6 · ${sid}\n  ⚠ 3 · /warnings`,
    `  GPT-6 · ${sid}\n  ⚠ 3`,
    // Emoji-presentation variant (⚠ + U+FE0F) must not fool the row gate.
    `  GPT-6 · ${sid}\n  ⚠️ 2 warnings · f2 to view`,
    // Hints on the left and the warning on the right of the same second row.
    `  GPT-6 · ${sid}\n  ← for agents · ? for shortcuts                        ⚠ 1 warning · f2 to view`,
  ])('reads the two-row Codex 0.158 footer: %s', async (footer) => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.pty.captureInputState = () => ({
      viewport: `Working · esc to interrupt\n› Ask Codex to do anything\n\n${footer}`,
      cursor: { x: 2, y: 1 },
    });
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'terminal', sessionId: sid });
    expect(t.pty.write).not.toHaveBeenCalled();
  });

  it.each([
    `/tmp/${sid} · GPT-6`,
    `project-${sid} · GPT-6`,
    `${sid.slice(0, 20)}… · GPT-6`,
    `${sid} · ${other}`,
    `${sid} · ${sid}`,
    `GPT-6 · Context 79% used`,
    // A non-id suffix may not smuggle a second UUID past the uniqueness gate.
    `${sid} see /tmp/${other}`,
    // The id has to open the segment; a hyphen glued to it is not a boundary.
    `${sid}-x · GPT-6`,
    // A non-word punctuation glued directly after the id is still glued, not a
    // whitespace-delimited status token: file/path/colon suffixes must not bind.
    `${sid}.json · GPT-6`,
    `${sid}/sub · GPT-6`,
    `${sid}:x · GPT-6`,
    `${sid},foo · GPT-6`,
  ])('rejects non-ID or ambiguous segments in the two-row footer: %s', async (footer) => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.pty.captureInputState = () => ({
      viewport: `${other}\n› Ask Codex to do anything\n\n  ${footer}\n  ← for agents · ? for shortcuts`,
      cursor: { x: 2, y: 1 },
    });
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
    expect(codexTerminalSessionIsBound(t.pty, sid)).toBe(false);
  });

  it.each([
    { line: '› draft at Home', x: 2, y: 0 },
    { line: '› draft', x: 7, y: 0 },
    { line: '› first line\n  second line', x: 13, y: 1 },
    { line: '› 1. Update now', x: 2, y: 0 },
  ])('does not bind or configure while the composer contains a draft or picker: %s', async ({ line, x, y }) => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.pty.captureInputState = () => ({
      viewport: `${line}\n\n  GPT-6 · ${sid}\n  ← for agents · ? for shortcuts`,
      cursor: { x, y },
    });
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
    expect(prepareCodexTerminalStatusLine(t.pty)).toBeUndefined();
    expect(ensureCodexStatusLineConfig).not.toHaveBeenCalled();
  });

  it.each([
    `\n\n\n\n  ${sid}`,
    `\n  ${sid}\n  arbitrary transcript row`,
    `\n  ${sid}\n  ← for agents\n  extra row`,
    `\n  ${sid}\n  ← for agents · ${other}`,
  ])('rejects misplaced, ambiguous, or unrecognized footer rows: %s', async (below) => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.pty.captureInputState = () => ({ viewport: `› Ask Codex to do anything\n${below}`, cursor: { x: 2, y: 0 } });
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
  });

  it('preserves legacy behavior when rollout enumeration is unavailable', async () => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(undefined);
    const t = terminal('');
    t.pty.captureInputState = vi.fn();
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'legacy' });
    expect(t.pty.captureInputState).not.toHaveBeenCalled();
  });

  it('reads a captured macOS inline footer including native agent hints', async () => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.pty.captureInputState = () => ({
      viewport: readFileSync(new URL('./fixtures/codex-footer-inline.txt', import.meta.url), 'utf8'),
      cursor: { x: 2, y: 2 },
    });
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'terminal', sessionId: sid });
  });

  it('reads an empty resumed composer with the ID at the end', async () => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.pty.captureInputState = () => ({
      viewport: `› \n\n  GPT-6 · ${sid}\n  ? for shortcuts`,
      cursor: { x: 2, y: 0 },
    });
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'terminal', sessionId: sid });
  });

  it('keeps legacy PID ownership without querying the terminal', async () => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(new Set([sid]));
    const t = terminal();
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'legacy' });
    expect(t.sendText).not.toHaveBeenCalled();
  });

  it('reads ANSI-colored thread IDs while a task is running', async () => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.pty.captureInputState = () => ({
      viewport: `Working · esc to interrupt\n› Ask Codex to do anything\n\n  \x1b[32m${sid}\x1b[0m · GPT-6 · Context 79% used`,
      cursor: { x: 2, y: 1 },
    });
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'terminal', sessionId: sid });
    expect(t.sendText).not.toHaveBeenCalled();
  });

  it('does not mistake loading mentioned in conversation text for a startup screen', async () => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.pty.captureInputState = () => ({
      viewport: `The loading, Queued for capacity, and Resuming session states are documented here.\n› Ask Codex to do anything\n\n  ${sid} · GPT-6 · Context 79% used`,
      cursor: { x: 2, y: 1 },
    });
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'terminal', sessionId: sid });
    expect(t.sendText).not.toHaveBeenCalled();
  });

  it.each(['│ model: loading │', '│ directory: loading │', '• Queued for capacity', '• Resuming session'])('rejects native pending state %s even with a footer', async (row) => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.pty.captureInputState = () => ({
      viewport: `${row}\n› Ask Codex to do anything\n\n  ${sid} · GPT-6 · Context 79% used`,
      cursor: { x: 2, y: 1 },
    });
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
    expect(t.sendText).not.toHaveBeenCalled();
  });

  it('does not infer a thread from transcript UUIDs, truncated IDs, or ambiguous footer segments', async () => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(new Set());
    for (const footer of [
      'GPT-6 · Context 79% used',
      `${sid.slice(0, 20)}… · GPT-6 · Context 79% used`,
      `${sid} · ${other} · GPT-6 · Context 79% used`,
      `project-${sid} · GPT-6 · Context 79% used`,
    ]) {
      const t = terminal();
      t.pty.captureInputState = () => ({
        viewport: `${sid}\n› Ask Codex to do anything\n\n  ${footer}`,
        cursor: { x: 2, y: 1 },
      });
      expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
      expect(t.sendText).not.toHaveBeenCalled();
      expect(t.sendSpecialKeys).not.toHaveBeenCalled();
      expect(codexTerminalSessionIsBound(t.pty, sid)).toBe(false);
    }
  });

  it('binds the exact pane when its daemon owns the rollout instead of the TUI', async () => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(new Set());
    const a = terminal();
    const b = terminal(other);
    expect(await refreshCodexTerminalSession(a.pty)).toEqual({ kind: 'terminal', sessionId: sid });
    expect(await refreshCodexTerminalSession(b.pty)).toEqual({ kind: 'terminal', sessionId: other });
    expect(a.sendText).not.toHaveBeenCalled();
    expect(a.sendSpecialKeys).not.toHaveBeenCalled();
    expect(codexTerminalSessionIsBound(a.pty, sid)).toBe(true);
    expect(codexTerminalSessionIsBound(a.pty, other)).toBe(false);
    expect(codexTerminalSessionIsBound(b.pty, sid)).toBe(false);
  });

  it('never types a query into a draft, picker, busy screen, or unknown screen', async () => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(new Set());
    for (const line of ['› my draft', '› 1. Update now', 'Working · esc to interrupt', '']) {
      const t = terminal();
      t.pty.captureInputState = () => ({ viewport: line, cursor: { x: 2, y: 0 } });
      expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
      expect(t.sendText).not.toHaveBeenCalled();
    }
  });

  it('invalidates a prior binding before a failed refresh or PID replacement', async () => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    await refreshCodexTerminalSession(t.pty);
    t.pty.cliPid = 123;
    expect(codexTerminalSessionIsBound(t.pty, sid)).toBe(false);
    t.pty.cliPid = 43212;
    t.pty.captureInputState = () => null;
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
    expect(codexTerminalSessionIsBound(t.pty, sid)).toBe(false);
  });

  it('ignores old status cards in scrollback when the footer ID is missing', async () => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal('');
    t.setScreen(card(other));
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
    expect(codexTerminalSessionIsBound(t.pty, other)).toBe(false);
    expect(t.sendText).not.toHaveBeenCalled();
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('reads the footer without requiring terminal write or scrollback capabilities', async () => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    delete t.pty.sendText;
    delete t.pty.sendSpecialKeys;
    delete t.pty.captureCurrentScreen;
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'terminal', sessionId: sid });
    expect(t.pty.write).not.toHaveBeenCalled();
  });

  it('preserves explicitly selected app-server identity without reading the footer', async () => {
    const t = terminal();
    t.pty.expectedCodexSessionId = other;
    t.pty.captureInputState = vi.fn();
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'legacy' });
    expect(t.pty.captureInputState).not.toHaveBeenCalled();
    expect(t.sendText).not.toHaveBeenCalled();
  });
});


describe('Codex terminal statusline setup', () => {
  it('configures once but still requires the running TUI to expose the ID before binding', async () => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(new Set());
    vi.mocked(codexConfigPathForPid).mockReturnValue('/custom/config.toml');
    vi.mocked(ensureCodexStatusLineConfig).mockReturnValue({ kind: 'updated', configPath: '/custom/config.toml' });
    const t = terminal('');
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
    expect(prepareCodexTerminalStatusLine(t.pty)?.kind).toBe('updated');
    expect(prepareCodexTerminalStatusLine(t.pty)?.kind).toBe('updated');
    expect(ensureCodexStatusLineConfig).toHaveBeenCalledTimes(1);
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
    expect(codexTerminalSessionIsBound(t.pty, sid)).toBe(false);
    t.pty.captureInputState = () => ({ viewport: `\n› Ask Codex to do anything\n\n  ${sid}`, cursor: { x: 2, y: 1 } });
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'terminal', sessionId: sid });
    expect(prepareCodexTerminalStatusLine(t.pty)).toBeUndefined();
    expect(t.sendText).not.toHaveBeenCalled();
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('does not alter config for visible IDs, drafts, or unknown layouts', () => {
    const t = terminal();
    expect(prepareCodexTerminalStatusLine(t.pty)).toBeUndefined();
    t.pty.captureInputState = () => ({ viewport: '› draft', cursor: { x: 2, y: 0 } });
    expect(prepareCodexTerminalStatusLine(t.pty)).toBeUndefined();
    expect(codexConfigPathForPid).not.toHaveBeenCalled();
    expect(ensureCodexStatusLineConfig).not.toHaveBeenCalled();
  });

  it('does not guess another config path when process inspection fails', () => {
    const t = terminal('');
    expect(prepareCodexTerminalStatusLine(t.pty)).toEqual({ kind: 'failed' });
    expect(ensureCodexStatusLineConfig).not.toHaveBeenCalled();
  });

  it('retries failed edits and invalidates the cached setup after PID replacement', () => {
    const t = terminal('');
    vi.mocked(codexConfigPathForPid).mockReturnValue('/custom/config.toml');
    vi.mocked(ensureCodexStatusLineConfig)
      .mockReturnValueOnce({ kind: 'failed', configPath: '/custom/config.toml' })
      .mockReturnValue({ kind: 'configured', configPath: '/custom/config.toml' });
    expect(prepareCodexTerminalStatusLine(t.pty)?.kind).toBe('failed');
    expect(prepareCodexTerminalStatusLine(t.pty)?.kind).toBe('configured');
    t.pty.cliPid = 1000;
    expect(prepareCodexTerminalStatusLine(t.pty)?.kind).toBe('configured');
    expect(ensureCodexStatusLineConfig).toHaveBeenCalledTimes(3);
  });

  it('falls back to legacy mode for owned sessions (isAdopt === false) when statusline thread ID is absent', async () => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal('');
    t.pty.isAdopt = false;
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'legacy' });
    expect(prepareCodexTerminalStatusLine(t.pty)).toBeUndefined();
    expect(ensureCodexStatusLineConfig).not.toHaveBeenCalled();
  });

  it('still uses visible footer thread ID for owned sessions when present', async () => {
    vi.mocked(findCodexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.pty.isAdopt = false;
    expect(await refreshCodexTerminalSession(t.pty)).toEqual({ kind: 'terminal', sessionId: sid });
  });
});
