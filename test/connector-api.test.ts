import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendTriggerLog } from '../src/services/trigger-log-store.js';

let server: Server | null = null;
let baseUrl = '';
let dataDir = '';
let prevDataDir: string | undefined;

async function startConnectorApi(): Promise<void> {
  vi.resetModules();
  const { handleConnectorApi } = await import('../src/dashboard/connector-api.js');
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (await handleConnectorApi(req, res, url)) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad test server address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function json(res: Response): Promise<any> {
  return res.json();
}

async function seedLegacyWorkflowConnector(): Promise<any> {
  const { createWebhookSecret } = await import('../src/services/webhook-key.js');
  const { upsertConnector } = await import('../src/services/connector-store.js');
  const secret = createWebhookSecret('legacy-workflow-secret');
  return upsertConnector({
    id: 'conn_legacy_workflow',
    name: 'Legacy report',
    enabled: true,
    verify: {
      type: 'token',
      secretRef: secret.ref,
      signatureHeader: 'x-botmux-signature',
      timestampHeader: 'x-botmux-timestamp',
      nonceHeader: 'x-botmux-nonce',
      toleranceSeconds: 300,
    },
    target: {
      mode: 'fixed',
      kind: 'workflow',
      botId: 'app1',
      chatId: 'oc_legacy',
      workflowId: 'weekly-report',
    },
    promptEnvelope: {
      sourceName: 'legacy-report',
      headerAllowlist: [],
      includeRawText: false,
      maxBodyBytes: 1024,
    },
    loggingPolicy: { storePayload: false, storeHeaders: false, retentionDays: 14 },
    lifecycleExtractors: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  });
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-connector-api-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dataDir;
  await startConnectorApi();
});

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
  vi.restoreAllMocks();
});

