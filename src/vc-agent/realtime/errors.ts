export const REALTIME_VOICE_PROTO_NOT_CONFIGURED = 'proto_not_configured';
export const REALTIME_VOICE_TRANSPORT_NOT_CONFIGURED = 'transport_not_configured';

export class RealtimeVoiceNotConfiguredError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RealtimeVoiceNotConfiguredError';
    this.code = code;
  }
}

export function protoNotConfigured(detail: string): never {
  throw new RealtimeVoiceNotConfiguredError(
    REALTIME_VOICE_PROTO_NOT_CONFIGURED,
    `VC realtime voice protobuf is not configured: ${detail}`,
  );
}

export function transportNotConfigured(): never {
  throw new RealtimeVoiceNotConfiguredError(
    REALTIME_VOICE_TRANSPORT_NOT_CONFIGURED,
    'VC realtime voice WebSocket transport is not configured.',
  );
}
