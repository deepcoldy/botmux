import { classifyLarkError, extractLarkErrorShape } from '../im/lark/error-classify.js';
import { LARK_CODE_MESSAGE_WITHDRAWN, LARK_CODE_MESSAGE_UPDATE_EXPIRED } from '../im/lark/lark-errors.js';
import { logger } from '../utils/logger.js';
import type { FeedbackExtensionStore } from './feedback-extension-store.js';

const pendingRefreshes = new Set<string>();
export interface FeedbackRefreshBudget { deadline: number; remaining: number }
export function feedbackRefreshBudget(): FeedbackRefreshBudget {
  return { deadline: Date.now() + 2000, remaining: 4 };
}
export async function refreshFeedbackMessage(input: {
  store: FeedbackExtensionStore; appId: string; messageId: string; kind: 'dirty' | 'cleanup';
  revision?: number; budget: FeedbackRefreshBudget; run: (signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  const now = Date.now();
  const operationKey = JSON.stringify([input.appId, input.messageId]);
  if (input.budget.remaining <= 0 || now >= input.budget.deadline
    || pendingRefreshes.has(operationKey)
    || !input.store.refreshDue(input.appId, input.messageId, input.kind, now)) return;
  input.budget.remaining--;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  pendingRefreshes.add(operationKey);
  const operation = Promise.resolve().then(() => input.run(controller.signal))
    .finally(() => pendingRefreshes.delete(operationKey));
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('feedback_refresh_timeout'));
        }, Math.min(1000, Math.max(1, input.budget.deadline - now)));
      }),
    ]);
    if (input.kind === 'dirty') input.store.clearDirtySurface(input.appId, input.messageId, input.revision!);
    else input.store.clearInlineCleanup(input.appId, input.messageId);
  } catch (error) {
    const classified = classifyLarkError(error);
    const shape = extractLarkErrorShape(error);
    const name = error instanceof Error ? error.name : '';
    const permanent = classified.classification === 'permanent'
      || shape.larkCode === LARK_CODE_MESSAGE_WITHDRAWN || shape.larkCode === LARK_CODE_MESSAGE_UPDATE_EXPIRED
      || name === 'MessageWithdrawnError' || name === 'MessageUpdateExpiredError'
      || (error instanceof Error && error.message === 'feedback_refresh_target_missing');
    const reason = permanent ? 'target_unavailable' : error instanceof Error && error.message === 'feedback_refresh_timeout' ? 'timeout' : 'transient';
    const outcome = input.store.failRefresh(input.appId, input.messageId, input.kind, permanent, reason, Date.now(), input.revision);
    if (outcome !== 'stale') logger.warn(`[feedback-refresh] ${input.kind} ${outcome} app=${input.appId} message=${input.messageId} reason=${reason}`);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
