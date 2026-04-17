/**
 * Unit tests for CLI adapter writeInput() — verifies correct PtyHandle
 * method calls for each adapter in tmux vs non-tmux mode.
 *
 * Actual behavior (not the intended/ideal design):
 * - Claude Code: always uses pasteText (bracketed paste) so the paste-burst
 *   heuristic doesn't swallow a trailing Enter.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmuxPty() {
  return {
    write: vi.fn(),
    sendText: vi.fn(),
    sendSpecialKeys: vi.fn(),
    pasteText: vi.fn(),
  } satisfies PtyHandle;
}

function makeRawPty() {
  return { write: vi.fn() } satisfies PtyHandle;
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

  it('claude-code: pasteText + Enter (bracketed paste)', async () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    const pty = makeTmuxPty();
    await adapter.writeInput(pty, 'hello world');
    expect(pty.pasteText).toHaveBeenCalledWith('hello world');
    expect(pty.sendSpecialKeys).toHaveBeenCalledWith('Enter');
    expect(pty.sendText).not.toHaveBeenCalled();
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

  it('claude-code: pasteText(whole) + Enter', async () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    const pty = makeTmuxPty();
    await adapter.writeInput(pty, MULTILINE);
    expect(pty.pasteText).toHaveBeenCalledWith(MULTILINE);
    expect(pty.sendSpecialKeys).toHaveBeenCalledWith('Enter');
    expect(pty.sendText).not.toHaveBeenCalled();
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
  it.each(ALL_ADAPTERS)('%s: content round-trips intact (tmux)', async (_name, adapter) => {
    const pty = makeTmuxPty();
    const followUp = '帮我看看\n\nSession ID: dece91fd-abc';
    await adapter.writeInput(pty, followUp);

    // Whichever method is used, the full content should appear in exactly one call.
    const payloads = [
      ...pty.sendText.mock.calls.map(c => c[0]),
      ...pty.pasteText.mock.calls.map(c => c[0]),
    ];
    expect(payloads).toContain(followUp);
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

  it('claude-code: image path in multiline uses pasteText', async () => {
    const pty = makeTmuxPty();
    const adapter = createClaudeCodeAdapter('/bin/claude');
    await adapter.writeInput(pty, 'check /tmp/a.png\n\nSession ID: x');
    expect(pty.pasteText).toHaveBeenCalled();
    expect(pty.sendSpecialKeys).toHaveBeenCalledWith('Enter');
  });
});
