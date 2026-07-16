import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

import {
  fetchMeetingEventsAsBot,
  runLarkCliJson,
} from '../src/vc-agent/polling-source.js';

describe('vc agent polling source process bounds', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it('passes an explicit timeout to synchronous lark-cli execution', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '{}', stderr: '' });

    expect(runLarkCliJson(['vc', '+meeting-events'], { timeoutMs: 12_345 })).toEqual({});
    expect(spawnSyncMock).toHaveBeenCalledWith('lark-cli', ['vc', '+meeting-events'], expect.objectContaining({
      encoding: 'utf-8',
      timeout: 12_345,
    }));
  });

  it('reports a bounded timeout instead of treating it as an ordinary exit', () => {
    const error = Object.assign(new Error('spawnSync lark-cli ETIMEDOUT'), { code: 'ETIMEDOUT' });
    spawnSyncMock.mockReturnValue({ status: null, stdout: '', stderr: '', error });

    expect(() => runLarkCliJson(['vc', '+meeting-events'], { timeoutMs: 500 }))
      .toThrow('timed out after 500ms');
  });

  it('forwards the restore timeout through meeting event polling', () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ meeting: { id: 'm1' }, events: [] }),
      stderr: '',
    });

    expect(fetchMeetingEventsAsBot({ meetingId: 'm1', timeoutMs: 7_000 }).batch.meeting.id).toBe('m1');
    expect(spawnSyncMock).toHaveBeenCalledWith('lark-cli', expect.arrayContaining([
      'vc', '+meeting-events', '--meeting-id', 'm1',
    ]), expect.objectContaining({ timeout: 7_000 }));
  });
});
