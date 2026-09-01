/**
 * Inbound-webhook idempotency (duplicate-delivery suppression).
 *
 * The scenario these tests encode is a real production report: an at-least-once
 * upstream (EventHub) re-POSTed the SAME Codebase event ~33.5s later; both
 * deliveries were dispatched and each opened its own CLI session. The upstream
 * already sends a unique id in `x-idempotency-key`; botmux ignored it.
 */
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import type { ConnectorDefinition } from '../src/services/connector-store.js';

let server: Server | null = null;
let baseUrl = '';
let dataDir = '';
let prevDataDir: string | undefined;
let proxyToDaemon: any;

/** Every dispatch gets a distinct triggerId so a test can prove a suppressed
 *  retry echoes the FIRST delivery's id rather than a freshly minted one. */
let dispatchCount = 0;

async function startWebhookServer(): Promise<void> {
  vi.resetModules();
  const { handleWebhookRoute } = await import('../src/dashboard/webhook-routes.js');
  const { __testOnly_resetWebhookIdempotency } = await import('../src/services/webhook-idempotency.js');
  __testOnly_resetWebhookIdempotency();
  dispatchCount = 0;
  proxyToDaemon = vi.fn(async () => ({
    status: 200,
    text: async () => JSON.stringify({
      ok: true,
      triggerId: `trg_${++dispatchCount}`,
      action: 'queued',
      target: { kind: 'turn', chatId: 'oc_fixed' },
    }),
  }));
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (await handleWebhookRoute(req, res, url, {
      proxyToDaemon,
      createLifecycleGroup: async () => ({ chatId: 'oc_created' }),
    })) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad test server address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

/** Token-mode connector on the FIXED-group path — exactly the shape from the
 *  report (`verify.type=token`, `target.mode=fixed`, no lifecycle dedup). */
async function seedConnector(
  overrides: Partial<ConnectorDefinition> = {},
  id = 'conn_idem',
): Promise<ConnectorDefinition> {
  const { createWebhookSecret } = await import('../src/services/webhook-key.js');
  const { upsertConnector } = await import('../src/services/connector-store.js');
  const secret = createWebhookSecret('tok_secret_value');
  return upsertConnector({
    id,
    name: 'Codebase MR review',
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
    promptEnvelope: { sourceName: 'codebase', headerAllowlist: [], includeRawText: false, maxBodyBytes: 4096 },
    loggingPolicy: { storePayload: false, storeHeaders: false, retentionDays: 14 },
    lifecycleExtractors: null,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  });
}

async function post(
  connectorId: string,
  body: unknown,
  headers: Record<string, string> = {},
  query = '',
): Promise<{ status: number; body: any }> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(
    `${baseUrl}/webhook/${encodeURIComponent(connectorId)}/tok_secret_value${query}`,
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw },
  );
  return { status: res.status, body: await res.json() };
}

const MR_EVENT = {
  event: 'merge_request',
  object_attributes: { iid: 2227, title: 'fix: something', state: 'opened' },
};

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-webhook-idem-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dataDir;
  await startWebhookServer();
});

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
  vi.restoreAllMocks();
});

