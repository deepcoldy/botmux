/**
 * Unit tests for session-discovery module.
 *
 * Mocks execSync, readFileSync, readlinkSync to test discovery logic
 * without requiring actual tmux sessions or /proc filesystem.
 *
 * Run:  pnpm vitest run test/session-discovery.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Factories use a synchronous `require`, never `await vi.importActual(...)`: bun's
// `vi` shim has no `importActual`, and the real module must be SPREAD IN because bun
// links named exports for real — a factory returning only the overridden keys fails
// the whole file with "Export named 'X' not found in module '…'" (measured: `fork`,
// imported by src/core/self-spawn.ts on the transitive graph).
vi.mock('node:child_process', () => {
  const actual = require('node:child_process') as typeof import('node:child_process');
  return {
    ...actual,
    execSync: vi.fn(),
    // ⚠️ `execFileSync` MUST be stubbed, even though no test configures it.
    // `readProcessStartTime()` falls back to `execFileSync('ps', ['-o','lstart=' …])`
    // when /proc parsing yields nothing. Before the spread was added, this factory
    // returned ONLY `execSync`, so that call threw and `startedAt` stayed undefined —
    // the "should not include sessionId for non-claude CLI types" and "metadata file
    // not found" cases silently depended on that OMISSION. Spreading the real module
    // (required: bun links named exports for real) handed the fallback a working `ps`,
    // which returned a genuine timestamp and failed both `toBeUndefined()` assertions.
    // Throwing here preserves the original behaviour explicitly instead of by accident.
    execFileSync: vi.fn(() => { throw new Error('execFileSync not stubbed for this test'); }),
  };
});

vi.mock('node:fs', () => {
  const actual = require('node:fs') as typeof import('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(),
    readlinkSync: vi.fn(),
  };
});

vi.mock('node:os', () => {
  const actual = require('node:os') as typeof import('node:os');
  return {
    ...actual,
    homedir: () => '/home/testuser',
    // session-discovery 用 platform() 决定 Linux /proc 快路径 vs macOS ps/lsof 兜底。
    // 既有 mock 数据全部按 Linux 形态准备，所以这里固定为 'linux'。
    // macOS 兜底路径的覆盖见 test/session-discovery.smoke.test.ts。
    platform: () => 'linux',
  };
});

import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverAdoptableSessions,
  discoverAdoptableSessionByTarget,
  validateAdoptTarget,
  isBareShellComm,
  bareShellLaunchKind,
  bareShellLaunchGuidance,
  settleLaunchComm,
} from '../src/core/session-discovery.js';
import type { CliId } from '../src/adapters/cli/types.js';

describe('isBareShellComm()', () => {
  it('classifies interactive shells as bare shells', () => {
    for (const sh of ['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'fish', 'tcsh', 'csh']) {
      expect(isBareShellComm(sh)).toBe(true);
    }
  });
  it('tolerates the leading-dot login-shell form (e.g. -zsh → .zsh on some ps)', () => {
    expect(isBareShellComm('.zsh')).toBe(true);
  });
  it('does NOT classify agent CLIs or launchers as bare shells', () => {
    for (const comm of ['codex', 'claude', 'node', 'python', 'relay', 'seed', 'coco']) {
      expect(isBareShellComm(comm)).toBe(false);
    }
  });
  it('returns false for undefined/empty', () => {
    expect(isBareShellComm(undefined)).toBe(false);
    expect(isBareShellComm('')).toBe(false);
  });
});

describe('bareShellLaunchKind()', () => {
  it('reports trampoline when leaf shell differs from the launch shell', () => {
    // The exact user case: $SHELL=bash, .bashrc `exec zsh` → leaf is zsh.
    expect(bareShellLaunchKind('zsh', 'bash')).toBe('trampoline');
    expect(bareShellLaunchKind('bash', 'zsh')).toBe('trampoline');
  });
  it('reports stuck when leaf matches the launch shell (slow/erroring rc, or CLI not on PATH)', () => {
    expect(bareShellLaunchKind('bash', 'bash')).toBe('stuck');
    expect(bareShellLaunchKind('zsh', 'zsh')).toBe('stuck');
  });
  it('reports stuck (no confident trampoline claim) when the launch shell is unknown', () => {
    expect(bareShellLaunchKind('zsh', '')).toBe('stuck');
  });
});

describe('settleLaunchComm()', () => {
  it('does not classify the launch wrapper as a failed CLI when it execs shortly afterward', async () => {
    vi.useFakeTimers();
    try {
      const reads = ['zsh', 'coco'];
      const settled = settleLaunchComm(
        () => reads.shift() ?? 'coco',
        { timeoutMs: 2_000, pollMs: 100 },
      );

      await vi.advanceTimersByTimeAsync(100);

      expect(await settled).toBe('coco');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not classify a fish launch wrapper as failed when it execs the CLI shortly afterward', async () => {
    vi.useFakeTimers();
    try {
      const reads = ['fish', 'codex'];
      const settled = settleLaunchComm(
        () => reads.shift() ?? 'codex',
        { timeoutMs: 2_000, pollMs: 100 },
      );

      await vi.advanceTimersByTimeAsync(100);

      expect(await settled).toBe('codex');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a persistent bare shell after the bounded launch grace period', async () => {
    vi.useFakeTimers();
    try {
      const settled = settleLaunchComm(
        () => 'zsh',
        { timeoutMs: 300, pollMs: 100 },
      );

      await vi.advanceTimersByTimeAsync(300);

      expect(await settled).toBe('zsh');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a persistent fish shell after the bounded launch grace period', async () => {
    vi.useFakeTimers();
    try {
      const settled = settleLaunchComm(
        () => 'fish',
        { timeoutMs: 300, pollMs: 100 },
      );

      await vi.advanceTimersByTimeAsync(300);

      expect(await settled).toBe('fish');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('bareShellLaunchGuidance()', () => {
  it('points fish trampoline diagnostics at config.fish and fish-compatible guards', () => {
    const guidance = bareShellLaunchGuidance('zsh', 'fish');

    expect(guidance.rcFileHint).toBe('~/.config/fish/config.fish');
    expect(guidance.manualTerminalGuard).toBe('status is-interactive; and isatty stdout; and not set -q BOTMUX_MANAGED_SHELL; and exec zsh');
  });

  it('preserves POSIX rc and guard guidance for bash/zsh launches', () => {
    const guidance = bareShellLaunchGuidance('fish', 'zsh');

    expect(guidance.rcFileHint).toBe('~/.zshrc');
    expect(guidance.manualTerminalGuard).toBe('[ -z "$BASH_EXECUTION_STRING" ] && [ -t 1 ] && exec fish');
  });
});

const mockExecSync = vi.mocked(execSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReadlinkSync = vi.mocked(readlinkSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Set up mocks for a standard discovery scenario.
 *
 * paneLines: raw tmux list-panes output lines (one per line, no trailing newline)
 * commMap: pid → comm name
 * cwdMap: pid → cwd path
 * childMap: pid → child pids
 * cmdlineMap: pid → argv list for /proc/<pid>/cmdline
 * dimsMap: tmuxTarget → "cols rows"
 * claudeMeta: pid → JSON string of session metadata
 */
