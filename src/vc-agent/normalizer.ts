import { createHash } from 'node:crypto';
import type {
  NormalizedVcChatItem,
  NormalizedVcMagicShareItem,
  NormalizedVcMeetingBatch,
  NormalizedVcMeetingItem,
  NormalizedVcParticipantItem,
  NormalizedVcTranscriptItem,
  VcMeetingActivityType,
  VcMeetingActor,
  VcMeetingRef,
  VcMeetingSource,
} from './types.js';

const ACTIVITY_TYPES: VcMeetingActivityType[] = [
  'participant_joined',
  'participant_left',
  'chat_received',
  'transcript_received',
  'magic_share_started',
  'magic_share_ended',
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function getPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const part of path.split('.')) {
    if (!isRecord(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

function parseTimeMs(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v < 10_000_000_000 ? Math.floor(v * 1000) : Math.floor(v);
    }
    if (typeof v === 'string' && v.trim()) {
      if (/^\d+$/.test(v.trim())) {
        const n = Number(v.trim());
        if (Number.isFinite(n)) return n < 10_000_000_000 ? Math.floor(n * 1000) : Math.floor(n);
      }
      const parsed = Date.parse(v);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function actorFrom(...records: unknown[]): VcMeetingActor {
  const openId = firstString(
    ...records.flatMap((r) => [
      getPath(r, 'open_id'),
      getPath(r, 'openId'),
      getPath(r, 'user_id'),
      getPath(r, 'userId'),
      getPath(r, 'id'),
      getPath(r, 'id.open_id'),
      getPath(r, 'id.openId'),
      getPath(r, 'id.user_id'),
      getPath(r, 'id.userId'),
      getPath(r, 'user.open_id'),
      getPath(r, 'user.openId'),
      getPath(r, 'user.user_id'),
      getPath(r, 'user.userId'),
      getPath(r, 'user.id.open_id'),
      getPath(r, 'user.id.openId'),
      getPath(r, 'user.id.user_id'),
      getPath(r, 'user.id.userId'),
      getPath(r, 'participant.open_id'),
      getPath(r, 'participant.openId'),
      getPath(r, 'participant.user_id'),
      getPath(r, 'participant.userId'),
      getPath(r, 'participant.id.open_id'),
      getPath(r, 'participant.id.openId'),
      getPath(r, 'participant.id.user_id'),
      getPath(r, 'participant.id.userId'),
      getPath(r, 'sender.open_id'),
      getPath(r, 'sender.openId'),
      getPath(r, 'sender.user_id'),
      getPath(r, 'sender.userId'),
      getPath(r, 'sender.id'),
      getPath(r, 'sender.id.open_id'),
      getPath(r, 'sender.id.openId'),
      getPath(r, 'sender.id.user_id'),
      getPath(r, 'sender.id.userId'),
      getPath(r, 'operator.open_id'),
      getPath(r, 'operator.openId'),
      getPath(r, 'operator.user_id'),
      getPath(r, 'operator.userId'),
      getPath(r, 'operator.id'),
      getPath(r, 'operator.id.open_id'),
      getPath(r, 'operator.id.openId'),
      getPath(r, 'operator.id.user_id'),
      getPath(r, 'operator.id.userId'),
      getPath(r, 'from.open_id'),
      getPath(r, 'from.openId'),
      getPath(r, 'from.user_id'),
      getPath(r, 'from.userId'),
      getPath(r, 'from.id'),
      getPath(r, 'from.id.open_id'),
      getPath(r, 'from.id.openId'),
      getPath(r, 'from.id.user_id'),
      getPath(r, 'from.id.userId'),
      getPath(r, 'message.sender.open_id'),
      getPath(r, 'message.sender.openId'),
      getPath(r, 'message.sender.user_id'),
      getPath(r, 'message.sender.userId'),
      getPath(r, 'message.sender.id'),
      getPath(r, 'message.sender.id.open_id'),
      getPath(r, 'message.sender.id.openId'),
      getPath(r, 'message.sender.id.user_id'),
      getPath(r, 'message.sender.id.userId'),
    ]),
  );
  const unionId = firstString(
    ...records.flatMap((r) => [
      getPath(r, 'union_id'),
      getPath(r, 'unionId'),
      getPath(r, 'id.union_id'),
      getPath(r, 'id.unionId'),
      getPath(r, 'user.union_id'),
      getPath(r, 'user.unionId'),
      getPath(r, 'user.id.union_id'),
      getPath(r, 'user.id.unionId'),
      getPath(r, 'participant.union_id'),
      getPath(r, 'participant.unionId'),
      getPath(r, 'participant.id.union_id'),
      getPath(r, 'participant.id.unionId'),
      getPath(r, 'sender.union_id'),
      getPath(r, 'sender.unionId'),
      getPath(r, 'sender.id.union_id'),
      getPath(r, 'sender.id.unionId'),
      getPath(r, 'operator.union_id'),
      getPath(r, 'operator.unionId'),
      getPath(r, 'operator.id.union_id'),
      getPath(r, 'operator.id.unionId'),
      getPath(r, 'from.union_id'),
      getPath(r, 'from.unionId'),
      getPath(r, 'from.id.union_id'),
      getPath(r, 'from.id.unionId'),
      getPath(r, 'message.sender.union_id'),
      getPath(r, 'message.sender.unionId'),
      getPath(r, 'message.sender.id.union_id'),
      getPath(r, 'message.sender.id.unionId'),
    ]),
  );
  const name = firstString(
    ...records.flatMap((r) => [
      getPath(r, 'name'),
      getPath(r, 'user_name'),
      getPath(r, 'userName'),
      getPath(r, 'display_name'),
      getPath(r, 'displayName'),
      getPath(r, 'user.name'),
      getPath(r, 'user.user_name'),
      getPath(r, 'user.userName'),
      getPath(r, 'user.display_name'),
      getPath(r, 'user.displayName'),
      getPath(r, 'participant.name'),
      getPath(r, 'participant.user_name'),
      getPath(r, 'participant.userName'),
      getPath(r, 'participant.display_name'),
      getPath(r, 'participant.displayName'),
      getPath(r, 'sender.name'),
      getPath(r, 'sender.user_name'),
      getPath(r, 'sender.userName'),
      getPath(r, 'sender.display_name'),
      getPath(r, 'sender.displayName'),
      getPath(r, 'operator.name'),
      getPath(r, 'operator.user_name'),
      getPath(r, 'operator.userName'),
      getPath(r, 'operator.display_name'),
      getPath(r, 'operator.displayName'),
      getPath(r, 'from.name'),
      getPath(r, 'from.user_name'),
      getPath(r, 'from.userName'),
      getPath(r, 'from.display_name'),
      getPath(r, 'from.displayName'),
      getPath(r, 'message.sender.name'),
      getPath(r, 'message.sender.user_name'),
      getPath(r, 'message.sender.userName'),
      getPath(r, 'message.sender.display_name'),
      getPath(r, 'message.sender.displayName'),
    ]),
  );
  const userType = firstNumber(
    ...records.flatMap((r) => [
      getPath(r, 'user_type'),
      getPath(r, 'userType'),
      getPath(r, 'participant.user_type'),
      getPath(r, 'participant.userType'),
      getPath(r, 'user.user_type'),
      getPath(r, 'user.userType'),
      getPath(r, 'sender.user_type'),
      getPath(r, 'sender.userType'),
      getPath(r, 'operator.user_type'),
      getPath(r, 'operator.userType'),
      getPath(r, 'from.user_type'),
      getPath(r, 'from.userType'),
      getPath(r, 'message.sender.user_type'),
      getPath(r, 'message.sender.userType'),
    ]),
  );
  return {
    ...(openId ? { openId } : {}),
    ...(unionId ? { unionId } : {}),
    ...(name ? { name } : {}),
    ...(userType !== undefined ? { userType } : {}),
  };
}

function eventTypeOf(rawEvent: unknown): VcMeetingActivityType | undefined {
  const direct = firstString(
    getPath(rawEvent, 'event_type'),
    getPath(rawEvent, 'eventType'),
    getPath(rawEvent, 'activity_event_type'),
    getPath(rawEvent, 'activityEventType'),
    getPath(rawEvent, 'type'),
  );
  if (direct && ACTIVITY_TYPES.includes(direct as VcMeetingActivityType)) {
    return direct as VcMeetingActivityType;
  }
  if (isRecord(rawEvent)) {
    for (const t of ACTIVITY_TYPES) {
      if (rawEvent[t] !== undefined || rawEvent[`${t}_items`] !== undefined) return t;
    }
  }
  return undefined;
}

function firstArray(...values: unknown[]): unknown[] | undefined {
  for (const v of values) {
    if (Array.isArray(v)) return v;
  }
  return undefined;
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  return v === undefined || v === null ? [] : [v];
}

function payloadsForType(rawEvent: unknown, type: VcMeetingActivityType): unknown[] {
  const candidates = [
    getPath(rawEvent, `${type}_items`),
    getPath(rawEvent, type),
    getPath(rawEvent, `payload.${type}_items`),
    getPath(rawEvent, `payload.${type}`),
    getPath(rawEvent, `data.${type}_items`),
    getPath(rawEvent, `data.${type}`),
    getPath(rawEvent, 'items'),
    getPath(rawEvent, 'payload.items'),
    getPath(rawEvent, 'data.items'),
  ];
  for (const c of candidates) {
    const values = asArray(c);
    if (values.length > 0) return values;
  }
  return [rawEvent];
}

function rawEventsFrom(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const activityItems = firstArray(
    // Official VC bot activity push field. The misspelling is part of the
    // upstream schema and must be consumed verbatim.
    getPath(raw, 'meeting_actitivty_items'),
    getPath(raw, 'event.meeting_actitivty_items'),
    getPath(raw, 'data.event.meeting_actitivty_items'),
    getPath(raw, 'payload.event.meeting_actitivty_items'),
    // Accept the correctly-spelled form defensively for CLI fixtures / future schema fixes.
    getPath(raw, 'meeting_activity_items'),
    getPath(raw, 'event.meeting_activity_items'),
    getPath(raw, 'data.event.meeting_activity_items'),
    getPath(raw, 'payload.event.meeting_activity_items'),
  );
  if (activityItems) return activityItems;

  const candidates = [
    getPath(raw, 'events'),
    getPath(raw, 'data.events'),
    getPath(raw, 'data.items'),
    getPath(raw, 'items'),
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  const directCandidates = [
    getPath(raw, 'event'),
    getPath(raw, 'data.event'),
    getPath(raw, 'payload.event'),
    raw,
  ];
  for (const c of directCandidates) {
    if (isRecord(c) && eventTypeOf(c)) return [c];
  }
  return [];
}

function meetingRefFrom(raw: unknown, fallbackMeetingId?: string): VcMeetingRef {
  const eventMeeting = rawEventsFrom(raw).map((e) => getPath(e, 'meeting')).find(isRecord);
  const meeting = getPath(raw, 'meeting')
    ?? getPath(raw, 'event.meeting')
    ?? getPath(raw, 'data.meeting')
    ?? getPath(raw, 'data.event.meeting')
    ?? eventMeeting
    ?? raw;
  const id = firstString(
    fallbackMeetingId,
    getPath(meeting, 'id'),
    getPath(meeting, 'meeting_id'),
    getPath(raw, 'meeting_id'),
    getPath(raw, 'event.meeting_id'),
    getPath(raw, 'data.meeting_id'),
    getPath(raw, 'data.event.meeting_id'),
  );
  const meetingNo = firstString(
    getPath(meeting, 'meeting_no'),
    getPath(meeting, 'meetingNo'),
    getPath(raw, 'meeting_no'),
    getPath(raw, 'meetingNo'),
    getPath(raw, 'event.meeting_no'),
    getPath(raw, 'event.meetingNo'),
    getPath(raw, 'data.event.meeting_no'),
    getPath(raw, 'data.event.meetingNo'),
  );
  const topic = firstString(
    getPath(meeting, 'topic'),
    getPath(meeting, 'title'),
    getPath(meeting, 'meeting_title'),
    getPath(raw, 'topic'),
    getPath(raw, 'title'),
    getPath(raw, 'meeting_title'),
    getPath(raw, 'event.topic'),
    getPath(raw, 'event.title'),
    getPath(raw, 'event.meeting_title'),
  );
  const startTimeMs = parseTimeMs(
    getPath(meeting, 'start_time'),
    getPath(meeting, 'startTime'),
    getPath(meeting, 'start_time_ms'),
    getPath(meeting, 'startTimeMs'),
    getPath(raw, 'start_time'),
    getPath(raw, 'startTime'),
    getPath(raw, 'start_time_ms'),
    getPath(raw, 'startTimeMs'),
    getPath(raw, 'event.start_time'),
    getPath(raw, 'event.startTime'),
    getPath(raw, 'event.start_time_ms'),
    getPath(raw, 'event.startTimeMs'),
  );
  const host = actorFrom(
    getPath(meeting, 'host_user'),
    getPath(meeting, 'hostUser'),
    getPath(meeting, 'host'),
    {
      open_id: getPath(meeting, 'host_open_id'),
      user_id: getPath(meeting, 'host_user_id'),
      name: getPath(meeting, 'host_name'),
      user_type: getPath(meeting, 'host_user_type'),
    },
    getPath(raw, 'host_user'),
    getPath(raw, 'hostUser'),
    getPath(raw, 'host'),
    getPath(raw, 'event.host_user'),
    getPath(raw, 'event.hostUser'),
    getPath(raw, 'event.host'),
  );
  return {
    id: id ?? '',
    ...(meetingNo ? { meetingNo } : {}),
    ...(topic ? { topic } : {}),
    ...(startTimeMs !== undefined ? { startTimeMs } : {}),
    ...(host.openId ? { hostOpenId: host.openId } : {}),
    ...(host.name ? { hostName: host.name } : {}),
  };
}

function eventIdOf(rawEvent: unknown): string | undefined {
  return firstString(
    getPath(rawEvent, 'event_id'),
    getPath(rawEvent, 'eventId'),
    getPath(rawEvent, 'id'),
    getPath(rawEvent, 'header.event_id'),
  );
}

function occurredAt(rawEvent: unknown, item: unknown): number | undefined {
  return parseTimeMs(
    getPath(item, 'time'),
    getPath(item, 'timestamp'),
    getPath(item, 'event_time'),
    getPath(item, 'eventTime'),
    getPath(item, 'create_time'),
    getPath(item, 'createTime'),
    getPath(item, 'send_time'),
    getPath(item, 'sendTime'),
    getPath(item, 'send_time_ms'),
    getPath(item, 'sendTimeMs'),
    getPath(item, 'join_time'),
    getPath(item, 'joinTime'),
    getPath(item, 'join_time_ms'),
    getPath(item, 'joinTimeMs'),
    getPath(item, 'leave_time'),
    getPath(item, 'leaveTime'),
    getPath(item, 'leave_time_ms'),
    getPath(item, 'leaveTimeMs'),
    getPath(item, 'start_time'),
    getPath(item, 'startTime'),
    getPath(item, 'start_time_ms'),
    getPath(item, 'startTimeMs'),
    getPath(item, 'end_time'),
    getPath(item, 'endTime'),
    getPath(item, 'end_time_ms'),
    getPath(item, 'endTimeMs'),
    getPath(rawEvent, 'event_time'),
    getPath(rawEvent, 'eventTime'),
    getPath(rawEvent, 'time'),
    getPath(rawEvent, 'timestamp'),
    getPath(rawEvent, 'create_time'),
    getPath(rawEvent, 'createTime'),
    getPath(rawEvent, 'send_time'),
    getPath(rawEvent, 'sendTime'),
    getPath(rawEvent, 'send_time_ms'),
    getPath(rawEvent, 'sendTimeMs'),
    getPath(rawEvent, 'join_time'),
    getPath(rawEvent, 'joinTime'),
    getPath(rawEvent, 'join_time_ms'),
    getPath(rawEvent, 'joinTimeMs'),
    getPath(rawEvent, 'leave_time'),
    getPath(rawEvent, 'leaveTime'),
    getPath(rawEvent, 'leave_time_ms'),
    getPath(rawEvent, 'leaveTimeMs'),
  );
}

function normalizeParticipant(
  source: VcMeetingSource,
  meetingId: string,
  type: 'participant_joined' | 'participant_left',
  rawEvent: unknown,
  item: unknown,
): NormalizedVcParticipantItem {
  const participant = actorFrom(
    item,
    getPath(item, 'participant'),
    getPath(item, 'user'),
    getPath(item, 'operator'),
    getPath(item, 'from'),
    rawEvent,
    getPath(rawEvent, 'participant'),
    getPath(rawEvent, 'user'),
    getPath(rawEvent, 'operator'),
    getPath(rawEvent, 'from'),
  );
  const occurredAtMs = occurredAt(rawEvent, item);
  const itemKey = [
    type,
    participant.openId ?? participant.name ?? 'unknown',
    occurredAtMs ?? eventIdOf(rawEvent) ?? '',
  ].join(':');
  return {
    source,
    type,
    meetingId,
    ...(eventIdOf(rawEvent) ? { eventId: eventIdOf(rawEvent) } : {}),
    itemKey,
    ...(occurredAtMs !== undefined ? { occurredAtMs } : {}),
    participant,
    ...(firstString(
      getPath(item, 'role'),
      getPath(item, 'participant.role'),
      getPath(rawEvent, 'role'),
      getPath(rawEvent, 'participant.role'),
    ) ? {
      role: firstString(
        getPath(item, 'role'),
        getPath(item, 'participant.role'),
        getPath(rawEvent, 'role'),
        getPath(rawEvent, 'participant.role'),
      ),
    } : {}),
  };
}

function normalizeChat(source: VcMeetingSource, meetingId: string, rawEvent: unknown, item: unknown): NormalizedVcChatItem {
  const sender = actorFrom(
    item,
    getPath(item, 'sender'),
    getPath(item, 'user'),
    getPath(item, 'operator'),
    getPath(item, 'from'),
    getPath(item, 'message.sender'),
    rawEvent,
    getPath(rawEvent, 'sender'),
    getPath(rawEvent, 'user'),
    getPath(rawEvent, 'operator'),
    getPath(rawEvent, 'from'),
  );
  const messageId = firstString(
    getPath(item, 'message_id'),
    getPath(item, 'messageId'),
    getPath(item, 'id'),
    getPath(item, 'message.message_id'),
    getPath(item, 'message.messageId'),
    getPath(item, 'message.id'),
    getPath(rawEvent, 'message_id'),
    getPath(rawEvent, 'messageId'),
    getPath(rawEvent, 'message.message_id'),
    getPath(rawEvent, 'message.messageId'),
    getPath(rawEvent, 'message.id'),
  );
  const text = firstString(
    getPath(item, 'text'),
    getPath(item, 'content.text'),
    getPath(item, 'content.plain_text'),
    getPath(item, 'content.plainText'),
    getPath(item, 'content.value'),
    getPath(item, 'message.text'),
    getPath(item, 'message.content.text'),
    getPath(item, 'message.content.plain_text'),
    getPath(item, 'message.content.plainText'),
    getPath(item, 'message.content.value'),
    getPath(item, 'message.message_content'),
    getPath(item, 'message.messageContent'),
    getPath(item, 'message_content'),
    getPath(item, 'messageContent'),
    getPath(item, 'body.text'),
    getPath(item, 'body.content.text'),
    typeof getPath(item, 'content') === 'string' ? getPath(item, 'content') : undefined,
    typeof getPath(item, 'message.content') === 'string' ? getPath(item, 'message.content') : undefined,
  );
  const occurredAtMs = occurredAt(rawEvent, item);
  return {
    source,
    type: 'chat_received',
    meetingId,
    ...(eventIdOf(rawEvent) ? { eventId: eventIdOf(rawEvent) } : {}),
    itemKey: `chat:${messageId ?? shortHash(`${sender.openId ?? sender.name ?? ''}:${occurredAtMs ?? ''}:${text ?? ''}`)}`,
    ...(occurredAtMs !== undefined ? { occurredAtMs } : {}),
    ...(messageId ? { messageId } : {}),
    sender,
    ...(firstString(
      getPath(item, 'message_type'),
      getPath(item, 'messageType'),
      getPath(item, 'type'),
      getPath(item, 'message.message_type'),
      getPath(item, 'message.messageType'),
      getPath(rawEvent, 'message_type'),
      getPath(rawEvent, 'messageType'),
    ) ? {
      messageType: firstString(
        getPath(item, 'message_type'),
        getPath(item, 'messageType'),
        getPath(item, 'type'),
        getPath(item, 'message.message_type'),
        getPath(item, 'message.messageType'),
        getPath(rawEvent, 'message_type'),
        getPath(rawEvent, 'messageType'),
      ),
    } : {}),
    ...(text ? { text } : {}),
  };
}

function normalizeTranscript(source: VcMeetingSource, meetingId: string, rawEvent: unknown, item: unknown): NormalizedVcTranscriptItem {
  const speaker = actorFrom(
    item,
    getPath(item, 'speaker'),
    getPath(item, 'user'),
    getPath(item, 'operator'),
    rawEvent,
    getPath(rawEvent, 'speaker'),
    getPath(rawEvent, 'user'),
    getPath(rawEvent, 'operator'),
  );
  const text = firstString(
    getPath(item, 'text'),
    getPath(item, 'content.text'),
    getPath(item, 'content.plain_text'),
    getPath(item, 'content.plainText'),
    getPath(item, 'content'),
    getPath(item, 'sentence.text'),
    getPath(item, 'sentence.content'),
    getPath(item, 'sentence'),
    getPath(item, 'transcript.text'),
    getPath(item, 'transcript.content'),
    getPath(item, 'transcript'),
  ) ?? '';
  const startTimeMs = parseTimeMs(
    getPath(item, 'start_time'),
    getPath(item, 'startTime'),
    getPath(item, 'start_time_ms'),
    getPath(item, 'startTimeMs'),
  );
  const endTimeMs = parseTimeMs(
    getPath(item, 'end_time'),
    getPath(item, 'endTime'),
    getPath(item, 'end_time_ms'),
    getPath(item, 'endTimeMs'),
  );
  const sentenceId = firstString(
    getPath(item, 'sentence_id'),
    getPath(item, 'sentenceId'),
    getPath(item, 'id'),
    getPath(item, 'sentence.sentence_id'),
    getPath(item, 'sentence.sentenceId'),
    getPath(item, 'sentence.id'),
    getPath(item, 'transcript.sentence_id'),
    getPath(item, 'transcript.sentenceId'),
    getPath(item, 'transcript.id'),
  ) ?? `fallback:${shortHash(`${speaker.openId ?? speaker.name ?? ''}:${startTimeMs ?? ''}:${endTimeMs ?? ''}:${text}`)}`;
  const isFinalRaw = getPath(item, 'is_final') ?? getPath(item, 'isFinal') ?? getPath(item, 'final');
  const status = firstString(getPath(item, 'status'), getPath(item, 'state'));
  const occurredAtMs = endTimeMs ?? startTimeMs ?? occurredAt(rawEvent, item);
  return {
    source,
    type: 'transcript_received',
    meetingId,
    ...(eventIdOf(rawEvent) ? { eventId: eventIdOf(rawEvent) } : {}),
    itemKey: `transcript:${sentenceId}`,
    ...(occurredAtMs !== undefined ? { occurredAtMs } : {}),
    sentenceId,
    speaker,
    ...(startTimeMs !== undefined ? { startTimeMs } : {}),
    ...(endTimeMs !== undefined ? { endTimeMs } : {}),
    ...(firstString(getPath(item, 'language'), getPath(item, 'lang'), getPath(item, 'sentence.language'), getPath(item, 'transcript.language')) ? {
      language: firstString(getPath(item, 'language'), getPath(item, 'lang'), getPath(item, 'sentence.language'), getPath(item, 'transcript.language')),
    } : {}),
    text,
    ...(firstNumber(getPath(item, 'revision'), getPath(item, 'version'), getPath(item, 'rev')) !== undefined ? {
      revision: firstNumber(getPath(item, 'revision'), getPath(item, 'version'), getPath(item, 'rev')),
    } : {}),
    ...(typeof isFinalRaw === 'boolean' || status ? {
      isFinal: isFinalRaw === true || status === 'final' || status === 'stable',
    } : {}),
  };
}

function normalizeMagicShare(
  source: VcMeetingSource,
  meetingId: string,
  type: 'magic_share_started' | 'magic_share_ended',
  rawEvent: unknown,
  item: unknown,
): NormalizedVcMagicShareItem {
  const shareDoc = getPath(item, 'share_doc')
    ?? getPath(item, 'shareDoc')
    ?? getPath(item, 'document')
    ?? getPath(item, 'doc')
    ?? getPath(rawEvent, 'share_doc')
    ?? getPath(rawEvent, 'shareDoc')
    ?? getPath(rawEvent, 'document')
    ?? getPath(rawEvent, 'doc')
    ?? item;
  const shareId = firstString(
    getPath(item, 'share_id'),
    getPath(item, 'shareId'),
    getPath(rawEvent, 'share_id'),
    getPath(rawEvent, 'shareId'),
    getPath(shareDoc, 'token'),
    getPath(shareDoc, 'id'),
  );
  const occurredAtMs = occurredAt(rawEvent, item);
  return {
    source,
    type,
    meetingId,
    ...(eventIdOf(rawEvent) ? { eventId: eventIdOf(rawEvent) } : {}),
    itemKey: `${type}:${shareId ?? shortHash(`${firstString(getPath(shareDoc, 'title')) ?? ''}:${occurredAtMs ?? ''}`)}`,
    ...(occurredAtMs !== undefined ? { occurredAtMs } : {}),
    ...(shareId ? { shareId } : {}),
    ...(firstString(getPath(shareDoc, 'title'), getPath(item, 'title'), getPath(rawEvent, 'title')) ? {
      title: firstString(getPath(shareDoc, 'title'), getPath(item, 'title'), getPath(rawEvent, 'title')),
    } : {}),
    ...(firstString(getPath(shareDoc, 'url'), getPath(item, 'url'), getPath(rawEvent, 'url')) ? {
      url: firstString(getPath(shareDoc, 'url'), getPath(item, 'url'), getPath(rawEvent, 'url')),
    } : {}),
    operator: actorFrom(
      item,
      getPath(item, 'operator'),
      getPath(item, 'user'),
      getPath(item, 'from'),
      rawEvent,
      getPath(rawEvent, 'operator'),
      getPath(rawEvent, 'user'),
      getPath(rawEvent, 'from'),
    ),
  };
}

function normalizeItem(
  source: VcMeetingSource,
  meetingId: string,
  type: VcMeetingActivityType,
  rawEvent: unknown,
  item: unknown,
): NormalizedVcMeetingItem {
  switch (type) {
    case 'participant_joined':
    case 'participant_left':
      return normalizeParticipant(source, meetingId, type, rawEvent, item);
    case 'chat_received':
      return normalizeChat(source, meetingId, rawEvent, item);
    case 'transcript_received':
      return normalizeTranscript(source, meetingId, rawEvent, item);
    case 'magic_share_started':
    case 'magic_share_ended':
      return normalizeMagicShare(source, meetingId, type, rawEvent, item);
  }
}

export function normalizeVcMeetingEvents(
  raw: unknown,
  opts: { meetingId?: string; source?: VcMeetingSource } = {},
): NormalizedVcMeetingBatch {
  const source = opts.source ?? 'polling';
  const meeting = meetingRefFrom(raw, opts.meetingId);
  const meetingId = meeting.id || opts.meetingId || '';
  const items: NormalizedVcMeetingItem[] = [];

  for (const rawEvent of rawEventsFrom(raw)) {
    const type = eventTypeOf(rawEvent);
    if (!type) continue;
    for (const payload of payloadsForType(rawEvent, type)) {
      items.push(normalizeItem(source, meetingId, type, rawEvent, payload));
    }
  }

  return {
    source,
    meeting: { ...meeting, id: meetingId },
    items,
    ...(firstString(getPath(raw, 'page_token'), getPath(raw, 'data.page_token')) ? {
      pageToken: firstString(getPath(raw, 'page_token'), getPath(raw, 'data.page_token')),
    } : {}),
    ...(typeof (getPath(raw, 'has_more') ?? getPath(raw, 'data.has_more')) === 'boolean' ? {
      hasMore: (getPath(raw, 'has_more') ?? getPath(raw, 'data.has_more')) as boolean,
    } : {}),
  };
}

export const _testOnly = {
  parseTimeMs,
  eventTypeOf,
};
