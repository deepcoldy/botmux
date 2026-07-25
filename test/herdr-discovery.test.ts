/**
 * Unit tests for herdr-related session-discovery helpers.
 *
 * Covers:
 *   - validateHerdrAdoptTarget: 'alive' | 'missing' | 'unknown' tri-state
 *     (drives the detached-vs-disconnected UX for /adopt and /restart)
 *   - findUniqueClaudeSessionByCwd: only returns a match when exactly one
 *     Claude metadata file points at the same realpath cwd
 *
 * Mocks node:child_process.execFileSync (used by tryHerdrJson) and
 * node:fs.readdirSync/readFileSync (used by findUniqueClaudeSessionByCwd).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(),
  readlinkSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
}));

vi.mock('node:os', () => ({
  homedir: () => '/home/testuser',
  platform: () => 'linux',
}));

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import {
  validateHerdrAdoptTarget,
  findUniqueClaudeSessionByCwd,
} from '../src/core/session-discovery.js';

const mockExecFileSync = vi.mocked(execFileSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockRealpathSync = vi.mocked(realpathSync);

beforeEach(() => {
  vi.resetAllMocks();
  // realpath defaults to identity so symlink-aware comparison still works.
  mockRealpathSync.mockImplementation(((p: string) => p) as any);
});

describe('validateHerdrAdoptTarget', () => {
  it('returns "missing" when sessionName or paneId is empty', () => {
    expect(validateHerdrAdoptTarget(undefined, 'pane-1')).toBe('missing');
    expect(validateHerdrAdoptTarget('sess', undefined)).toBe('missing');
    expect(validateHerdrAdoptTarget('', 'pane-1')).toBe('missing');
  });

  it('returns "alive" when herdr agent list contains the pane', () => {
    mockExecFileSync.mockReturnValueOnce(
      JSON.stringify({ result: { agents: [{ pane_id: 'pane-1', agent: '/usr/bin/claude' }] } }) as any,
    );
    expect(validateHerdrAdoptTarget('sess', 'pane-1')).toBe('alive');
  });

  it('does not accept a reused listed pane when the expected CLI no longer runs there', () => {
    mockExecFileSync
      .mockReturnValueOnce(
        JSON.stringify({ result: { agents: [{ pane_id: 'pane-1', agent: '/usr/bin/claude' }] } }) as any,
      )
      .mockReturnValueOnce(JSON.stringify({
        result: {
          process_info: {
            foreground_processes: [{ pid: 4242, name: 'codex', argv: ['codex'] }],
          },
        },
      }) as any);

    expect(validateHerdrAdoptTarget('sess', 'pane-1', undefined, 'claude-code')).toBe('missing');
  });

  it('checks the exact expected PID even when another matching CLI appears first', () => {
    const listed = JSON.stringify({ result: { agents: [{ pane_id: 'pane-1', agent: '/usr/bin/claude' }] } });
    const processInfo = JSON.stringify({
      result: {
        process_info: {
          foreground_processes: [
            { pid: 1111, name: 'claude', argv: ['claude'] },
            { pid: 2222, name: 'claude', argv: ['claude'] },
          ],
        },
      },
    });
    mockExecFileSync
      .mockReturnValueOnce(listed as any)
      .mockReturnValueOnce(processInfo as any)
      .mockReturnValueOnce(listed as any)
      .mockReturnValueOnce(processInfo as any);

    expect(validateHerdrAdoptTarget('sess', 'pane-1', 2222, 'claude-code')).toBe('alive');
    expect(validateHerdrAdoptTarget('sess', 'pane-1', 3333, 'claude-code')).toBe('missing');
  });

  it('returns "missing" when herdr returns ok but pane is not in list', () => {
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify({ result: { agents: [{ pane_id: 'pane-other' }] } }) as any)
      .mockReturnValueOnce(JSON.stringify({ result: { process_info: { foreground_processes: [] } } }) as any);
    expect(validateHerdrAdoptTarget('sess', 'pane-1')).toBe('missing');
  });

  it('returns "unknown" when herdr CLI invocation fails (server down etc.)', () => {
    // execFileSync throwing models any of: herdr binary missing, server not
    // running, network/socket error. We must not mistake this for "missing"
    // because the agent might still be there once herdr is reachable again.
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('command failed');
    });
    expect(validateHerdrAdoptTarget('sess', 'pane-1')).toBe('unknown');
  });

  it('returns "missing" when herdr returns malformed payload (no agents array)', () => {
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify({ result: {} }) as any)
      .mockReturnValueOnce(JSON.stringify({ result: { process_info: { foreground_processes: [] } } }) as any);
    expect(validateHerdrAdoptTarget('sess', 'pane-1')).toBe('missing');
  });
});

describe('findUniqueClaudeSessionByCwd', () => {
  function setupClaudeMeta(entries: Record<string, { sessionId?: string; cwd?: string; startedAt?: number }>) {
    mockReaddirSync.mockReturnValueOnce(Object.keys(entries) as any);
    mockReadFileSync.mockImplementation(((path: unknown) => {
      const pathStr = String(path);
      for (const [name, data] of Object.entries(entries)) {
        if (pathStr.endsWith(name)) return JSON.stringify(data);
      }
      throw new Error('ENOENT');
    }) as any);
  }

  it('returns the session metadata when exactly one file matches', () => {
    setupClaudeMeta({
      'a.json': { sessionId: 'sess-A', cwd: '/proj/foo', startedAt: 1700 },
      'b.json': { sessionId: 'sess-B', cwd: '/proj/bar', startedAt: 1800 },
    });
    expect(findUniqueClaudeSessionByCwd('/proj/foo')).toEqual({
      sessionId: 'sess-A',
      startedAt: 1700,
    });
  });

  it('returns undefined when multiple files match the same cwd (ambiguous)', () => {
    // Resuming "the most recent one" sounds tempting but is the wrong call:
    // if two adopt targets exist, the user must pick. So the helper bails.
    setupClaudeMeta({
      'a.json': { sessionId: 'sess-A', cwd: '/proj/foo', startedAt: 1700 },
      'b.json': { sessionId: 'sess-B', cwd: '/proj/foo', startedAt: 1800 },
    });
    expect(findUniqueClaudeSessionByCwd('/proj/foo')).toBeUndefined();
  });

  it('returns undefined when nothing matches the cwd', () => {
    setupClaudeMeta({
      'a.json': { sessionId: 'sess-A', cwd: '/proj/bar' },
    });
    expect(findUniqueClaudeSessionByCwd('/proj/foo')).toBeUndefined();
  });

  it('returns undefined when the sessions dir is unreadable', () => {
    mockReaddirSync.mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    expect(findUniqueClaudeSessionByCwd('/proj/foo')).toBeUndefined();
  });

  it('skips entries with missing sessionId', () => {
    setupClaudeMeta({
      'a.json': { cwd: '/proj/foo' }, // 缺 sessionId → 跳过
      'b.json': { sessionId: 'sess-B', cwd: '/proj/foo', startedAt: 1800 },
    });
    expect(findUniqueClaudeSessionByCwd('/proj/foo')).toEqual({
      sessionId: 'sess-B',
      startedAt: 1800,
    });
  });

  it('compares cwd through realpath (symlink-aware)', () => {
    // user-facing cwd is a symlink, metadata files store the real path
    mockRealpathSync.mockImplementation(((p: string) => {
      if (p === '/proj/link') return '/proj/real';
      return p;
    }) as any);
    setupClaudeMeta({
      'a.json': { sessionId: 'sess-A', cwd: '/proj/real', startedAt: 1700 },
    });
    expect(findUniqueClaudeSessionByCwd('/proj/link')).toEqual({
      sessionId: 'sess-A',
      startedAt: 1700,
    });
  });

  it('ignores malformed JSON files', () => {
    mockReaddirSync.mockReturnValueOnce(['bad.json', 'good.json'] as any);
    mockReadFileSync.mockImplementation(((path: unknown) => {
      const pathStr = String(path);
      if (pathStr.endsWith('bad.json')) return '{not valid json';
      if (pathStr.endsWith('good.json')) {
        return JSON.stringify({ sessionId: 'sess-OK', cwd: '/proj/foo', startedAt: 9000 });
      }
      throw new Error('ENOENT');
    }) as any);
    expect(findUniqueClaudeSessionByCwd('/proj/foo')).toEqual({
      sessionId: 'sess-OK',
      startedAt: 9000,
    });
  });
});
