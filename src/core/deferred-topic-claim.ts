import { randomUUID } from 'node:crypto';
import type { DeferredTopicBinding } from './deferred-topic-binding.js';
import type { DaemonSession } from './types.js';

/**
 * Daemon-side half of the first-message claim for a silent fresh-topic
 * schedule run, for a CLI that cannot write `<dataDir>/deferred-topics`
 * (bwrap sandbox / macOS seatbelt / read isolation).
 *
 * The binding file is what the daemon later trusts to route replies in the
 * materialized topic to this session, so it stays host-owned: an agent-writable
 * copy would let a session alias any message of the chat onto itself. The CLI
 * still publishes the root with its own provider client (hooks, attachments
 * and private-reply handling are unchanged); the daemon only
 *   1. serializes publishers with a short lease (what the file lock did), and
 *   2. records the root after proving it is a top-level message this bot sent
 *      into this session's chat after the run fired — the Riff relay's chat
 *      fence plus sender and freshness, so an older bot message of the chat
 *      (e.g. another session's topic root) cannot be re-bound to this run.
 *
 * Trust boundary: the caller already passed `sessionCliIpcAuth`. The run turn
 * is taken from the capability's live origin, never from the request body.
 */
export const DEFERRED_TOPIC_CLAIM_ROUTE = 'deferred-topic';
/** How long a CLI waits for a concurrent publisher; mirrors the file lock. */
export const DEFERRED_TOPIC_CLAIM_WAIT_MS = 30_000;
/** A lease outlives one provider request plus its retries. An expired lease
 * may be taken over; its holder's late commit is then refused. */
export const DEFERRED_TOPIC_LEASE_TTL_MS = 60_000;
/** The holder renews well inside the TTL while its provider request runs. */
export const DEFERRED_TOPIC_LEASE_RENEW_MS = 20_000;
/** Tolerated provider/host clock skew for the root freshness check. */
export const DEFERRED_TOPIC_ROOT_CLOCK_SKEW_MS = 10_000;
/** Requests carry only an action, a lease id and a message id. */
export const DEFERRED_TOPIC_CLAIM_MAX_BYTES = 4096;

const MESSAGE_ID = /^om_[A-Za-z0-9_-]{1,128}$/;
const LEASE_ID = /^[0-9a-f-]{36}$/;

export type DeferredTopicClaimRequest =
  | { action: 'peek' }
  | { action: 'claim' }
  | { action: 'commit'; leaseId: string; rootMessageId: string }
  | { action: 'renew'; leaseId: string }
  | { action: 'release'; leaseId: string };

export type DeferredTopicClaimResponse =
  | { ok: true; state: 'bound'; rootMessageId: string; createdAt: string }
  | { ok: true; state: 'unbound' }
  | { ok: true; state: 'claimed'; leaseId: string }
  | { ok: true; state: 'busy' }
  | { ok: true; state: 'not_claimable'; reason: string }
  | { ok: true; state: 'released' }
  | { ok: true; state: 'renewed' }
  | { ok: false; status: 400 | 404 | 409 | 502; error: string };

/** What the daemon learned about a claimed root from the provider. `null`
 * means the message could not be resolved at all. */
export interface DeferredTopicRootFacts {
  chatId?: string;
  senderAppId?: string;
  /** True when the message is itself a reply inside some thread. */
  isReply?: boolean;
  /** Provider creation time (epoch ms). */
  createdAtMs?: number;
}

export interface DeferredTopicClaimDeps {
  readBinding(sessionId: string): DeferredTopicBinding | undefined;
  writeBinding(binding: DeferredTopicBinding): void;
  lookupRoot(larkAppId: string, rootMessageId: string): Promise<DeferredTopicRootFacts | null>;
  now?: () => number;
}

interface Lease {
  leaseId: string;
  turnId: string;
  expiresAt: number;
}

type ClaimSession = Pick<DaemonSession, 'session' | 'larkAppId' | 'chatId' | 'managedTurnOrigin'>;

export function parseDeferredTopicClaimRequest(body: Record<string, unknown>): DeferredTopicClaimRequest | undefined {
  switch (body.action) {
    case 'peek':
    case 'claim':
      return { action: body.action };
    case 'commit':
      return typeof body.leaseId === 'string' && LEASE_ID.test(body.leaseId)
        && typeof body.rootMessageId === 'string' && MESSAGE_ID.test(body.rootMessageId)
        ? { action: 'commit', leaseId: body.leaseId, rootMessageId: body.rootMessageId }
        : undefined;
    case 'renew':
    case 'release':
      return typeof body.leaseId === 'string' && LEASE_ID.test(body.leaseId)
        ? { action: body.action, leaseId: body.leaseId }
        : undefined;
    default:
      return undefined;
  }
}

export class DeferredTopicClaimRegistry {
  private readonly leases = new Map<string, Lease>();

