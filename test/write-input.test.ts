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
 * - CoCo (tmux): single pasteText with whole content + delayed Enter — tmux
 *   `load-buffer` + `paste-buffer -d` wraps in bracketed paste markers when
 *   the pane has them on (Ink default). PR #4 / 59afae5 (May 2026) moved
 *   off the per-line typing model that claude-code uses: Trae CLI 0.120.31
 *   fresh-spawn treated the rapid send-keys -l burst as an open-ended paste
 *   and swallowed the trailing Enter as a soft-newline, stranding the
 *   message in the input box. Submit is verified via CoCo's platform-specific
 *   history.jsonl.
 * - CoCo (raw PTY): same explicit \x1b[200~...\x1b[201~ wrap as claude-code.
 * - Other adapters (Aiden/Codex/Gemini/OpenCode): use plain sendText + Enter
 *   in tmux, or write(content) + \r in raw mode. The whole content (including
 *   newlines) is sent in one sendText call — those CLIs tolerate raw LF.
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
import { createMtrAdapter } from '../src/adapters/cli/mtr.js';
import { createHermesAdapter } from '../src/adapters/cli/hermes.js';
import { createMiraAdapter } from '../src/adapters/cli/mira.js';
import type { CliAdapter, PtyHandle } from '../src/adapters/cli/types.js';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { codexHistoryPath } from '../src/services/codex-paths.js';

// ── Speed: collapse the adapters' real-time submit waits ───────────────────
// writeInput()'s submit-confirmation polls the (memfs-mocked, synchronous)
// history/transcript with real wall-clock budgets — ~0.5–3s per case across
// 90+ tests, which made this the single slowest file in the whole suite.
// BOTMUX_TIME_SCALE (read lazily by src/utils/timing.ts) shrinks every
// delay/poll budget by this factor WITHOUT changing which branch the code
// takes: memfs writes are synchronous, so the submit marker is already present
// the instant the poll starts. The few tests that choreograph their OWN
// real-time events (a transcript append fired on a timer) scale those delays by
// TIME_SCALE as well, so the relative ordering against the (now shrunken) poll
// budget is preserved.
// Default to 0.1, but honor an externally-set BOTMUX_TIME_SCALE so the
// benchmark (scripts/bench-tests.ts) can measure the un-scaled "before" timing
// by exporting BOTMUX_TIME_SCALE=1. TIME_SCALE always reflects the *effective*
// scale, so the choreographed delay below stays consistent with the adapter's
// (equally scaled) confirm budget.
process.env.BOTMUX_TIME_SCALE ??= '0.05';
const TIME_SCALE = Number(process.env.BOTMUX_TIME_SCALE);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COCO_HISTORY_PATH = platform() === 'darwin'
  ? join(homedir(), 'Library', 'Caches', 'coco', 'history.jsonl')
  : join(homedir(), '.cache', 'coco', 'history.jsonl');
const CLAUDE_KEYBINDINGS_PATH = join(homedir(), '.claude', 'keybindings.json');

function appendCodexHistory(content: string, sessionId?: string): void {
  const path = codexHistoryPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({ session_id: sessionId, text: content }) + '\n');
}

function resetCodexHistory(): void {
  const path = codexHistoryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
}

function appendCocoHistory(content: string): void {
  mkdirSync(dirname(COCO_HISTORY_PATH), { recursive: true });
  appendFileSync(COCO_HISTORY_PATH, JSON.stringify({ content, mode: 'user', timestamp: new Date().toISOString() }) + '\n');
}

function resetCocoHistory(): void {
  mkdirSync(dirname(COCO_HISTORY_PATH), { recursive: true });
  writeFileSync(COCO_HISTORY_PATH, '');
}

function writeClaudeKeybindings(bindings: Record<string, string>): void {
  mkdirSync(dirname(CLAUDE_KEYBINDINGS_PATH), { recursive: true });
  writeFileSync(CLAUDE_KEYBINDINGS_PATH, JSON.stringify({
    bindings: [{ context: 'Chat', bindings }],
  }));
}

function removeClaudeKeybindings(): void {
  try { rmSync(CLAUDE_KEYBINDINGS_PATH); } catch { /* absent */ }
}

function makeTmuxPty(opts?: { confirmCodexSubmit?: boolean; codexSessionId?: string }) {
  const confirmCodexSubmit = opts?.confirmCodexSubmit ?? true;
  let submittedText = '';
  return {
    write: vi.fn(),
    sendText: vi.fn((text: string) => { submittedText = text; }),
    sendSpecialKeys: vi.fn((key: string) => {
      if (confirmCodexSubmit && key === 'Enter') appendCodexHistory(submittedText, opts?.codexSessionId);
    }),
    pasteText: vi.fn((text: string) => { submittedText = text; }),
  } satisfies PtyHandle;
}

function makeRawPty(opts?: { confirmCodexSubmit?: boolean; codexSessionId?: string }) {
  const confirmCodexSubmit = opts?.confirmCodexSubmit ?? true;
  let submittedText = '';
  return {
    write: vi.fn((data: string) => {
      if (data === '\r') {
        if (confirmCodexSubmit) appendCodexHistory(submittedText, opts?.codexSessionId);
        return;
      }
      if (data.endsWith('\r')) {
        submittedText += data.slice(0, -1);
        if (confirmCodexSubmit) appendCodexHistory(submittedText, opts?.codexSessionId);
        return;
      }
      submittedText += data;
    }),
  } satisfies PtyHandle;
}

type AdapterEntry = [string, CliAdapter];

/** Adapters that use plain sendText+Enter (tmux) / write+CR (raw) — Aiden,
 *  Gemini, OpenCode, MTR, Hermes. (Codex moved to PASTE_BUFFER_ADAPTERS: its
 *  TUI treats every literal \n as Enter, so a multi-line burst fragmented into
 *  per-line submits / "Queued follow-up inputs" — bracketed paste fixes it.) */
const PLAIN_ADAPTERS: AdapterEntry[] = [
  ['aiden', createAidenAdapter('/bin/aiden')],
  ['gemini', createGeminiAdapter('/bin/gemini')],
  ['opencode', createOpenCodeAdapter('/bin/opencode')],
  ['mtr', createMtrAdapter('/bin/mtr')],
  ['hermes', createHermesAdapter('/bin/hermes')],
];

/** Node runner adapters use a one-line base64 control protocol so multiline
 *  content cannot be split by terminal Enter semantics. */
const APP_RUNNER_ADAPTERS: AdapterEntry[] = [
  ['mira', createMiraAdapter()],
];

/** Adapters that type per-line + `\` soft-newline + Enter (Claude Code idiom). */
const HUMAN_TYPING_ADAPTERS: AdapterEntry[] = [
  ['claude-code', createClaudeCodeAdapter('/bin/claude')],
];

/** Adapters that use tmux pasteText (load-buffer + paste-buffer -d) with
 *  delayed Enter — CoCo / Trae CLI and Codex. See coco.ts for the Trae 0.120.31
 *  burst bug, and codex.ts for the per-line-submit bug bracketed paste fixes
 *  (Codex 0.134+ handles bracketed paste correctly — the old "Codex exits on
 *  bracketed paste" note was true only for a much earlier build). */
const PASTE_BUFFER_ADAPTERS: AdapterEntry[] = [
  ['coco', createCocoAdapter('/bin/coco')],
  ['codex', createCodexAdapter('/bin/codex')],
];

/** Adapters that wrap content in bracketed-paste markers (\x1b[200~ ... \x1b[201~)
 *  in non-tmux mode — claude-code and coco. */
const BRACKETED_PASTE_FALLBACK_ADAPTERS: AdapterEntry[] = [
  ...HUMAN_TYPING_ADAPTERS,
  ...PASTE_BUFFER_ADAPTERS,
];

const ALL_ADAPTERS: AdapterEntry[] = [
  ...HUMAN_TYPING_ADAPTERS,
  ...PASTE_BUFFER_ADAPTERS,
  ...PLAIN_ADAPTERS,
  ...APP_RUNNER_ADAPTERS,
];

function decodeRunnerLine(line: string, prefix: string): any {
  expect(line.startsWith(prefix)).toBe(true);
  const encoded = line.slice(prefix.length).replace(/\r$/, '');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

// =========================================================================
// 1. Single-line content
// =========================================================================

describe('writeInput: single-line, tmux mode', () => {
  it.each([...HUMAN_TYPING_ADAPTERS, ...PLAIN_ADAPTERS])('%s: sendText + Enter, no pasteText', async (_name, adapter) => {
    const pty = makeTmuxPty();
    await adapter.writeInput(pty, 'hello world');
    expect(pty.sendText).toHaveBeenCalledWith('hello world');
    expect(pty.sendSpecialKeys).toHaveBeenCalledWith('Enter');
    expect(pty.pasteText).not.toHaveBeenCalled();
  });

  it.each(PASTE_BUFFER_ADAPTERS)('%s: pasteText + delayed Enter, no sendText', async (_name, adapter) => {
    const pty = makeTmuxPty();
    await adapter.writeInput(pty, 'hello world');
    expect(pty.pasteText).toHaveBeenCalledWith('hello world');
    expect(pty.sendSpecialKeys).toHaveBeenCalledWith('Enter');
    expect(pty.sendText).not.toHaveBeenCalled();
  });

  it.each(APP_RUNNER_ADAPTERS)('%s: sends a base64 runner control line + Enter', async (_name, adapter) => {
    const pty = makeTmuxPty();
    await adapter.writeInput(pty, 'hello world');
    const line = pty.sendText.mock.calls[0]?.[0] ?? '';
    expect(decodeRunnerLine(line, '::botmux-mira:')).toEqual({ type: 'message', content: 'hello world' });
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

  it.each(BRACKETED_PASTE_FALLBACK_ADAPTERS)('%s: wraps in bracketed paste + CR', async (_name, adapter) => {
    const pty = makeRawPty();
    await adapter.writeInput(pty, 'hello world');
    const allWritten = pty.write.mock.calls.map(c => c[0]).join('');
    expect(allWritten).toContain('\x1b[200~');
    expect(allWritten).toContain('hello world');
    expect(allWritten).toContain('\x1b[201~');
    expect(allWritten.endsWith('\r')).toBe(true);
  });

  it.each(APP_RUNNER_ADAPTERS)('%s: writes a base64 runner control line + CR', async (_name, adapter) => {
    const pty = makeRawPty();
    await adapter.writeInput(pty, 'hello world');
    const allWritten = pty.write.mock.calls.map(c => c[0]).join('');
    expect(decodeRunnerLine(allWritten, '::botmux-mira:')).toEqual({ type: 'message', content: 'hello world' });
    expect(allWritten.endsWith('\r')).toBe(true);
  });
});

// =========================================================================
// 2. Multiline content
//    - Claude Code / CoCo / Codex: bracketed paste (pasteText) with the whole
//      string — the embedded \n stay content, only the trailing Enter submits.
//    - PLAIN adapters (Aiden/Gemini/OpenCode/MTR/Hermes): sendText with the
//      whole string (including \n) — those CLIs treat literal LF as a newline,
//      not a submit, so only the trailing Enter submits.
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

  it.each(APP_RUNNER_ADAPTERS)('%s: preserves multiline content inside the control payload', async (_name, adapter) => {
    const pty = makeTmuxPty();
    await adapter.writeInput(pty, MULTILINE);
    const line = pty.sendText.mock.calls[0]?.[0] ?? '';
    expect(decodeRunnerLine(line, '::botmux-mira:')).toEqual({ type: 'message', content: MULTILINE });
    expect(pty.sendSpecialKeys).toHaveBeenCalledWith('Enter');
    expect(pty.pasteText).not.toHaveBeenCalled();
  });

  it.each(HUMAN_TYPING_ADAPTERS)('%s: sendText per-line + `\\` + Enter for soft newlines, no pasteText', async (_name, adapter) => {
    // 'first line\n\nSession ID: abc-123' splits into 3 lines: non-empty, empty, non-empty.
    // Expected calls (in order):
    //   sendText('first line'), sendText('\\'), sendSpecialKeys('Enter')   ← soft-newline 1
    //   sendText('\\'), sendSpecialKeys('Enter')                            ← soft-newline 2 (skip empty content)
    //   sendText('Session ID: abc-123'), sendSpecialKeys('Enter')           ← submit
    const pty = makeTmuxPty();
    await adapter.writeInput(pty, MULTILINE);
    expect(pty.pasteText).not.toHaveBeenCalled();
    expect(pty.sendText).toHaveBeenCalledWith('first line');
    expect(pty.sendText).toHaveBeenCalledWith('Session ID: abc-123');
    const backslashCalls = pty.sendText.mock.calls.filter(c => c[0] === '\\').length;
    expect(backslashCalls).toBe(2);
    expect(pty.sendSpecialKeys).toHaveBeenLastCalledWith('Enter');
  });

  it('claude-code: respects custom chat keybindings where Enter is newline and Meta+Enter submits', async () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    writeClaudeKeybindings({
      'cmd+enter': 'chat:submit',
      'meta+enter': 'chat:submit',
      enter: 'chat:newline',
    });
    try {
      const pty = makeTmuxPty();
      await adapter.writeInput(pty, MULTILINE);

      expect(pty.pasteText).not.toHaveBeenCalled();
      expect(pty.sendText).toHaveBeenCalledWith('first line');
      expect(pty.sendText).toHaveBeenCalledWith('Session ID: abc-123');
      expect(pty.sendText).not.toHaveBeenCalledWith('\\');
      expect(pty.sendSpecialKeys.mock.calls).toEqual([
        ['Enter'],
        ['Enter'],
        ['M-Enter'],
      ]);
    } finally {
      removeClaudeKeybindings();
    }
  });

  it('claude-code: fails before typing when only unsupported Cmd+Enter can submit', async () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    writeClaudeKeybindings({
      'cmd+enter': 'chat:submit',
      enter: 'chat:newline',
    });
    try {
      const pty = makeTmuxPty();
      const result = await adapter.writeInput(pty, MULTILINE);

      expect(pty.pasteText).not.toHaveBeenCalled();
      expect(pty.sendText).not.toHaveBeenCalled();
      expect(pty.sendSpecialKeys).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        submitted: false,
        failureReason: expect.stringContaining('terminal-sendable'),
      });
    } finally {
      removeClaudeKeybindings();
    }
  });

  it('claude-code: fails before typing when only unsendable Ctrl+Enter can submit', async () => {
    // Terminals cannot distinguish Ctrl+Enter from Enter, so it must NOT be
    // treated as a sendable submit key — fail fast instead of phantom-submitting.
    const adapter = createClaudeCodeAdapter('/bin/claude');
    writeClaudeKeybindings({
      'ctrl+enter': 'chat:submit',
      enter: 'chat:newline',
    });
    try {
      const pty = makeTmuxPty();
      const result = await adapter.writeInput(pty, MULTILINE);

      expect(pty.sendText).not.toHaveBeenCalled();
      expect(pty.sendSpecialKeys).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        submitted: false,
        failureReason: expect.stringContaining('terminal-sendable'),
      });
    } finally {
      removeClaudeKeybindings();
    }
  });

  it('claude-code: fails before typing when Enter is newline and no submit key is bound', async () => {
    // A config that remaps Enter to newline without binding any chat:submit key
    // would otherwise type the message and emit newlines forever — fail fast.
    const adapter = createClaudeCodeAdapter('/bin/claude');
    writeClaudeKeybindings({ enter: 'chat:newline' });
    try {
      const pty = makeTmuxPty();
      const result = await adapter.writeInput(pty, MULTILINE);

      expect(pty.sendText).not.toHaveBeenCalled();
      expect(pty.sendSpecialKeys).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        submitted: false,
        failureReason: expect.stringContaining('terminal-sendable'),
      });
    } finally {
      removeClaudeKeybindings();
    }
  });

  it('claude-code: CLAUDE_CODE_SUBMIT_KEY env overrides the submit key', async () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    removeClaudeKeybindings();
    process.env.CLAUDE_CODE_SUBMIT_KEY = 'meta+enter';
    try {
      const pty = makeTmuxPty();
      await adapter.writeInput(pty, MULTILINE);

      // Enter still submits by default here, so soft-newlines stay backslashed;
      // only the final submit honours the override.
      expect(pty.sendSpecialKeys.mock.calls.at(-1)).toEqual(['M-Enter']);
    } finally {
      delete process.env.CLAUDE_CODE_SUBMIT_KEY;
    }
  });

  it.each(PASTE_BUFFER_ADAPTERS)('%s: single pasteText(whole) + delayed Enter, no sendText', async (_name, adapter) => {
    // Coco's tmux path uses load-buffer + paste-buffer -d (PtyHandle.pasteText)
    // for the whole content, then a single delayed Enter. tmux wraps in
    // bracketed-paste markers automatically when the Ink TUI has them on.
    const pty = makeTmuxPty();
    await adapter.writeInput(pty, MULTILINE);
    expect(pty.pasteText).toHaveBeenCalledWith(MULTILINE);
    expect(pty.sendText).not.toHaveBeenCalled();
    expect(pty.sendSpecialKeys).toHaveBeenCalledWith('Enter');
  });
});

