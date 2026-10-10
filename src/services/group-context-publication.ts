import { updateMessage } from '../im/lark/client.js';
import type { TopicMessageLookup } from '../cli/topic-send-guard.js';
import { logger } from '../utils/logger.js';
import { readGroupContextDeliveryBinding, type GroupContextDeliveryBinding } from './group-context-delivery-store.js';
import { groupContextEpoch } from './group-context-prompt.js';
import { getGroupContextMessage } from './group-context-store.js';

/** Authorship comes from an exact native turn binding, never the sending bot. */
export function readGroupContextAuthorOrigin(input: {
  appId: string; chatId: string; sessionId: string; turnId?: string;
  nativeSessionId?: string; cliId?: string; workerGeneration?: number;
}, dataDir?: string): GroupContextDeliveryBinding | undefined {
  if (!input.turnId) return undefined;
  const epoch = groupContextEpoch(input.sessionId, input.nativeSessionId, input.cliId, input.turnId);
  const provisionalEpoch = groupContextEpoch(input.sessionId, undefined, input.cliId, input.turnId);
  const binding = readGroupContextDeliveryBinding(input.appId, input.chatId, input.turnId, dataDir, epoch)
    ?? (epoch !== provisionalEpoch ? readGroupContextDeliveryBinding(input.appId, input.chatId, input.turnId, dataDir, provisionalEpoch) : undefined);
  if (!binding || binding.sessionId !== input.sessionId) return undefined;
  if (binding.epoch === provisionalEpoch) {
    // A fresh opening can publish before terminal receipt resolves its native
    // ID. It must still be the exact bound worker, never a replacement retry.
    return binding.workerGeneration !== undefined && input.workerGeneration !== undefined
      && (binding.workerGeneration === input.workerGeneration
        || (binding.workerGeneration === 0 && input.workerGeneration === 1)) ? binding : undefined;
  }
  return binding.workerGeneration !== undefined && binding.workerGeneration === input.workerGeneration
    && binding.epoch === epoch
    ? binding : undefined;
}

/** Call only with the exact body and message ID acknowledged by the provider. */
export async function observeAcknowledgedGroupPublication(
  appId: string, message: Record<string, unknown>, groupContextAuthorOrigin?: GroupContextDeliveryBinding,
): Promise<void> {
  try {
    const { observePublishedGroupMessage } = await import('./group-context-runtime.js');
    if (groupContextAuthorOrigin) observePublishedGroupMessage(appId, message, groupContextAuthorOrigin);
    else observePublishedGroupMessage(appId, message);
  } catch {
    logger.warn('[group-context] published message could not be recorded; next activation will backfill');
  }
}

/** Only acknowledged card updates can replace the group's published history. */
export async function patchPublishedGroupCard(
  appId: string, chatId: string, messageId: string, content: string, rootId?: string,
  groupContextAuthorOrigin?: GroupContextDeliveryBinding,
  beforeWrite?: (topicMessageLookup?: TopicMessageLookup) => void | Promise<void>,
): Promise<void> {
  // Carry the caller's ownership fence through the composite option so it runs
  // at the same post-lookup position as the pre-sharing write guard, while the
  // PATCH acknowledgement is still returned.
  const receipt = await updateMessage(appId, messageId, content, { returnAcknowledgement: true, ...(beforeWrite ? { beforeWrite } : {}) });
  // A patch cannot move a message. Some callers only know the session routing
  // anchor (which may be a chat id), so retain the acknowledged destination.
  let previous: ReturnType<typeof getGroupContextMessage>;
  try { previous = getGroupContextMessage(appId, chatId, messageId); } catch { /* Observation remains best effort. */ }
  await observeAcknowledgedGroupPublication(appId, {
    // Existing sparse revisions may recover their root from an older journal
    // row. A routing anchor must not override that durable identity.
    message_id: messageId, chat_id: chatId, root_id: previous ? previous.rootId : rootId,
    thread_id: previous?.threadId, msg_type: 'interactive', body: { content },
    ...(receipt?.update_time !== undefined ? { update_time: receipt.update_time } : {}),
    observed_at: Date.now(),
  }, groupContextAuthorOrigin);
}
