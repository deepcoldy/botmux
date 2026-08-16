/**
 * Subtree enumeration against a synthetic /proc, so each of the three signals can
 * be isolated (a real /proc cannot be made to hold a chosen shape).
 *
 * The scanner's CONTRACT, and what each group below pins down:
 *   - enumeration    the three signals (pgid / env nonce / ppid chain) and the
 *                    exclude guard
 *   - fail-closed    only ENOENT is "raced away"; every other read/parse error
 *                    fails the WHOLE scan rather than shrinking the result
 *   - evidence       a clean scan is a diagnostic signal, never boundary proof
 *   - identity       pid + boot id + starttime, so a recycled pid is detected
 *   - signalling     kill(-pid) happens ONLY after the identity re-verifies
 *   - platform gate  off-Linux, /proc means nothing, so scanning is refused
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MOJO_TREE_NONCE_ENV,
  mojoTreeScanSupported,
  quiescenceFromScan,
  readProcessIdentity,
  sameProcessIdentity,
  scanMojoTree,
  signalTurnTreeGroup,
} from '../src/adapters/backend/mojo-process-tree.js';

let procRoot: string;
const NONCE = 'botmux-mojo-deadbeef';
const BOOT_ID = '11111111-2222-3333-4444-555555555555';

/** 18 leading fields then starttime, matching the real field-22 layout. */
function statLine(
  pid: number, comm: string, ppid: number, pgid: number, starttime: number, state = 'S',
): string {
  const between = Array.from({ length: 16 }, () => '0').join(' ');
  // pid (comm) state ppid pgid <16 filler fields> starttime
  return `${pid} (${comm}) ${state} ${ppid} ${pgid} ${between} ${starttime}`;
}

function proc(
  pid: number,
  opts: { ppid: number; pgid: number; comm?: string; env?: string; starttime?: number; stat?: string; state?: string },
): void {
  const dir = join(procRoot, String(pid));
  mkdirSync(dir, { recursive: true });
  // Field 2 is parenthesised and may itself contain spaces and ')', which is why
  // the parser cuts at the LAST ')' instead of splitting on whitespace.
  writeFileSync(
    join(dir, 'stat'),
    opts.stat ?? statLine(pid, opts.comm ?? 'mojo', opts.ppid, opts.pgid, opts.starttime ?? 1000, opts.state ?? 'S'),
  );
  writeFileSync(join(dir, 'environ'), opts.env ?? '');
}

function writeBootId(value = BOOT_ID): void {
  mkdirSync(join(procRoot, 'sys', 'kernel', 'random'), { recursive: true });
  writeFileSync(join(procRoot, 'sys', 'kernel', 'random', 'boot_id'), `${value}\n`);
}

beforeEach(() => { procRoot = mkdtempSync(join(tmpdir(), 'fake-proc-')); });
afterEach(() => { rmSync(procRoot, { recursive: true, force: true }); });

