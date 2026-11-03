import type { DaemonInfo } from './registry.js';

export interface XpiDisableIpcResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type XpiDisableIpcFetch = (
  port: number,
  path: string,
  init: RequestInit,
) => Promise<XpiDisableIpcResponse>;

/**
 * Ask every currently-online daemon to terminalise its owned XPI queue.
 * A settings write must not report success unless every daemon explicitly
 * acknowledges cleanup; offline daemons are covered again by the OFF boot
 * sweep when they next start.
 */
export async function fanoutCrossPrincipalInterruptionDisable(
  daemons: readonly Pick<DaemonInfo, 'larkAppId' | 'ipcPort'>[],
  fetchDaemonIpc: XpiDisableIpcFetch,
  warn: (message: string) => void,
): Promise<void> {
  const results = await Promise.all(daemons.map(async (daemon) => {
    try {
      const response = await fetchDaemonIpc(
        daemon.ipcPort,
        '/api/xpi/disable',
        { method: 'POST' },
      );
      const body: any = await response.json().catch(() => ({}));
      if (response.ok && body?.ok && typeof body.cancelled === 'number') return true;
      warn(
        `[xpi-disable] daemon ${daemon.larkAppId} returned `
        + `${response.status} ${JSON.stringify(body)}`,
      );
      return false;
    } catch (error) {
      warn(
        `[xpi-disable] daemon ${daemon.larkAppId} unreachable: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }));
  const failed = results.filter(ok => !ok).length;
  if (failed > 0) {
    throw new Error(
      `xpi disable: ${failed}/${daemons.length} daemon(s) did not ack — cleanup incomplete`,
    );
  }
}
