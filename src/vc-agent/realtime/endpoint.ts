import { getBotClient } from '../../bot-registry.js';
import { larkGet } from '../../im/lark/client.js';

export interface RealtimeEndpointResult {
  websocketUrl: string;
  raw: unknown;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export async function fetchRealtimeVoiceEndpoint(
  larkAppId: string,
  meetingId: string,
): Promise<RealtimeEndpointResult> {
  if (!meetingId.trim()) throw new Error('meetingId is required for VC realtime endpoint');
  const client = getBotClient(larkAppId);
  const res = await larkGet(client, '/open-apis/vc/v1/realtime/endpoint', {
    meeting_id: meetingId,
  });
  if (res?.code !== 0) {
    throw new Error(`failed to fetch VC realtime endpoint: ${res?.msg ?? 'unknown'} (code=${res?.code ?? '?'})`);
  }
  const websocketUrl = firstString(
    res?.data?.websocket_url,
    res?.data?.websocketUrl,
    res?.data?.ws_url,
    res?.data?.url,
  );
  if (!websocketUrl) throw new Error('VC realtime endpoint response did not contain websocket_url');
  return { websocketUrl, raw: res };
}
