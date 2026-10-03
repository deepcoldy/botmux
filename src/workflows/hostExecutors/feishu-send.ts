import type { OutboundMessageOptions } from '../../im/lark/client.js';
import { z } from 'zod';

import { sendMessage, MessageWithdrawnError } from '../../im/lark/client.js';
import { PROVIDER_TTL_MS } from '../shared/provider-reconciler.js';
import type { ProviderReconciler } from '../shared/provider-reconciler.js';
import type {
  ExecutorErrorClassification,
  SideEffectingExecutor,
} from './types.js';

/**
 * Input for the `feishu-send` hostExecutor.  Mirrors the surface area of
 * `client.sendMessage`; the canonical hash covers every field that
 * participates in the external effect (spike report §1.5 / events doc
 * v0.1.2 §3.2).
 */
export type FeishuSendInput = {
  larkAppId: string;
  chatId: string;
  content: string;
  /** Defaults to 'text'. */
  msgType?: string;
};

export type FeishuSendOutput = {
  messageId: string;
};

const FeishuSendInputSchema = z.object({
  larkAppId: z.string().min(1),
  chatId: z.string().min(1),
  content: z.string(),
  msgType: z.string().min(1).optional(),
}).strict();

export function parseFeishuSendInput(input: unknown): FeishuSendInput {
  return FeishuSendInputSchema.parse(input);
}

export function createFeishuSendExecutor(options?: OutboundMessageOptions): SideEffectingExecutor<FeishuSendInput, FeishuSendOutput> {
  return {
    provider: 'feishu-im',
    idempotencyTtlMs: PROVIDER_TTL_MS['feishu-im'],

    canonicalInput(input) {
      return {
        // receive_id + receive_id_type fully identify the destination.  We
        // pin receive_id_type to 'chat_id' because that's all
        // `client.sendMessage` supports today; future variants would extend
        // this canonical shape.
        receive_id: input.chatId,
        receive_id_type: 'chat_id',
        msg_type: input.msgType ?? 'text',
        content: input.content,
        // larkAppId is part of "who sends" — different bots writing the
        // same content to the same chat are distinct effects.
        larkAppId: input.larkAppId,
      };
    },

    async invoke(input, idempotencyKey) {
      const args = [input.larkAppId, input.chatId, input.content, input.msgType ?? 'text', idempotencyKey] as const;
      const messageId = options
        ? await sendMessage(...args, undefined, options)
        : await sendMessage(...args);
      return {
        output: { messageId },
        externalRefs: { messageId },
      };
    },

    classifyError(err) {
      return classifyFeishuError(err);
    },
  };
}

export const feishuSendExecutor = createFeishuSendExecutor();

export function createFeishuSendReconciler(options?: OutboundMessageOptions): ProviderReconciler {
  const executor = createFeishuSendExecutor(options);
  return {
    provider: 'feishu-im',
    requiresEffectInput: true,

    canonicalInput(input) {
      return executor.canonicalInput(input as FeishuSendInput);
    },

    async idempotentSubmit(idempotencyKey, input) {
      let parsed: FeishuSendInput;
      try {
        parsed = parseFeishuSendInput(input);
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
        const { externalRefs } = await executor.invoke(parsed, idempotencyKey);
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
}

export const feishuSendReconciler = createFeishuSendReconciler();

// ─── Error classification (shared with feishu-reply) ────────────────────────

export function classifyFeishuError(err: unknown): ExecutorErrorClassification | null {
  if (err instanceof MessageWithdrawnError) {
    return {
      errorCode: 'UnknownProviderError',
      // Withdrawn message means the parent or target is gone — the user
      // would need to retarget (effectively manual).  Could be refined
      // to a dedicated WithdrawnTarget code later.
      errorClass: 'manual',
      errorMessage: err.message,
    };
  }

  if (err instanceof Error) {
    const status = (err as any)?.response?.status ?? (err as any)?.status;
    const code = (err as any)?.response?.data?.code ?? (err as any)?.code;

    // Rate-limited
    if (status === 429 || code === 99991663 /* feishu rate-limited */) {
      return {
        errorCode: 'ProviderRateLimited',
        errorClass: 'retryable',
        errorMessage: err.message,
      };
    }
    // Generic network — connection refused / DNS / 5xx
    if (
      status >= 500 ||
      /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|getaddrinfo/i.test(err.message)
    ) {
      return {
        errorCode: 'NetworkError',
        errorClass: 'retryable',
        errorMessage: err.message,
      };
    }
  }
  // Unknown — fall through to protocol default (UnknownProviderError /
  // manual) by returning null.
  return null;
}

function defaultFeishuClassification(err: unknown): ExecutorErrorClassification {
  return {
    errorCode: 'UnknownProviderError',
    errorClass: 'manual',
    errorMessage: err instanceof Error ? err.message : String(err),
  };
}
