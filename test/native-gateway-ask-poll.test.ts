/**
 * The native gateway's poll of a turn's asks, through the real IPC routes with
 * host HMAC: an ask is shown and answerable only while the live managed origin
 * is that very turn. A dispatch attempt is numbered per turn, so an equal
 * attempt number of another turn must not keep it visible.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { parseBotConfigsFromText, registerBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { _resetForTest, listPendingAsks, registerAsk, setCardDispatcher } from '../src/core/ask-broker.js';
import { createNativeGatewayAskDispatcher } from '../src/core/native-gateway-ask-dispatch.js';
import * as pool from '../src/core/worker-pool.js';

const APP = 'local_gateway_poll';
const SECRET = 'native-gateway-ask-poll-secret';
let server: IpcServerHandle | undefined;

afterEach(async () => {
  _resetForTest();
  await server?.close();
  server = undefined;
  setIpcAuthSecret(null);
  setLarkAppId('');
  __testOnly_resetBotRegistry();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function gatewayCore() {
  vi.stubEnv('BOTMUX_CORE_ONLY', '1');
  __testOnly_resetBotRegistry();
  registerBot(parseBotConfigsFromText(JSON.stringify([{ larkAppId: APP, apiOnly: true, cliId: 'codex' }]))[0]!);
  setLarkAppId(APP);
  setIpcAuthSecret(SECRET);
  _resetForTest();
  setCardDispatcher(createNativeGatewayAskDispatcher());
  const ds: any = {
    larkAppId: APP, chatId: 'http_async_fixture', workerGeneration: 2,
    session: { sessionId: 'session', larkAppId: APP },
    asyncTriggerResults: new Map([['turn', { status: 'pending' }]]),
    activeInteractiveTurn: { turnId: 'turn' },
    managedTurnOrigin: { capability: 'cap', turnId: 'turn', dispatchAttempt: 4 },
  };
  vi.spyOn(pool, 'findActiveBySessionId').mockImplementation(id => id === 'session' ? ds : undefined);
  server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true, coreOnlyPublicRoutes: true });
  const call = (method: 'GET' | 'POST', path: string, body?: unknown) => fetch(`http://127.0.0.1:${server!.port}${path}`, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
    headers: daemonIpcAuthHeaders({ secret: SECRET, port: server!.port, method, path,
      headers: body ? { 'content-type': 'application/json' } : undefined }),
  });
  return { ds, call };
}

describe('the native gateway poll of a turn', () => {
  it('shows and accepts answers for an ask only while the live managed origin is that turn', async () => {
    const { ds, call } = await gatewayCore();
    void registerAsk({
      larkAppId: APP, chatId: ds.chatId, sessionId: 'session', rootMessageId: null, timeoutMs: 600_000,
      nativeGatewayOrigin: { turnId: 'turn', workerGeneration: 2, dispatchAttempt: 4 },
      questions: [{ prompt: 'Proceed?', options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }], multiSelect: false }],
    });
    const poll = async () => (await (await call('GET', '/api/sessions/session/native-gateway-asks?triggerId=turn')).json()).asks;
    expect(await poll()).toHaveLength(1);

    // The live origin is now another turn, under the same attempt number.
    ds.managedTurnOrigin = { capability: 'cap', turnId: 'turn-next', dispatchAttempt: 4 };
    expect(await poll()).toEqual([]);
    const [ask] = listPendingAsks();
    const answer = await call('POST', '/api/sessions/session/native-gateway-asks', {
      origin: { sessionId: 'session', turnId: 'turn', workerGeneration: 2, dispatchAttempt: 4 },
      askId: ask!.askId, nonce: ask!.nonce, by: 'alice', action: 'submit',
    });
    expect(answer.status).toBe(409);
  });
});
