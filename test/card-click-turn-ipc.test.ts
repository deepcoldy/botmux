/**
 * POST /api/cards/click-turn is behind the host HMAC gate. Deleting that
 * requirement, or the route's poster call, fails this file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  setCardClickTurnPoster,
  setIpcAuthSecret,
  setLarkAppId,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import { loopbackFetch } from '../src/core/loopback-fetch.js';

const SECRET = 'card-click-turn-ipc-secret';
let server: IpcServerHandle | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  setCardClickTurnPoster(null);
  setIpcAuthSecret(null);
  setLarkAppId('');
});

describe('card click turn IPC', () => {
  it('returns 401 without host HMAC and reaches the poster with it', async () => {
    const seen: unknown[] = [];
    setLarkAppId('cli_app');
    setIpcAuthSecret(SECRET);
    setCardClickTurnPoster(async (larkAppId, body) => {
      seen.push({ larkAppId, body });
      return { ok: true, messageId: 'om_card', exp: 123 };
    });
    server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const body = JSON.stringify({ prompt: 'do the thing', chatId: 'oc_chat' });
    const unsigned = await loopbackFetch(`http://127.0.0.1:${server.port}/api/cards/click-turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(unsigned.status).toBe(401);
    expect(seen).toEqual([]);

    const signed = await fetchDaemonIpc(server.port, '/api/cards/click-turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }, SECRET);
    expect(signed.status).toBe(200);
    expect(await signed.json()).toEqual({ ok: true, messageId: 'om_card', exp: 123 });
    expect(seen).toEqual([{ larkAppId: 'cli_app', body: { prompt: 'do the thing', chatId: 'oc_chat' } }]);
  });
});
