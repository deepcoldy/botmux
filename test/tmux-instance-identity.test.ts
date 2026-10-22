import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => {
  const actual = require('node:child_process') as typeof import('node:child_process');
  return { ...actual, execFileSync: vi.fn() };
});
vi.mock('node:fs', () => {
  const actual = require('node:fs') as typeof import('node:fs');
  return { ...actual, lstatSync: vi.fn(actual.lstatSync), readFileSync: vi.fn(actual.readFileSync) };
});

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';

const exec = vi.mocked(execFileSync);
const lstat = vi.mocked(lstatSync);
const read = vi.mocked(readFileSync);
const NAME = 'bmx-cold-start';
const SOCKET = '/tmp/tmux cold-start/tmux-1000/default';
const HEADER = 'Num       RefCount Protocol Flags    Type St Inode Path\n';
const row = (socket: string) => `0000000000000000: 00000002 00000000 00010000 0001 01 1234 ${socket}\n`;
const error = (properties: Record<string, unknown>) => Object.assign(new Error('probe failed'), properties);
const absentSocket = () => error({ status: 1, signal: null, stderr: Buffer.from(`error connecting to ${SOCKET} (No such file or directory)`) });
const missingPath = () => { throw error({ code: 'ENOENT' }); };

beforeEach(() => {
  exec.mockReset();
  exec.mockImplementation(() => { throw absentSocket(); });
  lstat.mockReset();
  lstat.mockImplementation(missingPath);
  read.mockReset();
  read.mockReturnValue(HEADER);
});

