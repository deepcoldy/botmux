import { describe, expect, it, vi } from 'vitest';

import { fanoutCrossPrincipalInterruptionDisable } from '../src/dashboard/xpi-disable-fanout.js';

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('XPI disable daemon fanout', () => {
  it('rejects with the failed daemon count when any daemon does not acknowledge cleanup', async () => {
    const daemons = [
      { larkAppId: 'cli_ok', ipcPort: 9101 },
      { larkAppId: 'cli_reject', ipcPort: 9102 },
      { larkAppId: 'cli_offline', ipcPort: 9103 },
    ];
    const fetchDaemonIpc = vi.fn(async (port: number) => {
      if (port === 9101) return response(200, { ok: true, cancelled: 2 });
      if (port === 9102) return response(503, { ok: false, error: 'handler unavailable' });
      throw new Error('connect ECONNREFUSED');
    });
    const warn = vi.fn();

    await expect(fanoutCrossPrincipalInterruptionDisable(
      daemons,
      fetchDaemonIpc,
      warn,
    )).rejects.toThrow('xpi disable: 2/3 daemon(s) did not ack — cleanup incomplete');

    expect(fetchDaemonIpc).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cli_reject'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cli_offline'));
  });

  it('resolves only when every daemon returns a typed cleanup acknowledgement', async () => {
    const fetchDaemonIpc = vi.fn(async () => response(200, { ok: true, cancelled: 0 }));

    await expect(fanoutCrossPrincipalInterruptionDisable(
      [
        { larkAppId: 'cli_a', ipcPort: 9201 },
        { larkAppId: 'cli_b', ipcPort: 9202 },
      ],
      fetchDaemonIpc,
      vi.fn(),
    )).resolves.toBeUndefined();
    expect(fetchDaemonIpc).toHaveBeenCalledTimes(2);
  });
});
