import { randomUUID } from 'node:crypto';
import {
  concatProtoFields,
  decodeProtoFields,
  encodeBytes,
  encodeInt64,
  encodeString,
  encodeUint32,
  fieldBigInt,
  fieldBool,
  fieldBytes,
  fieldNumber,
  fieldString,
} from './protobuf.js';
import type {
  DecodedRealtimeServerEvent,
  RealtimeVoiceAudioFormat,
  RealtimeVoiceFrame,
} from './types.js';

export const CLIENT_EVENT_SESSION_CREATE = 'session.create';
export const CLIENT_EVENT_AUDIO_UPSTREAM_APPEND = 'audio.upstream.append';
export const CLIENT_EVENT_AUDIO_UPSTREAM_CLEAR = 'audio.upstream.clear';
export const CLIENT_EVENT_SESSION_CLOSE = 'session.close';

export const SERVER_EVENT_SESSION_CREATED = 'session.created';
export const SERVER_EVENT_AUDIO_DOWNSTREAM_DELTA = 'audio.downstream.delta';
export const SERVER_EVENT_SESSION_CLOSED = 'session.closed';
export const SERVER_EVENT_ERROR = 'error';

export const CLIENT_CLOSE_REASON_USER_LEFT = 1;

export interface EncodedRealtimeClientEvent {
  eventId: string;
  payload: Buffer;
}

export interface EncodeClientEventOptions {
  eventId?: string;
  createdAt?: string;
}

