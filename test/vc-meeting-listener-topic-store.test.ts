import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureVcMeetingListenerTopicRoot,
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

  it('serializes concurrent root creation across provider send and persistence', async () => {
    const dir = tempDir();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });
    const createFirst = vi.fn(async () => {
      markFirstStarted();
      await firstBlocked;
      return 'om_first';
    });
    const createSecond = vi.fn(async () => 'om_second');

    const first = ensureVcMeetingListenerTopicRoot(dir, key, createFirst);
    await firstStarted;
    const second = ensureVcMeetingListenerTopicRoot(dir, key, createSecond);

    await Promise.resolve();
    expect(createFirst).toHaveBeenCalledTimes(1);
    expect(createSecond).not.toHaveBeenCalled();

    releaseFirst();
    await expect(first).resolves.toEqual({ rootMessageId: 'om_first', created: true });
    await expect(second).resolves.toEqual({ rootMessageId: 'om_first', created: false });
    expect(createSecond).not.toHaveBeenCalled();
    expect(getVcMeetingListenerTopicRoot(dir, key)).toBe('om_first');
  });

  it('uses member epoch and chat as independent presentation boundaries', () => {
    const dir = tempDir();
    expect(recordVcMeetingListenerTopicRoot(dir, key, 'om_epoch_3').ok).toBe(true);
    expect(getVcMeetingListenerTopicRoot(dir, { ...key, memberEpoch: 4 })).toBeUndefined();
    expect(getVcMeetingListenerTopicRoot(dir, { ...key, targetChatId: 'oc_other' })).toBeUndefined();
  });
});