describe('tmux instance identity preflight', () => {
  it('keeps a server-confirmed missing session usable without extra probes', () => {
    exec.mockImplementation(() => { throw error({ status: 1, signal: null, stderr: 'cannot find session' }); });
    expect(() => TmuxBackend.assertInstanceIdentity(NAME, 'binding-a')).not.toThrow();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['binding-b', '', '-BOTMUX_CODEX_INSTANCE_BINDING'])('rejects an existing session with another or missing identity: %s', actual => {
    exec.mockReturnValueOnce('');
    exec.mockReturnValueOnce(actual === 'binding-b' ? `BOTMUX_CODEX_INSTANCE_BINDING=${actual}` : actual);
    expect(() => TmuxBackend.assertInstanceIdentity(NAME, 'binding-a')).toThrow(/preserved; attachment refused/);
    expect(lstat).not.toHaveBeenCalled();
  });

  it('accepts the matching existing binding without filesystem fallback', () => {
    exec.mockReturnValueOnce('');
    exec.mockReturnValueOnce('BOTMUX_CODEX_INSTANCE_BINDING=binding-a\n');
    expect(() => TmuxBackend.assertInstanceIdentity(NAME, 'binding-a')).not.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    { status: 1, signal: null, stderr: `error connecting to ${SOCKET} (Connection refused)` },
    { status: 1, signal: null, stderr: 'lost server' },
    { code: 'ETIMEDOUT', status: 1, signal: null, stderr: `error connecting to ${SOCKET} (No such file or directory)` },
    { status: null, signal: 'SIGTERM' },
    { code: 'ENOENT', status: null, signal: null },
  ])('keeps an indeterminate server or executable fail-closed: %j', failure => {
    exec.mockImplementation(() => { throw error(failure); });
    expect(() => TmuxBackend.assertInstanceIdentity(NAME, 'binding-a')).toThrow(/preserved/);
    expect(read).not.toHaveBeenCalled();
  });

  it('does not reinterpret a previously existing session as a cold start', () => {
    exec.mockReturnValueOnce('');
    expect(() => TmuxBackend.assertInstanceIdentity(NAME, 'binding-a')).toThrow(/preserved/);
    expect(lstat).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== 'linux')('Linux cold tmux evidence', () => {
  it('allows only preflight for an absent path with no kernel binding, preserving spaces and probe unknown', () => {
    read.mockReturnValue(HEADER + row(`${SOCKET}-other`) + row('/tmp/other socket/default'));
    expect(TmuxBackend.probeSession(NAME)).toBe('unknown');
    expect(() => TmuxBackend.assertInstanceIdentity(NAME, 'binding-a')).not.toThrow();
    expect(read).toHaveBeenCalledWith('/proc/net/unix', 'utf8');
    expect(lstat.mock.calls).toEqual([[SOCKET], [SOCKET]]);
    expect(exec.mock.calls.map(call => (call[1] as string[])[0])).toEqual(['has-session', 'has-session', 'show-environment']);
  });

  it('refuses an unlinked live socket that still owns its kernel pathname', () => {
    read.mockReturnValue(HEADER + row(SOCKET));
    expect(() => TmuxBackend.assertInstanceIdentity(NAME, 'binding-a')).toThrow(/preserved/);
  });

  it('rechecks once when another cold start creates the socket and confirms the target session is absent', () => {
    lstat.mockImplementationOnce(missingPath);
    lstat.mockReturnValueOnce({} as ReturnType<typeof lstatSync>);
    exec.mockImplementationOnce(() => { throw absentSocket(); });
    exec.mockImplementationOnce(() => { throw absentSocket(); });
    exec.mockImplementationOnce(() => { throw error({ status: 1, signal: null, stderr: 'cannot find session' }); });
    expect(() => TmuxBackend.assertInstanceIdentity(NAME, 'binding-a')).not.toThrow();
    expect(lstat).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it.each(['binding-a', 'binding-b'])('rechecks the actual identity after a concurrent socket appears: %s', actual => {
    lstat.mockImplementationOnce(missingPath);
    lstat.mockReturnValueOnce({} as ReturnType<typeof lstatSync>);
    exec.mockImplementationOnce(() => { throw absentSocket(); });
    exec.mockImplementationOnce(() => { throw absentSocket(); });
    exec.mockReturnValueOnce('');
    exec.mockReturnValueOnce(`BOTMUX_CODEX_INSTANCE_BINDING=${actual}`);
    const check = () => TmuxBackend.assertInstanceIdentity(NAME, 'binding-a');
    if (actual === 'binding-a') expect(check).not.toThrow();
    else expect(check).toThrow(/preserved/);
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it('keeps a still-unknown concurrent server rejected without further cold-start checks', () => {
    lstat.mockImplementationOnce(missingPath);
    lstat.mockReturnValueOnce({} as ReturnType<typeof lstatSync>);
    expect(() => TmuxBackend.assertInstanceIdentity(NAME, 'binding-a')).toThrow(/preserved/);
    expect(exec).toHaveBeenCalledTimes(4);
    expect(read).toHaveBeenCalledTimes(1);
    expect(lstat).toHaveBeenCalledTimes(2);
  });

  it.each(['EACCES', 'ENOTDIR'])('does not treat filesystem %s as proof of absence', code => {
    lstat.mockImplementation(() => { throw error({ code }); });
    expect(() => TmuxBackend.assertInstanceIdentity(NAME, 'binding-a')).toThrow(/preserved/);
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses an unreadable kernel socket census', () => {
    read.mockImplementation(() => { throw error({ code: 'EACCES' }); });
    expect(() => TmuxBackend.assertInstanceIdentity(NAME, 'binding-a')).toThrow(/preserved/);
  });

  it.each(['', 'unrecognized header\n', HEADER + 'incomplete socket row\n'])('refuses missing or malformed kernel evidence: %j', contents => {
    read.mockReturnValue(contents);
    expect(() => TmuxBackend.assertInstanceIdentity(NAME, 'binding-a')).toThrow(/preserved/);
  });
});

describe.skipIf(process.platform !== 'linux')('teardown probe on the default server', () => {
  it('reads a socket no server ever bound as missing, where the strict probe stays unknown', () => {
    expect(TmuxBackend.probeSessionForTeardown(NAME)).toBe('missing');
    expect(TmuxBackend.probeSession(NAME)).toBe('unknown');
  });

  it('trusts a running server that answers the session is gone', () => {
    exec.mockImplementation(() => { throw error({ status: 1, signal: null, stderr: `can't find session: ${NAME}` }); });
    expect(TmuxBackend.probeSessionForTeardown(NAME)).toBe('missing');
  });

  it('keeps an unlinked live socket that still owns its kernel pathname unknown', () => {
    read.mockReturnValue(HEADER + row(SOCKET));
    expect(TmuxBackend.probeSessionForTeardown(NAME)).toBe('unknown');
  });

  it('keeps an unreadable kernel socket census unknown', () => {
    read.mockImplementation(() => { throw error({ code: 'EACCES' }); });
    expect(TmuxBackend.probeSessionForTeardown(NAME)).toBe('unknown');
  });

  it.each(['', 'unrecognized header\n', HEADER + 'incomplete socket row\n'])('keeps missing or malformed kernel evidence unknown: %j', contents => {
    read.mockReturnValue(contents);
    expect(TmuxBackend.probeSessionForTeardown(NAME)).toBe('unknown');
  });

  it('keeps a timed-out answer unknown', () => {
    exec.mockImplementation(() => { throw error({ code: 'ETIMEDOUT', status: 1, signal: null, stderr: `error connecting to ${SOCKET} (No such file or directory)` }); });
    expect(TmuxBackend.probeSessionForTeardown(NAME)).toBe('unknown');
  });
});
