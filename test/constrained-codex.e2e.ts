import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIsolatedCodex, isolatedCatalog, isolatedInvocationEnv } from '../src/services/constrained-invocation/codex-runtime.js';
import { CONSTRAINED_CODEX_CONFIG } from '../src/services/constrained-invocation/codex-profile.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import type { InvocationRequest } from '../src/services/constrained-invocation/contract.js';

// Opt-in real Codex, fake provider, synthetic input, no auth and no IM traffic.
const executable = process.env.BOTMUX_CONSTRAINED_CODEX;
const ocrPath = process.env.BOTMUX_MODEL_PROXY_OCR;
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const schema = {
  type: 'object', properties: {
    content: { type: 'string' },
    tool_calls: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'string' } }, required: ['name', 'arguments'], additionalProperties: false } },
  }, required: ['content', 'tool_calls'], additionalProperties: false,
};
async function harness(reply: (body: any, index: number) => any, model = 'gpt-5.5', responsesLite = false) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-native-fixture-')); roots.push(root);
  for (const name of ['home', 'codex', 'work']) mkdirSync(join(root, name), { mode: 0o700 });
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const buffers: Buffer[] = [];
    for await (const chunk of req) buffers.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(buffers).toString()); requests.push(body);
    const item = reply(body, requests.length);
    if (item === null) return; // intentional hang for deadline/cancel
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const response = { id: `response-${requests.length}`, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 3 } } };
    for (const event of [
      { type: 'response.created', response: { id: response.id } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  // Synthetic native metadata deliberately advertises tools and code mode.
  // Exercise the same catalog normalization used in production without auth.
  const catalog = isolatedCatalog({ models: [{
    slug: model, display_name: 'Fixture', description: 'Synthetic test model',
    default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'high', description: 'Fixture' }],
    shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 0,
    base_instructions: 'Return the requested structured answer.',
    support_verbosity: false, default_reasoning_summary: 'none',
    truncation_policy: { mode: 'tokens', limit: 10000 }, context_window: 272000,
    experimental_supported_tools: ['clock', 'send_user_message_async'],
    tool_mode: 'code_mode_only', use_responses_lite: responsesLite,
    input_modalities: ['text'],
  }] }, model);
  const catalogPath = join(root, 'models.json');
  writeFileSync(catalogPath, JSON.stringify(catalog));
  writeFileSync(join(root, 'codex', 'config.toml'), `model_catalog_json=${JSON.stringify(catalogPath)}\nmodel_provider="fixture"\n${CONSTRAINED_CODEX_CONFIG}\n[model_providers.fixture]\nname="fixture"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
  const run = (prompt: string, signal = AbortSignal.timeout(15_000)) => runIsolatedCodex({ requestId: 'fixture', prompt, model, deadlineMs: 15_000, outputSchema: schema } as InvocationRequest, {
    executable: executable!, cwd: join(root, 'work'), env: isolatedInvocationEnv(join(root, 'home'), join(root, 'codex'), { PATH: process.env.PATH, NO_PROXY: '127.0.0.1' }),
  }, signal);
  return { run, requests, root };
}
const assistant = (value: unknown) => ({ type: 'message', role: 'assistant', id: 'fixture-final', content: [{ type: 'output_text', text: JSON.stringify(value) }] });

it.skipIf(!executable)('forwards a caller-selected model to native inference without adding host tools', async () => {
  const h = await harness(() => assistant({ content: 'done', tool_calls: [] }), 'fixture-reasoner');
  const result = await h.run('Return JSON');
  expect(result.configuredModel).toBe('fixture-reasoner');
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0].model).toBe('fixture-reasoner');
  expect(h.requests[0].tools).toEqual([]);
});

it.skipIf(!executable).each([false, true])('real native runtime has no host tools and rejects a forced shell call (Responses Lite: %s)', async responsesLite => {
  let marker = '';
  const h = await harness((_body, index) => index === 1
    ? { type: 'function_call', call_id: 'hostile-call', name: 'exec_command', arguments: JSON.stringify({ cmd: `touch ${marker}` }) }
    : assistant({ content: 'done', tool_calls: [] }), 'fixture-reasoner', responsesLite);
  marker = join(h.root, 'must-not-exist');
  const result = await h.run('Perform the supplied reasoning.');
  expect(h.requests.length).toBe(2);
  for (const request of h.requests) {
    expect(request.tools ?? []).toEqual([]);
    const toolItems = request.input.filter((item: any) => item.type === 'additional_tools');
    expect(toolItems).toHaveLength(responsesLite ? 1 : 0);
    expect(toolItems.every((item: any) => item.tools.length === 0)).toBe(true);
  }
  expect(existsSync(marker)).toBe(false);
  expect(JSON.stringify(h.requests[1])).toMatch(/unknown|unsupported|unrecognized|not found/i);
  expect(result.usage?.inputTokens).toBe(20);
  expect(result.usage?.outputTokens).toBe(10);
  expect(result.actualModel).toBeNull();
});

it.skipIf(!executable)('external tool proposal roundtrip is schema valid and context isolated', async () => {
  const h = await harness(body => JSON.stringify(body.input).includes('TOOL_RESULT=42')
    ? assistant({ content: '42', tool_calls: [] })
    : assistant({ content: '', tool_calls: [{ name: 'add', arguments: '{"left":19,"right":23}' }] }));
  const first = await h.run('Request a proposal for add(19,23).');
  const proposal = (first.output as any).tool_calls[0];
  const args = JSON.parse(proposal.arguments);
  const toolResult = args.left + args.right; // executed by this external fixture
  const second = await h.run(`Prior proposal: ${JSON.stringify(first.output)}\nTOOL_RESULT=${toolResult}`);
  expect(second.output).toEqual({ content: '42', tool_calls: [] });
  expect(second.usage?.inputTokens).toBe(10); // fresh native thread, no prior total
  expect(h.requests.every(request => request.tools.length === 0)).toBe(true);
});

it.skipIf(!executable)('rejects schema-invalid native output', async () => {
  const h = await harness(() => assistant({ content: 42, tool_calls: [] }));
  await expect(h.run('Return JSON')).rejects.toThrow('output_schema_mismatch');
});

it.skipIf(!executable)('cancels a hung native model request and returns only after process exit', async () => {
  const h = await harness(() => null);
  await expect(h.run('Wait forever', AbortSignal.timeout(700))).rejects.toThrow('invocation_aborted');
});

it.skipIf(!executable)('native worker exits on owner process death instead of becoming an orphan', async () => {
  const h = await harness(() => null);
  const params = { executable, cwd: join(h.root, 'work'), env: isolatedInvocationEnv(join(h.root, 'home'), join(h.root, 'codex'), { PATH: process.env.PATH, NO_PROXY: '127.0.0.1' }) };
  const request = { requestId: 'parent-death', prompt: 'Wait', model: 'gpt-5.5', deadlineMs: 15000, outputSchema: schema };
  const parent = spawnTsEvalWithRepoImports(`
    import { runIsolatedCodex } from './src/services/constrained-invocation/codex-runtime.js';
    await runIsolatedCodex(${JSON.stringify(request)}, { ...${JSON.stringify(params)}, onSpawn: pid => console.log(pid) }, AbortSignal.timeout(15000));
  `, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  const nativePid = await new Promise<number>((resolve, reject) => {
    parent.stdout!.once('data', data => resolve(Number(String(data).trim())));
    parent.once('error', reject);
  });
  try {
    await viWait(() => h.requests.length > 0);
    parent.kill('SIGKILL');
    await viWait(() => { try { process.kill(nativePid, 0); return false; } catch { return true; } });
  } finally {
    parent.kill('SIGKILL');
    try { process.kill(-nativePid, 'SIGKILL'); } catch { /* gone */ }
  }
});
async function viWait(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('process_lifecycle_timeout');
}

it.skipIf(!executable || !process.env.BOTMUX_MODEL_PROXY_OPENAI_SDK)('ordinary SDK uses the public proxy for a Codex text/tool roundtrip', async () => {
  const { InvocationService } = await import('../src/services/constrained-invocation/service.js');
  const { proxyConfigSchema, proxyClients } = await import('../src/services/model-proxy/config.js');
  const { startModelProxy } = await import('../src/services/model-proxy/server.js');
  const { pathToFileURL } = await import('node:url');
  const { default: OpenAI } = await import(pathToFileURL(process.env.BOTMUX_MODEL_PROXY_OPENAI_SDK!).href);
  const chats: any[] = [];
  const h = await harness(body => {
    const text = body.input.flatMap((m: any) => m.content ?? []).find((c: any) => c.text?.includes('CHAT_REQUEST_JSON:\n'))?.text;
    const chat = JSON.parse(text.split('CHAT_REQUEST_JSON:\n')[1]); chats.push(chat);
    return assistant(!chat.tools?.length ? { content: 'hello', tool_calls: [] }
      : chat.messages.at(-1).role === 'tool' ? { content: '42', tool_calls: [] }
        : { content: '', tool_calls: [{ name: 'add', arguments: '{"left":19,"right":23}' }] });
  });
  const service = new InvocationService({ directory: join(h.root, 'records'), run: (request, signal) => h.run(request.prompt, signal) });
  const config = proxyConfigSchema.parse({ port: 0, models: { reasoner: { bot: 'fixture', model: 'gpt-5.5', deadlineMs: 15000 } }, clients: [{ id: 'fixture', tokenEnv: 'FIXTURE_TOKEN', models: ['reasoner'] }] });
  const token = 'synthetic-codex-proxy-token-at-least-32';
  const proxy = await startModelProxy({ config, clients: proxyClients(config, { FIXTURE_TOKEN: token }), backend: () => ({ capabilities: async () => ({ supported: true }), start: async request => service.start(request), get: async id => service.get(id)!, cancel: id => service.cancel(id) }) });
  try {
    const sdk = new OpenAI({ baseURL: `http://127.0.0.1:${proxy.port}/v1`, apiKey: token, maxRetries: 0 });
    const text = await sdk.chat.completions.create({ model: 'reasoner', messages: [{ role: 'user', content: 'hello' }] });
    expect(text.choices[0].message.content).toBe('hello');
    const messages: any[] = [{ role: 'system', content: 'Use the external calculator.' }, { role: 'user', content: '19 + 23' }];
    const tools = [{ type: 'function', function: { name: 'add', parameters: { type: 'object', properties: { left: { type: 'integer' }, right: { type: 'integer' } }, required: ['left', 'right'] } } }];
    const first = await sdk.chat.completions.create({ model: 'reasoner', messages, tools, tool_choice: 'required' });
    const call = first.choices[0].message.tool_calls[0]; const args = JSON.parse(call.function.arguments);
    messages.push(first.choices[0].message, { role: 'tool', tool_call_id: call.id, content: String(args.left + args.right) });
    const last = await sdk.chat.completions.create({ model: 'reasoner', messages, tools, tool_choice: 'none' });
    expect(last.choices[0].message.content).toBe('42'); expect(chats[2].messages).toEqual(messages);
    expect(h.requests.every(r => r.tools.length === 0)).toBe(true); expect(h.requests).toHaveLength(3);
    expect(last.usage).toBeNull(); expect(last.botmux.native_invocation_usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  } finally { await proxy.close(); await service.close(); }
});

