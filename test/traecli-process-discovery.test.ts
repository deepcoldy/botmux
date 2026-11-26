// This file mocks process inspection, never a live daemon or tmux socket.
import './helpers/require-fenced-data-dir.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => {
  const actual = require('node:child_process') as typeof import('node:child_process');
  return { ...actual, execSync: vi.fn(), execFileSync: vi.fn() };
});
vi.mock('node:os', () => {
  const actual = require('node:os') as typeof import('node:os');
  return { ...actual, platform: () => 'darwin' };
});

import { execFileSync, execSync } from 'node:child_process';
import { cliIdFromCommArgv, readComm } from '../src/core/session-discovery.js';
import { isTraexProcess } from '../src/core/traex-leaf-pid.js';
import { LSOF_EXEC_OPTIONS } from '../src/utils/process-open-files.js';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(execSync).mockReturnValue('/opt/bin/traecli\n');
});

describe('macOS traecli process identity', () => {
  it.each(['/opt/traex', '/opt/TRAE CLI/traex'])(
    'recognizes TRAE from the loaded executable %s without trusting argv or symlinks', executable => {
      vi.mocked(execFileSync).mockReturnValue(`p123\nftxt\nn${executable}\nftxt\nn/usr/lib/dyld\n`);
      const comm = readComm(123);
      expect(comm).toBe('traex');
      expect(cliIdFromCommArgv(comm, ['/opt/bin/traecli'], 'traex')).toBe('traex');
      expect(cliIdFromCommArgv(comm, ['/opt/bin/traecli'], 'coco')).toBeUndefined();
      expect(isTraexProcess(123)).toBe(true);
      expect(execFileSync).toHaveBeenCalledWith(
        'lsof', ['-n', '-P', '-a', '-p', '123', '-d', 'txt', '-Fn'], LSOF_EXEC_OPTIONS,
      );
      expect(LSOF_EXEC_OPTIONS.timeout).toBeGreaterThan(0);
    },
  );

  it('resolves the dot-prefixed process title through the same verified executable', () => {
    vi.mocked(execSync).mockReturnValue('.traecli\n');
    vi.mocked(execFileSync).mockReturnValue('p123\nftxt\nn/opt/traex\n');
    expect(readComm(123)).toBe('traex');
  });

  it('keeps legacy CoCo with the same title isolated from TRAE', () => {
    vi.mocked(execFileSync).mockReturnValue('p123\nftxt\nn/opt/coco\n');
    const comm = readComm(123);
    expect(cliIdFromCommArgv(comm, ['/opt/bin/traecli', 'traex'], 'coco')).toBe('coco');
    expect(cliIdFromCommArgv(comm, ['/opt/bin/traecli', 'traex'], 'traex')).toBeUndefined();
    expect(isTraexProcess(123)).toBe(false);
  });

  it.each([
    '',
    'p999\nftxt\nn/opt/traex\n',
    'p123\nfcwd\nn/opt/traex\n',
    'p123\nftxt\nn/usr/bin/node\nftxt\nn/opt/traex\n',
    'p123\nftxt\nn/opt/traex-helper\n',
    'p123\nftxt\nn/opt/traecli\n',
  ])('does not guess TRAE from unavailable or unrelated executable records (%j)', output => {
    vi.mocked(execFileSync).mockReturnValue(output);
    const comm = readComm(123);
    expect(comm).toBe('traecli');
    expect(cliIdFromCommArgv(comm, ['/opt/bin/traecli', '/opt/traex'], 'traex')).toBeUndefined();
    expect(cliIdFromCommArgv(comm, [], 'coco')).toBe('coco');
  });

  it('keeps the legacy mapping when lsof is denied, missing or times out', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('inspection unavailable'); });
    expect(readComm(123)).toBe('traecli');
    expect(isTraexProcess(123)).toBe(false);
  });

  it('does not probe the executable or guess a name when ps cannot read the process', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('process exited'); });
    expect(readComm(123)).toBeUndefined();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it.each(['traex', 'coco', 'codex', 'claude', 'zsh', 'node'])(
    'does not add an executable probe for an unambiguous %s process', comm => {
      vi.mocked(execSync).mockReturnValue(`/opt/${comm}\n`);
      expect(readComm(123)).toBe(comm);
      expect(execFileSync).not.toHaveBeenCalled();
    },
  );

  it('re-probes the executable when a PID is reused instead of caching the old CLI', () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce('p123\nftxt\nn/opt/traex\n')
      .mockReturnValueOnce('p123\nftxt\nn/opt/coco\n');
    expect(readComm(123)).toBe('traex');
    expect(readComm(123)).toBe('coco');
  });
});
