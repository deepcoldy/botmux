import { describe, it, expect } from 'vitest';
import {
  tmuxKeyToBytes,
  kdlString,
  buildLayoutString,
  ZELLIJ_CONFIG_KDL,
  parseZellijServerProcs,
} from '../src/adapters/backend/zellij-backend.js';
import {
  unixInodesUnderDir,
  socketInodesFromFdLinks,
  attributeOwners,
  PROBE_CONNECTIONS,
} from '../src/adapters/backend/zellij-socket-probe.js';
import {
  parseZellijVersion,
  isZellijVersionSupported,
} from '../src/setup/ensure-zellij.js';

describe('tmuxKeyToBytes', () => {
  it('maps named keys to terminal byte sequences', () => {
    expect(tmuxKeyToBytes('Enter')).toBe('\r');
    expect(tmuxKeyToBytes('Escape')).toBe('\x1b');
    expect(tmuxKeyToBytes('Tab')).toBe('\t');
    expect(tmuxKeyToBytes('BSpace')).toBe('\x7f');
    expect(tmuxKeyToBytes('Up')).toBe('\x1b[A');
    expect(tmuxKeyToBytes('M-Enter')).toBe('\x1b\r');
  });

  it('maps C-<x> control combos to control bytes', () => {
    expect(tmuxKeyToBytes('C-c')).toBe('\x03');
    expect(tmuxKeyToBytes('C-d')).toBe('\x04');
    expect(tmuxKeyToBytes('C-a')).toBe('\x01');
  });

  it('maps M-<x> meta combos to ESC-prefixed bytes', () => {
    expect(tmuxKeyToBytes('M-b')).toBe('\x1bb');
  });

  it('falls back to the literal string for unknown keys (no dropped input)', () => {
    expect(tmuxKeyToBytes('weird')).toBe('weird');
  });
});

