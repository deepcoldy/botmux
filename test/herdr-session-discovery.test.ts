/**
 * Unit tests for the Herdr branch of session-discovery.
 *
 * Verifies:
 *   - discoverAdoptableSessions() walks `herdr session list` → `agent list`,
 *     skips bmx-* sessions, filters by CliId, and produces AdoptableSession
 *     rows with the right pane/agent metadata.
 *   - validateAdoptTarget() resolves to 'alive' / 'missing' / 'unknown' based
 *     on whether the herdr agent still has the recorded pane id.
 *   - adoptTargetLabel() and adoptTargetKey() format herdr targets distinctly
 *     from tmux ones so the /adopt UI doesn't collide.
 *
 * Tmux discovery already has full coverage in session-discovery.test.ts;
 * here we mock tmux as "not running" and focus on the herdr code path.
 *
 * Run:  pnpm vitest run test/herdr-session-discovery.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  readlinkSync: vi.fn(() => { throw new Error('ENOENT'); }),
  realpathSync: vi.fn((p: string) => p),
}));

vi.mock('node:os', () => ({
  homedir: () => '/home/testuser',
  platform: () => 'linux',
}));

import { execFileSync, execSync } from 'node:child_process';
import {
  discoverAdoptableSessions,
  validateAdoptTarget,
  validateAdoptTargetState,
  adoptTargetLabel,
  adoptTargetKey,
} from '../src/core/session-discovery.js';

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedExecSync = vi.mocked(execSync);

// ─── Helpers ───────────────────────────────────────────────────────────────

interface HerdrFixture {
  sessions: Array<{ name: string; running: boolean }>;
  agentsBySession: Record<string, Array<{ name?: string; agent?: string; pane_id?: string; terminal_id?: string; cwd?: string }>>;
  panesBySession?: Record<string, Array<{ name?: string; pane_id?: string; terminal_id?: string; cwd?: string; foreground_cwd?: string }>>;
  processByPane?: Record<string, { pid: number; name: string; argv: string[]; cwd: string }>;
  /** Throw on certain probes to simulate `unknown` validation result. */
  failOn?: (args: string[]) => boolean;
}

function installHerdrFixture(fx: HerdrFixture) {
  mockedExecFileSync.mockImplementation(((cmd: any, args: any) => {
    if (cmd !== 'herdr') throw new Error(`unexpected cmd ${cmd}`);
    const argv = args as string[];
    if (fx.failOn?.(argv)) throw new Error('herdr failure');

    if (argv[0] === 'session' && argv[1] === 'list') {
      return JSON.stringify({ sessions: fx.sessions }) as any;
    }
    if (argv.includes('--session')) {
      const sessionName = argv[argv.indexOf('--session') + 1];
      if (argv.includes('agent') && argv.includes('list')) {
        const agents = fx.agentsBySession[sessionName] ?? [];
        return JSON.stringify({ result: { agents } }) as any;
      }
      if (argv.includes('pane') && argv.includes('list')) {
        return JSON.stringify({ result: { panes: fx.panesBySession?.[sessionName] ?? [] } }) as any;
      }
      if (argv.includes('pane') && argv.includes('process-info')) {
        const paneId = argv[argv.indexOf('--pane') + 1];
        const proc = fx.processByPane?.[`${sessionName}:${paneId}`];
        return JSON.stringify({ result: { process_info: { foreground_processes: proc ? [proc] : [] } } }) as any;
      }
    }
    return '' as any;
  }) as any);
}

