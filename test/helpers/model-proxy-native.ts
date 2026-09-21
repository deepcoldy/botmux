import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIsolatedClaude } from '../../src/services/constrained-invocation/claude-runtime.js';
import { InvocationService } from '../../src/services/constrained-invocation/service.js';
import { startModelProxy } from '../../src/services/model-proxy/server.js';
import { proxyClients, proxyConfigSchema } from '../../src/services/model-proxy/config.js';
import type { ChatRequest } from '../../src/services/model-proxy/protocol.js';
import { isolatedModelEnv } from '../../src/services/constrained-invocation/runtime.js';

/** Genuine CLI, synthetic Anthropic provider; no user credentials or projects.
 * A new native HOME/work directory per invocation preserves concurrent isolation. */
export async function nativeProxyFixture(executable: string, reply: (chat: ChatRequest) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-proxy-native-'));
  const chats: ChatRequest[] = []; const nativeRequests: any[] = []; const failures: string[] = []; const pids: number[] = [];
  const native = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      if (!req.url?.includes('/messages')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString()); nativeRequests.push(body);
      const texts = body.messages.flatMap((m: any) => typeof m.content === 'string' ? [m.content] : m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text));
      const prompt = texts.find((t: string) => t.includes('CHAT_REQUEST_JSON:\n'));
      const chat = JSON.parse(prompt.split('CHAT_REQUEST_JSON:\n')[1]); chats.push(chat);
      const output = reply(chat);
      if (output === undefined) return; // Deliberately hung provider for cancellation.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { type: 'message_start', message: { id: 'fixture-message', type: 'message', role: 'assistant', content: [], model: body.model, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'serialization', name: 'StructuredOutput', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(output) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    } catch (error) { failures.push(String(error)); res.writeHead(500); res.end('{}'); }
  });
  await new Promise<void>((resolve, reject) => { native.once('error', reject); native.listen(0, '127.0.0.1', resolve); });
  const nativePort = (native.address() as { port: number }).port;
  const service = new InvocationService({ directory: join(root, 'records'), run: async (request, signal) => {
    const dir = mkdtempSync(join(root, 'invocation-'));
    for (const name of ['home', 'work', 'claude']) mkdirSync(join(dir, name), { mode: 0o700 });
    const env = isolatedModelEnv(join(dir, 'home'), { PATH: process.env.PATH, NO_PROXY: '127.0.0.1' });
    Object.assign(env, { CLAUDE_CONFIG_DIR: join(dir, 'claude'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${nativePort}`, ANTHROPIC_API_KEY: 'synthetic-no-real-credential', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
    try { return await runIsolatedClaude(request, { executable, cwd: join(dir, 'work'), env, onSpawn: pid => pids.push(pid) }, signal); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  } });
  const token = 'synthetic-client-credential-32-characters';
  const config = proxyConfigSchema.parse({ port: 0, models: { reasoner: { bot: 'fixture', model: 'claude-sonnet-4-5', deadlineMs: 15000 } }, clients: [{ id: 'fixture', tokenEnv: 'FIXTURE_TOKEN', models: ['reasoner'] }] });
  const proxy = await startModelProxy({ config, clients: proxyClients(config, { FIXTURE_TOKEN: token }), backend: () => ({ capabilities: async () => ({ supported: true, maxOutputTokens: true }), start: async request => service.start(request), get: async id => service.get(id)!, cancel: id => service.cancel(id) }) });
  return { root, chats, nativeRequests, failures, pids, token, baseURL: `http://127.0.0.1:${proxy.port}/v1`, async close() {
    await proxy.close(); await service.close(); native.closeAllConnections(); await new Promise<void>(resolve => native.close(() => resolve())); rmSync(root, { recursive: true, force: true });
  } };
}
