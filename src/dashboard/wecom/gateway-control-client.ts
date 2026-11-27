import { createDaemonClient } from '../daemon-internal-client.js';
import {
  WECOM_GATEWAY_CONTROL_PATHS,
  type WecomControlResult,
  type WecomSessionControlRequest,
} from '../../im/wecom/contract/gateway-control.js';

/**
 * Dashboard-side clients of the gateway control server. Each request is signed
 * with the dashboard secret and sent to the loopback port the gateway
 * published in its runtime record; `secret` overrides the key in tests.
 */

export async function requestWecomSessionControl(input: WecomSessionControlRequest & {
  port: number;
}, secret?: string): Promise<WecomControlResult> {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error('invalid_control_port');
  }
  const client = createDaemonClient({ dashboardUrl: `http://127.0.0.1:${input.port}`, appId: 'wecom-host-control', secret, timeoutMs: 30000 });
  const { port: _port, ...body } = input;
  const response = await client.request({ method: 'POST', path: WECOM_GATEWAY_CONTROL_PATHS.sessionControl, body });
  return response.body as WecomControlResult;
}