function setupMocks(opts: {
  paneLines: string;
  commMap?: Record<number, string>;
  cwdMap?: Record<number, string>;
  childMap?: Record<number, number[]>;
  cmdlineMap?: Record<number, string[]>;
  dimsMap?: Record<string, string>;
  claudeMeta?: Record<number, string>;
  /** pid → starttime (clock ticks since boot) for /proc/<pid>/stat field 22.
   *  Drives readProcessStartTime's Linux fast path. Pids absent here yield a
   *  thrown ENOENT → readProcessStartTime returns undefined (no ps fallback in
   *  the mocked child_process), matching the "uptime unknown" legacy behavior. */
  statMap?: Record<number, number>;
  /** /proc/stat btime (seconds since epoch). Defaults to 1_700_000_000. */
  bootTimeSeconds?: number;
  /** pid → ordered list of /proc/<pid>/fd/<n> symlink target strings.
   *  Used to test CoCo session discovery (and any future fd-walking logic).
   *  Pass `'<path> (deleted)'` suffix to simulate procfs's deleted-inode marker. */
  procFdMap?: Record<number, string[]>;
}) {
  const { paneLines, commMap = {}, cwdMap = {}, childMap = {}, cmdlineMap = {}, dimsMap = {}, claudeMeta = {}, statMap = {}, bootTimeSeconds = 1_700_000_000, procFdMap = {} } = opts;

  // Replace blanket existsSync / readdirSync mocks with procFdMap-aware ones.
  mockExistsSync.mockImplementation((path: unknown) => {
    const pathStr = String(path);
    const fdMatch = pathStr.match(/^\/proc\/(\d+)\/fd$/);
    if (fdMatch) return Number(fdMatch[1]) in procFdMap;
    return false;
  });
  mockReaddirSync.mockImplementation(((path: unknown) => {
    const pathStr = String(path);
    const fdMatch = pathStr.match(/^\/proc\/(\d+)\/fd$/);
    if (fdMatch) {
      const pid = Number(fdMatch[1]);
      const entries = procFdMap[pid];
      if (entries) return entries.map((_, i) => String(i));
    }
    return [];
  }) as any);

  mockExecSync.mockImplementation((cmd: unknown) => {
    const cmdStr = String(cmd);

    // tmux list-panes
    if (cmdStr.includes('list-panes')) {
      return paneLines;
    }

    // `ps -A -o pid= -o ppid=` —— 返回全表，由调用方过滤。我们这里把
    // childMap 全展开成两列。
    if (cmdStr.includes('ps -A -o pid= -o ppid=')) {
      const rows: string[] = [];
      for (const [ppidStr, kids] of Object.entries(childMap)) {
        const ppid = Number(ppidStr);
        for (const kid of kids) rows.push(`${kid} ${ppid}`);
      }
      return rows.join('\n') + (rows.length ? '\n' : '');
    }

    // tmux display (pane dimensions)
    const displayMatch = cmdStr.match(/tmux display -t '([^']+)'/);
    if (displayMatch) {
      const target = displayMatch[1];

      // pane_pid query. 两种形态：
      //   validateTmuxAdoptTarget          → 只要 '#{pane_pid}'
      //   discoverAdoptableSessionByTarget → '#{session_name}:...pane_index} #{pane_pid}'
      //                                      （连 canonical 地址一起回显，用来核对
      //                                        tmux 有没有模糊命中别的 pane）
      if (cmdStr.includes('pane_pid')) {
        const wantsCanonical = cmdStr.includes('session_name');
        // Extract the target and find matching pane from paneLines.
        // 取 pid 必须按**最后**一个空格切：会话名本身可能含空格
        // （如「AD 智投星:0.0 651511」），按第一个空格切会把 pid 取成会话名的后半段。
        // 这与 discoverAdoptableSessions 解析 list-panes 输出的规则一致。
        for (const line of paneLines.split('\n')) {
          if (line.startsWith(target + ' ')) {
            // paneLines 的格式与 canonical query 的格式串完全相同，可整行回显。
            return (wantsCanonical ? line : line.slice(line.lastIndexOf(' ') + 1)) + '\n';
          }
        }
        throw new Error('pane not found');
      }

      // pane dimensions query
      const dims = dimsMap[target];
      if (dims) return dims;
      throw new Error('pane not found');
    }

    throw new Error(`unexpected execSync call: ${cmdStr}`);
  });

  mockReadFileSync.mockImplementation((path: unknown) => {
    const pathStr = String(path);

    // /proc/<pid>/comm
    const commMatch = pathStr.match(/\/proc\/(\d+)\/comm/);
    if (commMatch) {
      const pid = Number(commMatch[1]);
      if (pid in commMap) return commMap[pid] + '\n';
      throw new Error('ENOENT');
    }

    // /proc/<pid>/cmdline
    const cmdlineMatch = pathStr.match(/\/proc\/(\d+)\/cmdline/);
    if (cmdlineMatch) {
      const pid = Number(cmdlineMatch[1]);
      if (pid in cmdlineMap) return cmdlineMap[pid]!.join('\0') + '\0';
      throw new Error('ENOENT');
    }

    // /proc/stat (system boot time)
    if (pathStr === '/proc/stat') {
      return `cpu 0 0 0 0\nbtime ${bootTimeSeconds}\nprocesses 1\n`;
    }

    // /proc/<pid>/stat — only field 22 (starttime, index 19 after the comm
    // paren) matters to readProcessStartTime; pad the leading fields with 0s.
    const statMatch = pathStr.match(/\/proc\/(\d+)\/stat$/);
    if (statMatch) {
      const pid = Number(statMatch[1]);
      if (pid in statMap) {
        const after = Array(19).fill('0');
        after[0] = 'S';
        after.push(String(statMap[pid]));
        return `${pid} (proc) ${after.join(' ')}`;
      }
      throw new Error('ENOENT');
    }

    // Claude session metadata
    const metaMatch = pathStr.match(/\.claude\/sessions\/(\d+)\.json/);
    if (metaMatch) {
      const pid = Number(metaMatch[1]);
      if (pid in claudeMeta) return claudeMeta[pid];
      throw new Error('ENOENT');
    }

    throw new Error(`unexpected readFileSync: ${pathStr}`);
  });

  mockReadlinkSync.mockImplementation((path: unknown) => {
    const pathStr = String(path);
    const cwdMatch = pathStr.match(/\/proc\/(\d+)\/cwd/);
    if (cwdMatch) {
      const pid = Number(cwdMatch[1]);
      if (pid in cwdMap) return cwdMap[pid];
      throw new Error('ENOENT');
    }
    const fdMatch = pathStr.match(/^\/proc\/(\d+)\/fd\/(\d+)$/);
    if (fdMatch) {
      const pid = Number(fdMatch[1]);
      const idx = Number(fdMatch[2]);
      const entries = procFdMap[pid];
      if (entries && idx >= 0 && idx < entries.length) return entries[idx];
      throw new Error('ENOENT');
    }
    throw new Error(`unexpected readlinkSync: ${pathStr}`);
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
});