describe('scanMojoTree enumeration', () => {
  it('finds a descendant that escaped the process group via setsid', () => {
    proc(100, { ppid: 1, pgid: 100 });                                          // turn root
    // New group AND new session, reparented to init: neither pgid nor ppid can
    // reach it. Only the inherited env nonce can.
    proc(200, { ppid: 1, pgid: 200, env: `PATH=/bin\0${MOJO_TREE_NONCE_ENV}=${NONCE}\0` });
    proc(300, { ppid: 1, pgid: 300, env: 'PATH=/bin\0' });                      // unrelated

    const scan = scanMojoTree(100, NONCE, { procRoot });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.members.map(m => m.pid).sort()).toEqual([100, 200]);
    expect(scan.members.find(m => m.pid === 200)?.via).toBe('env');
  });

  it('finds an env-scrubbed descendant through the parent chain', () => {
    proc(100, { ppid: 1, pgid: 100 });
    proc(200, { ppid: 100, pgid: 200, env: '' });   // left the group, wiped its env
    proc(300, { ppid: 200, pgid: 300, env: '' });   // grandchild, same
    const scan = scanMojoTree(100, NONCE, { procRoot });
    if (!scan.ok) throw new Error(`scan failed: ${scan.reason}`);
    expect(scan.members.map(m => m.pid).sort()).toEqual([100, 200, 300]);
  });

  it('never claims the excluded pids', () => {
    // The daemon must never be signalled, even if some other signal matched.
    proc(100, { ppid: 1, pgid: 100 });
    proc(999, { ppid: 100, pgid: 100, env: `${MOJO_TREE_NONCE_ENV}=${NONCE}\0` });
    const scan = scanMojoTree(100, NONCE, { procRoot, excludePids: [999] });
    if (!scan.ok) throw new Error(`scan failed: ${scan.reason}`);
    expect(scan.members.map(m => m.pid)).not.toContain(999);
  });

  it('parses a comm containing spaces and a close paren', () => {
    proc(100, { ppid: 1, pgid: 100, comm: 'we ird) name' });
    const scan = scanMojoTree(100, NONCE, { procRoot });
    if (!scan.ok) throw new Error(`scan failed: ${scan.reason}`);
    expect(scan.members.map(m => m.pid)).toEqual([100]);
  });

  it('reports an empty member list only when the subtree is genuinely gone', () => {
    proc(300, { ppid: 1, pgid: 300, env: 'PATH=/bin\0' });
    const scan = scanMojoTree(100, NONCE, { procRoot });
    if (!scan.ok) throw new Error(`scan failed: ${scan.reason}`);
    expect(scan.members).toEqual([]);
  });
});

describe('scanMojoTree is fail-closed', () => {
  it('fails instead of reporting an empty tree when /proc cannot be read', () => {
    // "cannot enumerate" must never read as "nothing is running": that would let a
    // close claim success on an unscannable host.
    const scan = scanMojoTree(100, NONCE, { procRoot: join(procRoot, 'missing') });
    expect(scan.ok).toBe(false);
    if (scan.ok) return;
    expect(scan.failure.kind).toBe('proc-unreadable');
  });

  it('fails the whole scan when one stat line is unparsable, instead of skipping that pid', () => {
    // A garbled stat line is NOT an absent process. Skipping it silently shrank
    // the member list, which is exactly how a live survivor could be missed.
    proc(100, { ppid: 1, pgid: 100 });
    proc(200, { ppid: 100, pgid: 200, stat: 'no-parens-here at all' });
    const scan = scanMojoTree(100, NONCE, { procRoot });
    expect(scan.ok).toBe(false);
    if (scan.ok) return;
    expect(scan.failure.kind).toBe('proc-entry-unparsable');
    expect(scan.failure).toMatchObject({ pid: 200 });
  });

  it('fails the whole scan when stat has a non-numeric ppid/pgid', () => {
    proc(100, { ppid: 1, pgid: 100 });
    proc(200, { ppid: 100, pgid: 200, stat: '200 (mojo) S notanumber alsonot 0 0' });
    const scan = scanMojoTree(100, NONCE, { procRoot });
    expect(scan.ok).toBe(false);
    if (scan.ok) return;
    expect(scan.failure.kind).toBe('proc-entry-unparsable');
  });

  it('fails the whole scan when a stat file is unreadable for a reason other than ENOENT', () => {
    proc(100, { ppid: 1, pgid: 100 });
    proc(200, { ppid: 100, pgid: 200 });
    // EACCES, not ENOENT: the pid still exists, we just cannot account for it.
    chmodSync(join(procRoot, '200', 'stat'), 0o000);
    // Running as root defeats the permission bit; only assert when it took effect.
    let readable = true;
    try { readFileSync(join(procRoot, '200', 'stat'), 'utf-8'); } catch { readable = false; }
    if (readable) return;
    const scan = scanMojoTree(100, NONCE, { procRoot });
    expect(scan.ok).toBe(false);
    if (scan.ok) return;
    expect(scan.failure.kind).toBe('proc-entry-unreadable');
  });

  it('treats a pid that vanished between readdir and read as a non-member, not a failure', () => {
    // ENOENT is the ONE tolerated error: the process really is gone, so it is
    // genuinely not a member and the scan must still succeed.
    proc(100, { ppid: 1, pgid: 100 });
    const ghost = join(procRoot, '200');
    mkdirSync(ghost, { recursive: true });   // directory with no stat/environ at all
    const scan = scanMojoTree(100, NONCE, { procRoot });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.members.map(m => m.pid)).toEqual([100]);
  });
});

