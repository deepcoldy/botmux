import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { openDatabaseSyncNow } from '../src/services/sqlite-compat.js';
import { GOAL_COMMAND_OBJECTIVE } from '../src/workflows/v3/contract.js';
import { discoverRolloutSessions } from '../src/services/resumable-session-discovery.js';
import { traexRolloutUserInputs, traexSessionIdFromRolloutPath } from '../src/services/traex-transcript.js';
import { traeSessionsRoot } from '../src/services/traex-paths.js';
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
 *  sibling's session id, THEN under the owned one (both in the same callback, so
 *  both are present by the adapter's first probe). The adapter must skip the
 *  foreign line and return the owned id. See ptyForeignNowOwnedLater for the
 *  harder async-timing variant. */
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

/** The hard async-timing variant: on Enter the FOREIGN line lands immediately,
 *  but the OWNED line is written by a timer strictly AFTER the adapter's first
 *  poll (delayMs). This reproduces Codex's reproduction — a matcher that settles
 *  on the first any-text sighting would return {submitted:true} with no id at
 *  ~200ms and never re-scan for the owned line. The adapter must keep polling
 *  (enumeration available) until the owned line surfaces, then return ownedSid. */
function ptyForeignNowOwnedLater(
  foreignSid: string, ownedSid: string, cliPid: number, delayMs: number,
): PtyHandle & { pasteText: ReturnType<typeof vi.fn>; sendSpecialKeys: ReturnType<typeof vi.fn>; timers: NodeJS.Timeout[] } {
  let pasted = '';
  let committed = false;
  const timers: NodeJS.Timeout[] = [];
  return {
    write: vi.fn(),
    cliPid,
    timers,
    pasteText: vi.fn((text: string) => { pasted = text; }),
    sendSpecialKeys: vi.fn((key: string) => {
      if (key === 'Enter' && !committed) {
        committed = true;
        mkdirSync(join(traeHome, 'cli'), { recursive: true });
        appendFileSync(historyPath, historyLine(foreignSid, pasted));  // foreign lands now
        timers.push(setTimeout(() => {
          appendFileSync(historyPath, historyLine(ownedSid, pasted));   // owned lands later
        }, delayMs));
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

  it('preserves @ file mentions in normal user input', async () => {
    const adapter = createTraexAdapter('/bin/traex');
    const prompt = 'inspect @src/index.ts';
    const pty = ptyThatCommits(SID_1);

    const result = await adapter.writeInput(pty, prompt);

    expect(result).toEqual({ submitted: true });
    expect(pty.pasteText).toHaveBeenCalledWith(prompt);
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

  it('keeps polling past a foreign-first sighting until the OWNED line lands later (async timing)', async () => {
    // Codex's timing reproduction: on Enter the foreign line lands immediately,
    // the owned line ~400ms later — strictly after the adapter's first probe. A
    // matcher that settled on the first any-text sighting would return
    // {submitted:true} with NO id at ~200ms and never re-scan. Enumeration is
    // available (real owning pid), so the adapter must keep polling until the
    // owned line surfaces and return SID_1. Run at REAL time (no BOTMUX_TIME_SCALE)
    // so the 200ms+800ms cadence spans the 400ms owned-line timer.
    delete process.env.BOTMUX_TIME_SCALE;
    const ownedPid = spawnRolloutHolder(SID_1);
    await new Promise(r => setTimeout(r, 150));
    const adapter = createTraexAdapter('/bin/traex');
    const pty = ptyForeignNowOwnedLater(SID_2, SID_1, ownedPid, 400);

    const result = await adapter.writeInput(pty, 'duplicate text owned-later');
    for (const t of pty.timers) clearTimeout(t);

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

  it('lists TraeX history_mutation sessions with the native indexed title', async () => {
    const sessionsDir = join(traeHome, 'cli', 'sessions', '2026', '08', '29');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'rollout-2026-08-29T10-00-00-' + SID_1 + '.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: SID_1, cwd: '/old/project' } }),
      JSON.stringify({ type: 'history_mutation', payload: { operation: 'append', items: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'the original prompt' }],
      }] } }),
      '',
    ].join('\n'));

    const db = openDatabaseSyncNow(join(traeHome, 'cli', 'state_5.sqlite'))!;
    db.exec([
      'CREATE TABLE threads (',
      '  id TEXT PRIMARY KEY,',
      '  title TEXT NOT NULL,',
      '  first_user_message TEXT NOT NULL,',
      '  cwd TEXT NOT NULL,',
      '  rollout_path TEXT NOT NULL,',
      '  updated_at INTEGER NOT NULL',
      ');',
      "INSERT INTO threads VALUES ('" + SID_1 + "', 'Native TraeX title', 'the original prompt', '/current/project', '/tmp/rollout.jsonl', 1787900000);",
    ].join('\n'));
    db.close();

    const rows = await createTraexAdapter('/bin/traex').listResumableSessions!({ limit: 10 });

    expect(rows).toEqual([{
      cliSessionId: SID_1,
      cwd: '/current/project',
      title: 'Native TraeX title',
      lastActivityAt: 1_787_900_000_000,
    }]);
  });

  it('lists 0.210-shaped sessions by native name and hides botmux-origin threads', async () => {
    // Measured on TraeX 0.210.1: rollouts open with a <system-reminder> context
    // item; the state DB keeps the display name in `name` and the first prompt
    // only in `preview` (title / first_user_message stay empty).
    const sessionsDir = join(traeHome, 'cli', 'sessions', '2026', '10', '17');
    mkdirSync(sessionsDir, { recursive: true });
    const reminder = {
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '<system-reminder>\nAs you answer the user\'s questions, you can use the following context:\n</system-reminder>' }],
    };
    const rollout = (sid: string, prompt: string) => [
      JSON.stringify({ type: 'session_meta', payload: { id: sid, cwd: '/root/project' } }),
      JSON.stringify({ type: 'history_mutation', payload: { operation: 'append', items: [reminder] } }),
      JSON.stringify({ type: 'history_mutation', payload: { operation: 'append', items: [{
        type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }],
      }] } }),
      '',
    ].join('\n');
    const envelope = '<session_id>4f6c2e1a-1111-4222-8333-944455556666</session_id>\n<user_message>\n收到\n</user_message>';
    writeFileSync(join(sessionsDir, `rollout-2026-10-17T23-08-59-${SID_1}.jsonl`), rollout(SID_1, '请只回复两个字：收到。'));
    writeFileSync(join(sessionsDir, `rollout-2026-10-17T23-11-59-${SID_2}.jsonl`), rollout(SID_2, envelope));

    const db = openDatabaseSyncNow(join(traeHome, 'cli', 'state_5.sqlite'))!;
    db.exec([
      'CREATE TABLE threads (',
      '  id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, updated_at INTEGER NOT NULL, cwd TEXT NOT NULL,',
      "  title TEXT NOT NULL, first_user_message TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '', name TEXT",
      ');',
    ].join('\n'));
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, 1792249771, ?, ?, ?, ?, ?)');
    insert.run(SID_1, '/r1.jsonl', '/root/project', '', '', '请只回复两个字：收到。', '回复确认收到');
    insert.run(SID_2, '/r2.jsonl', '/root/project', '', '', envelope, '确认收到消息');
    db.close();

    const rows = await createTraexAdapter('/bin/traex').listResumableSessions!({ limit: 10 });

    expect(rows).toEqual([{
      cliSessionId: SID_1,
      cwd: '/root/project',
      title: '回复确认收到',
      lastActivityAt: 1_792_249_771_000,
    }]);
  });

  it('hides botmux v3 goal workers but lists user-run goal sessions (0.210 goal mode)', async () => {
    const sessionsDir = join(traeHome, 'cli', 'sessions', '2026', '10', '19');
    mkdirSync(sessionsDir, { recursive: true });
    const goalRollout = (sid: string, objective: string) => [
      JSON.stringify({ type: 'session_meta', payload: { id: sid, cwd: '/root/project', thread_source: 'user' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'thread_goal_updated', threadId: sid, goal: { threadId: sid, objective } } }),
      '',
    ].join('\n');
    writeFileSync(join(sessionsDir, `rollout-2026-10-19T09-00-00-${SID_1}.jsonl`), goalRollout(SID_1, GOAL_COMMAND_OBJECTIVE));
    writeFileSync(join(sessionsDir, `rollout-2026-10-19T09-05-00-${SID_2}.jsonl`), goalRollout(SID_2, 'ship the release notes'));

    const db = openDatabaseSyncNow(join(traeHome, 'cli', 'state_5.sqlite'))!;
    db.exec([
      'CREATE TABLE threads (',
      '  id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, updated_at INTEGER NOT NULL, cwd TEXT NOT NULL,',
      "  title TEXT NOT NULL, first_user_message TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '', name TEXT",
      ');',
    ].join('\n'));
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, 1792400000, ?, ?, ?, ?, ?)');
    insert.run(SID_1, '/r1.jsonl', '/root/project', '', '', GOAL_COMMAND_OBJECTIVE, 'Read $BOTMUX_GOAL_PATH. Write files');
    insert.run(SID_2, '/r2.jsonl', '/root/project', '', '', 'ship the release notes', 'Ship release notes');
    db.close();

    const rows = await createTraexAdapter('/bin/traex').listResumableSessions!({ limit: 10 });

    expect(rows).toEqual([expect.objectContaining({ cliSessionId: SID_2, title: 'Ship release notes' })]);
  });

  it('hides a goal worker that later received a normal turn (objective only left in preview)', async () => {
    const sessionsDir = join(traeHome, 'cli', 'sessions', '2026', '10', '19');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, `rollout-2026-10-19T09-00-00-${SID_1}.jsonl`), [
      JSON.stringify({ type: 'session_meta', payload: { id: SID_1, cwd: '/root/project', thread_source: 'user' } }),
      '',
    ].join('\n'));

    const db = openDatabaseSyncNow(join(traeHome, 'cli', 'state_5.sqlite'))!;
    db.exec([
      'CREATE TABLE threads (',
      '  id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, updated_at INTEGER NOT NULL, cwd TEXT NOT NULL,',
      "  title TEXT NOT NULL, first_user_message TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '', name TEXT",
      ');',
    ].join('\n'));
    db.prepare('INSERT INTO threads VALUES (?, ?, 1792400000, ?, ?, ?, ?, ?)')
      .run(SID_1, '/r1.jsonl', '/root/project', 'status?', 'status?', GOAL_COMMAND_OBJECTIVE, 'Read $BOTMUX_GOAL_PATH. Write files');
    db.close();

    expect(await createTraexAdapter('/bin/traex').listResumableSessions!({ limit: 10 })).toEqual([]);
  });

  it('reaches the same verdict with and without the native index (one fixture, two paths)', async () => {
    // Each fixture is a rollout plus the threads row TraeX writes for it:
    // `preview` = the original first input; title / first_user_message / name
    // are display fields TraeX may rewrite later.
    const ENV = '<session_id>4f6c2e1a-1111-4222-8333-944455556666</session_id>\n<user_message>\nhi\n</user_message>';
    const meta = (sid: string) => ({ type: 'session_meta', payload: { id: sid, cwd: '/root/project', thread_source: 'user' } });
    const dc = (sid: string, text: string, turnId: string) => ({ type: 'history_mutation', payload: {
      operation: 'append', turn_id: turnId,
      items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
      display_completions: [{ thread_id: sid, turn_id: turnId, item: { type: 'UserMessage', content: [{ type: 'text', text }] } }],
    } });
    const item = (text: string, turnId: string) => ({ type: 'history_mutation', payload: {
      operation: 'append', turn_id: turnId, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
    } });
    const done = (turnId: string) => ({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } });
    const goal = (sid: string) => ({ type: 'event_msg', payload: { type: 'thread_goal_updated', threadId: sid, goal: { threadId: sid, objective: GOAL_COMMAND_OBJECTIVE } } });
    const sid = (n: number) => `01a1600${n}-0000-7000-8000-000000000000`;
    type Row = { name: string | null; title: string; fum: string; preview: string };
    const FIXTURES: Array<{ name: string; sid: string; records: unknown[]; row: Row; listed: boolean }> = [
      { name: 'external', sid: sid(1), listed: true,
        records: [meta(sid(1)), dc(sid(1), 'external prompt', 't1')],
        row: { name: 'External task', title: 'external prompt', fum: 'external prompt', preview: 'external prompt' } },
      { name: 'external, later envelope in mutable fields', sid: sid(2), listed: true,
        records: [meta(sid(2)), dc(sid(2), 'external first prompt', 't1'), done('t1'), dc(sid(2), ENV, 't2')],
        row: { name: ENV, title: ENV, fum: ENV, preview: 'external first prompt' } },
      { name: 'botmux', sid: sid(3), listed: false,
        records: [meta(sid(3)), dc(sid(3), ENV, 't1')],
        row: { name: '确认收到消息', title: ENV, fum: ENV, preview: ENV } },
      { name: 'botmux, renamed and continued cleanly', sid: sid(4), listed: false,
        records: [meta(sid(4)), dc(sid(4), ENV, 't1'), done('t1'), dc(sid(4), 'plain follow-up', 't2')],
        row: { name: 'Totally normal name', title: 'plain follow-up', fum: 'plain follow-up', preview: ENV } },
      { name: 'v3 goal worker that later got a normal turn', sid: sid(5), listed: false,
        records: [meta(sid(5)), goal(sid(5)), dc(sid(5), 'status?', 't2')],
        row: { name: 'Read $BOTMUX_GOAL_PATH. Write files', title: 'status?', fum: 'status?', preview: GOAL_COMMAND_OBJECTIVE } },
      { name: 'no preview (old row), weak botmux first turn', sid: sid(6), listed: false,
        records: [meta(sid(6)), item(ENV, 't1')],
        row: { name: null, title: ENV, fum: ENV, preview: '' } },
      { name: 'no preview (old row), weak external first turn', sid: sid(7), listed: true,
        records: [meta(sid(7)), item('legacy external prompt', 't1')],
        row: { name: null, title: 'Legacy title', fum: 'legacy external prompt', preview: '' } },
      { name: 'no preview, first_user_message rewritten to a later envelope', sid: sid(8), listed: true,
        records: [meta(sid(8)), dc(sid(8), 'external first prompt', 't1'), done('t1'), dc(sid(8), ENV, 't2')],
        row: { name: null, title: ENV, fum: ENV, preview: '' } },
      { name: 'no preview, first_user_message rewritten to a later clean input', sid: sid(9), listed: false,
        records: [meta(sid(9)), dc(sid(9), ENV, 't1'), done('t1'), dc(sid(9), 'plain follow-up', 't2')],
        row: { name: null, title: 'plain follow-up', fum: 'plain follow-up', preview: '' } },
    ];

    const sessionsDir = join(traeHome, 'cli', 'sessions', '2026', '10', '20');
    mkdirSync(sessionsDir, { recursive: true });
    const db = openDatabaseSyncNow(join(traeHome, 'cli', 'state_5.sqlite'))!;
    db.exec([
      'CREATE TABLE threads (',
      '  id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, updated_at INTEGER NOT NULL, cwd TEXT NOT NULL,',
      "  title TEXT NOT NULL, first_user_message TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '', name TEXT",
      ');',
    ].join('\n'));
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    FIXTURES.forEach((f, i) => {
      const path = join(sessionsDir, `rollout-2026-10-20T10-00-0${i}-${f.sid}.jsonl`);
      writeFileSync(path, f.records.map(r => JSON.stringify(r)).join('\n') + '\n');
      insert.run(f.sid, path, 1_792_400_000 + i, '/root/project', f.row.title, f.row.fum, f.row.preview, f.row.name);
    });
    db.close();

    const withIndex = await createTraexAdapter('/bin/traex').listResumableSessions!({ limit: 20 });
    const rolloutOnly = await discoverRolloutSessions(traeSessionsRoot(), 20, undefined, {
      dialect: 'traex',
      userInputTexts: traexRolloutUserInputs,
      sessionIdFromPath: traexSessionIdFromRolloutPath,
    });

    const expected = FIXTURES.filter(f => f.listed).map(f => f.sid).sort();
    expect(withIndex.map(s => s.cliSessionId).sort()).toEqual(expected);
    expect(rolloutOnly.map(s => s.cliSessionId).sort()).toEqual(expected);
    // The envelope in the external thread's mutable fields is never displayed.
    expect(withIndex.find(s => s.cliSessionId === sid(2))?.title).toBe('external first prompt');
  });
});
