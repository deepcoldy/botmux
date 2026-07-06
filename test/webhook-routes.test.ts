import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyWebhookSignature, verifyWebhookToken } from '../src/dashboard/webhook-routes.js';
import type { ConnectorDefinition } from '../src/services/connector-store.js';

let server: Server | null = null;
let baseUrl = '';
let dataDir = '';
let prevDataDir: string | undefined;

async function startWebhookServer(opts: {
  createLifecycleGroup?: any;
  proxyToDaemon?: any;
} = {}): Promise<void> {
  vi.resetModules();
  const { handleWebhookRoute } = await import('../src/dashboard/webhook-routes.js');
  const proxyToDaemon = opts.proxyToDaemon ?? vi.fn(async () => ({
    status: 200,
    text: async () => JSON.stringify({ ok: true, triggerId: 'trg_upstream', action: 'delivered', target: { kind: 'turn', chatId: 'oc_new' } }),
  })) as any;
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (await handleWebhookRoute(req, res, url, {
      proxyToDaemon,
      createLifecycleGroup: opts.createLifecycleGroup,
    })) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad test server address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

function sign(secret: string, ts: string, raw: string): string {
  return createHmac('sha256', secret).update(ts).update('.').update(raw).digest('base64url');
}

async function postWebhook(connectorId: string, nonce: string, body: unknown): Promise<any> {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${baseUrl}/webhook/${encodeURIComponent(connectorId)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-botmux-timestamp': ts,
      'x-botmux-nonce': nonce,
      'x-botmux-signature': sign('secret', ts, raw),
    },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
}

async function seedNewGroupConnector(): Promise<ConnectorDefinition> {
  const { createWebhookSecret } = await import('../src/services/webhook-key.js');
  const { upsertConnector } = await import('../src/services/connector-store.js');
  const secret = createWebhookSecret('secret');
  return upsertConnector({
    id: 'conn_new_group',
    name: 'Alerts',
    enabled: true,
    verify: {
      type: 'hmac-sha256',
      secretRef: secret.ref,
      signatureHeader: 'x-botmux-signature',
      timestampHeader: 'x-botmux-timestamp',
      nonceHeader: 'x-botmux-nonce',
      toleranceSeconds: 300,
    },
    target: { mode: 'new-group', kind: 'turn', botId: 'app1', botIds: ['app1', 'app2'] },
    promptEnvelope: { sourceName: 'alerts', headerAllowlist: [], includeRawText: false, maxBodyBytes: 1024 },
    loggingPolicy: { storePayload: false, storeHeaders: false, retentionDays: 14 },
    lifecycleExtractors: { dedupKey: '$.alert.id' },
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z',
  });
}

async function seedNoDedupConnector(): Promise<ConnectorDefinition> {
  const { createWebhookSecret } = await import('../src/services/webhook-key.js');
  const { upsertConnector } = await import('../src/services/connector-store.js');
  const secret = createWebhookSecret('tok_plain_value');
  return upsertConnector({
    id: 'conn_nodedup',
    name: 'Per-event rooms',
    enabled: true,
    verify: { type: 'token', secretRef: secret.ref, signatureHeader: 'x-botmux-signature', timestampHeader: 'x-botmux-timestamp', nonceHeader: 'x-botmux-nonce', toleranceSeconds: 300 },
    target: { mode: 'new-group', kind: 'turn', botId: 'app1' },
    promptEnvelope: { sourceName: 'events', headerAllowlist: [], includeRawText: false, maxBodyBytes: 1024 },
    loggingPolicy: { storePayload: false, storeHeaders: false, retentionDays: 14 },
    lifecycleExtractors: null,
    createdAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
  });
}

async function seedTokenConnector(): Promise<ConnectorDefinition> {
  const { createWebhookSecret } = await import('../src/services/webhook-key.js');
  const { upsertConnector } = await import('../src/services/connector-store.js');
  const secret = createWebhookSecret('tok_plain_value');
  return upsertConnector({
    id: 'conn_token',
    name: 'Simple',
    enabled: true,
    verify: {
      type: 'token',
      secretRef: secret.ref,
      signatureHeader: 'x-botmux-signature',
      timestampHeader: 'x-botmux-timestamp',
      nonceHeader: 'x-botmux-nonce',
      toleranceSeconds: 300,
    },
    target: { mode: 'fixed', kind: 'turn', botId: 'app1', chatId: 'oc_fixed' },
    promptEnvelope: { sourceName: 'simple', headerAllowlist: [], includeRawText: false, maxBodyBytes: 1024 },
    loggingPolicy: { storePayload: false, storeHeaders: false, retentionDays: 14 },
    lifecycleExtractors: null,
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-webhook-route-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
  vi.restoreAllMocks();
});

describe('webhook route verification helpers', () => {
  it('verifies HMAC over timestamp dot raw-body', () => {
    const ts = '1770000000';
    const raw = Buffer.from('{"ok":true}');
    const mac = createHmac('sha256', 'secret').update(ts).update('.').update(raw).digest();
    expect(verifyWebhookSignature('secret', ts, raw, `sha256=${mac.toString('hex')}`)).toBe(true);
    expect(verifyWebhookSignature('secret', ts, raw, mac.toString('base64url'))).toBe(true);
    expect(verifyWebhookSignature('wrong', ts, raw, mac.toString('base64url'))).toBe(false);
  });

  it('verifies a bearer token with constant-time comparison', () => {
    expect(verifyWebhookToken('s3cret', 's3cret')).toBe(true);
    expect(verifyWebhookToken('s3cret', 'wrong')).toBe(false);
    expect(verifyWebhookToken('s3cret', '')).toBe(false);
    expect(verifyWebhookToken('s3cret', 's3cret-longer')).toBe(false);
  });
});

describe('webhook token mode', () => {
  it('accepts the token embedded in the path and dispatches', async () => {
    await startWebhookServer();
    await seedTokenConnector();
    const res = await fetch(`${baseUrl}/webhook/conn_token/tok_plain_value`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('rejects a wrong path token with 401', async () => {
    await startWebhookServer();
    await seedTokenConnector();
    const res = await fetch(`${baseUrl}/webhook/conn_token/wrong-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('accepts the token via query param or Authorization bearer header', async () => {
    await startWebhookServer();
    await seedTokenConnector();
    const q = await fetch(`${baseUrl}/webhook/conn_token?token=tok_plain_value`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(q.status).toBe(200);
    const h = await fetch(`${baseUrl}/webhook/conn_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok_plain_value' },
      body: '{}',
    });
    expect(h.status).toBe(200);
  });

  it('forwards rootMessageId from query, header, and payload', async () => {
    const captured: any[] = [];
    const proxyToDaemon = vi.fn(async (_appId: string, _path: string, init: RequestInit) => {
      captured.push(JSON.parse(String(init.body)));
      return { status: 200, text: async () => JSON.stringify({ ok: true, action: 'queued', target: { kind: 'turn', chatId: 'oc_fixed' } }) };
    }) as any;
    await startWebhookServer({ proxyToDaemon });
    await seedTokenConnector();

    const query = await fetch(`${baseUrl}/webhook/conn_token/tok_plain_value?rootMessageId=om_query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(query.status).toBe(200);
    const header = await fetch(`${baseUrl}/webhook/conn_token/tok_plain_value`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-botmux-root-message-id': 'om_header' },
      body: '{}',
    });
    expect(header.status).toBe(200);
    const payload = await fetch(`${baseUrl}/webhook/conn_token/tok_plain_value`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { rootMessageId: 'om_payload' } }),
    });
    expect(payload.status).toBe(200);

    expect(captured.map(x => x.target.rootMessageId)).toEqual(['om_query', 'om_header', 'om_payload']);
    expect(captured.every(x => x.target.chatId === 'oc_fixed')).toBe(true);
  });

  it('rejects when no token is presented at all', async () => {
    await startWebhookServer();
    await seedTokenConnector();
    const res = await fetch(`${baseUrl}/webhook/conn_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('passes the connector instruction onto the dispatched trigger (top-level, not in envelope)', async () => {
    const captured: any[] = [];
    const proxyToDaemon = vi.fn(async (_appId: string, _path: string, init: RequestInit) => {
      captured.push(JSON.parse(String(init.body)));
      return { status: 200, text: async () => JSON.stringify({ ok: true, action: 'delivered', target: { kind: 'turn', chatId: 'oc_fixed' } }) };
    }) as any;
    await startWebhookServer({ proxyToDaemon });
    const { createWebhookSecret } = await import('../src/services/webhook-key.js');
    const { upsertConnector } = await import('../src/services/connector-store.js');
    const secret = createWebhookSecret('tok_plain_value');
    upsertConnector({
      id: 'conn_instr',
      name: 'Instr',
      enabled: true,
      verify: { type: 'token', secretRef: secret.ref, signatureHeader: 'x-botmux-signature', timestampHeader: 'x-botmux-timestamp', nonceHeader: 'x-botmux-nonce', toleranceSeconds: 300 },
      target: { mode: 'fixed', kind: 'turn', botId: 'app1', chatId: 'oc_fixed' },
      promptEnvelope: { sourceName: 'instr', headerAllowlist: [], includeRawText: false, maxBodyBytes: 1024, instruction: 'Summarize and notify oncall.' },
      loggingPolicy: { storePayload: false, storeHeaders: false, retentionDays: 14 },
      lifecycleExtractors: null,
      createdAt: '2026-06-06T00:00:00.000Z',
      updatedAt: '2026-06-06T00:00:00.000Z',
    });
    const res = await fetch(`${baseUrl}/webhook/conn_instr/tok_plain_value`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].instruction).toBe('Summarize and notify oncall.');
    expect(captured[0].envelope.instruction).toBeUndefined();
  });

  it('wait mode does not require a dynamic chatId and forwards wait options', async () => {
    const captured: any[] = [];
    const proxyToDaemon = vi.fn(async (_appId: string, _path: string, init: RequestInit) => {
      captured.push(JSON.parse(String(init.body)));
      return { status: 200, text: async () => JSON.stringify({ ok: true, triggerId: 'trg_wait', action: 'completed', output: { content: 'answer' } }) };
    }) as any;
    await startWebhookServer({ proxyToDaemon });
    const { createWebhookSecret } = await import('../src/services/webhook-key.js');
    const { upsertConnector } = await import('../src/services/connector-store.js');
    const secret = createWebhookSecret('tok_plain_value');
    upsertConnector({
      id: 'conn_wait_dynamic',
      name: 'Wait Dynamic',
      enabled: true,
      verify: { type: 'token', secretRef: secret.ref, signatureHeader: 'x-botmux-signature', timestampHeader: 'x-botmux-timestamp', nonceHeader: 'x-botmux-nonce', toleranceSeconds: 300 },
      target: { mode: 'dynamic', kind: 'turn', botId: 'app1' },
      promptEnvelope: { sourceName: 'wait', headerAllowlist: [], includeRawText: false, maxBodyBytes: 1024 },
      loggingPolicy: { storePayload: false, storeHeaders: false, retentionDays: 14 },
      lifecycleExtractors: null,
      createdAt: '2026-06-06T00:00:00.000Z',
      updatedAt: '2026-06-06T00:00:00.000Z',
    });

    const res = await fetch(`${baseUrl}/webhook/conn_wait_dynamic/tok_plain_value?wait=1&timeoutMs=120000`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, action: 'completed', output: { content: 'answer' } });
    expect(captured).toHaveLength(1);
    expect(captured[0].target).toEqual({ kind: 'turn', botId: 'app1' });
    expect(captured[0].options).toEqual({ waitForFinalOutput: true, timeoutMs: 120000 });
  });

  it('wait mode forwards sessionId so callers can continue a headless session', async () => {
    const captured: any[] = [];
    const proxyToDaemon = vi.fn(async (_appId: string, _path: string, init: RequestInit) => {
      captured.push(JSON.parse(String(init.body)));
      return {
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          triggerId: 'trg_wait_2',
          action: 'completed',
          target: { kind: 'turn', sessionId: 'sess_headless' },
          output: { content: 'answer' },
        }),
      };
    }) as any;
    await startWebhookServer({ proxyToDaemon });
    const { createWebhookSecret } = await import('../src/services/webhook-key.js');
    const { upsertConnector } = await import('../src/services/connector-store.js');
    const secret = createWebhookSecret('tok_plain_value');
    upsertConnector({
      id: 'conn_wait_session',
      name: 'Wait Session',
      enabled: true,
      verify: { type: 'token', secretRef: secret.ref, signatureHeader: 'x-botmux-signature', timestampHeader: 'x-botmux-timestamp', nonceHeader: 'x-botmux-nonce', toleranceSeconds: 300 },
      target: { mode: 'dynamic', kind: 'turn', botId: 'app1' },
      promptEnvelope: { sourceName: 'wait', headerAllowlist: [], includeRawText: false, maxBodyBytes: 1024 },
      loggingPolicy: { storePayload: false, storeHeaders: false, retentionDays: 14 },
      lifecycleExtractors: null,
      createdAt: '2026-06-06T00:00:00.000Z',
      updatedAt: '2026-06-06T00:00:00.000Z',
    });

    const res = await fetch(`${baseUrl}/webhook/conn_wait_session/tok_plain_value?wait=1&sessionId=sess_headless`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"hello":"world"}',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, action: 'completed', output: { content: 'answer' } });
    expect(captured).toHaveLength(1);
    expect(captured[0].target).toEqual({ kind: 'turn', botId: 'app1', sessionId: 'sess_headless' });
    expect(captured[0].options).toEqual({ waitForFinalOutput: true });
  });
});

describe('webhook new-group lifecycle', () => {
  it('creates one lifecycle group and reuses it for duplicate firing events', async () => {
    const createLifecycleGroup = vi.fn(async () => ({ chatId: 'oc_new', creatorLarkAppId: 'app1' }));
    const proxyToDaemon = vi.fn(async (_appId: string, _path: string, init: RequestInit) => ({
      status: 200,
      text: async () => JSON.stringify({
        ok: true,
        triggerId: JSON.parse(String(init.body)).source.requestId,
        action: 'delivered',
        target: { kind: 'turn', chatId: JSON.parse(String(init.body)).target.chatId },
      }),
    })) as any;
    await startWebhookServer({ createLifecycleGroup, proxyToDaemon });
    await seedNewGroupConnector();

    const first = await postWebhook('conn_new_group', 'nonce_1', { alert: { id: 'cpu-high', status: 'firing' } });
    expect(first.status).toBe(200);
    expect(first.body.lifecycle).toMatchObject({ dedupKey: 'cpu-high', action: 'create', chatId: 'oc_new' });

    const second = await postWebhook('conn_new_group', 'nonce_2', { alert: { id: 'cpu-high', status: 'firing' } });
    expect(second.status).toBe(200);
    expect(second.body.lifecycle).toMatchObject({ dedupKey: 'cpu-high', action: 'reuse', chatId: 'oc_new' });
    expect(createLifecycleGroup).toHaveBeenCalledTimes(1);
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
  });

  it('rejects an event whose configured dedup key is absent from the payload', async () => {
    const createLifecycleGroup = vi.fn(async () => ({ chatId: 'oc_new', creatorLarkAppId: 'app1' }));
    await startWebhookServer({ createLifecycleGroup });
    await seedNewGroupConnector();
    const res = await postWebhook('conn_new_group', 'nonce_x', { other: 'shape' });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('lifecycle_extract_failed');
    expect(createLifecycleGroup).not.toHaveBeenCalled();
  });

  it('creates a fresh group for every event when dedup is not configured', async () => {
    const createLifecycleGroup = vi.fn(async () => ({ chatId: 'oc_fresh', creatorLarkAppId: 'app1' }));
    const proxyToDaemon = vi.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({ ok: true, action: 'delivered', target: { kind: 'turn', chatId: 'oc_fresh' } }),
    })) as any;
    await startWebhookServer({ createLifecycleGroup, proxyToDaemon });
    await seedNoDedupConnector();

    const a = await fetch(`${baseUrl}/webhook/conn_nodedup/tok_plain_value`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":1}' });
    const b = await fetch(`${baseUrl}/webhook/conn_nodedup/tok_plain_value`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":2}' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Two events → two group creations (no reuse), each dispatched.
    expect(createLifecycleGroup).toHaveBeenCalledTimes(2);
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
    expect((await a.json()).lifecycle).toMatchObject({ action: 'create', chatId: 'oc_fresh' });
  });
});
