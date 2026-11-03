import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../src/services/constrained-invocation/codex-runtime.js', async original => ({
  ...await original<typeof import('../src/services/constrained-invocation/codex-runtime.js')>(),
  runCodexInvocation: vi.fn(async (request: any) => ({ output: { content: JSON.parse(request.prompt.split('CHAT_REQUEST_JSON:\n')[1]).messages[0].content, tool_calls: [] }, configuredModel: request.model, actualModel: null, reasoningEffort: null, usage: null, usageSource: null, startupMs: 1 })),
}));
vi.mock('../src/utils/daemon-discovery.js', async original => ({ ...await original<typeof import('../src/utils/daemon-discovery.js')>(), findOnlineDaemon: vi.fn() }));
vi.mock('../src/core/daemon-ipc-auth.js', async original => {
  const mod = await original<typeof import('../src/core/daemon-ipc-auth.js')>();
  return { ...mod, fetchDaemonIpc: (port: number, path: string, init: RequestInit) => mod.fetchDaemonIpc(port, path, init, 'proxy-ipc-synthetic-secret') };
});
import { startIpcServer, setLarkAppId, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { registerBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { closeConstrainedInvocations } from '../src/services/constrained-invocation/daemon.js';
import { runCodexInvocation } from '../src/services/constrained-invocation/codex-runtime.js';
import { findOnlineDaemon } from '../src/utils/daemon-discovery.js';
import { ipcInvocationBackend } from '../src/services/model-proxy/backend.js';
import { startModelProxy } from '../src/services/model-proxy/server.js';
import { proxyClients, proxyConfigSchema } from '../src/services/model-proxy/config.js';
let ipc: IpcServerHandle | undefined;
let proxy: Awaited<ReturnType<typeof startModelProxy>> | undefined;
afterEach(async () => { await proxy?.close(); await closeConstrainedInvocations(); await ipc?.close(); __testOnly_resetBotRegistry(); setIpcAuthSecret(null); vi.clearAllMocks(); });
it('public HTTP routes to the configured dedicated Bot through real authenticated IPC', async () => {
  registerBot({ larkAppId: 'proxy_fixture', larkAppSecret: '', apiOnly: true, cliId: 'codex', codexAuthSync: 'isolated' } as any);
  setLarkAppId('proxy_fixture'); setIpcAuthSecret('proxy-ipc-synthetic-secret');
  ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true, coreOnlyPublicRoutes: true });
  vi.mocked(findOnlineDaemon).mockReturnValue({ larkAppId: 'proxy_fixture', ipcPort: ipc.port });
  const config = proxyConfigSchema.parse({ port: 0, models: { review: { bot: 'proxy_fixture', model: 'native-model', deadlineMs: 2000 } }, clients: [{ id: 'review-client', tokenEnv: 'SYNTHETIC_TOKEN', models: ['review'] }] });
  const token = 'synthetic-token-for-model-proxy-ipc-test';
  proxy = await startModelProxy({ config, clients: proxyClients(config, { SYNTHETIC_TOKEN: token }), backend: bot => ipcInvocationBackend(bot, '/synthetic-data-dir') });
  const call = (extra = {}) => fetch(`http://127.0.0.1:${proxy!.port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'ipc-round' }, body: JSON.stringify({ model: 'review', messages: [{ role: 'user', content: 'hello' }], ...extra }) });
  const first = await call({ max_completion_tokens: null }); expect(first.status).toBe(200);
  const response = await first.json() as any;
  expect(response.choices[0].message.content).toBe('hello'); expect(response.model).toBe('review');
  expect(response.botmux.configured_model).toBe('native-model');
  expect(await (await call()).json()).toEqual(response);
  expect((await call({ messages: [{ role: 'user', content: 'changed' }] })).status).toBe(409);
  for (const limit of [1, 4096, 128_000]) {
    const rejected = await call({ max_completion_tokens: limit });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: 'max_completion_tokens_unsupported' } });
  }
  for (const limit of [0, -1, 1.5, 128_001, '4096', false, {}, []]) {
    const rejected = await call({ max_completion_tokens: limit });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: 'unsupported_or_invalid_parameter' } });
  }
  expect(runCodexInvocation).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runCodexInvocation).mock.calls[0][0]).not.toHaveProperty('maxOutputTokens');
  expect(vi.mocked(runCodexInvocation).mock.calls[0][1].ownerOpenId).toBeUndefined();
  expect(vi.mocked(runCodexInvocation).mock.calls[0][1].authHome).toContain('proxy_fixture');
});
it('does not accept a daemon discovered by fuzzy name as an identity match', () => {
  vi.mocked(findOnlineDaemon).mockReturnValue({ larkAppId: 'different_bot', ipcPort: 1234 });
  expect(() => ipcInvocationBackend('requested_bot', '/synthetic')).toThrow('inference_profile_offline');
});
