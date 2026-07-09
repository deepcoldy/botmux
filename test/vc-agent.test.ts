import { describe, expect, it } from 'vitest';
import { normalizeVcMeetingEvents } from '../src/vc-agent/normalizer.js';
import {
  beginVcIngestionPass,
  beginVcPollingPass,
  buildVcMeetingStatePayload,
  collectStableTranscriptItems,
  createVcMeetingSessionState,
  ingestNormalizedVcMeetingItems,
} from '../src/vc-agent/meeting-state.js';
import { assertLarkCliJsonOk } from '../src/vc-agent/polling-source.js';
import { buildVcMeetingConfirmCard } from '../src/vc-agent/cards.js';

describe('vc-agent normalizer and state', () => {
  it('normalizes polling meeting event items without relying on push event names', () => {
    const batch = normalizeVcMeetingEvents({
      meeting: { id: 'm_1', meeting_no: '123456789', topic: 'Design review' },
      events: [
        {
          event_id: 'evt_chat',
          event_type: 'chat_received',
          chat_received_items: [
            {
              message_id: 'msg_1',
              send_time: 1_780_000_000_000,
              sender: { open_id: 'ou_a', user_name: 'Alice' },
              message_type: 'text',
              text: 'ping',
            },
          ],
        },
        {
          event_id: 'evt_tx',
          event_type: 'transcript_received',
          transcript_received_items: [
            {
              sentence_id: 'sent_1',
              speaker: { open_id: 'ou_b', user_name: 'Bob' },
              start_time: 1_780_000_001_000,
              end_time: 1_780_000_002_000,
              language: 'zh_cn',
              text: 'first version',
            },
          ],
        },
      ],
      page_token: 'token_1',
      has_more: false,
    }, { source: 'polling' });

    expect(batch.meeting).toMatchObject({ id: 'm_1', meetingNo: '123456789', topic: 'Design review' });
    expect(batch.pageToken).toBe('token_1');
    expect(batch.items.map((item) => item.type)).toEqual(['chat_received', 'transcript_received']);
    expect(batch.items.every((item) => item.source === 'polling')).toBe(true);
    expect(JSON.stringify(batch)).not.toContain('vc.bot.');
  });

  it('normalizes push activity payloads from the upstream meeting_actitivty_items typo container', () => {
    const batch = normalizeVcMeetingEvents({
      header: {
        event_id: 'evt_push_1',
        event_type: 'vc.bot.meeting_activity_v1',
        create_time: '1780000000000',
      },
      event: {
        meeting_actitivty_items: [
          {
            activity_event_type: 'transcript_received',
            meeting: {
              id: 'm_push',
              meeting_no: '987654321',
              topic: 'Push review',
              start_time_ms: '1780000000000',
              host_user_id: 'ou_host',
              host_name: 'Host',
            },
            transcript_received_items: [
              {
                sentence_id: 'sent_push_1',
                speaker: { open_id: 'ou_speaker', user_name: 'Speaker', user_type: 100 },
                language: 'zh_cn',
                start_time_ms: '1780000001000',
                end_time_ms: '1780000002000',
                text: 'push transcript',
              },
            ],
          },
          {
            activity_event_type: 'chat_received',
            meeting: { id: 'm_push' },
            chat_received_items: [
              {
                message_id: 'msg_push_1',
                sender: { open_id: 'ou_sender', user_name: 'Sender' },
                message_type: 1,
                text: 'push chat',
              },
            ],
          },
        ],
      },
    }, { meetingId: 'm_push', source: 'push' });

    expect(batch.meeting).toMatchObject({
      id: 'm_push',
      meetingNo: '987654321',
      topic: 'Push review',
      startTimeMs: 1_780_000_000_000,
      hostOpenId: 'ou_host',
      hostName: 'Host',
    });
    expect(batch.items.map((item) => item.type)).toEqual(['transcript_received', 'chat_received']);
    expect(batch.items.every((item) => item.source === 'push')).toBe(true);
    expect(batch.items[0]).toMatchObject({
      type: 'transcript_received',
      itemKey: 'transcript:sent_push_1',
      occurredAtMs: 1_780_000_002_000,
      speaker: { openId: 'ou_speaker', name: 'Speaker', userType: 100 },
      text: 'push transcript',
    });
    expect(batch.items[1]).toMatchObject({
      type: 'chat_received',
      itemKey: 'chat:msg_push_1',
      messageType: '1',
      text: 'push chat',
    });
  });

  it('normalizes push activity payloads with nested speaker id objects', () => {
    const batch = normalizeVcMeetingEvents({
      header: {
        event_id: 'evt_push_nested_id',
        event_type: 'vc.bot.meeting_activity_v1',
      },
      event: {
        meeting_activity_items: [
          {
            activity_event_type: 'transcript_received',
            meeting: {
              id: 'm_push_nested_id',
              meeting_no: '455282654',
              host_user: {
                id: { open_id: 'ou_host_nested', union_id: 'on_host_nested', user_id: 'host_uid' },
                user_name: 'Host',
              },
            },
            transcript_received_items: [
              {
                sentence_id: 'sent_nested_id',
                speaker: {
                  id: { open_id: 'ou_speaker_nested', union_id: 'on_speaker_nested', user_id: 'speaker_uid' },
                  user_name: 'Speaker',
                  user_type: 1,
                },
                start_time_ms: '1783573991399',
                end_time_ms: '1783573992719',
                language: 'zh_cn',
                text: 'nested id transcript',
              },
            ],
          },
        ],
      },
    }, { meetingId: 'm_push_nested_id', source: 'push' });

    expect(batch.meeting).toMatchObject({
      id: 'm_push_nested_id',
      meetingNo: '455282654',
      hostOpenId: 'ou_host_nested',
      hostName: 'Host',
    });
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]).toMatchObject({
      type: 'transcript_received',
      itemKey: 'transcript:sent_nested_id',
      speaker: { openId: 'ou_speaker_nested', unionId: 'on_speaker_nested', name: 'Speaker', userType: 1 },
      text: 'nested id transcript',
    });
  });

  it('normalizes chat message fields nested under message with wrapper operator actor', () => {
    const batch = normalizeVcMeetingEvents({
      event: {
        meeting_actitivty_items: [
          {
            activity_event_type: 'chat_received',
            meeting: { id: 'm_push' },
            operator: { id: 'ou_operator', name: 'Operator' },
            chat_received_items: [
              {
                send_time_ms: '1780000005000',
                message: {
                  id: 'msg_nested',
                  message_type: 'text',
                  content: { text: 'nested chat' },
                },
              },
            ],
          },
        ],
      },
    }, { meetingId: 'm_push', source: 'push' });

    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]).toMatchObject({
      type: 'chat_received',
      itemKey: 'chat:msg_nested',
      messageId: 'msg_nested',
      messageType: 'text',
      sender: { openId: 'ou_operator', name: 'Operator' },
      occurredAtMs: 1_780_000_005_000,
      text: 'nested chat',
    });
  });

  it('normalizes chat sender from the activity operator wrapper', () => {
    const batch = normalizeVcMeetingEvents({
      header: {
        event_id: 'evt_push_chat_operator',
        event_type: 'vc.bot.meeting_activity_v1',
        create_time: '1780000000000',
      },
      event: {
        meeting_actitivty_items: [
          {
            activity_event_type: 'chat_received',
            meeting: { id: 'm_push' },
            operator: { id: 'ou_operator', name: 'Operator' },
            chat_received_items: [
              {
                message_id: 'msg_push_operator',
                message_type: 1,
                text: 'operator chat',
              },
            ],
          },
        ],
      },
    }, { meetingId: 'm_push', source: 'push' });

    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]).toMatchObject({
      type: 'chat_received',
      sender: { openId: 'ou_operator', name: 'Operator' },
      text: 'operator chat',
    });
  });

  it('normalizes participant actor from the activity wrapper', () => {
    const batch = normalizeVcMeetingEvents({
      event: {
        meeting_actitivty_items: [
          {
            activity_event_type: 'participant_joined',
            meeting: { id: 'm_push' },
            participant: { id: 'ou_participant', name: 'Participant', user_type: 101, role: 'host' },
            participant_joined_items: [
              { join_time_ms: '1780000006000' },
            ],
          },
        ],
      },
    }, { meetingId: 'm_push', source: 'push' });

    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]).toMatchObject({
      type: 'participant_joined',
      participant: { openId: 'ou_participant', name: 'Participant', userType: 101 },
      occurredAtMs: 1_780_000_006_000,
      role: 'host',
    });
  });

  it('normalizes transcript text and speaker from nested and wrapper fields', () => {
    const batch = normalizeVcMeetingEvents({
      event: {
        meeting_actitivty_items: [
          {
            activity_event_type: 'transcript_received',
            meeting: { id: 'm_push' },
            speaker: { id: 'ou_speaker', name: 'Speaker' },
            transcript_received_items: [
              {
                sentence: { id: 'sent_nested', text: 'nested transcript', language: 'en_us' },
                startTimeMs: '1780000007000',
                endTimeMs: '1780000008000',
              },
            ],
          },
        ],
      },
    }, { meetingId: 'm_push', source: 'push' });

    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]).toMatchObject({
      type: 'transcript_received',
      itemKey: 'transcript:sent_nested',
      sentenceId: 'sent_nested',
      speaker: { openId: 'ou_speaker', name: 'Speaker' },
      startTimeMs: 1_780_000_007_000,
      endTimeMs: 1_780_000_008_000,
      language: 'en_us',
      text: 'nested transcript',
    });
  });

  it('treats exit-zero lark-cli ok=false payloads as failed API calls', () => {
    expect(() => assertLarkCliJsonOk({ ok: true }, 'meeting text message send')).not.toThrow();
    expect(() => assertLarkCliJsonOk({ ok: false, error: 'permission denied' }, 'meeting text message send'))
      .toThrow('meeting text message send failed: permission denied');
  });

  it('drops repeated non-transcript items by item key', () => {
    const batch = normalizeVcMeetingEvents({
      meeting: { id: 'm_1' },
      events: [
        {
          event_type: 'chat_received',
          chat_received_items: [
            { message_id: 'msg_1', sender: { open_id: 'ou_a' }, text: 'same' },
            { message_id: 'msg_1', sender: { open_id: 'ou_a' }, text: 'same' },
          ],
        },
      ],
    }, { meetingId: 'm_1' });
    const state = createVcMeetingSessionState({ meeting: { id: 'm_1' } });
    beginVcPollingPass(state, new Date('2026-07-01T00:00:00.000Z'));

    const result = ingestNormalizedVcMeetingItems(state, batch.items);

    expect(result.acceptedItems).toHaveLength(1);
    expect(result.droppedDuplicateItems).toHaveLength(1);
    expect(state.dedup.seenItemIds).toEqual(['chat:msg_1']);
  });

  it('upserts transcript revisions by sentence_id and flushes the later text once stable', () => {
    const state = createVcMeetingSessionState({ meeting: { id: 'm_1' } });

    beginVcPollingPass(state, new Date('2026-07-01T00:00:00.000Z'));
    ingestNormalizedVcMeetingItems(state, normalizeVcMeetingEvents({
      meeting: { id: 'm_1' },
      events: [
        {
          event_type: 'transcript_received',
          transcript_received_items: [
            { sentence_id: 'sent_1', revision: 7, speaker: { open_id: 'ou_a', user_name: 'Alice' }, text: 'ship this week' },
          ],
        },
      ],
    }, { meetingId: 'm_1' }).items, { now: new Date('2026-07-01T00:00:00.000Z') });
    expect(collectStableTranscriptItems(state, { stabilizePollWindows: 1 })).toEqual([]);

    beginVcPollingPass(state, new Date('2026-07-01T00:00:10.000Z'));
    ingestNormalizedVcMeetingItems(state, normalizeVcMeetingEvents({
      meeting: { id: 'm_1' },
      events: [
        {
          event_type: 'transcript_received',
          transcript_received_items: [
            { sentence_id: 'sent_1', revision: 7, speaker: { open_id: 'ou_a', user_name: 'Alice' }, text: 'do not ship this week' },
          ],
        },
      ],
    }, { meetingId: 'm_1' }).items, { now: new Date('2026-07-01T00:00:10.000Z') });
    expect(state.dedup.transcriptBySentenceId.sent_1.text).toBe('do not ship this week');
    expect(collectStableTranscriptItems(state, { stabilizePollWindows: 1 })).toEqual([]);

    beginVcPollingPass(state, new Date('2026-07-01T00:00:20.000Z'));
    ingestNormalizedVcMeetingItems(state, [], { now: new Date('2026-07-01T00:00:20.000Z') });
    const ready = collectStableTranscriptItems(state, { stabilizePollWindows: 1 });

    expect(ready).toHaveLength(1);
    expect(ready[0].text).toBe('do not ship this week');
    expect(ready[0].revision).toBe(2);
  });

  it('stabilizes push transcripts by wall-clock time without polling windows', () => {
    const state = createVcMeetingSessionState({ meeting: { id: 'm_1' }, source: 'push' });
    beginVcIngestionPass(state, new Date('2026-07-01T00:00:00.000Z'));
    ingestNormalizedVcMeetingItems(state, normalizeVcMeetingEvents({
      event: {
        meeting_actitivty_items: [
          {
            activity_event_type: 'transcript_received',
            meeting: { id: 'm_1' },
            transcript_received_items: [
              { sentence_id: 'sent_1', speaker: { open_id: 'ou_a' }, text: 'push only' },
            ],
          },
        ],
      },
    }, { meetingId: 'm_1', source: 'push' }).items, { now: new Date('2026-07-01T00:00:00.000Z') });

    expect(collectStableTranscriptItems(state, {
      stabilizeMs: 5_000,
      now: new Date('2026-07-01T00:00:04.999Z'),
    })).toEqual([]);
    const ready = collectStableTranscriptItems(state, {
      stabilizeMs: 5_000,
      now: new Date('2026-07-01T00:00:05.000Z'),
    });

    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ source: 'push', text: 'push only' });
  });

  it('prunes transcript dedup state by age when the transcript cap is exceeded', () => {
    const state = createVcMeetingSessionState({ meeting: { id: 'm_1' } });
    for (let i = 0; i < 3; i += 1) {
      beginVcPollingPass(state, new Date(`2026-07-01T00:00:0${i}.000Z`));
      ingestNormalizedVcMeetingItems(state, normalizeVcMeetingEvents({
        meeting: { id: 'm_1' },
        events: [{
          event_type: 'transcript_received',
          transcript_received_items: [
            { sentence_id: `sent_${i}`, speaker: { open_id: 'ou_a' }, text: `line ${i}` },
          ],
        }],
      }, { meetingId: 'm_1' }).items, {
        now: new Date(`2026-07-01T00:00:0${i}.000Z`),
        transcriptLimit: 2,
      });
    }

    expect(Object.keys(state.dedup.transcriptBySentenceId).sort()).toEqual(['sent_1', 'sent_2']);
  });

  it('uses transcript end/start time to advance the polling time-window cursor', () => {
    const state = createVcMeetingSessionState({ meeting: { id: 'm_1' } });
    beginVcPollingPass(state, new Date('2026-07-01T00:00:00.000Z'));

    const batch = normalizeVcMeetingEvents({
      meeting: { id: 'm_1' },
      events: [
        {
          event_type: 'transcript_received',
          transcript_received_items: [
            {
              sentence_id: 'sent_time',
              speaker: { open_id: 'ou_a' },
              start_time: 1_780_000_001_000,
              end_time: 1_780_000_002_000,
              text: 'advance cursor',
            },
          ],
        },
      ],
    }, { meetingId: 'm_1' });

    ingestNormalizedVcMeetingItems(state, batch.items);

    expect(batch.items[0].occurredAtMs).toBe(1_780_000_002_000);
    expect(state.ingestion.lastSeenEventTime).toBe(1_780_000_002_000);
  });

  it('builds structured meeting-state payloads for vc_meeting source', () => {
    const state = createVcMeetingSessionState({
      meeting: { id: 'm_1', topic: 'Weekly' },
      attentionTargetOpenId: 'ou_target',
      notificationChatId: 'oc_notify',
    });
    beginVcPollingPass(state, new Date('2026-07-01T00:00:00.000Z'));
    const payload = buildVcMeetingStatePayload(state, [], { pageToken: 'next' });

    expect(payload).toMatchObject({
      format: 'botmux.vc-meeting.v1',
      meeting: { id: 'm_1', topic: 'Weekly' },
      poll: { ordinal: 1, pageToken: 'next' },
      session: {
        attentionTargetOpenId: 'ou_target',
        notificationChatId: 'oc_notify',
      },
    });
  });

  it('escapes HTML control chars in VC cards so meeting titles cannot inject mentions', () => {
    const card = buildVcMeetingConfirmCard({
      status: 'pending',
      meeting: {
        id: 'm_<at id=ou_x></at>',
        topic: '</font><at id=all></at>',
      },
      targetOpenId: 'ou_target',
      nonce: 'nonce_1',
    });

    const parsed = JSON.parse(card) as { elements: Array<{ tag: string; content?: string }> };
    const markdown = parsed.elements.find(element => element.tag === 'markdown')?.content ?? '';
    expect(markdown).not.toMatch(/<at\b/);
    expect(markdown).toContain('&lt;at id=all&gt;&lt;/at&gt;');
  });

});
