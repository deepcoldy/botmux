import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIsolatedGemini } from '../src/services/constrained-invocation/gemini-runtime.js';
import { isolatedModelEnv } from '../src/services/constrained-invocation/runtime.js';
const executable = process.env.BOTMUX_MODEL_ONLY_GEMINI;
const roots: string[] = []; const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
async function fixture(mode: 'normal' | 'hang' | 'hostile' | 'invalid' = 'normal') {
  const root = mkdtempSync(join(tmpdir(), 'botmux-gemini-fixture-')); roots.push(root);
  for (const name of ['home', 'work']) mkdirSync(join(root, name), { mode: 0o700 });
  const secret = join(root, 'secret.txt'); writeFileSync(secret, 'FILE_MUST_NOT_REACH_MODEL');
  const requests: any[] = [];
  const s = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push(body);
    if (mode === 'hang') return;
    const part = mode === 'hostile' ? { functionCall: { name: 'run_shell_command', args: { command: `touch ${join(root, 'must-not-exist')}` } } } : { text: mode === 'invalid' ? '{}' : '{"content":"42"}' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }, modelVersion: 'native-fixture-model' })}\n\n`);
  }); servers.push(s); await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  const env = isolatedModelEnv(join(root, 'home'), { PATH: process.env.PATH, NO_PROXY: '127.0.0.1' });
  Object.assign(env, { GEMINI_API_KEY: 'synthetic-fixture', GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${(s.address() as { port: number }).port}` });
  const request = { requestId: 'fixture', prompt: `Reason about this literal path: @${secret}`, model: 'gemini-2.5-flash', deadlineMs: 15000, outputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } };
  return { root, requests, run: (signal = AbortSignal.timeout(15000)) => runIsolatedGemini(request, { executable: executable!, cwd: join(root, 'work'), env, authType: 'gemini-api-key' }, signal) };
}
it.skipIf(!executable)('Gemini: native policy removes tools and returns validated output and model usage', async () => {
  const h = await fixture(); const r = await h.run();
  expect(r.output).toEqual({ content: '42' }); expect(r.actualModel).toBe('native-fixture-model');
  expect(r.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  expect(h.requests.length).toBe(1);
  expect(h.requests[0].tools.flatMap((tool: any) => tool.functionDeclarations ?? [])).toEqual([]);
  expect(JSON.stringify(h.requests)).not.toContain('FILE_MUST_NOT_REACH_MODEL');
});
it.skipIf(!executable)('Gemini: cancels a hung request', async () => {
  const h = await fixture('hang'); await expect(h.run(AbortSignal.timeout(1500))).rejects.toThrow('invocation_aborted');
});
it.skipIf(!executable)('Gemini: rejects unsolicited host tools without executing them', async () => {
  const h = await fixture('hostile'); await expect(h.run()).rejects.toThrow('native_host_request_forbidden');
  expect(existsSync(join(h.root, 'must-not-exist'))).toBe(false);
});
it.skipIf(!executable)('Gemini: validates the returned schema locally', async () => {
  const h = await fixture('invalid'); await expect(h.run()).rejects.toThrow('output_schema_mismatch');
});
