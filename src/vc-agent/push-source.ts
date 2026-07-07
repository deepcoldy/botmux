import type { VcMeetingPushContext, VcMeetingPushEventKind, VcMeetingRef } from './types.js';

export const VC_BOT_MEETING_INVITED_EVENT = 'vc.bot.meeting_invited_v1';
export const VC_BOT_MEETING_ACTIVITY_EVENT = 'vc.bot.meeting_activity_v1';
export const VC_BOT_MEETING_ENDED_EVENT = 'vc.bot.meeting_ended_v1';
export const VC_PARTICIPANT_MEETING_JOINED_EVENT = 'vc.meeting.participant_meeting_joined_v1';

export type VcMeetingPushEventType =
  | typeof VC_BOT_MEETING_INVITED_EVENT
  | typeof VC_BOT_MEETING_ACTIVITY_EVENT
  | typeof VC_BOT_MEETING_ENDED_EVENT
  | typeof VC_PARTICIPANT_MEETING_JOINED_EVENT;

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

function parseTimeMs(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v < 10_000_000_000 ? Math.floor(v * 1000) : Math.floor(v);
    }
    if (typeof v === 'string' && v.trim()) {
      const s = v.trim();
      if (/^\d+$/.test(s)) {
        const n = Number(s);
        if (Number.isFinite(n)) return n < 10_000_000_000 ? Math.floor(n * 1000) : Math.floor(n);
      }
      const parsed = Date.parse(s);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function eventBody(data: unknown): unknown {
  return getPath(data, 'event') ?? getPath(data, 'data.event') ?? data;
}

function firstActivityMeeting(data: unknown): unknown {
  const candidates = [
    getPath(data, 'event.meeting_actitivty_items'),
    getPath(data, 'event.meeting_activity_items'),
    getPath(data, 'data.event.meeting_actitivty_items'),
    getPath(data, 'data.event.meeting_activity_items'),
    getPath(data, 'meeting_actitivty_items'),
    getPath(data, 'meeting_activity_items'),
  ];
  for (const c of candidates) {
    if (!Array.isArray(c)) continue;
    for (const item of c) {
      const meeting = getPath(item, 'meeting');
      if (isRecord(meeting)) return meeting;
    }
  }
  return undefined;
}

function meetingRefFromPush(data: unknown): VcMeetingRef {
  const body = eventBody(data);
  const meeting = getPath(body, 'meeting') ?? getPath(data, 'meeting') ?? firstActivityMeeting(data) ?? body;
  const id = firstString(
    getPath(meeting, 'id'),
    getPath(meeting, 'meeting_id'),
    getPath(body, 'meeting_id'),
    getPath(data, 'meeting_id'),
    getPath(data, 'event.meeting_id'),
    getPath(data, 'data.event.meeting_id'),
  );
  return {
    id: id ?? '',
    ...(firstString(getPath(meeting, 'meeting_no'), getPath(meeting, 'meetingNo'), getPath(body, 'meeting_no')) ? {
      meetingNo: firstString(getPath(meeting, 'meeting_no'), getPath(meeting, 'meetingNo'), getPath(body, 'meeting_no')),
    } : {}),
    ...(firstString(getPath(meeting, 'topic'), getPath(meeting, 'title'), getPath(meeting, 'meeting_title')) ? {
      topic: firstString(getPath(meeting, 'topic'), getPath(meeting, 'title'), getPath(meeting, 'meeting_title')),
    } : {}),
    ...(parseTimeMs(getPath(meeting, 'start_time'), getPath(meeting, 'startTime'), getPath(meeting, 'start_time_ms')) !== undefined ? {
      startTimeMs: parseTimeMs(getPath(meeting, 'start_time'), getPath(meeting, 'startTime'), getPath(meeting, 'start_time_ms')),
    } : {}),
    ...(firstString(getPath(meeting, 'host_user.open_id'), getPath(meeting, 'host.open_id')) ? {
      hostOpenId: firstString(getPath(meeting, 'host_user.open_id'), getPath(meeting, 'host.open_id')),
    } : {}),
    ...(firstString(getPath(meeting, 'host_user.user_name'), getPath(meeting, 'host_user.name'), getPath(meeting, 'host.name')) ? {
      hostName: firstString(getPath(meeting, 'host_user.user_name'), getPath(meeting, 'host_user.name'), getPath(meeting, 'host.name')),
    } : {}),
  };
}

function eventIdFromPush(data: unknown): string | undefined {
  return firstString(
    getPath(data, 'header.event_id'),
    getPath(data, 'event_id'),
    getPath(data, 'uuid'),
    getPath(data, 'event.event_id'),
    getPath(data, 'data.event.event_id'),
  );
}

function occurredAtFromPush(data: unknown): number | undefined {
  const body = eventBody(data);
  return parseTimeMs(
    getPath(data, 'header.create_time'),
    getPath(data, 'header.event_time'),
    getPath(body, 'event_time'),
    getPath(body, 'timestamp'),
    getPath(body, 'time'),
    getPath(body, 'create_time'),
  );
}

export function parseVcMeetingPushEvent(input: {
  data: unknown;
  larkAppId: string;
  kind: VcMeetingPushEventKind;
  eventType: VcMeetingPushEventType;
}): VcMeetingPushContext {
  return {
    larkAppId: input.larkAppId,
    kind: input.kind,
    eventType: input.eventType,
    ...(eventIdFromPush(input.data) ? { eventId: eventIdFromPush(input.data) } : {}),
    meeting: meetingRefFromPush(input.data),
    ...(occurredAtFromPush(input.data) !== undefined ? { occurredAtMs: occurredAtFromPush(input.data) } : {}),
    raw: input.data,
  };
}
