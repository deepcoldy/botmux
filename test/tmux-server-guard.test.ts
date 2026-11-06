import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decideBootDirective,
  parseProcNetUnix,
  parseLsofListeners,
  parseLsofListenerResult,
  recoverNewestBotmuxSocket,
  tmuxSocketPath,
  newestBotmuxListener,
  type TmuxOwnerProbe,
} from '../src/core/tmux-server-guard.js';

// /proc/net/unix captured on Linux tmux 3.0a: a LISTENING server row
// (Flags 00010000, St 01), a connected client row with the SAME pathname
// (Flags 0, St 03), and a bound-but-never-listening row (Flags 0, St 01).
const PROC_TABLE = [
  'Num       RefCount Protocol Flags    Type St Inode Path',
  '0000000000000000: 00000002 00000000 00010000 0001 01 190164873 /tmp/u/tmux-1001/botmux',
  '0000000000000000: 00000003 00000000 00000000 0001 03 190178051 /tmp/u/tmux-1001/botmux',
  '0000000000000000: 00000002 00000000 00000000 0001 01 190749868 /tmp/u/tmux-1001/stalebound',
  '0000000000000000: 00000002 00000000 00010000 0001 01 190200000 /tmp/u/tmux-1001/otherlabel',
].join('\n');

describe('parseProcNetUnix', () => {
  const rows = parseProcNetUnix(PROC_TABLE);
  it('counts only listening-flag + state-01 STREAM rows as listening', () => {
    expect(rows.find(r => r.inode === '190164873')?.listening).toBe(true);
    expect(rows.find(r => r.inode === '190178051')?.listening).toBe(false);
    expect(rows.find(r => r.inode === '190749868')?.listening).toBe(false);
  });
});

const base = {
  owner: { kind: 'connect-error' } as TmuxOwnerProbe,
  listeners: [] as number[] | null,
  filePresent: false as boolean | null,
  supportsNoFork: false,
  canSignalRecovery: true,
  isBotmuxListener: () => false,
  startTicks: () => null,
};

