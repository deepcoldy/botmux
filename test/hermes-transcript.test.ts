import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

const existsSyncMock = vi.mocked(existsSync);
const spawnSyncMock = vi.mocked(spawnSync);
const CONTENT_JSON_PREFIX = String.fromCharCode(0) + 'json:';

describe('hermes transcript reader', () => {
  beforeEach(() => {
    existsSyncMock.mockReset();
    spawnSyncMock.mockReset();
  });

  it('resolves the state DB from HERMES_HOME when Hermes runs under a profile', async () => {
    const { resolveHermesStateDbPath } = await import('../src/services/hermes-transcript.js');

    expect(resolveHermesStateDbPath({ HERMES_HOME: ' /tmp/hermes-profile ' })).toBe('/tmp/hermes-profile/state.db');
    expect(resolveHermesStateDbPath({})).toBe(join(homedir(), '.hermes', 'state.db'));
  });

  it('matches the hermes-botmux-session wrapper profile path when requested', async () => {
    const { resolveHermesStateDbPath } = await import('../src/services/hermes-transcript.js');
    const sessionId = 'e453e682-c110-4f27-a68b-17017004a4ca';
    const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);

    expect(resolveHermesStateDbPath(
      { HERMES_HOME: '/home/litongde/.hermes', BOTMUX_SESSION_ID: sessionId },
      { botmuxSessionProfile: true },
    )).toBe(`/home/litongde/.hermes/profiles/botmux-${hash}/state.db`);
  });

  it('returns empty events when state.db does not exist', async () => {
    existsSyncMock.mockReturnValue(false);
    const { drainHermesStateDb, currentHermesStateOffset } = await import('../src/services/hermes-transcript.js');

    expect(drainHermesStateDb(12, '/tmp/missing.db')).toEqual({ events: [], newOffset: 12 });
    expect(currentHermesStateOffset('/tmp/missing.db')).toBe(0);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('converts Hermes rows into bridge events and advances by row id', async () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        { id: 2, session_id: ' h1 ', role: 'user', content: 'hello', timestamp: 100 },
        { id: 3, session_id: 'h1', role: 'assistant', content: `${CONTENT_JSON_PREFIX}[{"text":"thinking"}]`, timestamp: 101, finish_reason: 'tool_calls' },
        { id: 4, session_id: ' h1 ', role: 'assistant', content: `${CONTENT_JSON_PREFIX}[{"text":"hi"}]`, timestamp: 102, finish_reason: 'stop' },
        { id: 5, session_id: 'h1', role: 'assistant', content: '', timestamp: 103, finish_reason: 'stop' },
      ]),
      stderr: '',
    } as any);
    const { drainHermesStateDb } = await import('../src/services/hermes-transcript.js');

    expect(drainHermesStateDb(1, '/tmp/state.db')).toEqual({
      newOffset: 5,
      events: [
        { uuid: 'hermes:2', timestampMs: 100000, kind: 'user', text: 'hello', sourceSessionId: 'h1', preserveMarkTimeMs: true },
        { uuid: 'hermes:4', timestampMs: 102000, kind: 'assistant_final', text: 'hi', sourceSessionId: 'h1' },
      ],
    });
  });

  it('reads the current max row id as offset', async () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '42\n', stderr: '' } as any);
    const { currentHermesStateOffset } = await import('../src/services/hermes-transcript.js');

    expect(currentHermesStateOffset('/tmp/state.db')).toBe(42);
  });
});
