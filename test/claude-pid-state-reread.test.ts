/**
 * Claude rewrites `<config>/sessions/<pid>.json` in place on every state change
 * — the native build writes then ftruncates, a Node writer truncates then
 * writes — and it does so on the busy→idle edge the worker judges a finished
 * turn on. A read landing inside that rewrite must not be taken for "no
 * record": the unread-turn check then told the group a reply was lost that the
 * next bridge tick delivered (worker-claude-clear-restore.integration flaking
 * in CI).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeJsonlPathForSession,
  claudePidStatePath,
  resolveJsonlFromPid,
  setClaudePidStateRereadSleepForTests,
} from '../src/adapters/cli/claude-code.js';

let root: string;
let dataDir: string;
let cwd: string;
let recordPath: string;
const pid = process.pid;
const before = randomUUID();
const after = randomUUID();

// No procStart: the record is matched on cwd, so no /proc is needed.
const record = (sessionId: string, status: string) =>
  JSON.stringify({ pid, sessionId, cwd, kind: 'interactive', status, updatedAt: Date.now() });

/** Every sleep the reader asks for; `onSleep` runs inside it, the way the
 *  writer progresses while the reader waits. */
function watchSleeps(onSleep: (call: number) => void = () => {}): number[] {
  const calls: number[] = [];
  setClaudePidStateRereadSleepForTests(ms => {
    calls.push(ms);
    onSleep(calls.length);
  });
  return calls;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-pid-state-'));
  dataDir = join(root, 'config');
  cwd = join(root, 'work');
  mkdirSync(cwd);
  recordPath = claudePidStatePath(pid, dataDir);
  mkdirSync(dirname(recordPath), { recursive: true });
});

afterEach(() => {
  setClaudePidStateRereadSleepForTests(null);
  rmSync(root, { recursive: true, force: true });
});

describe('resolveJsonlFromPid reads through a record Claude is rewriting', () => {
  it('a native build between write and ftruncate: the new record followed by the old tail', () => {
    const old = record(before, 'busy waiting on a long-running background task');
    const next = record(after, 'idle');
    expect(next.length).toBeLessThan(old.length);
    writeFileSync(recordPath, next + old.slice(next.length));
    const sleeps = watchSleeps(() => writeFileSync(recordPath, next));

    expect(resolveJsonlFromPid(pid, cwd, dataDir)).toEqual({
      path: claudeJsonlPathForSession(after, cwd, dataDir),
      cliSessionId: after,
    });
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it('a truncate-first writer between truncate and write: an empty record', () => {
    writeFileSync(recordPath, '');
    watchSleeps(() => writeFileSync(recordPath, record(after, 'idle')));

    expect(resolveJsonlFromPid(pid, cwd, dataDir)?.cliSessionId).toBe(after);
  });

  it('a writer that needs more than one re-read is still waited for', () => {
    writeFileSync(recordPath, '');
    watchSleeps(call => { if (call === 2) writeFileSync(recordPath, record(after, 'idle')); });

    expect(resolveJsonlFromPid(pid, cwd, dataDir)?.cliSessionId).toBe(after);
  });

  it('a record that never parses is given up on after a bounded wait', () => {
    writeFileSync(recordPath, '{"pid":');
    const sleeps = watchSleeps();

    expect(resolveJsonlFromPid(pid, cwd, dataDir)).toBeNull();
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(1_000);
  });

  it('a pid with no record is answered at once, without waiting', () => {
    const sleeps = watchSleeps();

    expect(resolveJsonlFromPid(pid, cwd, dataDir)).toBeNull();
    expect(sleeps).toEqual([]);
  });

  it('a complete record is read once, without waiting', () => {
    writeFileSync(recordPath, record(after, 'idle'));
    const sleeps = watchSleeps();

    expect(resolveJsonlFromPid(pid, cwd, dataDir)?.cliSessionId).toBe(after);
    expect(sleeps).toEqual([]);
  });
});

describe.skipIf(process.platform !== 'linux')('resolveJsonlFromPid after an in-session cwd change', () => {
  function publishMovedState(sessionId = after, procStartOverride?: string) {
    const movedCwd = join(root, 'moved-work');
    mkdirSync(movedCwd);
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const procStart = procStartOverride ?? stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19];
    writeFileSync(recordPath, JSON.stringify({ pid, sessionId, cwd: movedCwd, procStart }));
    return claudeJsonlPathForSession(sessionId, movedCwd, dataDir);
  }

  function transcript(sessionId = after) {
    const path = claudeJsonlPathForSession(sessionId, cwd, dataDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"type":"user","message":{"role":"user","content":"confirm this input"}}\n');
    return path;
  }

  it('keeps reading the existing same-session transcript when only the pid cwd moved', () => {
    const originalPath = transcript();
    publishMovedState();
    const result = resolveJsonlFromPid(pid, cwd, dataDir);
    expect(result).toEqual({ path: originalPath, cliSessionId: after });
    expect(readFileSync(result!.path, 'utf8')).toContain('confirm this input');
  });

  it('prefers the current-cwd transcript when Claude actually writes it', () => {
    transcript();
    const currentPath = publishMovedState();
    mkdirSync(dirname(currentPath), { recursive: true });
    writeFileSync(currentPath, 'current transcript');
    expect(resolveJsonlFromPid(pid, cwd, dataDir)).toEqual({ path: currentPath, cliSessionId: after });
  });

  it('retains the projected path for a cold session that has not written any transcript', () => {
    const currentPath = publishMovedState();
    expect(resolveJsonlFromPid(pid, cwd, dataDir)).toEqual({ path: currentPath, cliSessionId: after });
  });

  it('does not fall back to a different session after a native session rotation', () => {
    transcript(before);
    const currentPath = publishMovedState(after);
    expect(resolveJsonlFromPid(pid, cwd, dataDir)).toEqual({ path: currentPath, cliSessionId: after });
  });

  it('does not let an existing transcript bypass the pid-reuse identity guard', () => {
    transcript();
    publishMovedState(after, 'invalid-start-time');
    expect(resolveJsonlFromPid(pid, cwd, dataDir)).toBeNull();
  });

  it('finds the original transcript under Claude\'s truncated long-cwd bucket', () => {
    cwd = join(root, 'long-work', ...Array(6).fill('x'.repeat(40)));
    mkdirSync(cwd, { recursive: true });
    cwd = realpathSync(cwd);
    const slug = cwd.replace(/[^A-Za-z0-9-]/g, '-');
    const originalPath = join(dataDir, 'projects', `${slug.slice(0, 200)}-abc123`, `${after}.jsonl`);
    mkdirSync(dirname(originalPath), { recursive: true });
    writeFileSync(originalPath, 'original transcript');
    publishMovedState();
    expect(resolveJsonlFromPid(pid, cwd, dataDir)).toEqual({ path: originalPath, cliSessionId: after });
  });

  it('ignores a current-cwd directory named like a JSONL instead of hiding the original file', () => {
    const originalPath = transcript();
    const currentPath = publishMovedState();
    mkdirSync(currentPath, { recursive: true });
    expect(resolveJsonlFromPid(pid, cwd, dataDir)).toEqual({ path: originalPath, cliSessionId: after });
  });

  it('does not use a directory as the original-cwd transcript fallback', () => {
    const originalPath = claudeJsonlPathForSession(after, cwd, dataDir);
    mkdirSync(originalPath, { recursive: true });
    const currentPath = publishMovedState();
    expect(resolveJsonlFromPid(pid, cwd, dataDir)).toEqual({ path: currentPath, cliSessionId: after });
  });
});