describe('writeInput: multiline, non-tmux mode', () => {
  it.each(PLAIN_ADAPTERS)('%s: write(content) + CR', async (_name, adapter) => {
    const pty = makeRawPty();
    await adapter.writeInput(pty, MULTILINE);
    const allWritten = pty.write.mock.calls.map(c => c[0]).join('');
    expect(allWritten).toBe(MULTILINE + '\r');
  });

  it.each(BRACKETED_PASTE_FALLBACK_ADAPTERS)('%s: wraps in bracketed paste + CR', async (_name, adapter) => {
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

  it.each(HUMAN_TYPING_ADAPTERS)('%s: each non-empty line round-trips via sendText (tmux)', async (_name, adapter) => {
    const pty = makeTmuxPty();
    const followUp = '帮我看看\n\nSession ID: dece91fd-abc';
    await adapter.writeInput(pty, followUp);

    expect(pty.sendText).toHaveBeenCalledWith('帮我看看');
    expect(pty.sendText).toHaveBeenCalledWith('Session ID: dece91fd-abc');
    expect(pty.sendSpecialKeys).toHaveBeenLastCalledWith('Enter');
  });

  it.each(PASTE_BUFFER_ADAPTERS)('%s: whole content round-trips via pasteText intact (tmux)', async (_name, adapter) => {
    const pty = makeTmuxPty();
    const followUp = '帮我看看\n\nSession ID: dece91fd-abc';
    await adapter.writeInput(pty, followUp);

    expect(pty.pasteText).toHaveBeenCalledWith(followUp);
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

  it('coco: true (0.120.32+ parks submit-while-busy in its TUI queue, dequeues at idle)', () => {
    expect(createCocoAdapter('/bin/coco').supportsTypeAhead).toBe(true);
  });

  it('codex: true (0.134.0+ parks submit-while-busy, writes rollout user event at dequeue time)', () => {
    expect(createCodexAdapter('/bin/codex').supportsTypeAhead).toBe(true);
  });

  it.each(PLAIN_ADAPTERS.filter(([name]) => name !== 'codex'))('%s: undefined (default behavior)', (_name, adapter) => {
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

describe('claude-code writeInput submission confirmation', () => {
  function makeClaudeJsonlPaths(prefix: string): { oldPath: string; newPath: string } {
    const projectDir = join(homedir(), '.claude', 'projects', `-${prefix}-project`);
    mkdirSync(projectDir, { recursive: true });
    const oldPath = join(projectDir, 'old-session.jsonl');
    const newPath = join(projectDir, 'new-session.jsonl');
    writeFileSync(oldPath, '');
    return { oldPath, newPath };
  }

  function writeClaudePidFile(pid: number, body: Record<string, unknown>): void {
    const dir = join(homedir(), '.claude', 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, ...body }));
  }

  function makeJsonlForSession(prefix: string, sessionId: string, cwd: string): string {
    const projectHash = cwd.replace(/[^A-Za-z0-9-]/g, '-');
    const projectDir = join(homedir(), '.claude', 'projects', projectHash);
    mkdirSync(projectDir, { recursive: true });
    const path = join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(path, '');
    return path;
  }

  it('follows a new Claude JSONL when the submitted user event lands there', async () => {
    const { oldPath, newPath } = makeClaudeJsonlPaths('follow-user');
    const adapter = createClaudeCodeAdapter('/bin/claude');
    let wroteNewTranscript = false;
    const pty: PtyHandle = {
      claudeJsonlPath: oldPath,
      write: vi.fn(),
      sendText: vi.fn(),
      sendSpecialKeys: vi.fn((key: string) => {
        if (key !== 'Enter' || wroteNewTranscript) return;
        wroteNewTranscript = true;
        writeFileSync(
          newPath,
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello from the moved session' } }) + '\n',
        );
      }),
    };

    const result = await adapter.writeInput(pty, 'hello from the moved session');

    expect(result).toBeUndefined();
    expect(pty.claudeJsonlPath).toBe(newPath);
    expect(pty.sendSpecialKeys).toHaveBeenCalledTimes(1);
  });

  it('follows a new Claude JSONL when type-ahead is recorded as a queue enqueue', async () => {
    const { oldPath, newPath } = makeClaudeJsonlPaths('follow-queue');
    const adapter = createClaudeCodeAdapter('/bin/claude');
    let wroteNewTranscript = false;
    const pty: PtyHandle = {
      claudeJsonlPath: oldPath,
      write: vi.fn(),
      sendText: vi.fn(),
      sendSpecialKeys: vi.fn((key: string) => {
        if (key !== 'Enter' || wroteNewTranscript) return;
        wroteNewTranscript = true;
        writeFileSync(
          newPath,
          JSON.stringify({
            type: 'queue-operation',
            operation: 'enqueue',
            content: 'queued prompt after session switch',
          }) + '\n',
        );
      }),
    };

    const result = await adapter.writeInput(pty, 'queued prompt after session switch');

    expect(result).toBeUndefined();
    expect(pty.claudeJsonlPath).toBe(newPath);
    expect(pty.sendSpecialKeys).toHaveBeenCalledTimes(1);
  });

  it('pid resolver: switches to Claude\'s authoritative session JSONL on entry', async () => {
    const cwd = '/tmp/pid-resolver-happy';
    const oldSessionId = '11111111-1111-4111-8111-111111111111';
    const newSessionId = '22222222-2222-4222-8222-222222222222';
    const oldPath = makeJsonlForSession('pid-resolver-happy', oldSessionId, cwd);
    const newPath = makeJsonlForSession('pid-resolver-happy', newSessionId, cwd);
    // Pid file already points at the rotated session — entry resolver should
    // re-pin to newPath, then the simulated submit lands there.
    writeClaudePidFile(7777, { sessionId: newSessionId, cwd });

    const adapter = createClaudeCodeAdapter('/bin/claude');
    const pty: PtyHandle = {
      claudeJsonlPath: oldPath,
      cliPid: 7777,
      cliCwd: cwd,
      write: vi.fn(),
      sendText: vi.fn(),
      sendSpecialKeys: vi.fn((key: string) => {
        if (key !== 'Enter') return;
        appendFileSync(
          newPath,
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'rotated prompt body' } }) + '\n',
        );
      }),
    };

    const result = await adapter.writeInput(pty, 'rotated prompt body');

    expect(result).toEqual({ submitted: true, cliSessionId: newSessionId });
    expect(pty.claudeJsonlPath).toBe(newPath);
  });

  it('pid resolver: ignores file when cwd does not match (falls back to fingerprint)', async () => {
    const cwd = '/tmp/pid-resolver-cwd';
    const otherCwd = '/tmp/some-other-project';
    const oldSessionId = '33333333-3333-4333-8333-333333333333';
    const decoySessionId = '44444444-4444-4444-8444-444444444444';
    const oldPath = makeJsonlForSession('pid-resolver-cwd', oldSessionId, cwd);
    // pid file claims a session from a different cwd — resolver must reject it.
    writeClaudePidFile(8888, { sessionId: decoySessionId, cwd: otherCwd });

    const adapter = createClaudeCodeAdapter('/bin/claude');
    const pty: PtyHandle = {
      claudeJsonlPath: oldPath,
      cliPid: 8888,
      cliCwd: cwd,
      write: vi.fn(),
      sendText: vi.fn(),
      sendSpecialKeys: vi.fn((key: string) => {
        if (key !== 'Enter') return;
        appendFileSync(
          oldPath,
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'submit on pinned path' } }) + '\n',
        );
      }),
    };

    const result = await adapter.writeInput(pty, 'submit on pinned path');

    expect(result).toBeUndefined();
    expect(pty.claudeJsonlPath).toBe(oldPath);
  });

  it('pid resolver: accepts cwd mismatch when procStart matches (worker cliCwd drift)', async () => {
    // Failure mode this guards against: a botmux session created with
    // workingDir=A is later resumed by a scheduled task with workingDir=B
    // (e.g. an ai-news cron). Claude itself was spawned in B but the loaded
    // session retains its original cwd=A, so the pid file reports cwd=A
    // while the worker's `cliCwd` is B. With strict cwd equality the
    // resolver rejects, the pinned JSONL stays at the wrong project hash,
    // and every submit hits the 20s "submit not confirmed" warning.
    // procStart matching against /proc/<pid>/stat is the strong signal that
    // the pid file belongs to the live process, so cwd disagreement should
    // be tolerated and the pid file's cwd believed.
    const workerCwd = '/tmp/pid-resolver-cwd-drift-worker';
    const claudeCwd = '/tmp/pid-resolver-cwd-drift-claude';
    const oldSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const rotatedSessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const oldPath = makeJsonlForSession('pid-resolver-cwd-drift', oldSessionId, workerCwd);
    const rotatedPath = makeJsonlForSession('pid-resolver-cwd-drift', rotatedSessionId, claudeCwd);
    const fakePid = 31337;
    mkdirSync(`/proc/${fakePid}`, { recursive: true });
    writeFileSync(
      `/proc/${fakePid}/stat`,
      `${fakePid} (claude) S 1 1 1 0 -1 4194304 100 0 0 0 1 1 0 0 20 0 1 0 555555 12345 678 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`,
    );
    writeClaudePidFile(fakePid, {
      sessionId: rotatedSessionId,
      cwd: claudeCwd,
      procStart: '555555',
    });

    const adapter = createClaudeCodeAdapter('/bin/claude');
    const pty: PtyHandle = {
      claudeJsonlPath: oldPath,
      cliPid: fakePid,
      cliCwd: workerCwd,
      write: vi.fn(),
      sendText: vi.fn(),
      sendSpecialKeys: vi.fn((key: string) => {
        if (key !== 'Enter') return;
        appendFileSync(
          rotatedPath,
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'submit on rotated path' } }) + '\n',
        );
      }),
    };

    const result = await adapter.writeInput(pty, 'submit on rotated path');

    expect(result).toEqual({ submitted: true, cliSessionId: rotatedSessionId });
    expect(pty.claudeJsonlPath).toBe(rotatedPath);
  });

  it('pid resolver: ignores file when procStart does not match /proc/<pid>/stat', async () => {
    const cwd = '/tmp/pid-resolver-procstart';
    const oldSessionId = '55555555-5555-4555-8555-555555555555';
    const decoySessionId = '66666666-6666-4666-8666-666666666666';
    const oldPath = makeJsonlForSession('pid-resolver-procstart', oldSessionId, cwd);
    const fakePid = 42424;
    // Stage a fake /proc/<pid>/stat in the mocked fs so readProcStarttime
    // returns a starttime — procStart in the pid file deliberately differs,
    // so the resolver must reject the rotation.
    mkdirSync(`/proc/${fakePid}`, { recursive: true });
    writeFileSync(
      `/proc/${fakePid}/stat`,
      `${fakePid} (claude) S 1 1 1 0 -1 4194304 100 0 0 0 1 1 0 0 20 0 1 0 999999 12345 678 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`,
    );
    writeClaudePidFile(fakePid, { sessionId: decoySessionId, cwd, procStart: '111' });

    const adapter = createClaudeCodeAdapter('/bin/claude');
    const pty: PtyHandle = {
      claudeJsonlPath: oldPath,
      cliPid: fakePid,
      cliCwd: cwd,
      write: vi.fn(),
      sendText: vi.fn(),
      sendSpecialKeys: vi.fn((key: string) => {
        if (key !== 'Enter') return;
        appendFileSync(
          oldPath,
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'pinned despite stale procStart' } }) + '\n',
        );
      }),
    };

    const result = await adapter.writeInput(pty, 'pinned despite stale procStart');

    expect(result).toBeUndefined();
    expect(pty.claudeJsonlPath).toBe(oldPath);
  });

  it('pid resolver: re-reads pid file mid-flight when sessionId rotates between type and Enter', async () => {
    const cwd = '/tmp/pid-resolver-rotate';
    const startSessionId = '77777777-7777-4777-8777-777777777777';
    const rotatedSessionId = '88888888-8888-4888-8888-888888888888';
    const startPath = makeJsonlForSession('pid-resolver-rotate', startSessionId, cwd);
    const rotatedPath = makeJsonlForSession('pid-resolver-rotate', rotatedSessionId, cwd);
    // Initial pid file points at the starting session.
    writeClaudePidFile(9999, { sessionId: startSessionId, cwd });

    const adapter = createClaudeCodeAdapter('/bin/claude');
    const pty: PtyHandle = {
      claudeJsonlPath: startPath,
      cliPid: 9999,
      cliCwd: cwd,
      write: vi.fn(),
      sendText: vi.fn(),
      sendSpecialKeys: vi.fn((key: string) => {
        if (key !== 'Enter') return;
        // Simulate Claude rotating sessionId at submit time: the user line
        // lands in the rotated jsonl AND the pid file is updated. The
        // adapter must re-resolve and return the new id.
        writeClaudePidFile(9999, { sessionId: rotatedSessionId, cwd });
        appendFileSync(
          rotatedPath,
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'sent during rotation' } }) + '\n',
        );
      }),
    };

    const result = await adapter.writeInput(pty, 'sent during rotation');

    expect(result).toEqual({ submitted: true, cliSessionId: rotatedSessionId });
    expect(pty.claudeJsonlPath).toBe(rotatedPath);
    // Critically: the rotation must be detected on the FIRST Enter — no extra
    // retries, otherwise live users would see a multi-submit duplicate.
    expect(pty.sendSpecialKeys).toHaveBeenCalledTimes(1);
  });

  it('pid resolver: polls rotated JSONL from its own baseline when append follows pid update', async () => {
    const cwd = '/tmp/pid-resolver-rotate-delayed';
    const startSessionId = '99999999-9999-4999-8999-999999999999';
    const rotatedSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const startPath = makeJsonlForSession('pid-resolver-rotate-delayed', startSessionId, cwd);
    const rotatedPath = makeJsonlForSession('pid-resolver-rotate-delayed', rotatedSessionId, cwd);
    // Make the starting transcript larger than the rotated one. A stale
    // baseByte from startPath would otherwise hide the delayed append.
    writeFileSync(startPath, `${'x'.repeat(4096)}\n`);
    writeClaudePidFile(12345, { sessionId: startSessionId, cwd });

    const adapter = createClaudeCodeAdapter('/bin/claude');
    let scheduledAppend = false;
    const pty: PtyHandle = {
      claudeJsonlPath: startPath,
      cliPid: 12345,
      cliCwd: cwd,
      write: vi.fn(),
      sendText: vi.fn(),
      sendSpecialKeys: vi.fn((key: string) => {
        if (key !== 'Enter' || scheduledAppend) return;
        scheduledAppend = true;
        writeClaudePidFile(12345, { sessionId: rotatedSessionId, cwd });
        // Scaled to match the adapter's (now BOTMUX_TIME_SCALE-shrunken) confirm
        // budget — the append must still land WITHIN the poll window, as it does
        // in production where the real 850ms < the real 4×800ms budget.
        setTimeout(() => {
          appendFileSync(
            rotatedPath,
            JSON.stringify({ type: 'user', message: { role: 'user', content: 'delayed append after pid rotate' } }) + '\n',
          );
        }, 850 * TIME_SCALE);
      }),
    };

    const result = await adapter.writeInput(pty, 'delayed append after pid rotate');

    expect(result).toEqual({ submitted: true, cliSessionId: rotatedSessionId });
    expect(pty.claudeJsonlPath).toBe(rotatedPath);
    expect(pty.sendSpecialKeys).toHaveBeenCalledTimes(1);
  });

  it('pid resolver: missing pid file → falls back to fingerprint search', async () => {
    const { oldPath, newPath } = makeClaudeJsonlPaths('pid-resolver-missing');
    const adapter = createClaudeCodeAdapter('/bin/claude');
    let wroteNewTranscript = false;
    const pty: PtyHandle = {
      claudeJsonlPath: oldPath,
      cliPid: 6543, // No pid file written → resolver returns null
      cliCwd: '/tmp/pid-resolver-missing-cwd',
      write: vi.fn(),
      sendText: vi.fn(),
      sendSpecialKeys: vi.fn((key: string) => {
        if (key !== 'Enter' || wroteNewTranscript) return;
        wroteNewTranscript = true;
        writeFileSync(
          newPath,
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'fallback by fingerprint' } }) + '\n',
        );
      }),
    };

    const result = await adapter.writeInput(pty, 'fallback by fingerprint');

    expect(result).toBeUndefined();
    expect(pty.claudeJsonlPath).toBe(newPath);
  });

  it('returns a recheck closure that recognises a slow-path submit (e.g. UserPromptSubmit hook delay)', async () => {
    // Simulates Claude where the in-band 4×800ms confirm budget runs out
    // (Enter sent, jsonl still empty), then a slow UserPromptSubmit hook
    // finally lets the user line land. The deferred recheck must spot it
    // and let the worker suppress the false-failure warning.
    const cwd = '/tmp/recheck-deferred';
    const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const pinnedPath = makeJsonlForSession('recheck-deferred', sessionId, cwd);
    writeClaudePidFile(31337, { sessionId, cwd });

    const adapter = createClaudeCodeAdapter('/bin/claude');
    const pty: PtyHandle = {
      claudeJsonlPath: pinnedPath,
      cliPid: 31337,
      cliCwd: cwd,
      write: vi.fn(),
      sendText: vi.fn(),
      sendSpecialKeys: vi.fn(),  // No append on Enter — simulates hook still running
    };

    const result = await adapter.writeInput(pty, 'slow hook still running');
    expect(result).toMatchObject({ submitted: false });
    const recheck = (result as any)?.recheck as () => boolean;
    expect(typeof recheck).toBe('function');
    expect(recheck()).toBe(false);  // Still nothing in the jsonl

    // Hook eventually lets the user line land in the pinned path.
    appendFileSync(
      pinnedPath,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'slow hook still running' } }) + '\n',
    );
    expect(recheck()).toBe(true);  // Now the worker suppresses the warning
  });
});

