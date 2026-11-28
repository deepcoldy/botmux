import { randomBytes } from 'node:crypto';
import { WecomTransport, type WecomTransportOptions } from './transport.js';
import type { WecomInboundMessage } from './types.js';

/**
 * Identity pairing over the bot's own WSS connection: authenticate, show a
 * one-time challenge, and accept exactly one single-chat text message that
 * repeats it. Shared by `botmux wecom identify` (gateway/identify.ts) and the
 * Dashboard's scan-to-create flow (dashboard/wecom/draft-identity.ts); callers
 * own locking and what happens to the verified userid.
 */

export interface WecomIdentityTransport {
  start(handler: (message: WecomInboundMessage) => Promise<void> | void): Promise<void>;
  stop(): Promise<void>;
}
export interface WecomDraftIdentity { userid: string; verifiedAt: string }
export interface WecomDraftIdentifyOptions {
  botId: string;
  secret: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onChallenge: (challenge: string) => void;
  onConnectionError?: () => void;
  /** Recheck job generation and registered bots after acquiring the same lock as the gateway. */
  beforeConnect?: () => void;
  createTransport?: (options: WecomTransportOptions) => WecomIdentityTransport;
  challenge?: () => string;
}
export async function runIdentityChallenge(options: WecomDraftIdentifyOptions): Promise<WecomDraftIdentity> {
  let settled = false;
  let challenge: string | undefined;
  let cancellationCode: string | undefined;
  let resolveIdentity!: (userid: string) => void;
  let rejectIdentity!: (error: Error) => void;
  const identity = new Promise<string>((done, fail) => {
    resolveIdentity = done;
    rejectIdentity = fail;
  });
  void identity.catch(() => {});
  const transport = (options.createTransport ?? (settings => new WecomTransport(settings)))({
    botId: options.botId, secret: options.secret,
    onError: () => options.onConnectionError?.(),
    onTerminalDisconnect: () => cancel('wecom_identify_disconnected'),
  });
  function cancel(code: string): void {
    if (settled) return;
    settled = true;
    cancellationCode = code;
    rejectIdentity(new Error(code));
    void transport.stop().catch(() => {});
  }
  const abort = () => cancel('wecom_identify_cancelled');
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new Error('wecom_identify_invalid_timeout');
  }
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => cancel('wecom_identify_timeout'), timeoutMs);
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal?.aborted) {
      abort();
      throw new Error('wecom_identify_cancelled');
    }
    options.beforeConnect?.();
    // Race cancellation even if an injected or broken transport never settles start().
    await Promise.race([transport.start(message => {
      if (Date.now() >= deadline) {
        cancel('wecom_identify_timeout');
        return;
      }
      if (settled || !challenge || !message.userId || message.chatType !== 'single' || message.text !== challenge
        || message.attachments.length || message.quote) {
        return;
      }
      settled = true;
      resolveIdentity(message.userId);
    }), identity]);
    if (cancellationCode) throw new Error(cancellationCode);
    if (options.signal?.aborted) throw new Error('wecom_identify_cancelled');
    if (Date.now() >= deadline) throw new Error('wecom_identify_timeout');
    challenge = options.challenge?.() ?? `BOTMUX-ID-${randomBytes(16).toString('hex').toUpperCase()}`;
    options.onChallenge(challenge);
    const userid = await identity;
    if (options.signal?.aborted) throw new Error('wecom_identify_cancelled');
    return { userid, verifiedAt: new Date().toISOString() };
  } catch (error) {
    if (cancellationCode) throw new Error(cancellationCode);
    if (error instanceof Error && /^wecom_identify_[a-z_]+$/.test(error.message)) throw error;
    throw new Error('wecom_identify_failed');
  } finally {
    settled = true;
    challenge = undefined;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    try {
      await transport.stop();
    } catch {
      throw new Error('wecom_identify_cleanup_failed');
    }
  }
}
