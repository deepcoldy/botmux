import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChatRequest, completionResponse, toInvocation, ProxyError } from '../src/services/model-proxy/protocol.js';
import { proxyConfigSchema, proxyClients } from '../src/services/model-proxy/config.js';
import { startModelProxy } from '../src/services/model-proxy/server.js';
import { InvocationService } from '../src/services/constrained-invocation/service.js';
import type { InvocationResult } from '../src/services/constrained-invocation/contract.js';
import type { NativeInvocationOutput } from '../src/services/constrained-invocation/runtime.js';

const token = 'synthetic-local-client-token-at-least-32';
const roots: string[] = []; const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tool = { type: 'function', function: { name: 'add', parameters: { type: 'object', properties: { x: { type: 'integer' }, note: { type: 'string' } }, required: ['x'], additionalProperties: false } } };
const chat = { model: 'reasoner', messages: [{ role: 'system', content: 'Calculate.' }, { role: 'user', content: 'Add.' }], tools: [tool] };
const done = (output: unknown): InvocationResult => ({ requestId: 'r1', state: 'completed', output, error: null, startedAt: '2026-01-01T00:00:00Z', durationMs: 1, startupMs: 1, configuredModel: 'native', actualModel: null, reasoningEffort: null, usage: null, usageSource: null });
const proposal = { content: '', tool_calls: [{ name: 'add', arguments: '{"x":42}' }] };

describe('public conversation contract', () => {
  it.each([undefined, null])('leaves native output limits unspecified for %s', max_completion_tokens => {
    const route = { bot: 'fixture', model: 'native', deadlineMs: 5000 };
    const result = toInvocation(parseChatRequest({ ...chat, max_completion_tokens }), route, 'r1');
    expect(result).not.toHaveProperty('maxOutputTokens');
    expect(result).toEqual(toInvocation(parseChatRequest(chat), route, 'r1'));
  });
  it.each([1, 4096, 128_000])('preserves a positive native output limit: %s', max_completion_tokens => {
    const result = toInvocation(parseChatRequest({ ...chat, max_completion_tokens }), { bot: 'fixture', model: 'native', deadlineMs: 5000 }, 'r1');
    expect(result.maxOutputTokens).toBe(max_completion_tokens);
  });
  it.each([[0], [-1], [1.5], [128_001], ['4096'], ['null'], [false], [{}], [[]]])('rejects invalid output limits: %j', max_completion_tokens => {
    expect(() => parseChatRequest({ ...chat, max_completion_tokens })).toThrow('unsupported_or_invalid_parameter');
  });
  it('preserves message order, roles and optional tool properties without normalizing the schema', () => {
    const parsed = parseChatRequest(chat);
    const request = toInvocation(parsed, { bot: 'fixture', model: 'native', deadlineMs: 5000 }, 'r1');
    expect(JSON.parse(request.prompt.split('CHAT_REQUEST_JSON:\n')[1])).toEqual(chat);
    const response = completionResponse(parsed, done(proposal));
    const message = response.choices[0].message;
    expect(message.tool_calls?.[0].function.arguments).toBe('{"x":42}');
    expect(response.choices[0].finish_reason).toBe('tool_calls');
    const next = parseChatRequest({ ...chat, messages: [...chat.messages, message, { role: 'tool', tool_call_id: message.tool_calls![0].id, content: '42' }] });
    expect(next.messages.at(-1)).toMatchObject({ content: '42' });
    expect(completionResponse(parsed, done(proposal))).toEqual(response);
  });
  it.each([
    { stream: true }, { temperature: 0 }, { max_tokens: 100 }, { n: 2 }, { seed: 1 },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/image' } }] }] },
    { tools: [{ ...tool, function: { ...tool.function, parameters: { ...tool.function.parameters, patternProperties: {} } } }] },
  ])('rejects unsupported inputs before inference: %j', extra => { expect(() => parseChatRequest({ ...chat, ...extra })).toThrow(); });
  it.each([
    [{ role: 'tool', tool_call_id: 'missing', content: '1' }],
    [{ role: 'assistant', tool_calls: [{ id: 'x', type: 'function', function: { name: 'add', arguments: '{}' } }] }],
    [{ role: 'assistant', tool_calls: [{ id: 'x', type: 'function', function: { name: 'add', arguments: '{}' } }] }, { role: 'user', content: 'interleaved' }],
  ])('rejects malformed tool histories', (...messages) => { expect(() => parseChatRequest({ ...chat, messages })).toThrow(); });
  it.each([
    { content: '', tool_calls: [{ name: 'shell', arguments: '{}' }] },
    { content: '', tool_calls: [{ name: 'add', arguments: '{"x":"42"}' }] },
    { content: '', tool_calls: [{ name: 'add', arguments: '{"x":42,"unexpected":true}' }] },
  ])('rejects invalid generated tool proposals', output => { expect(() => completionResponse(parseChatRequest(chat), done(output))).toThrow(); });
  it('enforces none, required, named choice and parallel tool calls', () => {
    expect(() => completionResponse(parseChatRequest({ ...chat, tool_choice: 'none' }), done(proposal))).toThrow('tool_choice_violation');
    expect(() => completionResponse(parseChatRequest({ ...chat, tool_choice: 'required' }), done({ content: 'done', tool_calls: [] }))).toThrow('tool_choice_violation');
    expect(() => completionResponse(parseChatRequest({ ...chat, parallel_tool_calls: false }), done({ ...proposal, tool_calls: [...proposal.tool_calls, ...proposal.tool_calls] }))).toThrow('tool_choice_violation');
    expect(completionResponse(parseChatRequest({ ...chat, tool_choice: { type: 'function', function: { name: 'add' } } }), done(proposal)).choices[0].finish_reason).toBe('tool_calls');
  });
  it('validates JSON content and exposes native totals without inventing API usage', () => {
    const request = parseChatRequest({ ...chat, response_format: { type: 'json_object' } });
    expect(() => completionResponse(request, done({ content: 'plain', tool_calls: [] }))).toThrow('invalid_model_json');
    const result = { ...done({ content: '{"value":42}', tool_calls: [] }), usage: { inputTokens: 50, outputTokens: 8, cachedInputTokens: 20, cacheWriteInputTokens: null }, usageSource: 'native_thread_total' as const };
    const response = completionResponse(request, result);
    expect(response.usage).toBeNull(); expect(response.botmux.native_invocation_usage).toEqual(result.usage);
    expect(response.botmux.usage_scope).toBe('whole_native_invocation');
  });
});

