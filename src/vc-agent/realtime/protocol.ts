import { protoNotConfigured } from './errors.js';
import {
  decodeServerEvent,
  encodeAudioFrameEvent,
  encodeAudioUpstreamClearEvent,
  encodeSessionCloseEvent,
  encodeSessionCreateEvent,
  type EncodedRealtimeClientEvent,
} from './events.js';
import {
  decodeFrontierFrame,
  encodeFrontierFrame,
  FRONTIER_FRAME_TYPE_NORMAL,
  FRONTIER_METHOD,
  FRONTIER_SERVICE,
} from './frontier.js';
import type {
  DecodedRealtimeServerEvent,
  RealtimeVoiceAudioFormat,
  RealtimeVoiceFrame,
  RealtimeVoiceProtocol,
} from './types.js';

export function createUnavailableRealtimeVoiceProtocol(): RealtimeVoiceProtocol {
  return {
    configured: false,
    encodeSessionCreate(): Buffer {
      return protoNotConfigured('ClientEvent session.create schema is not configured.');
    },
    encodeAudioFrame(): Buffer {
      return protoNotConfigured('ClientEvent audio frame schema is not configured.');
    },
    encodeAudioUpstreamClear(): Buffer {
      return protoNotConfigured('ClientEvent audio clear schema is not configured.');
    },
    encodeSessionClose(): Buffer {
      return protoNotConfigured('ClientEvent session.close schema is not configured.');
    },
    decodeServerEvent(): undefined {
      return protoNotConfigured('ServerEvent schema is not configured.');
    },
  };
}

export function createProtoRealtimeVoiceProtocol(): RealtimeVoiceProtocol {
  let seqId = 0n;

  function wrap(event: EncodedRealtimeClientEvent): Buffer {
    seqId += 1n;
    return encodeFrontierFrame({
      seqId,
      service: FRONTIER_SERVICE,
      method: FRONTIER_METHOD,
      payload: event.payload,
      msgId: event.eventId,
      frameType: FRONTIER_FRAME_TYPE_NORMAL,
    });
  }

  return {
    configured: true,
    encodeSessionCreate(format: RealtimeVoiceAudioFormat): Buffer {
      return wrap(encodeSessionCreateEvent(format));
    },
    encodeAudioFrame(frame: RealtimeVoiceFrame, sessionId: bigint): Buffer {
      return wrap(encodeAudioFrameEvent(frame, sessionId));
    },
    encodeAudioUpstreamClear(sessionId: bigint): Buffer {
      return wrap(encodeAudioUpstreamClearEvent(sessionId));
    },
    encodeSessionClose(sessionId: bigint): Buffer {
      return wrap(encodeSessionCloseEvent(sessionId));
    },
    decodeServerEvent(data: Buffer): DecodedRealtimeServerEvent | undefined {
      const frame = decodeFrontierFrame(data);
      if (frame.skipped || !frame.payload || frame.payload.length === 0) return undefined;
      return decodeServerEvent(frame.payload);
    },
  };
}
