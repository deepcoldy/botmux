import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runMinimaxAcp } from '../src/services/minimax-acp.js';
import { collectNativePrint } from '../src/services/constrained-invocation/print-process.js';
import { readRequestBodyJson } from './helpers/read-request-body.js';
import { resolveNodeExecutable } from './helpers/ts-runner.js';

const executable = process.env.BOTMUX_MCODE_E2E_BIN;
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

it.skipIf(!executable).each([
  ['account', 'http'], ['account', 'stdio'], ['project', 'http'], ['project', 'stdio'],
  ['native-options', 'http'],
] as const)('real mcode discovers and invokes a %s %s MCP tool across exact-ID recovery', async (source, transport) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-native-mcp-'))); roots.push(root);
  const cwd = join(root, 'work'); const dataDir = join(root, 'account'); const home = join(root, 'home');
  for (const dir of [cwd, dataDir, home]) mkdirSync(dir, { mode: 0o700 });
  const marker = `MCP_PROOF_${randomUUID().replaceAll('-', '')}`;
  const calls = join(root, 'mcp-calls.jsonl');
  const definitions = [{ name: 'proof', description: 'Return a local test proof marker.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } }];
  const mcpMethods: string[] = [];
  const mcpUrl = await listen(createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    if (req.headers.authorization !== 'Bearer synthetic-mcp-only') { res.writeHead(401).end(); return; }
    const body = await readRequestBodyJson<any>(req);
    if (!body) { res.writeHead(400).end(); return; }
    mcpMethods.push(body.method);
    if (body.id === undefined) { res.writeHead(202).end(); return; }
    let result: unknown;
    if (body.method === 'initialize') result = { protocolVersion: body.params.protocolVersion,
      serverInfo: { name: 'botmux-mcp-fixture', version: '1' }, capabilities: { tools: {} } };
    else if (body.method === 'tools/list') result = { tools: definitions };
    else if (body.method === 'tools/call') {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(calls, JSON.stringify(body.params) + '\n');
      result = { content: [{ type: 'text', text: marker }] };
    } else if (body.method === 'ping') result = {};
    else { res.writeHead(400).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  }));
  const seenTools: string[][] = [];
  let searches = 0;
  let proofRequests = 0;
  let requiredCalls = 1;
  const modelUrl = await listen(createServer(async (req, res) => {
    const body = await readRequestBodyJson<any>(req);
    if (!body) { res.writeHead(400).end(); return; }
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'fixture-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }] })); return;
    }
    const tools = (body.tools ?? []).map((tool: any) => tool.function);
    seenTools.push(tools.map((tool: any) => tool.name));
    const context = JSON.stringify(body.messages);
    const previousCalls = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    const target = tools.find((tool: any) => /proof/.test(tool.name));
    const search = tools.find((tool: any) => tool.name === 'tool_search');
    let call: { name: string; arguments: string } | undefined;
    let content = 'MCP_TOOL_NOT_AVAILABLE';
    if (context.includes(marker) && previousCalls >= requiredCalls) content = marker;
    else if (target && ++proofRequests <= 4) call = { name: target.name, arguments: '{}' };
    else if (search && ++searches <= 4) call = { name: search.name, arguments: JSON.stringify({ query: 'proof', max_results: 5 }) };
    const deltas = call ? [
      { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `proof-${randomUUID()}`, type: 'function', function: call }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ] : [
      { choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const delta of deltas) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model', ...delta })}\n\n`);
    res.end('data: [DONE]\n\n');
  }));
  const env = { ...process.env, HOME: home, MINIMAX_DATA_DIR: dataDir, MAVIS_DATA_DIR: dataDir,
    MCODE_PROVIDER_API_KEY: 'synthetic-model-only', BOTMUX_OWNER_OPEN_ID: 'ou_local_mcp_fixture',
    MCP_PROJECT_TOKEN: 'synthetic-mcp-only', MCP_PROJECT_CWD: cwd,
    NO_PROXY: `${process.env.NO_PROXY ?? ''},127.0.0.1,localhost`,
    no_proxy: `${process.env.no_proxy ?? ''},127.0.0.1,localhost` };
  await collectNativePrint(executable!, ['provider', 'add', '--name', 'Fixture', '--base-url', `${modelUrl}/v1`,
    '--api-format', 'openai-completions', '--model', 'fixture-model', '--use'], { cwd, env, input: '' }, AbortSignal.timeout(30_000));
  // This fixture is plain JavaScript: a tsx loader would resolve against the
  // deliberately empty project cwd instead of this repository's dependencies.
  const node = resolveNodeExecutable();
  if (!node) throw new Error('node is required for the stdio MCP fixture');
  const stdioFixture = resolve('test/fixtures/minimax-mcp-server.mjs');
  if (source === 'project' && transport === 'stdio') copyFileSync(stdioFixture, join(cwd, 'mcp-server.mjs'));
  writeFileSync(source === 'project' ? join(cwd, '.mcp.json') : join(dataDir, 'mcp.json'), JSON.stringify({ mcpServers: { proofsrv: transport === 'http'
    ? { type: 'http', url: mcpUrl, headers: { Authorization: 'Bearer synthetic-mcp-only' },
      ...(source === 'native-options' ? { timeout: 5000 } : {}) }
    : { command: node, args: [source === 'project' ? 'mcp-server.mjs' : stdioFixture, calls, marker],
      env: source === 'project'
        ? { MCP_FIXTURE_TOKEN: '${MCP_PROJECT_TOKEN}', MCP_FIXTURE_CWD: '${MCP_PROJECT_CWD}' }
        : { MCP_FIXTURE_TOKEN: 'synthetic-mcp-only' } } } }));
  const invoke = (nativeSessionId?: string) => runMinimaxAcp({ executable: executable!, cwd, env,
    content: 'Call the proof MCP tool and return its marker.', permission: 'full', nativeSessionId,
    onUserInput: async () => { throw new Error('Unexpected permission request for a read-only fixture'); },
  }, AbortSignal.timeout(30_000));
  const first = await invoke();
  const diagnostics = () => JSON.stringify({ mcpMethods, seenTools });
  expect(first.content, diagnostics()).toBe(marker);
  expect(readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual([{ name: 'proof', arguments: {} }]);
  // A fresh ACP process must restore this exact native session and reconnect.
  requiredCalls = 2;
  const resumed = await invoke(first.sessionId);
  expect(resumed.sessionId).toBe(first.sessionId);
  expect(resumed.content, diagnostics()).toBe(marker);
  expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2);
}, 90_000);