  constructor(private readonly deps: DeferredTopicClaimDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async handle(ds: ClaimSession | undefined, req: DeferredTopicClaimRequest): Promise<DeferredTopicClaimResponse> {
    if (!ds || ds.session.status === 'closed') return { ok: false, status: 404, error: 'session_not_active' };
    const run = ds.session.deferredScheduleRun;
    if (!run) return { ok: false, status: 409, error: 'not_deferred_run' };
    const sessionId = ds.session.sessionId;

    const existing = this.deps.readBinding(sessionId);
    if (existing) {
      if (existing.sessionId !== sessionId
        || existing.turnId !== run.turnId
        || existing.chatId !== ds.chatId
        || existing.larkAppId !== ds.larkAppId
        || existing.routingAnchor !== run.routingAnchor) {
        return { ok: false, status: 409, error: 'binding_identity_mismatch' };
      }
      if (req.action === 'release') return { ok: true, state: 'released' };
      if (req.action === 'renew') return { ok: false, status: 409, error: 'already_bound' };
      // A commit retried after the daemon already recorded it converges only on
      // the same root; anything else would re-point a published topic.
      if (req.action === 'commit' && req.rootMessageId !== existing.rootMessageId) {
        return { ok: false, status: 409, error: 'already_bound' };
      }
      this.leases.delete(sessionId);
      return { ok: true, state: 'bound', rootMessageId: existing.rootMessageId, createdAt: existing.createdAt };
    }

    if (req.action === 'peek') return { ok: true, state: 'unbound' };

    if (req.action === 'release') {
      if (this.leases.get(sessionId)?.leaseId === req.leaseId) this.leases.delete(sessionId);
      return { ok: true, state: 'released' };
    }

    if (req.action === 'renew') {
      const held = this.leases.get(sessionId);
      // Renewal only extends a lease nobody has taken over yet.
      if (!held || held.leaseId !== req.leaseId) return { ok: false, status: 409, error: 'lease_lost' };
      held.expiresAt = this.now() + DEFERRED_TOPIC_LEASE_TTL_MS;
      return { ok: true, state: 'renewed' };
    }

    // Only the scheduled turn itself may publish the root, and "itself" is the
    // turn the presented capability was minted for.
    const turnId = ds.managedTurnOrigin?.turnId;
    if (req.action === 'claim') {
      if (!turnId || turnId !== run.turnId) return { ok: true, state: 'not_claimable', reason: 'turn_mismatch' };
      const held = this.leases.get(sessionId);
      if (held && held.expiresAt > this.now()) return { ok: true, state: 'busy' };
      const lease: Lease = { leaseId: randomUUID(), turnId, expiresAt: this.now() + DEFERRED_TOPIC_LEASE_TTL_MS };
      this.leases.set(sessionId, lease);
      return { ok: true, state: 'claimed', leaseId: lease.leaseId };
    }

    // commit
    const held = this.leases.get(sessionId);
    if (!held || held.leaseId !== req.leaseId) return { ok: false, status: 409, error: 'lease_lost' };
    if (!turnId || turnId !== held.turnId || held.turnId !== run.turnId) {
      return { ok: false, status: 409, error: 'turn_mismatch' };
    }
    let facts: DeferredTopicRootFacts | null;
    try {
      facts = await this.deps.lookupRoot(ds.larkAppId, req.rootMessageId);
    } catch {
      return { ok: false, status: 502, error: 'root_lookup_failed' };
    }
    if (!facts) return { ok: false, status: 502, error: 'root_lookup_failed' };
    if (facts.chatId !== ds.chatId) return { ok: false, status: 409, error: 'root_outside_target_chat' };
    if (facts.senderAppId !== ds.larkAppId) return { ok: false, status: 409, error: 'root_not_sent_by_bot' };
    if (facts.isReply) return { ok: false, status: 409, error: 'root_not_top_level' };
    // Run-relative (not lease-relative) so a retried send whose provider uuid
    // dedupes onto the root an earlier, failed attempt published still binds.
    const runStartedAt = Date.parse(run.createdAt);
    if (!Number.isFinite(runStartedAt)
      || facts.createdAtMs === undefined
      || facts.createdAtMs < runStartedAt - DEFERRED_TOPIC_ROOT_CLOCK_SKEW_MS) {
      return { ok: false, status: 409, error: 'root_predates_run' };
    }
    // The lookup awaited the provider: re-check nothing moved underneath us.
    if (this.leases.get(sessionId)?.leaseId !== req.leaseId) return { ok: false, status: 409, error: 'lease_lost' };
    const raced = this.deps.readBinding(sessionId);
    if (raced) {
      return raced.rootMessageId === req.rootMessageId
        ? { ok: true, state: 'bound', rootMessageId: raced.rootMessageId, createdAt: raced.createdAt }
        : { ok: false, status: 409, error: 'already_bound' };
    }
    const binding: DeferredTopicBinding = {
      sessionId,
      turnId: run.turnId,
      chatId: ds.chatId,
      larkAppId: ds.larkAppId,
      routingAnchor: run.routingAnchor,
      rootMessageId: req.rootMessageId,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.deps.writeBinding(binding);
    this.leases.delete(sessionId);
    return { ok: true, state: 'bound', rootMessageId: binding.rootMessageId, createdAt: binding.createdAt };
  }
}

/** Interpret a `GET /im/v1/messages/:id` payload for the commit fence. */
export function deferredTopicRootFactsFromDetail(detail: any): DeferredTopicRootFacts | null {
  const item = detail?.items?.[0] ?? detail?.message ?? detail;
  if (!item || typeof item !== 'object') return null;
  const chatId = typeof item.chat_id === 'string' ? item.chat_id : undefined;
  const sender = item.sender;
  // Lark labels a bot sender `app` here, but other surfaces of the same API
  // have been observed to say `bot` (see event-dispatcher). Accept either, or
  // an app_id-typed id; the fence that matters is equality with the session's
  // own app id, which the caller cannot influence.
  const senderType = sender?.sender_type;
  const senderIdType = sender?.id_type ?? sender?.sender_id_type;
  const senderAppId = typeof sender?.id === 'string'
    && (senderType === 'app' || senderType === 'bot' || senderIdType === 'app_id')
    ? sender.id
    : undefined;
  const parent = typeof item.parent_id === 'string' && item.parent_id ? item.parent_id : undefined;
  const root = typeof item.root_id === 'string' && item.root_id ? item.root_id : undefined;
  const created = Number(item.create_time);
  return {
    chatId,
    senderAppId,
    isReply: !!(parent || (root && root !== item.message_id)),
    ...(Number.isFinite(created) && created > 0 ? { createdAtMs: created } : {}),
  };
}
