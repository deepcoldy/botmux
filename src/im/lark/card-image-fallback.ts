import { omitReplyCardImages } from './md-card.js';
import { logger } from '../../utils/logger.js';
import type { ReplyImageState } from './reply-images.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** Require the specific card-image rejection, not merely HTTP 400 or 230099.
 * Accept both the SDK's Axios error and client.ts's flattened SDK error. */
function isInvalidImageKeyError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const data = isRecord(error.response) && isRecord(error.response.data)
    ? error.response.data : error;
  const message = typeof data.msg === 'string' ? data.msg
    : typeof error.message === 'string' ? error.message : '';
  return (data.code === 230099 || /\(code:\s*230099\)/.test(message))
    && /\bErrCode:\s*200570\b/.test(message)
    && /card contains invalid image keys/i.test(message);
}

/** A definitive rejection has no accepted message to duplicate. Retry once
 * with image descriptions, through the same fenced sender and stable UUID.
 * Remember this downgrade across the caller's transient-error retries. */
export async function replyWithImageFallback<T>(
  content: string,
  msgType: string | undefined,
  send: (content: string) => Promise<T>,
  state: ReplyImageState = { omitImages: false },
): Promise<T> {
  if (msgType !== 'interactive') return send(content);
  if (state.omitImages) return send(omitReplyCardImages(content));
  try {
    return await send(content);
  } catch (error) {
    if (!isInvalidImageKeyError(error)) throw error;
    const fallback = omitReplyCardImages(content);
    if (fallback === content) throw error;
    state.omitImages = true;
    logger.warn('Reply card image keys rejected; retrying with image descriptions');
    return send(fallback);
  }
}
