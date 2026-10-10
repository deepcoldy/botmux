import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as configStore from '../src/services/config-store.js';
import * as botRegistry from '../src/bot-registry.js';
import * as groupsStore from '../src/services/groups-store.js';

let handle: IpcServerHandle | undefined;
let entry: any;
let botConfig: any;
beforeEach(() => {
  entry = { larkAppId: 'app-a' };
  botConfig = { larkAppId: 'app-a', cliId: 'codex' };
  setLarkAppId('app-a');
  vi.spyOn(botRegistry, 'getBot').mockReturnValue({ config: botConfig } as any);
  vi.spyOn(groupsStore, 'listChats').mockResolvedValue([{ chatId: 'oc_a', name: '测试群' }] as any);
  vi.spyOn(configStore, 'rmwBotEntry').mockImplementation(async (_appId, mutate: any) => {
    const out = mutate(entry, [entry]);
    return { ok: true, result: out.result };
  });
});
afterEach(async () => {
  await handle?.close();
  handle = undefined;
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
});
async function request(path: string, body?: unknown) {
  handle ??= await startIpcServer({ port: 0, host: '127.0.0.1' });
  const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, body === undefined ? undefined : {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

it('reads disabled defaults and returns hot-reloaded settings after saving', async () => {
  const initial = await request('/api/groups');
  expect(initial.body.chats[0].idleClose).toEqual({ enabled: false, duration: 1, unit: 'days' });
  const settings = { enabled: true, duration: 3, unit: 'hours' };
  expect(await request('/api/group-idle-close/oc_a', settings)).toEqual({ status: 200, body: { ok: true, settings } });
  expect(entry.groupIdleClose.oc_a).toEqual(settings);
  expect((await request('/api/groups')).body.chats[0].idleClose).toEqual(settings);
});

it('rejects malformed API input without writes and leaves memory unchanged on storage failure', async () => {
  for (const body of [null, {}, { enabled: true, duration: 0, unit: 'days' }, { enabled: true, duration: 1.5, unit: 'hours' }, { enabled: true, duration: '2', unit: 'hours' }]) {
    expect((await request('/api/group-idle-close/oc_a', body)).status).toBe(400);
  }
  expect((await request('/api/group-idle-close/invalid', { enabled: false, duration: 1, unit: 'days' })).status).toBe(400);
  expect(configStore.rmwBotEntry).not.toHaveBeenCalled();
  vi.mocked(configStore.rmwBotEntry).mockResolvedValue({ ok: false, reason: 'write_failed' } as any);
  const result = await request('/api/group-idle-close/oc_a', { enabled: true, duration: 2, unit: 'days' });
  expect(result.status).toBe(500);
  expect(botConfig.groupIdleClose).toBeUndefined();
});