beforeEach(() => {
  vi.resetAllMocks();
  // No tmux: `tmux list-panes` throws → discoverAdoptableSessions falls back
  // to herdr-only enumeration.
  mockedExecSync.mockImplementation(() => { throw new Error('no tmux'); });
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('discoverAdoptableSessions (herdr branch)', () => {
  it('returns an AdoptableSession row for each known-CLI herdr agent', () => {
    installHerdrFixture({
      sessions: [
        { name: 'work', running: true },
        { name: 'bmx-deadbeef', running: true },  // must be filtered (botmux-owned)
        { name: 'stopped', running: false },      // must be filtered (not running)
      ],
      agentsBySession: {
        work: [
          { name: 'cc', agent: 'claude', pane_id: '1-1', terminal_id: 't-1', cwd: '/projects/api' },
          { name: 'cx', agent: 'codex',  pane_id: '1-2', terminal_id: 't-2', cwd: '/projects/web' },
          { name: 'sh', agent: 'bash',   pane_id: '1-3', terminal_id: 't-3', cwd: '/home' },          // unknown CLI → filtered
          { name: 'botmux-deadbeef', agent: 'claude', pane_id: '1-4', cwd: '/projects/managed' },      // botmux-managed shared agent → filtered
          { name: 'no-pane', agent: 'claude', cwd: '/projects/x' },                                   // missing pane_id → filtered
        ],
        'bmx-deadbeef': [
          { name: 'botmux', agent: 'claude', pane_id: '5-5', cwd: '/projects/own' },
        ],
      },
    });

    const sessions = discoverAdoptableSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.every(s => s.source === 'herdr')).toBe(true);

    const claude = sessions.find(s => s.cliId === 'claude-code');
    expect(claude).toMatchObject({
      source: 'herdr',
      herdrSessionName: 'work',
      herdrPaneId: '1-1',
      herdrTarget: '1-1',
      herdrTerminalId: 't-1',
      cwd: '/projects/api',
    });

    const codex = sessions.find(s => s.cliId === 'codex');
    expect(codex).toMatchObject({
      source: 'herdr',
      herdrSessionName: 'work',
      herdrPaneId: '1-2',
      cwd: '/projects/web',
    });
  });

  it('discovers a TraeX foreground process even before Herdr reports it as an agent', () => {
    installHerdrFixture({
      sessions: [{ name: 'work', running: true }],
      agentsBySession: { work: [] },
      panesBySession: {
        work: [{ pane_id: 'w1:p1', terminal_id: 'term-1', cwd: '/projects/traex' }],
      },
      processByPane: {
        'work:w1:p1': { pid: 4321, name: 'traex', argv: ['traex', '--resume'], cwd: '/projects/traex' },
      },
    });

    expect(discoverAdoptableSessions('traex')).toEqual([
      expect.objectContaining({
        source: 'herdr',
        herdrSessionName: 'work',
        herdrPaneId: 'w1:p1',
        herdrTerminalId: 'term-1',
        cliPid: 4321,
        cliId: 'traex',
        cwd: '/projects/traex',
      }),
    ]);
  });

  it('filters by CliId when requested', () => {
    installHerdrFixture({
      sessions: [{ name: 'work', running: true }],
      agentsBySession: {
        work: [
          { agent: 'claude', pane_id: '1-1', cwd: '/a' },
          { agent: 'codex',  pane_id: '1-2', cwd: '/b' },
        ],
      },
    });

    const onlyCodex = discoverAdoptableSessions('codex');
    expect(onlyCodex).toHaveLength(1);
    expect(onlyCodex[0]!.cliId).toBe('codex');
  });

  it('treats generic agent as Cursor only when Cursor is requested', () => {
    installHerdrFixture({
      sessions: [{ name: 'work', running: true }],
      agentsBySession: {
        work: [
          { agent: 'agent', pane_id: '1-1', cwd: '/cursor' },
        ],
      },
    });

    expect(discoverAdoptableSessions()).toHaveLength(0);

    const onlyCursor = discoverAdoptableSessions('cursor');
    expect(onlyCursor).toHaveLength(1);
    expect(onlyCursor[0]!.cliId).toBe('cursor');
    expect(onlyCursor[0]!.cwd).toBe('/cursor');
  });

  it('returns an empty list when herdr is unavailable', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(discoverAdoptableSessions()).toEqual([]);
  });
});

