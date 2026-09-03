/**
 * Regression net for the inbound-webhook idempotency invariants that PR #1086's
 * own suite leaves uncovered. Each case here was written against a specific
 * mutation of the shipped code and verified to go red under it — the five areas
 * are the ones a re-review flagged as highest risk:
 *
 *  1. singleflight join: `aborted` must NOT fall through to re-inspect
 *     (an aborted waiter taking over as owner re-opens double-dispatch).
 *  2. two-stage rate limiter: no double-charge, no unauthenticated bypass.
 *  3. `dispatchDidRun` classification: only a provably-forked turn keeps the key.
 *  4. HMAC ordering: verify-then-claim, so a bogus signature cannot burn a nonce.
 *  5. takeover race: when a failed owner releases the slot and N parked waiters
 *     wake together, exactly ONE may become the new owner (probe 5). Dropping the
 *     re-inspect loop makes all N dispatch — an Nx duplicate delivery.
 *
 * Of these, only #1 and #5 are NOT already caught by #1086's own suite; the rest
 * add an integration-level view of behaviour that suite checks at unit level.
 *
 * Why these live in their own file: they are invariant guards rather than feature
 * tests, and keeping the mutation each one answers next to it is what stops them
 * from being "simplified" into something that passes on broken code.
 *
 * NO PROBE HERE MAY DEPEND ON A TIMER FOR ORDERING. Two failure modes were found
 * in review and both are guarded above: a participant that never reaches the
 * server makes a concurrency probe pass VACUOUSLY, and a cancellation that lands
 * after the owner's settle makes it FALSE-RED on correct code. Use
 * `waitForRequests` for happens-before and a deferred owner failure for causal
 * order; never a sleep long enough to "probably" win.
 */
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let server: Server | null = null;
let baseUrl = '';
let dataDir = '';
let prevDataDir: string | undefined;
let proxyToDaemon: any;
let dispatchCount = 0;
/** Requests that actually REACHED the server this test. Concurrency probes below
 *  assert on this: a participant that never lands makes them pass vacuously. */
let requestsSeen = 0;

/** Yield n macrotask turns, so a queued 'close' / abort callback is delivered. */
const tick = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve));
};

/** Wait until `n` requests have reached the server, then let the handler park on
 *  its reservation. Replaces sleeping for a guessed number of milliseconds: the
 *  probes need a HAPPENED-BEFORE, and a timer only gives a hoped-for one. */
async function waitForRequests(n: number): Promise<void> {
  while (requestsSeen < n) await new Promise(resolve => setTimeout(resolve, 1));
  await tick(3);
}

