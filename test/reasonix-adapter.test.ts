import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(), execFileSync: actual.execFileSync };
});

import { execFile } from 'node:child_process';
import {
  captureSessionIdForCli,
  createReasonixAdapter,
  isDescendantOf,
  pidBelongsToProcessTree,
  reasonixSessionsDir,
} from '../src/adapters/cli/reasonix.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

describe('Reasonix session capture', () => {
  const children = new Set<ChildProcess>();

  afterEach(() => {
    vi.mocked(execFile).mockReset();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    children.clear();
  });

  it('derives the session bucket from the canonical cwd', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'reasonix-cwd-')));
    const project = join(root, 'project');
    const link = join(root, 'project-link');
    try {
      mkdirSync(project);
      symlinkSync(project, link);
      expect(reasonixSessionsDir(link, '/state')).toBe(
        join('/state/projects', project.replaceAll('/', '-'), 'sessions'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('matches the lease-owned session when a newer same-cwd session exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reasonix-capture-'));
    const cwd = join(root, 'project');
    mkdirSync(cwd);
    const sessionsDir = reasonixSessionsDir(cwd, root);
    mkdirSync(sessionsDir, { recursive: true });
    const currentCreatedAt = '2026-08-03T11:23:44.138167478Z';
    const newerCreatedAt = '2026-08-03T12:20:02.416748963Z';
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n');setInterval(()=>{},1000)"], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    children.add(child);
    if (!child.stdout) throw new Error('child stdout unavailable');
    await once(child.stdout, 'data');
    if (!child.pid) throw new Error('child pid unavailable');

    try {
      writeFileSync(join(sessionsDir, 'current.jsonl.lease.json'), JSON.stringify({ pid: child.pid }));
      writeFileSync(join(sessionsDir, 'current.jsonl.meta'), JSON.stringify({ created_at: currentCreatedAt }));
      writeFileSync(join(sessionsDir, 'newer.jsonl.lease.json'), JSON.stringify({ pid: 999_999_999 }));
      writeFileSync(join(sessionsDir, 'newer.jsonl.meta'), JSON.stringify({ created_at: newerCreatedAt }));
      vi.mocked(execFile).mockImplementation(((_bin, _args, _opts, callback) => {
        callback(null, JSON.stringify({
          sessions: [
            { id: 'session_newer', created_at: newerCreatedAt },
            { id: 'session_current', created_at: currentCreatedAt },
          ],
        }));
      }) as any);

      await expect(captureSessionIdForCli('/bin/reasonix', cwd, process.pid, {
        sessionRoot: root,
        tries: 1,
      })).resolves.toBe('session_current');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns undefined when no lease belongs to the CLI process tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reasonix-capture-'));
    const cwd = join(root, 'project');
    mkdirSync(cwd);
    vi.mocked(execFile).mockImplementation(((_bin, _args, _opts, callback) => {
      callback(null, JSON.stringify({ sessions: [{ id: 'session_other' }] }));
    }) as any);
    try {
      await expect(captureSessionIdForCli('/bin/reasonix', cwd, process.pid, {
        sessionRoot: root,
        tries: 1,
      })).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a dropped text or Enter write as unsubmitted', async () => {
    const textDropped = createReasonixAdapter('/bin/reasonix');
    const enterDropped = createReasonixAdapter('/bin/reasonix');
    const textPty = {
      sendText: vi.fn(() => false),
      sendSpecialKeys: vi.fn(),
    } as unknown as PtyHandle;
    const enterPty = {
      sendText: vi.fn(() => true),
      sendSpecialKeys: vi.fn(() => false),
    } as unknown as PtyHandle;

    await expect(textDropped.writeInput(textPty, 'hello')).resolves.toEqual({ submitted: false });
    await expect(enterDropped.writeInput(enterPty, 'hello')).resolves.toEqual({ submitted: false });
    expect(textPty.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('recognizes self and child processes', async () => {
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n');setInterval(()=>{},1000)"], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    children.add(child);
    if (!child.stdout) throw new Error('child stdout unavailable');
    await once(child.stdout, 'data');
    if (!child.pid) throw new Error('child pid unavailable');

    expect(isDescendantOf(process.pid, process.pid)).toBe(true);
    expect(isDescendantOf(child.pid, process.pid)).toBe(true);
    expect(pidBelongsToProcessTree(child.pid, process.pid)).toBe(true);
    expect(pidBelongsToProcessTree(999_999_999, process.pid)).toBe(false);
  });

  it.runIf(process.platform === 'linux')('matches a PID reported inside a nested namespace', () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'reasonix-proc-'));
    const rootPid = process.pid;
    const childPid = rootPid + 1_000_000;
    try {
      mkdirSync(join(procRoot, String(rootPid), 'task', String(rootPid)), { recursive: true });
      mkdirSync(join(procRoot, String(childPid), 'task', String(childPid)), { recursive: true });
      writeFileSync(join(procRoot, String(rootPid), 'status'), `NSpid:\t${rootPid}\t1\n`);
      writeFileSync(join(procRoot, String(rootPid), 'task', String(rootPid), 'children'), String(childPid));
      writeFileSync(join(procRoot, String(childPid), 'status'), `NSpid:\t${childPid}\t42\n`);
      writeFileSync(join(procRoot, String(childPid), 'task', String(childPid), 'children'), '');

      expect(pidBelongsToProcessTree(42, rootPid, procRoot)).toBe(true);
    } finally {
      rmSync(procRoot, { recursive: true, force: true });
    }
  });
});
