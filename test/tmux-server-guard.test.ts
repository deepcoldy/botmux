import { describe, it, expect } from 'vitest';
import {
  decideBootDirective,
  parseProcNetUnix,
  parseLsofListeners,
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
});

describe('tmuxSocketPath', () => {
  it('honours TMUX_TMPDIR and default name', () => {
    expect(tmuxSocketPath({ TMUX_TMPDIR: '/t' }, 42, 'botmux')).toBe('/t/tmux-42/botmux');
    expect(tmuxSocketPath({}, 42)).toBe('/tmp/tmux-42/default');
  });
});