describe('codex writeInput submission confirmation', () => {
  it('buildArgs resumes with the persisted Codex thread id', () => {
    resetCodexHistory();
    const adapter = createCodexAdapter('/bin/codex');

    expect(adapter.buildArgs({
      sessionId: 'botmux-session',
      resume: true,
      resumeSessionId: '019dd3e2-f2da-7592-86b5-a43d4cd0772f',
    })).toEqual([
      'resume',
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
      '019dd3e2-f2da-7592-86b5-a43d4cd0772f',
    ]);
  });

  it('buildArgs does not override Codex resume cwd with -C', () => {
    resetCodexHistory();
    const adapter = createCodexAdapter('/bin/codex');

    expect(adapter.buildArgs({
      sessionId: 'botmux-session',
      resume: true,
      resumeSessionId: '019dd3e2-f2da-7592-86b5-a43d4cd0772f',
      workingDir: '/repo/root',
    })).toEqual([
      'resume',
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
      '019dd3e2-f2da-7592-86b5-a43d4cd0772f',
    ]);
  });

  it('buildArgs falls back to the latest history entry containing the botmux session id', () => {
    resetCodexHistory();
    appendCodexHistory('<session_id>botmux-session</session_id>', 'old-codex-session');
    appendCodexHistory('<session_id>other-session</session_id>', 'other-codex-session');
    appendCodexHistory('<session_id>botmux-session</session_id>', 'new-codex-session');
    const adapter = createCodexAdapter('/bin/codex');

    expect(adapter.buildArgs({ sessionId: 'botmux-session', resume: true })).toEqual([
      'resume',
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
      'new-codex-session',
    ]);
  });

  it('honors CODEX_HOME for resume fallback and submit confirmation', async () => {
    const prevCodexHome = process.env.CODEX_HOME;
    const customHome = join(homedir(), '.codex-botmux-test-home');
    process.env.CODEX_HOME = customHome;
    try {
      resetCodexHistory();
      appendCodexHistory('<session_id>custom-botmux-session</session_id>', 'custom-codex-session');
      const adapter = createCodexAdapter('/bin/codex');
      expect(adapter.buildArgs({ sessionId: 'custom-botmux-session', resume: true })).toEqual([
        'resume',
        '--dangerously-bypass-approvals-and-sandbox',
        '--no-alt-screen',
        'custom-codex-session',
      ]);

      resetCodexHistory();
      const pty = makeTmuxPty({ codexSessionId: 'custom-submit-session' });
      const result = await adapter.writeInput(pty, MULTILINE);
      expect(result).toEqual({ submitted: true, cliSessionId: 'custom-submit-session' });
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      try { rmSync(customHome, { recursive: true, force: true }); } catch { /* memfs / absent */ }
    }
  });

  it('buildArgs starts fresh when resume has no known Codex thread id', () => {
    resetCodexHistory();
    const adapter = createCodexAdapter('/bin/codex');

    expect(adapter.buildArgs({ sessionId: 'botmux-session', resume: true })).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
    ]);
  });

  it('buildArgs pins cwd when resume falls back to a fresh Codex session', () => {
    resetCodexHistory();
    const adapter = createCodexAdapter('/bin/codex');

    expect(adapter.buildArgs({
      sessionId: 'botmux-session',
      resume: true,
      workingDir: '/repo/root',
    })).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
      '-C',
      '/repo/root',
    ]);
  });

  it('confirms a multiline submit when history.jsonl appends the escaped prompt marker', async () => {
    resetCodexHistory();
    const pty = makeTmuxPty();
    const adapter = createCodexAdapter('/bin/codex');
    const result = await adapter.writeInput(pty, MULTILINE);

    expect(result).toBeUndefined();
    expect(pty.pasteText).toHaveBeenCalledWith(MULTILINE);
    expect(pty.sendText).not.toHaveBeenCalled();
    expect(pty.sendSpecialKeys).toHaveBeenCalledTimes(1);
    expect(pty.sendSpecialKeys).toHaveBeenCalledWith('Enter');
  });

  it('returns the Codex thread id recorded by history.jsonl', async () => {
    resetCodexHistory();
    const pty = makeTmuxPty({ codexSessionId: 'codex-thread-1' });
    const adapter = createCodexAdapter('/bin/codex');
    const result = await adapter.writeInput(pty, MULTILINE);

    expect(result).toEqual({ submitted: true, cliSessionId: 'codex-thread-1' });
  });

  it('ignores same-prefix history decoys and returns the exact submitted thread id', async () => {
    resetCodexHistory();
    const content = 'shared-prefix '.repeat(4) + 'actual submitted tail';
    const decoy = content.slice(0, 40) + ' different tail from another codex';
    let submittedText = '';
    const pty: PtyHandle = {
      write: vi.fn(),
      pasteText: vi.fn((text: string) => { submittedText = text; }),
      sendSpecialKeys: vi.fn((key: string) => {
        if (key !== 'Enter') return;
        appendCodexHistory(decoy, 'decoy-thread');
        appendCodexHistory(submittedText, 'actual-thread');
      }),
    };
    const adapter = createCodexAdapter('/bin/codex');
    const result = await adapter.writeInput(pty, content);

    expect(result).toEqual({ submitted: true, cliSessionId: 'actual-thread' });
  });

  it('matches JSON-decoded escaped text from history.jsonl', async () => {
    resetCodexHistory();
    const content = '<user_message>\n包含 <tag> & emoji ✅\n</user_message>';
    let submittedText = '';
    const pty: PtyHandle = {
      write: vi.fn(),
      pasteText: vi.fn((text: string) => { submittedText = text; }),
      sendSpecialKeys: vi.fn((key: string) => {
        if (key !== 'Enter') return;
        const escaped = submittedText
          .replace(/</g, '\\u003c')
          .replace(/>/g, '\\u003e')
          .replace(/&/g, '\\u0026');
        appendFileSync(codexHistoryPath(), `{"session_id":"escaped-thread","text":"${escaped.replace(/\n/g, '\\n')}"}` + '\n');
      }),
    };
    const adapter = createCodexAdapter('/bin/codex');
    const result = await adapter.writeInput(pty, content);

    expect(result).toEqual({ submitted: true, cliSessionId: 'escaped-thread' });
  });

  it('matches history text after CRLF normalization without falling back to prefix-only', async () => {
    resetCodexHistory();
    const content = 'first line\r\nsecond line\r\nthird line';
    let submittedText = '';
    const pty: PtyHandle = {
      write: vi.fn(),
      pasteText: vi.fn((text: string) => { submittedText = text; }),
      sendSpecialKeys: vi.fn((key: string) => {
        if (key !== 'Enter') return;
        appendCodexHistory(submittedText.replace(/\r\n/g, '\n'), 'normalised-thread');
      }),
    };
    const adapter = createCodexAdapter('/bin/codex');
    const result = await adapter.writeInput(pty, content);

    expect(result).toEqual({ submitted: true, cliSessionId: 'normalised-thread' });
  });

  it('retries Enter and reports failure when history.jsonl never records the prompt', async () => {
    resetCodexHistory();
    const pty = makeTmuxPty({ confirmCodexSubmit: false });
    const adapter = createCodexAdapter('/bin/codex');
    const result = await adapter.writeInput(pty, MULTILINE);

    expect(result).toMatchObject({ submitted: false });
    // Deferred recheck closure surfaces slow-path submits to the worker
    // (cold-start / heavy UserPromptSubmit hook) so they don't false-warn;
    // before any append it must report the submit still missing.
    expect(typeof (result as any)?.recheck).toBe('function');
    expect((result as any).recheck()).toBe(false);
    appendCodexHistory(MULTILINE, 'late-codex-thread');
    expect((result as any).recheck()).toEqual({ submitted: true, cliSessionId: 'late-codex-thread' });
    expect(pty.pasteText).toHaveBeenCalledWith(MULTILINE);
    expect(pty.sendText).not.toHaveBeenCalled();
    expect(pty.sendSpecialKeys).toHaveBeenCalledTimes(4);
  });
});