describe('discoverAdoptableSessions', () => {
  it('should discover Claude processes in non-bmx tmux panes', () => {
    setupMocks({
      paneLines: 'mysession:0.0 1000\nmysession:0.1 2000\n',
      // pane 1000 shell → child 1001 (bash) → child 1002 (claude)
      commMap: { 1000: 'zsh', 1001: 'bash', 1002: 'claude' },
      childMap: { 1000: [1001], 1001: [1002] },
      cwdMap: { 1002: '/home/user/project' },
      dimsMap: { 'mysession:0.0': '120 40' },
      claudeMeta: {
        1002: JSON.stringify({ sessionId: 'sess-abc123', cwd: '/home/user/project', startedAt: 1700000000000 }),
      },
    });

    const results = discoverAdoptableSessions();

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      source: 'tmux',
      tmuxTarget: 'mysession:0.0',
      panePid: 1000,
      cliPid: 1002,
      cliId: 'claude-code',
      sessionId: 'sess-abc123',
      cwd: '/home/user/project',
      startedAt: 1700000000000,
      paneCols: 120,
      paneRows: 40,
    });
  });

  it('should discover panes in sessions whose name contains spaces', () => {
    // 真实回归：tmux 会话名可以含空格（如「AD 智投星核心指标」）。list-panes 输出
    // 变成 "AD 智投星核心指标:0.0 1000"，按第一个空格切分会把 pid 解析成 NaN，
    // pane 被静默跳过，/adopt 永远扫不到这个会话。
    setupMocks({
      paneLines: 'AD 智投星核心指标:0.0 1000\n',
      commMap: { 1000: 'fish', 1001: 'claude' },
      childMap: { 1000: [1001] },
      cwdMap: { 1001: '/home/user/project' },
      dimsMap: { 'AD 智投星核心指标:0.0': '210 61' },
      claudeMeta: {
        1001: JSON.stringify({ sessionId: 'sess-spaced', cwd: '/home/user/project', startedAt: 1700000000000 }),
      },
    });

    const results = discoverAdoptableSessions();

    expect(results).toHaveLength(1);
    expect(results[0]!.tmuxTarget).toBe('AD 智投星核心指标:0.0');
    expect(results[0]!.panePid).toBe(1000);
    expect(results[0]!.cliPid).toBe(1001);
    expect(results[0]!.sessionId).toBe('sess-spaced');
  });

  it('should discover multiple CLI types', () => {
    setupMocks({
      paneLines: 'dev:0.0 1000\ndev:1.0 2000\n',
      commMap: { 1000: 'bash', 1100: 'codex', 2000: 'zsh', 2100: 'aiden' },
      childMap: { 1000: [1100], 2000: [2100] },
      cwdMap: { 1100: '/project/a', 2100: '/project/b' },
      dimsMap: { 'dev:0.0': '80 24', 'dev:1.0': '200 50' },
    });

    const results = discoverAdoptableSessions();

    expect(results).toHaveLength(2);
    expect(results[0]!.cliId).toBe('codex');
    expect(results[0]!.paneCols).toBe(80);
    expect(results[0]!.paneRows).toBe(24);
    expect(results[1]!.cliId).toBe('aiden');
    expect(results[1]!.paneCols).toBe(200);
    expect(results[1]!.paneRows).toBe(50);
  });

  it('matches a configured Codex-compatible executable exactly without hiding legacy defaults', () => {
    const fixture = {
      paneLines: 'fork:0.0 1000\nofficial:0.0 2000\nclaude:0.0 3000\n',
      commMap: { 1000: 'zsh', 1001: 'vendorCodex', 2000: 'codex', 3000: 'claude' },
      childMap: { 1000: [1001] },
      cwdMap: { 1001: '/workspace/fork', 2000: '/workspace/official', 3000: '/workspace/claude' },
      dimsMap: {
        'fork:0.0': '100 30',
        'official:0.0': '120 40',
        'claude:0.0': '140 50',
      },
    };
    setupMocks(fixture);

    const custom = discoverAdoptableSessions('codex', '/opt/Vendor Codex/vendorCodex');
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({ tmuxTarget: 'fork:0.0', cliPid: 1001, cliId: 'codex' });

    // Omitting the executable takes the untouched static path: official Codex
    // and Claude are still classified normally, while the unknown fork is not.
    setupMocks(fixture);
    expect(discoverAdoptableSessions().map(s => [s.tmuxTarget, s.cliId])).toEqual([
      ['official:0.0', 'codex'],
      ['claude:0.0', 'claude-code'],
    ]);
  });

  it('discovers a configured Codex-compatible executable in a known Node launcher slot', () => {
    setupMocks({
      paneLines: 'fork:0.0 1000\n',
      commMap: { 1000: 'zsh', 1001: 'node' },
      childMap: { 1000: [1001] },
      cmdlineMap: {
        1001: ['node', '--enable-source-maps', '/opt/vendorCodex'],
      },
      cwdMap: { 1001: '/workspace/fork' },
      dimsMap: { 'fork:0.0': '100 30' },
    });

    expect(discoverAdoptableSessions('codex', '/opt/vendorCodex')).toEqual([
      expect.objectContaining({
        tmuxTarget: 'fork:0.0',
        cliPid: 1001,
        cliId: 'codex',
        cwd: '/workspace/fork',
      }),
    ]);
  });

  it('does not adopt a generic launcher when the custom executable appears only in program argv', () => {
    setupMocks({
      paneLines: 'unrelated:0.0 1000\n',
      commMap: { 1000: 'zsh', 1001: 'node' },
      childMap: { 1000: [1001] },
      cmdlineMap: { 1001: ['node', '/srv/unrelated.js', '/opt/vendorCodex'] },
      cwdMap: { 1001: '/workspace/unrelated' },
      dimsMap: { 'unrelated:0.0': '100 30' },
    });

    expect(discoverAdoptableSessions('codex', '/opt/vendorCodex')).toEqual([]);
  });

  it('uses the same exact executable filter in the single-pane confirm path', () => {
    setupMocks({
      paneLines: 'fork:0.0 1000\nofficial:0.0 2000\n',
      commMap: { 1000: 'vendorCodex', 2000: 'codex' },
      cwdMap: { 1000: '/workspace/fork', 2000: '/workspace/official' },
      dimsMap: { 'fork:0.0': '100 30', 'official:0.0': '120 40' },
    });

    expect(discoverAdoptableSessionByTarget(
      'fork:0.0',
      'codex',
      '/opt/vendorCodex',
    )).toMatchObject({ cliPid: 1000, cliId: 'codex' });
    expect(discoverAdoptableSessionByTarget(
      'official:0.0',
      'codex',
      '/opt/vendorCodex',
    )).toBeUndefined();
  });

  it('should bind a Codex rollout opened by the native child below its Node launcher', () => {
    const cliSessionId = '019f829a-3c55-75c3-b408-bb44fd88c067';
    setupMocks({
      paneLines: 'codex:0.0 1000\n',
      // npm's `codex` shim stays alive as a Node launcher. Its argv matches
      // Codex before discovery reaches the native child that owns the rollout.
      commMap: { 1000: 'zsh', 1001: 'node', 1002: 'codex' },
      cmdlineMap: { 1001: ['node', '/opt/codex/bin/codex'] },
      childMap: { 1000: [1001], 1001: [1002] },
      cwdMap: { 1001: '/workspace/project', 1002: '/workspace/project' },
      dimsMap: { 'codex:0.0': '160 50' },
      procFdMap: {
        1002: [`/home/testuser/.codex/sessions/2026/07/21/rollout-2026-07-21T03-00-00-${cliSessionId}.jsonl`],
      },
    });

    const results = discoverAdoptableSessions('codex');

    expect(results).toHaveLength(1);
    // The worker must poll the native pid so it can late-bind a rollout that
    // is not open yet when `/adopt` first scans the pane.
    expect(results[0]!.cliPid).toBe(1002);
    expect(results[0]!.sessionId).toBe(cliSessionId);
  });

  it('should keep the outer native Codex pid when it launches a shell with an inner Codex', () => {
    const outerSessionId = '019f829a-3c55-75c3-b408-bb44fd88c068';
    const innerSessionId = '019f829a-3c55-75c3-b408-bb44fd88c069';
    setupMocks({
      paneLines: 'codex:0.0 1000\n',
      commMap: { 1000: 'zsh', 1001: 'codex', 1002: 'bash', 1003: 'codex' },
      childMap: { 1000: [1001], 1001: [1002], 1002: [1003] },
      cwdMap: { 1001: '/workspace/outer', 1003: '/workspace/inner' },
      dimsMap: { 'codex:0.0': '160 50' },
      procFdMap: {
        1001: [`/home/testuser/.codex/sessions/2026/07/21/rollout-2026-07-21T03-00-00-${outerSessionId}.jsonl`],
        1003: [`/home/testuser/.codex/sessions/2026/07/21/rollout-2026-07-21T03-01-00-${innerSessionId}.jsonl`],
      },
    });

    const results = discoverAdoptableSessions('codex');

    expect(results).toHaveLength(1);
    expect(results[0]!.cliPid).toBe(1001);
    expect(results[0]!.sessionId).toBe(outerSessionId);
    expect(results[0]!.cwd).toBe('/workspace/outer');
  });

  it('should discover seed and relay processes by comm (Claude Code forks)', () => {
    setupMocks({
      paneLines: 'dev:0.0 1000\ndev:1.0 2000\n',
      commMap: { 1000: 'bash', 1100: 'seed', 2000: 'zsh', 2100: 'relay' },
      childMap: { 1000: [1100], 2000: [2100] },
      cwdMap: { 1100: '/project/seed', 2100: '/project/relay' },
      dimsMap: { 'dev:0.0': '80 24', 'dev:1.0': '200 50' },
    });

    const results = discoverAdoptableSessions();

    expect(results).toHaveLength(2);
    expect(results[0]!.cliId).toBe('seed');
    expect(results[1]!.cliId).toBe('relay');
  });

  it('should discover cursor-agent processes as Cursor sessions', () => {
    setupMocks({
      paneLines: 'cursor:0.0 1000\n',
      commMap: { 1000: 'zsh', 1001: 'cursor-agent' },
      childMap: { 1000: [1001] },
      cwdMap: { 1001: '/workspace/cursor' },
      dimsMap: { 'cursor:0.0': '160 50' },
    });

    const results = discoverAdoptableSessions();

    expect(results).toHaveLength(1);
    expect(results[0]!.cliId).toBe('cursor');
    expect(results[0]!.cliPid).toBe(1001);
    expect(results[0]!.cwd).toBe('/workspace/cursor');
  });

  it('should derive startedAt from process start time for non-Claude CLIs', () => {
    setupMocks({
      paneLines: 'cursor:0.0 1000\n',
      commMap: { 1000: 'zsh', 1001: 'cursor-agent' },
      childMap: { 1000: [1001] },
      cwdMap: { 1001: '/workspace/cursor' },
      dimsMap: { 'cursor:0.0': '160 50' },
      // btime 1_700_000_000s + 50000 ticks / 100 Hz = 1_700_000_500s
      statMap: { 1001: 50_000 },
      bootTimeSeconds: 1_700_000_000,
    });

    const results = discoverAdoptableSessions();

    expect(results).toHaveLength(1);
    expect(results[0]!.cliId).toBe('cursor');
    expect(results[0]!.startedAt).toBe(1_700_000_500_000);
  });

  it('should treat generic agent as Cursor only for Cursor-filtered adoption', () => {
    setupMocks({
      paneLines: 'cursor:0.0 1000\n',
      commMap: { 1000: 'zsh', 1001: 'MainThread' },
      childMap: { 1000: [1001] },
      cmdlineMap: { 1001: ['/home/user/.local/bin/agent', '--model', 'gpt-5.5-extra-high'] },
      cwdMap: { 1001: '/workspace/cursor' },
      dimsMap: { 'cursor:0.0': '160 50' },
    });

    expect(discoverAdoptableSessions()).toHaveLength(0);

    const results = discoverAdoptableSessions('cursor');
    expect(results).toHaveLength(1);
    expect(results[0]!.cliId).toBe('cursor');
    expect(results[0]!.cliPid).toBe(1001);
    expect(results[0]!.cwd).toBe('/workspace/cursor');
  });

  it('should skip bmx-* prefixed sessions', () => {
    setupMocks({
      paneLines: 'bmx-abc12345:0.0 1000\nmysession:0.0 2000\n',
      // The bmx pane has a claude process but should be skipped
      commMap: { 1000: 'zsh', 1001: 'claude', 2000: 'zsh', 2001: 'codex' },
      childMap: { 1000: [1001], 2000: [2001] },
      cwdMap: { 1001: '/project/a', 2001: '/project/b' },
      dimsMap: { 'bmx-abc12345:0.0': '80 24', 'mysession:0.0': '120 40' },
    });

    const results = discoverAdoptableSessions();

    expect(results).toHaveLength(1);
    expect(results[0]!.tmuxTarget).toBe('mysession:0.0');
    expect(results[0]!.cliId).toBe('codex');
  });

  it('should handle panes with no CLI process gracefully', () => {
    setupMocks({
      paneLines: 'mysession:0.0 1000\nmysession:0.1 2000\n',
      // pane 1000 has vim, pane 2000 has only a shell — no known CLI
      commMap: { 1000: 'bash', 1001: 'vim', 2000: 'zsh' },
      childMap: { 1000: [1001], 1001: [] },
      cwdMap: {},
      dimsMap: {},
    });

    const results = discoverAdoptableSessions();
    expect(results).toHaveLength(0);
  });

  it('should handle tmux not available gracefully', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('tmux: command not found');
    });

    const results = discoverAdoptableSessions();
    expect(results).toHaveLength(0);
  });

  it('should handle empty tmux output', () => {
    setupMocks({
      paneLines: '',
    });

    const results = discoverAdoptableSessions();
    expect(results).toHaveLength(0);
  });

  it('should skip pane when cwd cannot be read', () => {
    setupMocks({
      paneLines: 'mysession:0.0 1000\n',
      commMap: { 1000: 'claude' },
      cwdMap: {}, // no cwd for pid 1000
      dimsMap: { 'mysession:0.0': '80 24' },
    });

    const results = discoverAdoptableSessions();
    expect(results).toHaveLength(0);
  });

  it('should skip pane when dimensions cannot be read', () => {
    setupMocks({
      paneLines: 'mysession:0.0 1000\n',
      commMap: { 1000: 'claude' },
      cwdMap: { 1000: '/home/user/project' },
      dimsMap: {}, // no dimensions
    });

    const results = discoverAdoptableSessions();
    expect(results).toHaveLength(0);
  });

  it('should detect CLI process directly on pane shell pid (depth 0)', () => {
    setupMocks({
      paneLines: 'mysession:0.0 1000\n',
      commMap: { 1000: 'opencode' },
      cwdMap: { 1000: '/workspace' },
      dimsMap: { 'mysession:0.0': '160 48' },
    });

    const results = discoverAdoptableSessions();

    expect(results).toHaveLength(1);
    expect(results[0]!.cliId).toBe('opencode');
    expect(results[0]!.cliPid).toBe(1000);
    expect(results[0]!.cwd).toBe('/workspace');
  });

  it('should detect MTR CLI process', () => {
    setupMocks({
      paneLines: 'mtrsession:0.0 1000\n',
      commMap: { 1000: 'mtr' },
      cwdMap: { 1000: '/workspace/mtr' },
      dimsMap: { 'mtrsession:0.0': '120 40' },
    });

    const results = discoverAdoptableSessions();

    expect(results).toHaveLength(1);
    expect(results[0]!.cliId).toBe('mtr');
    expect(results[0]!.cwd).toBe('/workspace/mtr');
  });

  it('should treat OpenCode comm as MTR when the MTR bot filters adopt sessions', () => {
    setupMocks({
      paneLines: 'mtrsession:0.0 1000\n',
      commMap: { 1000: 'opencode' },
      cwdMap: { 1000: '/workspace/mtr' },
      dimsMap: { 'mtrsession:0.0': '120 40' },
    });

    const results = discoverAdoptableSessions('mtr');

    expect(results).toHaveLength(1);
    expect(results[0]!.cliId).toBe('mtr');
    expect(results[0]!.cwd).toBe('/workspace/mtr');
  });

  it('should treat dot-prefixed OpenCode comm as MTR when the MTR bot filters adopt sessions', () => {
    setupMocks({
      paneLines: 'mtrsession:0.0 1000\n',
      commMap: { 1000: 'zsh', 1001: 'node', 1002: '.opencode' },
      childMap: { 1000: [1001], 1001: [1002] },
      cwdMap: { 1002: '/workspace/mtr' },
      dimsMap: { 'mtrsession:0.0': '120 40' },
    });

    const results = discoverAdoptableSessions('mtr');

    expect(results).toHaveLength(1);
    expect(results[0]!.cliId).toBe('mtr');
    expect(results[0]!.cliPid).toBe(1002);
    expect(results[0]!.cwd).toBe('/workspace/mtr');
  });

  it('should keep OpenCode comm as OpenCode when the OpenCode bot filters adopt sessions', () => {
    setupMocks({
      paneLines: 'opencode:0.0 1000\n',
      commMap: { 1000: 'opencode' },
      cwdMap: { 1000: '/workspace/opencode' },
      dimsMap: { 'opencode:0.0': '120 40' },
    });

    const results = discoverAdoptableSessions('opencode');

    expect(results).toHaveLength(1);
    expect(results[0]!.cliId).toBe('opencode');
    expect(results[0]!.cwd).toBe('/workspace/opencode');
  });

  it('should keep dot-prefixed OpenCode comm as OpenCode when the OpenCode bot filters adopt sessions', () => {
    setupMocks({
      paneLines: 'opencode:0.0 1000\n',
      commMap: { 1000: '.opencode' },
      cwdMap: { 1000: '/workspace/opencode' },
      dimsMap: { 'opencode:0.0': '120 40' },
    });

    const results = discoverAdoptableSessions('opencode');

    expect(results).toHaveLength(1);
    expect(results[0]!.cliId).toBe('opencode');
    expect(results[0]!.cwd).toBe('/workspace/opencode');
  });

  it('should detect Hermes CLI process', () => {
    setupMocks({
      paneLines: 'hermessession:0.0 1000\n',
      commMap: { 1000: 'hermes' },
      cwdMap: { 1000: '/workspace/hermes' },
      dimsMap: { 'hermessession:0.0': '120 40' },
    });

    const results = discoverAdoptableSessions();

    expect(results).toHaveLength(1);
    expect(results[0]!.cliId).toBe('hermes');
    expect(results[0]!.cwd).toBe('/workspace/hermes');
  });

  it('should detect Pi CLI process', () => {
    setupMocks({
      paneLines: 'pisession:0.0 1000\n',
      commMap: { 1000: 'pi' },
      cwdMap: { 1000: '/workspace/pi' },
      dimsMap: { 'pisession:0.0': '120 40' },
    });

    const results = discoverAdoptableSessions();

    expect(results).toHaveLength(1);
    expect(results[0]!.cliId).toBe('pi');
    expect(results[0]!.cwd).toBe('/workspace/pi');
  });

  it('should not include sessionId for non-claude CLI types', () => {
    setupMocks({
      paneLines: 'mysession:0.0 1000\n',
      commMap: { 1000: 'bash', 1001: 'gemini' },
      childMap: { 1000: [1001] },
      cwdMap: { 1001: '/home/user/proj' },
      dimsMap: { 'mysession:0.0': '80 24' },
    });

    const results = discoverAdoptableSessions();

    expect(results).toHaveLength(1);
    expect(results[0]!.cliId).toBe('gemini');
    expect(results[0]!.sessionId).toBeUndefined();
    expect(results[0]!.startedAt).toBeUndefined();
  });

  it('should handle Claude session metadata file not found gracefully', () => {
    setupMocks({
      paneLines: 'mysession:0.0 1000\n',
      commMap: { 1000: 'bash', 1001: 'claude' },
      childMap: { 1000: [1001] },
      cwdMap: { 1001: '/home/user/proj' },
      dimsMap: { 'mysession:0.0': '80 24' },
      claudeMeta: {}, // no metadata file
    });

    const results = discoverAdoptableSessions();

    expect(results).toHaveLength(1);
    expect(results[0]!.cliId).toBe('claude-code');
    expect(results[0]!.sessionId).toBeUndefined();
    expect(results[0]!.startedAt).toBeUndefined();
  });

  it('should handle malformed pane lines', () => {
    setupMocks({
      paneLines: 'garbage-line-no-space\nmysession:0.0 notanumber\nmysession:0.1 3000\n',
      commMap: { 3000: 'coco' },
      cwdMap: { 3000: '/workspace' },
      dimsMap: { 'mysession:0.1': '80 24' },
    });

    const results = discoverAdoptableSessions();

    expect(results).toHaveLength(1);
    expect(results[0]!.cliId).toBe('coco');
  });

  // ── CoCo /proc/<pid>/fd-based session discovery ─────────────────────────
  // CoCo opens session.log + traces.jsonl with continuous fds (events.jsonl
  // is opened per write, so unreliable). The discovery walks /proc/<pid>/fd
  // looking for any open file under ~/.cache/coco/sessions/<sid>/...

  it('captures CoCo sessionId from a live session.log fd', () => {
    setupMocks({
      paneLines: 'work:0.0 5000\n',
      commMap: { 5000: 'bash', 5001: 'coco' },
      childMap: { 5000: [5001] },
      cwdMap: { 5001: '/workspace/proj' },
      dimsMap: { 'work:0.0': '120 30' },
      procFdMap: {
        5001: [
          '/dev/null',
          '/home/testuser/.cache/coco/sessions/8db7d911-96f3-4764-a310-e42ae4cb626f/session.log',
          '/home/testuser/.cache/coco/sessions/8db7d911-96f3-4764-a310-e42ae4cb626f/traces.jsonl',
        ],
      },
    });

    const results = discoverAdoptableSessions();

    expect(results).toHaveLength(1);
    expect(results[0]!.cliId).toBe('coco');
    expect(results[0]!.sessionId).toBe('8db7d911-96f3-4764-a310-e42ae4cb626f');
  });

  it('skips CoCo handles flagged as deleted by procfs', () => {
    // Real-world case from the field: an e2e test wiped the session dir
    // while CoCo kept its fds open. procfs marks the targets " (deleted)".
    // findCocoSessionByPid must NOT return that sid, otherwise adopt
    // attaches a bridge that watches a path which will never gain content.
    setupMocks({
      paneLines: 'work:0.0 6000\n',
      commMap: { 6000: 'bash', 6001: 'coco' },
      childMap: { 6000: [6001] },
      cwdMap: { 6001: '/workspace/proj' },
      dimsMap: { 'work:0.0': '120 30' },
      procFdMap: {
        6001: [
          '/home/testuser/.cache/coco/sessions/eb9da933-f82f-4a95-ac17-857f16daa318/session.log (deleted)',
          '/home/testuser/.cache/coco/sessions/eb9da933-f82f-4a95-ac17-857f16daa318/traces.jsonl (deleted)',
        ],
      },
    });

    const results = discoverAdoptableSessions();

    expect(results).toHaveLength(1);
    expect(results[0]!.cliId).toBe('coco');
    expect(results[0]!.sessionId).toBeUndefined();
  });

  it('returns coco discovery without sessionId when no fd points at a session dir', () => {
    setupMocks({
      paneLines: 'work:0.0 7000\n',
      commMap: { 7000: 'bash', 7001: 'coco' },
      childMap: { 7000: [7001] },
      cwdMap: { 7001: '/workspace/proj' },
      dimsMap: { 'work:0.0': '120 30' },
      procFdMap: {
        7001: ['/dev/null', '/dev/urandom', '/tmp/somefile.log'],
      },
    });

    const results = discoverAdoptableSessions();

    expect(results).toHaveLength(1);
    expect(results[0]!.cliId).toBe('coco');
    expect(results[0]!.sessionId).toBeUndefined();
  });

  it('rejects fd targets whose sid segment is not a valid uuid', () => {
    setupMocks({
      paneLines: 'work:0.0 8000\n',
      commMap: { 8000: 'bash', 8001: 'coco' },
      childMap: { 8000: [8001] },
      cwdMap: { 8001: '/workspace/proj' },
      dimsMap: { 'work:0.0': '120 30' },
      procFdMap: {
        // Looks like a valid path but the segment isn't uuid-shaped — could
        // be an e2e fixture dir name (e.g. e2e-stream-text-1778316270608)
        // and we don't want to bind adopt to that.
        8001: ['/home/testuser/.cache/coco/sessions/e2e-stream-text-1778316270608/session.log'],
      },
    });

    const results = discoverAdoptableSessions();

    expect(results).toHaveLength(1);
    expect(results[0]!.sessionId).toBeUndefined();
  });

  // ── TRAE (traex) /proc/<pid>/fd-based session discovery ─────────────────
  // TRAE is a Codex-family CLI: it holds its rollout JSONL fd open for the
  // session lifetime, so the pid → rollout probe mirrors Codex but matches
  // the ~/.trae/cli/sessions layout.

  it('detects a TRAE (traex) CLI process and captures sessionId from the open rollout fd', () => {
    const sessionId = '8db7d911-96f3-4764-a310-e42ae4cb626f';
    const root = mkdtempSync(join(tmpdir(), 'botmux-traex-discovery-'));
    const rolloutDir = join(root, '.trae', 'cli', 'sessions', '2026', '06', '11');
    const rolloutPath = join(
      rolloutDir,
      `rollout-2026-06-11T10-00-00-${sessionId}.jsonl`,
    );
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(rolloutPath, `${JSON.stringify({
      timestamp: '2026-06-11T10:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: sessionId,
        timestamp: '2026-06-11T10:00:00.000Z',
        cwd: '/workspace/proj',
        source: 'cli',
        thread_source: 'user',
      },
    })}\n`);

    try {
      setupMocks({
        paneLines: 'work:0.0 9000\n',
        commMap: { 9000: 'bash', 9001: 'traex' },
        childMap: { 9000: [9001] },
        cwdMap: { 9001: '/workspace/proj' },
        dimsMap: { 'work:0.0': '120 30' },
        procFdMap: {
          9001: ['/dev/null', rolloutPath],
        },
      });

      const results = discoverAdoptableSessions();

      expect(results).toHaveLength(1);
      expect(results[0]!.cliId).toBe('traex');
      expect(results[0]!.cwd).toBe('/workspace/proj');
      expect(results[0]!.sessionId).toBe(sessionId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns traex discovery without sessionId when no rollout fd is open', () => {
    setupMocks({
      paneLines: 'work:0.0 9100\n',
      commMap: { 9100: 'bash', 9101: 'traex' },
      childMap: { 9100: [9101] },
      cwdMap: { 9101: '/workspace/proj' },
      dimsMap: { 'work:0.0': '120 30' },
      procFdMap: {
        9101: ['/dev/null', '/tmp/somefile.log'],
      },
    });

    const results = discoverAdoptableSessions();

    expect(results).toHaveLength(1);
    expect(results[0]!.cliId).toBe('traex');
    expect(results[0]!.sessionId).toBeUndefined();
  });

  it('filters to traex sessions only when a TRAE bot adopts', () => {
    setupMocks({
      paneLines: 'work:0.0 9200\nwork:0.1 9300\n',
      commMap: { 9200: 'traex', 9300: 'codex' },
      cwdMap: { 9200: '/workspace/trae-proj', 9300: '/workspace/codex-proj' },
      dimsMap: { 'work:0.0': '120 30', 'work:0.1': '120 30' },
    });

    const results = discoverAdoptableSessions('traex' as CliId);

    expect(results).toHaveLength(1);
    expect(results[0]!.cliId).toBe('traex');
    expect(results[0]!.cwd).toBe('/workspace/trae-proj');
  });
});

