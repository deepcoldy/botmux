import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FeedbackWebhookSecretStore,
  startFeedbackWebhookDispatcher,
  classifyWebhookResponse,
  computeRetryDelay,
  dispatchWebhookAttempt,
  validateWebhookDestination,
} from '../src/services/feedback-webhook-dispatcher.js';
import { parseBotConfigsFromText } from '../src/bot-registry.js';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';
import { beginFeedbackMaintenance, freezeFeedbackSource } from '../src/services/feedback-maintenance.js';
import { closeFeedbackStorage, getFeedbackStorage } from '../src/services/feedback-storage.js';
import { readFeedbackStorageConfig } from '../src/services/feedback-storage-config.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function storeWithOneOutboxRow(prefix: string): Promise<SkillFeedbackStore> {
  const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir);
  const db = await SkillFeedbackStore.open(dir);
  db.recordTurnTerminal({ botAppId: 'app', sessionId: 's', turnId: 't', status: 'completed' });
  db.recordTurnDelivery({
    botAppId: 'app', sessionId: 's', turnId: 't', platform: 'lark', platformAppId: 'app', platformMessageId: 'm',
    content: 'answer', cardMode: 'card', status: 'delivered',
    webhookDestinations: [{ id: 'd', enabled: true, url: 'https://hook.example/x', eventTypes: ['turn.completed'], secretRef: 'secret', timeoutMs: 1000 }],
  });
  return db;
}

describe('feedback webhook destination and secret safety', () => {
  it('normalizes destinations while preserving secret references only', () => {
    const [bot] = parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'app', larkAppSecret: 'app-secret', cliId: 'claude-code', feedbackWebhooks: { destinations: [{ id: ' audit ', enabled: true, url: 'https://hook.example/x', eventTypes: ['turn.completed'], secretRef: 'feedback-webhook:abc', timeoutMs: 1200 }] } }]));
    expect(bot.feedbackWebhooks?.destinations).toEqual([{ id: 'audit', enabled: true, url: 'https://hook.example/x', eventTypes: ['turn.completed'], secretRef: 'feedback-webhook:abc', timeoutMs: 1200 }]);
    expect(JSON.stringify(bot.feedbackWebhooks)).not.toContain('app-secret');
  });

  it('stores secret material atomically in a host-only file and returns refs only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-secret-')); dirs.push(dir);
    const store = new FeedbackWebhookSecretStore(dir);
    const ref = store.put('destination', 'super-secret');
    expect(ref).toMatch(/^feedback-webhook:/);
    expect(store.get(ref)).toBe('super-secret');
    const path = join(dir, 'feedback-webhook-secrets.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).not.toContain('destination"');
  });

  it.each([
    'http://example.com/hook', 'https://user:pass@example.com/hook', 'https://example.com/hook#fragment',
    'https://127.0.0.1/hook', 'https://[::1]/hook', 'https://10.0.0.1/hook', 'https://169.254.1.1/hook',
    'https://100.64.0.1/hook', 'https://192.0.2.1/hook', 'https://[::ffff:127.0.0.1]/hook',
  ])('rejects unsafe URL %s', async (url) => {
    await expect(validateWebhookDestination(url)).rejects.toThrow(/webhook_destination/);
  });

  it('fails closed when any DNS answer is private, unless global admin policy permits it', async () => {
    const lookup = async () => [{ address: '203.0.113.9', family: 4 as const }, { address: '10.0.0.2', family: 4 as const }];
    await expect(validateWebhookDestination('https://hook.example/h', { lookup })).rejects.toThrow('webhook_destination_address_blocked');
    await expect(validateWebhookDestination('https://hook.example/h', { lookup, allowPrivateNetworks: true })).resolves.toMatchObject({ hostname: 'hook.example' });
  });

  it.each([
    '0:0:0:0:0:0:0:0',
    '0:0:0:0:0:0:0:1',
  ])('rejects expanded IPv6 loopback/unspecified DNS answer %s', async (address) => {
    const lookup = async () => [{ address, family: 6 as const }];
    await expect(validateWebhookDestination('https://hook.example/h', { lookup }))
      .rejects.toThrow('webhook_destination_address_blocked');
  });
});

