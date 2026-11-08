import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { TrustedCaller, TurnParticipant } from '../types.js';
import { updateDispatchRegistry } from './dispatch-registry.js';
import { registryEntryProvesHumanSender } from './reply-target.js';
import type { TriggerUserAuthTool } from '../services/trigger-user-auth.js';

export const DISPATCH_USER_DELIVERY_ROUTE = '/api/dispatch-user/deliver';
export const SCHEDULE_DELEGATED_ADD_ROUTE = '/api/schedule/delegated-add';
export const SCHEDULE_MANAGED_MUTATE_ROUTE = '/api/schedule/managed-mutate';
/** `botmux send --mention <bot on this machine>`: the CLI writes the message
 *  itself, so the daemon signs the delegation in two steps around that write. */
export const DISPATCH_USER_MENTION_PREPARE_ROUTE = '/api/dispatch-user/mention-prepare';
export const DISPATCH_USER_MENTION_BIND_ROUTE = '/api/dispatch-user/mention-bind';
/** Limit the complete UTF-8 JSON request, including routing and encoded brief. */
export const DISPATCH_USER_DELIVERY_MAX_BYTES = 64 * 1024;
const identity = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[A-Za-z0-9_-]{1,128}$`));
const authorityV1Schema = z.object({
  appId: identity('cli_'),
  openId: identity('ou_'),
  unionId: identity('on_'),
  tools: z.array(z.enum(['lark-cli', 'bytedcli'])).min(1).max(2),
}).strict();
const scheduleCreateCapabilitySchema = z.object({
  action: z.literal('schedule:create'),
  targetAppId: identity('cli_'),
  targetChatId: identity('oc_'),
  allowedExecutionPositions: z.array(z.enum(['top-level', 'topic'])).min(1).max(2),
  /** Persisted execution scopes are deliberately coarser than provider APIs. */
  allowedRunScopes: z.array(z.literal('bytedcli')).max(1),
  /** Fixed task-local lifecycle authority; absent on older v2 records. */
  allowSelfManage: z.boolean().optional(),
  botGrantId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
}).strict();
const authorityV2Schema = z.object({
  appId: identity('cli_'),
  openId: identity('ou_'),
  unionId: identity('on_'),
  tools: z.array(z.enum(['lark-cli', 'bytedcli'])).max(2),
  capabilities: z.array(scheduleCreateCapabilitySchema).min(1).max(64),
}).strict();
const payloadBase = {
  deliveryId: z.string().uuid(),
  sourceAppId: identity('cli_'),
  sourceSessionId: z.string().min(1).max(256),
  sourceTurnId: z.string().min(1).max(256),
  /** Thread the dispatched message is posted into. Absent on a
   *  `botmux send --mention` handoff: that message may land at the chat's top
   *  level, quoted or in a thread, so the record is pinned to the exact message
   *  id instead, after the daemon verified this bot posted it into `chatId`. */
  rootId: identity('om_').optional(),
  chatId: identity('oc_'),
  targetAppIds: z.array(identity('cli_')).min(1).max(64),
  issuedAt: z.number().int().nonnegative(),
  messageId: identity('om_').optional(),
};
const payloadV1Schema = z.object({
  domain: z.literal('botmux.dispatch-user.v1'),
  ...payloadBase,
  authority: authorityV1Schema,
}).strict();
const payloadV2Schema = z.object({
  domain: z.literal('botmux.dispatch-user.v2'),
  ...payloadBase,
  authority: authorityV2Schema,
}).strict();
/**
 * A workflow handoff's delegation (design 2026-11-03 §10.2, D5): signed by the
 * main bot's daemon for ONE attempt of ONE node of a run, from the identity
 * frozen at the run's authorization — never inherited from a node's report.
 * It names exactly one target bot, the run's chat, the node topic (`rootId`)
 * and, once sent, the handoff message. Same key, store and pending → bind
 * steps as a dispatch; only the source differs, hence its own domain.
 */
export const DISPATCH_USER_WORKFLOW_DOMAIN = 'botmux.dispatch-user.workflow.v1' as const;
const workflowRefSchema = z.object({
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  nodeId: z.string().min(1).max(256),
  instanceId: z.string().min(1).max(256).optional(),
  attemptId: z.string().min(1).max(256),
  /** Flow revision the attempt was dispatched under (design §13.3). */
  revision: z.number().int().positive(),
  /** The handoff's binding nonce (core/workflow-handoff-binding). */
  nonce: z.string().regex(/^wfh_[A-Za-z0-9_-]{24}$/),
  /** Absent: signed by the main bot for its handoff. n ≥ 1: passed on n
   *  hops by node bots (`botmux dispatch` / `send --mention` from the node
   *  session), still tied to the same attempt and narrowed at every hop. */
  hop: z.number().int().min(1).max(16).optional(),
}).strict();
const payloadWorkflowSchema = z.object({
  domain: z.literal(DISPATCH_USER_WORKFLOW_DOMAIN),
  ...payloadBase,
  /** The node topic for the main bot's handoff; a passed-on record follows
   *  the dispatch's own rule (a thread, or none for a --mention handoff). */
  rootId: identity('om_').optional(),
  targetAppIds: z.array(identity('cli_')).min(1).max(64),
  workflow: workflowRefSchema,
  authority: authorityV1Schema,
}).strict();
const payloadSchema = z.discriminatedUnion('domain', [payloadV1Schema, payloadV2Schema, payloadWorkflowSchema]);

/** A credential-store reference, never credentials. openId belongs ONLY to appId. */
export type ScheduleCreateCapability = z.infer<typeof scheduleCreateCapabilitySchema>;
export type DispatchUserAuthority = z.infer<typeof authorityV1Schema> | z.infer<typeof authorityV2Schema>;
export type DispatchUserPayload = z.infer<typeof payloadSchema>;
export type WorkflowDispatchUserRef = z.infer<typeof workflowRefSchema>;
export type WorkflowDispatchUserPayload = z.infer<typeof payloadWorkflowSchema>;
export interface SignedDispatchUser { payload: DispatchUserPayload; signature: string }

export function scheduleCreateCapabilities(authority: DispatchUserAuthority): ScheduleCreateCapability[] {
  const raw = (authority as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(value => {
    const parsed = scheduleCreateCapabilitySchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

export function signDispatchUser(secret: string, value: DispatchUserPayload): SignedDispatchUser {
  if (!secret) throw new Error('missing dispatch identity signing key');
  const payload = payloadSchema.parse(value);
  const signature = createHmac('sha256', secret).update(JSON.stringify(payload)).digest('base64url');
  return { payload, signature };
}

export function verifyDispatchUser(secret: string, raw: unknown): DispatchUserPayload | undefined {
  try {
    if (!secret || !raw || typeof raw !== 'object') return;
    const signed = raw as SignedDispatchUser;
    const expected = signDispatchUser(secret, signed.payload);
    const a = Buffer.from(expected.signature, 'base64url');
    const b = Buffer.from(signed.signature, 'base64url');
    if (a.length === b.length && timingSafeEqual(a, b)) return expected.payload;
  } catch { /* malformed or forged records never confer authority */ }
}

/** Recover only the exact platform-observed human on a restored turn. Neither
 * the session owner nor another participant/last caller can fill a missing sender. */
export function dispatchCallerFromReply(appId: string, reply?: {
  senderOpenId?: string; participants?: TurnParticipant[];
}): TrustedCaller | undefined {
  if (!registryEntryProvesHumanSender(reply)) return;
  return { requestLarkAppId: appId, requestUserOpenId: reply.senderOpenId, senderType: 'user' };
}

/** Only a daemon-authenticated, current human turn may originate a delegation. */
export async function authorityForDispatch(input: {
  caller?: TrustedCaller;
  sourceAppId: string;
  tools: TriggerUserAuthTool[];
  inherited?: DispatchUserAuthority;
  scheduleCreate?: {
    targetAppIds: string[];
    targetChatId: string;
    allowedRunScopes?: Array<'bytedcli'>;
    allowSelfManage?: boolean;
  };
  resolveUnionId: (appId: string, openId: string) => Promise<string | null>;
}): Promise<DispatchUserAuthority | undefined> {
  if (!input.tools.length && !input.scheduleCreate) return;
  // An inherited authority is accepted only after verification for this exact turn.
  if (input.inherited) {
    const tools = input.inherited.tools.filter(tool => input.tools.includes(tool));
    // Persistent schedule authority is deliberately never inherited.  A peer
    // bot may narrow the existing immediate-tool delegation, but cannot mint a
    // durable task from it or forward one to a third bot.
    return tools.length ? authorityV1Schema.parse({
      appId: input.inherited.appId,
      openId: input.inherited.openId,
      unionId: input.inherited.unionId,
      tools,
    }) : undefined;
  }
  const c = input.caller;
  if (c?.senderType !== 'user' || c.source || c.requestLarkAppId !== input.sourceAppId
    || !c.requestUserOpenId) return;
  const unionId = c.requestUserUnionId
    ?? await input.resolveUnionId(input.sourceAppId, c.requestUserOpenId);
  if (!unionId) throw new Error('dispatch_user_identity_unresolved');
  const base = { appId: input.sourceAppId, openId: c.requestUserOpenId, unionId, tools: input.tools };
  if (!input.scheduleCreate) return authorityV1Schema.parse(base);
  const allowedRunScopes = (input.scheduleCreate.allowedRunScopes ?? [])
    .filter(scope => input.tools.includes(scope));
  return authorityV2Schema.parse({
    ...base,
    capabilities: input.scheduleCreate.targetAppIds.map(targetAppId => ({
      action: 'schedule:create' as const,
      targetAppId,
      targetChatId: input.scheduleCreate!.targetChatId,
      allowedExecutionPositions: ['top-level', 'topic'] as const,
      allowedRunScopes,
      ...(input.scheduleCreate!.allowSelfManage ? { allowSelfManage: true } : {}),
    })),
  });
}

export const dispatchUserStorePath = (dataDir: string): string => join(dataDir, 'dispatch-user-delegations.json');

function readStore(dataDir: string): Record<string, unknown> {
  const path = dispatchUserStorePath(dataDir);
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid dispatch identity store');
  return value as Record<string, unknown>;
}

type DispatchUserPayloadInput = Omit<DispatchUserPayload, 'domain' | 'deliveryId' | 'issuedAt' | 'messageId'> & {
  /** Present only on a workflow handoff (its own domain, §10.2). */
  workflow?: WorkflowDispatchUserRef;
};

/** Two workflow records for the same handoff: same source, chat, topic,
 *  target and attempt. A same-key re-send of a handoff (Lark returns the
 *  message it already delivered) re-binds onto such a record. */
function sameWorkflowHandoff(a: DispatchUserPayload, b: DispatchUserPayload): boolean {
  if (a.domain !== DISPATCH_USER_WORKFLOW_DOMAIN || b.domain !== DISPATCH_USER_WORKFLOW_DOMAIN) return false;
  return a.sourceAppId === b.sourceAppId && a.chatId === b.chatId && a.rootId === b.rootId
    && JSON.stringify(a.targetAppIds) === JSON.stringify(b.targetAppIds)
    && JSON.stringify(a.workflow) === JSON.stringify(b.workflow);
}

/** Register before sending; the receiver may observe the event before send resolves.
 * A pending record grants nothing. It only lets that receiver wait for the exact
 * message-id binding. Crash/timeout remains a refusal, never a root-wide grant. */
export async function registerPendingDispatchUser(input: {
  dataDir: string;
  secret: string;
  payload: DispatchUserPayloadInput;
}): Promise<SignedDispatchUser> {
  const v2 = scheduleCreateCapabilities(input.payload.authority).length > 0;
  const workflow = input.payload.workflow;
  const pending = signDispatchUser(input.secret, {
    sourceAppId: input.payload.sourceAppId, sourceSessionId: input.payload.sourceSessionId,
    sourceTurnId: input.payload.sourceTurnId,
    ...(input.payload.rootId ? { rootId: input.payload.rootId } : {}),
    chatId: input.payload.chatId,
    targetAppIds: input.payload.targetAppIds, authority: input.payload.authority,
    ...(workflow ? { workflow } : {}),
    domain: workflow ? DISPATCH_USER_WORKFLOW_DOMAIN : v2 ? 'botmux.dispatch-user.v2' : 'botmux.dispatch-user.v1',
    deliveryId: randomUUID(), issuedAt: Date.now(),
  } as DispatchUserPayload);
  await updateDispatchRegistry(dispatchUserStorePath(input.dataDir), store => {
    store[`pending:${pending.payload.deliveryId}`] = pending;
  });
  return pending;
}

/** The still-unbound registration for `deliveryId`, verified. */
export function readPendingDispatchUser(dataDir: string, secret: string, deliveryId: string): DispatchUserPayload | undefined {
  const payload = verifyDispatchUser(secret, readStore(dataDir)[`pending:${deliveryId}`]);
  return payload && payload.deliveryId === deliveryId && !payload.messageId ? payload : undefined;
}

/** Bind a registration to the message it was sent as. Throws when the message
 * id already carries a record or the registration is gone — except a workflow
 * handoff re-sent with its frozen uuid, which Lark answers with the message it
 * already delivered: the record bound to it for the same handoff is replaced
 * by this one (signed now, from the same frozen identity, after this send's
 * own target check). */
export async function bindPendingDispatchUser(input: {
  dataDir: string;
  secret: string;
  deliveryId: string;
  messageId: string;
}): Promise<DispatchUserPayload> {
  const key = `pending:${input.deliveryId}`;
  let bound: DispatchUserPayload | undefined;
  await updateDispatchRegistry(dispatchUserStorePath(input.dataDir), store => {
    const pending = verifyDispatchUser(input.secret, store[key]);
    if (!pending || pending.deliveryId !== input.deliveryId || pending.messageId) {
      throw new Error('dispatch registration is missing or already bound');
    }
    const existing = store[input.messageId];
    if (existing !== undefined) {
      const prior = verifyDispatchUser(input.secret, existing);
      if (!prior || prior.messageId !== input.messageId || !sameWorkflowHandoff(prior, pending)) {
        throw new Error('duplicate dispatch message identity');
      }
    }
    const completed = signDispatchUser(input.secret, { ...pending, messageId: input.messageId });
    store[input.messageId] = completed;
    delete store[key];
    bound = completed.payload;
  });
  return bound!;
}

export async function dropPendingDispatchUser(dataDir: string, deliveryId: string): Promise<void> {
  await updateDispatchRegistry(dispatchUserStorePath(dataDir), store => { delete store[`pending:${deliveryId}`]; });
}

export async function deliverDispatchWithUser(input: {
  dataDir: string;
  secret: string;
  payload: DispatchUserPayloadInput;
  send: () => Promise<string>;
}): Promise<string> {
  const pending = await registerPendingDispatchUser(input);
  const deliveryId = pending.payload.deliveryId;
  let messageId: string;
  try {
    messageId = await input.send();
  } catch (error) {
    await dropPendingDispatchUser(input.dataDir, deliveryId);
    throw error;
  }
  try {
    await bindPendingDispatchUser({ dataDir: input.dataDir, secret: input.secret, deliveryId, messageId });
  } catch (error) {
    await dropPendingDispatchUser(input.dataDir, deliveryId);
    throw error;
  }
  return messageId;
}

export async function resolveDispatchUser(input: {
  dataDir: string;
  secret: string;
  appId: string;
  chatId: string;
  rootId?: string;
  turnId: string;
  waitMs?: number;
}): Promise<DispatchUserPayload | undefined> {
  const deadline = Date.now() + (input.waitMs ?? 5000);
  const addressed = (p: DispatchUserPayload): boolean => p.chatId === input.chatId
    && p.targetAppIds.includes(input.appId);
  // A dispatch record names its thread. A --mention handoff record has none:
  // it is pinned to one exact message whose author and chat were verified
  // before binding, so it applies to that message wherever it landed.
  const rootMatches = (p: DispatchUserPayload): boolean => p.rootId === undefined
    || p.rootId === input.rootId;
  do {
    const store = readStore(input.dataDir);
    const exact = verifyDispatchUser(input.secret, store[input.turnId]);
    if (exact && exact.messageId === input.turnId && addressed(exact) && rootMatches(exact)) return exact;
    const pending = Object.entries(store).some(([key, raw]) => {
      const p = key.startsWith('pending:') ? verifyDispatchUser(input.secret, raw) : undefined;
      return p && !p.messageId && addressed(p)
        && (p.rootId === undefined || p.rootId === input.rootId)
        && Date.now() - p.issuedAt < 30_000;
    });
    if (!pending || Date.now() >= deadline) return;
    await delay(25);
  } while (Date.now() <= deadline);
}

/**
 * Whether a message the CLI reports as its handoff is really that handoff:
 * posted by this bot, into the registered chat, after the registration. Without this a registration could be bound to some other
 * message — e.g. another bot's message to the same target, whose turn would
 * then run with this turn's human.
 */
export function handoffMessageMatches(detail: unknown, expected: {
  messageId: string;
  appId: string;
  chatId: string;
  issuedAt: number;
}): boolean {
  const record = detail as { items?: unknown[] } | null | undefined;
  const item = (Array.isArray(record?.items) ? record!.items[0] : undefined) as {
    message_id?: unknown; chat_id?: unknown; create_time?: unknown;
    sender?: { id?: unknown; id_type?: unknown; sender_type?: unknown };
  } | undefined;
  if (!item || item.message_id !== expected.messageId || item.chat_id !== expected.chatId) return false;
  // Lark stamps a bot's message 'app' or (seen on cross-bot cards) 'bot'; the
  // identity claim is the app id either way.
  const sender = item.sender;
  if (!sender || (sender.sender_type !== 'app' && sender.sender_type !== 'bot')
    || sender.id !== expected.appId
    || (sender.id_type !== undefined && sender.id_type !== 'app_id')) return false;
  const created = Number(item.create_time);
  // Lark stamps create_time in ms; allow the two clocks a minute of skew.
  return Number.isFinite(created) && created >= expected.issuedAt - 60_000;
}

/** Fetch the handoff message for {@link handoffMessageMatches}. A message read
 *  right after the send can briefly be unreadable; retry a provider failure a
 *  couple of times (well inside the receiver's 5 s wait) before giving up. A
 *  message that IS returned is never re-read: a mismatch is final. */
export async function readHandoffMessage<T>(
  read: () => Promise<T>,
  options: { attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(options.intervalMs ?? 200);
    try { return await read(); } catch (error) { lastError = error; }
  }
  throw lastError;
}
