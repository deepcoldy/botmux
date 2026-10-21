import { describe, expect, it, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  asyncCall: vi.fn(),
  syncCall: vi.fn(),
  roots: vi.fn(async () => new Map()),
  daemon: vi.fn(async () => new Map()),
  readdir: vi.fn(() => [] as string[]),
  readFile: vi.fn(),
  readlink: vi.fn(),
  traexRollout: vi.fn(),
  traexThread: vi.fn(),
}));

vi.mock('../src/services/orca-cli.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/orca-cli.js')>(),
  callOrca: state.asyncCall,
  callOrcaSync: state.syncCall,
}));

vi.mock('../src/services/orca-relay.js', () => ({
  queryOrcaRelayPtyMetadata: state.roots,
}));

vi.mock('../src/services/orca-daemon.js', () => ({
  queryOrcaDaemonSessions: state.daemon,
}));

vi.mock('../src/services/traex-transcript.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/traex-transcript.js')>(),
  findTraexRolloutByPid: state.traexRollout,
  findTraexThreadByPid: state.traexThread,
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    readdirSync: state.readdir,
    readFileSync: state.readFile,
    readlinkSync: state.readlink,
  };
});
import {
  cliIdFromOrcaAgentIdentity,
  discoverAdoptableOrcaSessionByHandle,
  discoverAdoptableOrcaSessions,
  validateOrcaAdoptTarget,
} from '../src/core/orca-adopt-discovery.js';
import { validateAdoptTargetState } from '../src/core/session-discovery.js';

const terminal = {
  handle: 'term_1',
  ptyId: 'ssh:h@@pty:1',
  incarnationId: 'inc_1',
  worktreeId: 'repo::/work',
  worktreePath: '/work',
  connected: true,
  writable: true,
  executionHostId: 'ssh:h',
  agentIdentity: 'trae',
  title: 'Fix login flow',
};

const serverTerminal = {
  ...terminal,
  ptyId: 'serve-3687641d',
  executionHostId: 'local',
};

type OrcaCallResult = { ok: boolean; value?: unknown; kind?: string; message?: string };

/** Instance-aware CLI mock: the relay list is served unless a server list is
 * pinned, mirroring a machine where only one Orca installation answers. */
function mockOrcaLists(lists: { relay?: OrcaCallResult; server?: OrcaCallResult; local?: OrcaCallResult } = {}): void {
  state.asyncCall.mockImplementation(async (_args: string[], instance?: string) => {
    if (instance === 'server') return lists.server ?? { ok: false, kind: 'unavailable', message: 'no orcad' };
    if (instance === 'relay-local') return lists.local ?? { ok: false, kind: 'unavailable', message: 'no local relay' };
    return lists.relay ?? { ok: false, kind: 'unavailable', message: 'no relay shim' };
  });
}

