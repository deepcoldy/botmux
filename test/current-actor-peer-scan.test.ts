/**
 * The socket-owner scan behind every execution-identity request must not hold
 * the daemon's event loop: on a busy host it walks ~100k fds. These run it
 * against a large synthetic procfs.
 *
 * Run:  npx vitest run --project unit test/current-actor-peer-scan.test.ts
 */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveLoopbackPeerProcesses } from '../src/core/current-actor-attestation.js';

const SERVER_PORT = 7_951;
const PIDS = 400;
const FDS_PER_PID = 25;

function procStat(pid: number, ppid: number, start: string): string {
  const tail = ['S', String(ppid), '1', '1', '0', '-1', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', start];
  return `${pid} (proc ${pid}) ${tail.join(' ')}\n`;
}

const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
let procRoot: string;
const tcpRows: string[] = [];

/** Register an ESTABLISHED client→daemon row and return its client port. */
function connection(clientPort: number, inode: number): void {
  tcpRows.push(`${tcpRows.length}: 0100007F:${hex(clientPort)} 0100007F:${hex(SERVER_PORT)} 01 00000000:00000000 00:00000000 00000000 1000 0 ${inode}`);
  writeFileSync(join(procRoot, 'net', 'tcp'), [
    'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode',
    ...tcpRows,
  ].join('\n'));
}

function holdSocket(pid: number, fd: number, inode: number): void {
  symlinkSync(`socket:[${inode}]`, join(procRoot, String(pid), 'fd', String(fd)));
}

beforeAll(() => {
  procRoot = mkdtempSync(join(tmpdir(), 'peer-scan-'));
  mkdirSync(join(procRoot, 'net'), { recursive: true });
  writeFileSync(join(procRoot, 'net', 'tcp6'), '');
  // A crowded host: every process holds many unrelated fds.
  for (let pid = 1_000; pid < 1_000 + PIDS; pid++) {
    const dir = join(procRoot, String(pid));
    mkdirSync(join(dir, 'fd'), { recursive: true });
    writeFileSync(join(dir, 'stat'), procStat(pid, 1, String(pid * 10)));
    for (let fd = 0; fd < FDS_PER_PID; fd++) {
      symlinkSync(fd % 3 === 0 ? `socket:[${pid * 100 + fd}]` : `/dev/pts/${fd}`, join(dir, 'fd', String(fd)));
    }
  }
  connection(50_001, 9_000_001);
  holdSocket(1_200, 100, 9_000_001);
});
afterAll(() => rmSync(procRoot, { recursive: true, force: true }));

const resolve = (clientPort: number, scanTuning: Parameters<typeof resolveLoopbackPeerProcesses>[0]['scanTuning'] = {}) =>
  resolveLoopbackPeerProcesses({ remoteAddress: '127.0.0.1', remotePort: clientPort, localPort: SERVER_PORT, procRoot, scanTuning });

describe('socket owner scan', () => {
  it('lets other work run while it walks a crowded procfs, and still finds the owner', async () => {
    // Stand-in for a health check / timer / outbound I/O callback queued while
    // the scan runs: it must get turns before the scan finishes.
    let otherTurns = 0;
    let stop = false;
    const other = () => { if (stop) return; otherTurns++; setImmediate(other); };
    setImmediate(other);
    const result = await resolve(50_001, { sliceMs: 0 });
    const turnsBeforeResult = otherTurns;
    stop = true;
    expect(result).toEqual({ ok: true, peer: { pid: 1_200, procStart: '12000' } });
    // One turn per process when every slice is exhausted immediately.
    expect(turnsBeforeResult).toBeGreaterThan(PIDS / 2);
  });

  it('refuses a socket held by two processes (inherited or passed fd)', async () => {
    connection(50_002, 9_000_002);
    holdSocket(1_010, 101, 9_000_002);
    holdSocket(1_390, 101, 9_000_002);
    expect(await resolve(50_002)).toEqual({ ok: false, reason: 'peer_unresolved' });
  });

  it('fails closed when the scan runs past its budget', async () => {
    expect(await resolve(50_001, { sliceMs: 0, budgetMs: 0 })).toEqual({ ok: false, reason: 'peer_unresolved' });
  });

  it('concurrent requests each get their own owner', async () => {
    connection(50_003, 9_000_003);
    holdSocket(1_005, 102, 9_000_003);
    const [a, b] = await Promise.all([resolve(50_001, { sliceMs: 0 }), resolve(50_003, { sliceMs: 0 })]);
    expect(a).toEqual({ ok: true, peer: { pid: 1_200, procStart: '12000' } });
    expect(b).toEqual({ ok: true, peer: { pid: 1_005, procStart: '10050' } });
  });

  it('a request that arrives after the running pass swept its holder is resolved by a fresh pass', async () => {
    // Wait by observed yield count, not by a fixed number of turns: with
    // sliceMs 0 the pass yields on every check, so the process that is first
    // in readdir order is provably behind the scan head after a few processes
    // worth of checks. Its fd dir has already been read, so the new socket is
    // invisible to the running pass and MUST be picked up by a second pass.
    const order = readdirSync(procRoot).filter(e => /^\d+$/.test(e)).map(Number);
    const behind = order[0];
    let yields = 0;
    const running = resolve(50_001, { sliceMs: 0, onYield: () => { yields++; } });
    while (yields < (FDS_PER_PID + 1) * 6) await new Promise(r => setImmediate(r));
    connection(50_004, 9_000_004);
    holdSocket(behind, 103, 9_000_004);
    const late = resolve(50_004, { sliceMs: 0 });
    expect(await running).toEqual({ ok: true, peer: { pid: 1_200, procStart: '12000' } });
    expect(await late).toEqual({ ok: true, peer: { pid: behind, procStart: String(behind * 10) } });
  });

  it('refuses a late request whose socket has one holder behind the scan head and one ahead', async () => {
    // If a mid-scan request were squeezed into the running pass, the holder
    // that pass already swept would never be re-checked: a socket passed to or
    // inherited by that process would look uniquely owned by the second one.
    const order = readdirSync(procRoot).filter(e => /^\d+$/.test(e)).map(Number);
    const behind = order[0];
    const ahead = order[20];
    let yields = 0;
    const running = resolve(50_001, { sliceMs: 0, onYield: () => { yields++; } });
    while (yields < (FDS_PER_PID + 1) * 6) await new Promise(r => setImmediate(r));
    connection(50_006, 9_000_006);
    holdSocket(behind, 107, 9_000_006);
    holdSocket(ahead, 107, 9_000_006);
    const late = resolve(50_006, { sliceMs: 0 });
    expect((await running).ok).toBe(true);
    expect(await late).toEqual({ ok: false, reason: 'peer_unresolved' });
  });

  it('accepts a single process that holds the socket through two duplicated fds', async () => {
    // dup()/dup2() of a socket fd is normal (two event loops, an inherited
    // stdio slot). Two fds in ONE process are still one holder; counting them
    // twice would reject an unambiguous peer.
    connection(50_007, 9_000_007);
    holdSocket(1_030, 108, 9_000_007);
    holdSocket(1_030, 109, 9_000_007);
    expect(await resolve(50_007)).toEqual({ ok: true, peer: { pid: 1_030, procStart: '10300' } });
  });

  it('pins the holder start time at the moment the fd is seen, not when the pass ends', async () => {
    // The pass spans many event-loop turns: a pid read only at the end could
    // already belong to a recycled process. Simulate PID reuse by rewriting
    // the holder's stat start time after the pass has swept it.
    const order = readdirSync(procRoot).filter(e => /^\d+$/.test(e)).map(Number);
    const holder = order[0];
    connection(50_008, 9_000_008);
    holdSocket(holder, 110, 9_000_008);
    const statPath = join(procRoot, String(holder), 'stat');
    const original = readFileSync(statPath, 'utf8');
    try {
      let yields = 0;
      const promise = resolve(50_008, { sliceMs: 0, onYield: () => { yields++; } });
      while (yields < (FDS_PER_PID + 1) * 6) await new Promise(r => setImmediate(r));
      writeFileSync(statPath, original.replace(`${holder * 10}`, '999999'));
      expect(await promise).toEqual({ ok: true, peer: { pid: holder, procStart: String(holder * 10) } });
    } finally {
      writeFileSync(statPath, original);
    }
  });

  it('coalesces requests queued in the same tick into one host-wide pass', async () => {
    // Sharing one pass across queued requests is the mechanism that keeps a
    // burst of attestation calls from paying one full /proc walk each. Count
    // yields (check points): one request costs one pass; six requests queued
    // before the runner's first splice cost two passes (the first request
    // starts a pass immediately, the remaining five ride the next one), never
    // six. Wall-clock free.
    let singlePassYields = 0;
    await resolve(50_001, { sliceMs: 0, onYield: () => { singlePassYields++; } });
    let totalYields = 0;
    const tuning = { sliceMs: 0, onYield: () => { totalYields++; } };
    const pending: Array<Promise<unknown>> = [];
    for (let k = 0; k < 6; k++) {
      const clientPort = 50_010 + k;
      const inode = 9_000_010 + k;
      const pid = 1_300 + k;
      connection(clientPort, inode);
      holdSocket(pid, 120 + k, inode);
      pending.push(resolve(clientPort, tuning));
    }
    const results = await Promise.all(pending);
    expect(results.every(r => (r as { ok?: boolean }).ok)).toBe(true);
    // The first request starts a pass synchronously (1 pass); the other five
    // are queued before it resumes and ride the next pass (2 passes). Neither
    // one pass (late requests wrongly squeezed in) nor six (no sharing) is
    // acceptable; a few extra fds from earlier cases must not move the band.
    expect(totalYields).toBeGreaterThan(singlePassYields * 1.5);
    expect(totalYields).toBeLessThan(singlePassYields * 3);
  });
});
