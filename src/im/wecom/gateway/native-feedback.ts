import { createHash } from 'node:crypto';
import {
  effectiveWebhookDestinations,
  type FeedbackEventEnvelope,
  type FrozenWebhookDestination,
} from '../../../services/feedback-outbox.js';
import {
  dispatchWebhookAttempt,
  computeRetryDelay,
  FeedbackWebhookSecretStore,
} from '../../../services/feedback-webhook-dispatcher.js';
import type { WecomNativePlatformConfig } from '../config/native-platform-config.js';

export interface NativeFeedbackOutboxRow {
  event: FeedbackEventEnvelope;
  destination: FrozenWebhookDestination;
  attempts: number;
  nextAttemptAt: number;
  status: 'pending' | 'sending' | 'delivered' | 'failed';
  error?: string;
}

export interface NativeFeedbackState {
  nativeFeedbackOutbox?: Record<string, NativeFeedbackOutboxRow>;
}

/** Called synchronously after updating feedback/terminal state, BEFORE the same
 * bridge save. One atomic state file contains both the fact and its outbox. */
export function enqueueWecomFeedbackEvent(
  state: NativeFeedbackState,
  policy: WecomNativePlatformConfig,
  input: {
    type: 'turn.completed' | 'feedback.revised';
    botId: string;
    taskId: string;
    sessionId: string;
    triggerId: string;
    conversationId: string;
    actor?: string;
    revision?: number;
    feedback?: unknown;
  },
  now = Date.now(),
): void {
  const eventId = `wecom_${createHash('sha256')
    .update(JSON.stringify([input.botId, input.taskId, input.type, input.actor ?? null, input.revision ?? 0]))
    .digest('hex')}`;
  const event: FeedbackEventEnvelope = {
    eventId,
    type: input.type,
    version: 1,
    time: new Date(now).toISOString(),
    data: { platform: 'wecom', ...structuredClone(input) },
  };
  for (const destination of effectiveWebhookDestinations(input.type, [policy.feedbackWebhooks])) {
    const key = createHash('sha256').update(JSON.stringify([eventId, destination.id])).digest('hex');
    (state.nativeFeedbackOutbox ??= {})[key] ??= {
      event,
      destination,
      attempts: 0,
      nextAttemptAt: now,
      status: 'pending',
    };
  }
}

/** Single gateway lane; a sending row after restart is outcome-unknown and
 * retried with the SAME event ID. Receivers can dedupe by X-Botmux-Event-Id. */
export async function dispatchWecomFeedbackOutbox(ctx: {
  state: NativeFeedbackState;
  save(): void;
  secretDir: string;
  now?: () => number;
  dispatch?: typeof dispatchWebhookAttempt;
  readSecret?: (ref: string) => string | undefined;
  allow?: () => boolean;
}): Promise<void> {
  const now = ctx.now ?? Date.now;
  const readSecret = ctx.readSecret ?? ((ref: string) => new FeedbackWebhookSecretStore(ctx.secretDir).get(ref));
  for (const row of Object.values(ctx.state.nativeFeedbackOutbox ?? {})) {
    if (ctx.allow?.() === false) {
      return;
    }
    if (!['pending', 'sending'].includes(row.status) || row.nextAttemptAt > now()) {
      continue;
    }
    const secret = readSecret(row.destination.secretRef);
    if (!secret) {
      row.status = 'failed';
      row.error = 'webhook_secret_missing';
      ctx.save();
      continue;
    }
    row.status = 'sending';
    row.attempts++;
    ctx.save();
    try {
      const result = await (ctx.dispatch ?? dispatchWebhookAttempt)({
        destination: row.destination,
        event: row.event,
        secret,
        now,
      });
      if (result.kind === 'delivered') {
        row.status = 'delivered';
      } else {
        row.status = result.kind === 'failed' ? 'failed' : 'pending';
        row.error = result.error ?? `webhook_http_${result.status ?? 0}`;
        row.nextAttemptAt = now() + computeRetryDelay({
          attempts: row.attempts,
          retryAfter: result.retryAfter,
          now: now(),
        });
      }
    } catch {
      row.status = 'pending';
      row.error = 'webhook_dispatch_failed';
      row.nextAttemptAt = now() + computeRetryDelay({ attempts: row.attempts });
    }
    ctx.save();
  }
}
