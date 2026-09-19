import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIsolatedOpenCode } from '../src/services/constrained-invocation/opencode-runtime.js';
import { isolatedModelEnv } from '../src/services/constrained-invocation/runtime.js';
const executable = process.env.BOTMUX_MODEL_ONLY_OPENCODE;
const roots: string[] = []; const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
async function fixture(mode: 'normal' | 'hang' | 'hostile' | 'invalid' = 'normal') {
  const root = mkdtempSync(join(tmpdir(), 'botmux-opencode-fixture-')); roots.push(root);
  for (const name of ['home', 'work']) mkdirSync(join(root, name), { mode: 0o700 });
  const requests: any[] = [];
  const s = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push(body);
    if (mode === 'hang') return;
    const hostile = mode === 'hostile';
    const delta = hostile ? { role: 'assistant', tool_calls: [{ index: 0, id: 'forbidden', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: `touch ${join(root, 'must-not-exist')}`, description: 'Forbidden fixture' }) } }] } : { role: 'assistant', content: mode === 'invalid' ? '{}' : '{"content":"42"}' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const data of [
      { id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: null }] },
      { id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: hostile ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 2 }, prompt_tokens_details: { cached_tokens: 2 } } },
    ]) res.write(`data: ${JSON.stringify(data)}\n\n`);
    res.end('data: [DONE]\n\n');
  }); servers.push(s); await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  const env = isolatedModelEnv(join(root, 'home'), { PATH: process.env.PATH, NO_PROXY: '127.0.0.1' });
  const provider = { fixture: { npm: '@ai-sdk/openai-compatible', name: 'fixture', options: { baseURL: `http://127.0.0.1:${(s.address() as { port: number }).port}/v1`, apiKey: 'synthetic-fixture' }, models: { 'fixture-model': { name: 'fixture-model', limit: { context: 64000, output: 4096 } } } } };
  const request = { requestId: 'fixture', prompt: 'Return content 42', model: 'fixture/fixture-model', deadlineMs: 15000, outputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } };
  return { root, requests, run: (signal = AbortSignal.timeout(15000)) => runIsolatedOpenCode(request, { executable: executable!, cwd: join(root, 'work'), env, fixtureProvider: provider }, signal) };
}
it.skipIf(!executable)('OpenCode: no tools or auxiliary title inference and validated output', async () => {
  const h = await fixture(); const r = await h.run(); expect(r.output).toEqual({ content: '42' });
  expect(r.actualModel).toBeNull(); expect(r.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 });
  expect(h.requests.length).toBe(1); expect(h.requests[0].tools ?? []).toEqual([]);
});
it.skipIf(!executable)('OpenCode: cancels a hung native request', async () => {
  const h = await fixture('hang'); await expect(h.run(AbortSignal.timeout(2000))).rejects.toThrow('invocation_aborted');
});
it.skipIf(!executable)('OpenCode: rejects unsolicited host tool calls without executing them', async () => {
  const h = await fixture('hostile'); await expect(h.run()).rejects.toThrow('native_host_request_forbidden');
  expect(existsSync(join(h.root, 'must-not-exist'))).toBe(false);
});
it.skipIf(!executable)('OpenCode: validates model JSON locally', async () => {
  const h = await fixture('invalid'); await expect(h.run()).rejects.toThrow('output_schema_mismatch');
});