async function startWebhookServer(): Promise<void> {
  vi.resetModules();
  const { handleWebhookRoute } = await import('../src/dashboard/webhook-routes.js');
  const { __testOnly_resetWebhookIdempotency } = await import('../src/services/webhook-idempotency.js');
  __testOnly_resetWebhookIdempotency();
  dispatchCount = 0;
  requestsSeen = 0;
  proxyToDaemon = vi.fn(async () => ({
    status: 200,
    text: async () => JSON.stringify({
      ok: true, triggerId: `trg_${++dispatchCount}`, action: 'queued',
      target: { kind: 'turn', chatId: 'oc_fixed' },
    }),
  }));
  server = createServer(async (req, res) => {
    requestsSeen += 1;
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (await handleWebhookRoute(req, res, url, { proxyToDaemon })) return;
    res.writeHead(404).end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
}

async function seedConnector(overrides: Record<string, unknown> = {}, id = 'conn_idem'): Promise<void> {
  const { createWebhookSecret } = await import('../src/services/webhook-key.js');
  const { upsertConnector } = await import('../src/services/connector-store.js');
  const secret = createWebhookSecret('tok_secret_value');
  upsertConnector({
    id, name: 'probe', enabled: true,
    verify: {
      type: 'token', secretRef: secret.ref,
      signatureHeader: 'x-botmux-signature', timestampHeader: 'x-botmux-timestamp',
      nonceHeader: 'x-botmux-nonce', toleranceSeconds: 300,
    },
    target: { mode: 'fixed', kind: 'turn', botId: 'app1', chatId: 'oc_fixed' },
    promptEnvelope: { sourceName: 'probe', headerAllowlist: [], includeRawText: false, maxBodyBytes: 4096 },
    loggingPolicy: { storePayload: false, storeHeaders: false, retentionDays: 14 },
    lifecycleExtractors: null,
    createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  } as any);
}

const post = (connectorId: string, body: unknown, headers: Record<string, string> = {}, query = '') => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return fetch(`${baseUrl}/webhook/${encodeURIComponent(connectorId)}/tok_secret_value${query}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw,
  }).then(async r => ({ status: r.status, body: await r.json() as any }));
};

const EVT = { event: 'mr', iid: 1 };

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-probe-'));
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

describe('probe 1: join aborted vs released (integration)', () => {
  it('a WAITER whose client aborts does NOT dispatch; the later retry dispatches fresh', async () => {
    // Owner A will FAIL (daemon_offline). Waiter B joins, then its client hangs up.
    // B must stop (aborted), not re-inspect and take over. The upstream's retry C
    // must then become the new owner and dispatch.
    // Mutation that should REDDEN this probe: drop the `aborted` early-return in
    // webhook-routes.ts so an aborted waiter falls through to re-inspect — B would
    // then take over after A fails and settle, so C would fold (ignored) instead
    // of dispatching.
    //
    // ORDERING IS THE WHOLE TEST, so none of it is left to a timer. The failure
    // this probe must not have is a FALSE RED on correct code, which happens iff
    // A's settle fires while B is still parked (its abort not yet DELIVERED):
    // A's release then wakes B, B takes over, and C folds. A `setTimeout` before
    // A's failure loses that race under CPU contention — verified: with A on a
    // 300ms timer, blocking the event loop ~250ms makes this test fail against
    // CORRECT code. A test that fires on correct code gets deleted, taking the
    // only invariant this file adds with it.
    //
    // So A's failure is a DEFERRED promise released by the test, causally after
    // the abort has been observed. Note the fix is the causal order, NOT a bigger
    // timeout: no delay value makes a race safe, and tuning one hides the bug.
    await seedConnector();
    let failOwner: () => void = () => {};
    const ownerMayFail = new Promise<void>(resolve => { failOwner = resolve; });
    let attempt = 0;
    proxyToDaemon.mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        // A: the owner. Fails only once the test releases it, so its settle can
        // never overtake B's abort.
        await ownerMayFail;
        return { status: 502, text: async () => JSON.stringify({ ok: false, errorCode: 'daemon_offline', error: 'down' }) };
      }
      // C (and anything else): a healthy daemon.
      return { status: 200, text: async () => JSON.stringify({ ok: true, triggerId: `trg_${++dispatchCount}`, action: 'queued' }) };
    });
    const key = { 'x-idempotency-key': 'evt_abort_waiter' };
    const first = post('conn_idem', EVT, key);          // A: owner, will fail
    await waitForRequests(1);
    const ac = new AbortController();
    const waiter = fetch(`${baseUrl}/webhook/conn_idem/tok_secret_value`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...key },
      body: JSON.stringify(EVT), signal: ac.signal,
    }).catch(() => null);                              // B: waiter, aborts
    // B must be PARKED on the reservation before we cancel it — otherwise the
    // probe passes vacuously (verified: with B never reaching the server, the
    // mutation above stays green).
    await waitForRequests(2);
    ac.abort();
    await waiter;                                      // abort delivered to the server
    await tick(2);                                     // ...and drained by the join
    failOwner();
    const a = await first;
    expect(a.body.ok).toBe(false);                     // A failed
    // C: upstream retry. A's failure released the slot; B (aborted) never took it.
    const c = await post('conn_idem', EVT, key);
    expect(c.body.action).toBe('queued');              // C dispatched, NOT folded
    // Landing count, not just call count: 3 requests reached the server (A, B, C).
    // The call-count assertion below cannot tell the two worlds apart on its own —
    // correct is A+C = 2, broken is A+B = 2, the SAME number — so it only means
    // anything once B is known to have taken part.
    expect(requestsSeen).toBe(3);
    // A's failed attempt + C's dispatch = 2 daemon calls; B contributed none.
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
  });
});

describe('probe 5: concurrent waiters racing to take over a released reservation', () => {
  it('exactly ONE waiter takes over when the owner fails; the rest fold', async () => {
    // The re-inspect loop in webhook-routes.ts is load-bearing, and says so:
    // "several waiters can wake together and only one may take over as `first`".
    // Nothing tested it. Mutation that should REDDEN this probe: on a 'released'
    // outcome, break out of the loop and dispatch instead of re-inspecting (the
    // exact "simplification" that comment warns against). Measured under it: all
    // 8 waiters dispatch (9 daemon calls) — an 8x duplicate delivery, which is
    // strictly worse than the single duplicate the rest of this file guards, and
    // the whole 85-test suite stays GREEN.
    //
    // Why `released` (not `ran`) is the interesting case: a successful owner is
    // already covered by the fold path. It is FAILURE that reopens the slot and
    // wakes every parked waiter at once, so "who takes over" is decided exactly
    // here — and `inspect` must hand `first` to one of them and only one.
    await seedConnector();
    const WAITERS = 8;
    let failOwner: () => void = () => {};
    const ownerMayFail = new Promise<void>(resolve => { failOwner = resolve; });
    let attempt = 0;
    proxyToDaemon.mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        // The owner. Released by the test only once every waiter is parked, so
        // the wake-up is genuinely simultaneous (a timer here would let waiters
        // arrive after the release and serialise instead of racing).
        await ownerMayFail;
        return { status: 502, text: async () => JSON.stringify({ ok: false, errorCode: 'daemon_offline', error: 'down' }) };
      }
      return { status: 200, text: async () => JSON.stringify({ ok: true, triggerId: `trg_${++dispatchCount}`, action: 'queued' }) };
    });
    const key = { 'x-idempotency-key': 'evt_takeover_race' };
    const owner = post('conn_idem', EVT, key);
    await waitForRequests(1);
    const waiters = Array.from({ length: WAITERS }, () => post('conn_idem', EVT, key));
    await waitForRequests(1 + WAITERS);   // all parked before the slot reopens
    failOwner();
    const ownerResult = await owner;
    const settled = await Promise.all(waiters);
    expect(ownerResult.body.ok).toBe(false);                       // owner failed
    const queued = settled.filter(r => r.body.action === 'queued').length;
    const folded = settled.filter(r => r.body.action === 'ignored').length;
    expect(queued).toBe(1);                                        // exactly one took over
    expect(folded).toBe(WAITERS - 1);                              // the rest folded onto it
    // Owner's failed attempt + exactly one takeover. Unlike probe 1's call count,
    // this number IS discriminating: the mutation above makes it 1 + WAITERS.
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
  });
});

describe('probe 2: two-stage rate limiter', () => {
  it('charges a dispatch exactly ONCE in the dispatch bucket (no double-charge)', async () => {
    // If a single delivery were charged twice in the dispatch bucket, the 429
    // would arrive at ceil(N/2) instead of N.
    await seedConnector({ rateLimit: { windowSeconds: 60, maxRequests: 4 } });
    const key = (i: number) => ({ 'x-idempotency-key': `evt_${i}` });
    for (let i = 0; i < 4; i++) {
      const r = await post('conn_idem', EVT, key(i));
      expect([r.status, r.body.action]).toEqual([200, 'queued']);
    }
    const fifth = await post('conn_idem', EVT, key(4));
    expect([fifth.status, fifth.body.errorCode]).toEqual([429, 'rate_limited']);
    expect(proxyToDaemon).toHaveBeenCalledTimes(4);
  });

  it('a collapsed duplicate is charged admission but NOT dispatch quota', async () => {
    // After N unique dispatches exhaust the dispatch bucket, a duplicate of an
    // earlier event must still fold (200 ignored), not be refused 429.
    await seedConnector({ rateLimit: { windowSeconds: 60, maxRequests: 2 } });
    const k0 = { 'x-idempotency-key': 'evt_dup_0' };
    const k1 = { 'x-idempotency-key': 'evt_dup_1' };
    await post('conn_idem', EVT, k0);                  // dispatch 1
    await post('conn_idem', EVT, k1);                  // dispatch 2 (bucket exhausted)
    const dup = await post('conn_idem', EVT, k0);      // folded, must not be 429
    expect([dup.status, dup.body.action]).toEqual([200, 'ignored']);
    const unique = await post('conn_idem', EVT, { 'x-idempotency-key': 'evt_dup_2' });
    expect([unique.status, unique.body.errorCode]).toEqual([429, 'rate_limited']);
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
  });

  it('every POST is metered at admission, even before auth (no bypass)', async () => {
    await seedConnector({ rateLimit: { windowSeconds: 60, maxRequests: 2 } });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`${baseUrl}/webhook/conn_idem/WRONG_TOKEN`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(EVT),
      });
      codes.push(r.status);
    }
    expect(codes).toContain(401);
    expect(codes).toContain(429);                      // admission bucket (x4 = 8) engaged
    expect(proxyToDaemon).not.toHaveBeenCalled();
  });
});

describe('probe 3: dispatchDidRun enumeration', () => {
  it('classifies every errorCode in the contract', async () => {
    const { dispatchDidRun } = await import('../src/services/webhook-idempotency.js');
    // Proven ran:
    expect(dispatchDidRun({ ok: true, triggerId: 't' })).toBe(true);
    expect(dispatchDidRun({ ok: false, errorCode: 'wait_timeout', triggerId: 't' })).toBe(true);
    // wait_timeout WITHOUT a triggerId cannot be folded onto anything -> release.
    expect(dispatchDidRun({ ok: false, errorCode: 'wait_timeout' })).toBe(false);
    // Pre-dispatch / commit-unknown -> release (fail-open):
    for (const errorCode of ['daemon_offline', 'bad_request', 'target_required', 'bot_not_found',
      'trigger_failed', 'no_output', 'idempotency_conflict', 'chat_not_allowed', 'session_not_found']) {
      expect(dispatchDidRun({ ok: false, errorCode, triggerId: 't' })).toBe(false);
    }
    // trigger_failed WITH a triggerId: the turn forked then failed. Releasing is
    // the at-least-once recovery (a failed attempt is retried), NOT a silent keep.
    expect(dispatchDidRun({ ok: false, errorCode: 'trigger_failed', triggerId: 't' })).toBe(false);
  });

  it('a turn that forked then failed (trigger_failed) releases so the retry re-runs', async () => {
    await seedConnector();
    proxyToDaemon.mockImplementation(async () => ({
      status: 502,
      text: async () => JSON.stringify({ ok: false, triggerId: `trg_${++dispatchCount}`, errorCode: 'trigger_failed', error: 'cli exited 1' }),
    }));
    const key = { 'x-idempotency-key': 'evt_fork_fail' };
    const first = await post('conn_idem', EVT, key);
    expect(first.body.errorCode).toBe('trigger_failed');
    const retry = await post('conn_idem', EVT, key);
    // The retry must dispatch again (the failed attempt is recoverable), not fold.
    expect(retry.body.errorCode).toBe('trigger_failed');
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
  });
});

describe('probe 4: HMAC verify/nonce ordering', () => {
  const sign = (ts: string, raw: string) =>
    createHmac('sha256', 'hmac_secret_value').update(ts).update('.').update(raw).digest('base64url');

  async function seedHmac(): Promise<void> {
    const { createWebhookSecret } = await import('../src/services/webhook-key.js');
    const { upsertConnector } = await import('../src/services/connector-store.js');
    const secret = createWebhookSecret('hmac_secret_value');
    upsertConnector({
      id: 'conn_hmac', name: 'signed', enabled: true,
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

  it('a bogus signature does NOT burn the nonce (order: verify then claim)', async () => {
    // Mutation that should REDDEN: swap claimNonce before verifyWebhookSignature
    // in webhook-routes.ts — the bogus request would then claim 'victim' and the
    // genuine retry would get 409 replay.
    await seedHmac();
    const raw = JSON.stringify(EVT);
    const ts = String(Math.floor(Date.now() / 1000));
    const bogus = await sendSigned(
      { 'x-botmux-timestamp': ts, 'x-botmux-nonce': 'victim', 'x-botmux-signature': 'sha256=deadbeef' }, raw);
    expect(bogus.status).toBe(401);
    const genuine = await sendSigned(
      { 'x-botmux-timestamp': ts, 'x-botmux-nonce': 'victim', 'x-botmux-signature': sign(ts, raw) }, raw);
    expect(genuine.body.action).toBe('queued');
  });

  it('a captured signature replayed with a FRESH nonce is not made worse by the new ordering', async () => {
    // The signature covers only `ts.rawBody`, NOT the nonce, so a captured
    // signature can be replayed with a fresh nonce inside the tolerance window.
    // That window is PRE-EXISTING and documented (webhook.md: "要正确支持需要给
    // nonce 也做一套绑定完整请求指纹的 reserve/settle"); this PR's verify-then-claim
    // reordering must not widen it.
    //
    // Deliberately NOT asserting `action === 'queued'` for the unkeyed replay:
    // that would pin the weakness as required behaviour, so whoever finally binds
    // the nonce into the signature would see this test go RED for FIXING it — and
    // a test that fires on correct code gets deleted. We accept either outcome
    // (dispatched today, rejected once bound) and pin only what must not change:
    // an idempotency key still folds the replay.
    await seedHmac();
    const raw = JSON.stringify(EVT);
    const ts = String(Math.floor(Date.now() / 1000));
    const captured = { 'x-botmux-timestamp': ts, 'x-botmux-nonce': 'n1', 'x-botmux-signature': sign(ts, raw) };
    await sendSigned(captured, raw);

    const replay = await sendSigned({ ...captured, 'x-botmux-nonce': 'n2' }, raw);
    expect(['queued', undefined]).toContain(replay.body.action);   // dispatched, or rejected by a future nonce binding
    expect(replay.status === 200 || replay.status === 401).toBe(true);

    // INVARIANT (this is the part that must hold): the same replay carrying an
    // idempotency key folds onto the first keyed delivery instead of running twice.
    const keyed = { ...captured, 'x-idempotency-key': 'evt_hmac_replay' };
    const first = await sendSigned({ ...keyed, 'x-botmux-nonce': 'n3' }, raw);
    expect(first.body.action).toBe('queued');
    const folded = await sendSigned({ ...keyed, 'x-botmux-nonce': 'n4' }, raw);
    expect(folded.body.action).toBe('ignored');
  });
});
