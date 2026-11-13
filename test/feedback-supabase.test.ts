import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  delete process.env.BOTMUX_TEST_SUPABASE_KEY;
});
async function fixture(response: (operation: string, args: unknown[]) => Response) {
  const dataDir = await mkdtemp(join(tmpdir(), 'supabase-feedback-'));
  directories.push(dataDir);
  process.env.BOTMUX_TEST_SUPABASE_KEY = 'sb_secret_private_test_key';
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(input), headers: new Headers(init?.headers), body });
    return response(body.p_operation, body.p_args);
  };
  const target = { url: 'https://example.supabase.co', keyRef: 'env:BOTMUX_TEST_SUPABASE_KEY', schema: 'botmux_feedback', requestTimeoutMs: 5000 };
  return { dataDir, requests, target, fetcher };
}
describe('Supabase feedback storage', () => {
  it('uses the official SDK with the selected schema and binds every call to the installation identity', async () => {
    const fixtureData = await fixture((operation, args) => new Response(JSON.stringify({ version: 1, result: { operation, args } }), { headers: { 'content-type': 'application/json' } }));
    const adapter = await import('../src/services/feedback-supabase-store.js').catch(() => undefined);
    expect(adapter, 'Supabase adapter must be implemented').toBeDefined();
    const client = await adapter!.openSupabaseFeedbackClient(fixtureData.dataDir, fixtureData.target, fixtureData.fetcher);
    expect(await client.call('getResponse', ['response-id'], 'installation-id')).toEqual({ operation: 'getResponse', args: ['response-id'] });
    expect(fixtureData.requests[0].url).toBe('https://example.supabase.co/rest/v1/rpc/botmux_feedback');
    expect(fixtureData.requests[0].headers.get('content-profile')).toBe('botmux_feedback');
    expect(fixtureData.requests[0].headers.get('apikey')).toBe('sb_secret_private_test_key');
    expect(fixtureData.requests[0].body.p_instance_id).toBe('installation-id');
    await client.close();
  });
  it('opens only an active matching schema and normalizes SQL null lookups to undefined', async () => {
    const fixtureData = await fixture(operation => new Response(JSON.stringify({ version: 1, result: operation === 'migration_status' ? { version: 1, instance_id: 'installation-id', state: 'active' } : null }), { headers: { 'content-type': 'application/json' } }));
    const { openSupabaseFeedbackStorage } = await import('../src/services/feedback-supabase-store.js');
    const storage = await openSupabaseFeedbackStorage(fixtureData.dataDir, fixtureData.target, 'installation-id', fixtureData.fetcher);
    expect(await storage.store.getResponse('missing')).toBeUndefined();
    expect(fixtureData.requests.map(request => request.body.p_operation)).toEqual(['migration_status', 'getResponse']);
    await storage.store.close();
  });
  it('does not replay a mutation when transport outcome is unknown and redacts upstream content', async () => {
    const fixtureData = await fixture(() => { throw new Error('network failed: sb_secret_private_test_key'); });
    const { openSupabaseFeedbackClient } = await import('../src/services/feedback-supabase-store.js');
    const client = await openSupabaseFeedbackClient(fixtureData.dataDir, fixtureData.target, fixtureData.fetcher);
    await expect(client.call('recordFeedback', [{ callbackKey: 'original-key' }], 'installation-id')).rejects.toThrow('feedback_supabase_outcome_unknown');
    expect(fixtureData.requests).toHaveLength(1);
  });
  it('rejects public keys before creating any HTTP request', async () => {
    const fixtureData = await fixture(() => new Response('{}'));
    process.env.BOTMUX_TEST_SUPABASE_KEY = 'sb_publishable_public_key';
    const { openSupabaseFeedbackClient } = await import('../src/services/feedback-supabase-store.js');
    await expect(openSupabaseFeedbackClient(fixtureData.dataDir, fixtureData.target, fixtureData.fetcher)).rejects.toThrow('feedback_supabase_server_key_required');
    expect(fixtureData.requests).toHaveLength(0);
  });
  it('preserves outbox try-method return contracts through one atomic RPC', async () => {
    const fixtureData = await fixture(operation => new Response(JSON.stringify({ version: 1, result: operation === 'migration_status' ? { version: 1, instance_id: 'installation-id', state: 'active' } : true }), { headers: { 'content-type': 'application/json' } }));
    const { openSupabaseFeedbackStorage } = await import('../src/services/feedback-supabase-store.js');
    const storage = await openSupabaseFeedbackStorage(fixtureData.dataDir, fixtureData.target, 'installation-id', fixtureData.fetcher);
    expect(await storage.store.trySettleFeedbackOutboxDelivered('outbox', 'claim', 200, '2026-11-13T00:00:00Z')).toEqual({ done: true, changed: true });
    expect(fixtureData.requests[1].body.p_operation).toBe('settleFeedbackOutboxDelivered');
    await storage.store.close();
  });
  it('preserves the terminal try-method payload field', async () => {
    const fixtureData = await fixture(operation => new Response(JSON.stringify({ version: 1, result: operation === 'migration_status' ? { version: 1, instance_id: 'installation-id', state: 'active' } : { type: 'turn.completed' } }), { headers: { 'content-type': 'application/json' } }));
    const { openSupabaseFeedbackStorage } = await import('../src/services/feedback-supabase-store.js');
    const storage = await openSupabaseFeedbackStorage(fixtureData.dataDir, fixtureData.target, 'installation-id', fixtureData.fetcher);
    expect(await storage.store.tryRecordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: 'turn', status: 'completed' })).toEqual({ done: true, payload: { type: 'turn.completed' } });
    await storage.store.close();
  });
  it('does not retry a server failure after a mutation may have committed', async () => {
    const fixtureData = await fixture(() => new Response('temporarily unavailable', { status: 503 }));
    const { openSupabaseFeedbackClient } = await import('../src/services/feedback-supabase-store.js');
    const client = await openSupabaseFeedbackClient(fixtureData.dataDir, fixtureData.target, fixtureData.fetcher);
    await expect(client.call('recordFeedback', [{ callbackKey: 'original-key' }], 'installation-id')).rejects.toThrow('feedback_supabase_outcome_unknown');
    expect(fixtureData.requests).toHaveLength(1);
  });
});