describe('decideBootDirective', () => {
  it('reachable owner → spawn attach; -N only when supported', () => {
    expect(decideBootDirective({ ...base, owner: { kind: 'reachable', pid: 7 }, supportsNoFork: true }))
      .toEqual({ mode: 'spawn', noFork: true });
    expect(decideBootDirective({ ...base, owner: { kind: 'reachable', pid: 7 }, supportsNoFork: false }))
      .toEqual({ mode: 'spawn', noFork: false });
  });

  it('Linux: zero listeners cold-boots for every non-reachable owner answer', () => {
    for (const owner of ['connect-error', 'no-server', 'unknown'] as const) {
      expect(decideBootDirective({ ...base, owner: { kind: owner } as TmuxOwnerProbe }))
        .toEqual({ mode: 'spawn', noFork: false });
    }
  });

  it('FAILS CLOSED: an unreadable census (null) never collapses to a cold boot', () => {
    for (const owner of ['connect-error', 'no-server', 'unknown'] as const) {
      expect(decideBootDirective({ ...base, owner: { kind: owner } as TmuxOwnerProbe, listeners: null }).mode)
        .toBe('wait');
    }
  });

  it('macOS: a RESIDUAL dead socket file (no-server + census read, 0 listeners) cold-boots', () => {
    // tmux leaves the socket file behind after kill-server/SIGKILL/last-session
    // exit. lsof succeeds and finds NO bound process → positive cold evidence
    // (a backlogged live server is still bound and a full lsof scan sees it).
    const d = decideBootDirective({
      ...base, owner: { kind: 'no-server' }, listeners: [],
      filePresent: true, supportsNoFork: true, canSignalRecovery: false,
    });
    expect(d).toEqual({ mode: 'spawn', noFork: false });
  });

  it('macOS: connect-error + census read, 0 listeners also cold-boots', () => {
    const d = decideBootDirective({
      ...base, owner: { kind: 'connect-error' }, listeners: [],
      filePresent: true, supportsNoFork: true, canSignalRecovery: false,
    });
    expect(d).toEqual({ mode: 'spawn', noFork: false });
  });

  it('macOS: census UNREADABLE (null) still fails closed even with no-server', () => {
    const d = decideBootDirective({
      ...base, owner: { kind: 'no-server' }, listeners: null,
      filePresent: true, supportsNoFork: true, canSignalRecovery: false,
    });
    expect(d.mode).toBe('wait');
  });

  it('macOS: a live silent listener the census sees still waits, never boots', () => {
    const d = decideBootDirective({
      ...base, owner: { kind: 'connect-error' }, listeners: [64032],
      filePresent: true, supportsNoFork: true, canSignalRecovery: false,
    });
    expect(d).toMatchObject({ mode: 'wait', unprotected: false });
  });

  it('ENOENT socket + one botmux listener on Linux → SIGUSR1 recreate', () => {
    expect(decideBootDirective({ ...base, listeners: [4101], isBotmuxListener: p => p === 4101 }))
      .toEqual({ mode: 'recreate-socket', pid: 4101 });
  });

  it('socket file PRESENT + a botmux listener → wait; USR1 may only fire on a provably ENOENT path', () => {
    // SIGUSR1 first unlinks then binds the path: signalling while a socket file
    // exists could delete a freshly booted SUCCESSOR's socket. The ENOENT
    // precondition is what prevents that, so a fingerprinted listener alone
    // must never be enough.
    const d = decideBootDirective({
      ...base, listeners: [4101], filePresent: true, isBotmuxListener: p => p === 4101,
    });
    expect(d.mode).toBe('wait');
  });

  it('multi-orphan shape: ENOENT + THREE bmx listeners → recreate the NEWEST', () => {
    const ticks = new Map([[4101, 100], [4202, 200], [4303, 300]]);
    expect(decideBootDirective({
      ...base, listeners: [4101, 4202, 4303],
      isBotmuxListener: p => ticks.has(p), startTicks: p => ticks.get(p) ?? null,
    })).toEqual({ mode: 'recreate-socket', pid: 4303 });
  });

  it('newestBotmuxListener: unknown ticks fall back to first; no bmx → null', () => {
    expect(newestBotmuxListener([1, 2], () => true, () => null)).toBe(1);
    expect(newestBotmuxListener([9], () => false, () => 5)).toBeNull();
  });

  it('socket file PRESENT + silent listener → wait, never cold-boot', () => {
    expect(decideBootDirective({ ...base, listeners: [7], filePresent: true }).mode).toBe('wait');
  });

  it('non-botmux listener with ENOENT → wait, never USR1/cold-boot', () => {
    expect(decideBootDirective({ ...base, listeners: [4242] }).mode).toBe('wait');
  });

  it('macOS tmux < 3.2 silent listener → wait + unprotected', () => {
    expect(decideBootDirective({ ...base, listeners: [7], filePresent: true, canSignalRecovery: false }))
      .toMatchObject({ mode: 'wait', unprotected: true });
  });

  it('macOS tmux >= 3.2 silent listener → protected wait', () => {
    expect(decideBootDirective({ ...base, listeners: [7], filePresent: true, supportsNoFork: true, canSignalRecovery: false }))
      .toMatchObject({ mode: 'wait', unprotected: false });
  });
});

