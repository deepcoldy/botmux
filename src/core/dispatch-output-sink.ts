/**
 * Codex App output-sink rule for an ISOLATED caller (a pane authenticated by
 * its rotating managed-origin capability, not trusted-host) of the daemon
 * routes through which `botmux dispatch` writes to Lark.
 *
 * It is the same decision `/api/send`, `/api/attention` and the worker's relay
 * authorization (`authorizeManagedSend`) apply: a Codex App turn whose output
 * is bound to `http_wait` / `http_async` / `suppressed` may not post to Lark.
 * Relayed dispatches arrive as trusted-host re-execs that the worker already
 * authorized; ordinary host callers keep their existing behaviour. One
 * definition, used both at route entry and inside the provider-write fence.
 */
import { isCodexAppCliId } from '../adapters/cli/types.js';
import { validateCodexAppManagedSendOrigin } from '../utils/codex-app-dispatch-ledger.js';
import type { DaemonSession } from './types.js';

export const DISPATCH_ORIGIN_NOT_SENDABLE = 'origin_not_sendable';

type SinkSession = Pick<DaemonSession, 'session' | 'managedTurnOrigin' | 'initConfig'>;

export function isolatedDispatchOutputSinkAllowed(ds: SinkSession): boolean {
  return validateCodexAppManagedSendOrigin(
    ds.session.codexAppDispatchLedger,
    ds.managedTurnOrigin ?? {},
    // Either source naming Codex App requires an exact ledger match (fail-closed),
    // same as worker.ts' codexAppManagedOrigin and the daemon's /api/send.
    isCodexAppCliId(ds.initConfig?.cliId) || isCodexAppCliId(ds.session.cliId),
  ).ok;
}

/** Re-evaluate the rule at the moment of the provider write. The route-entry
 *  check alone is not enough: the turn can settle (its ledger entry removed)
 *  while the route awaits a message lookup, identity resolution or a provider
 *  retry, and the worker publishes the origin revocation only after the daemon
 *  committed the settlement. Trusted-host callers are returned unchanged. */
export function withIsolatedDispatchSinkFence<W extends { beforeWrite: () => Promise<void> }>(
  ds: SinkSession,
  base: W,
  trustedHost: boolean,
): W {
  if (trustedHost) return base;
  const assertSendable = (): void => {
    if (!isolatedDispatchOutputSinkAllowed(ds)) {
      throw Object.assign(
        new Error('dispatch origin is no longer sendable before provider effect'),
        { code: DISPATCH_ORIGIN_NOT_SENDABLE },
      );
    }
  };
  return {
    ...base,
    beforeWrite: async (): Promise<void> => {
      assertSendable();
      await base.beforeWrite();
      assertSendable();
    },
  };
}

export function isDispatchOriginNotSendableError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === DISPATCH_ORIGIN_NOT_SENDABLE;
}
