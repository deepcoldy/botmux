import type { DeferredTopicBinding } from '../core/deferred-topic-binding.js';
import {
  DEFERRED_TOPIC_CLAIM_WAIT_MS,
  DEFERRED_TOPIC_LEASE_RENEW_MS,
  type DeferredTopicClaimRequest,
  type DeferredTopicClaimResponse,
} from '../core/deferred-topic-claim.js';
import type { DeferredTopicBindingStore, DeferredTopicSendSession } from './deferred-topic-send.js';

/** Transport for the daemon's session-scoped `deferred-topic` route. Returns
 * the parsed JSON body; a non-2xx response must surface as `{ ok: false }`. */
export type DeferredTopicClaimPost = (
  request: DeferredTopicClaimRequest,
) => Promise<DeferredTopicClaimResponse>;

function claimError(res: DeferredTopicClaimResponse): Error {
  return new Error(`deferred topic claim refused: ${res.ok ? res.state : res.error}`);
}

function boundBinding(
  session: DeferredTopicSendSession,
  rootMessageId: string,
  createdAt: string,
): DeferredTopicBinding {
  const run = session.deferredScheduleRun!;
  return {
    sessionId: session.sessionId,
    turnId: run.turnId,
    chatId: session.chatId,
    larkAppId: session.larkAppId,
    routingAnchor: run.routingAnchor,
    rootMessageId,
    createdAt,
  };
}

/** Daemon port for the claim route. A persistent pane (tmux + sandbox / read
 * isolation) can keep a spawn-time BOTMUX_DAEMON_IPC_PORT across a daemon
 * restart, so the port the worker publishes in the rotating capability claim
 * wins; the inherited env is only the compatibility fallback. */
export function resolveDeferredTopicIpcPort(
  claimPort: number | undefined,
  envPort: string | undefined,
): number | undefined {
  if (claimPort !== undefined) return claimPort;
  const parsed = Number(envPort);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : undefined;
}

/** Read-only daemon lookup for advisory callers (reachability / topic checks).
 * Never claims; any failure degrades to "no binding", like a missing file. */
export async function peekRemoteDeferredTopicBinding(
  session: DeferredTopicSendSession,
  post: DeferredTopicClaimPost,
): Promise<DeferredTopicBinding | undefined> {
  if (!session.deferredScheduleRun) return undefined;
  try {
    const res = await post({ action: 'peek' });
    return res.ok && res.state === 'bound'
      ? boundBinding(session, res.rootMessageId, res.createdAt)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Daemon-owned binding store for a CLI that cannot write the host sidecar.
 *
 * `withLock` turns the file lock into a daemon lease: `claim` either reports
 * the existing root, grants this process the exclusive right to publish one,
 * or reports `busy` while another process holds that right. The lease is
 * released on every exit path that did not commit, so a failed provider
 * request never wedges the run for the remainder of the lease TTL.
 */
export function remoteDeferredTopicBindingStore(
  session: DeferredTopicSendSession,
  post: DeferredTopicClaimPost,
  opts: { waitMs?: number; pollMs?: number; renewMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): DeferredTopicBindingStore {
  const waitMs = opts.waitMs ?? DEFERRED_TOPIC_CLAIM_WAIT_MS;
  const pollMs = opts.pollMs ?? 250;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  let bound: DeferredTopicBinding | undefined;
  let leaseId: string | undefined;
  let denied: string | undefined;

  return {
    async withLock(fn) {
      bound = undefined;
      leaseId = undefined;
      denied = undefined;
      const deadline = Date.now() + waitMs;
      for (;;) {
        const res = await post({ action: 'claim' });
        if (!res.ok) throw claimError(res);
        if (res.state === 'bound') {
          bound = boundBinding(session, res.rootMessageId, res.createdAt);
          break;
        }
        if (res.state === 'claimed') {
          leaseId = res.leaseId;
          break;
        }
        if (res.state === 'not_claimable') {
          denied = res.reason;
          break;
        }
        // busy: another `botmux send` of this run is publishing the root.
        if (Date.now() >= deadline) throw new Error('deferred topic claim timed out waiting for a concurrent send');
        await sleep(pollMs);
      }
      // Keep the lease alive while the provider request runs, so a slow
      // publish is never taken over by a concurrent send of the same run.
      const renewer = leaseId
        ? setInterval(() => {
          if (leaseId) void post({ action: 'renew', leaseId }).catch(() => undefined);
        }, opts.renewMs ?? DEFERRED_TOPIC_LEASE_RENEW_MS)
        : undefined;
      renewer?.unref?.();
      try {
        return await fn();
      } finally {
        if (renewer) clearInterval(renewer);
        if (leaseId) {
          const id = leaseId;
          leaseId = undefined;
          await post({ action: 'release', leaseId: id }).catch(() => undefined);
        }
      }
    },
    read: () => bound,
    assertCanMaterialize() {
      if (!leaseId) throw new Error(`deferred topic is not claimable: ${denied ?? 'no lease'}`);
    },
    async write(binding) {
      if (!leaseId) throw new Error('deferred topic commit without a lease');
      // The root was just published; a provider read-after-write miss (502)
      // is retried here so the run does not end with an unbound topic.
      let res = await post({ action: 'commit', leaseId, rootMessageId: binding.rootMessageId });
      for (let attempt = 1; attempt <= 2 && !res.ok && res.status === 502; attempt++) {
        await sleep(attempt * 1_000);
        res = await post({ action: 'commit', leaseId, rootMessageId: binding.rootMessageId });
      }
      if (!res.ok || res.state !== 'bound' || res.rootMessageId !== binding.rootMessageId) {
        throw claimError(res);
      }
      // Committed: the lease is consumed server-side, nothing left to release.
      leaseId = undefined;
      bound = boundBinding(session, res.rootMessageId, res.createdAt);
    },
  };
}