describe('coco writeInput submission confirmation', () => {
  // CoCo's tmux path (post PR #4 / 59afae5): single pasteText with the whole
  // content, then a delayed Enter; if ~/.cache/coco/history.jsonl doesn't
  // append our prefix within the budget, retry Enter up to 3 more times.
  // The mock records the last-pasted text and, on the first Enter (when
  // configured to confirm), writes a coco-shaped history line with that
  // content so the adapter's prefix-match path can succeed.
  function makeCocoPasteTmuxPty(opts?: { confirmCocoSubmit?: boolean }) {
    const confirmCocoSubmit = opts?.confirmCocoSubmit ?? true;
    let lastPasted = '';
    let submittedOnce = false;
    return {
      write: vi.fn(),
      sendText: vi.fn(),
      sendSpecialKeys: vi.fn((key: string) => {
        if (key !== 'Enter') return;
        if (!confirmCocoSubmit || submittedOnce) return;
        submittedOnce = true;
        appendCocoHistory(lastPasted);
      }),
      pasteText: vi.fn((text: string) => { lastPasted = text; }),
    } satisfies PtyHandle;
  }

  it('confirms a multiline submit when history.jsonl appends the escaped prompt marker', async () => {
    resetCocoHistory();
    appendCocoHistory('seed prior submit so file exists');
    const adapter = createCocoAdapter('/bin/coco');
    const pty = makeCocoPasteTmuxPty();
    const result = await adapter.writeInput(pty, MULTILINE);

    // Successful submit returns undefined (no warning needed)
    expect(result).toBeUndefined();
    // tmux paste-buffer path: single pasteText with the whole content, then
    // exactly one Enter (no retries — the mock confirmed via history.jsonl).
    expect(pty.pasteText).toHaveBeenCalledWith(MULTILINE);
    expect(pty.sendText).not.toHaveBeenCalled();
    const enterCalls = pty.sendSpecialKeys.mock.calls.filter(c => c[0] === 'Enter').length;
    expect(enterCalls).toBe(1);
  });

  it('retries Enter and reports failure when history.jsonl never records the prompt', async () => {
    resetCocoHistory();
    appendCocoHistory('seed prior submit so file exists');
    const adapter = createCocoAdapter('/bin/coco');
    const pty = makeCocoPasteTmuxPty({ confirmCocoSubmit: false });
    const result = await adapter.writeInput(pty, MULTILINE);

    expect(result).toMatchObject({ submitted: false });
    expect(typeof (result as any)?.recheck).toBe('function');
    expect((result as any).recheck()).toBe(false);
    // pasteText called once, then 1 initial submit Enter + 3 retry Enters = 4
    expect(pty.pasteText).toHaveBeenCalledWith(MULTILINE);
    const enterCalls = pty.sendSpecialKeys.mock.calls.filter(c => c[0] === 'Enter').length;
    expect(enterCalls).toBe(4);
  });

  it('matches HTML-escaped angle brackets that Go marshalling emits (regression)', async () => {
    // CoCo's Go encoder turns "<user_message>..." into "<user_message>..."
    // in the on-disk JSON. A naive substring-match against JSON.stringify(content)
    // (what we did before) would miss this — JS's JSON.stringify leaves `<`
    // alone. Adapter must JSON-decode each candidate line and compare strings.
    //
    // We use a custom mock that, on the FINAL submit Enter, appends a
    // Go-shaped line (with literal `<` etc.) rather than the JS-shaped
    // line the default helper writes. The successful-submit assertion then
    // exercises the JSON-decode + startsWith path.
    resetCocoHistory();
    appendCocoHistory('seed prior submit so file exists');

    const angled = '<user_message>\n@CoCo hello\n</user_message>';
    let pendingBackslash = false;
    let submittedOnce = false;
    const pty: PtyHandle = {
      write: vi.fn(),
      sendText: vi.fn((text: string) => { pendingBackslash = (text === '\\'); }),
      sendSpecialKeys: vi.fn((key: string) => {
        if (key !== 'Enter') return;
        if (pendingBackslash) { pendingBackslash = false; return; }
        if (submittedOnce) return;
        submittedOnce = true;
        // Mimic Go's encoder: HTML-escape `<` `>` `&`, encode \n as the
        // two-char escape `\n`. This is what we observe in the real
        // ~/.cache/coco/history.jsonl after a CoCo submit.
        const goShaped = `{"content":"\\u003cuser_message\\u003e\\n@CoCo hello\\n\\u003c/user_message\\u003e","mode":"user","timestamp":"2026-05-12T13:56:29Z"}`;
        appendFileSync(COCO_HISTORY_PATH, goShaped + '\n');
      }),
      pasteText: vi.fn(),
    };

    const adapter = createCocoAdapter('/bin/coco');
    const result = await adapter.writeInput(pty, angled);

    // Success path: JSON-decode + startsWith finds the Go-escaped content,
    // so writeInput returns undefined (no warning queued).
    expect(result).toBeUndefined();
  });

  it('skips verification on fresh install with no history.jsonl yet', async () => {
    // No appendCocoHistory call → file doesn't exist in memfs.
    // Adapter should trust the Enter and return undefined rather than
    // false-warning, since brand-new coco installs have no history.jsonl
    // until the first submit lands.
    const { rmSync } = await import('node:fs');
    try { rmSync(COCO_HISTORY_PATH); } catch { /* may not exist */ }
    const adapter = createCocoAdapter('/bin/coco');
    const pty = makeCocoPasteTmuxPty({ confirmCocoSubmit: false });
    const result = await adapter.writeInput(pty, 'hello');
    expect(result).toBeUndefined();
  });

  it('confirms submit when baseByte lands mid-line (non-atomic history append)', async () => {
    // CoCo/Trae 0.120.32 appends history.jsonl non-atomically, so the file size
    // captured as baseByte can fall in the MIDDLE of the JSONL line that ends up
    // carrying our marker. Reading straight from baseByte yields a mid-line
    // fragment that fails JSON.parse, so the old scanner skipped the marker line
    // and false-warned even though CoCo received and replied. The fix backs up
    // to the line boundary before parsing.
    resetCocoHistory();
    appendCocoHistory('an older complete record');
    const prompt = '<user_message>\n@CoCo midline test\n</user_message>';
    // Simulate CoCo having written only the HEAD of this submit's line (no
    // trailing newline yet) at the moment the adapter samples baseByte.
    const partialHead = '{"content":"\\u003cuser_message\\u003e\\n@CoCo midline test';
    appendFileSync(COCO_HISTORY_PATH, partialHead);
    // baseByte is now mid-line, inside the marker line.

    let completedOnce = false;
    const pty: PtyHandle = {
      write: vi.fn(),
      sendText: vi.fn(),
      sendSpecialKeys: vi.fn((key: string) => {
        if (key !== 'Enter' || completedOnce) return;
        completedOnce = true;
        // CoCo finishes the rest of the SAME line + newline.
        appendFileSync(
          COCO_HISTORY_PATH,
          '\\n\\u003c/user_message\\u003e","mode":"user","timestamp":"2026-05-21T09:00:00Z"}\n',
        );
      }),
      pasteText: vi.fn(),
    };

    const adapter = createCocoAdapter('/bin/coco');
    const result = await adapter.writeInput(pty, prompt);

    // Confirmed → no warning, and no spurious retry Enters.
    expect(result).toBeUndefined();
    const enterCalls = (pty.sendSpecialKeys as any).mock.calls.filter((c: string[]) => c[0] === 'Enter').length;
    expect(enterCalls).toBe(1);
  });
});
