import { loopbackFetch } from '../../loopback-fetch.js';
import { readPluginServiceState } from '../service-manager.js';
import { readPluginCardActionToken } from '../card-actions/auth.js';
import type { InputBinding, CapturedInput } from './store.js';

/** Reuses the installed plugin service and its existing host credential.
 * The receiver commits idempotently by input.id before returning an exact ACK. */
export async function deliverCapturedInput(binding: InputBinding, input: CapturedInput): Promise<void> {
  const service = readPluginServiceState(binding.pluginId);
  if (service?.pluginId !== binding.pluginId || service.status !== 'online'
    || !Number.isInteger(service.port) || service.port! < 1 || service.port! > 65535) throw new Error('input_capture_service_unavailable');
  const token = readPluginCardActionToken(binding.pluginId);
  const response = await loopbackFetch(`http://127.0.0.1:${service.port}/botmux/inputs/v1`, {
    method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, binding, input }),
  });
  if (!response.ok || Number(response.headers.get('content-length')) > 4096) {
    await response.body?.cancel(); throw new Error('input_capture_delivery_unconfirmed');
  }
  let bytes = 0; const chunks: Uint8Array[] = [];
  if (!response.body) throw new Error('input_capture_delivery_unconfirmed');
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength;
    if (bytes > 4096) throw new Error('input_capture_ack_too_large');
    chunks.push(chunk);
  }
  const ack = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (ack.schemaVersion !== 1 || ack.acceptedInputId !== input.id || ack.bindingId !== binding.id) {
    throw new Error('input_capture_ack_mismatch');
  }
}