describe('inbound webhook idempotency', () => {
  it('suppresses a re-delivered event carrying the same x-idempotency-key (the reported bug)', async () => {
    await seedConnector();
    const key = { 'x-idempotency-key': 'rec_1787211053887175595_2228_aedff72c' };

    const first = await post('conn_idem', MR_EVENT, key);
    const retry = await post('conn_idem', MR_EVENT, key);

    // First delivery dispatches and says so.
    expect(first.status).toBe(200);
    expect(first.body.action).toBe('queued');
    expect(first.body.idempotency).toEqual({ key: 'rec_1787211053887175595_2228_aedff72c', action: 'accepted' });

    // The retry is collapsed: 2xx (an at-least-once sender must not keep
    // retrying), no new dispatch, and it points at the turn that really ran.
    expect(retry.status).toBe(200);
    expect(retry.body.ok).toBe(true);
    expect(retry.body.action).toBe('ignored');
    expect(retry.body.idempotency).toMatchObject({ action: 'duplicate', firstTriggerId: 'trg_1' });

    // The whole point: exactly ONE session was created, not two.
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['x-botmux-idempotency-key', 'botmux control-plane spelling'],
    ['idempotency-key', 'IETF draft / Stripe spelling'],
    ['x-idempotency-key', 'the header EventHub sends today'],
  ])('honours %s (%s)', async header => {
    await seedConnector();
    await post('conn_idem', MR_EVENT, { [header]: 'evt_same' });
    const retry = await post('conn_idem', MR_EVENT, { [header]: 'evt_same' });
    expect(retry.body.action).toBe('ignored');
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });

  it('prefers the botmux-specific header when several are present', async () => {
    await seedConnector();
    const first = await post('conn_idem', MR_EVENT, {
      'x-botmux-idempotency-key': 'from_botmux',
      'idempotency-key': 'from_ietf',
      'x-idempotency-key': 'from_vendor',
    });
    expect(first.body.idempotency.key).toBe('from_botmux');
  });

  it('accepts the key from a query parameter for senders that cannot set headers', async () => {
    await seedConnector();
    await post('conn_idem', MR_EVENT, {}, '?idempotencyKey=evt_q');
    const retry = await post('conn_idem', MR_EVENT, {}, '?idempotencyKey=evt_q');
    expect(retry.body.action).toBe('ignored');
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });

  it('accepts the key from a configured body path', async () => {
    await seedConnector({ idempotency: { keyPath: '$.object_attributes.iid' } });
    await post('conn_idem', MR_EVENT);
    const retry = await post('conn_idem', MR_EVENT);
    expect(retry.body.action).toBe('ignored');
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });

  it('treats distinct keys as distinct events', async () => {
    await seedConnector();
    await post('conn_idem', MR_EVENT, { 'x-idempotency-key': 'evt_a' });
    await post('conn_idem', MR_EVENT, { 'x-idempotency-key': 'evt_b' });
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
  });

  it('changes nothing when no key is presented (existing connectors keep today\'s behaviour)', async () => {
    await seedConnector();
    const first = await post('conn_idem', MR_EVENT);
    const second = await post('conn_idem', MR_EVENT);
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
    expect(first.body.idempotency).toBeUndefined();
    expect(second.body.idempotency).toBeUndefined();
  });

  it('FAILS OPEN when the same key arrives with a different body', async () => {
    await seedConnector();
    const key = { 'x-idempotency-key': 'reused_key' };
    await post('conn_idem', MR_EVENT, key);
    const other = await post('conn_idem', { ...MR_EVENT, object_attributes: { iid: 9999 } }, key);

    // A key that is not a reliable unique id must not silently swallow what may
    // be a genuinely different production event.
    expect(other.status).toBe(200);
    expect(other.body.action).toBe('queued');
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
  });

  it('keeps the first record after a conflicting body, so the good key still dedupes', async () => {
    await seedConnector();
    const key = { 'x-idempotency-key': 'reused_key' };
    await post('conn_idem', MR_EVENT, key);
    await post('conn_idem', { junk: true }, key);      // conflict → dispatched, not stamped
    const realRetry = await post('conn_idem', MR_EVENT, key);
    expect(realRetry.body.action).toBe('ignored');
    expect(realRetry.body.idempotency.firstTriggerId).toBe('trg_1');
  });

  it('does not let a FAILED dispatch consume the key (the sender\'s retry must still work)', async () => {
    await seedConnector();
    proxyToDaemon.mockImplementationOnce(async () => ({
      status: 502,
      text: async () => JSON.stringify({ ok: false, errorCode: 'daemon_offline', error: 'daemon offline' }),
    }));
    const key = { 'x-idempotency-key': 'evt_retry_after_failure' };

    const failed = await post('conn_idem', MR_EVENT, key);
    expect(failed.body.ok).toBe(false);

    // at-least-once retry after a failure is the recovery path — it must run.
    const retry = await post('conn_idem', MR_EVENT, key);
    expect(retry.body.ok).toBe(true);
    expect(retry.body.action).toBe('queued');
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
  });

  it('does not let an unauthenticated request burn the key', async () => {
    await seedConnector();
    const raw = JSON.stringify(MR_EVENT);
    const bad = await fetch(`${baseUrl}/webhook/conn_idem/WRONG_TOKEN`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-idempotency-key': 'evt_auth' },
      body: raw,
    });
    expect(bad.status).toBe(401);

    const good = await post('conn_idem', MR_EVENT, { 'x-idempotency-key': 'evt_auth' });
    expect(good.body.action).toBe('queued');
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });

  it('does not let a dryRun consume the key', async () => {
    await seedConnector();
    const key = { 'x-idempotency-key': 'evt_dry' };
    await post('conn_idem', MR_EVENT, key, '?dryRun=1');
    const real = await post('conn_idem', MR_EVENT, key);
    expect(real.body.action).toBe('queued');
  });

  it('scopes keys per connector so two upstreams cannot collide', async () => {
    await seedConnector({}, 'conn_a');
    await seedConnector({}, 'conn_b');
    await post('conn_a', MR_EVENT, { 'x-idempotency-key': 'shared_id' });
    const onB = await post('conn_b', MR_EVENT, { 'x-idempotency-key': 'shared_id' });
    expect(onB.body.action).toBe('queued');
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
  });

  it('can be disabled per connector for an upstream that reuses ids', async () => {
    await seedConnector({ idempotency: { disabled: true } });
    const key = { 'x-idempotency-key': 'evt_same' };
    await post('conn_idem', MR_EVENT, key);
    const retry = await post('conn_idem', MR_EVENT, key);
    expect(retry.body.action).toBe('queued');
    expect(retry.body.idempotency).toBeUndefined();
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
  });

  it('suppresses duplicates on the new-group path too (no second group is created)', async () => {
    const createLifecycleGroup = vi.fn(async () => ({ chatId: 'oc_created' }));
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    vi.resetModules();
    const { handleWebhookRoute } = await import('../src/dashboard/webhook-routes.js');
    const { __testOnly_resetWebhookIdempotency } = await import('../src/services/webhook-idempotency.js');
    __testOnly_resetWebhookIdempotency();
    dispatchCount = 0;
    proxyToDaemon = vi.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({ ok: true, triggerId: `trg_${++dispatchCount}`, action: 'queued' }),
    }));
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (await handleWebhookRoute(req, res, url, { proxyToDaemon, createLifecycleGroup })) return;
      res.writeHead(404).end();
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as any;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    await seedConnector({ target: { mode: 'new-group', kind: 'turn', botId: 'app1' } }, 'conn_ng');
    const key = { 'x-idempotency-key': 'evt_ng' };
    await post('conn_ng', MR_EVENT, key);
    const retry = await post('conn_ng', MR_EVENT, key);

    expect(retry.body.action).toBe('ignored');
    expect(createLifecycleGroup).toHaveBeenCalledTimes(1);
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });

  it('ignores an over-long key instead of trusting a truncated one', async () => {
    await seedConnector();
    const huge = { 'x-idempotency-key': 'x'.repeat(201) };
    await post('conn_idem', MR_EVENT, huge);
    const retry = await post('conn_idem', MR_EVENT, huge);
    expect(retry.body.action).toBe('queued');
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
  });

  it('collapses CONCURRENT duplicates that overlap while the first is still in flight', async () => {
    await seedConnector();
    // A slow dispatch is the very condition that makes an upstream time out and
    // retry — so the retry OVERLAPS the original rather than following it.
    proxyToDaemon.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 150));
      return {
        status: 200,
        text: async () => JSON.stringify({ ok: true, triggerId: `trg_${++dispatchCount}`, action: 'queued' }),
      };
    });
    const key = { 'x-idempotency-key': 'evt_concurrent' };

    const [a, b] = await Promise.all([
      post('conn_idem', MR_EVENT, key),
      post('conn_idem', MR_EVENT, key),
    ]);

    const actions = [a.body.action, b.body.action].sort();
    expect(actions).toEqual(['ignored', 'queued']);
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });

  it('still dedupes after a successful dispatch settles (reservation is not released by response close)', async () => {
    await seedConnector();
    const key = { 'x-idempotency-key': 'evt_settle' };
    const first = await post('conn_idem', MR_EVENT, key);
    expect(first.body.action).toBe('queued');
    // Give the response 'close' hook a chance to run before retrying — a naive
    // release-on-close would have dropped the record here.
    await new Promise(r => setTimeout(r, 50));
    const retry = await post('conn_idem', MR_EVENT, key);
    expect(retry.body.action).toBe('ignored');
    expect(retry.body.idempotency.firstTriggerId).toBe('trg_1');
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });

  it('releases the reservation when the request never reaches dispatch (bad target)', async () => {
    // A dynamic-mode connector with no chatId fails AFTER the key was reserved.
    await seedConnector({ target: { mode: 'dynamic', kind: 'turn', botId: 'app1' } }, 'conn_dyn');
    const key = { 'x-idempotency-key': 'evt_no_target' };

    const failed = await post('conn_dyn', MR_EVENT, key);
    expect(failed.status).toBe(400);
    await new Promise(r => setTimeout(r, 50));

    // The sender fixes the call and retries the SAME event: it must run, not be
    // swallowed as a "duplicate" of a delivery that never happened.
    const fixed = await post('conn_dyn', MR_EVENT, key, '?chatId=oc_target');
    expect(fixed.body.action).toBe('queued');
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });
  it('does not release the reservation when the CLIENT ABORTS mid-dispatch', async () => {
    // The upstream aborting on timeout is the very thing that provokes the retry
    // this feature collapses — and 'close' fires on abort while the dispatch is
    // still in flight. Releasing there made the retry dispatch a SECOND time.
    await seedConnector();
    proxyToDaemon.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 400));
      return {
        status: 200,
        text: async () => JSON.stringify({ ok: true, triggerId: `trg_${++dispatchCount}`, action: 'queued' }),
      };
    });
    const headers = { 'content-type': 'application/json', 'x-idempotency-key': 'evt_abort' };
    const raw = JSON.stringify(MR_EVENT);

    const ac = new AbortController();
    const inflight = fetch(`${baseUrl}/webhook/conn_idem/tok_secret_value`, {
      method: 'POST', headers, body: raw, signal: ac.signal,
    }).catch(() => null);
    setTimeout(() => ac.abort(), 80);
    await inflight;
    // Let the abandoned dispatch finish and any close handler run.
    await new Promise(r => setTimeout(r, 600));
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);   // the turn really ran

    // The sender believes delivery failed and retries the same event: it must be
    // recognised as a duplicate of the turn that is already running/ran.
    const retry = await post('conn_idem', MR_EVENT, { 'x-idempotency-key': 'evt_abort' });
    expect(retry.body.action).toBe('ignored');
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });

  it('does not release the reservation when the client aborts during a PRE-DISPATCH await', async () => {
    // Found in review: 'close' fires when the client hangs up, which is NOT when
    // the handler stops. Parked on a pre-effect await (template mention identity
    // resolution here), the handler resumes AFTER the release and still dispatches
    // — so the retry and the original both ran. Reproduces on a plain fixed-group
    // connector, so it is not a new-group-only symptom.
    await seedConnector({
      topicMessage: {
        mode: 'template',
        text: 'alert {{mention who}}',
        extractors: { who: { path: 'owner', kind: 'mention' } },
      },
    }, 'conn_tpl');
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    vi.resetModules();
    const { handleWebhookRoute } = await import('../src/dashboard/webhook-routes.js');
    const { __testOnly_resetWebhookIdempotency } = await import('../src/services/webhook-idempotency.js');
    __testOnly_resetWebhookIdempotency();
    dispatchCount = 0;
    proxyToDaemon = vi.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({ ok: true, triggerId: `trg_${++dispatchCount}`, action: 'queued' }),
    }));
    const resolveMentionIdentities = async (_bot: string, ids: string[]) => {
      await new Promise(r => setTimeout(r, 400));           // slow PRE-dispatch await
      return new Map(ids.map(id => [id, 'ou_resolved']));
    };
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (await handleWebhookRoute(req, res, url, { proxyToDaemon, resolveMentionIdentities } as any)) return;
      res.writeHead(404).end();
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;

    const headers = { 'content-type': 'application/json', 'x-idempotency-key': 'evt_pre' };
    const raw = JSON.stringify({ ...MR_EVENT, owner: 'ou_someone' });
    const ac = new AbortController();
    const first = fetch(`${baseUrl}/webhook/conn_tpl/tok_secret_value`, {
      method: 'POST', headers, body: raw, signal: ac.signal,
    }).catch(() => null);
    setTimeout(() => ac.abort(), 80);
    await first;
    await new Promise(r => setTimeout(r, 250));             // still inside the await

    const retry = await fetch(`${baseUrl}/webhook/conn_tpl/tok_secret_value`, {
      method: 'POST', headers, body: raw,
    }).then(r => r.json() as any);
    await new Promise(r => setTimeout(r, 1200));            // let both handlers finish
    // The invariant is ONE dispatch for one event. The retry joins the still-parked
    // original as a singleflight waiter and is answered from its real outcome, so
    // `ignored` here means "folded onto the run that happened" — not a lost event.
    expect(dispatchCount).toBe(1);
    expect(retry.action).toBe('ignored');
  });

  it('suppresses a duplicate BEFORE the rate limiter can answer 429', async () => {
    // Found in review: the limiter ran first, so a duplicate got 429 — which an
    // at-least-once sender reads as "not delivered" and retries, hitting the
    // limiter again. The suppression path was unreachable exactly when needed.
    await seedConnector({ rateLimit: { windowSeconds: 60, maxRequests: 1 } });
    const key = { 'x-idempotency-key': 'evt_rl' };
    const first = await post('conn_idem', MR_EVENT, key);
    const dup = await post('conn_idem', MR_EVENT, key);
    expect(first.body.action).toBe('queued');
    expect([dup.status, dup.body.action]).toEqual([200, 'ignored']);
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });

  describe('HMAC mode', () => {
    const sign = (ts: string, raw: string) =>
      createHmac('sha256', 'hmac_secret_value').update(ts).update('.').update(raw).digest('base64url');

    async function seedHmac(): Promise<void> {
      const { createWebhookSecret } = await import('../src/services/webhook-key.js');
      const { upsertConnector } = await import('../src/services/connector-store.js');
      const secret = createWebhookSecret('hmac_secret_value');
      upsertConnector({
        id: 'conn_hmac', name: 'Signed', enabled: true,
        verify: {
          type: 'hmac-sha256', secretRef: secret.ref,
          signatureHeader: 'x-botmux-signature', timestampHeader: 'x-botmux-timestamp',
          nonceHeader: 'x-botmux-nonce', toleranceSeconds: 300,
        },
        target: { mode: 'fixed', kind: 'turn', botId: 'app1', chatId: 'oc_fixed' },
        promptEnvelope: { sourceName: 'signed', headerAllowlist: [], includeRawText: false, maxBodyBytes: 99999 },
        loggingPolicy: { storePayload: false, storeHeaders: false, retentionDays: 14 },
        lifecycleExtractors: null,
        createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
      } as any);
    }
    const sendSigned = (headers: Record<string, string>, raw: string) =>
      fetch(`${baseUrl}/webhook/conn_hmac`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw,
      }).then(async r => ({ status: r.status, body: await r.json() as any }));

    it('answers 409 for a VERBATIM signed retry (documented HMAC limitation)', async () => {
      // Scope decision, not an oversight: the nonce is claimed before the
      // idempotency gate, so an identical signed replay is a nonce replay. Folding
      // it would require deferring the claim, which only works when the first
      // delivery SUCCEEDS — on failure the nonce is spent and the retry that should
      // take over is refused (see the next test). Doing it properly needs a second
      // reserve/settle machine for nonces, CAS-bound to a full dispatch-affecting
      // fingerprint, because the signature covers only `timestamp.rawBody` and not
      // the idempotency key / query / routing headers. Out of scope here; HMAC
      // senders must re-sign with a fresh nonce per retry (documented).
      await seedHmac();
      const raw = JSON.stringify(MR_EVENT);
      const ts = String(Math.floor(Date.now() / 1000));
      const headers = {
        'x-botmux-timestamp': ts,
        'x-botmux-nonce': 'gateway-fixed-nonce',
        'x-botmux-signature': sign(ts, raw),
        'x-idempotency-key': 'rec_hmac_1',
      };
      const first = await sendSigned(headers, raw);
      const retry = await sendSigned(headers, raw);
      expect(first.body.action).toBe('queued');
      expect([retry.status, retry.body.errorCode]).toEqual([409, 'replay']);
      expect(proxyToDaemon).toHaveBeenCalledTimes(1);
    });

    it('folds a retry that mints a fresh nonce and re-signs (the supported shape)', async () => {
      // What the documentation asks HMAC senders to do — and it collapses properly.
      await seedHmac();
      const raw = JSON.stringify(MR_EVENT);
      const key = 'rec_hmac_2';
      const send = (nonce: string) => {
        const ts = String(Math.floor(Date.now() / 1000));
        return sendSigned({
          'x-botmux-timestamp': ts, 'x-botmux-nonce': nonce,
          'x-botmux-signature': sign(ts, raw), 'x-idempotency-key': key,
        }, raw);
      };
      const first = await send('nonce-1');
      const retry = await send('nonce-2');
      expect(first.body.action).toBe('queued');
      expect([retry.status, retry.body.action]).toEqual([200, 'ignored']);
      expect(proxyToDaemon).toHaveBeenCalledTimes(1);
    });

    it('still rejects a nonce reused for a DISTINCT delivery', async () => {
      // Deferring the claim must not weaken replay protection: anything that gets
      // past the idempotency gate is a distinct delivery, so a repeated nonce there
      // is a real replay.
      await seedHmac();
      const ts = String(Math.floor(Date.now() / 1000));
      const a = JSON.stringify({ evt: 'a' });
      const b = JSON.stringify({ evt: 'b' });
      await sendSigned({ 'x-botmux-timestamp': ts, 'x-botmux-nonce': 'shared', 'x-botmux-signature': sign(ts, a) }, a);
      const reuse = await sendSigned({ 'x-botmux-timestamp': ts, 'x-botmux-nonce': 'shared', 'x-botmux-signature': sign(ts, b) }, b);
      expect([reuse.status, reuse.body.errorCode]).toEqual([409, 'replay']);
    });

    it('does not let a bogus signature burn a nonce', async () => {
      // Verifying the signature before claiming also closes the old ordering hole:
      // an unauthenticated caller could write into the (uncapped) nonce map, and
      // could poison a nonce the real sender was about to use.
      await seedHmac();
      const raw = JSON.stringify(MR_EVENT);
      const ts = String(Math.floor(Date.now() / 1000));
      const bogus = await sendSigned(
        { 'x-botmux-timestamp': ts, 'x-botmux-nonce': 'victim', 'x-botmux-signature': 'sha256=deadbeef' }, raw);
      expect(bogus.status).toBe(401);
      const genuine = await sendSigned(
        { 'x-botmux-timestamp': ts, 'x-botmux-nonce': 'victim', 'x-botmux-signature': sign(ts, raw) }, raw);
      expect(genuine.body.action).toBe('queued');
    });

    it('still rejects a tampered body carrying a captured signature', async () => {
      await seedHmac();
      const raw = JSON.stringify(MR_EVENT);
      const ts = String(Math.floor(Date.now() / 1000));
      const headers = { 'x-botmux-timestamp': ts, 'x-botmux-nonce': 'n1', 'x-botmux-signature': sign(ts, raw) };
      await sendSigned(headers, raw);
      const tampered = await sendSigned(headers, JSON.stringify({ ...MR_EVENT, injected: true }));
      expect([tampered.status, tampered.body.errorCode]).toEqual([401, 'invalid_signature']);
    });
  });

  it('still meters unauthenticated floods at the edge (rate-limit split)', async () => {
    // Moving the single limiter behind verification (so a collapsed duplicate is
    // never answered 429) silently removed entry abuse protection: a bad-token
    // flood returned 401 forever with the limiter never engaging, allowing unbounded
    // body reads, audit writes, and — in HMAC mode — nonce-map growth before the
    // signature is even checked. The edge admission bucket restores that bound.
    await seedConnector({ rateLimit: { windowSeconds: 60, maxRequests: 2 } });
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) {
      const res = await fetch(`${baseUrl}/webhook/conn_idem/WRONG_TOKEN`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(MR_EVENT),
      });
      codes.push(res.status);
    }
    expect(codes).toContain(401);            // rejected on credentials
    expect(codes).toContain(429);            // and eventually throttled at the edge
    expect(proxyToDaemon).not.toHaveBeenCalled();
  });

  it('answers a retryable 503 when too many duplicates of one event pile up', async () => {
    // Over the waiter bound we must not answer 2xx (nothing is confirmed) and must
    // not spin re-inspecting. A retryable 503 tells the sender to come back.
    await seedConnector();
    const store = await import('../src/services/webhook-idempotency.js');
    proxyToDaemon.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 800));
      return {
        status: 200,
        text: async () => JSON.stringify({ ok: true, triggerId: `trg_${++dispatchCount}`, action: 'queued' }),
      };
    });
    const key = { 'x-idempotency-key': 'evt_flood' };
    const total = store.WEBHOOK_IDEMPOTENCY_MAX_WAITERS + 10;
    const all = await Promise.all(
      Array.from({ length: total }, () => post('conn_idem', MR_EVENT, key)),
    );
    const queued = all.filter(r => r.body.action === 'queued').length;
    const ignored = all.filter(r => r.body.action === 'ignored').length;
    const overloaded = all.filter(r => r.status === 503).length;
    expect(queued).toBe(1);                       // exactly one real dispatch
    expect(overloaded).toBe(total - 1 - ignored); // the rest are told to retry
    expect(overloaded).toBeGreaterThan(0);
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });

  it('does not ACK an in-flight duplicate when the first delivery then FAILS', async () => {
    // Found in review: answering 200 ignored before the first outcome is known can
    // stop the sender retrying; if that first delivery then fails, the event is
    // lost. The waiter must learn the real outcome instead.
    await seedConnector();
    proxyToDaemon.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 300));
      return { status: 502, text: async () => JSON.stringify({ ok: false, errorCode: 'daemon_offline', error: 'down' }) };
    });
    const key = { 'x-idempotency-key': 'evt_inflight_fail' };
    const first = post('conn_idem', MR_EVENT, key);
    await new Promise(r => setTimeout(r, 80));
    const dup = post('conn_idem', MR_EVENT, key);
    const [f, d] = await Promise.all([first, dup]);
    expect(f.body.ok).toBe(false);
    // The duplicate must NOT be told the event was handled.
    expect(d.body.action).not.toBe('ignored');
    expect(d.body.ok).toBe(false);
  });

  it('folds a retry after wait_timeout instead of running the turn twice', async () => {
    // Found in review: waitForSessionFinalOutput dispatches FIRST and then waits,
    // so a 504 wait_timeout describes a turn that is already running. Releasing
    // the key on !ok let the sender's retry dispatch it a second time.
    await seedConnector();
    proxyToDaemon.mockImplementation(async () => ({
      status: 504,
      text: async () => JSON.stringify({
        ok: false, triggerId: `trg_${++dispatchCount}`,
        errorCode: 'wait_timeout', error: 'wait timeout after 1000ms',
      }),
    }));
    const key = { 'x-idempotency-key': 'evt_wait' };
    const first = await post('conn_idem', MR_EVENT, key, '?wait=1');
    expect([first.status, first.body.errorCode]).toEqual([504, 'wait_timeout']);
    const retry = await post('conn_idem', MR_EVENT, key, '?wait=1');
    expect(retry.body.action).toBe('ignored');
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });

  it('keeps a successful dispatch settled even if the audit log write fails', async () => {
    // Found in review: appendTriggerLog runs AFTER the daemon accepted the turn, so
    // a disk-full/EIO throw turned a proven success into a 5xx and released the key
    // — the sender then retried a turn that had really queued.
    await seedConnector();
    const logStore = await import('../src/services/trigger-log-store.js');
    const spy = vi.spyOn(logStore, 'appendTriggerLog').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    try {
      const key = { 'x-idempotency-key': 'evt_log' };
      const first = await post('conn_idem', MR_EVENT, key);
      expect(first.body.action).toBe('queued');
      const retry = await post('conn_idem', MR_EVENT, key);
      expect(retry.body.action).toBe('ignored');
      expect(proxyToDaemon).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not create a second group when the client aborts during group creation', async () => {
    // Found in review: new-group's side effect (creating the Feishu group) happens
    // before any dispatch, so a release at 'close' let the retry create ANOTHER
    // group and dispatch again.
    const createLifecycleGroup = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 400));
      return { chatId: `oc_created_${createLifecycleGroup.mock.calls.length}` };
    });
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    vi.resetModules();
    const { handleWebhookRoute } = await import('../src/dashboard/webhook-routes.js');
    const { __testOnly_resetWebhookIdempotency } = await import('../src/services/webhook-idempotency.js');
    __testOnly_resetWebhookIdempotency();
    dispatchCount = 0;
    proxyToDaemon = vi.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({ ok: true, triggerId: `trg_${++dispatchCount}`, action: 'queued' }),
    }));
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (await handleWebhookRoute(req, res, url, { proxyToDaemon, createLifecycleGroup })) return;
      res.writeHead(404).end();
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
    await seedConnector({ target: { mode: 'new-group', kind: 'turn', botId: 'app1' } }, 'conn_ng2');

    const headers = { 'content-type': 'application/json', 'x-idempotency-key': 'evt_ng_abort' };
    const raw = JSON.stringify(MR_EVENT);
    const ac = new AbortController();
    const first = fetch(`${baseUrl}/webhook/conn_ng2/tok_secret_value`, {
      method: 'POST', headers, body: raw, signal: ac.signal,
    }).catch(() => null);
    setTimeout(() => ac.abort(), 100);
    await first;
    await new Promise(r => setTimeout(r, 700));
    const retry = await fetch(`${baseUrl}/webhook/conn_ng2/tok_secret_value`, {
      method: 'POST', headers, body: raw,
    }).then(r => r.json() as any);
    await new Promise(r => setTimeout(r, 700));
    expect([retry.action, createLifecycleGroup.mock.calls.length, dispatchCount]).toEqual(['ignored', 1, 1]);
  });
});

