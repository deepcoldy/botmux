import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  asyncCall: vi.fn(),
  syncCall: vi.fn(),
  relayMetadata: vi.fn(async () => new Map()),
}));

vi.mock('../src/services/orca-cli.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/orca-cli.js')>(),
  callOrca: api.asyncCall,
  callOrcaSync: api.syncCall,
}));

vi.mock('../src/services/orca-relay.js', () => ({
  queryOrcaRelayPtyMetadata: api.relayMetadata,
}));

import { OrcaBackend, renderOrcaTranscriptHistory } from '../src/adapters/backend/orca-backend.js';

const identity = (overrides: Partial<ConstructorParameters<typeof OrcaBackend>[0]> = {}) => ({
  terminalHandle: 'term_1',
  ptyId: 'ssh:h@@pty:1',
  incarnationId: 'inc_1',
  executionHostId: 'ssh:h',
  worktreeId: 'repo::/w',
  agentIdentity: 'trae',
  ...overrides,
});

const liveIdentity = (overrides: Record<string, unknown> = {}) => ({
  handle: 'term_1',
  ptyId: 'ssh:h@@pty:1',
  incarnationId: 'inc_1',
  executionHostId: 'ssh:h',
  worktreeId: 'repo::/w',
  agentIdentity: 'trae',
  connected: true,
  writable: true,
  ...overrides,
});

