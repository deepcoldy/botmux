/**
 * Unit tests for CLI adapter writeInput() — verifies correct PtyHandle
 * method calls for each adapter in tmux vs non-tmux mode.
 *
 * Actual behavior (not the intended/ideal design):
 * - Claude Code (tmux): types content like a human via sendText, replacing
 *   each \n with a `\` + Enter pair (Claude Code's documented soft-newline
 *   idiom). Final Enter submits. Sidesteps tmux bracketed-paste mode, which
 *   was unreliable: Claude Code can toggle it off mid-session and turn pasted
 *   newlines into separate submits.
 * - Claude Code (raw PTY): keeps the explicit \x1b[200~...\x1b[201~ wrapping
 *   since we control the markers directly there.
 * - All other adapters (Aiden/CoCo/Codex/Gemini/OpenCode): use plain
 *   sendText + Enter in tmux, or write(content) + \r in raw mode. The whole
 *   content (including newlines) is sent in one sendText call — tmux
 *   `send-keys -l` preserves LF, and CoCo/others treat LF as a newline, not
 *   submit (Enter/CR is what triggers submit).
 *
 * Run:  pnpm vitest run test/write-input.test.ts
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const memfs = await import('memfs');
  return memfs.fs;
});

import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { createAidenAdapter } from '../src/adapters/cli/aiden.js';
import { createCocoAdapter } from '../src/adapters/cli/coco.js';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { createGeminiAdapter } from '../src/adapters/cli/gemini.js';
import { createOpenCodeAdapter } from '../src/adapters/cli/opencode.js';
import type { CliAdapter, PtyHandle } from '../src/adapters/cli/types.js';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CODEX_HISTORY_PATH = join(homedir(), '.codex', 'history.jsonl');

function appendCodexHistory(content: string): void {
  mkdirSync(dirname(CODEX_HISTORY_PATH), { recursive: true });
  appendFileSync(CODEX_HISTORY_PATH, JSON.stringify({ text: content }) + '\n');
}

function resetCodexHistory(): void {
  mkdirSync(dirname(CODEX_HISTORY_PATH), { recursive: true });
  writeFileSync(CODEX_HISTORY_PATH, '');
}

function makeTmuxPty(opts?: { confirmCodexSubmit?: boolean }) {
  const confirmCodexSubmit = opts?.confirmCodexSubmit ?? true;
  let submittedText = '';
  return {
    write: vi.fn(),
    sendText: vi.fn((text: string) => { submittedText = text; }),
    sendSpecialKeys: vi.fn((key: string) => {
      if (confirmCodexSubmit && key === 'Enter') appendCodexHistory(submittedText);
    }),
    pasteText: vi.fn((text: string) => { submittedText = text; }),
  } satisfies PtyHandle;
}

function makeRawPty(opts?: { confirmCodexSubmit?: boolean }) {
  const confirmCodexSubmit = opts?.confirmCodexSubmit ?? true;
  let submittedText = '';
  return {
    write: vi.fn((data: string) => {
      if (data === '\r') {
        if (confirmCodexSubmit) appendCodexHistory(submittedText);
        return;
      }
      if (data.endsWith('\r')) {
        submittedText += data.slice(0, -1);
        if (confirmCodexSubmit) appendCodexHistory(submittedText);
        return;
      }
      submittedText += data;
    }),
  } satisfies PtyHandle;
}

type AdapterEntry = [string, CliAdapter];

/** Adapters that use plain sendText+Enter (tmux) / write+CR (raw) — i.e. everyone except Claude Code. */
const PLAIN_ADAPTERS: AdapterEntry[] = [
  ['aiden', createAidenAdapter('/bin/aiden')],
  ['coco', createCocoAdapter('/bin/coco')],
  ['codex', createCodexAdapter('/bin/codex')],
  ['gemini', createGeminiAdapter('/bin/gemini')],
  ['opencode', createOpenCodeAdapter('/bin/opencode')],
];

const ALL_ADAPTERS: AdapterEntry[] = [
  ['claude-code', createClaudeCodeAdapter('/bin/claude')],
  ...PLAIN_ADAPTERS,
];

// =========================================================================
// 1. Single-line content
// =========================================================================

