/**
 * Every path in im/wecom/contract/dashboard-routes.ts reaches the handler the
 * Dashboard serves it with: WecomDashboard.terminalHttp, the seam dashboard.ts
 * calls for every request before its auth gate and before its own routes.
 *
 * Each request is correctly signed and carries a body the route refuses. A
 * route that is served answers with its own refusal; a path the seam does not
 * take falls through to this server's 404, the way dashboard.ts goes on to its
 * other routes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { WecomDashboard } from '../src/dashboard/wecom/index.js';
import { createDaemonClient } from '../src/dashboard/daemon-internal-client.js';
import { WECOM_DASHBOARD_ROUTE_PATHS } from '../src/im/wecom/contract/dashboard-routes.js';

const SECRET = 'wecom-dashboard-routes-secret';

/** What each route answers to a signed request it refuses (`{}` is not a terminal request). */
const REFUSAL: Record<keyof typeof WECOM_DASHBOARD_ROUTE_PATHS, { status: number; error: string }> = {
  terminalMint: { status: 403, error: 'native_terminal_rejected' },
};

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});

async function dashboardOrigin(): Promise<string> {
  const wecom = new WecomDashboard({
    secret: SECRET,
    audit: { append() {} },
    resolveActor: () => null,
    isAuthSessionLive: () => false,
    dashboardPort: () => 7891,
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (await wecom.terminalHttp(req, res, url)) {
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'not_found' }));
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function signedPost(origin: string, path: string): Promise<{ status: number; error: unknown }> {
  const client = createDaemonClient({ dashboardUrl: origin, appId: 'wecom-dashboard-routes', secret: SECRET });
  const response = await client.request({ method: 'POST', path, body: {} });
  return { status: response.status, error: (response.body as { error?: unknown } | undefined)?.error };
}

describe('routes the Dashboard serves for a WeCom gateway', () => {
  it.each(Object.entries(WECOM_DASHBOARD_ROUTE_PATHS) as Array<[keyof typeof WECOM_DASHBOARD_ROUTE_PATHS, string]>)(
    '%s (%s) reaches its Dashboard handler',
    async (route, path) => {
      const origin = await dashboardOrigin();
      expect(await signedPost(origin, path)).toEqual(REFUSAL[route]);
    },
  );

  it('lets a path outside the contract fall through to the rest of the Dashboard', async () => {
    const origin = await dashboardOrigin();
    expect(await signedPost(origin, `${WECOM_DASHBOARD_ROUTE_PATHS.terminalMint}/other`)).toEqual({ status: 404, error: 'not_found' });
  });
});
