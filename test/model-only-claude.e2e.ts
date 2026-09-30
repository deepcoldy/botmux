import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIsolatedClaude } from '../src/services/constrained-invocation/claude-runtime.js';
import { isolatedInvocationEnv } from '../src/services/constrained-invocation/codex-runtime.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const executable = process.env.BOTMUX_MODEL_ONLY_CLAUDE;
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const schema = { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false };
async function fixture(hang = false, hostile = false) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-claude-fixture-')); roots.push(root);
  for (const name of ['home', 'claude', 'work']) mkdirSync(join(root, name), { mode: 0o700 });
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (!req.url?.includes('/messages')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    if (hang) return;
    const item = { type: 'tool_use', id: 'structured-answer', name: hostile ? 'Bash' : 'StructuredOutput', input: {} };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'message_start', message: { id: 'fixture-message', type: 'message', role: 'assistant', content: [], model: body.model, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: item },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(hostile ? { command: `touch ${join(root, 'must-not-exist')}` } : { content: '42' }) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const env = isolatedInvocationEnv(join(root, 'home'), join(root, 'unused'), { PATH: process.env.PATH, NO_PROXY: '127.0.0.1' });
  delete env.CODEX_HOME;
  Object.assign(env, { CLAUDE_CONFIG_DIR: join(root, 'claude'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: 'synthetic-fixture', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  const request = { requestId: 'fixture', prompt: 'Return content 42', model: 'claude-sonnet-4-5', deadlineMs: 15000, outputSchema: schema };
  const runtime = { executable: executable!, cwd: join(root, 'work'), env };
  return { root, requests, request, runtime, run: (signal = AbortSignal.timeout(15000)) => runIsolatedClaude(request, runtime, signal) };
}

it.skipIf(!executable)('uses the native Claude model with only the serialization tool and returns structured output', async () => {
  const h = await fixture();
  const result = await h.run();
  expect(result.output).toEqual({ content: '42' });
  expect(h.requests.length).toBeGreaterThan(0);
  for (const request of h.requests) expect(request.tools.map((tool: any) => tool.name)).toEqual(['StructuredOutput']);
  expect(result.usage?.inputTokens).toBeGreaterThan(0);
});

it.skipIf(!executable)('cancels a hung Claude request before returning', async () => {
  const h = await fixture(true);
  await expect(h.run(AbortSignal.timeout(1500))).rejects.toThrow('invocation_aborted');
});

it.skipIf(!executable)('rejects a forced host command without creating its marker', async () => {
  const h = await fixture(false, true);
  await expect(h.run()).rejects.toThrow('native_host_request_forbidden');
  expect(existsSync(join(h.root, 'must-not-exist'))).toBe(false);
});

it.skipIf(!executable)('reaps the whole Claude process group after its owner dies', async () => {
  const h = await fixture(true);
  const parent = spawnTsEvalWithRepoImports(`
    import { runIsolatedClaude } from './src/services/constrained-invocation/claude-runtime.js';
    await runIsolatedClaude(${JSON.stringify(h.request)}, { ...${JSON.stringify(h.runtime)}, onSpawn: pid => console.log(pid) }, AbortSignal.timeout(15000));
  `, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  const nativePid = await new Promise<number>((resolve, reject) => {
    parent.stdout!.once('data', data => resolve(Number(String(data).trim())));
    parent.once('error', reject);
  });
  try {
    for (let i = 0; i < 100 && !h.requests.length; i++) await new Promise(resolve => setTimeout(resolve, 50));
    expect(h.requests.length).toBeGreaterThan(0);
    expect(Number.isSafeInteger(nativePid)).toBe(true);
    parent.kill('SIGKILL');
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      try { process.kill(-nativePid, 0); } catch { alive = false; }
    }
    expect(alive).toBe(false);
  } finally {
    parent.kill('SIGKILL');
    if (nativePid) { try { process.kill(-nativePid, 'SIGKILL'); } catch { /* gone */ } }
  }
});

it.skipIf(!executable).each([1, 4096, 16384])('passes completion budget %s to native generation', async maxOutputTokens => {
  const h = await fixture();
  await runIsolatedClaude({ ...h.request, maxOutputTokens }, h.runtime, AbortSignal.timeout(15000));
  expect(h.requests.length).toBeGreaterThan(0);
  for (const request of h.requests) expect(request.max_tokens).toBe(maxOutputTokens);
});