describe('feedback webhook attempt contract', () => {
  it('keeps a recurring lazy opening single-flight and isolates its failure during bounded stop', async () => {
    vi.useFakeTimers();
    let rejectOpening!: (error: Error) => void;
    const opening = new Promise<SkillFeedbackStore>((_, reject) => { rejectOpening = reject; });
    let calls = 0;
    const dispatcher = startFeedbackWebhookDispatcher({
      store: () => ++calls === 1 ? Promise.reject(new Error('bootstrap-failed')) : opening,
      readSecret: () => 'secret', intervalMs: 50,
    });
    try {
      await dispatcher.ready;
      await vi.advanceTimersByTimeAsync(1050);
      expect(calls).toBe(2);
      const stopping = dispatcher.stop(100);
      rejectOpening(new Error('recurring-open-failed'));
      await expect(stopping).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally { rejectOpening(new Error('test-finished')); vi.useRealTimers(); }
  });

  it('returns immediately from stop(0) while a recurring storage opening remains pending', async () => {
    vi.useFakeTimers();
    const opening = deferred<SkillFeedbackStore>();
    let calls = 0;
    const dispatcher = startFeedbackWebhookDispatcher({
      store: () => ++calls === 1 ? Promise.reject(new Error('bootstrap-failed')) : opening.promise,
      readSecret: () => 'secret', intervalMs: 50,
    });
    try {
      await dispatcher.ready;
      await vi.advanceTimersByTimeAsync(50);
      expect(calls).toBe(2);
      await dispatcher.stop(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { opening.resolve(undefined as unknown as SkillFeedbackStore); vi.useRealTimers(); }
  });

  it('releases a claim that completes after hard stop without dispatching or inventing an unknown outcome', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-late-claim-')); dirs.push(dir);
    const db = await SkillFeedbackStore.open(dir);
    const blocker = await SkillFeedbackStore.open(dir);
    db.recordTurnTerminal({ botAppId: 'app', sessionId: 's', turnId: 't', status: 'completed' });
    db.recordTurnDelivery({
      botAppId: 'app', sessionId: 's', turnId: 't', platform: 'lark', platformAppId: 'app', platformMessageId: 'm',
      content: 'answer', cardMode: 'card', status: 'delivered',
      webhookDestinations: [{ id: 'd', enabled: true, url: 'https://hook.example/x', eventTypes: ['turn.completed'], secretRef: 'secret' }],
    });
    const claimed = deferred<void>(), release = deferred<void>();
    const original = db.tryClaimFeedbackOutbox.bind(db);
    vi.spyOn(db, 'tryClaimFeedbackOutbox').mockImplementation(async input => {
      const result = original(input);
      (blocker as any).db.exec('BEGIN IMMEDIATE');
      claimed.resolve();
      await release.promise;
      return result;
    });
    const dispatcher = startFeedbackWebhookDispatcher({
      store: db, readSecret: () => 'secret',
      dispatch: async () => ({ kind: 'retry' as const, error: 'webhook_outcome_unknown' }),
    });
    try {
      await claimed.promise;
      await dispatcher.stop(0);
      release.resolve();
      await dispatcher.ready;
      (blocker as any).db.exec('COMMIT');
      db.resetExpiredFeedbackOutboxClaims(Date.now() + 1000, 0);
      expect(db.listFeedbackOutbox()).toMatchObject([{ status: 'pending', lastError: 'webhook_stopped_before_request' }]);
      await beginFeedbackMaintenance(dir, 'late-claim');
      await expect(freezeFeedbackSource(dir, 'late-claim')).resolves.toBeUndefined();
    } finally {
      release.resolve(); await dispatcher.stop(0);
      try { (blocker as any).db.exec('ROLLBACK'); } catch {}
      blocker.close(); db.close();
    }
  });

  it('does not send when request admission is busy and recovers the claim as known-unsent', async () => {
    const db = await storeWithOneOutboxRow('botmux-webhook-admission-busy-');
    const dispatch = vi.fn(async () => ({ kind: 'delivered' as const, status: 200 }));
    vi.spyOn(db, 'tryStartFeedbackOutboxRequest').mockReturnValue({ done: false, busy: true });
    const dispatcher = startFeedbackWebhookDispatcher({ store: db, readSecret: () => 'secret', dispatch, intervalMs: 100_000 });
    try {
      await dispatcher.ready;
      expect(dispatch).not.toHaveBeenCalled();
      expect(db.listFeedbackOutbox()).toMatchObject([{ status: 'inflight', lastError: 'webhook_claimed_before_request' }]);
      db.resetExpiredFeedbackOutboxClaims(Date.now() + 1000, 0);
      expect(db.listFeedbackOutbox()).toMatchObject([{ status: 'pending', lastError: 'webhook_stopped_before_request' }]);
    } finally { await dispatcher.stop(0); db.close(); }
  });

  it('does not send when another worker re-claimed the row before admission', async () => {
    const db = await storeWithOneOutboxRow('botmux-webhook-admission-stolen-');
    const dispatch = vi.fn(async () => ({ kind: 'delivered' as const, status: 200 }));
    const admit = db.tryStartFeedbackOutboxRequest.bind(db);
    vi.spyOn(db, 'tryStartFeedbackOutboxRequest').mockImplementation((outboxId, claimToken) => {
      db.resetExpiredFeedbackOutboxClaims(Date.now() + 1000, 0);
      db.claimFeedbackOutbox({ now: Date.now() + 1000, limit: 1, claimToken: 'other-worker' });
      return admit(outboxId, claimToken);
    });
    const dispatcher = startFeedbackWebhookDispatcher({ store: db, readSecret: () => 'secret', dispatch, intervalMs: 100_000 });
    try {
      await dispatcher.ready;
      expect(dispatch).not.toHaveBeenCalled();
      expect(db.listFeedbackOutbox()).toMatchObject([{ status: 'inflight', claimToken: 'other-worker' }]);
    } finally { await dispatcher.stop(0); db.close(); }
  });

  it('does not send when hard stop lands between request admission and the request', async () => {
    const db = await storeWithOneOutboxRow('botmux-webhook-admitted-stop-');
    const dispatch = vi.fn(async () => ({ kind: 'delivered' as const, status: 200 }));
    const admit = db.tryStartFeedbackOutboxRequest.bind(db);
    let dispatcher!: ReturnType<typeof startFeedbackWebhookDispatcher>;
    vi.spyOn(db, 'tryStartFeedbackOutboxRequest').mockImplementation((outboxId, claimToken) => {
      const admitted = admit(outboxId, claimToken);
      void dispatcher.stop(0);
      return admitted;
    });
    dispatcher = startFeedbackWebhookDispatcher({ store: db, readSecret: () => 'secret', dispatch, intervalMs: 100_000 });
    try {
      await dispatcher.ready;
      expect(dispatch).not.toHaveBeenCalled();
      expect(db.listFeedbackOutbox()).toMatchObject([{ status: 'pending', lastError: 'webhook_stopped_before_request' }]);
    } finally { await dispatcher.stop(0); db.close(); }
  });

  it('does not send claimed rows when hard stop lands while the claim returns', async () => {
    const db = await storeWithOneOutboxRow('botmux-webhook-claim-stop-');
    const dispatch = vi.fn(async () => ({ kind: 'delivered' as const, status: 200 }));
    const claim = db.tryClaimFeedbackOutbox.bind(db);
    let dispatcher!: ReturnType<typeof startFeedbackWebhookDispatcher>;
    vi.spyOn(db, 'tryClaimFeedbackOutbox').mockImplementation(input => {
      const claimed = claim(input);
      void dispatcher.stop(0);
      return claimed;
    });
    dispatcher = startFeedbackWebhookDispatcher({ store: db, readSecret: () => 'secret', dispatch, intervalMs: 100_000 });
    try {
      await dispatcher.ready;
      expect(dispatch).not.toHaveBeenCalled();
      expect(db.listFeedbackOutbox()).toMatchObject([{ status: 'pending', lastError: 'webhook_stopped_before_request' }]);
    } finally { await dispatcher.stop(0); db.close(); }
  });

  it('retries a failed storage bootstrap and delivers pending events without restarting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-bootstrap-')); dirs.push(dir);
    const config = await readFeedbackStorageConfig(dir);
    const path = join(dir, 'feedback-storage.json');
    writeFileSync(path, '{');
    const errors: unknown[] = [];
    const dispatcher = startFeedbackWebhookDispatcher({
      store: async () => (await getFeedbackStorage(dir)).store,
      readSecret: () => 'secret', intervalMs: 50, onError: error => errors.push(error),
      dispatch: async () => ({ kind: 'delivered' as const, status: 204 }),
    });
    try {
      await dispatcher.ready;
      expect(errors).toHaveLength(1);
      writeFileSync(path, JSON.stringify(config));
      const { store } = await getFeedbackStorage(dir);
      await store.recordTurnTerminal({ botAppId: 'app', sessionId: 's', turnId: 't', status: 'completed' });
      await store.recordTurnDelivery({
        botAppId: 'app', sessionId: 's', turnId: 't', platform: 'lark', platformAppId: 'app', platformMessageId: 'm',
        content: 'answer', cardMode: 'card', status: 'delivered',
        webhookDestinations: [{ id: 'd', enabled: true, url: 'https://hook.example/x', eventTypes: ['turn.completed'], secretRef: 'secret' }],
      });
      await vi.waitFor(async () => {
        expect(await store.listFeedbackOutbox()).toMatchObject([{ status: 'delivered', attempts: 1 }]);
      });
    } finally {
      await dispatcher.stop(0);
      await closeFeedbackStorage(dir);
    }
  });

  it.each(['quiesce', 'stop'] as const)('does not start dispatching when storage opens after %s', async method => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-late-bootstrap-')); dirs.push(dir);
    const db = await SkillFeedbackStore.open(dir);
    db.recordTurnTerminal({ botAppId: 'app', sessionId: 's', turnId: 't', status: 'completed' });
    db.recordTurnDelivery({
      botAppId: 'app', sessionId: 's', turnId: 't', platform: 'lark', platformAppId: 'app', platformMessageId: 'm',
      content: 'answer', cardMode: 'card', status: 'delivered',
      webhookDestinations: [{ id: 'd', enabled: true, url: 'https://hook.example/x', eventTypes: ['turn.completed'], secretRef: 'secret' }],
    });
    const opening = deferred<SkillFeedbackStore>();
    const dispatcher = startFeedbackWebhookDispatcher({
      store: () => opening.promise, readSecret: () => 'secret',
      dispatch: async () => ({ kind: 'delivered' as const, status: 204 }),
    });
    const stopped = method === 'stop' ? dispatcher.stop(0) : dispatcher.quiesce();
    opening.resolve(db);
    try {
      await stopped;
      await dispatcher.ready;
      expect(db.listFeedbackOutbox()).toMatchObject([{ status: 'pending', attempts: 0 }]);
      const resumed = startFeedbackWebhookDispatcher({
        store: db, readSecret: () => 'secret',
        dispatch: async () => ({ kind: 'delivered' as const, status: 204 }),
      });
      await resumed.ready;
      await resumed.stop(0);
      expect(db.listFeedbackOutbox()).toMatchObject([{ status: 'delivered', attempts: 1 }]);
    } finally { await dispatcher.stop(0); db.close(); }
  });

  it('retains unknown request outcome and blocks migration after a transport reset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-unknown-')); dirs.push(dir);
    const db = await SkillFeedbackStore.open(dir);
    db.recordTurnTerminal({ botAppId: 'app', sessionId: 's', turnId: 't', status: 'completed' });
    db.recordTurnDelivery({
      botAppId: 'app', sessionId: 's', turnId: 't', platform: 'lark', platformAppId: 'app', platformMessageId: 'm',
      content: 'answer', cardMode: 'card', status: 'delivered',
      webhookDestinations: [{ id: 'd', enabled: true, url: 'https://8.8.8.8/hook', eventTypes: ['turn.completed'], secretRef: 'secret' }],
    });
    const dispatcher = startFeedbackWebhookDispatcher({
      store: db, readSecret: () => 'secret',
      dispatch: input => dispatchWebhookAttempt({ ...input, request: async () => { throw new Error('ECONNRESET_after_receiver_commit'); } }),
    });
    await dispatcher.ready;
    await dispatcher.quiesce();
    await beginFeedbackMaintenance(dir, 'unknown-webhook');
    try {
      await expect(freezeFeedbackSource(dir, 'unknown-webhook')).rejects.toThrow('feedback_outbox_unsettled');
    } finally { db.close(); }
  });
  it('maintenance quiescence waits for an in-flight request without aborting it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-quiesce-')); dirs.push(dir);
    const db = await SkillFeedbackStore.open(dir);
    db.recordTurnTerminal({ botAppId: 'app', sessionId: 's', turnId: 't', status: 'completed' });
    db.recordTurnDelivery({
      botAppId: 'app', sessionId: 's', turnId: 't', platform: 'lark', platformAppId: 'app', platformMessageId: 'm',
      content: 'answer', cardMode: 'card', status: 'delivered',
      webhookDestinations: [{ id: 'd', enabled: true, url: 'https://hook.example/x', eventTypes: ['turn.completed'], secretRef: 'secret' }],
    });
    const started = deferred<AbortSignal | undefined>();
    const request = deferred<{ kind: 'delivered'; status: number }>();
    const dispatcher = startFeedbackWebhookDispatcher({
      store: db, readSecret: () => 'secret',
      dispatch: async input => { started.resolve(input.signal); return request.promise; },
    });
    const signal = await started.promise;
    let quiesced = false;
    const stopping = dispatcher.quiesce().then(() => { quiesced = true; });
    await Promise.resolve();
    expect(quiesced).toBe(false);
    expect(signal?.aborted).toBe(false);
    request.resolve({ kind: 'delivered', status: 200 });
    await stopping;
    expect(db.listFeedbackOutbox()[0].status).toBe('delivered');
    db.close();
  });
  it('recovers stale claims, immediately dispatches due rows, and stops boundedly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-pump-')); dirs.push(dir);
    const db = await SkillFeedbackStore.open(dir);
    const destination = { id: 'd', enabled: true, url: 'https://hook.example/x', eventTypes: ['turn.completed' as const], secretRef: 'feedback-webhook:r', timeoutMs: 1000 };
    db.recordTurnTerminal({ botAppId: 'app', sessionId: 's', turnId: 't', status: 'completed', completedAt: '2026-08-11T00:00:00.000Z' });
    db.recordTurnDelivery({ botAppId: 'app', sessionId: 's', turnId: 't', platform: 'lark', platformAppId: 'app', platformMessageId: 'm', content: 'answer', cardMode: 'feedback', status: 'delivered', webhookDestinations: [destination] });
    db.claimFeedbackOutbox({ now: Date.now(), limit: 1, claimToken: 'crashed' });
    const attempts: string[] = [];
    const dispatcher = startFeedbackWebhookDispatcher({ store: db, readSecret: () => 'secret', staleClaimMs: 0, intervalMs: 100_000,
      dispatch: async input => { attempts.push(input.event.eventId); return { kind: 'delivered' as const, status: 204 }; } });
    await dispatcher.ready;
    expect(attempts).toHaveLength(1);
    expect(db.listFeedbackOutbox()[0].status).toBe('delivered');
    await dispatcher.stop();
    db.close();
  });

  it('reschedules a claimed row when dispatch throws before returning a classification', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-throw-')); dirs.push(dir);
    const db = await SkillFeedbackStore.open(dir);
    const destination = { id: 'd', enabled: true, url: 'https://hook.example/x', eventTypes: ['turn.completed' as const], secretRef: 'feedback-webhook:r', timeoutMs: 1000 };
    db.recordTurnTerminal({ botAppId: 'app', sessionId: 's', turnId: 't', status: 'completed', completedAt: '2026-08-11T00:00:00.000Z' });
    db.recordTurnDelivery({ botAppId: 'app', sessionId: 's', turnId: 't', platform: 'lark', platformAppId: 'app', platformMessageId: 'm', content: 'answer', cardMode: 'feedback', status: 'delivered', webhookDestinations: [destination] });
    const errors: unknown[] = [];
    const dispatcher = startFeedbackWebhookDispatcher({ store: db, readSecret: () => 'secret', intervalMs: 100_000,
      onError: error => errors.push(error), dispatch: async () => { throw new Error('dns exploded'); } });
    await dispatcher.ready;
    expect(db.listFeedbackOutbox()[0]).toMatchObject({ status: 'pending', attempts: 1, lastError: 'dns exploded' });
    expect(errors).toHaveLength(1);
    await dispatcher.stop(); db.close();
  });

  it('does not block the daemon event loop when another process holds the feedback DB write lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-busy-')); dirs.push(dir);
    const db = await SkillFeedbackStore.open(dir);
    const blocker = await SkillFeedbackStore.open(dir);
    (blocker as any).db.exec('BEGIN IMMEDIATE;');

    const started = Date.now();
    const dispatcher = startFeedbackWebhookDispatcher({
      store: db,
      readSecret: () => 'secret',
      intervalMs: 100_000,
    });
    await dispatcher.ready;
    expect(Date.now() - started).toBeLessThan(500);

    (blocker as any).db.exec('COMMIT;');
    await dispatcher.stop();
    blocker.close();
    db.close();
  });

  it('stop(0) returns immediately without waiting the internal default window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-stop0-')); dirs.push(dir);
    const db = await SkillFeedbackStore.open(dir);
    // A dispatch that never resolves would, under the old internal 5s default,
    // make stop() block up to 5s. With an explicit 0 budget stop must not wait.
    const dispatcher = startFeedbackWebhookDispatcher({ store: db, readSecret: () => 'secret', intervalMs: 100_000, shutdownMs: 5000,
      dispatch: () => new Promise(() => { /* never resolves */ }) });
    await dispatcher.ready;
    const t0 = Date.now();
    await dispatcher.stop(0);           // shared-budget = 0 → return now
    expect(Date.now() - t0).toBeLessThan(500);
    db.close();
  });

  it('inherits frozen delivery destinations for feedback.revised fan-out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-feedback-outbox-inherit-')); dirs.push(dir);
    const db = await SkillFeedbackStore.open(dir);
    const destination = { id: 'audit', enabled: true, url: 'https://hook.example/x', eventTypes: ['feedback.revised' as const], secretRef: 'feedback-webhook:a', timeoutMs: 1000 };
    db.recordTurnDelivery({ botAppId: 'app', sessionId: 's', turnId: 't', platform: 'lark', platformAppId: 'app', platformMessageId: 'm', content: 'answer', cardMode: 'feedback', status: 'delivered', webhookDestinations: [destination] });
    db.recordFeedback({ platform: 'lark', platformAppId: 'app', platformMessageId: 'm', operatorSubjectId: 'u', result: 'effective_progress', semantic: 'progress', callbackKey: 'cb' });
    expect(db.listFeedbackOutbox()).toHaveLength(1);
    expect(db.listFeedbackOutbox()[0]).toMatchObject({ destination: { id: 'audit' }, event: { type: 'feedback.revised', data: { semantic: 'progress' } } });
    db.close();
  });

  it('signs exact bytes, pins validated DNS, disables redirects, and sets idempotency headers', async () => {
    const seen: any[] = [];
    const event = { eventId: 'evt-1', type: 'turn.completed' as const, version: 1 as const, time: '2026-08-11T00:00:00.000Z', data: { status: 'completed' } };
    const result = await dispatchWebhookAttempt({
      destination: { id: 'd', url: 'https://hook.example/path', secretRef: 'r', timeoutMs: 1000 }, event,
      secret: 'secret', now: () => 1234,
      lookup: async () => [{ address: '8.8.8.8', family: 4 as const }],
      request: async input => { seen.push(input); return { status: 204, headers: {}, body: '' }; },
    });
    expect(result).toEqual({ kind: 'delivered', status: 204 });
    const body = JSON.stringify(event);
    expect(seen[0].headers['X-Botmux-Event-Id']).toBe('evt-1');
    expect(seen[0].headers['X-Botmux-Timestamp']).toBe('1234');
    expect(seen[0].headers['X-Botmux-Signature']).toBe(`v1=${createHmac('sha256', 'secret').update(`v1.1234.${body}`).digest('hex')}`);
    expect(seen[0]).toMatchObject({ body, redirect: 'error', pinnedAddress: '8.8.8.8' });
  });

  it('classifies status and bounds Retry-After/backoff jitter', () => {
    expect(classifyWebhookResponse(200)).toBe('delivered');
    expect(classifyWebhookResponse(408)).toBe('retry');
    expect(classifyWebhookResponse(429)).toBe('retry');
    expect(classifyWebhookResponse(503)).toBe('retry');
    expect(classifyWebhookResponse(404)).toBe('failed');
    expect(computeRetryDelay({ attempts: 4, retryAfter: '999999', random: () => 1, maxDelayMs: 300_000 })).toBe(300_000);
    expect(computeRetryDelay({ attempts: 2, random: () => 0.5, baseDelayMs: 1000, maxDelayMs: 300_000 })).toBe(1000);
  });
});
import { deferred } from './helpers/feedback-deferred.js';
