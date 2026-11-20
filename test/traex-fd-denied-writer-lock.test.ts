/**
 * A TRAE process whose fd table procfs refuses must still be bound to its own
 * thread — and only its own.
 *
 * Field case: a non-root botmux on a host whose /usr/bin/bwrap is setuid root
 * (Debian 10, bwrap 0.3.1). That bwrap creates the sandbox's user namespace as
 * root, so procfs lists /proc/<traex>/fd but refuses every link (EACCES), the
 * fd-based ownership proof came back empty, no turn was ever bound and every
 * reply was reported "not collected".
 *
 * The refusal here is the kernel's, not a mock. Target and reader run with the
 * same capabilities (as root both give up CAP_SYS_PTRACE), so the target's
 * dumpable flag alone decides: non-dumpable, root is refused the links (the
 * field shape) and an ordinary user the whole fd directory. The ownership
 * evidence that replaces it — the writer flock TRAE holds per thread — is read
 * from the real /proc/locks.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { findTraexWriterLockSessionIdsByPid, procLocksExclusiveHoldsOf } from '../src/services/traex-transcript.js';
import { tsEvalArgs, tsRunnerPrefix } from './helpers/ts-runner.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const linux = process.platform === 'linux';
const isRoot = process.getuid?.() === 0;
const CAP_SYS_PTRACE = 19n;
const holdsPtrace = linux && (() => {
  const capEff = /^CapEff:\s*([0-9a-f]+)$/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1];
  return capEff !== undefined && ((BigInt(`0x${capEff}`) >> CAP_SYS_PTRACE) & 1n) === 1n;
})();
// Run target and reader without CAP_SYS_PTRACE, which would read anything.
const dropPtrace = holdsPtrace ? ['setpriv', '--bounding-set', '-sys_ptrace', '--'] : [];
const runnable = linux
  && spawnSync('python3', ['-I', '-c', 'import ctypes, fcntl'], { stdio: 'ignore' }).status === 0
  && (dropPtrace.length === 0 || spawnSync(dropPtrace[0]!, [...dropPtrace.slice(1), 'true'], { stdio: 'ignore' }).status === 0);

const OWN = '01a1f81d-0000-7000-8000-000000000001';
const SUBAGENT = '01a1f81d-0000-7000-8000-000000000002';
const SIBLING = '01a1f81d-0000-7000-8000-000000000003';
const STALE = '01a1f81d-0000-7000-8000-000000000004';

// Holds an exclusive flock on each lock file and keeps each rollout open, as
// TRAE does. Non-dumpable when asked; SIGUSR1 makes it dumpable (readable)
// again. Lives until its stdin closes.
const FAKE_TRAEX = `
import ctypes, fcntl, os, signal, sys
libc = ctypes.CDLL(None)
held = []
for p in filter(None, sys.argv[1].split(',')):
    f = open(p, 'rb'); fcntl.flock(f, fcntl.LOCK_EX); held.append(f)
held += [open(p, 'rb') for p in filter(None, sys.argv[2].split(','))]
signal.signal(signal.SIGUSR1, lambda *_: libc.prctl(4, 1, 0, 0, 0))
if os.environ.get('FAKE_TRAEX_NONDUMPABLE') == '1':
    libc.prctl(4, 0, 0, 0, 0)  # PR_SET_DUMPABLE, 0
print('ready', flush=True)
sys.stdin.read()
`;

interface ReaderResult {
  probe: { status: string; code?: string; stage?: string };
  legacy: string[] | null;
  owned: string[] | null;
  observed: { path: string; cliSessionId: string } | null;
  source: { via: string; sessionIds?: string[] } | null;
  ownedWithoutLockTable: string[] | null | 'n/a';
  afterReadable: { probe: string; denial: unknown; via: string | null } | 'n/a';
}

describe.skipIf(!runnable)('TRAE ownership when procfs refuses the fd table', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'traex-fd-denied-')));
  const traeHome = join(root, '.trae');
  const lockDir = join(traeHome, 'cli', 'thread-writer-locks');
  const day = join(traeHome, 'cli', 'sessions', '2026', '11', '20');
  const lock = (id: string) => join(lockDir, `${id}.lock`);
  const rollout = (id: string) => join(day, `rollout-2026-11-20T16-41-08-${id}.jsonl`);
  const children: ChildProcess[] = [];
  let targetPid: number;
  let result: ReaderResult;

  async function holder(locks: string[], open: string[], nonDumpable: boolean): Promise<ChildProcess> {
    const argv = [...dropPtrace, 'python3', '-I', '-c', FAKE_TRAEX, locks.join(','), open.join(',')];
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, FAKE_TRAEX_NONDUMPABLE: nonDumpable ? '1' : '0' },
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`fake traex exited early (${code})`)));
      child.stdout!.once('data', () => resolve());
    });
    return child;
  }

  beforeAll(async () => {
    mkdirSync(lockDir, { recursive: true });
    mkdirSync(day, { recursive: true });
    const meta = (id: string, threadSource: string) => JSON.stringify({
      timestamp: '2026-11-20T08:41:08.000Z',
      type: 'session_meta',
      payload: { id, timestamp: '2026-11-20T08:41:08.000Z', thread_source: threadSource },
    }) + '\n';
    for (const id of [OWN, SUBAGENT, SIBLING, STALE]) writeFileSync(lock(id), '');
    writeFileSync(rollout(OWN), meta(OWN, 'user'));
    writeFileSync(rollout(SUBAGENT), meta(SUBAGENT, 'subagent'));
    writeFileSync(rollout(SIBLING), meta(SIBLING, 'user'));
    writeFileSync(rollout(STALE), meta(STALE, 'user'));

    // The session's TRAE: its top-level thread plus a subagent thread.
    const target = await holder([lock(OWN), lock(SUBAGENT)], [rollout(OWN), rollout(SUBAGENT)], true);
    targetPid = target.pid!;
    // Another TRAE pane on the same TRAE_HOME, readable — its thread is not ours.
    await holder([lock(SIBLING)], [rollout(SIBLING)], false);

    const reader = `
      process.env.TRAE_HOME = ${JSON.stringify(traeHome)};
      const files = await import('./src/utils/process-open-files.js');
      const t = await import('./src/services/traex-transcript.js');
      const pid = ${targetPid};
      const probeOf = () => typeof files.probeProcessOpenFiles === 'function'
        ? files.probeProcessOpenFiles(pid)
        : { status: files.listProcessOpenFiles(pid) === undefined ? 'unavailable' : 'listed' };
      const probe = probeOf();
      const legacy = files.listProcessOpenFiles(pid) ?? null;
      const owned = t.findTraexRolloutSetByPid(pid);
      const observed = t.findTraexRolloutByPid(pid) ?? null;
      const source = typeof t.traexProcessFileSource === 'function' ? t.traexProcessFileSource(pid) ?? null : null;
      let ownedWithoutLockTable = 'n/a';
      if (typeof t.__testOnly_setProcLocksPath === 'function') {
        t.__testOnly_setProcLocksPath(${JSON.stringify(join(root, 'no-lock-table'))});
        const set = t.findTraexRolloutSetByPid(pid);
        ownedWithoutLockTable = set ? [...set] : null;
        t.__testOnly_setProcLocksPath(undefined);
      }
      let afterReadable = 'n/a';
      if (typeof files.processOpenFilesDenial === 'function') {
        process.kill(pid, 'SIGUSR1');
        let now = probeOf();
        for (let i = 0; i < 100 && now.status !== 'ok'; i++) {
          await new Promise(resolve => setTimeout(resolve, 20));
          now = probeOf();
        }
        t.findTraexRolloutSetByPid(pid);
        afterReadable = {
          probe: now.status,
          denial: files.processOpenFilesDenial(pid) ?? null,
          via: t.traexProcessFileSource(pid)?.via ?? null,
        };
      }
      console.log(JSON.stringify({ probe, legacy, owned: owned ? [...owned] : null, observed, source, ownedWithoutLockTable, afterReadable }));
    `;
    const { command, prefixArgs } = tsRunnerPrefix();
    const argv = [...dropPtrace, command, ...prefixArgs, ...tsEvalArgs(reader).args];
    const run = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 60_000 });
    const line = String(run.stdout ?? '').trim().split('\n').filter(l => l.startsWith('{')).pop();
    if (!line) throw new Error(`reader produced no result: ${String(run.stderr ?? '')}`);
    result = JSON.parse(line) as ReaderResult;
  }, 90_000);

  afterAll(() => {
    for (const child of children) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  });

  it('really is refused by the kernel here', () => {
    expect(result.probe).toMatchObject({ status: 'denied', stage: isRoot ? 'readlink' : 'readdir' });
    // The shared enumerator keeps its old answer for every other CLI.
    expect(result.legacy).toEqual(isRoot ? [] : null);
  });

  it('binds the top-level thread whose writer lock the process holds', () => {
    expect(result.owned).toEqual([OWN]);
    expect(result.observed).toEqual({ path: rollout(OWN), cliSessionId: OWN });
    expect(result.source?.via).toBe('writer-lock');
    expect([...(result.source?.sessionIds ?? [])].sort()).toEqual([OWN, SUBAGENT]);
  });

  it('never claims a lock another process holds or nobody holds', () => {
    expect(result.owned).not.toContain(SIBLING);
    expect(result.owned).not.toContain(STALE);
    expect(result.source?.sessionIds).not.toContain(SIBLING);
    expect(result.source?.sessionIds).not.toContain(STALE);
  });

  it('cannot prove ownership either way when the lock table is unreadable', () => {
    expect(result.ownedWithoutLockTable).toBeNull();
  });

  it('forgets the refusal once the process is readable again', () => {
    expect(result.afterReadable).toEqual({ probe: 'ok', denial: null, via: 'fd' });
  });

  it('matches a held lock to a lock file by device, or by TRAE\'s owner record where devices disagree', () => {
    const held = readFileSync('/proc/locks', 'utf8').split('\n')
      .filter(line => procLocksExclusiveHoldsOf(line, targetPid).length > 0);
    const table = (name: string, lines: string[]) => {
      const path = join(root, name);
      writeFileSync(path, lines.join('\n') + '\n');
      return path;
    };
    const exact = table('locks-exact', held);
    // The same inode numbers under another device number: what btrfs (per-
    // subvolume st_dev) or an overlay without xino shows — or an unrelated
    // filesystem's file with a colliding inode.
    const elsewhere = table('locks-elsewhere', held.map(line => line.replace(
      / ([0-9a-f]+):([0-9a-f]+):(\d+) /i,
      (_all, major: string, minor: string, inode: string) => ` ${(parseInt(major, 16) + 1).toString(16)}:${minor}:${inode} `,
    )));
    expect(findTraexWriterLockSessionIdsByPid(targetPid, { procLocksPath: exact, lockDir })?.sort()).toEqual([OWN, SUBAGENT]);
    expect(findTraexWriterLockSessionIdsByPid(targetPid, { procLocksPath: elsewhere, lockDir })).toEqual([]);

    // TRAE records its writer's start time beside each lock (pid-namespace
    // independent): it settles a device mismatch only when it names this pid.
    const stat = readFileSync(`/proc/${targetPid}/stat`, 'utf8');
    const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const owner = join(lockDir, `${OWN}.owner.json`);
    try {
      writeFileSync(owner, JSON.stringify({ pid: 3, process_name: 'TRAE CLI', process_start_id: `linux:${Number(startTime) + 1}` }));
      expect(findTraexWriterLockSessionIdsByPid(targetPid, { procLocksPath: elsewhere, lockDir })).toEqual([]);
      writeFileSync(owner, JSON.stringify({ pid: 3, process_name: 'TRAE CLI', process_start_id: `linux:${startTime}` }));
      expect(findTraexWriterLockSessionIdsByPid(targetPid, { procLocksPath: elsewhere, lockDir })).toEqual([OWN]);
    } finally {
      unlinkSync(owner);
    }

    // An unreadable lock table proves nothing either way.
    expect(findTraexWriterLockSessionIdsByPid(targetPid, { procLocksPath: join(root, 'absent'), lockDir })).toBeUndefined();
  });
});

describe('procLocksExclusiveHoldsOf', () => {
  it('keeps only the exclusive FLOCK / POSIX locks the pid holds', () => {
    const table = [
      '1: FLOCK  ADVISORY  WRITE 410913 fe:01:4084764 0 EOF',
      '1: -> FLOCK  ADVISORY  WRITE 410913 fe:01:4084765 0 EOF',
      '2: POSIX  ADVISORY  WRITE 410913 103:02:77 0 EOF',
      '3: POSIX  ADVISORY  READ 410913 fe:01:9 128 128',
      '4: OFDLCK ADVISORY  WRITE -1 fe:01:10 0 EOF',
      '5: FLOCK  ADVISORY  WRITE 4109130 fe:01:11 0 EOF',
      '6: FLOCK  ADVISORY  READ 410913 fe:01:12 0 EOF',
      '',
    ].join('\n');
    expect(procLocksExclusiveHoldsOf(table, 410913)).toEqual([
      { major: 0xfe, minor: 1, inode: 4084764n },
      { major: 0x103, minor: 2, inode: 77n },
    ]);
    // OFD locks carry no holder pid.
    expect(procLocksExclusiveHoldsOf(table, -1)).toEqual([]);
  });
});

describe('worker: TRAE fd refusal log', () => {
  it('says once per pid and outcome that procfs refused the fd table, and what located the thread', () => {
    const denial = { code: 'EACCES', stage: 'readlink' };
    let source: Record<string, unknown> = { via: 'writer-lock', denial, sessionIds: [OWN], exclusiveHolds: 2 };
    const scope: Record<string, any> = {
      traexProcessFileSource: vi.fn(() => source),
      setuidRootBwrap: () => '/usr/bin/bwrap',
      log: vi.fn(),
      traexFileSourceLogKey: undefined,
    };
    const note = loadWorkerFunction<(pid: number) => void>('noteTraexProcessFileSource', scope);
    const lines = () => scope.log.mock.calls.map(([line]: [string]) => line);
    note(410913);
    note(410913);
    expect(lines()).toHaveLength(1);
    for (const fact of ['410913', 'EACCES', '/usr/bin/bwrap', '/proc/locks', OWN]) expect(lines()[0]).toContain(fact);

    // Locks held, none of them a thread lock here: a different outcome, said once.
    source = { via: 'writer-lock', denial, sessionIds: [], exclusiveHolds: 3 };
    note(410913);
    note(410913);
    expect(lines()).toHaveLength(2);
    expect(lines()[1]).toContain('3');
    source = { via: 'writer-lock', denial, sessionIds: [], exclusiveHolds: 0 };
    note(410913);
    expect(lines()).toHaveLength(3);
    expect(lines()[2]).not.toBe(lines()[1]);

    source = { via: 'none', denial };
    note(410913);
    expect(lines()).toHaveLength(4);
    source = { via: 'fd' };
    note(410914);
    expect(lines()).toHaveLength(4);
  });
});
