/**
 * `x-botmux-expected-core-boot` pins a request to one boot of a core-only
 * service. Requests without it (every fleet caller) are routed exactly as
 * before; a request carrying it is served only by a core-only service whose
 * current boot id matches, and any other daemon answers 409.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { getDaemonBootId } from '../src/core/worker-pool.js';

let handle: IpcServerHandle | null = null;

afterEach(async () => {
  await handle?.close();
  handle = null;
});

async function start(coreOnly: boolean): Promise<void> {
  handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: false, coreOnlyPublicRoutes: coreOnly });
}

function health(expectedBoot?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${handle!.port}/__health`, {
    headers: expectedBoot === undefined ? {} : { 'x-botmux-expected-core-boot': expectedBoot },
  });
}

describe('fleet daemon', () => {
  it('routes requests without the header unchanged', async () => {
    await start(false);
    const res = await health();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('refuses a request that expects a core-only boot, even with its own boot id', async () => {
    await start(false);
    const res = await health(getDaemonBootId());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'core_boot_changed' });
  });
});

describe('core-only service', () => {
  it('serves the current boot and requests without the header', async () => {
    await start(true);
    expect((await health(getDaemonBootId())).status).toBe(200);
    expect((await health()).status).toBe(200);
  });

  it('refuses a request pinned to another boot', async () => {
    await start(true);
    const res = await health(`${getDaemonBootId()}-previous`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'core_boot_changed' });
  });
});