it.skipIf(!executable || !ocrPath)('OCR native config sends a null budget through the public proxy to Codex', async () => {
  const { InvocationService } = await import('../src/services/constrained-invocation/service.js');
  const { proxyConfigSchema, proxyClients } = await import('../src/services/model-proxy/config.js');
  const { startModelProxy } = await import('../src/services/model-proxy/server.js');
  const chats: any[] = []; const invocations: InvocationRequest[] = []; const wire: any[] = [];
  const h = await harness(body => {
    const text = body.input.flatMap((m: any) => m.content ?? []).find((c: any) => c.text?.includes('CHAT_REQUEST_JSON:\n'))?.text;
    const chat = JSON.parse(text.split('CHAT_REQUEST_JSON:\n')[1]); chats.push(chat);
    if (JSON.stringify(chat.messages.filter((m: any) => m.role === 'system')).includes('task planning')) {
      return assistant({ content: 'Summary: Review the synthetic arithmetic module.\n\nIssues\n\n1. [low] Verify addition.\n   → file_read math.ts — inspect the module', tool_calls: [] });
    }
    if (!chat.tools?.length) return assistant({ content: '[]', tool_calls: [] });
    return assistant({ content: '', tool_calls: chat.messages.some((m: any) => m.role === 'tool')
      ? [{ name: 'task_done', arguments: '{"state":"DONE"}' }]
      : [{ name: 'file_read', arguments: '{"file_path":"math.ts"}' }] });
  });
  const service = new InvocationService({ directory: join(h.root, 'records'), run: (request, signal) => {
    invocations.push(request); return h.run(request.prompt, signal);
  } });
  const config = proxyConfigSchema.parse({ port: 0, models: { reasoner: { bot: 'fixture', model: 'gpt-5.5', deadlineMs: 15000 } }, clients: [{ id: 'ocr', tokenEnv: 'FIXTURE_TOKEN', models: ['reasoner'] }] });
  const token = 'synthetic-ocr-codex-token-at-least-32';
  const proxy = await startModelProxy({ config, clients: proxyClients(config, { FIXTURE_TOKEN: token }), backend: () => ({ capabilities: async () => ({ supported: true, maxOutputTokens: false }), start: async request => service.start(request), get: async id => service.get(id)!, cancel: id => service.cancel(id) }) });
  // Observe the actual HTTP body before request parsing/normalization.
  proxy.server.on('request', req => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(Buffer.from(c)));
    req.on('end', () => wire.push(JSON.parse(Buffer.concat(chunks).toString())));
  });
  try {
    const repo = join(h.root, 'review-repo'); const home = join(h.root, 'ocr-home');
    mkdirSync(repo); mkdirSync(home); mkdirSync(join(home, '.opencodereview'));
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'Synthetic baseline'], { cwd: repo });
    writeFileSync(join(repo, 'math.ts'), 'export function add(left: number, right: number): number {\n  return left + right;\n}\n' + Array.from({ length: 65 }, (_, i) => `export const fixture${i} = ${i};`).join('\n') + '\n');
    const env = { PATH: process.env.PATH, HOME: home, NO_PROXY: '127.0.0.1' };
    // Use OCR's own configuration API; its released source and loop are unchanged.
    // OCR_LLM_* would take precedence over this block and omit its extra_body.
    for (const [key, value] of Object.entries({
      'llm.url': `http://127.0.0.1:${proxy.port}/v1`, 'llm.auth_token': token,
      'llm.model': 'reasoner', 'llm.protocol': 'openai', 'llm.extra_body': '{"max_completion_tokens":null}',
    })) execFileSync(ocrPath!, ['config', 'set', key, value], { cwd: repo, env, timeout: 10000 });
    const resultPath = join(h.root, 'review.json');
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(ocrPath!, ['review', '--repo', repo, '--audience', 'agent', '--format', 'json', '--concurrency', '1', '--timeout', '2', '--output', resultPath], { cwd: repo, env });
      let stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
      child.stdout.resume(); child.stderr.on('data', c => stderr += c);
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('close', code => { clearTimeout(timer); resolve({ code, stderr }); });
    });
    expect(result.code, result.stderr + '\n' + JSON.stringify({ wireLimits: wire.map(r => r.max_completion_tokens), accepted: invocations.length })).toBe(0);
    const report = JSON.parse(readFileSync(resultPath, 'utf8'));
    expect(report.status).toBe('complete');
    expect(report.tool_calls.failure).toBe(0);
    expect(report.tool_calls.by_tool.file_read).toBe(1);
    expect(report.manifest.coverage.selected.map((v: any) => v.path)).toEqual(['math.ts']);
    expect(report.manifest.coverage.completed).toEqual(report.manifest.coverage.selected);
    expect(report.manifest.coverage.failed).toEqual([]); expect(report.manifest.coverage.waived).toEqual([]);
    expect(wire.length).toBeGreaterThan(0);
    expect(wire.every(r => Object.hasOwn(r, 'max_completion_tokens') && r.max_completion_tokens === null)).toBe(true);
    expect(invocations).toHaveLength(wire.length);
    expect(invocations.every(r => !Object.hasOwn(r, 'maxOutputTokens'))).toBe(true);
    expect(chats.some(c => JSON.stringify(c.messages).includes('task planning'))).toBe(true);
    expect(chats.some(c => c.messages.some((m: any) => m.role === 'tool' && m.content.includes('return left + right')))).toBe(true);
    expect(h.requests.every(r => r.tools.length === 0)).toBe(true);
    if (process.env.BOTMUX_MODEL_PROXY_CODEX_OCR_EVIDENCE) writeFileSync(process.env.BOTMUX_MODEL_PROXY_CODEX_OCR_EVIDENCE, JSON.stringify({ report, wire, invocations, nativeTools: h.requests.map(r => r.tools) }, null, 2));
  } finally { await proxy.close(); await service.close(); }
}, 120000);
