import { findOnlineDaemon } from '../../utils/daemon-discovery.js';
import { fetchDaemonIpc } from '../../core/daemon-ipc-auth.js';
import type { InvocationRequest, InvocationResult } from '../constrained-invocation/contract.js';
import { ProxyError } from './protocol.js';

export interface InvocationBackend {
  capabilities(): Promise<{ supported: boolean; maxOutputTokens?: boolean }>;
  start(request: InvocationRequest): Promise<InvocationResult>;
  get(id: string): Promise<InvocationResult>;
  cancel(id: string): Promise<InvocationResult | undefined>;
}
const base = '/api/headless/invocations';
export function ipcInvocationBackend(bot: string, dataDir: string): InvocationBackend {
  const daemon = findOnlineDaemon(bot, dataDir);
  // Configuration is a stable ID, never a fuzzy name or arbitrary address.
  if (!daemon || daemon.larkAppId !== bot) throw new ProxyError(503, 'inference_profile_offline');
  const call = async (path: string, method = 'GET', body?: unknown) => {
    let response: Response;
    try {
      response = await fetchDaemonIpc(daemon.ipcPort, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000) });
    } catch { throw new ProxyError(503, 'inference_transport_unavailable'); }
    let value: any;
    try { value = await response.json(); } catch { throw new ProxyError(502, 'invalid_inference_response'); }
    if (!response.ok) {
      if (value.error === 'idempotency_conflict') throw new ProxyError(409, 'idempotency_conflict');
      if (value.error === 'invocation_capacity_exceeded') throw new ProxyError(429, 'inference_capacity_exceeded');
      if (value.error === 'constrained_capability_unsupported') throw new ProxyError(503, 'inference_profile_unsupported');
      throw new ProxyError(502, 'inference_request_failed');
    }
    return value;
  };
  return {
    capabilities: async () => (await call(`${base}/capabilities`)).capability,
    start: async request => (await call(base, 'POST', request)).result,
    get: async id => (await call(`${base}/${encodeURIComponent(id)}`)).result,
    cancel: async id => (await call(`${base}/${encodeURIComponent(id)}/cancel`, 'POST')).result,
  };
}