describe('discoverAdoptableSessionByTarget', () => {
  // 三个 pane，其中只有一个是我们要解析的目标。全量扫描会把三个都走一遍进程树，
  // 快路径只碰目标那一个。
  const threePanes = {
    paneLines: 'dev:0.0 1000\ndev:0.1 2000\nother:0.0 3000\n',
    commMap: { 1000: 'zsh', 1001: 'claude', 2000: 'zsh', 2001: 'codex', 3000: 'zsh', 3001: 'claude' },
    childMap: { 1000: [1001], 2000: [2001], 3000: [3001] },
    cwdMap: { 1001: '/project/a', 2001: '/project/b', 3001: '/project/c' },
    dimsMap: { 'dev:0.0': '120 40', 'dev:0.1': '80 24', 'other:0.0': '200 50' },
    claudeMeta: {
      1001: JSON.stringify({ sessionId: 'sess-a', cwd: '/project/a', startedAt: 1700000000000 }),
      3001: JSON.stringify({ sessionId: 'sess-c', cwd: '/project/c', startedAt: 1700000000000 }),
    },
  };

  it('解析出的结果与全量扫描中同一 pane 的条目完全一致', () => {
    // 这条是快路径的核心契约：只收窄候选集，不改判定结果。两者一旦漂移，
    // /adopt 就会出现「卡片里能选、点了却接管不了」这类难查的偏差。
    setupMocks(threePanes);
    const fromFullScan = discoverAdoptableSessions().find(s => s.tmuxTarget === 'dev:0.0');

    setupMocks(threePanes);
    const fromFastPath = discoverAdoptableSessionByTarget('dev:0.0');

    expect(fromFastPath).toEqual(fromFullScan);
    expect(fromFastPath).toEqual({
      source: 'tmux',
      tmuxTarget: 'dev:0.0',
      panePid: 1000,
      cliPid: 1001,
      cliId: 'claude-code',
      sessionId: 'sess-a',
      cwd: '/project/a',
      startedAt: 1700000000000,
      paneCols: 120,
      paneRows: 40,
    });
  });

  it('不执行 tmux list-panes —— 这正是它比全量扫描快的原因', () => {
    setupMocks(threePanes);
    discoverAdoptableSessionByTarget('dev:0.0');

    const ranListPanes = mockExecSync.mock.calls.some(([cmd]) => String(cmd).includes('list-panes'));
    expect(ranListPanes).toBe(false);
  });

  it('只解析目标 pane 的进程树，不碰其它 pane', () => {
    setupMocks(threePanes);
    discoverAdoptableSessionByTarget('dev:0.0');

    // 其它两个 pane 的 shell pid 不应该出现在任何一条被执行的命令里
    const allCmds = mockExecSync.mock.calls.map(([cmd]) => String(cmd)).join('\n');
    expect(allCmds).not.toContain('2000');
    expect(allCmds).not.toContain('3000');
  });

  it('与全量扫描一样跳过 bmx-* 会话（botmux 自己管的 pane）', () => {
    setupMocks({
      paneLines: 'bmx-managed:0.0 1000\n',
      commMap: { 1000: 'zsh', 1001: 'claude' },
      childMap: { 1000: [1001] },
      cwdMap: { 1001: '/project/a' },
      dimsMap: { 'bmx-managed:0.0': '120 40' },
    });

    expect(discoverAdoptableSessionByTarget('bmx-managed:0.0')).toBeUndefined();
  });

  it('遵守 filterCliId —— 卡片 option 是用户可控输入，丢掉过滤等于允许切换 CLI 实现', () => {
    setupMocks(threePanes);
    // dev:0.1 跑的是 codex，一个 claude-code bot 不该解析得出它
    expect(discoverAdoptableSessionByTarget('dev:0.1', 'claude-code')).toBeUndefined();

    setupMocks(threePanes);
    expect(discoverAdoptableSessionByTarget('dev:0.1', 'codex')?.cliId).toBe('codex');
  });

  it('pane 已经不存在时返回 undefined，由调用方回落全量扫描', () => {
    setupMocks(threePanes);
    expect(discoverAdoptableSessionByTarget('gone:9.9')).toBeUndefined();
  });

  // ── 死目标 / 模糊命中：tmux display -t 失败时不报错，必须靠回显内容判断 ──
  //
  // 真机实测（tmux 3.6a），以下全部 exit 0、stderr 为空：
  //   nonexist:0.0  → 地址回显为 ':.'、pane_pid 为空串
  //   claude:99.0   → 解析到 claude:2.3（window 索引不存在 → 回落活动 window）
  //   claude:1.99   → 解析到 claude:1.1（pane 索引不存在 → 回落活动 pane）
  //   clau:1.3      → 解析到 claude:1.3（会话名前缀匹配）
  // 所以既不能靠 exit code 判死活，也不能相信「拿到正数 pid」= 命中了请求的 pane。

  it('死目标返回空 pane_pid + exit 0 时返回 undefined，绝不落到 pid 0 的进程树遍历', () => {
    // 回归：Number('') === 0 且 isNaN(0) === false。少了正数校验就会调
    // findCliProcess(0, 3)，从 pid 0 开始 BFS 整棵进程树、每个节点 fork 一次全量
    // ps，实测 >45s 同步冻结 —— 比它要优化掉的 5.4s 更糟，且直接冻住 daemon
    // 事件循环。注意这条路径不抛异常，与上面 'gone:9.9' 那条（mock 抛错）不同。
    mockExecSync.mockImplementation((cmd: unknown) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('pane_pid')) return ':. \n';  // 真机对死目标的原样回显
      throw new Error(`unexpected command: ${cmdStr}`);
    });

    expect(discoverAdoptableSessionByTarget('nonexist:0.0', 'claude-code')).toBeUndefined();

    const cmds = mockExecSync.mock.calls.map(([c]) => String(c));
    expect(cmds).toHaveLength(1);                                  // 只问了一次 tmux
    expect(cmds.some(c => c.includes('ps '))).toBe(false);         // 没碰进程树
    expect(cmds.some(c => c.includes('list-panes'))).toBe(false);  // 也没回落全量扫描
  });

  it('tmux 模糊命中别的 pane 时返回 undefined（canonical 地址与请求不符）', () => {
    // 回归：只补 panePid > 0 挡不住这条 —— 长会话 foobarX 会让短 target foobar
    // 拿到一个**真实正数** pid。若把请求的 target 原样回填，得到的对象就是
    // 「地址是用户选的、数据是另一个 pane 的」，端到端可导致接管错误会话。
    mockExecSync.mockImplementation((cmd: unknown) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('pane_pid')) return 'foobarX:0.0 4242\n';
      throw new Error(`unexpected command: ${cmdStr}`);
    });

    expect(discoverAdoptableSessionByTarget('foobar:0.0', 'claude-code')).toBeUndefined();

    const cmds = mockExecSync.mock.calls.map(([c]) => String(c));
    expect(cmds).toHaveLength(1);
    expect(cmds.some(c => c.includes('ps '))).toBe(false);
  });

  it('canonical 地址与请求严格相等时才继续解析（含空格会话名也能对上）', () => {
    // 反向断言上一条不是「无脑返回 undefined」：地址对得上就正常走下去。
    setupMocks({
      paneLines: 'AD 智投星核心指标:0.0 1000\n',
      commMap: { 1000: 'fish', 1001: 'claude' },
      childMap: { 1000: [1001] },
      cwdMap: { 1001: '/home/user/project' },
      dimsMap: { 'AD 智投星核心指标:0.0': '210 61' },
    });

    expect(discoverAdoptableSessionByTarget('AD 智投星核心指标:0.0')?.cliPid).toBe(1001);
  });

  it('会话名含空格时同样能解析（与全量扫描的切分规则一致）', () => {
    setupMocks({
      paneLines: 'AD 智投星核心指标:0.0 1000\n',
      commMap: { 1000: 'fish', 1001: 'claude' },
      childMap: { 1000: [1001] },
      cwdMap: { 1001: '/home/user/project' },
      dimsMap: { 'AD 智投星核心指标:0.0': '210 61' },
      claudeMeta: {
        1001: JSON.stringify({ sessionId: 'sess-spaced', cwd: '/home/user/project', startedAt: 1700000000000 }),
      },
    });

    const result = discoverAdoptableSessionByTarget('AD 智投星核心指标:0.0');
    expect(result?.tmuxTarget).toBe('AD 智投星核心指标:0.0');
    expect(result?.sessionId).toBe('sess-spaced');
  });
});

