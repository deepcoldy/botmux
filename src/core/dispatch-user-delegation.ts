import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { TrustedCaller, TurnParticipant } from '../types.js';
import { updateDispatchRegistry } from './dispatch-registry.js';
import type { TriggerUserAuthTool } from '../services/trigger-user-auth.js';

export const DISPATCH_USER_DELIVERY_ROUTE = '/api/dispatch-user/deliver';
const identity = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[A-Za-z0-9_-]{1,128}$`));
const authoritySchema = z.object({
  appId: identity('cli_'),
  openId: identity('ou_'),
  unionId: identity('on_'),
  tools: z.array(z.enum(['lark-cli', 'bytedcli'])).min(1).max(2),
}).strict();
const payloadSchema = z.object({
  domain: z.literal('botmux.dispatch-user.v1'),
  deliveryId: z.string().uuid(),
  sourceAppId: identity('cli_'),
  sourceSessionId: z.string().min(1).max(256),
  sourceTurnId: z.string().min(1).max(256),
  rootId: identity('om_'),
  chatId: identity('oc_'),
  targetAppIds: z.array(identity('cli_')).min(1).max(64),
  authority: authoritySchema,
  issuedAt: z.number().int().nonnegative(),
  messageId: identity('om_').optional(),
}).strict();

/** A credential-store reference, never credentials. openId belongs ONLY to appId. */
export type DispatchUserAuthority = z.infer<typeof authoritySchema>;
export type DispatchUserPayload = z.infer<typeof payloadSchema>;
export interface SignedDispatchUser { payload: DispatchUserPayload; signature: string }

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
  const sender = reply?.senderOpenId;
  if (!sender || !reply?.participants?.some(p => p.openId === sender && p.isBot === false)) return;
  return { requestLarkAppId: appId, requestUserOpenId: sender, senderType: 'user' };
}

/** Only a daemon-authenticated, current human turn may originate a delegation. */
export async function authorityForDispatch(input: {
  caller?: TrustedCaller;
  sourceAppId: string;
  tools: TriggerUserAuthTool[];
  inherited?: DispatchUserAuthority;
  resolveUnionId: (appId: string, openId: string) => Promise<string | null>;
}): Promise<DispatchUserAuthority | undefined> {
  if (!input.tools.length) return;
  // An inherited authority is accepted only after verification for this exact turn.
  if (input.inherited) {
    const tools = input.inherited.tools.filter(tool => input.tools.includes(tool));
    return tools.length ? authoritySchema.parse({ ...input.inherited, tools }) : undefined;
  }
  const c = input.caller;
  if (c?.senderType !== 'user' || c.source || c.requestLarkAppId !== input.sourceAppId
    || !c.requestUserOpenId) return;
  const unionId = c.requestUserUnionId
    ?? await input.resolveUnionId(input.sourceAppId, c.requestUserOpenId);
  if (!unionId) throw new Error('dispatch_user_identity_unresolved');
  return authoritySchema.parse({
    appId: input.sourceAppId, openId: c.requestUserOpenId, unionId, tools: input.tools,
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

/** Register before sending; the receiver may observe the event before send resolves.
 * A pending record grants nothing. It only lets that receiver wait for the exact
 * message-id binding. Crash/timeout remains a refusal, never a root-wide grant. */
export async function deliverDispatchWithUser(input: {
  dataDir: string;
  secret: string;
  payload: Omit<DispatchUserPayload, 'domain' | 'deliveryId' | 'issuedAt' | 'messageId'>;
  send: () => Promise<string>;
}): Promise<string> {
  const pending = signDispatchUser(input.secret, {
    sourceAppId: input.payload.sourceAppId, sourceSessionId: input.payload.sourceSessionId,
    sourceTurnId: input.payload.sourceTurnId, rootId: input.payload.rootId, chatId: input.payload.chatId,
    targetAppIds: input.payload.targetAppIds, authority: input.payload.authority,
    domain: 'botmux.dispatch-user.v1', deliveryId: randomUUID(), issuedAt: Date.now(),
  });
  const key = `pending:${pending.payload.deliveryId}`;
  const path = dispatchUserStorePath(input.dataDir);
  await updateDispatchRegistry(path, store => { store[key] = pending; });
  try {
    const messageId = await input.send();
    const completed = signDispatchUser(input.secret, { ...pending.payload, messageId });
    await updateDispatchRegistry(path, store => {
      if (store[messageId] !== undefined) throw new Error('duplicate dispatch message identity');
      store[messageId] = completed;
      delete store[key];
    });
    return messageId;
  } catch (error) {
    await updateDispatchRegistry(path, store => { delete store[key]; });
    throw error;
  }
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
  if (!input.rootId) return;
  const deadline = Date.now() + (input.waitMs ?? 5000);
  const matches = (p: DispatchUserPayload): boolean => p.rootId === input.rootId
    && p.chatId === input.chatId && p.targetAppIds.includes(input.appId);
  do {
    const store = readStore(input.dataDir);
    const exact = verifyDispatchUser(input.secret, store[input.turnId]);
    if (exact && exact.messageId === input.turnId && matches(exact)) return exact;
    const pending = Object.entries(store).some(([key, raw]) => {
      const p = key.startsWith('pending:') ? verifyDispatchUser(input.secret, raw) : undefined;
      return p && !p.messageId && matches(p) && Date.now() - p.issuedAt < 30_000;
    });
    if (!pending || Date.now() >= deadline) return;
    await delay(25);
  } while (Date.now() <= deadline);
}
