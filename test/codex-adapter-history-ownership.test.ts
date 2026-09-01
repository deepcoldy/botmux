/**
 * codex writeInput history-ownership filter (shared CODEX_HOME collision).
 *
 * history.jsonl is ONE global file shared by every Codex pane under a CODEX_HOME.
 * When two panes submit identical text, both append a same-text line; scanning
 * the delta and taking the FIRST match can hand pane B pane A's session id. That
 * poisoned id then drives the worker's bridge attach → B's replies are lost or
 * A's transcript is posted into B's thread.
 *
 * The adapter now filters the history match by pid ownership: it only accepts a
 * same-text line whose session id is one THIS pid actually holds open
 * (findCodexRolloutSetByPid), so B's writeInput returns B even when A's identical
 * line landed first. These tests spawn a REAL subprocess holding B's rollout fd
 * (so the ownership probe has a live pid to enumerate) and assert the RESULT is
 * B — not merely "not A", which a permanently-wedged bridge would also satisfy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

const SID_A = '019dd80d-d922-7a11-8339-0208d8c5b4ec'; // foreign sibling pane
const SID_B = '019dd80d-d922-7a11-8339-0208d8c5b4ee'; // this pane (owned)

let home: string;
let prevCodexHome: string | undefined;
let prevScale: string | undefined;
let ownerChild: ChildProcessWithoutNullStreams;
let rolloutB: string;
/** Deferred timers scheduled by a test's onEnter. writeInput retries Enter, so
 *  onEnter can fire several times; track every timer and clear them in afterEach
 *  so none survives to append to an already-removed home dir (→ uncaught ENOENT
 *  that poisons later tests / fails CI). */
let pendingTimers: ReturnType<typeof setTimeout>[] = [];

/** A rollout file under `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl`. */
function rolloutPath(root: string, sid: string): string {
  const dir = join(root, 'sessions', '2026', '05', '15');
  mkdirSync(dir, { recursive: true });
  return join(dir, `rollout-2026-05-15T07-04-39-${sid}.jsonl`);
}

/** A global history.jsonl line: Codex writes `{session_id, text, ...}` per submit. */
function historyLine(sid: string, text: string): string {
  return `${JSON.stringify({ session_id: sid, text, ts: 0 })}\n`;
}

/** A PtyHandle whose paste is a no-op but whose Enter triggers `onEnter`, so a
 *  test can append the history line(s) AFTER writeInput captured its baseByte —
 *  matching production (Codex writes the history line in response to submit, so
 *  the line always lands after baseByte). */
function fakePty(cliPid: number | undefined, onEnter?: () => void): PtyHandle {
  return {
    write() {},
    pasteText() {},
    sendSpecialKeys() { onEnter?.(); },
    ...(cliPid !== undefined ? { cliPid } : {}),
  } as unknown as PtyHandle;
}

beforeEach(async () => {
  prevScale = process.env.BOTMUX_TIME_SCALE;
  process.env.BOTMUX_TIME_SCALE = '0.01'; // collapse the ~0.5–3s submit waits
  prevCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), 'bmx-codex-hist-'));
  process.env.CODEX_HOME = home;

  // B's rollout exists and is held open by a live process → ownership probe of
  // that pid enumerates SID_B (not SID_A).
  rolloutB = rolloutPath(home, SID_B);
  writeFileSync(rolloutB, '');
  writeFileSync(join(home, 'history.jsonl'), '');

  ownerChild = spawn(
    process.execPath,
    ['-e', `require('fs').openSync(${JSON.stringify(rolloutB)}, 'a'); process.stdout.write('ready\\n'); setTimeout(()=>{}, 60000);`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('owner child not ready')), 5000);
    ownerChild.stdout.once('data', (b: Buffer) => { if (b.toString().includes('ready')) { clearTimeout(timer); resolve(); } });
    ownerChild.once('error', reject);
  });
});

afterEach(() => {
  for (const t of pendingTimers) clearTimeout(t);
  pendingTimers = [];
  if (ownerChild && !ownerChild.killed) ownerChild.kill('SIGKILL');
  if (home) rmSync(home, { recursive: true, force: true });
  if (prevScale === undefined) delete process.env.BOTMUX_TIME_SCALE; else process.env.BOTMUX_TIME_SCALE = prevScale;
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome;
});