describe('Orca adopt discovery', () => {
  beforeEach(() => {
    state.asyncCall.mockReset();
    state.syncCall.mockReset();
    state.roots.mockClear();
    state.roots.mockResolvedValue(new Map());
    state.daemon.mockReset();
    state.daemon.mockResolvedValue(new Map());
    state.readdir.mockReturnValue([]);
    state.readFile.mockReset();
    state.readlink.mockReset();
    state.traexRollout.mockReset();
    state.traexThread.mockReset();
  });

  it('maps Orca TRAE identity to the Botmux traex adapter', () => {
    expect(cliIdFromOrcaAgentIdentity('trae')).toBe('traex');
    expect(cliIdFromOrcaAgentIdentity('trae-cli')).toBe('traex');
  });

  it('returns only connected writable terminals for the bot CLI', async () => {
    mockOrcaLists({ relay: { ok: true, value: {
      terminals: [
        terminal,
        { ...terminal, handle: 'term_codex', agentIdentity: 'codex' },
        { ...terminal, handle: 'term_readonly', writable: false },
      ],
    } } });
    const candidates = await discoverAdoptableOrcaSessions('traex');
    expect(candidates.map(item => item.orcaTerminalHandle)).toEqual(['term_1']);
    expect(candidates[0]?.orcaTerminalTitle).toBe('Fix login flow');
    expect(candidates[0]?.orcaInstance).toBe('relay');
  });

  it('binds transcripts only to a CLI below the relay-attested PTY root', async () => {
    mockOrcaLists({ relay: { ok: true, value: { terminals: [terminal] } } });
    state.roots.mockResolvedValue(new Map([['pty:1', { pid: 100, cols: 104, rows: 50 }]]));
    state.readdir.mockReturnValue(['100', '101', '102', '999']);
    state.readFile.mockImplementation((path: string, encoding?: string) => {
      if (path.endsWith('/status')) {
        const pid = Number(path.split('/')[2]);
        return `Name:\tt\nPPid:\t${pid === 101 ? 100 : pid === 102 ? 101 : 1}\n`;
      }
      if (path.endsWith('/environ')) {
        return Buffer.from(path.includes('/101/') || path.includes('/102/') || path.includes('/999/')
          ? 'ORCA_TERMINAL_HANDLE=term_1\0'
          : '');
      }
      if (path.endsWith('/comm')) return encoding ? 'traecli\n' : Buffer.from('traecli\n');
      throw new Error(`unexpected read ${path}`);
    });
    state.readlink.mockReturnValue('/usr/bin/traecli');

    const [candidate] = await discoverAdoptableOrcaSessions('traex');
    expect(candidate?.cliPid).toBe(102);
    expect(candidate).toMatchObject({ paneCols: 104, paneRows: 50 });
    expect(candidate?.paneSizeVerified).toBe(true);
  });

  it('binds server-terminal transcripts and geometry through the terminal daemon', async () => {
    mockOrcaLists({ server: { ok: true, value: { terminals: [serverTerminal] } } });
    state.daemon.mockResolvedValue(new Map([['term_1', { pid: 100, cols: 120, rows: 40 }]]));
    state.readdir.mockReturnValue(['100', '101']);
    state.readFile.mockImplementation((path: string, encoding?: string) => {
      if (path.endsWith('/status')) {
        const pid = Number(path.split('/')[2]);
        return `Name:\tt\nPPid:\t${pid === 101 ? 100 : 1}\n`;
      }
      if (path.endsWith('/environ')) {
        return Buffer.from(path.includes('/101/') ? 'ORCA_TERMINAL_HANDLE=term_1\0' : '');
      }
      if (path.endsWith('/comm')) return encoding ? 'traecli\n' : Buffer.from('traecli\n');
      throw new Error(`unexpected read ${path}`);
    });
    state.readlink.mockReturnValue('/usr/bin/traecli');
    state.traexThread.mockReturnValue({ cliSessionId: 'thread_1', title: '修复登录流程' });

    const [candidate] = await discoverAdoptableOrcaSessions('traex');
    expect(candidate).toMatchObject({
      orcaInstance: 'server',
      orcaPtyId: 'serve-3687641d',
      cliPid: 101,
      sessionId: 'thread_1',
      orcaTerminalTitle: '修复登录流程',
      paneCols: 120,
      paneRows: 40,
      paneSizeVerified: true,
    });
    expect(state.roots).not.toHaveBeenCalled();
  });

  it('uses the owned TRAE thread title when Orca has no terminal title', async () => {
    mockOrcaLists({ server: { ok: true, value: { terminals: [{ ...serverTerminal, title: null }] } } });
    state.daemon.mockResolvedValue(new Map([['term_1', { pid: 100, cols: 120, rows: 40 }]]));
    state.readdir.mockReturnValue(['100', '101']);
    state.readFile.mockImplementation((path: string, encoding?: string) => {
      if (path.endsWith('/status')) return `Name:\tt\nPPid:\t${path.includes('/101/') ? 100 : 1}\n`;
      if (path.endsWith('/environ')) return Buffer.from(path.includes('/101/') ? 'ORCA_TERMINAL_HANDLE=term_1\0' : '');
      if (path.endsWith('/comm')) return encoding ? 'traecli\n' : Buffer.from('traecli\n');
      throw new Error(`unexpected read ${path}`);
    });
    state.readlink.mockReturnValue('/usr/bin/traecli');
    state.traexThread.mockReturnValue({ cliSessionId: 'thread_1', title: '修复登录流程' });

    expect(await discoverAdoptableOrcaSessions('traex')).toMatchObject([{
      sessionId: 'thread_1', orcaTerminalTitle: '修复登录流程',
    }]);
  });

  it('merges relay and server instances and tags each candidate with its instance', async () => {
    mockOrcaLists({
      relay: { ok: true, value: { terminals: [terminal] } },
      server: { ok: true, value: { terminals: [{ ...serverTerminal, handle: 'term_srv' }] } },
    });
    const candidates = await discoverAdoptableOrcaSessions('traex');
    expect(candidates.map(item => [item.orcaTerminalHandle, item.orcaInstance]))
      .toEqual([['term_1', 'relay'], ['term_srv', 'server']]);
  });

  it('discovers the original local relay terminal after the desktop disconnects', async () => {
    mockOrcaLists({
      relay: { ok: false, kind: 'unavailable', message: 'No owning Orca client is connected to the relay' },
      local: { ok: true, value: { terminals: [{ ...terminal, pid: 100, cols: 104, rows: 40 }] } },
    });
    expect(await discoverAdoptableOrcaSessions('traex')).toMatchObject([{
      orcaTerminalHandle: 'term_1', orcaInstance: 'relay-local', paneCols: 104, paneRows: 40,
      paneSizeVerified: true,
    }]);
    expect(state.roots).not.toHaveBeenCalled();
  });

  it('prefers the autonomous local relay route while the desktop is still online', async () => {
    mockOrcaLists({
      relay: { ok: true, value: { terminals: [terminal] } },
      local: { ok: true, value: { terminals: [{ ...terminal, pid: 100, cols: 104, rows: 40 }] } },
    });
    expect(await discoverAdoptableOrcaSessions('traex')).toMatchObject([{ orcaInstance: 'relay-local' }]);
  });

  it('keeps the server entry when both instances report the same handle', async () => {
    mockOrcaLists({
      relay: { ok: true, value: { terminals: [terminal] } },
      server: { ok: true, value: { terminals: [serverTerminal] } },
    });
    state.daemon.mockResolvedValue(new Map([['term_1', { pid: 100, cols: 120, rows: 40 }]]));
    const candidates = await discoverAdoptableOrcaSessions('traex');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ orcaInstance: 'server', paneSizeVerified: true });
  });

  it('resolves a handle through whichever instance owns the terminal', async () => {
    state.asyncCall.mockImplementation(async (_args: string[], instance?: string) => (
      instance === 'server'
        ? { ok: true, value: { terminal: serverTerminal } }
        : { ok: false, kind: 'missing', message: 'terminal_not_found' }
    ));
    expect(await discoverAdoptableOrcaSessionByHandle('term_1', 'traex'))
      .toMatchObject({ orcaInstance: 'server', orcaTerminalHandle: 'term_1' });

    state.asyncCall.mockImplementation(async (_args: string[], instance?: string) => (
      instance === 'server' || instance === 'relay-local'
        ? { ok: false, kind: 'missing', message: 'terminal_not_found' }
        : { ok: true, value: { terminal } }
    ));
    expect(await discoverAdoptableOrcaSessionByHandle('term_1', 'traex'))
      .toMatchObject({ orcaInstance: 'relay', orcaTerminalHandle: 'term_1' });
  });

  it('binds a Claude session from the relay-attested CLI pid, not cwd uniqueness', async () => {
    mockOrcaLists({ relay: { ok: true, value: {
      terminals: [{ ...terminal, agentIdentity: 'claude' }],
    } } });
    state.roots.mockResolvedValue(new Map([['pty:1', { pid: 100, cols: 90, rows: 40 }]]));
    state.readdir.mockReturnValue(['100', '101']);
    state.readFile.mockImplementation((path: string, encoding?: string) => {
      if (path.endsWith('/status')) {
        const pid = Number(path.split('/')[2]);
        return `Name:\tt\nPPid:\t${pid === 101 ? 100 : 1}\n`;
      }
      if (path.endsWith('/environ')) return Buffer.from(path.includes('/101/') ? 'ORCA_TERMINAL_HANDLE=term_1\0' : '');
      if (path.endsWith('/comm')) return encoding ? 'claude\n' : Buffer.from('claude\n');
      if (path.endsWith('/.claude/sessions/101.json')) {
        return JSON.stringify({ sessionId: 'claude-session-1', cwd: '/work' });
      }
      throw new Error(`unexpected read ${path}`);
    });
    state.readlink.mockReturnValue('/usr/bin/claude');

    const [candidate] = await discoverAdoptableOrcaSessions('claude-code');
    expect(candidate).toMatchObject({ cliPid: 101, sessionId: 'claude-session-1' });
  });

  it('rejects terminals with neither an incarnation nor a PTY identity', async () => {
    mockOrcaLists({ relay: { ok: true, value: {
      terminals: [{ ...terminal, ptyId: null, incarnationId: null }],
    } } });
    expect(await discoverAdoptableOrcaSessions('traex')).toEqual([]);
  });

  it('does not guess identity for a configured custom runtime', async () => {
    expect(await discoverAdoptableOrcaSessions('traex', '/opt/custom-traex')).toEqual([]);
    expect(state.asyncCall).not.toHaveBeenCalled();
    expect(validateAdoptTargetState({
      source: 'orca',
      orcaTerminalHandle: 'term_1',
      orcaWorktreeId: 'repo::/work',
      orcaAgentIdentity: 'trae',
      cliId: 'traex',
      cwd: '/work',
    }, '/opt/custom-traex')).toBe('missing');
    expect(state.syncCall).not.toHaveBeenCalled();
  });

  it('rejects a reused handle when its incarnation changed', () => {
    state.syncCall.mockReturnValue({
      ok: true,
      value: { terminal: { ...terminal, incarnationId: 'inc_2' } },
    });
    expect(validateOrcaAdoptTarget({
      orcaTerminalHandle: 'term_1',
      orcaPtyId: 'ssh:h@@pty:1',
      orcaIncarnationId: 'inc_1',
      orcaExecutionHostId: 'ssh:h',
      orcaWorktreeId: 'repo::/work',
      orcaAgentIdentity: 'trae',
    })).toBe('missing');
  });

  it('routes liveness validation through the instance that owns the terminal', () => {
    state.syncCall.mockReturnValue({ ok: true, value: { terminal: serverTerminal } });
    expect(validateOrcaAdoptTarget({
      orcaTerminalHandle: 'term_1',
      orcaPtyId: 'serve-3687641d',
      orcaIncarnationId: 'inc_1',
      orcaExecutionHostId: 'local',
      orcaWorktreeId: 'repo::/work',
      orcaAgentIdentity: 'trae',
      orcaInstance: 'server',
    })).toBe('alive');
    expect(state.syncCall).toHaveBeenLastCalledWith(
      ['terminal', 'show', '--terminal', 'term_1'], 'server',
    );

    state.syncCall.mockClear();
    state.syncCall.mockReturnValue({ ok: true, value: { terminal } });
    expect(validateOrcaAdoptTarget({
      orcaTerminalHandle: 'term_1',
      orcaPtyId: 'ssh:h@@pty:1',
      orcaIncarnationId: 'inc_1',
      orcaExecutionHostId: 'ssh:h',
      orcaWorktreeId: 'repo::/work',
      orcaAgentIdentity: 'trae',
      orcaInstance: 'relay',
    })).toBe('alive');
    expect(state.syncCall).toHaveBeenLastCalledWith(
      ['terminal', 'show', '--terminal', 'term_1'], 'relay',
    );
  });

  it('fails closed when restoring legacy Orca metadata without a stable identity', () => {
    const legacyTarget = {
      orcaTerminalHandle: 'term_1',
      orcaWorktreeId: 'repo::/work',
      orcaAgentIdentity: 'trae',
    };
    state.syncCall.mockReturnValue({ ok: true, value: { terminal } });
    expect(validateOrcaAdoptTarget(legacyTarget)).toBe('missing');
    // Legacy rows have no instance field; they must stay relay-routed.
    expect(state.syncCall).toHaveBeenLastCalledWith(
      ['terminal', 'show', '--terminal', 'term_1'], 'relay',
    );

    state.syncCall.mockReturnValue({ ok: true, value: { terminal: { ...terminal, ptyId: 'ssh:h@@pty:2', incarnationId: 'inc_2' } } });
    expect(validateAdoptTargetState({
      source: 'orca',
      ...legacyTarget,
      cliId: 'traex',
      cwd: '/work',
    })).toBe('missing');
  });

  it('fails closed on restore when a persisted identity field is missing', () => {
    // A matching terminal would validate 'alive', so only the presence guard
    // can produce 'missing' — mutating the guard away reddens this test.
    const full = {
      source: 'orca',
      orcaTerminalHandle: 'term_1',
      orcaPtyId: 'ssh:h@@pty:1',
      orcaIncarnationId: 'inc_1',
      orcaExecutionHostId: 'ssh:h',
      orcaWorktreeId: 'repo::/work',
      orcaAgentIdentity: 'trae',
      cliId: 'traex',
      cwd: '/work',
    };
    state.syncCall.mockReturnValue({ ok: true, value: { terminal } });
    for (const key of ['orcaTerminalHandle', 'orcaWorktreeId', 'orcaAgentIdentity']) {
      expect(validateAdoptTargetState({ ...full, [key]: undefined })).toBe('missing');
    }
    expect(state.syncCall).not.toHaveBeenCalled();
  });

  it('keeps transport failures distinct from a missing terminal', () => {
    state.syncCall.mockReturnValue({ ok: false, kind: 'unavailable', message: 'offline' });
    expect(validateOrcaAdoptTarget({
      orcaTerminalHandle: 'term_1',
      orcaPtyId: 'ssh:h@@pty:1',
      orcaWorktreeId: 'repo::/work',
      orcaAgentIdentity: 'trae',
    })).toBe('unknown');
  });
});
