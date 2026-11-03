/** Exercise naming policy validation, persistence and hot reload through the real IPC routes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as configStore from '../src/services/config-store.js';
import * as registry from '../src/bot-registry.js';

const APP = 'cli_naming_route';
let handle: IpcServerHandle | undefined;
let entry: Record<string, unknown>;
let botConfig: registry.BotConfig;
beforeEach(() => {
  entry = { larkAppId: APP };
  botConfig = { larkAppId: APP, larkAppSecret: 'test', cliId: 'codex' } as registry.BotConfig;
  setLarkAppId(APP);
  vi.spyOn(registry, 'getBot').mockReturnValue({ config: botConfig } as ReturnType<typeof registry.getBot>);
  vi.spyOn(configStore, 'rmwBotEntry').mockImplementation(async (_id, mutate) => {
    const out = mutate(entry, [entry]);
    return { ok: true, result: out?.result };
  });
});
afterEach(async () => { await handle?.close(); handle = undefined; setIpcAuthSecret(null); vi.restoreAllMocks(); });
/** Call the real bound IPC route using an ephemeral local HTTP server. */
async function request(body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  handle ??= await startIpcServer({ port: 0, host: '127.0.0.1' });
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/session-group-naming-config`, body === undefined ? {} : {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
describe('session-group naming configuration', () => {
  it('defaults to AI summary without a model override', async () => {
    expect(await request()).toEqual({ status: 200, body: { ok: true, mode: 'ai-summary', model: '' } });
  });
  it('persists, hot reloads and reads back a mode/model without losing other group fields', async () => {
    entry.sessionGroup = { namePrefix: '项目·', naming: { maxLen: 8 }, tag: { mode: 'off' } };
    botConfig.sessionGroup = structuredClone(entry.sessionGroup) as registry.SessionGroupConfig;
    expect((await request({ mode: 'session-title', model: ' small-model ' })).status).toBe(200);
    expect(entry.sessionGroup).toEqual({ namePrefix: '项目·', naming: { maxLen: 8, mode: 'session-title', model: 'small-model' }, tag: { mode: 'off' } });
    expect((await request()).body).toMatchObject({ mode: 'session-title', model: 'small-model' });
    await request({ mode: 'ai-summary', model: '' });
    expect(botConfig.sessionGroup?.naming).toEqual({ mode: 'ai-summary', maxLen: 8 });
  });
  it.each([{}, null, [[]], { mode: ['ai-summary'] }, { mode: 'unknown' }, { mode: 'truncate', model: 123 }, { mode: 'truncate', model: 'a\nb' }])('rejects invalid input without writing: %j', async body => {
    expect((await request(body)).status).toBe(400);
    expect(configStore.rmwBotEntry).not.toHaveBeenCalled();
  });
  it('does not change runtime policy when persistence fails', async () => {
    vi.mocked(configStore.rmwBotEntry).mockRejectedValue(new Error('disk unavailable'));
    expect((await request({ mode: 'truncate' })).status).toBe(500);
    expect(botConfig.sessionGroup).toBeUndefined();
  });
});
