/**
 * Signed workflow handoff bindings (design 2026-11-03 §5.4, P3).
 *
 * A bot-executed workflow node is handed off with a card message; the binding
 * that lets the receiving bot's daemon trust that message, and later route the
 * node's `botmux report --dispatch-root <handoff>` submission back to the run,
 * is keyed by the HANDOFF MESSAGE ID itself. It lives in the same host-wide
 * `orchestrate-dispatch.json` registry and is signed with the same host secret
 * as dispatch report bindings, under its own protocol domain, so neither kind
 * of binding can be replayed as the other.
 *
 * The id is only known after Lark accepted the send, while the receiving
 * daemon may see the message event first. The sender therefore writes a short
 * pending marker (keyed by the handoff's idempotency uuid, naming the topic
 * root and target) before sending; a receiver that sees a bot message in that
 * topic waits briefly for the exact binding. The marker grants nothing.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { updateDispatchRegistry } from './dispatch-registry.js';

const DOMAIN = 'botmux.workflow-handoff-binding.v1';
const PENDING_PREFIX = 'workflow-handoff-pending:';
/** A pending marker outlives any plausible send; it only bounds a wait. */
export const WORKFLOW_HANDOFF_PENDING_TTL_MS = 10 * 60_000;

const MESSAGE_ID_RE = /^om_[A-Za-z0-9_-]{1,128}$/;
const CHAT_ID_RE = /^oc_[A-Za-z0-9_-]{1,128}$/;

export interface WorkflowHandoffRef {
  runId: string;
  nodeId: string;
  instanceId?: string;
  attemptId: string;
  revision: number;
}

export interface WorkflowHandoffBindingPayload {
  domain: typeof DOMAIN;
  /** The handoff message id (also the `--dispatch-root` the bot reports with). */
  dispatchRoot: string;
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

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0');
}