describe('connector-api write routes', () => {
  it('rejects new workflow connectors without retaining a connector or generated secret', async () => {
    const res = await fetch(`${baseUrl}/api/connectors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Retired workflow target',
        target: {
          mode: 'fixed',
          kind: 'workflow',
          botId: 'app1',
          chatId: 'oc_1',
          workflowId: 'weekly-report',
        },
      }),
    });

    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({
      ok: false,
      error: 'legacy_workflow_connector_creation_disabled',
    });
    expect((await json(await fetch(`${baseUrl}/api/connectors`))).connectors).toEqual([]);
    expect((await json(await fetch(`${baseUrl}/api/webhook-secrets`))).secrets).toEqual([]);
  });

  it('does not allow an existing turn connector to become a workflow connector', async () => {
    const created = await json(await fetch(`${baseUrl}/api/connectors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Turn target',
        target: { mode: 'fixed', kind: 'turn', botId: 'app1', chatId: 'oc_1' },
      }),
    }));

    const update = await fetch(`${baseUrl}/api/connectors/${encodeURIComponent(created.connector.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { kind: 'workflow', workflowId: 'weekly-report' } }),
    });
    expect(update.status).toBe(400);
    expect(await json(update)).toMatchObject({
      ok: false,
      error: 'legacy_workflow_connector_creation_disabled',
    });
    const stored = await json(await fetch(`${baseUrl}/api/connectors/${encodeURIComponent(created.connector.id)}`));
    expect(stored.connector.target.kind).toBe('turn');
  });

  it('allows non-target maintenance on legacy workflow connectors but keeps their target immutable', async () => {
    const legacy = await seedLegacyWorkflowConnector();
    const maintained = await fetch(`${baseUrl}/api/connectors/${encodeURIComponent(legacy.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Legacy report (maintained)',
        rotateSecret: true,
        promptEnvelope: { sourceName: 'legacy-report', instruction: 'Keep this alive during migration.' },
      }),
    });
    expect(maintained.status).toBe(200);
    expect(await json(maintained)).toMatchObject({
      ok: true,
      connector: {
        name: 'Legacy report (maintained)',
        target: legacy.target,
      },
    });

    const targetChange = await fetch(`${baseUrl}/api/connectors/${encodeURIComponent(legacy.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { mode: 'fixed', chatId: 'oc_other' } }),
    });
    expect(targetChange.status).toBe(400);
    expect(await json(targetChange)).toMatchObject({
      ok: false,
      error: 'legacy_workflow_connector_target_immutable',
    });

    const toggled = await json(await fetch(`${baseUrl}/api/connectors/${encodeURIComponent(legacy.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    }));
    expect(toggled.connector.enabled).toBe(false);
    expect(toggled.connector.target).toEqual(legacy.target);
  });

  it('creates a connector with a generated one-time secret, then lists it without plaintext', async () => {
    const res = await fetch(`${baseUrl}/api/connectors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Generic alerts',
        target: { mode: 'dynamic', kind: 'turn', botId: 'app1', allowChats: ['oc_1'] },
        promptEnvelope: { sourceName: 'generic', headerAllowlist: ['x-event-id'] },
      }),
    });
    expect(res.status).toBe(201);
    const created = await json(res);
    expect(created.ok).toBe(true);
    expect(created.secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(created.connector.verify.secretRef).toMatch(/^whsec_/);
    expect(created.connector.verify.signatureHeader).toBe('x-botmux-signature');
    expect(created.connector.loggingPolicy).toMatchObject({ storePayload: true, storeHeaders: true, retentionDays: 14 });

    const list = await json(await fetch(`${baseUrl}/api/connectors`));
    expect(list.connectors).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(created.secret);

    const raw = readFileSync(join(dataDir, 'connectors.json'), 'utf-8');
    expect(raw).not.toContain(created.secret);
    expect(raw).toContain(created.connector.verify.secretRef);
  });

  it('defaults to token mode and bakes the secret into the webhook URL path', async () => {
    const created = await json(await fetch(`${baseUrl}/api/connectors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Easy alerts',
        target: { mode: 'fixed', kind: 'turn', botId: 'app1', chatId: 'oc_1' },
      }),
    }));
    expect(created.connector.verify.type).toBe('token');
    expect(created.webhookUrl).toContain(`/webhook/${created.connector.id}/${created.secret}`);
  });

  it('round-trips a trusted promptEnvelope.instruction and clears it on empty', async () => {
    const created = await json(await fetch(`${baseUrl}/api/connectors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Alert handler',
        target: { mode: 'fixed', kind: 'turn', botId: 'app1', chatId: 'oc_1' },
        promptEnvelope: { sourceName: 'alerts', instruction: '  总结告警并 @ oncall  ' },
      }),
    }));
    expect(created.connector.promptEnvelope.instruction).toBe('总结告警并 @ oncall');

    const id = created.connector.id;
    const cleared = await json(await fetch(`${baseUrl}/api/connectors/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ promptEnvelope: { sourceName: 'alerts', instruction: '' } }),
    }));
    expect(cleared.connector.promptEnvelope.instruction).toBeUndefined();
  });

  it('keeps HMAC mode when explicitly requested and omits the token from the URL', async () => {
    const created = await json(await fetch(`${baseUrl}/api/connectors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Signed alerts',
        verify: { type: 'hmac-sha256' },
        target: { mode: 'fixed', kind: 'turn', botId: 'app1', chatId: 'oc_1' },
      }),
    }));
    expect(created.connector.verify.type).toBe('hmac-sha256');
    expect(created.webhookUrl).toMatch(new RegExp(`/webhook/${created.connector.id}$`));
    expect(created.webhookUrl).not.toContain(created.secret);
  });

  it('updates enabled state and rotates an existing connector secret', async () => {
    const created = await json(await fetch(`${baseUrl}/api/connectors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Fixed alerts',
        secret: 'provided-secret',
        target: { mode: 'fixed', kind: 'turn', botId: 'app1', chatId: 'oc_1' },
      }),
    }));
    expect(created.secret).toBeUndefined();
    const id = created.connector.id;
    const ref = created.connector.verify.secretRef;

    const patch = await json(await fetch(`${baseUrl}/api/connectors/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    }));
    expect(patch.connector.enabled).toBe(false);

    const rotated = await json(await fetch(`${baseUrl}/api/connectors/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Fixed alerts v2', rotateSecret: true }),
    }));
    expect(rotated.connector.name).toBe('Fixed alerts v2');
    expect(rotated.secretRef).toBe(ref);
    expect(rotated.secret).toBeTruthy();
    expect(JSON.stringify(await json(await fetch(`${baseUrl}/api/connectors/${encodeURIComponent(id)}`)))).not.toContain(rotated.secret);
  });

  it('allows a new-group connector with NO dedup (every event → fresh group) and preserves botIds', async () => {
    const created = await json(await fetch(`${baseUrl}/api/connectors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Per-event rooms',
        target: { mode: 'new-group', kind: 'turn', botId: 'app1', botIds: ['app2'] },
      }),
    }));
    expect(created.connector.target.botIds).toEqual(['app1', 'app2']);
    expect(created.connector.lifecycleExtractors).toBeNull();
  });

  it('stores a dedup-only lifecycleExtractors (status dropped) for new-group', async () => {
    const created = await json(await fetch(`${baseUrl}/api/connectors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Auto war-room',
        target: { mode: 'new-group', kind: 'turn', botId: 'app1' },
        lifecycleExtractors: { dedupKey: '$.alert.id', status: '$.alert.state' },
      }),
    }));
    expect(created.connector.lifecycleExtractors).toEqual({ dedupKey: '$.alert.id' });
  });

  it('updates the complete webhook configuration and drops fields that do not belong to the new mode', async () => {
    const created = await json(await fetch(`${baseUrl}/api/connectors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Fixed turn',
        target: { mode: 'fixed', kind: 'turn', botId: 'app1', chatId: 'oc_old' },
        lifecycleExtractors: { dedupKey: '$.alert.id' },
      }),
    }));

    const updated = await json(await fetch(`${baseUrl}/api/connectors/${encodeURIComponent(created.connector.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Dynamic turn',
        target: { mode: 'dynamic', kind: 'turn', botId: 'app2', allowChats: ['oc_a', 'oc_b'] },
        promptEnvelope: { sourceName: 'Dynamic turn', instruction: 'summarize' },
        verify: { type: 'hmac-sha256' },
        loggingPolicy: { storePayload: false, storeHeaders: true, retentionDays: 14 },
        lifecycleExtractors: null,
      }),
    }));

    expect(updated.connector).toMatchObject({
      name: 'Dynamic turn',
      target: { mode: 'dynamic', kind: 'turn', botId: 'app2', allowChats: ['oc_a', 'oc_b'] },
      promptEnvelope: { sourceName: 'Dynamic turn', instruction: 'summarize' },
      verify: { type: 'hmac-sha256' },
      loggingPolicy: { storePayload: false },
      lifecycleExtractors: null,
    });
    expect(updated.connector.target.chatId).toBeUndefined();
    expect(updated.connector.target.workflowId).toBeUndefined();
  });

  it('manages standalone webhook secrets as metadata-only reads', async () => {
    const created = await json(await fetch(`${baseUrl}/api/webhook-secrets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }));
    expect(created.secretRef).toMatch(/^whsec_/);
    expect(created.secret).toBeTruthy();

    const listed = await json(await fetch(`${baseUrl}/api/webhook-secrets`));
    expect(listed.secrets).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(created.secret);

    const rotated = await json(await fetch(`${baseUrl}/api/webhook-secrets/${encodeURIComponent(created.secretRef)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'manual-rotation' }),
    }));
    expect(rotated.secret).toBe('manual-rotation');

    const deleted = await json(await fetch(`${baseUrl}/api/webhook-secrets/${encodeURIComponent(created.secretRef)}`, { method: 'DELETE' }));
    expect(deleted.deleted).toBe(true);
  });

  it('serves trigger log filters, connector stats, and explicit prune', async () => {
    const created = await json(await fetch(`${baseUrl}/api/connectors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Logged connector',
        target: { mode: 'dynamic', kind: 'turn', botId: 'app1' },
      }),
    }));
    const id = created.connector.id;
    appendTriggerLog({ triggerId: 'old', connectorId: id, action: 'queued', status: 'ok', createdAt: '2026-05-20T00:00:00.000Z', response: { httpStatus: 200, durationMs: 10 } }, dataDir);
    appendTriggerLog({ triggerId: 'rate', connectorId: id, action: 'failed', status: 'error', errorCode: 'rate_limited', createdAt: '2026-05-24T00:01:00.000Z', response: { httpStatus: 429, durationMs: 30 } }, dataDir);
    appendTriggerLog({ triggerId: 'sig', connectorId: 'missing', action: 'failed', status: 'error', errorCode: 'invalid_signature', createdAt: '2026-05-24T00:02:00.000Z' }, dataDir);

    const filtered = await json(await fetch(`${baseUrl}/api/trigger-logs?status=error&errorCode=rate_limited`));
    expect(filtered.logs.map((x: any) => x.triggerId)).toEqual(['rate']);

    const stats = await json(await fetch(`${baseUrl}/api/connectors/stats`));
    expect(stats.stats.find((s: any) => s.connectorId === id)).toMatchObject({
      name: 'Logged connector',
      total: 2,
      ok: 1,
      error: 1,
      lastErrorCode: 'rate_limited',
    });
    expect(stats.stats.find((s: any) => s.connectorId === 'missing')).toMatchObject({ total: 1, error: 1 });

    const summary = await json(await fetch(`${baseUrl}/api/trigger-logs/summary?connectorId=${encodeURIComponent(id)}`));
    expect(summary.summary).toMatchObject({ total: 2, ok: 1, error: 1, successRate: 50, avgDurationMs: 20, p95DurationMs: 30 });
    const page = await json(await fetch(`${baseUrl}/api/trigger-logs?connectorId=${encodeURIComponent(id)}&limit=1&offset=1`));
    expect(page).toMatchObject({ total: 2, limit: 1, offset: 1, hasMore: false, logs: [{ triggerId: 'old' }] });

    const pruned = await json(await fetch(`${baseUrl}/api/trigger-logs/prune`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxEntries: 1 }),
    }));
    expect(pruned).toMatchObject({ ok: true, before: 3, after: 1, deleted: 2 });
    const remaining = await json(await fetch(`${baseUrl}/api/trigger-logs?limit=10`));
    expect(remaining.logs.map((x: any) => x.triggerId)).toEqual(['sig']);
  });
});
