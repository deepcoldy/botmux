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

// Command assertions use the bare name whether or not this host has herdr on PATH.
vi.mock('../src/utils/herdr-executable.js', () => ({ herdrExecutable: () => 'herdr' }));
vi.mock('node:child_process', () => {
  const actual = require('node:child_process') as typeof import('node:child_process');
  return { ...actual, execSync: vi.fn(), execFileSync: vi.fn() };
});

vi.mock('node:fs', () => {
  const actual = require('node:fs') as typeof import('node:fs');
  return {
    ...actual,
    existsSync: () => false,
    // Plain functions, not vi.fn(): bun's mock.module has been observed to
    // install a bare mock (returns undefined) in place of `vi.fn(() => [])`,
    // which then crashes `for (const name of names)` in findUniqueClaudeSessionByCwd.
    readdirSync: () => [],
    readFileSync: () => { throw new Error('ENOENT'); },
    readlinkSync: () => { throw new Error('ENOENT'); },
    realpathSync: (p: string) => p,
  };
});

vi.mock('node:os', () => {
  const actual = require('node:os') as typeof import('node:os');
  return { ...actual, homedir: () => '/home/testuser', platform: () => 'linux' };
});

import { execFileSync, execSync } from 'node:child_process';
import {
  discoverAdoptableSessions,
  validateAdoptTarget,
  validateAdoptTargetState,
  adoptTargetLabel,
  adoptTargetKey,
  excludeOwnedHerdrAdoptTargets,
} from '../src/core/session-discovery.js';

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedExecSync = vi.mocked(execSync);

// ─── Helpers ───────────────────────────────────────────────────────────────

interface HerdrAgentFixture {
  name?: string;
  agent?: string;
  agent_session?: { kind?: string; value?: string };
  pane_id?: string;
  terminal_id?: string;
  cwd?: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
}

interface HerdrPaneFixture {
  name?: string;
  agent?: string;
  pane_id?: string;
  terminal_id?: string;
  cwd?: string;
  foreground_cwd?: string;
  /** Manual pane label (`herdr pane rename`); only `pane list` exposes it. */
  label?: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
}

