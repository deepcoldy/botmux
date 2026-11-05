/**
 * The socket-owner scan behind every execution-identity request must not hold
 * the daemon's event loop: on a busy host it walks ~100k fds. These run it
 * against a large synthetic procfs.
 *
 * Run:  npx vitest run --project unit test/current-actor-peer-scan.test.ts
 */
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it('a request that arrives mid-scan sees a holder the running pass had already walked past', async () => {
    // The pass walks in directory order, one process per turn here: the
    // process 5th in that order is behind the pass after 50 turns.
    const late = Number(readdirSync(procRoot).filter(e => /^\d+$/.test(e))[4]);
    const first = resolve(50_001, { sliceMs: 0 });
    for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r));
    connection(50_004, 9_000_004);
    holdSocket(late, 103, 9_000_004);
    const second = resolve(50_004, { sliceMs: 0 });
    expect((await first).ok).toBe(true);
    expect(await second).toEqual({ ok: true, peer: { pid: late, procStart: String(late * 10) } });
  });
});
