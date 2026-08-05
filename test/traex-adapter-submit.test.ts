import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

// TRAE submit verification polls the global submit log history.jsonl (written
// at SUBMIT time), NOT the per-session rollout. This mirrors the codex adapter
// and is the fix for the false "submission couldn't be confirmed" warning that
// fired when a type-ahead follow-up was parked mid-turn.
//
// history.jsonl is a GLOBAL file shared by every TRAE pane under one TRAE_HOME,
// so a sibling pane's identical text (e.g. a bare adopt-mode reply with no
// unique <session_id>) can surface a FOREIGN session id. The adapter therefore
// separates two facts:
//   - the text match CONFIRMS the submit (ownership-independent — always);
//   - the reported session id is only RETURNED when this pid provably holds
//     that rollout open (fail closed otherwise), so persist/attach never binds
//     an unverified id.
// These tests drive a PTY whose Enter appends the pasted text to history.jsonl,
// and — for the ownership path — hold the matching rollout file open in a real
// child process so /proc/<pid>/fd resolves.

const SID_1 = '00000000-0000-7000-8000-000000000001';
const SID_2 = '00000000-0000-7000-8000-000000000002';
let traeHome: string;
let historyPath: string;
let previousTraeHome: string | undefined;
let previousScale: string | undefined;
const holders: ChildProcess[] = [];

function historyLine(sid: string, text: string): string {
  return `${JSON.stringify({ session_id: sid, ts: 1785900000, text })}\n`;
}

function seedHistory(sid: string, text: string): void {
  mkdirSync(join(traeHome, 'cli'), { recursive: true });
  appendFileSync(historyPath, historyLine(sid, text));
}

/** Create the rollout file for `sid` and hold it open in a real child process,
 *  returning that pid. findTraexRolloutSetByPid(pid) then sees the rollout via
 *  /proc/<pid>/fd, so the adapter's ownership gate admits the sid. */