function nowRfc3339(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function eventIdOrNew(eventId: string | undefined): string {
  return eventId ?? randomUUID();
}

function realtimeMimeType(format: RealtimeVoiceAudioFormat): string {
  if (format.encoding !== 'pcm_s16le') {
    throw new Error(`unsupported realtime audio encoding: ${format.encoding}`);
  }
  return 'audio/pcm';
}

function encodeAudioFormat(format: RealtimeVoiceAudioFormat): Buffer {
  return concatProtoFields([
    encodeString(1, realtimeMimeType(format)),
    encodeString(2, 's16le'),
    encodeUint32(3, format.sampleRate),
  ]);
}

function encodeMedia(format: RealtimeVoiceAudioFormat): Buffer {
  const audio = encodeAudioFormat(format);
  return concatProtoFields([
    encodeBytes(1, audio),
    encodeBytes(2, audio),
  ]);
}

function encodeSession(format: RealtimeVoiceAudioFormat): Buffer {
  return concatProtoFields([
    encodeBytes(1, encodeMedia(format)),
  ]);
}

function encodeClientEvent(fields: {
  type: string;
  eventId: string;
  sessionId?: bigint;
  createdAt: string;
  payloadField: number;
  payload: Buffer;
}): EncodedRealtimeClientEvent {
  return {
    eventId: fields.eventId,
    payload: concatProtoFields([
      encodeString(1, fields.type),
      encodeString(2, fields.eventId),
      fields.sessionId === undefined ? undefined : encodeInt64(3, fields.sessionId),
      encodeString(4, fields.createdAt),
      encodeBytes(fields.payloadField, fields.payload, { emitEmpty: true }),
    ]),
  };
}

export function encodeSessionCreateEvent(
  format: RealtimeVoiceAudioFormat,
  opts: EncodeClientEventOptions = {},
): EncodedRealtimeClientEvent {
  const eventId = eventIdOrNew(opts.eventId);
  const sessionCreate = concatProtoFields([
    encodeBytes(1, encodeSession(format)),
  ]);
  return encodeClientEvent({
    type: CLIENT_EVENT_SESSION_CREATE,
    eventId,
    createdAt: opts.createdAt ?? nowRfc3339(),
    payloadField: 10,
    payload: sessionCreate,
  });
}

export function encodeAudioFrameEvent(
  frame: RealtimeVoiceFrame,
  sessionId: bigint,
  opts: EncodeClientEventOptions = {},
): EncodedRealtimeClientEvent {
  const payload = concatProtoFields([
    encodeBytes(1, frame.data, { emitEmpty: true }),
  ]);
  return encodeClientEvent({
    type: CLIENT_EVENT_AUDIO_UPSTREAM_APPEND,
    eventId: opts.eventId ?? '',
    sessionId,
    createdAt: opts.createdAt ?? nowRfc3339(),
    payloadField: 11,
    payload,
  });
}

export function encodeAudioUpstreamClearEvent(
  sessionId: bigint,
  opts: EncodeClientEventOptions = {},
): EncodedRealtimeClientEvent {
  return encodeClientEvent({
    type: CLIENT_EVENT_AUDIO_UPSTREAM_CLEAR,
    eventId: eventIdOrNew(opts.eventId),
    sessionId,
    createdAt: opts.createdAt ?? nowRfc3339(),
    payloadField: 12,
    payload: Buffer.alloc(0),
  });
}

export function encodeSessionCloseEvent(
  sessionId: bigint,
  opts: EncodeClientEventOptions = {},
): EncodedRealtimeClientEvent {
  const payload = concatProtoFields([
    encodeUint32(1, CLIENT_CLOSE_REASON_USER_LEFT),
  ]);
  return encodeClientEvent({
    type: CLIENT_EVENT_SESSION_CLOSE,
    eventId: eventIdOrNew(opts.eventId),
    sessionId,
    createdAt: opts.createdAt ?? nowRfc3339(),
    payloadField: 13,
    payload,
  });
}

function decodeSessionCreated(payload: Buffer): { clientEventId?: string } {
  const fields = decodeProtoFields(payload);
  return { clientEventId: fieldString(fields, 1) };
}

function decodeAudioDownstreamDelta(payload: Buffer): {
  trackId?: string;
  source?: string;
  ptsMs?: bigint;
  durationMs?: number;
  delta?: Buffer;
} {
  const fields = decodeProtoFields(payload);
  return {
    trackId: fieldString(fields, 1),
    source: fieldString(fields, 2),
    ptsMs: fieldBigInt(fields, 4),
    durationMs: fieldNumber(fields, 5),
    delta: fieldBytes(fields, 6),
  };
}

function decodeSessionClosed(payload: Buffer): { sessionId?: bigint; reason?: number } {
  const fields = decodeProtoFields(payload);
  return {
    sessionId: fieldBigInt(fields, 1),
    reason: fieldNumber(fields, 2),
  };
}

function decodeError(payload: Buffer): {
  clientEventId?: string;
  code?: number;
  message?: string;
  retryable?: boolean;
} {
  const fields = decodeProtoFields(payload);
  return {
    clientEventId: fieldString(fields, 1),
    code: fieldNumber(fields, 2),
    message: fieldString(fields, 3),
    retryable: fieldBool(fields, 4),
  };
}

export function decodeServerEvent(data: Buffer): DecodedRealtimeServerEvent {
  const fields = decodeProtoFields(data);
  const type = fieldString(fields, 1) ?? '';
  const eventId = fieldString(fields, 2);
  const sessionId = fieldBigInt(fields, 3);
  const createdAt = fieldString(fields, 4);
  if (type === SERVER_EVENT_SESSION_CREATED) {
    const payload = fieldBytes(fields, 10);
    const sessionCreated = payload ? decodeSessionCreated(payload) : {};
    return {
      type,
      ...(eventId ? { eventId } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...sessionCreated,
    };
  }
  if (type === SERVER_EVENT_AUDIO_DOWNSTREAM_DELTA) {
    const payload = fieldBytes(fields, 20);
    return {
      type,
      ...(eventId ? { eventId } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(payload ? decodeAudioDownstreamDelta(payload) : {}),
    };
  }
  if (type === SERVER_EVENT_SESSION_CLOSED) {
    const payload = fieldBytes(fields, 30);
    const sessionClosed = payload ? decodeSessionClosed(payload) : {};
    return {
      type,
      ...(eventId ? { eventId } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...sessionClosed,
    };
  }
  if (type === SERVER_EVENT_ERROR) {
    const payload = fieldBytes(fields, 90);
    return {
      type,
      ...(eventId ? { eventId } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(payload ? decodeError(payload) : {}),
    };
  }
  return {
    type: 'unknown',
    ...(type ? { rawType: type } : {}),
    ...(eventId ? { eventId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}
