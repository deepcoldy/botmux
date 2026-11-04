/**
 * Signed workflow handoff bindings (design 2026-11-03 §5.4, P3).
 *
 * A bot-executed workflow node is handed off with a card message. The binding
 * that lets the receiving bot's daemon trust that message, and later route the
 * node's `botmux report --dispatch-root <handoff>` submission back to the run,
 * lives in the host-wide `orchestrate-dispatch.json` registry, signed with the
 * same host secret as dispatch report bindings under its own protocol domain,
 * so neither kind of binding can be replayed as the other.
 *
 * The binding is registered BEFORE the handoff is sent, keyed by a nonce the
 * card itself carries (`wfh_…`, an HMAC of the attempt's frozen idempotency
 * key, so a same-key re-send carries the same nonce). The receiver therefore
 * never waits for the message id. Once Lark returns the id, the orchestrator
 * links it (signed) to the nonce: that id is the `--dispatch-root` key.
 *
 * Stopping an attempt REVOKES its binding (signed tombstone on the nonce,
 * written even before the binding exists): a revoked handoff is dropped by the
 * receiver, never staged, and every report for it is refused. The registry is
 * inside the host trust domain; signatures keep a forged entry from granting
 * anything, but deleting entries can of course not be prevented.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { updateDispatchRegistry } from './dispatch-registry.js';

const DOMAIN = 'botmux.workflow-handoff-binding.v1';
const NONCE_KEY_PREFIX = 'workflow-handoff:';

/** Workflow entries older than this are pruned on the next workflow write.
 *  An attempt lives at most hours (50 min send window, 15 s acceptance, node
 *  timeout ≤ 4 h); a staged submission no longer needs the registry. Keeping
 *  revocations for two days still drops any late-delivered handoff. */
export const WORKFLOW_HANDOFF_ENTRY_TTL_MS = 48 * 3600_000;

const MESSAGE_ID_RE = /^om_[A-Za-z0-9_-]{1,128}$/;
const CHAT_ID_RE = /^oc_[A-Za-z0-9_-]{1,128}$/;
export const WORKFLOW_HANDOFF_NONCE_RE = /^wfh_[A-Za-z0-9_-]{24}$/;
const NONCE_IN_TEXT_RE = /wfh_[A-Za-z0-9_-]{24}/g;

export interface WorkflowHandoffRef {
  runId: string;
  nodeId: string;
  instanceId?: string;
  attemptId: string;
  revision: number;
}

export interface WorkflowHandoffBindingPayload {
  domain: typeof DOMAIN;
  /** Carried in the handoff card; the binding's primary key. */
  nonce: string;
  /** Topic root the node's conversation lives under (node card id). */
  publishRoot: string;
  targetLarkAppId: string;
  targetChatId: string;
  /** The orchestrator (main bot) whose daemon owns the run. */
  sourceLarkAppId: string;
  workflow: WorkflowHandoffRef;
  issuedAt: string;
}

export interface SignedWorkflowHandoffBinding {
  payload: WorkflowHandoffBindingPayload;
  signature: string;
}

function hmac(secret: string, text: string): string {
  return createHmac('sha256', secret).update(text).digest('base64url');
}

