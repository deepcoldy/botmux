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

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(),
  readlinkSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: () => '/home/testuser',
  // session-discovery 用 platform() 决定 Linux /proc 快路径 vs macOS ps/lsof 兜底。
  // 既有 mock 数据全部按 Linux 形态准备，所以这里固定为 'linux'。
  // macOS 兜底路径的覆盖见 test/session-discovery.smoke.test.ts。
  platform: () => 'linux',
}));

import { execSync } from 'node:child_process';
import { readFileSync, readlinkSync, existsSync, readdirSync } from 'node:fs';
import { discoverAdoptableSessions, validateAdoptTarget } from '../src/core/session-discovery.js';
import type { CliId } from '../src/adapters/cli/types.js';

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

      // pane_pid query (for validateAdoptTarget)
      if (cmdStr.includes('pane_pid')) {
        // Extract the target and find matching pane from paneLines
        for (const line of paneLines.split('\n')) {
          if (line.startsWith(target + ' ')) {
            return line.split(' ')[1] + '\n';
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
    setupMocks({
      paneLines: 'work:0.0 9000\n',
      commMap: { 9000: 'bash', 9001: 'traex' },
      childMap: { 9000: [9001] },
      cwdMap: { 9001: '/workspace/proj' },
      dimsMap: { 'work:0.0': '120 30' },
      procFdMap: {
        9001: [
          '/dev/null',
          '/home/testuser/.trae/cli/sessions/2026/06/11/rollout-2026-06-11T10-00-00-8db7d911-96f3-4764-a310-e42ae4cb626f.jsonl',
        ],
      },
    });

    const results = discoverAdoptableSessions();

    expect(results).toHaveLength(1);
    expect(results[0]!.cliId).toBe('traex');
    expect(results[0]!.cwd).toBe('/workspace/proj');
    expect(results[0]!.sessionId).toBe('8db7d911-96f3-4764-a310-e42ae4cb626f');
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

  it('should return false when pane no longer exists', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('pane not found');
    });

    const result = validateAdoptTarget(tmuxTarget('nosession:0.0', 1001));
    expect(result).toBe(false);
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
