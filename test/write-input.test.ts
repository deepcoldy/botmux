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

function appendCodexHistory(content: string, sessionId?: string): void {
  mkdirSync(dirname(CODEX_HISTORY_PATH), { recursive: true });
  appendFileSync(CODEX_HISTORY_PATH, JSON.stringify({ session_id: sessionId, text: content }) + '\n');
}

function resetCodexHistory(): void {
  mkdirSync(dirname(CODEX_HISTORY_PATH), { recursive: true });
  writeFileSync(CODEX_HISTORY_PATH, '');
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
        setTimeout(() => {
          appendFileSync(
            rotatedPath,
            JSON.stringify({ type: 'user', message: { role: 'user', content: 'delayed append after pid rotate' } }) + '\n',
          );
        }, 850);
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

  it('buildArgs starts fresh when resume has no known Codex thread id', () => {
    resetCodexHistory();
    const adapter = createCodexAdapter('/bin/codex');

    expect(adapter.buildArgs({ sessionId: 'botmux-session', resume: true })).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
    ]);
  });

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

  it('returns the Codex thread id recorded by history.jsonl', async () => {
    resetCodexHistory();
    const pty = makeTmuxPty({ codexSessionId: 'codex-thread-1' });
    const adapter = createCodexAdapter('/bin/codex');
    const result = await adapter.writeInput(pty, MULTILINE);

    expect(result).toEqual({ submitted: true, cliSessionId: 'codex-thread-1' });
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
