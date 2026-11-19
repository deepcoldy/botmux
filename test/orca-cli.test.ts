import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const child = vi.hoisted(() => ({
  sync: vi.fn(),
  async: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: child.sync,
  execFile: child.async,
}));

import {
  callOrca,
  callOrcaSync,
  hasStableOrcaTerminalIdentity,
  matchesOrcaTerminalIdentity,
  resolveOrcaServerBinary,
} from '../src/services/orca-cli.js';

describe('Orca CLI envelope', () => {
  beforeEach(() => {
    child.sync.mockReset();
    child.async.mockReset();
  });

  it('finds the user relay CLI when the daemon PATH has no Orca binary', () => {
    const relayDir = join(homedir(), '.orca-relay', 'bin');
    const relayCli = join(relayDir, 'orca');
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(relayCli, '#!/bin/sh\n');
    chmodSync(relayCli, 0o700);
    vi.stubEnv('ORCA_REMOTE_CLI_BIN_DIR', '');
    child.sync.mockReturnValue(JSON.stringify({ ok: true, result: {} }));

    try {
      callOrcaSync(['terminal', 'list']);
      expect(child.sync.mock.calls[0]?.[0]).toBe(relayCli);
    } finally {
      vi.unstubAllEnvs();
      rmSync(join(homedir(), '.orca-relay'), { recursive: true, force: true });
    }
  });

  it('routes calls to the server CLI installation and keeps relay as the default', () => {
    const base = mkdtempSync(join(tmpdir(), 'botmux-orca-bins-'));
    const serverDir = join(base, 'server');
    const relayDir = join(base, 'relay');
    mkdirSync(serverDir, { recursive: true });
    mkdirSync(relayDir, { recursive: true });
    const serverCli = join(serverDir, 'orca');
    const relayCli = join(relayDir, 'orca');
    writeFileSync(serverCli, '#!/bin/sh\n');
    writeFileSync(relayCli, '#!/bin/sh\n');
    chmodSync(serverCli, 0o700);
    chmodSync(relayCli, 0o700);
    vi.stubEnv('ORCA_SERVER_CLI_BIN_DIR', serverDir);
    vi.stubEnv('ORCA_REMOTE_CLI_BIN_DIR', relayDir);
    child.sync.mockReturnValue(JSON.stringify({ ok: true, result: {} }));

    try {
      expect(resolveOrcaServerBinary()).toBe(serverCli);
      callOrcaSync(['terminal', 'list'], 'server');
      expect(child.sync.mock.calls[0]?.[0]).toBe(serverCli);
      callOrcaSync(['terminal', 'list']);
      expect(child.sync.mock.calls[1]?.[0]).toBe(relayCli);
    } finally {
      vi.unstubAllEnvs();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('adds JSON mode and returns the result payload', () => {
    child.sync.mockReturnValue(JSON.stringify({ ok: true, result: { value: 1 } }));
    expect(callOrcaSync<{ value: number }>(['terminal', 'show', '--terminal', 'term_1']))
      .toEqual({ ok: true, value: { value: 1 } });
    expect(child.sync.mock.calls[0]?.[1]).toEqual([
      'terminal', 'show', '--terminal', 'term_1', '--json',
    ]);
  });

  it('runs local relay requests through the self-hosted helper with identity in stdin', () => {
    child.sync.mockReturnValue(JSON.stringify({ ok: true, result: { send: { accepted: true } } }));
    const expected = { terminalHandle: 'term_1', incarnationId: 'inc_1', worktreeId: 'repo::/work', agentIdentity: 'trae' };
    expect(callOrcaSync(['terminal', 'send', '--terminal', 'term_1', '--text', 'once', '--enter'], 'relay-local', 15_000, expected))
      .toEqual({ ok: true, value: { send: { accepted: true } } });
    expect(child.sync.mock.calls[0]?.[1]).toContain('__orca-relay-local');
    expect(JSON.parse(child.sync.mock.calls[0]?.[2].input)).toEqual({
      args: ['terminal', 'send', '--terminal', 'term_1', '--text', 'once', '--enter'], expected, timeoutMs: 15_000,
    });
  });

  it('classifies a stale terminal separately from transport failure', () => {
    child.sync.mockImplementation(() => {
      throw Object.assign(new Error('failed'), {
        stdout: JSON.stringify({ ok: false, error: { message: 'terminal_handle_stale' } }),
      });
    });
    expect(callOrcaSync(['terminal', 'show'])).toMatchObject({ ok: false, kind: 'missing' });
  });

  it('classifies asynchronous relay connection failures', async () => {
    child.async.mockImplementation((_bin, _args, _opts, callback) => {
      callback(new Error('socket error'), '', 'Could not connect to the running Orca app');
    });
    await expect(callOrca(['terminal', 'list'])).resolves.toMatchObject({
      ok: false,
      kind: 'unavailable',
    });
  });

  it('requires a stable incarnation or PTY and matches every persisted identity field', () => {
    const terminal = {
      handle: 'term_1',
      ptyId: 'ssh:h@@pty:1',
      incarnationId: 'inc_1',
      executionHostId: 'ssh:h',
      worktreeId: 'repo::/work',
      agentIdentity: 'trae',
      connected: true,
      writable: true,
    };
    const expected = {
      terminalHandle: 'term_1',
      ptyId: 'ssh:h@@pty:1',
      incarnationId: 'inc_1',
      executionHostId: 'ssh:h',
      worktreeId: 'repo::/work',
      agentIdentity: 'trae',
    };
    expect(hasStableOrcaTerminalIdentity({ ptyId: null, incarnationId: null })).toBe(false);
    expect(matchesOrcaTerminalIdentity(terminal, expected)).toBe(true);
    // The instance is botmux routing state, not Orca identity.
    expect(matchesOrcaTerminalIdentity(terminal, { ...expected, instance: 'server' })).toBe(true);
    expect(matchesOrcaTerminalIdentity({ ...terminal, worktreeId: 'repo::/other' }, expected)).toBe(false);
    expect(matchesOrcaTerminalIdentity({ ...terminal, agentIdentity: 'codex' }, expected)).toBe(false);
  });
});
