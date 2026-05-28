import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyWebhookSignature } from '../src/dashboard/webhook-routes.js';
import type { ConnectorDefinition } from '../src/services/connector-store.js';

let server: Server | null = null;
let baseUrl = '';
let dataDir = '';
let prevDataDir: string | undefined;

async function startWebhookServer(opts: {
  createLifecycleGroup?: any;
  closeLifecycleGroup?: any;
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
      closeLifecycleGroup: opts.closeLifecycleGroup,
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
    lifecycleExtractors: { dedupKey: '$.alert.id', status: '$.alert.status', statusMap: { recovered: 'resolved' } },
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z',
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

  it('closes the lifecycle group on resolved events without triggering a model turn', async () => {
    const createLifecycleGroup = vi.fn(async () => ({ chatId: 'oc_new', creatorLarkAppId: 'app1' }));
    const closeLifecycleGroup = vi.fn(async () => ({ ok: true }));
    const proxyToDaemon = vi.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({ ok: true, action: 'delivered' }),
    })) as any;
    await startWebhookServer({ createLifecycleGroup, closeLifecycleGroup, proxyToDaemon });
    await seedNewGroupConnector();

    await postWebhook('conn_new_group', 'nonce_3', { alert: { id: 'disk-full', status: 'firing' } });
    const resolved = await postWebhook('conn_new_group', 'nonce_4', { alert: { id: 'disk-full', status: 'recovered' } });
    expect(resolved.status).toBe(200);
    expect(resolved.body.lifecycle).toMatchObject({ dedupKey: 'disk-full', status: 'resolved', action: 'close', chatId: 'oc_new' });
    expect(closeLifecycleGroup).toHaveBeenCalledTimes(1);
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });
});