describe('a clean scan is a diagnostic signal, not a credential boundary', () => {
  it('stamps a successful scan as diagnostic evidence', () => {
    proc(100, { ppid: 1, pgid: 100 });
    const scan = scanMojoTree(100, NONCE, { procRoot });
    if (!scan.ok) throw new Error(`scan failed: ${scan.reason}`);
    expect(scan.evidence).toBe('diagnostic');
  });

  it('never turns an empty scan into boundary proof', () => {
    // The whole point of opinion 1: enumeration cannot see a descendant that both
    // setsid'd and scrubbed its environ, so "no members found" must not authorise
    // dropping the device-isolation blocker.
    proc(300, { ppid: 1, pgid: 300, env: 'PATH=/bin\0' });   // unrelated only
    const q = quiescenceFromScan(scanMojoTree(100, NONCE, { procRoot }));
    expect(q.kind).toBe('diagnostic-clean');
    expect(q.boundaryProof).toBe(false);
  });

  it('reports survivors as alive without boundary proof', () => {
    proc(100, { ppid: 1, pgid: 100 });
    const q = quiescenceFromScan(scanMojoTree(100, NONCE, { procRoot }));
    expect(q.kind).toBe('alive');
    expect(q.boundaryProof).toBe(false);
    if (q.kind !== 'alive') return;
    expect(q.pids).toEqual([100]);
  });

  it('maps an unreadable /proc to unscannable, never to clean', () => {
    const q = quiescenceFromScan(scanMojoTree(100, NONCE, { procRoot: join(procRoot, 'missing') }));
    expect(q.kind).toBe('unscannable');
    expect(q.boundaryProof).toBe(false);
  });

  it('maps an unsupported platform to its own verdict, never to clean', () => {
    const q = quiescenceFromScan(scanMojoTree(100, NONCE, { platform: 'darwin' }));
    expect(q.kind).toBe('unsupported-platform');
    expect(q.boundaryProof).toBe(false);
  });

  it('leaves boundaryProof false on every verdict this module can produce', () => {
    // Only kernel-level containment may mint `contained-proven`; the scanner must
    // not be able to reach a boundaryProof:true value by any path.
    proc(100, { ppid: 1, pgid: 100 });
    const verdicts = [
      quiescenceFromScan(scanMojoTree(100, NONCE, { procRoot })),
      quiescenceFromScan(scanMojoTree(999, NONCE, { procRoot })),
      quiescenceFromScan(scanMojoTree(100, NONCE, { procRoot: join(procRoot, 'missing') })),
      quiescenceFromScan(scanMojoTree(100, NONCE, { platform: 'darwin' })),
    ];
    expect(verdicts.map(v => v.boundaryProof)).toEqual([false, false, false, false]);
  });
});