/**
 * Store-level tests with INJECTED time. The route-level suite above cannot reach
 * these branches: they only trigger after the 10-minute TTL or under the 10k
 * entry cap, neither of which an HTTP test can drive.
 */
describe('webhook idempotency store (time-dependent branches)', () => {
  const body = Buffer.from('{"evt":"mr","iid":2227}');
  /** Reserve and return the token (tests must settle with the right one). */
  const reserve = (store: any, key: string, at: number): number => {
    const d = store.inspectWebhookIdempotency('c', key, body, at);
    expect(d.kind).toBe('first');
    return d.token;
  };

  it('forgets a settled key once its TTL elapses', async () => {
    const store = await import('../src/services/webhook-idempotency.js');
    store.__testOnly_resetWebhookIdempotency();
    const t0 = 1_000_000;
    const token = reserve(store, 'k', t0);
    store.settleWebhookIdempotency('c', 'k', token, 'trg_1', t0);
    expect(store.inspectWebhookIdempotency('c', 'k', body, t0 + 1000).kind).toBe('duplicate');
    // Past the window the sender is entitled to a fresh delivery again.
    expect(
      store.inspectWebhookIdempotency('c', 'k', body, t0 + store.WEBHOOK_IDEMPOTENCY_TTL_MS + 1).kind,
    ).toBe('first');
  });

  it('shields an in-flight reservation for the whole window (a slow dispatch may still be running)', async () => {
    const store = await import('../src/services/webhook-idempotency.js');
    store.__testOnly_resetWebhookIdempotency();
    const t0 = 1_000_000;
    reserve(store, 'k', t0);
    // Inside the window the outcome is unknown, so a duplicate must be told to
    // WAIT (in_flight), never ACKed and never allowed to dispatch on its own.
    expect(store.inspectWebhookIdempotency('c', 'k', body, t0 + 300_000).kind).toBe('in_flight');
    expect(store.inspectWebhookIdempotency('c', 'k', body, t0 + 599_000).kind).toBe('in_flight');
  });

  it('reclaims a reservation whose dispatch never settled, instead of wedging the key forever', async () => {
    const store = await import('../src/services/webhook-idempotency.js');
    store.__testOnly_resetWebhookIdempotency();
    const t0 = 1_000_000;
    reserve(store, 'k', t0);   // never settled (wedged daemon / no timeout on the IPC call)
    // Holding it forever would permanently swallow every retry of this event. This
    // is a deliberate fail-open trade past the window, NOT a claim that the
    // dispatch is provably dead (the dashboard->daemon call carries no timeout).
    expect(
      store.inspectWebhookIdempotency('c', 'k', body, t0 + store.WEBHOOK_IDEMPOTENCY_TTL_MS + 1).kind,
    ).toBe('first');
  });

  it('reclaims an expired entry even when an earlier-inserted entry is still live', async () => {
    const store = await import('../src/services/webhook-idempotency.js');
    store.__testOnly_resetWebhookIdempotency();
    const t0 = 1_000_000;
    // A successful settle EXTENDS expiresAt without moving the Map entry, so
    // insertion order and expiry order diverge: A is inserted first but expires
    // last. A sweep that stopped at the first live entry left B stuck past its own
    // deadline (found in review).
    const tokenA = reserve(store, 'A', t0);
    reserve(store, 'B', t0 + 1000);                       // never settled
    store.settleWebhookIdempotency('c', 'A', tokenA, 'trg_A', t0 + store.WEBHOOK_IDEMPOTENCY_TTL_MS - 1000);
    const t = t0 + 1000 + store.WEBHOOK_IDEMPOTENCY_TTL_MS + 1;
    expect(store.inspectWebhookIdempotency('c', 'B', body, t).kind).toBe('first');
  });

  it('does not let an alert storm preempt an in-flight reservation via the size cap', async () => {
    const store = await import('../src/services/webhook-idempotency.js');
    store.__testOnly_resetWebhookIdempotency();
    const t0 = 1_000_000;
    // Volume is not evidence that a dispatch finished, so pressure-based eviction
    // must skip in-flight entries (otherwise a storm reopens double-dispatch).
    reserve(store, 'held', t0);
    for (let i = 0; i < store.WEBHOOK_IDEMPOTENCY_MAX_ENTRIES + 50; i++) {
      const t = store.inspectWebhookIdempotency('c', `k${i}`, body, t0);
      if (t.kind === 'first') store.settleWebhookIdempotency('c', `k${i}`, t.token, `trg_${i}`, t0);
    }
    expect(store.inspectWebhookIdempotency('c', 'held', body, t0).kind).toBe('in_flight');
  });

  it('ignores a settle whose token no longer owns the slot (ABA)', async () => {
    const store = await import('../src/services/webhook-idempotency.js');
    store.__testOnly_resetWebhookIdempotency();
    const t0 = 1_000_000;
    const tokenA = reserve(store, 'k', t0);                       // A wedges
    const tLate = t0 + store.WEBHOOK_IDEMPOTENCY_TTL_MS + 1;
    const tokenB = reserve(store, 'k', tLate);                    // slot reclaimed -> B

    // A's late FAILURE must not delete B's reservation (that would let a
    // concurrent duplicate of B's event dispatch a second time).
    store.settleWebhookIdempotency('c', 'k', tokenA, undefined, tLate);
    expect(store.inspectWebhookIdempotency('c', 'k', body, tLate).kind).toBe('in_flight');

    // A's late SUCCESS must not relabel B either: a duplicate must be pointed at
    // B's turn, not at the stale predecessor's.
    store.settleWebhookIdempotency('c', 'k', tokenA, 'trg_STALE_A', tLate);
    store.settleWebhookIdempotency('c', 'k', tokenB, 'trg_B', tLate);
    const hit = store.inspectWebhookIdempotency('c', 'k', body, tLate);
    expect(hit.kind).toBe('duplicate');
    expect(hit.kind === 'duplicate' && hit.firstTriggerId).toBe('trg_B');
  });

  it('a settled key survives a later release attempt (settle is idempotent)', async () => {
    const store = await import('../src/services/webhook-idempotency.js');
    store.__testOnly_resetWebhookIdempotency();
    const t0 = 1_000_000;
    const token = reserve(store, 'k', t0);
    store.settleWebhookIdempotency('c', 'k', token, 'trg_1', t0);
    // The handler's `finally` may still fire a release after a successful commit;
    // it must be a no-op rather than dropping the dedup record.
    store.settleWebhookIdempotency('c', 'k', token, undefined, t0);
    const hit = store.inspectWebhookIdempotency('c', 'k', body, t0);
    expect(hit.kind).toBe('duplicate');
    expect(hit.kind === 'duplicate' && hit.firstTriggerId).toBe('trg_1');
  });

  it('wakes a singleflight waiter with the real outcome', async () => {
    const store = await import('../src/services/webhook-idempotency.js');
    store.__testOnly_resetWebhookIdempotency();
    const t0 = 1_000_000;

    // Success is handed to the waiter, with the turn's id to fold onto.
    const tokenA = reserve(store, 'ok', t0);
    const waitOk = store.inspectWebhookIdempotency('c', 'ok', body, t0);
    expect(waitOk.kind).toBe('in_flight');
    const okPromise = waitOk.kind === 'in_flight' ? waitOk.join() : Promise.resolve(undefined);
    store.settleWebhookIdempotency('c', 'ok', tokenA, 'trg_ok', t0);
    await expect(okPromise).resolves.toEqual({ kind: 'ran', triggerId: 'trg_ok' });

    // Failure is handed to the waiter too — it must not hang until its own client
    // gives up, and must learn the event did NOT run so it can take over.
    const tokenB = reserve(store, 'bad', t0);
    const waitBad = store.inspectWebhookIdempotency('c', 'bad', body, t0);
    const badPromise = waitBad.kind === 'in_flight' ? waitBad.join() : Promise.resolve(undefined);
    store.settleWebhookIdempotency('c', 'bad', tokenB, undefined, t0);
    await expect(badPromise).resolves.toEqual({ kind: 'released' });
  });

  it('resolves waiters when the owner reservation is reclaimed by expiry', async () => {
    const store = await import('../src/services/webhook-idempotency.js');
    store.__testOnly_resetWebhookIdempotency();
    const t0 = 1_000_000;
    reserve(store, 'k', t0);                                  // owner wedges forever
    const waiting = store.inspectWebhookIdempotency('c', 'k', body, t0);
    expect(waiting.kind).toBe('in_flight');
    const joined = waiting.kind === 'in_flight' ? waiting.join() : Promise.resolve(undefined);
    // A later inspect past the window sweeps the wedged owner; its waiters must be
    // released (eviction is lazy, so nothing else would ever wake them).
    store.inspectWebhookIdempotency('c', 'k', body, t0 + store.WEBHOOK_IDEMPOTENCY_TTL_MS + 1);
    await expect(joined).resolves.toEqual({ kind: 'released' });
  });

  it('reports an ABORTED wait distinctly from a released one', async () => {
    const store = await import('../src/services/webhook-idempotency.js');
    store.__testOnly_resetWebhookIdempotency();
    const t0 = 1_000_000;
    reserve(store, 'k', t0);
    const waiting = store.inspectWebhookIdempotency('c', 'k', body, t0);
    const ac = new AbortController();
    const joined = waiting.kind === 'in_flight' ? waiting.join(ac.signal) : Promise.resolve(undefined);
    ac.abort();
    // Must NOT be 'released': that would send a disconnected request back to
    // re-inspect, where it could become the new owner and dispatch — the opposite
    // of cancelling it.
    await expect(joined).resolves.toEqual({ kind: 'aborted' });
  });

  it('answers `overloaded` rather than faking a release once too many waiters are parked', async () => {
    const store = await import('../src/services/webhook-idempotency.js');
    store.__testOnly_resetWebhookIdempotency();
    const t0 = 1_000_000;
    const token = reserve(store, 'k', t0);
    const parked: Array<Promise<unknown>> = [];
    for (let i = 0; i < store.WEBHOOK_IDEMPOTENCY_MAX_WAITERS; i++) {
      const d = store.inspectWebhookIdempotency('c', 'k', body, t0);
      expect(d.kind).toBe('in_flight');
      if (d.kind === 'in_flight') parked.push(d.join());
    }
    // Past the bound the verdict is explicit. A fake 'released' here would send the
    // caller straight back into inspect, still over the bound — a hot loop.
    expect(store.inspectWebhookIdempotency('c', 'k', body, t0).kind).toBe('overloaded');
    store.settleWebhookIdempotency('c', 'k', token, 'trg_1', t0);
    for (const p of await Promise.all(parked)) expect(p).toEqual({ kind: 'ran', triggerId: 'trg_1' });
  });

  it('keeps the entry cap a REAL bound even when every reservation is in flight', async () => {
    const store = await import('../src/services/webhook-idempotency.js');
    store.__testOnly_resetWebhookIdempotency();
    const t0 = 1_000_000;
    let firsts = 0;
    let disabled = 0;
    // `evict` refuses to preempt in-flight entries, so without a capacity check the
    // window would grow past the cap without limit under a distinct-key flood.
    for (let i = 0; i < store.WEBHOOK_IDEMPOTENCY_MAX_ENTRIES + 25; i++) {
      const d = store.inspectWebhookIdempotency('c', `k${i}`, body, t0);
      if (d.kind === 'first') firsts++;
      else if (d.kind === 'disabled') disabled++;
    }
    // At capacity we stop TRACKING new keys (degraded dedup) rather than dropping a
    // live reservation — the delivery still goes out exactly as an unkeyed one.
    expect([firsts, disabled]).toEqual([store.WEBHOOK_IDEMPOTENCY_MAX_ENTRIES, 25]);
  });

  it('trims settled entries so new keys stay trackable in steady state', async () => {
    const store = await import('../src/services/webhook-idempotency.js');
    store.__testOnly_resetWebhookIdempotency();
    const t0 = 1_000_000;
    for (let i = 0; i < store.WEBHOOK_IDEMPOTENCY_MAX_ENTRIES + 200; i++) {
      const d = store.inspectWebhookIdempotency('c', `s${i}`, body, t0);
      if (d.kind === 'first') store.settleWebhookIdempotency('c', `s${i}`, d.token, `trg_${i}`, t0);
    }
    expect(store.inspectWebhookIdempotency('c', 'brand_new', body, t0).kind).toBe('first');
  });
});

