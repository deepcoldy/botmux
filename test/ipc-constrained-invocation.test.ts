import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../src/services/constrained-invocation/codex-runtime.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/constrained-invocation/codex-runtime.js')>(),
  runCodexInvocation: vi.fn(async (request: any) => ({ output: { content: request.prompt }, configuredModel: request.model, actualModel: null, reasoningEffort: null, usage: null, usageSource: null, startupMs: 1 })),
}));
vi.mock('../src/services/constrained-invocation/claude-runtime.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/constrained-invocation/claude-runtime.js')>(),
  runClaudeInvocation: vi.fn(async (request: any) => ({ output: { content: request.prompt }, configuredModel: request.model, actualModel: null, reasoningEffort: null, usage: null, usageSource: null, startupMs: 1 })),
}));
vi.mock('../src/services/constrained-invocation/pi-runtime.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/constrained-invocation/pi-runtime.js')>(),
  runPiInvocation: vi.fn(async (request: any) => ({ output: { content: request.prompt }, configuredModel: request.model, actualModel: null, reasoningEffort: null, usage: null, usageSource: null, startupMs: 1 })),
}));
vi.mock('../src/services/constrained-invocation/minimax-runtime.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/constrained-invocation/minimax-runtime.js')>(),
  runMinimaxInvocation: vi.fn(async (request: any) => ({ output: { content: request.prompt }, configuredModel: request.model, actualModel: null, reasoningEffort: null, usage: null, usageSource: null, startupMs: 1 })),
}));
vi.mock('../src/services/constrained-invocation/gemini-runtime.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/constrained-invocation/gemini-runtime.js')>(),
  runGeminiInvocation: vi.fn(async (request: any) => ({ output: { content: request.prompt }, configuredModel: request.model, actualModel: null, reasoningEffort: null, usage: null, usageSource: null, startupMs: 1 })),
}));
vi.mock('../src/services/constrained-invocation/opencode-runtime.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/constrained-invocation/opencode-runtime.js')>(),
  runOpenCodeInvocation: vi.fn(async (request: any) => ({ output: { content: request.prompt }, configuredModel: request.model, actualModel: null, reasoningEffort: null, usage: null, usageSource: null, startupMs: 1 })),
}));
import { startIpcServer, setLarkAppId, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { registerBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import { closeConstrainedInvocations } from '../src/services/constrained-invocation/daemon.js';
import { runCodexInvocation } from '../src/services/constrained-invocation/codex-runtime.js';
import { runClaudeInvocation } from '../src/services/constrained-invocation/claude-runtime.js';
import { ALL_CLI_IDS } from '../src/adapters/cli/registry.js';

let server: IpcServerHandle | undefined;
const secret = 'constrained-invocation-test-secret';
afterEach(async () => { await closeConstrainedInvocations(); await server?.close(); server = undefined; __testOnly_resetBotRegistry(); setIpcAuthSecret(null); vi.clearAllMocks(); });
async function start(cliId = 'codex') {
  registerBot({ larkAppId: 'local_fixture', larkAppSecret: '', apiOnly: true, cliId, codexAuthSync: 'isolated' } as any);
  setLarkAppId('local_fixture'); setIpcAuthSecret(secret);
  server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true, coreOnlyPublicRoutes: true });
  return server;
}
const request = { requestId: 'ipc-round', prompt: 'Synthetic fixture', model: 'fixture-reasoner', deadlineMs: 1000, outputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } };
it('requires host authentication even with core-only public routes enabled', async () => {
  const s = await start();
  for (const [method, path] of [['GET', '/capabilities'], ['POST', ''], ['GET', '/ipc-round'], ['POST', '/ipc-round/cancel']]) {
    const response = await fetch(`http://127.0.0.1:${s.port}/api/headless/invocations${path}`, { method });
    expect(response.status).toBe(401);
  }
  expect(runCodexInvocation).not.toHaveBeenCalled();
});
it.each(['codex', 'codex-app', 'claude-code', 'pi', 'minimax', 'gemini', 'opencode'])('accepts, retrieves and deduplicates with the same contract for %s', async cli => {
  const s = await start(cli); const path = '/api/headless/invocations';
  const run = cli.startsWith('codex') ? runCodexInvocation : cli === 'pi' ? runPiInvocation : cli === 'minimax' ? runMinimaxInvocation : cli === 'gemini' ? runGeminiInvocation : cli === 'opencode' ? runOpenCodeInvocation : runClaudeInvocation;
  const invocation = { ...request, requestId: `round-${cli}` };
  const call = (method: string, target: string, body?: unknown) => fetchDaemonIpc(s.port, target, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }, secret);
  expect((await call('POST', path, invocation)).status).toBe(202);
  const duplicate = await call('POST', path, invocation); expect([200, 202]).toContain(duplicate.status);
  expect((await call('POST', path, { ...invocation, prompt: 'different round' })).status).toBe(409);
  const result = await (await call('GET', `${path}/${invocation.requestId}`)).json() as any;
  expect(result.result.output).toEqual({ content: request.prompt });
  expect(result.result.configuredModel).toBe(request.model);
  expect(run).toHaveBeenCalledTimes(1);
  expect(vi.mocked(run).mock.calls[0][1]).toMatchObject({ ownerOpenId: undefined });
  expect(vi.mocked(run).mock.calls[0][1].authHome).toMatch(new RegExp(`/${cli.startsWith('codex') ? 'codex' : cli === 'claude-code' ? 'claude' : cli}$`));
  expect((await call('POST', path, { ...request, requestId: 'forged-owner', ownerOpenId: 'ou_forged' })).status).toBe(400);
});
it('rejects an unsupported CLI without launching a worker', async () => {
  const s = await start('cursor');
  const response = await fetchDaemonIpc(s.port, '/api/headless/invocations', { method: 'POST', body: JSON.stringify(request), headers: { 'content-type': 'application/json' } }, secret);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: 'constrained_capability_unsupported' });
  expect(runCodexInvocation).not.toHaveBeenCalled();
  expect(runClaudeInvocation).not.toHaveBeenCalled();
});