interface HerdrFixture {
  sessions: Array<{ name: string; running: boolean }>;
  agentsBySession: Record<string, HerdrAgentFixture[]>;
  panesBySession?: Record<string, HerdrPaneFixture[]>;
  processByPane?: Record<string, { pid: number; name: string; argv?: string[]; argv0?: string; cwd: string }>;
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
        { name: 'botmux', running: true },        // machine-wide rendezvous → adoptable
        { name: 'bmx-deadbeef', running: true },  // legacy per-topic host → filtered
        { name: 'stopped', running: false },      // must be filtered (not running)
      ],
      agentsBySession: {
        work: [
          { name: 'cc', agent: 'claude', pane_id: '1-1', terminal_id: 't-1', cwd: '/projects/api' },
          { name: 'cx', agent: 'codex',  pane_id: '1-2', terminal_id: 't-2', cwd: '/projects/web' },
          { name: 'sh', agent: 'bash',   pane_id: '1-3', terminal_id: 't-3', cwd: '/home' },          // unknown CLI → filtered
          { name: 'botmux-deadbeef', agent: 'claude', pane_id: '1-4', cwd: '/projects/managed' },      // names are not a discovery policy
          { name: 'no-pane', agent: 'claude', cwd: '/projects/x' },                                   // missing pane_id → filtered
        ],
        botmux: [
          {
            name: 'botmux-feed1234',
            agent: 'pi',
            agent_session: {
              kind: 'path',
              value: '/home/testuser/.pi/agent/sessions/--projects-pi--/2026-07-23T06-07-29-246Z_019f8d96-0dde-7e12-8a8b-51a09766d97f.jsonl',
            },
            pane_id: 'w1:p1',
            terminal_id: 't-pi',
            cwd: '/projects/pi',
          },
        ],
        'bmx-deadbeef': [
          { name: 'botmux', agent: 'claude', pane_id: '5-5', cwd: '/projects/own' },
        ],
      },
      processByPane: {
        'botmux:w1:p1': { pid: 75275, name: 'node', argv0: 'pi', cwd: '/projects/pi' },
      },
    });

    const sessions = discoverAdoptableSessions();
    expect(sessions).toHaveLength(4);
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

    expect(sessions).toContainEqual(expect.objectContaining({
      source: 'herdr',
      herdrSessionName: 'work',
      herdrPaneId: '1-4',
      cwd: '/projects/managed',
    }));

    const pi = sessions.find(s => s.cliId === 'pi');
    expect(pi).toMatchObject({
      source: 'herdr',
      herdrSessionName: 'botmux',
      herdrPaneId: 'w1:p1',
      herdrTerminalId: 't-pi',
      cliPid: 75275,
      sessionId: '019f8d96-0dde-7e12-8a8b-51a09766d97f',
      cwd: '/projects/pi',
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

  it('excludes a managed Herdr agent with an active owner but keeps orphaned siblings', () => {
    const candidates = [
      {
        source: 'herdr' as const,
        herdrSessionName: 'botmux',
        herdrPaneId: 'w1:p1',
        herdrAgentName: 'botmux-owned',
        cliId: 'pi' as const,
        cwd: '/a',
        paneCols: 200,
        paneRows: 50,
      },
      {
        source: 'herdr' as const,
        herdrSessionName: 'botmux',
        herdrPaneId: 'w2:p1',
        herdrAgentName: 'botmux-orphan',
        cliId: 'pi' as const,
        cwd: '/b',
        paneCols: 200,
        paneRows: 50,
      },
    ];

    expect(excludeOwnedHerdrAdoptTargets(candidates, [
      { sessionName: 'botmux', agentName: 'botmux-owned' },
    ])).toEqual([candidates[1]]);
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

describe('discoverAdoptableSessions (herdr live title: pane label > terminal title)', () => {
  /** One Claude agent in pane w1:p1 of session `work`, plus its pane record. */
  function discoverClaude(agent: HerdrAgentFixture = {}, pane?: HerdrPaneFixture) {
    installHerdrFixture({
      sessions: [{ name: 'work', running: true }],
      agentsBySession: {
        work: [{ name: 'cc', agent: 'claude', pane_id: 'w1:p1', terminal_id: 't-1', cwd: '/work/demo', ...agent }],
      },
      panesBySession: {
        work: pane ? [{ pane_id: 'w1:p1', terminal_id: 't-1', cwd: '/work/demo', ...pane }] : [],
      },
    });
    const sessions = discoverAdoptableSessions();
    expect(sessions).toHaveLength(1);
    return sessions[0]!;
  }

  it('uses the pane label ahead of the terminal title', () => {
    const s = discoverClaude(
      { terminal_title_stripped: '修复登录页样式' },
      { label: 'demo-task · 示例', terminal_title_stripped: '修复登录页样式' },
    );
    expect(s.title).toBe('demo-task · 示例');
  });

  it('falls back to the Claude terminal title when the pane has no label', () => {
    expect(discoverClaude(
      { terminal_title_stripped: '修复登录页样式' },
      { terminal_title_stripped: '修复登录页样式' },
    ).title).toBe('修复登录页样式');
    // Agent record without the field → the pane record's terminal title.
    expect(discoverClaude({}, { terminal_title_stripped: '整理示例数据' }).title).toBe('整理示例数据');
  });

  it.each([
    'Claude Code',
    'CLAUDE CODE',
    'claude code',
    '  Claude   Code  ',
    'Claude',  // CLI display name of claude-code
    'claude',  // herdr agent kind
    '/work/demo',
    '~/work/demo',
    '   ',
    '\n\t',
  ])('treats terminal title %j as meaningless (title stays undefined)', (terminalTitle) => {
    expect(discoverClaude({ terminal_title_stripped: terminalTitle }, {}).title).toBeUndefined();
  });

  it('treats a terminal title equal to the herdr agent kind as meaningless', () => {
    // `.claude` still resolves to claude-code but differs from the CLI display
    // name, so only the agent-kind rule can reject it.
    expect(discoverClaude({ agent: '.claude', terminal_title_stripped: '.CLAUDE' }, {}).title).toBeUndefined();
  });

  it('leaves title undefined for an older herdr without label / terminal title, other fields unchanged', () => {
    const s = discoverClaude(
      { agent_session: { kind: 'id', value: '0f8fad5b-d9cb-469f-a165-70867728950e' } },
      {},
    );
    expect(s).toEqual({
      source: 'herdr',
      herdrSessionName: 'work',
      herdrTarget: 'w1:p1',
      herdrPaneId: 'w1:p1',
      herdrAgentName: 'cc',
      herdrTerminalId: 't-1',
      cliId: 'claude-code',
      sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      cwd: '/work/demo',
      paneCols: 200,
      paneRows: 50,
    });
    expect('title' in s).toBe(false);
  });

  it('still discovers the agent and uses its terminal title when `pane list` fails', () => {
    installHerdrFixture({
      sessions: [{ name: 'work', running: true }],
      agentsBySession: {
        work: [{ name: 'cc', agent: 'claude', pane_id: 'w1:p1', cwd: '/work/demo', terminal_title_stripped: '修复登录页样式' }],
      },
      panesBySession: { work: [{ pane_id: 'w1:p1', cwd: '/work/demo', label: 'demo-task · 示例' }] },
      failOn: a => a.includes('pane') && a.includes('list'),
    });
    expect(discoverAdoptableSessions()).toEqual([
      expect.objectContaining({ herdrPaneId: 'w1:p1', cwd: '/work/demo', title: '修复登录页样式' }),
    ]);
  });

  it('reads the pane label on the supplement path (pane only seen by `pane list`)', () => {
    installHerdrFixture({
      sessions: [{ name: 'work', running: true }],
      agentsBySession: { work: [] },
      panesBySession: {
        work: [
          { pane_id: 'w1:p1', terminal_id: 'term-1', cwd: '/work/traex', label: 'demo-task · 示例', terminal_title_stripped: '修复登录页样式' },
          { pane_id: 'w1:p2', terminal_id: 'term-2', cwd: '/work/demo', terminal_title_stripped: '整理示例数据' },
        ],
      },
      processByPane: {
        'work:w1:p1': { pid: 4321, name: 'traex', argv: ['traex', '--resume'], cwd: '/work/traex' },
        'work:w1:p2': { pid: 4322, name: 'claude', argv: ['claude'], cwd: '/work/demo' },
      },
    });
    const sessions = discoverAdoptableSessions();
    expect(sessions.find(s => s.herdrPaneId === 'w1:p1')).toMatchObject({ cliId: 'traex', title: 'demo-task · 示例' });
    expect(sessions.find(s => s.herdrPaneId === 'w1:p2')).toMatchObject({ cliId: 'claude-code', title: '整理示例数据' });
  });

  it('cleans titles: single line, no control chars or angle brackets', () => {
    expect(discoverClaude({}, { label: 'demo-task\n· 示例\t\u0007\u001b<at user_id="all"></at>' }).title)
      .toBe('demo-task · 示例 at user_id="all"/at');
    expect(discoverClaude({}, { label: 'a\u0007b\r\nc' }).title).toBe('ab c');
    expect(discoverClaude({ terminal_title_stripped: '修复\n登录页<b>样式</b>' }, {}).title).toBe('修复 登录页b样式/b');
  });

  it('falls back to the terminal title when the label is empty after cleaning', () => {
    expect(discoverClaude({ terminal_title_stripped: '修复登录页样式' }, { label: ' <> \u0007 ' }).title)
      .toBe('修复登录页样式');
  });

  it('truncates long titles to 80 code points ending in …, never splitting a character', () => {
    const cjk = discoverClaude({}, { label: '修'.repeat(100) }).title!;
    expect(cjk).toBe(`${'修'.repeat(79)}…`);
    expect(Array.from(cjk)).toHaveLength(80);

    const emoji = discoverClaude({}, { label: `${'x'.repeat(78)}${'😀'.repeat(5)}` }).title!;
    expect(emoji).toBe(`${'x'.repeat(78)}😀…`);
    expect(Array.from(emoji)).toHaveLength(80);
    expect(emoji).not.toContain('�');
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);

    const exact = '示'.repeat(80);
    expect(discoverClaude({}, { label: exact }).title).toBe(exact);
  });

  it('calls `pane list` exactly once per herdr session', () => {
    installHerdrFixture({
      sessions: [{ name: 'work', running: true }, { name: 'side', running: true }],
      agentsBySession: {
        work: [
          { agent: 'claude', pane_id: 'w1:p1', cwd: '/work/demo' },
          { agent: 'codex', pane_id: 'w1:p2', cwd: '/work/demo' },
        ],
        side: [{ agent: 'claude', pane_id: 'w2:p1', cwd: '/work/side' }],
      },
      panesBySession: {
        work: [{ pane_id: 'w1:p1', label: 'demo-task · 示例' }, { pane_id: 'w1:p2', label: '整理示例数据' }],
        side: [{ pane_id: 'w2:p1', label: '修复登录页样式' }],
      },
    });
    const sessions = discoverAdoptableSessions();
    expect(sessions.map(s => s.title)).toEqual(['demo-task · 示例', '整理示例数据', '修复登录页样式']);
    const paneListSessions = mockedExecFileSync.mock.calls
      .map(([, args]) => args as string[])
      .filter(a => a.includes('pane') && a.includes('list'))
      .map(a => a[a.indexOf('--session') + 1]);
    expect(paneListSessions).toEqual(['work', 'side']);
  });

  it('uses only the pane label for non-Claude CLIs, never the terminal title', () => {
    installHerdrFixture({
      sessions: [{ name: 'work', running: true }],
      agentsBySession: {
        work: [
          { agent: 'codex', pane_id: 'w1:p1', cwd: '/work/demo', terminal_title_stripped: '修复登录页样式' },
          { agent: 'codex', pane_id: 'w1:p2', cwd: '/work/demo', terminal_title_stripped: '修复登录页样式' },
        ],
      },
      panesBySession: {
        work: [
          { pane_id: 'w1:p1', terminal_title_stripped: '修复登录页样式' },
          { pane_id: 'w1:p2', label: 'demo-task · 示例', terminal_title_stripped: '修复登录页样式' },
          { pane_id: 'w1:p3', cwd: '/work/traex', terminal_title_stripped: '整理示例数据' },
        ],
      },
      processByPane: {
        'work:w1:p3': { pid: 4321, name: 'traex', argv: ['traex'], cwd: '/work/traex' },
      },
    });
    const sessions = discoverAdoptableSessions();
    // The unlabeled Codex pane stays a candidate; only its terminal title is ignored.
    const unlabeled = sessions.find(s => s.herdrPaneId === 'w1:p1');
    expect(unlabeled).toMatchObject({ herdrPaneId: 'w1:p1', cliId: 'codex', cwd: '/work/demo' });
    expect('title' in unlabeled!).toBe(false);
    expect(sessions.find(s => s.herdrPaneId === 'w1:p2')?.title).toBe('demo-task · 示例');
    // Supplement-path row without a usable title keeps its pre-change shape.
    const traex = sessions.find(s => s.herdrPaneId === 'w1:p3')!;
    expect(traex).toMatchObject({ cliId: 'traex', cliPid: 4321, cwd: '/work/traex' });
    expect('title' in traex).toBe(false);
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

  it("returns 'alive' for Herdr 0.7.5 Pi process-info that reports node + argv0 only", () => {
    installHerdrFixture({
      sessions: [{ name: 'collie', running: true }],
      agentsBySession: { collie: [{ pane_id: 'w3:p1', agent: 'pi', cwd: '/x' }] },
      processByPane: {
        'collie:w3:p1': { pid: 75275, name: 'node', argv0: 'pi', cwd: '/x' },
      },
    });
    const target = {
      source: 'herdr' as const,
      herdrSessionName: 'collie',
      herdrPaneId: 'w3:p1',
      cliId: 'pi' as const,
      cwd: '/x',
      paneCols: 200,
      paneRows: 50,
    };
    expect(validateAdoptTargetState(target)).toBe('alive');
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
