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

/** Subset of resolveMergedCardContent used here (dependency-injected so tests
 *  can stub it): resolves an interactive card to its merged text + structured
 *  JSON + resources, numbering [图片 N] via the given numberer. */
export type ResolveMergedCardFn = (
  larkAppId: string,
  messageId: string,
  numberer: ReturnType<typeof createImgNumberer>,
) => Promise<{ text: string; structuredContent: string; resources: MessageResource[] } | null>;

export interface RenderedQuotedMessage extends LarkMessage {
  resources: MessageResource[];
  /** Structured card JSON from the merge pass — set only for interactive
   *  messages that were successfully re-resolved (`quoted --raw` → cardJson). */
  mergedStructuredContent?: string;
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
  resolveMergedCard?: ResolveMergedCardFn,
): Promise<RenderedQuotedMessage> {
  const numberer = createImgNumberer();
  // Order: extractResources first so top-level keys get their numbers, then
  // parseApiMessage reuses them when rendering text content. Calling them in
  // the other order leaves resources unnumbered when extractTextContent runs
  // first (it only consults the cache, doesn't create entries for resources
  // that haven't been declared yet via extractResources).
  const resources = extractResources(rawMessage.msg_type ?? '', rawMessage.body?.content ?? '', numberer);
  const parsed = parseApiMessage(rawMessage, numberer);
  if (parsed.msgType === 'merge_forward') {
    const { extraResources } = await expandMergeForward(larkAppId, parsed.messageId, parsed, numberer);
    resources.push(...extraResources);
  }
  // Interactive cards: union both im.message.get representations so the quoted
  // view matches history/live. Fresh numberer + FULL replacement (content AND
  // resources): the merge re-renders the card from scratch, so [图片 N] must
  // restart at 1 aligned with merged.resources — reusing the numberer above
  // would leave merged text misnumbered, and keeping the pre-merge resources
  // would let the list view's upgrade-fallback shell image linger. Attachment
  // download (in cmdQuoted) runs on the replaced list.
  if (parsed.msgType === 'interactive' && resolveMergedCard) {
    const cardNumberer = createImgNumberer();
    const merged = await resolveMergedCard(larkAppId, parsed.messageId, cardNumberer).catch(() => null);
    if (merged) {
      parsed.content = merged.text;
      return { ...parsed, resources: merged.resources, mergedStructuredContent: merged.structuredContent };
    }
  }
  return { ...parsed, resources };
}