it('reports the selected CLI and every registered CLI without claiming unsupported adapters work', async () => {
  const s = await start('claude-code');
  const response = await fetchDaemonIpc(s.port, '/api/headless/invocations/capabilities', {}, secret);
  const body = await response.json() as any;
  const capability = body.capability;
  expect(capability).toMatchObject({ cli: 'claude-code', mode: 'model_only', loopOwner: 'caller', supported: true, runtimeVerified: false });
  expect(capability.adapters.map((item: any) => item.cli)).toEqual(ALL_CLI_IDS);
  expect(capability.adapters.find((item: any) => item.cli === 'cursor')).toMatchObject({ supported: false, reason: 'read_only_is_not_model_only' });
});

it.each([
  { backendType: 'tmux', codexInstancePool: { enabled: true, scope: 'ordinary-feishu', strategy: 'random', defaultInstanceId: 'fixture', instances: [{ id: 'fixture', codexHome: `${process.env.HOME}/native-fixture` }] } }, { existingAppServer: { endpoint: 'ws://localhost' } },
  { sandbox: true }, { readIsolation: true }, { backendType: 'tmux' },
  { triggerUserAuth: { enabled: true } }, { maxLiveWorkers: 1 },
])('does not bypass a configured execution or identity policy: %j', async policy => {
  const s = await start();
  registerBot({ larkAppId: 'local_fixture', larkAppSecret: '', apiOnly: true, cliId: 'codex', codexAuthSync: 'isolated', ...policy } as any);
  const response = await fetchDaemonIpc(s.port, '/api/headless/invocations', { method: 'POST', body: JSON.stringify(request), headers: { 'content-type': 'application/json' } }, secret);
  expect(response.status).toBe(400);
  expect(runCodexInvocation).not.toHaveBeenCalled();
});

import { runPiInvocation } from '../src/services/constrained-invocation/pi-runtime.js';

import { runMinimaxInvocation } from '../src/services/constrained-invocation/minimax-runtime.js';

import { runGeminiInvocation } from '../src/services/constrained-invocation/gemini-runtime.js';

import { runOpenCodeInvocation } from '../src/services/constrained-invocation/opencode-runtime.js';
