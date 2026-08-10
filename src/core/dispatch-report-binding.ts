import { createHmac, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';

const DOMAIN = 'botmux.dispatch-report-binding.v1';

export const DISPATCH_REPORT_REGISTER_ROUTE = '/api/report-relay/register';
export const DISPATCH_REPORT_REGISTER_MAX_BYTES = 64 * 1024;

export interface DispatchReportBindingPayload {
  domain: typeof DOMAIN;
  dispatchRoot: string;
  targetLarkAppId: string;
  targetSessionId: string;
  sourceName: string;
  issuedAt: string;
}

export interface SignedDispatchReportBinding {
  payload: DispatchReportBindingPayload;
  signature: string;
}

export function dispatchReportBindingSecretPath(dataDir: string): string {
  return join(dirname(dataDir), '.dashboard-secret.report-binding');
}

function validDispatchRoot(value: string): boolean {
  return /^om_[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !value.includes('\0');
}

function canonicalPayload(input: {
  dispatchRoot: string;
  targetLarkAppId: string;
  targetSessionId: string;
  sourceName?: string;
  issuedAt?: string;
}): DispatchReportBindingPayload {
  const dispatchRoot = input.dispatchRoot.trim();
  const targetLarkAppId = input.targetLarkAppId.trim();
  const targetSessionId = input.targetSessionId.trim();
  if (!validDispatchRoot(dispatchRoot)) throw new Error('invalid dispatch root');
  if (!validIdentity(targetLarkAppId) || !validIdentity(targetSessionId)) {
    throw new Error('invalid dispatch report target');
  }
  const sourceName = input.sourceName?.trim().slice(0, 200) || 'dispatched subtask';
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(issuedAt))) throw new Error('invalid dispatch report issue time');
  return {
    domain: DOMAIN,
    dispatchRoot,
    targetLarkAppId,
    targetSessionId,
    sourceName,
    issuedAt,
  };
}

function signPayload(secret: string, payload: DispatchReportBindingPayload): string {
  return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('base64url');
}

export function createDispatchReportBinding(
  secret: string,
  input: Omit<DispatchReportBindingPayload, 'domain'>,
): SignedDispatchReportBinding {
  if (!secret) throw new Error('dispatch report binding secret is empty');
  const payload = canonicalPayload(input);
  return { payload, signature: signPayload(secret, payload) };
}

export function verifyDispatchReportBinding(
  secret: string,
  dispatchRoot: string,
  raw: unknown,
): DispatchReportBindingPayload | null {
  if (!secret || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const binding = raw as Record<string, unknown>;
  if (!binding.payload || typeof binding.payload !== 'object' || Array.isArray(binding.payload)
    || typeof binding.signature !== 'string') return null;
  const candidate = binding.payload as Record<string, unknown>;
  try {
    const payload = canonicalPayload({
      dispatchRoot: typeof candidate.dispatchRoot === 'string' ? candidate.dispatchRoot : '',
      targetLarkAppId: typeof candidate.targetLarkAppId === 'string'
        ? candidate.targetLarkAppId
        : '',
      targetSessionId: typeof candidate.targetSessionId === 'string'
        ? candidate.targetSessionId
        : '',
      sourceName: typeof candidate.sourceName === 'string' ? candidate.sourceName : '',
      issuedAt: typeof candidate.issuedAt === 'string' ? candidate.issuedAt : '',
    });
    if (candidate.domain !== DOMAIN || payload.dispatchRoot !== dispatchRoot) return null;
    const expected = Buffer.from(signPayload(secret, payload), 'base64url');
    const provided = Buffer.from(binding.signature, 'base64url');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function resolveVerifiedDispatchReportTarget(input: {
  registry: Record<string, unknown>;
  dispatchRoot: string;
  secret: string;
}):
  | { ok: true; binding: DispatchReportBindingPayload }
  | { ok: false; error: 'dispatch_target_unavailable' | 'dispatch_binding_unproven' } {
  const rawEntry = input.registry[input.dispatchRoot];
  if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
    return { ok: false, error: 'dispatch_target_unavailable' };
  }
  const binding = verifyDispatchReportBinding(
    input.secret,
    input.dispatchRoot,
    (rawEntry as Record<string, unknown>).reportBinding,
  );
  return binding
    ? { ok: true, binding }
    : { ok: false, error: 'dispatch_binding_unproven' };
}

/** Prove a registry key is an actual seed sent by the registering daemon's bot. */
export function dispatchSeedOwnedBy(input: {
  message: unknown;
  dispatchRoot: string;
  targetChatId: string;
  larkAppId: string;
  botOpenId?: string;
}): boolean {
  if (!input.message || typeof input.message !== 'object' || Array.isArray(input.message)) {
    return false;
  }
  const message = input.message as Record<string, any>;
  const sender = message.sender && typeof message.sender === 'object'
    ? message.sender as Record<string, unknown>
    : {};
  const senderType = sender.sender_type ?? message.sender_type;
  const senderId = sender.open_bot_id ?? sender.id ?? sender.open_id ?? sender.app_id;
  const senderIdType = sender.open_bot_id
    ? 'open_id'
    : sender.id_type ?? sender.sender_id_type;
  const senderMatches = (senderIdType === 'app_id' && senderId === input.larkAppId)
    || senderId === input.larkAppId
    || (!!input.botOpenId && senderId === input.botOpenId);
  return message.message_id === input.dispatchRoot
    && message.chat_id === input.targetChatId
    && (senderType === 'app' || senderType === 'bot')
    && senderMatches;
}