describe('kdlString', () => {
  it('escapes backslashes and quotes', () => {
    expect(kdlString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});

describe('buildLayoutString', () => {
  it('produces a single command pane with close_on_exit and the CLI args', () => {
    const kdl = buildLayoutString('claude', ['--resume', 'abc'], {
      cwd: '/work/dir',
      cols: 120,
      rows: 40,
      env: {},
    });
    expect(kdl).toContain('layout {');
    expect(kdl).toContain('close_on_exit=true');
    // cwd is passed as a wrapper-script arg (execvp semantics, KDL-quoted).
    expect(kdl).toContain('"/work/dir"');
    expect(kdl).toContain('"claude"');
    expect(kdl).toContain('"--resume"');
    expect(kdl).toContain('"abc"');
  });
});

describe('ZELLIJ_CONFIG_KDL', () => {
  it('locks input and clears keybinds so pty.write passes straight through', () => {
    expect(ZELLIJ_CONFIG_KDL).toContain('default_mode "locked"');
    expect(ZELLIJ_CONFIG_KDL).toContain('clear-defaults=true');
  });
});

describe('zellij version gate', () => {
  it('parses versions', () => {
    expect(parseZellijVersion('zellij 0.44.1')).toEqual({ major: 0, minor: 44, patch: 1 });
    expect(parseZellijVersion('garbage')).toBeUndefined();
  });

  it('requires >= 0.44.0', () => {
    expect(isZellijVersionSupported({ major: 0, minor: 44, patch: 1 })).toBe(true);
    expect(isZellijVersionSupported({ major: 0, minor: 44, patch: 0 })).toBe(true);
    expect(isZellijVersionSupported({ major: 0, minor: 43, patch: 9 })).toBe(false);
    expect(isZellijVersionSupported({ major: 0, minor: 45, patch: 0 })).toBe(true);
    expect(isZellijVersionSupported({ major: 1, minor: 0, patch: 0 })).toBe(true);
  });
});

// Rename-proof server lookup (session-manager rename-session renames the
// socket FILE but the server argv keeps the spawn-time path — verified live).
describe('parseZellijServerProcs', () => {
  const PS = [
    ' 1150415 /root/.local/share/mise/installs/zellij/0.44.1/zellij --server /run/user/0/zellij/contract_version_1/zadopt-ren',
    ' 2836020 /usr/bin/zellij --server /run/user/0/zellij/contract_version_1/other-sess',
    '    4242 grep zellij --server /tmp/fake', // grep noise: argv matches shape → tolerated by design (inode match rejects it)
    '    9999 /usr/bin/zsh',
  ].join('\n');

  it('extracts pid + spawn-time socket path of server processes', () => {
    const servers = parseZellijServerProcs(PS);
    expect(servers.map(s => s.pid)).toContain(1150415);
    expect(servers.find(s => s.pid === 1150415)!.socketPath)
      .toBe('/run/user/0/zellij/contract_version_1/zadopt-ren');
    expect(servers.map(s => s.pid)).not.toContain(9999);
  });
});

describe('zellij-socket-probe pure helpers', () => {
  // Real /proc/net/unix shape (verified live): the bound path column carries
  // the SPAWN-TIME name (frozen across renames); listening + accepted rows
  // share it; client ends have no path column.
  const DIR = '/run/user/0/zellij/contract_version_1';
  const UNIX_TABLE = [
    'Num       RefCount Protocol Flags    Type St Inode Path',
    `ffff0001: 00000002 00000000 00010000 0001 01 111222 ${DIR}/old`,
    `ffff0002: 00000003 00000000 00000000 0001 03 111333 ${DIR}/old`,
    `ffff0003: 00000002 00000000 00010000 0001 01 444555 ${DIR}/other-sess`,
    'ffff0004: 00000002 00000000 00000000 0001 03 666777',
    'ffff0005: 00000002 00000000 00010000 0001 01 888999 /run/user/0/other-app/sock',
  ].join('\n');

  it('unixInodesUnderDir collects inodes bound under the socket dir only', () => {
    const inodes = unixInodesUnderDir(UNIX_TABLE, DIR);
    expect([...inodes].sort()).toEqual(['111222', '111333', '444555']);
  });

  it('socketInodesFromFdLinks keeps socket fds only', () => {
    const s = socketInodesFromFdLinks(['socket:[111333]', '/dev/null', 'pipe:[42]', 'socket:[999]']);
    expect([...s].sort()).toEqual(['111333', '999']);
  });

  // The causal core (Codex findings #2 + delta combo on PR #468): a pid owns
  // the probed socket iff it gained ≥ PROBE_CONNECTIONS dir-bound socket
  // inodes during our hold that ALL vanished after our close. The probe opens
  // PROBE_CONNECTIONS (=2) simultaneous connections precisely so one stray
  // short sibling connection can never impersonate us. Set-up: two servers
  // A(447407)/B(447915) whose spawn-time paths are BOTH ".../old" (rename +
  // name reuse).
  describe('attributeOwners', () => {
    const K = PROBE_CONNECTIONS;
    const PIDS = [447407, 447915];
    const bound = new Set(['111333', '111444', '444555', '444666']);
    const snap = (m: Record<number, string[]>) => new Map(Object.entries(m).map(([k, v]) => [Number(k), new Set(v)]));

    it('attributes the pid that accepted all K probe connections (appear→vanish)', () => {
      const before = snap({ 447407: ['1'], 447915: ['2'] });
      const during = snap({ 447407: ['1'], 447915: ['2', '111333', '111444'] }); // B accepted both
      const final = snap({ 447407: ['1'], 447915: ['2'] });                      // gone after our close
      expect(attributeOwners(PIDS, before, during, final, bound, K)).toEqual([447915]);
    });

    it('REGRESSION (Codex delta combo): target accept slow + ONE sibling short connection → nobody qualifies, fail-closed', () => {
      // Old single-connection protocol returned the sibling here (sole
      // appear→vanish inode) → misattribution. With K=2, one stray short
      // connection can never reach the required count.
      const before = snap({ 447407: ['1'], 447915: ['2'] });
      const during = snap({ 447407: ['1', '444555'], 447915: ['2'] }); // sibling A gained ONE short client; target B slow (our accepts invisible)
      const final = snap({ 447407: ['1'], 447915: ['2'] });            // sibling's short client also vanished
      expect(attributeOwners(PIDS, before, during, final, bound, K)).toEqual([]);
    });

    it('keeps the target attributable when extra short clients hit IT during the window (≥K, not ==K)', () => {
      const before = snap({ 447915: ['2'] });
      const during = snap({ 447915: ['2', '111333', '111444', '444555'] }); // our 2 + one unrelated short
      const final = snap({ 447915: ['2'] });
      expect(attributeOwners([447915], before, during, final, bound, K)).toEqual([447915]);
    });

    it('excludes a sibling whose unrelated client stays connected past our close', () => {
      const before = snap({ 447407: ['1'], 447915: ['2'] });
      const during = snap({ 447407: ['1', '444555', '444666'], 447915: ['2', '111333', '111444'] });
      const final = snap({ 447407: ['1', '444555', '444666'], 447915: ['2'] }); // A's clients still there
      expect(attributeOwners(PIDS, before, during, final, bound, K)).toEqual([447915]);
    });

    it('yields two candidates (ambiguous → fail-closed) when ≥K sibling shorts race the window', () => {
      const before = snap({ 447407: ['1'], 447915: ['2'] });
      const during = snap({ 447407: ['1', '444555', '444666'], 447915: ['2', '111333', '111444'] });
      const final = snap({ 447407: ['1'], 447915: ['2'] }); // all vanished
      expect(attributeOwners(PIDS, before, during, final, bound, K)).toHaveLength(2);
    });

    it('yields nothing when our accepts were not yet visible (slow server → fail-closed)', () => {
      const before = snap({ 447407: ['1'], 447915: ['2'] });
      const during = snap({ 447407: ['1'], 447915: ['2'] });
      const final = snap({ 447407: ['1'], 447915: ['2'] });
      expect(attributeOwners(PIDS, before, during, final, bound, K)).toEqual([]);
    });

    it('ignores gained fds that are not dir-bound sockets (random files/pipes)', () => {
      const before = snap({ 447407: ['1'] });
      const during = snap({ 447407: ['1', '999', '998'] }); // gained sockets not bound under dir
      const final = snap({ 447407: ['1'] });
      expect(attributeOwners([447407], before, during, final, bound, K)).toEqual([]);
    });
  });
});