function canonicalPayload(raw: Record<string, unknown>): WorkflowHandoffBindingPayload {
  const workflow = raw.workflow && typeof raw.workflow === 'object' && !Array.isArray(raw.workflow)
    ? raw.workflow as Record<string, unknown>
    : undefined;
  if (typeof raw.dispatchRoot !== 'string' || !MESSAGE_ID_RE.test(raw.dispatchRoot)) throw new Error('invalid handoff id');
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
    dispatchRoot: raw.dispatchRoot,
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

function sign(secret: string, payload: WorkflowHandoffBindingPayload): string {
  return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('base64url');
}

export function createWorkflowHandoffBinding(
  secret: string,
  input: Omit<WorkflowHandoffBindingPayload, 'domain' | 'issuedAt'> & { issuedAt?: string },
): SignedWorkflowHandoffBinding {
  if (!secret) throw new Error('workflow handoff binding secret is empty');
  const payload = canonicalPayload({ ...input, issuedAt: input.issuedAt ?? new Date().toISOString() });
  return { payload, signature: sign(secret, payload) };
}

/** The verified payload for exactly `dispatchRoot`, or null (missing, forged,
 *  another domain, or bound to a different message). */
export function verifyWorkflowHandoffBinding(
  secret: string,
  dispatchRoot: string,
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
  if (payload.dispatchRoot !== dispatchRoot) return null;
  const expected = Buffer.from(sign(secret, payload), 'base64url');
  const provided = Buffer.from(binding.signature, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  return payload;
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

export type WorkflowHandoffLookup =
  | { kind: 'workflow'; binding: WorkflowHandoffBindingPayload }
  /** The registry entry claims to be a workflow handoff but its signature,
   *  domain or key does not verify. Fail closed — never treat it as ordinary. */
  | { kind: 'unproven' }
  /** Not a workflow handoff entry (absent, or an ordinary dispatch entry). */
  | { kind: 'none' };

export function lookupWorkflowHandoff(input: {
  registry: Record<string, unknown>;
  dispatchRoot: string;
  secret: string;
}): WorkflowHandoffLookup {
  const entry = input.registry[input.dispatchRoot];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { kind: 'none' };
  const raw = (entry as Record<string, unknown>).workflowHandoff;
  if (raw === undefined) return { kind: 'none' };
  const binding = verifyWorkflowHandoffBinding(input.secret, input.dispatchRoot, raw);
  return binding ? { kind: 'workflow', binding } : { kind: 'unproven' };
}

export interface WorkflowHandoffPending {
  chatId: string;
  publishRoot: string;
  targetLarkAppId: string;
  expiresAt: number;
}

/** Write the pre-send wait hint (idempotent per idempotency uuid). */
export async function recordWorkflowHandoffPending(
  dataDir: string,
  idempotencyKey: string,
  pending: WorkflowHandoffPending,
  now: number = Date.now(),
): Promise<void> {
  await updateDispatchRegistry(registryPath(dataDir), (registry) => {
    pruneExpiredPending(registry, now);
    registry[`${PENDING_PREFIX}${idempotencyKey}`] = { workflowHandoffPending: pending };
  });
}

/** Publish the signed binding under the handoff message id and drop its
 *  pending marker. Re-recording the same binding is a no-op; a different
 *  binding under an existing key is refused (keys are Lark message ids). */
export async function recordWorkflowHandoffBinding(
  dataDir: string,
  idempotencyKey: string,
  binding: SignedWorkflowHandoffBinding,
  now: number = Date.now(),
): Promise<void> {
  await updateDispatchRegistry(registryPath(dataDir), (registry) => {
    pruneExpiredPending(registry, now);
    delete registry[`${PENDING_PREFIX}${idempotencyKey}`];
    const key = binding.payload.dispatchRoot;
    const existing = registry[key] as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      const prior = existing && typeof existing === 'object' ? existing.workflowHandoff as SignedWorkflowHandoffBinding | undefined : undefined;
      if (prior && JSON.stringify(prior.payload.workflow) === JSON.stringify(binding.payload.workflow)) return;
      throw new Error(`dispatch registry entry already exists for ${key}`);
    }
    // Deliberately none of the dispatch-entry fields (orchSessionId, bots,
    // reportBinding…): ordinary dispatch readers skip this entry, and the
    // report relay refuses it as an unproven dispatch binding.
    registry[key] = {
      kind: 'workflow-handoff',
      createdAt: binding.payload.issuedAt,
      workflowHandoff: binding,
    };
  });
}

function pruneExpiredPending(registry: Record<string, unknown>, now: number): void {
  for (const [key, value] of Object.entries(registry)) {
    if (!key.startsWith(PENDING_PREFIX)) continue;
    const pending = (value as { workflowHandoffPending?: WorkflowHandoffPending } | undefined)?.workflowHandoffPending;
    if (!pending || !(pending.expiresAt > now)) delete registry[key];
  }
}

/** True when a live pending marker names this exact topic and receiver. */
export function hasPendingWorkflowHandoff(
  registry: Record<string, unknown>,
  input: { chatId: string; publishRoot: string; targetLarkAppId: string; now?: number },
): boolean {
  const now = input.now ?? Date.now();
  for (const [key, value] of Object.entries(registry)) {
    if (!key.startsWith(PENDING_PREFIX)) continue;
    const pending = (value as { workflowHandoffPending?: WorkflowHandoffPending } | undefined)?.workflowHandoffPending;
    if (!pending || !(pending.expiresAt > now)) continue;
    if (pending.chatId === input.chatId
      && pending.publishRoot === input.publishRoot
      && pending.targetLarkAppId === input.targetLarkAppId) return true;
  }
  return false;
}

/**
 * Receiver side: the verified handoff binding for an inbound bot message, or
 * none. When a pending marker announces a handoff into this topic, poll the
 * registry for the exact key for up to `waitMs` (the sender records it right
 * after Lark returns the id). A binding is accepted only when every routing
 * fact matches the inbound event: message id, chat, topic root and receiver.
 */
export async function resolveInboundWorkflowHandoff(input: {
  readRegistry: () => Record<string, unknown>;
  secret: () => string;
  messageId: string;
  chatId: string;
  threadRootId: string | undefined;
  selfLarkAppId: string;
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<WorkflowHandoffBindingPayload | undefined> {
  if (!MESSAGE_ID_RE.test(input.messageId) || !input.threadRootId) return undefined;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (input.waitMs ?? 5_000);
  let secret: string | undefined;
  for (;;) {
    const registry = input.readRegistry();
    const entry = registry[input.messageId];
    if (entry !== undefined) {
      secret ??= input.secret();
      const found = lookupWorkflowHandoff({ registry, dispatchRoot: input.messageId, secret });
      if (found.kind !== 'workflow') return undefined;
      const binding = found.binding;
      const matches = binding.targetLarkAppId === input.selfLarkAppId
        && binding.targetChatId === input.chatId
        && binding.publishRoot === input.threadRootId;
      return matches ? binding : undefined;
    }
    if (!hasPendingWorkflowHandoff(registry, {
      chatId: input.chatId,
      publishRoot: input.threadRootId,
      targetLarkAppId: input.selfLarkAppId,
      now: now(),
    })) return undefined;
    if (now() >= deadline) return undefined;
    await sleep(input.pollMs ?? 100);
  }
}