describe('writeInput: single-line, tmux mode', () => {
  it.each(PLAIN_ADAPTERS)('%s: sendText + Enter', async (_name, adapter) => {
    const pty = makeTmuxPty();
    await adapter.writeInput(pty, 'hello world');
    expect(pty.sendText).toHaveBeenCalledWith('hello world');
    expect(pty.sendSpecialKeys).toHaveBeenCalledWith('Enter');
    expect(pty.pasteText).not.toHaveBeenCalled();
  });

  it('claude-code: sendText + Enter (human-typing, no pasteText)', async () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    const pty = makeTmuxPty();
    await adapter.writeInput(pty, 'hello world');
    expect(pty.sendText).toHaveBeenCalledWith('hello world');
    expect(pty.sendSpecialKeys).toHaveBeenCalledWith('Enter');
    expect(pty.pasteText).not.toHaveBeenCalled();
  });
});

describe('writeInput: single-line, non-tmux mode', () => {
  it.each(PLAIN_ADAPTERS)('%s: write(content) + CR', async (_name, adapter) => {
    const pty = makeRawPty();
    await adapter.writeInput(pty, 'hello world');
    const allWritten = pty.write.mock.calls.map(c => c[0]).join('');
    expect(allWritten).toBe('hello world\r');
  });

  it('claude-code: wraps in bracketed paste + CR', async () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    const pty = makeRawPty();
    await adapter.writeInput(pty, 'hello world');
    const allWritten = pty.write.mock.calls.map(c => c[0]).join('');
    expect(allWritten).toContain('\x1b[200~');
    expect(allWritten).toContain('hello world');
    expect(allWritten).toContain('\x1b[201~');
    expect(allWritten.endsWith('\r')).toBe(true);
  });
});

// =========================================================================
// 2. Multiline content
//    - Claude Code: pasteText with the whole string
//    - Others: sendText with the whole string (including \n) — tmux
//      `send-keys -l` passes LF literally, and these CLIs treat LF as a
//      newline (not submit). Only the trailing Enter submits.
// =========================================================================

const MULTILINE = 'first line\n\nSession ID: abc-123';

describe('writeInput: multiline, tmux mode', () => {
  it.each(PLAIN_ADAPTERS)('%s: sendText(whole) + Enter, no pasteText', async (_name, adapter) => {
    const pty = makeTmuxPty();
    await adapter.writeInput(pty, MULTILINE);
    expect(pty.sendText).toHaveBeenCalledWith(MULTILINE);
    expect(pty.sendSpecialKeys).toHaveBeenCalledWith('Enter');
    expect(pty.pasteText).not.toHaveBeenCalled();
  });

  it('claude-code: sendText per-line + `\\` + Enter for soft newlines, no pasteText', async () => {
    // 'first line\n\nSession ID: abc-123' splits into 3 lines: non-empty, empty, non-empty.
    // Expected calls (in order):
    //   sendText('first line'), sendText('\\'), sendSpecialKeys('Enter')   ← soft-newline 1
    //   sendText('\\'), sendSpecialKeys('Enter')                            ← soft-newline 2 (skip empty content)
    //   sendText('Session ID: abc-123'), sendSpecialKeys('Enter')           ← submit
    const adapter = createClaudeCodeAdapter('/bin/claude');
    const pty = makeTmuxPty();
    await adapter.writeInput(pty, MULTILINE);
    expect(pty.pasteText).not.toHaveBeenCalled();
    expect(pty.sendText).toHaveBeenCalledWith('first line');
    expect(pty.sendText).toHaveBeenCalledWith('Session ID: abc-123');
    const backslashCalls = pty.sendText.mock.calls.filter(c => c[0] === '\\').length;
    expect(backslashCalls).toBe(2);
    expect(pty.sendSpecialKeys).toHaveBeenLastCalledWith('Enter');
  });
});

describe('writeInput: multiline, non-tmux mode', () => {
  it.each(PLAIN_ADAPTERS)('%s: write(content) + CR', async (_name, adapter) => {
    const pty = makeRawPty();
    await adapter.writeInput(pty, MULTILINE);
    const allWritten = pty.write.mock.calls.map(c => c[0]).join('');
    expect(allWritten).toBe(MULTILINE + '\r');
  });

  it('claude-code: wraps in bracketed paste + CR', async () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    const pty = makeRawPty();
    await adapter.writeInput(pty, MULTILINE);
    const allWritten = pty.write.mock.calls.map(c => c[0]).join('');
    expect(allWritten).toContain('\x1b[200~');
    expect(allWritten).toContain(MULTILINE);
    expect(allWritten).toContain('\x1b[201~');
    expect(allWritten.endsWith('\r')).toBe(true);
  });
});