function spawnRolloutHolder(sid: string): number {
  const dir = join(traeHome, 'cli', 'sessions', '2026', '08', '05');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-08-05T00-00-00-${sid}.jsonl`);
  writeFileSync(path, historyLine(sid, 'rollout seed'));
  // `tail -f` keeps an fd open on the file until we kill it.
  const child = spawn('tail', ['-f', path], { stdio: 'ignore' });
  holders.push(child);
  return child.pid!;
}

/** A PTY whose first Enter appends the pasted text to history.jsonl under the
 *  given session id — the submit-time write TRAE performs. Optional cliPid wires
 *  the adapter's ownership gate. */
function ptyThatCommits(sid: string, cliPid?: number): PtyHandle & {
  pasteText: ReturnType<typeof vi.fn>;
  sendSpecialKeys: ReturnType<typeof vi.fn>;
} {
  let pasted = '';
  let committed = false;
  return {
    write: vi.fn(),
    cliPid,
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

function ptyThatNeverCommits(cliPid?: number): PtyHandle & {
  pasteText: ReturnType<typeof vi.fn>;
  sendSpecialKeys: ReturnType<typeof vi.fn>;
} {
  return { write: vi.fn(), cliPid, pasteText: vi.fn(), sendSpecialKeys: vi.fn() };
}

/** A PTY whose Enter appends the SAME pasted text TWICE — first under a foreign
 *  sibling's session id, THEN under the owned one. Models the shared-history
 *  collision where a sibling pane's identical text lands first in history.jsonl
 *  but our own owned line follows. The adapter must skip the foreign line and
 *  return the owned id. */
function ptyForeignThenOwned(foreignSid: string, ownedSid: string, cliPid?: number): PtyHandle & {
  pasteText: ReturnType<typeof vi.fn>;
  sendSpecialKeys: ReturnType<typeof vi.fn>;
} {
  let pasted = '';
  let committed = false;
  return {
    write: vi.fn(),
    cliPid,
    pasteText: vi.fn((text: string) => { pasted = text; }),
    sendSpecialKeys: vi.fn((key: string) => {
      if (key === 'Enter' && !committed) {
        committed = true;
        mkdirSync(join(traeHome, 'cli'), { recursive: true });
        appendFileSync(historyPath, historyLine(foreignSid, pasted));  // sibling first
        appendFileSync(historyPath, historyLine(ownedSid, pasted));    // ours next
      }
    }),
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
    while (holders.length) { try { holders.pop()!.kill('SIGKILL'); } catch { /* ignore */ } }
    if (previousTraeHome === undefined) delete process.env.TRAE_HOME;
    else process.env.TRAE_HOME = previousTraeHome;
    if (previousScale === undefined) delete process.env.BOTMUX_TIME_SCALE;
    else process.env.BOTMUX_TIME_SCALE = previousScale;
    rmSync(traeHome, { recursive: true, force: true });
  });

  // ── Submit confirmation (ownership-INDEPENDENT — the original bug fix) ──

  it('confirms the first submit even when history.jsonl does not exist yet (lazy-created)', async () => {
    // No history file on disk — TRAE creates it on the first submit. baseByte=0
    // and the appended line matches, so the submit is confirmed (unlike the old
    // SQLite path, which failed closed before writing). No cliPid → no id, but
    // the submit is still confirmed (never a false submit_unconfirmed).
    const adapter = createTraexAdapter('/bin/traex');
    const pty = ptyThatCommits(SID_1);

    const result = await adapter.writeInput(pty, 'the very first prompt');

    expect(result).toEqual({ submitted: true });
    expect(pty.pasteText).toHaveBeenCalledWith('the very first prompt');
    expect(pty.sendSpecialKeys).toHaveBeenCalledWith('Enter');
  });

  it('confirms a later turn from the history.jsonl delta, ignoring earlier lines', async () => {
    seedHistory(SID_1, 'the immutable first prompt');
    const adapter = createTraexAdapter('/bin/traex');
    const pty = ptyThatCommits(SID_1);

    const result = await adapter.writeInput(pty, 'a different second prompt');

    expect(result).toEqual({ submitted: true });
    // baseByte was captured after the seeded line, so only the new submit counts.
    expect(pty.sendSpecialKeys).toHaveBeenCalledTimes(1);
  });

  it('confirms a mid-turn type-ahead follow-up (the false-warning regression)', async () => {
    // Simulates the reported bug: a follow-up sent while a turn is running. TRAE
    // parks it but writes history.jsonl immediately, so writeInput confirms it
    // in-band instead of returning { submitted: false } → false warning. Submit
    // confirmation must NOT depend on pid ownership.
    seedHistory(SID_1, '<botmux_routing>opening turn</botmux_routing>');
    const adapter = createTraexAdapter('/bin/traex');
    const followUp = `<session_id>bm</session_id>\n\n<user_message>\nfollow-up while busy\n</user_message>`;
    const pty = ptyThatCommits(SID_1);

    const result = await adapter.writeInput(pty, followUp);

    expect(result).toEqual({ submitted: true });
  });

  it('returns submitted:false + recheck when the submit never reaches history.jsonl', async () => {
    seedHistory(SID_1, 'prior turn');
    const adapter = createTraexAdapter('/bin/traex');
    const pty = ptyThatNeverCommits();

    const result = await adapter.writeInput(pty, 'stuck in composer');

    expect(result).toMatchObject({ submitted: false });
    expect(typeof (result as any).recheck).toBe('function');
    // A recheck once the file finally records it flips to confirmed (no owning
    // pid → confirmed without an id).
    appendFileSync(historyPath, historyLine(SID_1, 'stuck in composer'));
    const late = await (result as any).recheck();
    expect(late).toEqual({ submitted: true });
  });

  // ── Session-id ownership (only RETURN a pid-owned id) ──

  it('returns the session id when THIS pid provably owns the rollout', async () => {
    const ownedPid = spawnRolloutHolder(SID_1);
    // Give tail a beat to open the fd.
    await new Promise(r => setTimeout(r, 150));
    const adapter = createTraexAdapter('/bin/traex');
    const pty = ptyThatCommits(SID_1, ownedPid);

    const result = await adapter.writeInput(pty, 'owned submit');

    expect(result).toEqual({ submitted: true, cliSessionId: SID_1 });
  });

  it('confirms the submit but WITHHOLDS a foreign sibling id the pid does not own', async () => {
    // The classic collision: our pid owns SID_1's rollout, but a sibling pane
    // wrote the SAME text first under SID_2. The history match may surface
    // SID_2; ownership gating must refuse to return it (would misbind resume /
    // bridge to a foreign session) while still confirming our submit.
    const ownedPid = spawnRolloutHolder(SID_1);
    await new Promise(r => setTimeout(r, 150));
    const adapter = createTraexAdapter('/bin/traex');
    // PTY commits the text under the FOREIGN SID_2 (sibling won the race).
    const pty = ptyThatCommits(SID_2, ownedPid);

    const result = await adapter.writeInput(pty, 'duplicate text across panes');

    expect(result).toEqual({ submitted: true });
    expect((result as any).cliSessionId).toBeUndefined();
  });

  it('returns the OWNED id when a foreign sibling line is written first, ours later', async () => {
    // Codex regression: an unfiltered matcher returns at the FIRST matching line,
    // so a foreign-first line would mask our owned line and drop the id even
    // though we own a later one. With an enumerable pid, the owned scan skips the
    // foreign line and keeps scanning to ours — returning SID_1, not undefined.
    const ownedPid = spawnRolloutHolder(SID_1);
    await new Promise(r => setTimeout(r, 150));
    const adapter = createTraexAdapter('/bin/traex');
    const pty = ptyForeignThenOwned(SID_2, SID_1, ownedPid);

    const result = await adapter.writeInput(pty, 'duplicate text foreign-first');

    expect(result).toEqual({ submitted: true, cliSessionId: SID_1 });
  });

  it('withholds the id when fd enumeration is unavailable (pid not running)', async () => {
    // A pid that isn't a live rollout holder → findTraexRolloutSetByPid returns
    // an empty set (or undefined); either way, fail closed on the id but still
    // confirm the submit.
    const adapter = createTraexAdapter('/bin/traex');
    const pty = ptyThatCommits(SID_1, 2 ** 22); // almost-certainly-dead pid

    const result = await adapter.writeInput(pty, 'no owner submit');

    expect(result).toEqual({ submitted: true });
  });

  it('keeps the botmux-ask fallback skill for non-RPC TraeX sessions', () => {
    const adapter = createTraexAdapter('/bin/traex');

    expect(adapter.asksViaHook).toBe(false);
    expect(adapter.hookInstall).toBeUndefined();
  });
});
