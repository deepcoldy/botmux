import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
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
const readdirSyncMock = vi.mocked(readdirSync);
const statSyncMock = vi.mocked(statSync);
const spawnSyncMock = vi.mocked(spawnSync);

describe('mtr transcript reader', () => {
  beforeEach(() => {
    vi.resetModules();
    existsSyncMock.mockReset();
    readdirSyncMock.mockReset();
    statSyncMock.mockReset();
    spawnSyncMock.mockReset();
  });

  it('returns empty events when the db is missing', async () => {
    existsSyncMock.mockReturnValue(false);
    const { drainMtrSession, currentMtrSessionOffset } = await import('../src/services/mtr-transcript.js');
    const source = { dbPath: '/tmp/mtr-alpha.db', sessionId: 'ses_abc' };

    expect(drainMtrSession(source, 9)).toEqual({ events: [], newOffset: 9 });
    expect(currentMtrSessionOffset(source)).toBe(0);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('converts completed MTR messages into bridge events', async () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValue({
      status: 0,
      stderr: '',
      stdout: JSON.stringify([
        {
          message_id: 'msg_user',
          session_id: 'ses_1',
          message_time_created: 1000,
          message_time_updated: 1001,
          message_data: JSON.stringify({ role: 'user', time: { created: 1000 } }),
          part_id: 'part_user',
          part_time_updated: 1002,
          part_data: JSON.stringify({ type: 'text', text: 'hello' }),
        },
        {
          message_id: 'msg_tool',
          session_id: 'ses_1',
          message_time_created: 1100,
          message_time_updated: 1200,
          message_data: JSON.stringify({ role: 'assistant', finish: 'tool-calls', time: { created: 1100, completed: 1200 } }),
          part_id: 'part_tool_text',
          part_time_updated: 1190,
          part_data: JSON.stringify({ type: 'text', text: 'thinking' }),
        },
        {
          message_id: 'msg_assistant',
          session_id: 'ses_1',
          message_time_created: 1300,
          message_time_updated: 1500,
          message_data: JSON.stringify({ role: 'assistant', finish: 'stop', time: { created: 1300, completed: 1500 } }),
          part_id: 'part_step',
          part_time_updated: 1400,
          part_data: JSON.stringify({ type: 'step-start' }),
        },
        {
          message_id: 'msg_assistant',
          session_id: 'ses_1',
          message_time_created: 1300,
          message_time_updated: 1500,
          message_data: JSON.stringify({ role: 'assistant', finish: 'stop', time: { created: 1300, completed: 1500 } }),
          part_id: 'part_text',
          part_time_updated: 1490,
          part_data: JSON.stringify({ type: 'text', text: 'hi there' }),
        },
      ]),
    } as any);
    const { drainMtrSession } = await import('../src/services/mtr-transcript.js');

    expect(drainMtrSession({ dbPath: '/tmp/mtr-alpha.db', sessionId: 'ses_1' }, 999)).toEqual({
      newOffset: 1500,
      events: [
        {
          uuid: 'mtr:/tmp/mtr-alpha.db:msg_user',
          timestampMs: 1000,
          kind: 'user',
          text: 'hello',
          sourceSessionId: 'ses_1',
        },
        {
          uuid: 'mtr:/tmp/mtr-alpha.db:msg_assistant',
          timestampMs: 1500,
          kind: 'assistant_final',
          text: 'hi there',
          sourceSessionId: 'ses_1',
        },
      ],
    });
  });

  it('re-reads a small timestamp overlap to avoid same-ms cursor misses', async () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValue({ status: 0, stderr: '', stdout: '[]' } as any);
    const { drainMtrSession } = await import('../src/services/mtr-transcript.js');

    expect(drainMtrSession({ dbPath: '/tmp/mtr-alpha.db', sessionId: 'ses_1' }, 10_000)).toEqual({
      events: [],
      newOffset: 10_000,
    });

    const script = spawnSyncMock.mock.calls[0]![1]![1] as string;
    expect(script).toContain('("ses_1", 5000, 5000)');
  });

  it('finds the newest MTR db session for a directory', async () => {
    existsSyncMock.mockReturnValue(true);
    readdirSyncMock.mockReturnValue(['mtr.db', 'mtr-alpha.db', 'mtr-alpha.db-wal'] as any);
    statSyncMock.mockReturnValue({ isFile: () => true } as any);
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ id: 'ses_old', time_updated: 10 }), stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ id: 'ses_new', time_updated: 20 }), stderr: '' } as any);
    const { findLatestMtrSessionByDirectory } = await import('../src/services/mtr-transcript.js');

    expect(findLatestMtrSessionByDirectory('/repo', ['/tmp/mtr.db', '/tmp/mtr-alpha.db'])).toEqual({
      dbPath: '/tmp/mtr-alpha.db',
      sessionId: 'ses_new',
    });
  });
});