describe('codex writeInput history ownership filter', () => {
  it('returns the OWNED session id (B), not the foreign sibling line (A) that landed first', async () => {
    const historyPath = join(home, 'history.jsonl');
    const adapter = createCodexAdapter();
    // On submit (Enter), the shared history gains A's identical-text line FIRST
    // (a concurrent sibling pane), then B's own line — both AFTER baseByte, as in
    // production where Codex writes the line in response to the submit.
    let appended = false;
    const onEnter = () => {
      if (appended) return;
      appended = true;
      appendFileSync(historyPath, historyLine(SID_A, '继续'));
      appendFileSync(historyPath, historyLine(SID_B, '继续'));
    };

    const result = await adapter.writeInput!(fakePty(ownerChild.pid!, onEnter), '继续');
    expect(result).toBeDefined();
    expect((result as any).submitted).toBe(true);
    // The heart of the fix: B's writeInput binds to B, never to A.
    expect((result as any).cliSessionId).toBe(SID_B);
  });

  it('recognizes rollouts under a custom CODEX_HOME (env-independent path shape), when worker + Codex share that home', async () => {
    // SCOPE: this proves the ownership probe recognizes B's rollout by its
    // structural `/sessions/rollout-…` shape even when the home is a custom
    // mkdtemp root (no `/.codex/` segment) — home here is BOTH the worker's
    // CODEX_HOME (via process.env, set in beforeEach) and the child's.
    //
    // It does NOT cover an ADOPTED external Codex whose CODEX_HOME differs from
    // the worker's: the worker scrubs inherited CODEX_HOME and the adapter reads
    // the worker's own codexHistoryPath()/sessions root, while the adopt init
    // message carries no external CODEX_HOME (only adoptCwd). That cross-home
    // adopt was never plumbed (true on master too) — a pre-existing limitation,
    // out of scope for this fix. See the note in matchCodexRolloutPath.
    const historyPath = join(home, 'history.jsonl');
    const adapter = createCodexAdapter();
    let appended = false;
    const onEnter = () => {
      if (appended) return;
      appended = true;
      appendFileSync(historyPath, historyLine(SID_A, 'hello'));
      appendFileSync(historyPath, historyLine(SID_B, 'hello'));
    };

    const result = await adapter.writeInput!(fakePty(ownerChild.pid!, onEnter), 'hello');
    expect((result as any)?.cliSessionId).toBe(SID_B);
  });

  it('does not wedge when ONLY the foreign line exists yet — waits, then binds B once B lands', async () => {
    const historyPath = join(home, 'history.jsonl');
    const adapter = createCodexAdapter();
    // On submit only A appears; B's line arrives shortly after (separate tick).
    // writeInput retries Enter, so guard the deferred B-append one-shot and track
    // the timer so afterEach can clear it (no append into a removed home dir).
    let scheduledB = false;
    const onEnter = () => {
      appendFileSync(historyPath, historyLine(SID_A, 'ping'));
      if (scheduledB) return;
      scheduledB = true;
      pendingTimers.push(setTimeout(() => {
        try { appendFileSync(historyPath, historyLine(SID_B, 'ping')); } catch { /* home may be gone if test already resolved */ }
      }, 20));
    };

    const result = await adapter.writeInput!(fakePty(ownerChild.pid!, onEnter), 'ping');
    // Must NOT have taken A; must eventually bind B (not a permanent no-match).
    expect((result as any)?.cliSessionId).toBe(SID_B);
  });

  it('with NO pid, preserves accept-first semantics (single-pane / pid-less callers unchanged)', async () => {
    const historyPath = join(home, 'history.jsonl');
    const adapter = createCodexAdapter();
    // Only a foreign-looking line exists; without a pid there is no ownership
    // signal, so the original submit-confirmation behavior (accept the match)
    // is preserved — the worker-side attach gate is the backstop there.
    const onEnter = () => { appendFileSync(historyPath, historyLine(SID_A, 'noping')); };

    const result = await adapter.writeInput!(fakePty(undefined, onEnter), 'noping');
    expect((result as any)?.cliSessionId).toBe(SID_A);
  });

  it('external App Server viewer accepts only its explicitly selected remote thread', async () => {
    const historyPath = join(home, 'history.jsonl');
    const adapter = createCodexAdapter();
    let appended = false;
    const onEnter = () => {
      if (appended) return;
      appended = true;
      // An unrelated same-text submit may land first in the global history.
      appendFileSync(historyPath, historyLine(SID_B, 'remote submit'));
      appendFileSync(historyPath, historyLine(SID_A, 'remote submit'));
    };
    const pty = fakePty(ownerChild.pid!, onEnter);
    // The remote TUI owns no rollout fd—the existing App Server owns SID_A.
    // Its explicit binding therefore wins over the local viewer PID.
    pty.expectedCodexSessionId = SID_A;

    const result = await adapter.writeInput!(pty, 'remote submit');
    expect((result as any)?.submitted).toBe(true);
    expect((result as any)?.cliSessionId).toBe(SID_A);
  });
});
