import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedVcMeetingItem } from '../src/vc-agent/types.js';
import {
  getVcMeetingFeedMetadataState,
  ingestVcMeetingFeedMetadata,
  listVcMeetingFeedMetadataAfter,
  removeVcMeetingFeedMetadata,
} from '../src/services/vc-meeting-feed-metadata-store.js';

const key = { listenerAppId: 'listener_app', meetingId: 'meeting_1' };

function transcript(revision: number, text = `revision ${revision}`): NormalizedVcMeetingItem {
  return {
    source: 'push',
    type: 'transcript_received',
    meetingId: key.meetingId,
    eventId: `transport_${revision}`,
    itemKey: 'transcript:sentence_1',
    sentenceId: 'sentence_1',
    speaker: { openId: 'alice', name: 'Alice' },
    text,
    revision,
    isFinal: revision >= 2,
  };
}

function chat(text = 'hello'): NormalizedVcMeetingItem {
  return {
    source: 'push',
    type: 'chat_received',
    meetingId: key.meetingId,
    eventId: 'transport_chat',
    itemKey: 'chat:message_1',
    messageId: 'message_1',
    sender: { openId: 'bob', name: 'Bob' },
    text,
  };
}

describe('vc meeting feed metadata journal', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'vc-feed-metadata-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('assigns listener-wide monotonic ingestSeq and persists only metadata', () => {
    const result = ingestVcMeetingFeedMetadata(dataDir, key, [transcript(1), chat()], 100);

    expect(result.accepted.map(outcome => outcome.metadata?.ingestSeq)).toEqual([1, 2]);
    expect(result.nextIngestSeq).toBe(3);
    const state = getVcMeetingFeedMetadataState(dataDir, key);
    expect(Object.values(state.items).map(item => item.ingestSeq)).toEqual([1, 2]);
    const dir = join(dataDir, 'vc-meeting-feed-metadata');
    const file = join(dir, readdirSync(dir).find(name => name.endsWith('.json'))!);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const onDisk = readFileSync(file, 'utf8');
    expect(onDisk).not.toContain('revision 1');
    expect(onDisk).not.toContain('hello');
  });

  it('deduplicates the same semantic item across push and polling transport', () => {
    const first = transcript(1);
    ingestVcMeetingFeedMetadata(dataDir, key, [first], 100);
    const replay = { ...first, source: 'polling', eventId: 'different_transport' } as NormalizedVcMeetingItem;
    const result = ingestVcMeetingFeedMetadata(dataDir, key, [replay], 200);

    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]?.metadata?.ingestSeq).toBe(1);
    expect(result.nextIngestSeq).toBe(2);
    expect(result.duplicates[0]?.metadata?.lastSeenAt).toBe(200);
  });

  it('allocates durable revisions by semantic change and drops an older semantic replay', () => {
    ingestVcMeetingFeedMetadata(dataDir, key, [transcript(1)], 100);
    const newer = ingestVcMeetingFeedMetadata(dataDir, key, [transcript(3)], 200);
    const staleReplay = { ...transcript(99, 'revision 1'), isFinal: false } as NormalizedVcMeetingItem;
    const stale = ingestVcMeetingFeedMetadata(dataDir, key, [staleReplay], 300);

    expect(newer.accepted[0]?.metadata).toMatchObject({ revision: 2, ingestSeq: 2 });
    expect(stale.stale).toHaveLength(1);
    expect(stale.nextIngestSeq).toBe(3);
    expect(listVcMeetingFeedMetadataAfter(dataDir, key, 1).map(item => item.revision)).toEqual([2]);
  });

  it('maps a post-restart local r1 observation back to the existing durable r2 identity', () => {
    ingestVcMeetingFeedMetadata(dataDir, key, [transcript(1, 'A')], 100);
    const latest = transcript(2, 'B');
    const accepted = ingestVcMeetingFeedMetadata(dataDir, key, [latest], 200);
    const rebuiltLocalR1 = { ...latest, revision: 1, eventId: 'after_restart' } as NormalizedVcMeetingItem;
    const replay = ingestVcMeetingFeedMetadata(dataDir, key, [rebuiltLocalR1], 300);

    expect(accepted.accepted[0]?.metadata).toMatchObject({ itemVersionKey: 'transcript:sentence_1:r2' });
    expect(replay.duplicates[0]?.metadata).toMatchObject({
      itemVersionKey: 'transcript:sentence_1:r2',
      ingestSeq: 2,
    });
    expect(replay.nextIngestSeq).toBe(3);
  });

  it('isolates a same-version content conflict without overwriting canonical metadata', () => {
    const first = ingestVcMeetingFeedMetadata(dataDir, key, [chat('first')], 100);
    const conflict = ingestVcMeetingFeedMetadata(dataDir, key, [chat('mutated')], 200);

    expect(conflict.conflicts).toHaveLength(1);
    expect(conflict.nextIngestSeq).toBe(2);
    const state = getVcMeetingFeedMetadataState(dataDir, key);
    expect(state.conflicts).toHaveLength(1);
    expect(state.items['chat:message_1:r1']?.contentHash)
      .toBe(first.accepted[0]?.metadata?.contentHash);
  });

  it('rejects a cross-type reuse of one canonical item key', () => {
    const original = chat('first');
    ingestVcMeetingFeedMetadata(dataDir, key, [original], 100);
    const crossType = {
      ...transcript(1, 'first'),
      itemKey: original.itemKey,
    } as NormalizedVcMeetingItem;
    const result = ingestVcMeetingFeedMetadata(dataDir, key, [crossType], 200);

    expect(result.conflicts).toHaveLength(1);
    expect(result.nextIngestSeq).toBe(2);
  });

  it('does not let a stale revision roll the latest pointer backward', () => {
    const first = transcript(1, 'A');
    ingestVcMeetingFeedMetadata(dataDir, key, [first], 100);
    ingestVcMeetingFeedMetadata(dataDir, key, [transcript(2, 'B')], 200);
    ingestVcMeetingFeedMetadata(dataDir, key, [first], 300);

    expect(getVcMeetingFeedMetadataState(dataDir, key).latestByItemKey['transcript:sentence_1'])
      .toMatchObject({ revision: 2, ingestSeq: 2 });
  });

  it('quarantines corrupt state and fails closed instead of resetting sequence', () => {
    ingestVcMeetingFeedMetadata(dataDir, key, [chat()], 100);
    const dir = join(dataDir, 'vc-meeting-feed-metadata');
    const file = join(dir, readdirSync(dir).find(name => name.endsWith('.json'))!);
    writeFileSync(file, '{broken', 'utf8');

    expect(() => ingestVcMeetingFeedMetadata(dataDir, key, [transcript(1)], 200))
      .toThrow(/corrupt and moved/);
    expect(readdirSync(dir).some(name => name.includes('.corrupt.'))).toBe(true);
    expect(readdirSync(dir).some(name => name.endsWith('.json'))).toBe(false);
    expect(() => ingestVcMeetingFeedMetadata(dataDir, key, [transcript(1)], 300))
      .toThrow(/quarantined evidence/);
  });

  it('rejects unknown nested fields so raw meeting content cannot hide in metadata', () => {
    ingestVcMeetingFeedMetadata(dataDir, key, [chat()], 100);
    const dir = join(dataDir, 'vc-meeting-feed-metadata');
    const file = join(dir, readdirSync(dir).find(name => name.endsWith('.json'))!);
    const state = JSON.parse(readFileSync(file, 'utf8')) as any;
    state.items['chat:message_1:r1'].rawText = 'secret body';
    writeFileSync(file, JSON.stringify(state), 'utf8');

    expect(() => getVcMeetingFeedMetadataState(dataDir, key)).toThrow(/failed validation/);
    expect(readdirSync(dir).some(name => name.includes('.corrupt.'))).toBe(true);
  });

  it('removes the complete per-meeting journal explicitly', () => {
    ingestVcMeetingFeedMetadata(dataDir, key, [chat()], 100);
    expect(removeVcMeetingFeedMetadata(dataDir, key)).toBe(true);
    expect(removeVcMeetingFeedMetadata(dataDir, key)).toBe(false);
  });
});