async function harness(run?: (prompt: string, signal: AbortSignal) => Promise<unknown>, deadlineMs = 2000) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-proxy-unit-')); roots.push(root);
  let starts = 0; let aborted = 0;
  const service = new InvocationService({ directory: root, run: async (request, signal): Promise<NativeInvocationOutput> => {
    starts++; signal.addEventListener('abort', () => aborted++, { once: true });
    return { configuredModel: request.model, actualModel: null, reasoningEffort: null, usage: null, usageSource: null, startupMs: 1, output: await (run?.(request.prompt, signal) ?? Promise.resolve({ content: 'ok', tool_calls: [] })) };
  } }); cleanups.push(() => service.close());
  const config = proxyConfigSchema.parse({ port: 0, models: { reasoner: { bot: 'fixture', model: 'native', deadlineMs } }, clients: [{ id: 'caller', tokenEnv: 'TEST_PROXY_TOKEN', models: ['reasoner'] }] });
  const proxy = await startModelProxy({ config, clients: proxyClients(config, { TEST_PROXY_TOKEN: token }), backend: () => ({ capabilities: async () => ({ supported: true }), start: async r => { try { return service.start(r); } catch (e) { if (e instanceof Error && e.message === 'idempotency_conflict') throw new ProxyError(409, 'idempotency_conflict'); throw e; } }, get: async id => service.get(id)!, cancel: id => service.cancel(id) }) });
  cleanups.push(() => proxy.close());
  const url = `http://127.0.0.1:${proxy.port}/v1/chat/completions`;
  const request = (body: unknown = chat, headers: Record<string, string> = {}, signal?: AbortSignal) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  return { request, service, proxy, get starts() { return starts; }, get aborted() { return aborted; } };
}
const hang = (_: string, signal: AbortSignal) => new Promise((_, reject) => { if (signal.aborted) reject(new Error('aborted')); else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
it('authenticates, restricts model aliases, and rejects unsupported budgets before starting', async () => {
  const h = await harness();
  expect((await h.request(chat, { authorization: 'Bearer wrong' })).status).toBe(401);
  expect((await h.request({ ...chat, model: 'other-identity' })).status).toBe(403);
  expect((await h.request({ ...chat, max_completion_tokens: 100 })).status).toBe(400);
  expect((await h.request(chat, { origin: 'https://example.test' })).status).toBe(403);
  expect(h.starts).toBe(0);
});
it('deduplicates concurrent and completed requests and rejects a changed body', async () => {
  const h = await harness(async () => { await new Promise(resolve => setTimeout(resolve, 150)); return { content: 'ok', tool_calls: [] }; });
  const headers = { 'idempotency-key': 'same' };
  const results = await Promise.all([h.request(chat, headers), h.request(chat, headers)]);
  expect(results.every(r => r.status === 200)).toBe(true);
  const bodies = await Promise.all(results.map(r => r.json())); expect(bodies[0]).toEqual(bodies[1]);
  expect(await (await h.request(chat, headers)).json()).toEqual(bodies[0]);
  expect(await (await h.request({ ...chat, max_completion_tokens: null }, headers)).json()).toEqual(bodies[0]);
  expect((await h.request({ ...chat, messages: [{ role: 'user', content: 'different' }] }, headers)).status).toBe(409);
  expect(h.starts).toBe(1);
});
it('isolates concurrent conversations', async () => {
  const h = await harness(async prompt => ({ content: JSON.parse(prompt.split('CHAT_REQUEST_JSON:\n')[1]).messages[0].content, tool_calls: [] }));
  const results = await Promise.all(['first', 'second'].map(content => h.request({ model: 'reasoner', messages: [{ role: 'user', content }] }).then(r => r.json()) as Promise<any>));
  expect(results.map(r => r.choices[0].message.content)).toEqual(['first', 'second']); expect(h.starts).toBe(2);
});
it('returns structured deadline failure after native cancellation', async () => {
  const h = await harness(hang, 100);
  const response = await h.request(); expect(response.status).toBe(504);
  expect(await response.json()).toMatchObject({ error: { code: 'deadline_exceeded' } }); expect(h.aborted).toBe(1);
});
it('cancels on last disconnect and reaps work on shutdown', async () => {
  const h = await harness(hang);
  const c = new AbortController(); const request = h.request(chat, {}, c.signal).catch(() => null);
  await until(() => h.starts === 1); c.abort(); await request;
  await until(() => h.aborted === 1);
  const second = h.request().catch(() => null); await until(() => h.starts === 2);
  await h.proxy.close(); await second; expect(h.aborted).toBe(2);
});
it('disconnecting one duplicate leaves the other waiter alive', async () => {
  let finish!: (v: unknown) => void;
  const h = await harness(() => new Promise(resolve => { finish = resolve; }));
  const c = new AbortController(); const headers = { 'idempotency-key': 'attached' };
  const first = h.request(chat, headers, c.signal).catch(() => null); await until(() => h.starts === 1);
  const second = h.request(chat, headers); await new Promise(resolve => setTimeout(resolve, 100));
  c.abort(); await first; await new Promise(resolve => setTimeout(resolve, 100)); expect(h.aborted).toBe(0);
  finish({ content: 'done', tool_calls: [] }); expect((await second).status).toBe(200); expect(h.starts).toBe(1);
});
async function until(test: () => boolean) { for (let n = 0; n < 100; n++) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('wait_failed'); }
it('returns structured syntax/content-size errors and lists only permitted aliases', async () => {
  const h = await harness();
  const base = `http://127.0.0.1:${h.proxy.port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const bad = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: '{' });
  expect(bad.status).toBe(400); expect(await bad.json()).toMatchObject({ error: { code: 'invalid_json' } });
  const huge = await h.request({ model: 'reasoner', messages: [{ role: 'user', content: 'a'.repeat(1_000_001) }] });
  expect(huge.status).toBe(413); expect(await huge.json()).toMatchObject({ error: { code: 'request_too_large' } });
  const models = await (await fetch(`${base}/v1/models`, { headers })).json() as any;
  expect(models.data.map((m: any) => m.id)).toEqual(['reasoner']);
  expect(JSON.stringify(models)).not.toContain('fixture'); expect(h.starts).toBe(0);
});
it('requires loopback configuration, private client tokens and known model grants', () => {
  expect(() => proxyConfigSchema.parse({ host: '0.0.0.0', models: {}, clients: [] })).toThrow();
  const config = proxyConfigSchema.parse({ models: { reasoner: { bot: 'fixture', model: 'native' } }, clients: [{ id: 'x', tokenEnv: 'TOKEN', models: ['reasoner'] }] });
  expect(() => proxyClients(config, { TOKEN: 'short' })).toThrow();
  expect(() => proxyClients({ ...config, clients: [...config.clients, ...config.clients] }, { TOKEN: token })).toThrow();
  expect(() => proxyClients({ ...config, clients: [{ ...config.clients[0], models: ['unknown'] }] }, { TOKEN: token })).toThrow();
});
it('keeps cancelled idempotency results instead of rerunning inference', async () => {
  const h = await harness(hang, 100);
  const headers = { 'idempotency-key': 'timed-out' };
  expect((await h.request(chat, headers)).status).toBe(504);
  expect((await h.request(chat, headers)).status).toBe(504);
  expect(h.starts).toBe(1); expect(h.aborted).toBe(1);
});
