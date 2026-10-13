import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { deliverCapturedInput } from '../src/core/plugins/input-capture/gateway.js';
import { createInputCaptureRuntime } from '../src/core/plugins/input-capture/runtime.js';
import { createInputCaptureStore, type InputBinding, type CapturedInput } from '../src/core/plugins/input-capture/store.js';
import { readPluginServiceState } from '../src/core/plugins/service-manager.js';
import { readPluginCardActionToken } from '../src/core/plugins/card-actions/auth.js';
import type { PluginServiceState } from '../src/core/plugins/types.js';

// Only registry/credential lookup is mocked; delivery uses the real loopback HTTP transport.
vi.mock('../src/core/plugins/service-manager.js', () => ({ readPluginServiceState: vi.fn() }));
vi.mock('../src/core/plugins/card-actions/auth.js', () => ({ readPluginCardActionToken: vi.fn() }));

const binding: InputBinding = { id: 'binding-original', revision: 1, active: true, larkAppId: 'cli_capture',
  sessionId: 's', chatId: 'oc_chat', anchor: 'om_root', sourceAnchor: 'om_root', ownerOpenId: 'ou_owner',
  pluginId: 'example', requestId: 'request-original', providerRef: 'opaque', createdAt: '2026-01-01T00:00:00Z' };
const input: CapturedInput = { id: 'input-original', bindingId: binding.id, sequence: 1, messageId: 'om_reply',
  senderOpenId: binding.ownerOpenId, text: 'inspect only', receivedAt: binding.createdAt, delivery: 'pending' };
const ack = { schemaVersion: 1, acceptedInputId: input.id, bindingId: binding.id };
const online = (port: number | undefined): PluginServiceState => ({
  pluginId: binding.pluginId, status: 'online', port, updatedAt: binding.createdAt,
});
const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readPluginCardActionToken).mockReturnValue('synthetic-capture-token');
});
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function serve(handler: RequestListener) {
  const server = createServer(handler);
  cleanups.push(() => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  vi.mocked(readPluginServiceState).mockReturnValue(online((server.address() as AddressInfo).port));
}

it.each([
  undefined,
  { ...online(1234), status: 'stopped' },
  { ...online(1234), pluginId: 'another-plugin' },
  ...[undefined, 0, -1, 65536, 1.5, NaN, '1234' as unknown as number].map(online),
])('rejects unavailable or invalid service state before reading credentials: %j', async state => {
  vi.mocked(readPluginServiceState).mockReturnValue(state);
  await expect(deliverCapturedInput(binding, input)).rejects.toThrow('input_capture_service_unavailable');
  expect(readPluginServiceState).toHaveBeenCalledWith(binding.pluginId);
  expect(readPluginCardActionToken).not.toHaveBeenCalled();
});

it('posts the original binding/input and host credential to the registered service', async () => {
  const requests: unknown[] = [];
  await serve(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization,
      contentType: req.headers['content-type'], body: JSON.parse(body) });
    res.end(JSON.stringify(ack));
  });
  await expect(deliverCapturedInput(binding, input)).resolves.toBeUndefined();
  expect(requests).toEqual([{ method: 'POST', path: '/botmux/inputs/v1',
    authorization: 'Bearer synthetic-capture-token', contentType: 'application/json',
    body: { schemaVersion: 1, binding, input } }]);
  expect(readPluginCardActionToken).toHaveBeenCalledWith(binding.pluginId);
});

it.each([302, 401, 503, 204])('rejects non-success or bodyless HTTP %s even with an ACK body', async status => {
  await serve((_req, res) => { res.writeHead(status); res.end(JSON.stringify(ack)); });
  await expect(deliverCapturedInput(binding, input)).rejects.toThrow('input_capture_delivery_unconfirmed');
});

it.each([false, true])('enforces the 4096-byte ACK boundary with chunked=%s', async chunked => {
  let bytes = 4096;
  await serve((_req, res) => {
    const body = JSON.stringify(ack).padEnd(bytes, ' ');
    res.setHeader(chunked ? 'transfer-encoding' : 'content-length', chunked ? 'chunked' : Buffer.byteLength(body));
    res.end(body);
  });
  await expect(deliverCapturedInput(binding, input)).resolves.toBeUndefined();
  bytes = 4097;
  await expect(deliverCapturedInput(binding, input)).rejects.toThrow(
    chunked ? 'input_capture_ack_too_large' : 'input_capture_delivery_unconfirmed');
});

it.each([{ schemaVersion: 2 }, { acceptedInputId: 'another-input' }, { bindingId: 'another-binding' }])(
  'rejects a mismatched ACK: %j', async patch => {
    await serve((_req, res) => res.end(JSON.stringify({ ...ack, ...patch })));
    await expect(deliverCapturedInput(binding, input)).rejects.toThrow('input_capture_ack_mismatch');
  });

it('rejects malformed JSON instead of confirming delivery', async () => {
  await serve((_req, res) => res.end('not JSON'));
  await expect(deliverCapturedInput(binding, input)).rejects.toBeInstanceOf(SyntaxError);
});

it.each([false, true])('times out after five seconds when headersSent=%s and the ACK never completes', async headersSent => {
  await serve((_req, res) => { if (headersSent) { res.writeHead(200); res.write('{'); } });
  await expect(deliverCapturedInput(binding, input)).rejects.toMatchObject({ name: 'TimeoutError' });
}, 10_000);

it('keeps an unconfirmed input pending and retries its original ID through the gateway', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-gateway-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = createInputCaptureStore(dir, binding.larkAppId);
  const received: string[] = [];
  let confirm = false;
  await serve(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const delivery = JSON.parse(body);
    received.push(delivery.input.id);
    res.end(JSON.stringify({ schemaVersion: 1, bindingId: delivery.binding.id,
      acceptedInputId: confirm ? delivery.input.id : 'another-input' }));
  });
  const runtime = createInputCaptureRuntime({ larkAppId: binding.larkAppId, store,
    session: () => ({ ...binding }), pluginEnabled: id => id === binding.pluginId,
    canTalk: () => true, deliver: deliverCapturedInput });
  cleanups.push(() => runtime.stop());
  runtime.register(binding.sessionId, { pluginId: binding.pluginId, requestId: binding.requestId, providerRef: binding.providerRef });
  runtime.capture({ messageId: input.messageId, chatId: binding.chatId, anchor: binding.anchor,
    senderOpenId: binding.ownerOpenId, text: input.text, botSender: false });
  await runtime.drain();
  const original = store.read().inputs[0];
  expect(original.delivery).toBe('pending');
  confirm = true;
  await runtime.drain();
  expect(received).toEqual([original.id, original.id]);
  expect(store.read().inputs).toEqual([{ ...original, delivery: 'acknowledged', acknowledgedAt: expect.any(String) }]);
});
