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
import { afterEach, describe, expect, it, vi } from 'bun:test';

import {
  createReasonixAdapter,
  findSessionStemForCli,
  isDescendantOf,
  pidBelongsToProcessTree,
  reasonixSessionsDir,
} from '../src/adapters/cli/reasonix.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

// A real Reasonix transcript stem: start timestamp + model slug. `--resume`
// accepts this, NOT the `session_<hmac>` machine id from `session list --json`.
const STEM = '20260803-121945.387040142-deepseek-v4-flash';

/** Build a fake `~/.reasonix` tree and return the sessions dir for `cwd`. */
function makeSessionRoot(): { root: string; cwd: string; sessionsDir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'reasonix-')));
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  const sessionsDir = reasonixSessionsDir(cwd, join(root, '.reasonix'));
  mkdirSync(sessionsDir, { recursive: true });
  return { root, cwd, sessionsDir };
}

function writeLease(sessionsDir: string, stem: string, pid: number): void {
  writeFileSync(join(sessionsDir, `${stem}.jsonl.lease.json`), JSON.stringify({ pid }));
  writeFileSync(join(sessionsDir, `${stem}.jsonl`), '');
}

describe('Reasonix session capture', () => {
  const children = new Set<ChildProcess>();
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
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

  it('picks the lease-owned stem when another session shares the cwd', () => {
    const { root, sessionsDir } = makeSessionRoot();
    try {
      writeLease(sessionsDir, STEM, process.pid);
      writeLease(sessionsDir, '20260803-131010.100000000-deepseek-v4-pro', 999_999_999);

      const stem = findSessionStemForCli(sessionsDir, process.pid);
      expect(stem).toBe(STEM);
      // Regression guard: `session list --json` ids are unusable with --resume.
      expect(stem?.startsWith('session_')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns undefined when no lease belongs to the CLI process tree', () => {
    const { root, sessionsDir } = makeSessionRoot();
    try {
      writeLease(sessionsDir, STEM, 999_999_999);
      expect(findSessionStemForCli(sessionsDir, process.pid)).toBeUndefined();
      expect(findSessionStemForCli(join(root, 'missing'), process.pid)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stays armed until the lease appears, then captures once', async () => {
    const { root, cwd, sessionsDir } = makeSessionRoot();
    const adapter = createReasonixAdapter('/bin/reasonix');
    const pty = {
      sendText: vi.fn(() => true),
      sendSpecialKeys: vi.fn(() => true),
      cliCwd: cwd,
      cliPid: process.pid,
    } as unknown as PtyHandle;
    try {
      process.env.HOME = root;
      adapter.buildArgs({ resume: false, sessionId: 's1', workingDir: cwd } as any);

      // Lease not on disk yet: the capture must not disarm itself.
      await expect(adapter.writeInput(pty, 'first')).resolves.toBeUndefined();

      writeLease(sessionsDir, STEM, process.pid);
      await expect(adapter.writeInput(pty, 'second')).resolves.toEqual({
        submitted: true,
        cliSessionId: STEM,
      });
      // Captured once; later turns report nothing new.
      await expect(adapter.writeInput(pty, 'third')).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips capture when resuming a known session', async () => {
    const { root, cwd, sessionsDir } = makeSessionRoot();
    const adapter = createReasonixAdapter('/bin/reasonix');
    const pty = {
      sendText: vi.fn(() => true),
      sendSpecialKeys: vi.fn(() => true),
      cliCwd: cwd,
      cliPid: process.pid,
    } as unknown as PtyHandle;
    try {
      process.env.HOME = root;
      writeLease(sessionsDir, STEM, process.pid);
      expect(adapter.buildArgs({
        resume: true,
        resumeSessionId: STEM,
        sessionId: 's1',
        workingDir: cwd,
      } as any)).toEqual(['--yolo', '--resume', STEM]);

      await expect(adapter.writeInput(pty, 'hello')).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves the resume command from the captured stem', () => {
    const adapter = createReasonixAdapter('/bin/reasonix');
    expect(adapter.buildResumeCommand!({ cliSessionId: STEM } as any)).toBe(`reasonix --resume ${STEM}`);
    expect(adapter.buildResumeCommand!({} as any)).toBeNull();
  });

  it('probes the transcript file to decide whether a resume target survives', () => {
    const { root, cwd, sessionsDir } = makeSessionRoot();
    const adapter = createReasonixAdapter('/bin/reasonix');
    try {
      writeFileSync(join(sessionsDir, `${STEM}.jsonl`), '');
      const check = (opts: Record<string, unknown>) => adapter.checkResumeTargetExists!({
        sessionId: 's1',
        ...opts,
      } as any);

      process.env.HOME = root;
      expect(check({ cliSessionId: STEM, workingDir: cwd })).toBe(true);
      expect(check({ cliSessionId: '20260101-000000.000000000-gone', workingDir: cwd })).toBe(false);
      // Unknown inputs stay undefined so the worker keeps its own judgement.
      expect(check({ workingDir: cwd })).toBeUndefined();
      expect(check({ cliSessionId: STEM })).toBeUndefined();
      expect(check({ cliSessionId: join(sessionsDir, `${STEM}.jsonl`), workingDir: cwd })).toBeUndefined();
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
