import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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

  it('adds JSON mode and returns the result payload', () => {
    child.sync.mockReturnValue(JSON.stringify({ ok: true, result: { value: 1 } }));
    expect(callOrcaSync<{ value: number }>(['terminal', 'show', '--terminal', 'term_1']))
      .toEqual({ ok: true, value: { value: 1 } });
    expect(child.sync.mock.calls[0]?.[1]).toEqual([
      'terminal', 'show', '--terminal', 'term_1', '--json',
    ]);
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
    expect(matchesOrcaTerminalIdentity({ ...terminal, worktreeId: 'repo::/other' }, expected)).toBe(false);
    expect(matchesOrcaTerminalIdentity({ ...terminal, agentIdentity: 'codex' }, expected)).toBe(false);
  });
});
