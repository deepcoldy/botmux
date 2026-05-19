/**
 * Pure-function render pipeline for `botmux quoted`. Extracted so unit tests
 * can exercise the wire-up (numberer sharing, extraResources merging) without
 * spinning up the CLI dispatcher or hitting Lark APIs.
 */
import type { LarkMessage } from '../types.js';
import {
  parseApiMessage,
  extractResources,
  createImgNumberer,
  normalizeApiMessageContent,
  type MessageResource,
} from '../im/lark/message-parser.js';

/** Subset of expandMergeForward used here — accepts the parsed message and a
 *  numberer, mutates parsed.content to the rendered tree, returns extra
 *  resources from sub-messages. Dependency-injected so tests can stub it. */
export type ExpandMergeForwardFn = (
  larkAppId: string,
  messageId: string,
  parsed: LarkMessage,
  numberer: ReturnType<typeof createImgNumberer>,
) => Promise<{ extraResources: MessageResource[] }>;

export interface RenderedQuotedMessage extends LarkMessage {
  resources: MessageResource[];
}

/**
 * Render a single quoted message into the JSON shape `botmux quoted` emits.
 *
 * Invariants this preserves:
 *   - Image and file counters in `[图片 N]` / `[文件 N]` placeholders align
 *     1:1 with the indices of the matching-type entries in `resources`
 *     (independent counters, mirrors `formatAttachmentsHint`).
 *   - For merge_forward messages, sub-message images/files are appended to
 *     `resources` and rendered inside the forwarded-XML tree using the same
 *     numberer, so placeholders inside the XML keep aligning with the
 *     overall list.
 */
export async function renderQuotedMessage(
  larkAppId: string,
  rawMessage: any,
  expandMergeForward: ExpandMergeForwardFn,
): Promise<RenderedQuotedMessage> {
  const numberer = createImgNumberer();
  // Order: extractResources first so top-level keys get their numbers, then
  // parseApiMessage reuses them when rendering text content. Calling them in
  // the other order leaves resources unnumbered when extractTextContent runs
  // first (it only consults the cache, doesn't create entries for resources
  // that haven't been declared yet via extractResources).
  const msgType = rawMessage.msg_type ?? '';
  const content = normalizeApiMessageContent(msgType, rawMessage.body?.content ?? '');
  const resources = extractResources(msgType, content, numberer);
  const parsed = parseApiMessage(rawMessage, numberer);
  if (parsed.msgType === 'merge_forward') {
    const { extraResources } = await expandMergeForward(larkAppId, parsed.messageId, parsed, numberer);
    resources.push(...extraResources);
  }
  return { ...parsed, resources };
}
