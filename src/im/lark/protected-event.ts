import { resolveBotmuxDataDir } from '../../core/data-dir.js';
import { ProtectedResultStore } from '../../services/protected-result-store.js';

export class ProtectedResultReadError extends Error {
  constructor() { super('protected_result_read_policy_unavailable'); }
}

/** Make one sanitized event for routing, listeners, parsing and context storage.
 * Never spread an original protected message: alternate card bodies and resource
 * metadata are just as sensitive as content. Policy failures are not parse misses.
 * The non-sensitive marker survives Inbox persistence so pre-ACK and claimed
 * capture can both reject the input even after its body became a placeholder. */
export function redactProtectedLarkEvent<T extends { message?: any }>(data: T, dataDir = resolveBotmuxDataDir()): T {
  const message = data?.message;
  if (!message) return data;
  try {
    const raw = { ...message, msg_type: message.message_type ?? message.msg_type,
      body: { content: message.content ?? message.body?.content ?? '' } };
    const redacted = new ProtectedResultStore(dataDir).redactMessage(raw);
    if (raw === redacted) return data;
    const { msg_type, body, ...metadata } = redacted;
    return { ...data, __protectedResultRedacted: true,
      message: { ...metadata, chat_type: message.chat_type,
        message_type: msg_type, content: body.content } };
  } catch { throw new ProtectedResultReadError(); }
}
