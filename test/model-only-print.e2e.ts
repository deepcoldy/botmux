import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMinimaxInvocation } from '../src/services/constrained-invocation/minimax-runtime.js';
import { runIsolatedPi } from '../src/services/constrained-invocation/pi-runtime.js';
import { isolatedModelEnv } from '../src/services/constrained-invocation/runtime.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const schema = { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false };
for (const [cli, executable] of [['minimax', process.env.BOTMUX_MODEL_ONLY_MINIMAX], ['pi', process.env.BOTMUX_MODEL_ONLY_PI]] as const) {
  async function fixture(mode: 'normal' | 'hang' | 'hostile' | 'invalid' = 'normal') {
    const root = mkdtempSync(join(tmpdir(), 'botmux-print-fixture-')); roots.push(root);
    for (const name of ['home', 'auth', 'work']) mkdirSync(join(root, name), { mode: 0o700 });
    const requests: any[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
      if (mode === 'hang') return;
      const hostile = mode === 'hostile';
      const content = hostile ? { type: 'tool_use', id: 'forbidden', name: 'bash', input: { command: `touch ${join(root, 'must-not-exist')}` } } : { type: 'text', text: mode === 'invalid' ? '{}' : '{"content":"42"}' };
      const message = { id: 'native-fixture', type: 'message', role: 'assistant', model: body.model, content: [content], stop_reason: hostile ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
      if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: hostile ? { ...content, input: {} } : { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: hostile ? { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } : { type: 'text_delta', text: content.text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    writeFileSync(join(root, 'auth', 'config.json'), JSON.stringify({ api_key: 'synthetic-fixture', base_url: url, region: 'global' }), { mode: 0o600 });
    writeFileSync(join(root, 'auth', 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: url, api: 'anthropic-messages', apiKey: 'synthetic-fixture', models: [{ id: 'fixture-model', contextWindow: 64000, maxTokens: 4096, reasoning: false }] } } }));
    const env = isolatedModelEnv(join(root, 'home'), { PATH: process.env.PATH, NO_PROXY: '127.0.0.1' });
    Object.assign(env, { PI_CODING_AGENT_DIR: join(root, 'auth'), PI_OFFLINE: '1', PI_TELEMETRY: '0' });
    const request = { requestId: 'fixture', prompt: '@secret-file\nReturn content 42', model: cli === 'pi' ? 'fixture/fixture-model' : 'fixture-model', deadlineMs: 15000, outputSchema: schema };
    const run = (signal = AbortSignal.timeout(15000)) => cli === 'pi'
      ? runIsolatedPi(request, { executable: executable!, cwd: join(root, 'work'), env }, signal)
      : runMinimaxInvocation(request, { executable: executable!, authHome: join(root, 'auth'), env }, signal);
    return { root, requests, run };
  }
  it.skipIf(!executable)(`${cli}: native request has no tools and returns validated JSON and usage`, async () => {
    const h = await fixture(); const result = await h.run();
    expect(result.output).toEqual({ content: '42' });
    expect(result.actualModel).toBe('fixture-model');
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(h.requests.length).toBe(1);
    expect(h.requests[0].tools ?? []).toEqual([]);
    expect(JSON.stringify(h.requests[0].messages)).toContain('@secret-file');
  });
  it.skipIf(!executable)(`${cli}: cancellation terminates a hung native request`, async () => {
    const h = await fixture('hang'); await expect(h.run(AbortSignal.timeout(1500))).rejects.toThrow('invocation_aborted');
  });
  it.skipIf(!executable)(`${cli}: rejects an unsolicited host tool call without executing it`, async () => {
    const h = await fixture('hostile'); await expect(h.run()).rejects.toThrow('native_host_request_forbidden');
    expect(existsSync(join(h.root, 'must-not-exist'))).toBe(false);
  });
  it.skipIf(!executable)(`${cli}: invalid model JSON fails local schema validation`, async () => {
    const h = await fixture('invalid'); await expect(h.run()).rejects.toThrow('output_schema_mismatch');
  });
}