describe('writeInput: multiline preserves unicode and session IDs', () => {
  it.each(PLAIN_ADAPTERS)('%s: content round-trips intact in one sendText (tmux)', async (_name, adapter) => {
    const pty = makeTmuxPty();
    const followUp = '帮我看看\n\nSession ID: dece91fd-abc';
    await adapter.writeInput(pty, followUp);

    const payloads = [
      ...pty.sendText.mock.calls.map(c => c[0]),
      ...pty.pasteText.mock.calls.map(c => c[0]),
    ];
    expect(payloads).toContain(followUp);
    expect(pty.sendSpecialKeys).toHaveBeenLastCalledWith('Enter');
  });

  it('claude-code: each non-empty line round-trips via sendText (tmux)', async () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    const pty = makeTmuxPty();
    const followUp = '帮我看看\n\nSession ID: dece91fd-abc';
    await adapter.writeInput(pty, followUp);

    expect(pty.sendText).toHaveBeenCalledWith('帮我看看');
    expect(pty.sendText).toHaveBeenCalledWith('Session ID: dece91fd-abc');
    expect(pty.sendSpecialKeys).toHaveBeenLastCalledWith('Enter');
  });
});

// =========================================================================
// 3. supportsTypeAhead flag
// =========================================================================

describe('supportsTypeAhead flag', () => {
  it('claude-code: true', () => {
    expect(createClaudeCodeAdapter('/bin/claude').supportsTypeAhead).toBe(true);
  });

  it.each(PLAIN_ADAPTERS)('%s: undefined (default behavior)', (_name, adapter) => {
    expect(adapter.supportsTypeAhead).toBeUndefined();
  });
});

// =========================================================================
// 4. Edge cases
// =========================================================================

describe('writeInput: edge cases', () => {
  it.each(ALL_ADAPTERS)('%s: empty string still submits Enter (tmux)', async (_name, adapter) => {
    const pty = makeTmuxPty();
    await adapter.writeInput(pty, '');
    expect(pty.sendSpecialKeys).toHaveBeenCalledWith('Enter');
  });

  it('claude-code: image path in multiline still types via sendText', async () => {
    const pty = makeTmuxPty();
    const adapter = createClaudeCodeAdapter('/bin/claude');
    await adapter.writeInput(pty, 'check /tmp/a.png\n\nSession ID: x');
    expect(pty.pasteText).not.toHaveBeenCalled();
    expect(pty.sendText).toHaveBeenCalledWith('check /tmp/a.png');
    expect(pty.sendText).toHaveBeenCalledWith('Session ID: x');
    expect(pty.sendSpecialKeys).toHaveBeenLastCalledWith('Enter');
  });
});

describe('codex writeInput submission confirmation', () => {
  it('confirms a multiline submit when history.jsonl appends the escaped prompt marker', async () => {
    resetCodexHistory();
    const pty = makeTmuxPty();
    const adapter = createCodexAdapter('/bin/codex');
    const result = await adapter.writeInput(pty, MULTILINE);

    expect(result).toBeUndefined();
    expect(pty.sendText).toHaveBeenCalledWith(MULTILINE);
    expect(pty.sendSpecialKeys).toHaveBeenCalledTimes(1);
    expect(pty.sendSpecialKeys).toHaveBeenCalledWith('Enter');
  });

  it('retries Enter and reports failure when history.jsonl never records the prompt', async () => {
    resetCodexHistory();
    const pty = makeTmuxPty({ confirmCodexSubmit: false });
    const adapter = createCodexAdapter('/bin/codex');
    const result = await adapter.writeInput(pty, MULTILINE);

    expect(result).toEqual({ submitted: false });
    expect(pty.sendText).toHaveBeenCalledWith(MULTILINE);
    expect(pty.sendSpecialKeys).toHaveBeenCalledTimes(4);
  });
});
