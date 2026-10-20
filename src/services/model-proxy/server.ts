import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { authenticate, type ProxyConfig, type ProxyClient } from './config.js';
import { parseChatRequest, toInvocation, completionResponse, ProxyError } from './protocol.js';
import type { InvocationBackend } from './backend.js';

function json(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-encoding']) throw new ProxyError(415, 'unsupported_content_encoding');
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new ProxyError(415, 'expected_application_json');
  const declared = req.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 1_000_000)) throw new ProxyError(413, 'request_too_large');
  const chunks: Buffer[] = []; let size = 0;
  const timer = setTimeout(() => req.destroy(), 10_000);
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > 1_000_000) throw new ProxyError(413, 'request_too_large');
      chunks.push(Buffer.from(chunk));
    }
  } finally { clearTimeout(timer); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ProxyError(400, 'invalid_json'); }
}
function resultError(state: string, error: string | null): ProxyError {
  if (state === 'timed_out') return new ProxyError(504, 'deadline_exceeded');
  if (state === 'cancelled') return new ProxyError(409, 'invocation_cancelled');
  // Never reflect CLI stderr, raw RPC errors or credential paths to clients.
  const known = ['native_auth_missing', 'native_model_not_found', 'native_tool_isolation_unproven', 'managed_requirements_unsupported', 'interrupted_unknown_outcome', 'max_output_tokens_unsupported'];
  return new ProxyError(502, known.includes(error ?? '') ? error! : 'native_inference_failed');
}

/** HTTP translation only: execution, durable idempotency, deadlines and native
 * processes stay in the existing daemon InvocationService. */
export async function startModelProxy(input: { config: ProxyConfig; clients: ProxyClient[]; backend(bot: string): InvocationBackend }) {
  const { config, clients } = input;
  let closing = false;
  const controllers = new Set<AbortController>();
  const tasks = new Set<Promise<void>>();
  // Disconnecting one duplicate waiter must not cancel other attached clients.
  // Across gateway processes the daemon deadline remains the final lease.
  const waiters = new Map<string, { count: number; cancel: boolean; settled: boolean }>();
  const server = createServer((req, res) => {
    const task = handle(req, res).catch(() => json(res, 500, { error: { message: 'internal_error', type: 'server_error', param: null, code: 'internal_error' } }));
    tasks.add(task); void task.finally(() => tasks.delete(task));
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 128;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const controller = new AbortController(); controllers.add(controller);
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnect);
    let attachment: { id: string; key: string; backend: InvocationBackend } | undefined;
    let terminal = false;
    try {
      if (closing) throw new ProxyError(503, 'proxy_shutting_down');
      const client = authenticate(clients, req.headers.authorization);
      if (!client) throw new ProxyError(401, 'invalid_api_key');
      // No browser-origin access or CORS; this is a local authenticated SDK API.
      if (req.headers.origin) throw new ProxyError(403, 'browser_origin_not_supported');
      if (req.method === 'GET' && req.url === '/v1/models') {
        json(res, 200, { object: 'list', data: client.models.map(id => ({ id, object: 'model', created: 0, owned_by: 'botmux' })) }); return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') throw new ProxyError(404, 'endpoint_not_supported');
      const request = parseChatRequest(await body(req));
      if (!client.models.includes(request.model) || !Object.hasOwn(config.models, request.model)) throw new ProxyError(403, 'model_not_allowed', 'model');
      const route = config.models[request.model];
      const key = req.headers['idempotency-key'];
      if (key !== undefined && (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key))) throw new ProxyError(400, 'invalid_idempotency_key');
      const id = `proxy_${createHash('sha256').update(JSON.stringify([client.id, route.bot, request.model, key ?? randomUUID()])).digest('hex')}`;
      const invocation = toInvocation(request, route, id);
      const backend = input.backend(route.bot);
      const capability = await backend.capabilities();
      if (!capability.supported) throw new ProxyError(503, 'inference_profile_unsupported');
      if (request.max_completion_tokens !== undefined && !capability.maxOutputTokens) throw new ProxyError(400, 'max_completion_tokens_unsupported', 'max_completion_tokens');
      controller.signal.throwIfAborted();
      const waiterKey = `${route.bot}:${id}`;
      const group = waiters.get(waiterKey) ?? { count: 0, cancel: false, settled: false };
      group.count++; waiters.set(waiterKey, group);
      attachment = { id, key: waiterKey, backend };
      // If acceptance becomes ambiguous, reconcile/cancel this ID; never submit
      // a second inference with a newly generated ID after transport failure.
      let result = await backend.start(invocation);
      const until = Date.parse(result.startedAt) + route.deadlineMs + 15_000;
      while (result.state === 'running') {
        controller.signal.throwIfAborted();
        if (Date.now() > until) throw new ProxyError(504, 'inference_cleanup_timeout');
        await delay(100, undefined, { signal: controller.signal });
        result = await backend.get(id);
      }
      terminal = true;
      if (result.state !== 'completed') throw resultError(result.state, result.error);
      res.setHeader('x-request-id', id);
      json(res, 200, completionResponse(request, result));
    } catch (error) {
      // A conflicting duplicate never owns cancellation of the accepted call.
      if (error instanceof ProxyError && error.code === 'idempotency_conflict') terminal = true;
      const e = error instanceof ProxyError ? error : new ProxyError(controller.signal.aborted ? 499 : 502, controller.signal.aborted ? 'client_disconnected' : 'inference_transport_unavailable');
      if (!req.complete) res.setHeader('connection', 'close');
      json(res, e.status, { error: { message: e.code, type: e.status < 500 ? 'invalid_request_error' : 'server_error', param: e.param, code: e.code } });
    } finally {
      if (attachment) {
        const group = waiters.get(attachment.key)!;
        group.count--;
        if (!terminal) group.cancel = true;
        if (terminal && res.statusCode !== 409) group.settled = true;
        if (!group.count) {
          waiters.delete(attachment.key);
          if (group.cancel && !group.settled) await attachment.backend.cancel(attachment.id).catch(() => {});
        }
      }
      controllers.delete(controller); res.off('close', disconnect);
    }
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  return { server, port: (server.address() as { port: number }).port, async close() {
    closing = true;
    for (const c of controllers) c.abort();
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.allSettled([...tasks]);
    server.closeAllConnections(); await closed;
  } };
}
