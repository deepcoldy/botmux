import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
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

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

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
