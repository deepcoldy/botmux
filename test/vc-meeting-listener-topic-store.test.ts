import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getVcMeetingListenerTopicRoot,
  recordVcMeetingListenerTopicRoot,
} from '../src/services/vc-meeting-listener-topic-store.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-vc-listener-topic-'));
  dirs.push(dir);
  return dir;
}

const key = {
  listenerAppId: 'listener-app',
  meetingId: 'meeting-1',
  memberId: 'important-sync',
  memberEpoch: 3,
  targetChatId: 'oc_listener',
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('vc meeting listener topic store', () => {
  it('persists one root per member epoch and returns it after reload', () => {
    const dir = tempDir();
    expect(getVcMeetingListenerTopicRoot(dir, key)).toBeUndefined();
    expect(recordVcMeetingListenerTopicRoot(dir, key, 'om_root', 100)).toEqual({
      ok: true,
      rootMessageId: 'om_root',
      existing: false,
    });
    expect(getVcMeetingListenerTopicRoot(dir, key)).toBe('om_root');
    expect(recordVcMeetingListenerTopicRoot(dir, key, 'om_root', 200)).toEqual({
      ok: true,
      rootMessageId: 'om_root',
      existing: true,
    });

    const files = readFileSync(join(dir, 'vc-meeting-listener-topics', `${key.listenerAppId}__${key.meetingId}__${key.memberId}__${key.memberEpoch}__${key.targetChatId}.json`), 'utf8');
    expect(JSON.parse(files)).toEqual(expect.objectContaining({ rootMessageId: 'om_root', createdAt: 100 }));
    expect(statSync(join(dir, 'vc-meeting-listener-topics')).mode & 0o777).toBe(0o700);
  });

  it('rejects a conflicting second root instead of splitting the stream', () => {
    const dir = tempDir();
    expect(recordVcMeetingListenerTopicRoot(dir, key, 'om_first').ok).toBe(true);
    expect(recordVcMeetingListenerTopicRoot(dir, key, 'om_second')).toEqual({
      ok: false,
      reason: 'conflict',
    });
    expect(getVcMeetingListenerTopicRoot(dir, key)).toBe('om_first');
  });

  it('uses member epoch and chat as independent presentation boundaries', () => {
    const dir = tempDir();
    expect(recordVcMeetingListenerTopicRoot(dir, key, 'om_epoch_3').ok).toBe(true);
    expect(getVcMeetingListenerTopicRoot(dir, { ...key, memberEpoch: 4 })).toBeUndefined();
    expect(getVcMeetingListenerTopicRoot(dir, { ...key, targetChatId: 'oc_other' })).toBeUndefined();
  });
});
