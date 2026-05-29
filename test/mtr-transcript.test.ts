import { existsSync, readdirSync, statSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    execSync: vi.fn(),
    spawnSync: vi.fn(),
  };
});

const existsSyncMock = vi.mocked(existsSync);
const readdirSyncMock = vi.mocked(readdirSync);
const statSyncMock = vi.mocked(statSync);
const execSyncMock = vi.mocked(execSync);
const spawnSyncMock = vi.mocked(spawnSync);
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalOpencodeDb = process.env.OPENCODE_DB;
const schemaOk = { status: 0, stdout: 'true\n', stderr: '' } as any;
const schemaBad = { status: 0, stdout: 'false\n', stderr: '' } as any;

describe('mtr transcript reader', () => {
  beforeEach(() => {
    vi.resetModules();
    existsSyncMock.mockReset();
    readdirSyncMock.mockReset();
    statSyncMock.mockReset();
    execSyncMock.mockReset();
    spawnSyncMock.mockReset();
    delete process.env.XDG_DATA_HOME;
    delete process.env.OPENCODE_DB;
  });

  afterEach(() => {
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalOpencodeDb === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = originalOpencodeDb;
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
    spawnSyncMock
      .mockReturnValueOnce(schemaOk)
      .mockReturnValueOnce({
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

  it('finds the newest MTR db session for a directory', async () => {
    existsSyncMock.mockReturnValue(true);
    readdirSyncMock.mockReturnValue(['mtr.db', 'mtr-alpha.db', 'mtr-alpha.db-wal'] as any);
    statSyncMock.mockReturnValue({ isFile: () => true } as any);
    spawnSyncMock
      .mockReturnValueOnce(schemaOk)
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ id: 'ses_old', time_updated: 10 }), stderr: '' } as any)
      .mockReturnValueOnce(schemaOk)
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ id: 'ses_new', time_updated: 20 }), stderr: '' } as any);
    const { findLatestMtrSessionByDirectory } = await import('../src/services/mtr-transcript.js');

    expect(findLatestMtrSessionByDirectory('/repo', ['/tmp/mtr.db', '/tmp/mtr-alpha.db'])).toEqual({
      dbPath: '/tmp/mtr-alpha.db',
      sessionId: 'ses_new',
    });
  });

  it('discovers MTR db candidates from XDG_DATA_HOME and OPENCODE_DB without duplicates', async () => {
    process.env.XDG_DATA_HOME = '/xdg';
    process.env.OPENCODE_DB = 'mtr-alpha.db';
    existsSyncMock.mockReturnValue(true);
    readdirSyncMock.mockReturnValue(['mtr.db', 'mtr-alpha.db', 'opencode.db'] as any);
    statSyncMock.mockReturnValue({ isFile: () => true } as any);
    const { mtrDbCandidates } = await import('../src/services/mtr-transcript.js');

    expect(mtrDbCandidates()).toEqual(['/xdg/opencode/mtr-alpha.db', '/xdg/opencode/mtr.db']);
  });

  it('parses MTR session ids from common command forms', async () => {
    const { mtrSessionIdFromCommand } = await import('../src/services/mtr-transcript.js');

    expect(mtrSessionIdFromCommand('mtr --session ses_abc123')).toBe('ses_abc123');
    expect(mtrSessionIdFromCommand('mtr --set-session=ses_XYZ789')).toBe('ses_XYZ789');
    expect(mtrSessionIdFromCommand('mtr --session "ses_quoted123"')).toBe('ses_quoted123');
    expect(mtrSessionIdFromCommand('mtr --session not-valid')).toBeUndefined();
  });

  it('skips db files that do not match the expected MTR schema', async () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock
      .mockReturnValueOnce(schemaBad)
      .mockReturnValueOnce(schemaOk)
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ id: 'ses_valid', time_updated: 30 }), stderr: '' } as any);
    const { findLatestMtrSessionByDirectory } = await import('../src/services/mtr-transcript.js');

    expect(findLatestMtrSessionByDirectory('/repo', ['/tmp/not-mtr.db', '/tmp/mtr.db'])).toEqual({
      dbPath: '/tmp/mtr.db',
      sessionId: 'ses_valid',
    });
    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
  });

  it('prefers an explicit session id from the adopted MTR process command', async () => {
    existsSyncMock.mockReturnValue(true);
    execSyncMock.mockReturnValue('mtr --session ses_cmd123\n' as any);
    spawnSyncMock
      .mockReturnValueOnce(schemaOk)
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ id: 'ses_cmd123', time_updated: 30 }), stderr: '' } as any);
    const { findMtrSessionForAdopt } = await import('../src/services/mtr-transcript.js');

    expect(findMtrSessionForAdopt(123, '/repo', ['/tmp/mtr.db'])).toEqual({
      dbPath: '/tmp/mtr.db',
      sessionId: 'ses_cmd123',
    });
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });
});
