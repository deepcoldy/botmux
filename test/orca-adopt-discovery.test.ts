import { describe, expect, it, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  asyncCall: vi.fn(),
  syncCall: vi.fn(),
  roots: vi.fn(async () => new Map()),
  readdir: vi.fn(() => [] as string[]),
  readFile: vi.fn(),
  readlink: vi.fn(),
}));

vi.mock('../src/services/orca-cli.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/orca-cli.js')>(),
  callOrca: state.asyncCall,
  callOrcaSync: state.syncCall,
}));

vi.mock('../src/services/orca-relay.js', () => ({
  queryOrcaRelayPtyMetadata: state.roots,
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

describe('Orca adopt discovery', () => {
  beforeEach(() => {
    state.asyncCall.mockReset();
    state.syncCall.mockReset();
    state.roots.mockClear();
    state.roots.mockResolvedValue(new Map());
    state.readdir.mockReturnValue([]);
    state.readFile.mockReset();
    state.readlink.mockReset();
  });

  it('maps Orca TRAE identity to the Botmux traex adapter', () => {
    expect(cliIdFromOrcaAgentIdentity('trae')).toBe('traex');
    expect(cliIdFromOrcaAgentIdentity('trae-cli')).toBe('traex');
  });

  it('returns only connected writable terminals for the bot CLI', async () => {
    state.asyncCall.mockResolvedValue({
      ok: true,
      value: {
        terminals: [
          terminal,
          { ...terminal, handle: 'term_codex', agentIdentity: 'codex' },
          { ...terminal, handle: 'term_readonly', writable: false },
        ],
      },
    });
    const candidates = await discoverAdoptableOrcaSessions('traex');
    expect(candidates.map(item => item.orcaTerminalHandle)).toEqual(['term_1']);
    expect(candidates[0]?.orcaTerminalTitle).toBe('Fix login flow');
  });

  it('binds transcripts only to a CLI below the relay-attested PTY root', async () => {
    state.asyncCall.mockResolvedValue({ ok: true, value: { terminals: [terminal] } });
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

  it('binds a Claude session from the relay-attested CLI pid, not cwd uniqueness', async () => {
    state.asyncCall.mockResolvedValue({
      ok: true,
      value: { terminals: [{ ...terminal, agentIdentity: 'claude' }] },
    });
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
    state.asyncCall.mockResolvedValue({
      ok: true,
      value: { terminals: [{ ...terminal, ptyId: null, incarnationId: null }] },
    });
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