describe('zombies are discounted, but only a definite Z', () => {
  it('marks a Z-state member as a zombie and a live one as not', () => {
    proc(100, { ppid: 1, pgid: 100 });
    proc(200, { ppid: 100, pgid: 100, state: 'Z' });
    const scan = scanMojoTree(100, NONCE, { procRoot });
    if (!scan.ok) throw new Error(`scan failed: ${scan.reason}`);
    expect(scan.members.find(m => m.pid === 200)?.zombie).toBe(true);
    expect(scan.members.find(m => m.pid === 100)?.zombie).toBe(false);
  });

  it('reports a subtree of only zombies as clean instead of blocking forever', () => {
    // A zombie has been reaped: it executes nothing and cannot use the credential,
    // it only waits for its parent to collect the status. Counting it as a survivor
    // blocked the close until the budget expired, every time, unrecoverably.
    proc(100, { ppid: 1, pgid: 100, state: 'Z' });
    proc(200, { ppid: 100, pgid: 100, state: 'Z' });
    const q = quiescenceFromScan(scanMojoTree(100, NONCE, { procRoot }));
    expect(q.kind).toBe('diagnostic-clean');
  });

  it('still reports alive when one member of a mostly-zombie tree executes', () => {
    proc(100, { ppid: 1, pgid: 100, state: 'Z' });
    proc(200, { ppid: 100, pgid: 100, state: 'R' });
    const q = quiescenceFromScan(scanMojoTree(100, NONCE, { procRoot }));
    expect(q.kind).toBe('alive');
    if (q.kind !== 'alive') return;
    // Only the executing pid is worth signalling; the zombie cannot act.
    expect(q.pids).toEqual([200]);
  });

  it('treats an unreadable state as executing, never as a zombie', () => {
    // The discount must not become a free pass: anything other than a definite 'Z'
    // — including a state we could not parse — has to count as executing.
    proc(100, { ppid: 1, pgid: 100 });
    // A stat line whose state field is empty-ish but ppid/pgid still parse.
    proc(200, { ppid: 100, pgid: 100, stat: '200 (mojo) ? 100 100 0 0' });
    const scan = scanMojoTree(100, NONCE, { procRoot });
    if (!scan.ok) throw new Error(`scan failed: ${scan.reason}`);
    expect(scan.members.find(m => m.pid === 200)?.zombie).toBe(false);
    expect(quiescenceFromScan(scan).kind).toBe('alive');
  });

  it('does not treat a state merely CONTAINING Z as a zombie', () => {
    proc(100, { ppid: 1, pgid: 100, state: 'ZZ' });
    const q = quiescenceFromScan(scanMojoTree(100, NONCE, { procRoot }));
    expect(q.kind).toBe('alive');
  });
});

describe('platform gate', () => {
  it('refuses to scan off-Linux instead of failing its way to an empty tree', () => {
    // On darwin readdir('/proc') would throw ENOENT, which is indistinguishable
    // from a broken Linux host; the gate makes the reason explicit and permanent.
    const scan = scanMojoTree(100, NONCE, { platform: 'darwin' });
    expect(scan.ok).toBe(false);
    if (scan.ok) return;
    expect(scan.failure.kind).toBe('unsupported-platform');
    expect(scan.failure).toMatchObject({ platform: 'darwin' });
  });

  it('says Linux is supported and darwin/win32 are not', () => {
    expect(mojoTreeScanSupported({ platform: 'linux' })).toBe(true);
    expect(mojoTreeScanSupported({ platform: 'darwin' })).toBe(false);
    expect(mojoTreeScanSupported({ platform: 'win32' })).toBe(false);
  });

  it('lets an explicit procRoot override opt back in, so tests stay hermetic', () => {
    expect(mojoTreeScanSupported({ platform: 'darwin', procRootOverridden: true })).toBe(true);
    proc(100, { ppid: 1, pgid: 100 });
    const scan = scanMojoTree(100, NONCE, { procRoot, platform: 'darwin' });
    expect(scan.ok).toBe(true);
  });

  it('refuses an identity read off-Linux', () => {
    const read = readProcessIdentity(100, { platform: 'darwin' });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failure.kind).toBe('unsupported-platform');
  });
});

describe('pid identity is bound to boot id and starttime', () => {
  it('reads pid, boot id and starttime together', () => {
    writeBootId();
    proc(100, { ppid: 1, pgid: 100, starttime: 987654 });
    const read = readProcessIdentity(100, { procRoot });
    if (!read.ok) throw new Error(`identity read failed: ${read.reason}`);
    expect(read.identity).toEqual({ pid: 100, bootId: BOOT_ID, starttime: 987654 });
  });

  it('fails when the boot id is unavailable, rather than inventing one', () => {
    // Without a boot id, a persisted (pid, starttime) pair would silently survive
    // a reboot and compare equal against an unrelated process.
    proc(100, { ppid: 1, pgid: 100 });
    const read = readProcessIdentity(100, { procRoot });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failure.kind).toBe('proc-unreadable');
  });

  it('fails when stat is too short to carry a starttime', () => {
    writeBootId();
    proc(100, { ppid: 1, pgid: 100, stat: '100 (mojo) S 1 100 0 0' });
    const read = readProcessIdentity(100, { procRoot });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failure.kind).toBe('proc-entry-unparsable');
  });

  it('treats a different starttime on the same pid as a different process', () => {
    const a = { pid: 100, bootId: BOOT_ID, starttime: 1000 };
    expect(sameProcessIdentity(a, { ...a, starttime: 1001 })).toBe(false);
  });

  it('treats a different boot id as a different process even when pid and starttime match', () => {
    // After a reboot every starttime restarts from zero, so the pair alone is
    // ambiguous; the boot id is what disambiguates it.
    const a = { pid: 100, bootId: BOOT_ID, starttime: 1000 };
    expect(sameProcessIdentity(a, { ...a, bootId: 'other-boot' })).toBe(false);
  });

  it('accepts a fully matching identity', () => {
    const a = { pid: 100, bootId: BOOT_ID, starttime: 1000 };
    expect(sameProcessIdentity(a, { ...a })).toBe(true);
  });
});

