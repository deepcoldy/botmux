/**
 * The request a terminal / write-link card button makes to the Dashboard
 * (WECOM_DASHBOARD_ROUTE_PATHS.terminalMint), and what its outcome means for
 * that click:
 *  - minted:    the Dashboard answered with a link;
 *  - rejected:  the Dashboard certainly minted nothing. Either nothing reached
 *               it (no Dashboard secret to sign with, the connection was
 *               refused) or it answered with a status other than 200, or with
 *               `ok: false`. The click may be tried again;
 *  - uncertain: the request may have reached the Dashboard, but no answer came
 *               back (a timeout, a connection reset). A link may exist that
 *               nobody received, so this click is not tried again: one click
 *               never yields two links (a new click is a new request).
 */
import { createDaemonClient, type DaemonClient } from '../../../../dashboard/daemon-internal-client.js';
import { resolveDashboardUrl } from '../../../../daemon-internal-client-wrapper.js';
import {
  WECOM_DASHBOARD_ROUTE_PATHS,
  type WecomTerminalMintRequest,
  type WecomTerminalMintResponse,
} from '../../contract/dashboard-routes.js';

export type TerminalMintClient = Pick<DaemonClient, 'request'>;

export type TerminalMintOutcome =
  | { kind: 'minted'; url: string }
  | { kind: 'rejected' }
  | { kind: 'uncertain' };

/**
 * The production client, made for each click: it targets the port the
 * Dashboard recorded in `.dashboard-port` when it bound (it probes upward when
 * its configured port is taken), read at this moment — the same lookup the
 * Feishu daemons' Dashboard commands use. Throws when there is no Dashboard
 * secret.
 */
export function createTerminalMintClient(): TerminalMintClient {
  return createDaemonClient({ appId: 'wecom-native-terminal', dashboardUrl: resolveDashboardUrl() });
}

function connectionRefused(error: unknown): boolean {
  const failure = error as { code?: unknown; cause?: { code?: unknown } } | null | undefined;
  return failure?.code === 'ECONNREFUSED' || failure?.cause?.code === 'ECONNREFUSED';
}

/** One mint request. Never throws; see the outcomes above. */
export async function requestTerminalMint(
  createClient: () => TerminalMintClient,
  body: WecomTerminalMintRequest,
): Promise<TerminalMintOutcome> {
  let client: TerminalMintClient;
  try {
    client = createClient();
  } catch {
    return { kind: 'rejected' };
  }
  let response: Awaited<ReturnType<TerminalMintClient['request']>>;
  try {
    // A POST is sent once (daemon-internal-client.ts retries no unsafe write).
    response = await client.request({
      method: 'POST',
      path: WECOM_DASHBOARD_ROUTE_PATHS.terminalMint,
      body,
    });
  } catch (error) {
    return connectionRefused(error) ? { kind: 'rejected' } : { kind: 'uncertain' };
  }
  const minted = response.body as Partial<Extract<WecomTerminalMintResponse, { ok: true }>> | undefined;
  if (response.status === 200 && minted?.ok === true && typeof minted.url === 'string' && minted.url) {
    return { kind: 'minted', url: minted.url };
  }
  return { kind: 'rejected' };
}