describe('parseLsofListeners (macOS)', () => {
  it('matches a bound named socket by exact path and ignores connected-peer records', () => {
    const out = ['p4242', 'c...', 'n/private/tmp/u/tmux-501/botmux', 'p4300', 'c...', 'n->0x1234'].join('\n');
    expect(parseLsofListeners(out, '/tmp/u/tmux-501/botmux')).toEqual([4242]);
  });
  it('does not cross-match a sibling label sharing the directory', () => {
    expect(parseLsofListeners('p1\nn/private/tmp/u/tmux-501/botmux2', '/tmp/u/tmux-501/botmux')).toEqual([]);
  });
  it('real darwin shape: server pid (listen fd + accepted conn both named) matched; client pid (n-> peer) excluded', () => {
    // Captured on a darwin tmux 3.6a host: the server reports the path on BOTH
    // its listening fd and the accepted-connection fd; the client reports a
    // bare n->0x peer. Only the server pid is returned.
    const out = [
      'p64032', 'f6', 'n/private/tmp/probeX/tmux-501/probeX',
      'f7', 'n/private/tmp/probeX/tmux-501/probeX',
      'p64048', 'f3', 'n->0x6f343834',
    ].join('\n');
    expect(parseLsofListeners(out, '/tmp/probeX/tmux-501/probeX')).toEqual([64032]);
  });
  it('defensively strips a trailing " type=STREAM" produced by other lsof builds', () => {
    // Native macOS lsof emits the bare path; some other lsof builds append
    // ` type=STREAM`. The parser must still match the listener either way.
    const out = 'p555\nn/private/tmp/u/tmux-501/botmux type=STREAM\n';
    expect(parseLsofListeners(out, '/tmp/u/tmux-501/botmux')).toEqual([555]);
  });
  it('recognized run with records but no socket ON THIS PATH → empty (valid cold/residual read)', () => {
    // P0 guard: a parseable lsof output that simply lists other sockets must be
    // a legitimate empty list, NOT an unreadable census — otherwise a residual
    // socket file after kill-server/SIGKILL would block cold boot forever.
    const out = 'p7\nn/private/tmp/u/tmux-501/other-label\np8\nn->0xdead\n';
    expect(parseLsofListenerResult(out, '/tmp/u/tmux-501/botmux'))
      .toEqual({ pids: [], recognized: true });
  });
  it('output with no recognizable p/n records at all → recognized=false (dialect unknown)', () => {
    expect(parseLsofListenerResult('some unexpected lsof dialect\n???\n', '/tmp/u/tmux-501/botmux'))
      .toEqual({ pids: [], recognized: false });
    expect(parseLsofListenerResult('', '/tmp/u/tmux-501/botmux'))
      .toEqual({ pids: [], recognized: false });
  });
});

describe('tmuxSocketPath', () => {
  it('honours TMUX_TMPDIR and default name', () => {
    expect(tmuxSocketPath({ TMUX_TMPDIR: '/t' }, 42, 'botmux')).toBe('/t/tmux-42/botmux');
    expect(tmuxSocketPath({}, 42)).toBe('/tmp/tmux-42/default');
  });
});

describe('recoverNewestBotmuxSocket (re-census immediately before SIGUSR1)', () => {
  const isBotmux = (p: number) => p === 4101 || p === 4202 || p === 4303;
  const ticks = new Map([[4101, 100], [4202, 200], [4303, 300]]);
  const seamFor = (census: () => number[] | null) => ({
    listeningServerPids: () => census(),
    isBotmuxListener: isBotmux,
    startTicks: (p: number) => ticks.get(p) ?? null,
  });

  it('sends USR1 while the path is ENOENT and the pid still listens as the newest bmx server', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-recover-'));
    try {
      const sock = join(dir, 'sock'); // absent
      const sent: number[] = [];
      const ok = recoverNewestBotmuxSocket(sock, 'linux', 4202, {
        ...seamFor(() => [4101, 4202]),
        recreateSocket: p => sent.push(p),
      });
      expect(ok).toBe(true);
      expect(sent).toEqual([4202]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('withholds when a successor already (re)created the socket file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-recover-'));
    try {
      const sock = join(dir, 'sock');
      writeFileSync(sock, '');
      const sent: number[] = [];
      const ok = recoverNewestBotmuxSocket(sock, 'linux', 4202, {
        ...seamFor(() => [4101, 4202]),
        recreateSocket: p => sent.push(p),
      });
      expect(ok).toBe(false);
      expect(sent).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('withholds when the expected pid stopped listening before the signal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-recover-'));
    try {
      const sock = join(dir, 'sock');
      const sent: number[] = [];
      const ok = recoverNewestBotmuxSocket(sock, 'linux', 4202, {
        ...seamFor(() => [4101]),
        recreateSocket: p => sent.push(p),
      });
      expect(ok).toBe(false);
      expect(sent).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('withholds when a NEWER botmux generation appeared between decision and signal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-recover-'));
    try {
      const sock = join(dir, 'sock');
      const sent: number[] = [];
      const ok = recoverNewestBotmuxSocket(sock, 'linux', 4202, {
        ...seamFor(() => [4101, 4202, 4303]),
        recreateSocket: p => sent.push(p),
      });
      expect(ok).toBe(false);
      expect(sent).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
