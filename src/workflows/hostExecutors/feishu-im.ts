import type { OutboundMessageOptions } from '../../im/lark/client.js';
import type { ProviderReconciler } from '../shared/provider-reconciler.js';
import { createFeishuReplyReconciler } from './feishu-reply.js';
import { createFeishuSendReconciler } from './feishu-send.js';

/**
 * Single Feishu IM provider reconciler.
 *
 * `effectAttempted.provider` is intentionally `feishu-im` for both
 * `feishu-send` and `feishu-reply` because Feishu's idempotency surface
 * is the IM uuid field.  The executor id identifies the author-facing
 * operation; durable recovery sees the provider, so it dispatches by the
 * verified frozen effect-input shape.
 */
export function createFeishuImReconciler(options?: OutboundMessageOptions): ProviderReconciler {
  const feishuReplyReconciler = createFeishuReplyReconciler(options);
  const feishuSendReconciler = createFeishuSendReconciler(options);
  return {
    provider: 'feishu-im',
    requiresEffectInput: true,

    canonicalInput(input) {
      // The recovery hash guard must canonicalize via the SAME shape
      // the original executor used.  Dispatch by input discriminator —
      // identical logic to idempotentSubmit's routing.
      if (isRecord(input) && Object.prototype.hasOwnProperty.call(input, 'rootMessageId')) {
        return feishuReplyReconciler.canonicalInput!(input);
      }
      if (isRecord(input) && Object.prototype.hasOwnProperty.call(input, 'chatId')) {
        return feishuSendReconciler.canonicalInput!(input);
      }
      // Unknown shape: return the input verbatim so the recomputed hash
      // ends up SHA-stable but different from the original; the guard
      // surfaces this as a mismatch rather than swallowing it.
      return input;
    },

    async idempotentSubmit(idempotencyKey, input) {
      if (isRecord(input) && Object.prototype.hasOwnProperty.call(input, 'rootMessageId')) {
        return feishuReplyReconciler.idempotentSubmit!(idempotencyKey, input);
      }
      if (isRecord(input) && Object.prototype.hasOwnProperty.call(input, 'chatId')) {
        return feishuSendReconciler.idempotentSubmit!(idempotencyKey, input);
      }
      return {
        ok: false,
        errorCode: 'InputValidationFailed',
        errorClass: 'manual',
        errorMessage:
          "Feishu IM effect input must include either 'chatId' (send) or 'rootMessageId' (reply)",
        evidence: { source: 'idempotentSubmit', reason: 'unknown_feishu_im_input' },
      };
    },
  };
}

export const feishuImReconciler = createFeishuImReconciler();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
