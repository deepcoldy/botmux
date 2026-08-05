import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

// TRAE submit verification polls the global submit log history.jsonl (written
// at SUBMIT time), NOT the per-session rollout. This mirrors the codex adapter
// and is the fix for the false "submission couldn't be confirmed" warning that
// fired when a type-ahead follow-up was parked mid-turn: the rollout only gets
// a parked message when the running turn dequeues it (can exceed the worker's
// deadline), while history.jsonl gets it immediately. These tests drive a PTY
// whose Enter appends the pasted text to history.jsonl, exactly as TRAE does.

const SID_1 = '00000000-0000-7000-8000-000000000001';
const SID_2 = '00000000-0000-7000-8000-000000000002';
let traeHome: string;
let historyPath: string;
let previousTraeHome: string | undefined;
let previousScale: string | undefined;

function historyLine(sid: string, text: string): string {
  return `${JSON.stringify({ session_id: sid, ts: 1785900000, text })}\n`;
}

function seedHistory(sid: string, text: string): void {
  mkdirSync(join(traeHome, 'cli'), { recursive: true });
  appendFileSync(historyPath, historyLine(sid, text));
}

/** A PTY whose first Enter appends the pasted text to history.jsonl under the
 *  given session id — the submit-time write TRAE performs. */
function ptyThatCommits(sid: string): PtyHandle & {
  pasteText: ReturnType<typeof vi.fn>;
  sendSpecialKeys: ReturnType<typeof vi.fn>;
} {
  let pasted = '';
  let committed = false;
  return {
    write: vi.fn(),
    pasteText: vi.fn((text: string) => { pasted = text; }),
    sendSpecialKeys: vi.fn((key: string) => {
      if (key === 'Enter' && !committed) {
        committed = true;
        mkdirSync(join(traeHome, 'cli'), { recursive: true });
        appendFileSync(historyPath, historyLine(sid, pasted));
      }
    }),
  };
}

/** A PTY that never writes the submit to history.jsonl (stuck in composer). */
function ptyThatNeverCommits(): PtyHandle & {
  pasteText: ReturnType<typeof vi.fn>;
  sendSpecialKeys: ReturnType<typeof vi.fn>;
} {
  return {
    write: vi.fn(),
    pasteText: vi.fn(),
    sendSpecialKeys: vi.fn(),
  };
}

describe.sequential('TRAE adapter submit verification (history.jsonl)', () => {
  beforeEach(() => {
    previousTraeHome = process.env.TRAE_HOME;
    previousScale = process.env.BOTMUX_TIME_SCALE;
    traeHome = mkdtempSync(join(tmpdir(), 'traex-adapter-'));
    historyPath = join(traeHome, 'cli', 'history.jsonl');
    process.env.TRAE_HOME = traeHome;
    process.env.BOTMUX_TIME_SCALE = '0.01';
  });

  afterEach(() => {
    if (previousTraeHome === undefined) delete process.env.TRAE_HOME;
    else process.env.TRAE_HOME = previousTraeHome;
    if (previousScale === undefined) delete process.env.BOTMUX_TIME_SCALE;
    else process.env.BOTMUX_TIME_SCALE = previousScale;
    rmSync(traeHome, { recursive: true, force: true });
  });

  it('confirms the first submit even when history.jsonl does not exist yet (lazy-created)', async () => {
    // No history file on disk — TRAE creates it on the first submit. baseByte=0
    // and the appended line matches, so the submit is confirmed (unlike the old
    // SQLite path, which failed closed before writing).
    const adapter = createTraexAdapter('/bin/traex');
    const pty = ptyThatCommits(SID_1);

    const result = await adapter.writeInput(pty, 'the very first prompt');

    expect(result).toEqual({ submitted: true, cliSessionId: SID_1 });
    expect(pty.pasteText).toHaveBeenCalledWith('the very first prompt');
    expect(pty.sendSpecialKeys).toHaveBeenCalledWith('Enter');
  });

  it('confirms a later turn from the history.jsonl delta, ignoring earlier lines', async () => {
    seedHistory(SID_1, 'the immutable first prompt');
    const adapter = createTraexAdapter('/bin/traex');
    const pty = ptyThatCommits(SID_1);

    const result = await adapter.writeInput(pty, 'a different second prompt');

    expect(result).toEqual({ submitted: true, cliSessionId: SID_1 });
    // baseByte was captured after the seeded line, so only the new submit counts.
    expect(pty.sendSpecialKeys).toHaveBeenCalledTimes(1);
  });

  it('returns the new native session id when a submit rotates to a fresh session', async () => {
    seedHistory(SID_1, 'old session prompt');
    const adapter = createTraexAdapter('/bin/traex');
    const pty = ptyThatCommits(SID_2);

    const result = await adapter.writeInput(pty, 'first prompt after session rotation');

    expect(result).toEqual({ submitted: true, cliSessionId: SID_2 });
  });

  it('confirms a mid-turn type-ahead follow-up (the false-warning regression)', async () => {
    // Simulates the reported bug: a follow-up sent while a turn is running. TRAE
    // parks it but writes history.jsonl immediately, so writeInput confirms it
    // in-band instead of returning { submitted: false } → false warning.
    seedHistory(SID_1, '<botmux_routing>opening turn</botmux_routing>');
    const adapter = createTraexAdapter('/bin/traex');
    const followUp = `<session_id>bm</session_id>\n\n<user_message>\nfollow-up while busy\n</user_message>`;
    const pty = ptyThatCommits(SID_1);

    const result = await adapter.writeInput(pty, followUp);

    expect(result).toEqual({ submitted: true, cliSessionId: SID_1 });
  });

  it('returns submitted:false + recheck when the submit never reaches history.jsonl', async () => {
    seedHistory(SID_1, 'prior turn');
    const adapter = createTraexAdapter('/bin/traex');
    const pty = ptyThatNeverCommits();

    const result = await adapter.writeInput(pty, 'stuck in composer');

    expect(result).toMatchObject({ submitted: false });
    expect(typeof (result as any).recheck).toBe('function');
    // A recheck once the file finally records it flips to confirmed.
    appendFileSync(historyPath, historyLine(SID_1, 'stuck in composer'));
    const late = await (result as any).recheck();
    expect(late).toEqual({ submitted: true, cliSessionId: SID_1 });
  });

  it('keeps the botmux-ask fallback skill for non-RPC TraeX sessions', () => {
    const adapter = createTraexAdapter('/bin/traex');

    expect(adapter.asksViaHook).toBe(false);
    expect(adapter.hookInstall).toBeUndefined();
  });
});