describe('dispatch outcome classification (dispatchDidRun)', () => {
  it('treats wait_timeout WITH a triggerId as "the turn ran"', async () => {
    const { dispatchDidRun } = await import('../src/services/webhook-idempotency.js');
    // waitForSessionFinalOutput dispatches the turn FIRST and only then waits, so a
    // 504 wait_timeout describes a turn that is already running. Releasing the key
    // there let an upstream retry the 504 and run the event twice.
    expect(dispatchDidRun({ ok: false, errorCode: 'wait_timeout', triggerId: 'trg_1' })).toBe(true);
  });

  it('does not claim a run for pre-dispatch or unknown failures', async () => {
    const { dispatchDidRun } = await import('../src/services/webhook-idempotency.js');
    expect(dispatchDidRun({ ok: true, triggerId: 'trg_1' })).toBe(true);
    expect(dispatchDidRun({ ok: false, errorCode: 'daemon_offline' })).toBe(false);
    expect(dispatchDidRun({ ok: false, errorCode: 'target_required' })).toBe(false);
    expect(dispatchDidRun({ ok: false, errorCode: 'trigger_failed', triggerId: 'trg_1' })).toBe(false);
    // No triggerId ⇒ nothing to fold a retry onto, so it cannot be proven.
    expect(dispatchDidRun({ ok: false, errorCode: 'wait_timeout' })).toBe(false);
  });
});