describe('validateAdoptTarget', () => {
  // Legacy signature accepted (tmuxTarget, pid); the herdr PR refactored
  // validateAdoptTarget to take the full AdoptableSession-shaped object so it
  // can route to either tmux or herdr validators. These helpers preserve the
  // original tests' intent while feeding the new shape.
  const tmuxTarget = (target: string, cliPid: number, cliId: CliId = 'claude-code') => ({
    source: 'tmux' as const,
    tmuxTarget: target,
    cliPid,
    cliId,
    cwd: '/x',
    paneCols: 200,
    paneRows: 50,
  });

  it('should return true when expected CLI process is still running', () => {
    setupMocks({
      paneLines: 'mysession:0.0 1000\n',
      commMap: { 1000: 'bash', 1001: 'claude' },
      childMap: { 1000: [1001] },
      cwdMap: {},
      dimsMap: {},
    });

    const result = validateAdoptTarget(tmuxTarget('mysession:0.0', 1001));
    expect(result).toBe(true);
  });

  it('revalidates a custom Codex runtime by exact executable basename', () => {
    setupMocks({
      paneLines: 'fork:0.0 1000\nofficial:0.0 2000\n',
      commMap: { 1000: 'vendorCodex', 2000: 'codex' },
      cwdMap: {},
      dimsMap: {},
    });

    expect(validateAdoptTarget(
      tmuxTarget('fork:0.0', 1000, 'codex'),
      '/opt/vendorCodex',
    )).toBe(true);
    expect(validateAdoptTarget(
      tmuxTarget('official:0.0', 2000, 'codex'),
      '/opt/vendorCodex',
    )).toBe(false);
  });

  it('should return false when pane no longer exists', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('pane not found');
    });

    const result = validateAdoptTarget(tmuxTarget('nosession:0.0', 1001));
    expect(result).toBe(false);
  });

  it('死目标返回空 pane_pid + exit 0 时返回 false，绝不落到 pid 0 的进程树遍历', () => {
    // 回归（与 discoverAdoptableSessionByTarget 同源）：`tmux display -t` 对死/歧义
    // 目标不报错，只打印空 pane_pid，`Number('') === 0` 且 `isNaN(0) === false`。
    // 少了正数校验就会调 hasCliProcess(0, expectedPid, 6)：从 pid 0 BFS 整棵进程树、
    // 每个节点 fork 一次全量 `ps`（实测 >20s 同步冻结），且一旦 expectedPid 恰好还活在
    // 机器上任意位置就误报 alive。这条路径由 daemon 重启对持久化 adopt 目标的校验触发。
    // 注意与上面「pane not found」那条（mock 抛错）不同：这条不抛异常。
    mockExecSync.mockImplementation((cmd: unknown) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('pane_pid')) return '\n';  // 真机对死目标的原样回显：空 pid
      throw new Error(`unexpected command: ${cmdStr}`);
    });

    expect(validateAdoptTarget(tmuxTarget('nonexist:0.0', 1001))).toBe(false);

    const cmds = mockExecSync.mock.calls.map(([c]) => String(c));
    expect(cmds.some(c => c.includes('ps '))).toBe(false);  // 没碰进程树 → 没冻结
  });

  it('should return false when CLI process has exited', () => {
    setupMocks({
      paneLines: 'mysession:0.0 1000\n',
      // Only the shell remains, no CLI child
      commMap: { 1000: 'bash' },
      childMap: {},
      cwdMap: {},
      dimsMap: {},
    });

    const result = validateAdoptTarget(tmuxTarget('mysession:0.0', 1001));
    expect(result).toBe(false);
  });

  it('should return false when a different CLI process is running', () => {
    setupMocks({
      paneLines: 'mysession:0.0 1000\n',
      commMap: { 1000: 'bash', 1099: 'codex' },
      childMap: { 1000: [1099] },
      cwdMap: {},
      dimsMap: {},
    });

    // Expecting pid 1001 but found 1099
    const result = validateAdoptTarget(tmuxTarget('mysession:0.0', 1001));
    expect(result).toBe(false);
  });

  it('should return true when expected pid matches at deeper level', () => {
    setupMocks({
      paneLines: 'mysession:0.0 1000\n',
      commMap: { 1000: 'zsh', 1001: 'bash', 1002: 'aiden' },
      childMap: { 1000: [1001], 1001: [1002] },
      cwdMap: {},
      dimsMap: {},
    });

    const result = validateAdoptTarget(tmuxTarget('mysession:0.0', 1002, 'aiden'));
    expect(result).toBe(true);
  });

  it('should validate the native Codex pid below an argv-matched Node launcher', () => {
    setupMocks({
      paneLines: 'codex:0.0 1000\n',
      commMap: { 1000: 'zsh', 1001: 'node', 1002: 'codex' },
      cmdlineMap: { 1001: ['node', '/opt/codex/bin/codex'] },
      childMap: { 1000: [1001], 1001: [1002] },
      cwdMap: {},
      dimsMap: {},
    });

    expect(validateAdoptTarget(tmuxTarget('codex:0.0', 1002, 'codex'))).toBe(true);
  });

  // Regression: a Cursor agent installed under the generic name `agent` is only
  // recognized when the identifier is filtered to 'cursor'. Discovery passes
  // that filter, so the session surfaces; validation must pass it too, or the
  // pre-adopt guard (and every daemon-restart restore) re-identifies nothing and
  // wrongly reports the live session as exited. See cliIdForComm's `agent` case.
  it('should validate a generic-agent Cursor target by threading its cliId filter', () => {
    setupMocks({
      paneLines: 'cursor:0.0 1000\n',
      // comm is the launcher's thread name; the real identity is argv[0]=`agent`.
      commMap: { 1000: 'zsh', 1001: 'MainThread' },
      childMap: { 1000: [1001] },
      cmdlineMap: { 1001: ['/home/user/.local/bin/agent', '--model', 'gpt-5.5'] },
      cwdMap: {},
      dimsMap: {},
    });

    // Filtered to 'cursor' (as discovery was) → the agent is re-identified → alive.
    expect(validateAdoptTarget(tmuxTarget('cursor:0.0', 1001, 'cursor'))).toBe(true);
    // Without the Cursor filter the generic `agent` is unrecognized — proving the
    // guard genuinely consults the filter, and that omitting it (the old bug)
    // would have falsely reported "exited".
    expect(validateAdoptTarget(tmuxTarget('cursor:0.0', 1001, 'claude-code'))).toBe(false);
  });
});