describe('OrcaBackend', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.asyncCall.mockReset();
    api.syncCall.mockReset();
    api.relayMetadata.mockReset();
    api.relayMetadata.mockResolvedValue(new Map());
  });

  it('publishes changed screen frames without resizing the source terminal', async () => {
    api.asyncCall.mockResolvedValue({
      ok: true,
      value: { terminal: { status: 'running', source: 'screen', tail: ['one', 'two'] } },
    });
    const backend = new OrcaBackend(identity());
    const chunks: string[] = [];
    backend.onData(chunk => chunks.push(chunk));
    backend.spawn('', [], { cwd: '/w', cols: 80, rows: 24, env: {} });
    await vi.runOnlyPendingTimersAsync();
    backend.resize(200, 60);
    expect(chunks[0]).toContain('one\r\ntwo');
    expect(backend.getPaneSize()).toEqual({ cols: 80, rows: 24 });
    expect(backend.hasAuthoritativePaneSize()).toBe(false);
    expect(api.syncCall).not.toHaveBeenCalled();
    backend.kill();
  });

  it('renders a draft returned outside the Orca screen snapshot', async () => {
    api.asyncCall.mockResolvedValue({
      ok: true,
      value: { terminal: { status: 'running', source: 'screen', tail: ['› Ask Codex to do anything'], draft: 'hello' } },
    });
    const backend = new OrcaBackend(identity());
    const chunks: string[] = [];
    backend.onData(chunk => chunks.push(chunk));
    backend.spawn('', [], { cwd: '/w', cols: 80, rows: 24, env: {} });
    await vi.runOnlyPendingTimersAsync();

    expect(chunks[0]).toContain('› Ask Codex to do anything\r\n› hello');
    backend.kill();
  });

  it('seeds retained text history above the current screen', async () => {
    const backend = new OrcaBackend(identity());
    backend.setWebHistory(renderOrcaTranscriptHistory([
      { kind: 'cot', text: 'WaitingWaitingWaiting' },
      { kind: 'user', text: '# AGENTS.md instructions for /repo\ninternal' },
      { kind: 'user', text: '\x1b[31molder question\x1b[0m' },
      { kind: 'assistant_final', text: 'older answer' },
    ]));

    api.asyncCall.mockResolvedValue({
      ok: true,
      value: { terminal: { status: 'running', source: 'screen', tail: ['current'] } },
    });
    backend.spawn('', [], { cwd: '/w', cols: 80, rows: 2, env: {} });
    await vi.runOnlyPendingTimersAsync();

    expect(backend.captureWebHistory()).toBe(
      '── User ──\r\nolder question\r\n\r\n── Assistant ──\r\nolder answer\r\ncurrent\r\n',
    );
    backend.kill();
  });

  it('submits staged text and Enter as plain text by default', () => {
    api.syncCall.mockImplementation((args: string[]) => args[1] === 'show'
      ? { ok: true, value: { terminal: liveIdentity() } }
      : { ok: true, value: { send: { accepted: true } } });
    const backend = new OrcaBackend(identity());
    expect(backend.pasteText('hello、world')).toBe(true);
    expect(backend.sendSpecialKeys('Enter')).toBe(true);
    expect(api.syncCall).toHaveBeenLastCalledWith([
      'terminal', 'send', '--terminal', 'term_1', '--text', 'hello、world', '--enter',
    ], 15_000);
  });

  it('uses bracketed paste only for a backend whose CLI requires it', () => {
    api.syncCall.mockImplementation((args: string[]) => args[1] === 'show'
      ? { ok: true, value: { terminal: liveIdentity() } }
      : { ok: true, value: { send: { accepted: true } } });
    const backend = new OrcaBackend(identity(), true);
    backend.pasteText('hello、world');
    backend.sendSpecialKeys('Enter');
    expect(api.syncCall).toHaveBeenLastCalledWith([
      'terminal', 'send', '--terminal', 'term_1', '--text', '\x1b[200~hello、world\x1b[201~', '--enter',
    ], 15_000);
  });

  it('throws on rejected input so adapters do not retry an uncertain Enter', () => {
    api.syncCall.mockImplementation((args: string[]) => args[1] === 'show'
      ? { ok: true, value: { terminal: liveIdentity() } }
      : { ok: true, value: { send: { accepted: false } } });
    const backend = new OrcaBackend(identity());
    backend.sendText('hello');
    expect(() => backend.sendSpecialKeys('Enter')).toThrow('rejected input');
  });

  it('refuses to append a remote message to a local Orca composer draft', async () => {
    api.asyncCall.mockResolvedValue({
      ok: true,
      value: { terminal: { status: 'running', source: 'screen', tail: ['screen'], draft: 'half typed' } },
    });
    const backend = new OrcaBackend(identity());
    backend.spawn('', [], { cwd: '/w', cols: 80, rows: 24, env: {} });
    await vi.runOnlyPendingTimersAsync();
    expect(() => backend.pasteText('remote')).toThrow('unsubmitted local draft');
    expect(api.syncCall).not.toHaveBeenCalled();
    backend.kill();
  });

  it('refreshes draft state synchronously before an adopt write', () => {
    const backend = new OrcaBackend(identity());
    api.syncCall.mockReturnValueOnce({ ok: true, value: { terminal: liveIdentity() } });
    api.syncCall.mockReturnValueOnce({
      ok: true,
      value: { terminal: { status: 'running', source: 'screen', tail: [], draft: 'local draft' } },
    });
    expect(backend.inspectDraftSync()).toBe('draft');

    api.syncCall.mockReturnValueOnce({ ok: true, value: { terminal: liveIdentity() } });
    api.syncCall.mockReturnValueOnce({
      ok: true,
      value: { terminal: { status: 'running', source: 'screen', tail: [], draft: '' } },
    });
    expect(backend.inspectDraftSync()).toBe('clean');
  });

  it('batches Web Terminal keystrokes without blocking on one CLI process per key', async () => {
    api.asyncCall.mockImplementation(async (args: string[]) => args[1] === 'show'
      ? { ok: true, value: { terminal: liveIdentity() } }
      : { ok: true, value: { send: { accepted: true } } });
    const backend = new OrcaBackend(identity());
    backend.write('a');
    backend.write('b');
    backend.write('c');
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() => expect(api.asyncCall).toHaveBeenCalledTimes(2));
    expect(api.asyncCall).toHaveBeenLastCalledWith([
      'terminal', 'send', '--terminal', 'term_1', '--text', 'abc',
    ], 15_000);
    backend.kill();
  });

  it('forwards Tab, Backspace, multiline text, and Enter with raw-byte semantics', async () => {
    api.asyncCall.mockImplementation(async (args: string[]) => args[1] === 'show'
      ? { ok: true, value: { terminal: liveIdentity() } }
      : { ok: true, value: { send: { accepted: true } } });
    const backend = new OrcaBackend(identity());
    backend.write('\t');
    await vi.advanceTimersByTimeAsync(25);
    backend.write('\x7f');
    await vi.advanceTimersByTimeAsync(25);
    backend.write('one\ntwo\r');
    await vi.waitFor(() => expect(api.asyncCall).toHaveBeenCalledTimes(6));
    expect(api.asyncCall.mock.calls.filter(call => call[0][1] === 'send').map(call => call[0])).toEqual([
      ['terminal', 'send', '--terminal', 'term_1', '--text', '\t'],
      ['terminal', 'send', '--terminal', 'term_1', '--text', '\x7f'],
      ['terminal', 'send', '--terminal', 'term_1', '--text', 'one\ntwo', '--enter'],
    ]);
    backend.kill();
  });

  it('refuses Web Terminal input when the live Orca identity changed', async () => {
    api.asyncCall.mockResolvedValue({
      ok: true,
      value: { terminal: liveIdentity({ incarnationId: 'inc_2' }) },
    });
    const backend = new OrcaBackend(identity());
    const exits: number[] = [];
    backend.onExit(() => exits.push(1));
    backend.write('x');
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() => expect(exits).toEqual([1]));
    expect(api.asyncCall.mock.calls.some(call => call[0][1] === 'send')).toBe(false);
  });

  it('publishes an authoritative relay size change to connected viewers', async () => {
    api.asyncCall.mockResolvedValue({
      ok: true,
      value: { terminal: { status: 'running', source: 'screen', tail: [] } },
    });
    api.relayMetadata.mockResolvedValue(new Map([['pty:1', { pid: 1, cols: 104, rows: 50 }]]));
    const backend = new OrcaBackend(identity());
    const sizes: Array<{ cols: number; rows: number }> = [];
    backend.onPaneSizeChange(size => sizes.push(size));
    backend.spawn('', [], { cwd: '/w', cols: 120, rows: 50, env: {} });
    await vi.waitFor(() => expect(sizes).toEqual([{ cols: 104, rows: 50 }]));
    expect(backend.getPaneSize()).toEqual({ cols: 104, rows: 50 });
    expect(backend.hasAuthoritativePaneSize()).toBe(true);
    backend.kill();
  });

  it('uses a final show probe before treating repeated read misses as exit', async () => {
    api.asyncCall.mockResolvedValue({
      ok: true,
      value: { terminal: liveIdentity() },
    });
    const backend = new OrcaBackend(identity());
    const exits: number[] = [];
    backend.onExit(() => exits.push(1));
    await (backend as unknown as { confirmMissing(): Promise<void> }).confirmMissing();
    expect(exits).toEqual([]);

    api.asyncCall.mockResolvedValue({
      ok: true,
      value: { terminal: liveIdentity({ incarnationId: 'inc_2' }) },
    });
    await (backend as unknown as { confirmMissing(): Promise<void> }).confirmMissing();
    expect(exits).toEqual([1]);
  });
});