describe('group signalling is gated on identity', () => {
  it('signals the negated pid once the identity re-verifies', () => {
    writeBootId();
    proc(100, { ppid: 1, pgid: 100, starttime: 4242 });
    const sent: Array<[number, string]> = [];
    const out = signalTurnTreeGroup(
      { pid: 100, bootId: BOOT_ID, starttime: 4242 },
      'SIGTERM',
      { procRoot, kill: (t, s) => { sent.push([t, s]); } },
    );
    expect(out.kind).toBe('signalled');
    // Negated: the whole process GROUP, which is the point of spawning detached.
    expect(sent).toEqual([[-100, 'SIGTERM']]);
  });

  it('refuses to signal a recycled pid', () => {
    // THE bug this guard exists for: the remembered pid now names an unrelated
    // process, so kill(-100) would take down a stranger's entire process group.
    writeBootId();
    proc(100, { ppid: 1, pgid: 100, starttime: 999999 });   // recycled: new starttime
    const sent: Array<[number, string]> = [];
    const out = signalTurnTreeGroup(
      { pid: 100, bootId: BOOT_ID, starttime: 4242 },
      'SIGKILL',
      { procRoot, kill: (t, s) => { sent.push([t, s]); } },
    );
    expect(out.kind).toBe('identity-mismatch');
    expect(sent).toEqual([]);
  });

  it('refuses to signal across a reboot boundary', () => {
    writeBootId('a-different-boot-id');
    proc(100, { ppid: 1, pgid: 100, starttime: 4242 });
    const sent: number[] = [];
    const out = signalTurnTreeGroup(
      { pid: 100, bootId: BOOT_ID, starttime: 4242 },
      'SIGKILL',
      { procRoot, kill: t => { sent.push(t); } },
    );
    expect(out.kind).toBe('identity-mismatch');
    expect(sent).toEqual([]);
  });

  it('reports a vanished root as gone without signalling anything', () => {
    writeBootId();
    const sent: number[] = [];
    const out = signalTurnTreeGroup(
      { pid: 100, bootId: BOOT_ID, starttime: 4242 },
      'SIGTERM',
      { procRoot, kill: t => { sent.push(t); } },
    );
    expect(out.kind).toBe('gone');
    expect(sent).toEqual([]);
  });

  it('refuses to signal when the identity cannot be established at all', () => {
    // No boot id => unverifiable. Refusing is recoverable; killing the wrong
    // group is not, so the ambiguous case must not signal.
    proc(100, { ppid: 1, pgid: 100, starttime: 4242 });
    const sent: number[] = [];
    const out = signalTurnTreeGroup(
      { pid: 100, bootId: BOOT_ID, starttime: 4242 },
      'SIGKILL',
      { procRoot, kill: t => { sent.push(t); } },
    );
    expect(out.kind).toBe('unverifiable');
    expect(sent).toEqual([]);
  });

  it('refuses to signal off-Linux', () => {
    const sent: number[] = [];
    const out = signalTurnTreeGroup(
      { pid: 100, bootId: BOOT_ID, starttime: 4242 },
      'SIGKILL',
      { platform: 'darwin', kill: t => { sent.push(t); } },
    );
    expect(out.kind).toBe('unsupported-platform');
    expect(sent).toEqual([]);
  });
});