function sameMac(a: string, b: string): boolean {
  const left = Buffer.from(a, 'base64url');
  const right = Buffer.from(b, 'base64url');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The nonce of one attempt's handoff: stable across same-key re-sends,
 *  unguessable without the host secret. */
export function workflowHandoffNonce(secret: string, idempotencyKey: string): string {
  if (!secret) throw new Error('workflow handoff binding secret is empty');
  return `wfh_${hmac(secret, `${DOMAIN}|nonce|${idempotencyKey}`).slice(0, 24)}`;
}

/** Every handoff nonce mentioned in a message text, in order. */
export function extractWorkflowHandoffNonces(text: string): string[] {
  return [...new Set(text.match(NONCE_IN_TEXT_RE) ?? [])];
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0');
}

function canonicalPayload(raw: Record<string, unknown>): WorkflowHandoffBindingPayload {
  const workflow = raw.workflow && typeof raw.workflow === 'object' && !Array.isArray(raw.workflow)
    ? raw.workflow as Record<string, unknown>
    : undefined;
  if (typeof raw.nonce !== 'string' || !WORKFLOW_HANDOFF_NONCE_RE.test(raw.nonce)) throw new Error('invalid nonce');
  if (typeof raw.publishRoot !== 'string' || !MESSAGE_ID_RE.test(raw.publishRoot)) throw new Error('invalid publish root');
  if (typeof raw.targetChatId !== 'string' || !CHAT_ID_RE.test(raw.targetChatId)) throw new Error('invalid chat');
  if (!validIdentity(raw.targetLarkAppId) || !validIdentity(raw.sourceLarkAppId)) throw new Error('invalid app');
  if (!workflow || !validIdentity(workflow.runId) || !validIdentity(workflow.nodeId) || !validIdentity(workflow.attemptId)) {
    throw new Error('invalid workflow ref');
  }
  if (workflow.instanceId !== undefined && !validIdentity(workflow.instanceId)) throw new Error('invalid instance');
  if (typeof workflow.revision !== 'number' || !Number.isSafeInteger(workflow.revision) || workflow.revision < 1) {
    throw new Error('invalid revision');
  }
  if (typeof raw.issuedAt !== 'string' || !Number.isFinite(Date.parse(raw.issuedAt))) throw new Error('invalid issue time');
  // Fixed key order: the signature covers exactly these bytes.
  return {
    domain: DOMAIN,
    nonce: raw.nonce,
    publishRoot: raw.publishRoot,
    targetLarkAppId: raw.targetLarkAppId,
    targetChatId: raw.targetChatId,
    sourceLarkAppId: raw.sourceLarkAppId,
    workflow: {
      runId: workflow.runId,
      nodeId: workflow.nodeId,
      ...(workflow.instanceId !== undefined ? { instanceId: workflow.instanceId as string } : {}),
      attemptId: workflow.attemptId,
      revision: workflow.revision,
    },
    issuedAt: raw.issuedAt,
  };
}

export function createWorkflowHandoffBinding(
  secret: string,
  input: Omit<WorkflowHandoffBindingPayload, 'domain' | 'issuedAt'> & { issuedAt?: string },
): SignedWorkflowHandoffBinding {
  if (!secret) throw new Error('workflow handoff binding secret is empty');
  const payload = canonicalPayload({ ...input, issuedAt: input.issuedAt ?? new Date().toISOString() });
  return { payload, signature: hmac(secret, JSON.stringify(payload)) };
}

/** The verified payload for exactly `nonce`, or null. */
export function verifyWorkflowHandoffBinding(
  secret: string,
  nonce: string,
  raw: unknown,
): WorkflowHandoffBindingPayload | null {
  if (!secret || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const binding = raw as Record<string, unknown>;
  if (!binding.payload || typeof binding.payload !== 'object' || Array.isArray(binding.payload)) return null;
  if (typeof binding.signature !== 'string') return null;
  const candidate = binding.payload as Record<string, unknown>;
  if (candidate.domain !== DOMAIN) return null;
  let payload: WorkflowHandoffBindingPayload;
  try {
    payload = canonicalPayload(candidate);
  } catch {
    return null;
  }
  if (payload.nonce !== nonce) return null;
  return sameMac(binding.signature, hmac(secret, JSON.stringify(payload))) ? payload : null;
}

export function registryPath(dataDir: string): string {
  return join(dataDir, 'orchestrate-dispatch.json');
}

export function readDispatchRegistryLoose(dataDir: string): Record<string, unknown> {
  try {
    const path = registryPath(dataDir);
    if (!existsSync(path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

interface NonceEntry {
  kind: 'workflow-handoff';
  workflowHandoff?: SignedWorkflowHandoffBinding;
  message?: { id: string; signature: string };
  revoked?: { at: string; reason: string; signature: string };
  /** The executing bot's daemon would not start a session for it (design
   *  §15.4), recorded where the main bot's acceptance check reads. */
  refused?: { at: string; reason: string; signature: string };
}

function nonceEntry(registry: Record<string, unknown>, nonce: string): NonceEntry | undefined {
  const raw = registry[`${NONCE_KEY_PREFIX}${nonce}`];
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as NonceEntry : undefined;
}

function messageMac(secret: string, nonce: string, messageId: string): string {
  return hmac(secret, `${DOMAIN}|message|${nonce}|${messageId}`);
}

function revocationMac(secret: string, nonce: string, at: string, reason: string): string {
  return hmac(secret, `${DOMAIN}|revoked|${nonce}|${at}|${reason}`);
}

function refusalMac(secret: string, nonce: string, at: string, reason: string): string {
  return hmac(secret, `${DOMAIN}|refused|${nonce}|${at}|${reason}`);
}

function validRefusal(secret: string, nonce: string, entry: NonceEntry | undefined): string | undefined {
  const refused = entry?.refused;
  if (!refused || typeof refused.at !== 'string' || typeof refused.reason !== 'string' || typeof refused.signature !== 'string') {
    return undefined;
  }
  return sameMac(refused.signature, refusalMac(secret, nonce, refused.at, refused.reason)) ? refused.reason : undefined;
}

function validRevocation(secret: string, nonce: string, entry: NonceEntry | undefined): boolean {
  const revoked = entry?.revoked;
  return !!revoked && typeof revoked.at === 'string' && typeof revoked.reason === 'string'
    && typeof revoked.signature === 'string'
    && sameMac(revoked.signature, revocationMac(secret, nonce, revoked.at, revoked.reason));
}

function linkedMessage(secret: string, nonce: string, entry: NonceEntry | undefined): string | undefined {
  const message = entry?.message;
  if (!message || typeof message.id !== 'string' || typeof message.signature !== 'string') return undefined;
  return sameMac(message.signature, messageMac(secret, nonce, message.id)) ? message.id : undefined;
}

/** Drop workflow nonce entries (and their message aliases) older than the
 *  TTL. Runs inside every workflow registry write, so the file stays bounded
 *  by the handoffs of the last two days. */
function pruneExpiredWorkflowEntries(registry: Record<string, unknown>, now: number): void {
  for (const [key, value] of Object.entries(registry)) {
    if (!key.startsWith(NONCE_KEY_PREFIX)) continue;
    const entry = value as NonceEntry | undefined;
    const stamps = [entry?.workflowHandoff?.payload?.issuedAt, entry?.revoked?.at, entry?.refused?.at]
      .map((stamp) => (typeof stamp === 'string' ? Date.parse(stamp) : NaN))
      .filter((ms) => Number.isFinite(ms));
    const newest = stamps.length > 0 ? Math.max(...stamps) : NaN;
    if (Number.isFinite(newest) && now - newest <= WORKFLOW_HANDOFF_ENTRY_TTL_MS) continue;
    const messageId = entry?.message?.id;
    delete registry[key];
    if (typeof messageId === 'string') {
      const alias = registry[messageId] as { kind?: unknown } | undefined;
      if (alias?.kind === 'workflow-handoff-message') delete registry[messageId];
    }
  }
}

/** Register the binding before the handoff is sent. Re-recording the same
 *  binding is a no-op; a different binding under an existing nonce is
 *  refused. Returns whether the handoff was already revoked. */
export async function recordWorkflowHandoffBinding(
  dataDir: string,
  secret: string,
  binding: SignedWorkflowHandoffBinding,
  now: number = Date.now(),
): Promise<{ revoked: boolean }> {
  let revoked = false;
  await updateDispatchRegistry(registryPath(dataDir), (registry) => {
    pruneExpiredWorkflowEntries(registry, now);
    const key = `${NONCE_KEY_PREFIX}${binding.payload.nonce}`;
    const entry: NonceEntry = nonceEntry(registry, binding.payload.nonce) ?? { kind: 'workflow-handoff' };
    if (entry.workflowHandoff) {
      // A same-key re-send re-signs at a new time; anything else differing
      // (route, target, attempt) is a different binding and is refused.
      const prior = verifyWorkflowHandoffBinding(secret, binding.payload.nonce, entry.workflowHandoff);
      const sameRoute = (payload: WorkflowHandoffBindingPayload) => JSON.stringify({ ...payload, issuedAt: '' });
      if (!prior || sameRoute(prior) !== sameRoute(binding.payload)) {
        throw new Error(`workflow handoff ${binding.payload.nonce} is already bound differently`);
      }
    } else {
      entry.workflowHandoff = binding;
    }
    revoked = validRevocation(secret, binding.payload.nonce, entry);
    registry[key] = entry;
  });
  return { revoked };
}

/** Link the sent handoff's message id to its nonce (the report key). */
export async function linkWorkflowHandoffMessage(
  dataDir: string,
  secret: string,
  nonce: string,
  messageId: string,
  now: number = Date.now(),
): Promise<void> {
  if (!MESSAGE_ID_RE.test(messageId)) throw new Error('invalid handoff message id');
  await updateDispatchRegistry(registryPath(dataDir), (registry) => {
    pruneExpiredWorkflowEntries(registry, now);
    const entry = nonceEntry(registry, nonce);
    if (!entry?.workflowHandoff) throw new Error(`workflow handoff ${nonce} is not registered`);
    const prior = linkedMessage(secret, nonce, entry);
    if (prior && prior !== messageId) throw new Error(`workflow handoff ${nonce} is linked to ${prior}`);
    const alias = registry[messageId] as { kind?: unknown; nonce?: unknown } | undefined;
    if (alias !== undefined && !(alias && alias.kind === 'workflow-handoff-message' && alias.nonce === nonce)) {
      throw new Error(`dispatch registry entry already exists for ${messageId}`);
    }
    entry.message = { id: messageId, signature: messageMac(secret, nonce, messageId) };
    // Deliberately none of the dispatch-entry fields (orchSessionId, bots,
    // reportBinding…): ordinary dispatch readers skip this entry, and the
    // report relay refuses it as an unproven dispatch binding.
    registry[messageId] = { kind: 'workflow-handoff-message', nonce };
  });
}

/** Revoke a handoff (idempotent; may precede its registration). */
export async function revokeWorkflowHandoff(
  dataDir: string,
  secret: string,
  nonce: string,
  reason: string,
  now: number = Date.now(),
): Promise<void> {
  if (!WORKFLOW_HANDOFF_NONCE_RE.test(nonce)) throw new Error('invalid handoff nonce');
  await updateDispatchRegistry(registryPath(dataDir), (registry) => {
    pruneExpiredWorkflowEntries(registry, now);
    const entry: NonceEntry = nonceEntry(registry, nonce) ?? { kind: 'workflow-handoff' };
    if (validRevocation(secret, nonce, entry)) return;
    const at = new Date(now).toISOString();
    entry.revoked = { at, reason, signature: revocationMac(secret, nonce, at, reason) };
    registry[`${NONCE_KEY_PREFIX}${nonce}`] = entry;
  });
}

/** The executing bot refused to start this handoff's session (design
 *  §15.4): durable, so the main bot's acceptance check still learns why when
 *  the direct notice could not reach it. The first reason is kept. */
export async function recordWorkflowHandoffRefusal(
  dataDir: string,
  secret: string,
  nonce: string,
  reason: string,
  now: number = Date.now(),
): Promise<void> {
  if (!WORKFLOW_HANDOFF_NONCE_RE.test(nonce)) throw new Error('invalid handoff nonce');
  const text = reason.slice(0, 2000);
  await updateDispatchRegistry(registryPath(dataDir), (registry) => {
    pruneExpiredWorkflowEntries(registry, now);
    const entry = nonceEntry(registry, nonce);
    if (!entry?.workflowHandoff || validRefusal(secret, nonce, entry) !== undefined) return;
    const at = new Date(now).toISOString();
    entry.refused = { at, reason: text, signature: refusalMac(secret, nonce, at, text) };
    registry[`${NONCE_KEY_PREFIX}${nonce}`] = entry;
  });
}

/** Whether `nonce` carries a valid revocation (with or without a binding). */
export function isWorkflowHandoffRevoked(registry: Record<string, unknown>, nonce: string, secret: string): boolean {
  return WORKFLOW_HANDOFF_NONCE_RE.test(nonce) && validRevocation(secret, nonce, nonceEntry(registry, nonce));
}

export type WorkflowHandoffLookup =
  | {
      kind: 'workflow';
      binding: WorkflowHandoffBindingPayload;
      /** The linked handoff message id, once sent. */
      messageId?: string;
      revoked: boolean;
      /** Why the executing bot would not start it, when it said so. */
      refusal?: string;
    }
  /** An entry claims to be a workflow handoff but does not verify. Fail
   *  closed — never treat it as an ordinary dispatch. */
  | { kind: 'unproven' }
  /** Not a workflow handoff. */
  | { kind: 'none' };

export function lookupWorkflowHandoffByNonce(input: {
  registry: Record<string, unknown>;
  nonce: string;
  secret: string;
}): WorkflowHandoffLookup {
  if (!WORKFLOW_HANDOFF_NONCE_RE.test(input.nonce)) return { kind: 'none' };
  const entry = nonceEntry(input.registry, input.nonce);
  if (!entry) return { kind: 'none' };
  if (!entry.workflowHandoff) return { kind: 'none' };
  const binding = verifyWorkflowHandoffBinding(input.secret, input.nonce, entry.workflowHandoff);
  if (!binding) return { kind: 'unproven' };
  const messageId = linkedMessage(input.secret, input.nonce, entry);
  const refusal = validRefusal(input.secret, input.nonce, entry);
  return {
    kind: 'workflow',
    binding,
    ...(messageId ? { messageId } : {}),
    revoked: validRevocation(input.secret, input.nonce, entry),
    ...(refusal !== undefined ? { refusal } : {}),
  };
}

/** Lookup by the handoff message id (the `--dispatch-root` key). */
export function lookupWorkflowHandoff(input: {
  registry: Record<string, unknown>;
  dispatchRoot: string;
  secret: string;
}): WorkflowHandoffLookup {
  const alias = input.registry[input.dispatchRoot];
  if (!alias || typeof alias !== 'object' || Array.isArray(alias)) return { kind: 'none' };
  const record = alias as { kind?: unknown; nonce?: unknown };
  if (record.kind !== 'workflow-handoff-message') return { kind: 'none' };
  if (typeof record.nonce !== 'string') return { kind: 'unproven' };
  const found = lookupWorkflowHandoffByNonce({ registry: input.registry, nonce: record.nonce, secret: input.secret });
  if (found.kind !== 'workflow') return found.kind === 'none' ? { kind: 'unproven' } : found;
  return found.messageId === input.dispatchRoot ? found : { kind: 'unproven' };
}

export type InboundWorkflowHandoff =
  | { kind: 'handoff'; binding: WorkflowHandoffBindingPayload }
  /** A real handoff for this bot that was stopped: drop the message. */
  | { kind: 'revoked'; binding: WorkflowHandoffBindingPayload };

/**
 * Receiver side: decide whether an inbound bot message is a workflow handoff
 * addressed to this bot, in this chat, in its node topic. Every handoff card
 * prints its nonce, so a message without one is decided without reading the
 * registry at all (the ordinary path costs nothing).
 *
 * - A message whose exact id is linked to the nonce is the handoff (only the
 *   orchestrator could have produced that id).
 * - Before the link exists, the nonce alone is not enough — anyone in the
 *   chat can echo a printed card. The sender must then be PROVEN to be the
 *   orchestrator's own bot (`proveSender`); anything unproven is an ordinary
 *   message (fail closed; acceptance timeout / retry handle a lost handoff).
 * - A nonce already linked to another message is never this handoff.
 */
export async function resolveInboundWorkflowHandoff(input: {
  readRegistry: () => Record<string, unknown>;
  secret: () => string;
  messageId: string;
  content: string;
  chatId: string;
  threadRootId: string | undefined;
  selfLarkAppId: string;
  /** Whether the message's sender is `sourceLarkAppId`'s bot in this chat. */
  proveSender: (sourceLarkAppId: string) => boolean | Promise<boolean>;
}): Promise<InboundWorkflowHandoff | undefined> {
  if (!MESSAGE_ID_RE.test(input.messageId) || !input.threadRootId) return undefined;
  const nonces = extractWorkflowHandoffNonces(input.content);
  if (nonces.length === 0) return undefined; // the common, ordinary case
  const registry = input.readRegistry();
  const secret = input.secret();
  for (const nonce of nonces) {
    const found = lookupWorkflowHandoffByNonce({ registry, nonce, secret });
    if (found.kind !== 'workflow') continue;
    const binding = found.binding;
    if (binding.targetLarkAppId !== input.selfLarkAppId
      || binding.targetChatId !== input.chatId
      || binding.publishRoot !== input.threadRootId) continue;
    if (found.messageId && found.messageId !== input.messageId) continue;
    if (!found.messageId && !(await input.proveSender(binding.sourceLarkAppId))) continue;
    return found.revoked ? { kind: 'revoked', binding } : { kind: 'handoff', binding };
  }
  return undefined;
}
