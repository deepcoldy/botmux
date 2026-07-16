import { z } from 'zod';

import { replyMessage } from '../../im/lark/client.js';
import { PROVIDER_TTL_MS } from '../shared/provider-reconciler.js';
import type { ProviderReconciler } from '../shared/provider-reconciler.js';
import type { SideEffectingExecutor } from './types.js';
import { classifyFeishuError } from './feishu-send.js';

export type FeishuReplyInput = {
  larkAppId: string;
  /** Parent message id (om_xxx) being replied to. */
  rootMessageId: string;
  content: string;
  msgType?: string;
  replyInThread?: boolean;
};

export type FeishuReplyOutput = {
  messageId: string;
};

const FeishuReplyInputSchema = z.object({
  larkAppId: z.string().min(1),
  rootMessageId: z.string().min(1),
  content: z.string(),
  msgType: z.string().min(1).optional(),
  replyInThread: z.boolean().optional(),
}).strict();

export function parseFeishuReplyInput(input: unknown): FeishuReplyInput {
  return FeishuReplyInputSchema.parse(input);
}

/**
 * `feishu-reply` is similar to `feishu-send` but the canonical input
 * additionally pins `rootMessageId` — spike Test 3c proved that Feishu
 * uuid dedupe IGNORES `parent_id` mismatches, so we must lock the parent
 * into the inputHash; otherwise a retry against a different parent would
 * silently land on the original parent.
 */
export const feishuReplyExecutor: SideEffectingExecutor<FeishuReplyInput, FeishuReplyOutput> = {
  provider: 'feishu-im',
  idempotencyTtlMs: PROVIDER_TTL_MS['feishu-im'],

  canonicalInput(input) {
    return {
      root_message_id: input.rootMessageId,
      msg_type: input.msgType ?? 'text',
      content: input.content,
      reply_in_thread: input.replyInThread ?? false,
      larkAppId: input.larkAppId,
    };
  },

  async invoke(input, idempotencyKey) {
    const messageId = await replyMessage(
      input.larkAppId,
      input.rootMessageId,
      input.content,
      input.msgType ?? 'text',
      input.replyInThread ?? false,
      idempotencyKey,
    );
    return {
      output: { messageId },
      externalRefs: { messageId },
    };
  },

  classifyError: classifyFeishuError,
};

export const feishuReplyReconciler: ProviderReconciler = {
  provider: 'feishu-im',
  requiresEffectInput: true,

  canonicalInput(input) {
    return feishuReplyExecutor.canonicalInput(input as FeishuReplyInput);
  },

  async idempotentSubmit(idempotencyKey, input) {
    let parsed: FeishuReplyInput;
    try {
      parsed = parseFeishuReplyInput(input);
    } catch (err) {
      return {
        ok: false,
        errorCode: 'InputValidationFailed',
        errorClass: 'manual',
        errorMessage: err instanceof Error ? err.message : String(err),
        evidence: { source: 'idempotentSubmit', reason: 'invalid_effect_input' },
      };
    }

    try {
      const { externalRefs } = await feishuReplyExecutor.invoke(parsed, idempotencyKey);
      return {
        ok: true,
        externalRefs,
        evidence: { source: 'idempotentSubmit', externalRefs },
      };
    } catch (err) {
      const classification = classifyFeishuError(err) ?? defaultFeishuClassification(err);
      return {
        ok: false,
        ...classification,
        evidence: { source: 'idempotentSubmit' },
      };
    }
  },
};

function defaultFeishuClassification(err: unknown) {
  return {
    errorCode: 'UnknownProviderError' as const,
    errorClass: 'manual' as const,
    errorMessage: err instanceof Error ? err.message : String(err),
  };
}