describe('validateAdoptTarget (herdr branch)', () => {
  it("returns 'alive' when the recorded pane_id is still listed", () => {
    installHerdrFixture({
      sessions: [{ name: 'work', running: true }],
      agentsBySession: { work: [{ pane_id: '1-1', agent: 'claude' }] },
      processByPane: {
        'work:1-1': { pid: 1234, name: 'claude', argv: ['claude'], cwd: '/x' },
      },
    });
    const target = {
      source: 'herdr' as const,
      herdrSessionName: 'work',
      herdrPaneId: '1-1',
      cliId: 'claude-code' as const,
      cwd: '/x',
      paneCols: 200,
      paneRows: 50,
    };
    expect(validateAdoptTargetState(target)).toBe('alive');
    expect(validateAdoptTarget(target)).toBe(true);
  });

  it("returns 'alive' for a hook-less TraeX pane whose foreground process still matches", () => {
    installHerdrFixture({
      sessions: [{ name: 'work', running: true }],
      agentsBySession: { work: [] },
      panesBySession: { work: [{ pane_id: 'w1:p1', cwd: '/x' }] },
      processByPane: {
        'work:w1:p1': { pid: 4321, name: 'traex', argv: ['traex', '--resume'], cwd: '/x' },
      },
    });
    const target = {
      source: 'herdr' as const,
      herdrSessionName: 'work',
      herdrPaneId: 'w1:p1',
      cliPid: 4321,
      cliId: 'traex' as const,
      cwd: '/x',
      paneCols: 200,
      paneRows: 50,
    };
    expect(validateAdoptTargetState(target)).toBe('alive');
  });

  it("returns 'missing' when the pane disappeared (kept agent list, no match)", () => {
    installHerdrFixture({
      sessions: [{ name: 'work', running: true }],
      agentsBySession: { work: [{ pane_id: '9-9', agent: 'claude' }] },
    });
    const target = {
      source: 'herdr' as const,
      herdrSessionName: 'work',
      herdrPaneId: '1-1',
      cliId: 'claude-code' as const,
      cwd: '/x',
      paneCols: 200,
      paneRows: 50,
    };
    expect(validateAdoptTargetState(target)).toBe('missing');
    expect(validateAdoptTarget(target)).toBe(false);
  });

  it("returns 'unknown' when the herdr probe itself errors (don't close adopt sessions)", () => {
    installHerdrFixture({
      sessions: [{ name: 'work', running: true }],
      agentsBySession: { work: [{ pane_id: '1-1', agent: 'claude' }] },
      failOn: a => a.includes('agent') && a.includes('list'),
    });
    const target = {
      source: 'herdr' as const,
      herdrSessionName: 'work',
      herdrPaneId: '1-1',
      cliId: 'claude-code' as const,
      cwd: '/x',
      paneCols: 200,
      paneRows: 50,
    };
    expect(validateAdoptTargetState(target)).toBe('unknown');
    // validateAdoptTarget returns true only for 'alive' — unknown still false
    expect(validateAdoptTarget(target)).toBe(false);
  });

  it("returns 'missing' when sessionName or paneId is absent", () => {
    expect(validateAdoptTargetState({
      source: 'herdr' as const,
      cliId: 'claude-code' as const,
      cwd: '/x',
      paneCols: 0, paneRows: 0,
    })).toBe('missing');
  });
});

describe('adoptTargetLabel / adoptTargetKey', () => {
  const t = {
    source: 'herdr' as const,
    herdrSessionName: 'work',
    herdrPaneId: '1-2',
    cliId: 'claude-code' as const,
    cwd: '/x',
    paneCols: 200,
    paneRows: 50,
  };

  it('herdr label formats as "<session>:<pane>"', () => {
    expect(adoptTargetLabel(t)).toBe('work:1-2');
  });

  it('herdr key is namespaced so it does not collide with tmux keys', () => {
    expect(adoptTargetKey(t)).toBe('herdr:work:1-2');
  });

  it('tmux label and key keep their original shape', () => {
    const tmuxTarget = {
      source: 'tmux' as const,
      tmuxTarget: '0:2.0',
      panePid: 1234,
      cliPid: 5678,
      cliId: 'claude-code' as const,
      cwd: '/x',
      paneCols: 200,
      paneRows: 50,
    };
    expect(adoptTargetLabel(tmuxTarget)).toBe('0:2.0');
    expect(adoptTargetKey(tmuxTarget)).toBe('tmux:0:2.0:5678');
  });
});
