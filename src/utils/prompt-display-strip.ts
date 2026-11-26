/**
 * Strip botmux-internal prompt blocks from text that is shown back to a human
 * as the user's own words (/adopt titles, /rewind previews, card excerpts).
 *
 * Why this is block-level rather than a generic `<[^>]+>` tag strip: the
 * follow-up-only `<botmux_formatting>` block (#2716) is APPENDED AFTER the
 * user's text in bare (`replyDelivery=transcript` + solo) turns, which carry
 * no `<user_message>` envelope for the usual extractors to key on. A tag-only
 * strip removes the angle brackets but leaves the block's body in the visible
 * text, so the whole element (tags + body) must go.
 *
 * Scope is deliberately limited to `<botmux_formatting>`: other leading blocks
 * (e.g. `<session_id>` on envelope-less codex shapes) pre-date this feature on
 * the same unreachable-in-practice picker path and changing their handling here
 * would mix an unrelated behavior change into the feature.
 */
export function stripBotmuxDisplayBlocks(text: string): string {
  return text.replace(/<botmux_formatting>[\s\S]*?<\/botmux_formatting>/g, ' ');
}

/**
 * Known BotMux envelope tags stripped as whole elements when extracting user
 * text from envelope-less prompts (hook injection mode or bare transcript mode,
 * where `<user_message>` is omitted).
 *
 * `<botmux_task>` is intentionally NOT listed here: its inner body IS the
 * task instruction, so callers unwrap its outer tags via `unwrapBotmuxTaskTags`
 * instead of deleting its body.
 */
export const BOTMUX_ENVELOPE_TAGS: ReadonlySet<string> = new Set([
  'botmux_routing',
  'botmux_builtin_skills',
  'botmux_skill_help',
  'identity',
  'botmux_credentials',
  'botmux_lark_tool',
  'session_id',
  'role',
  'project_group_mode',
  'botmux_steward',
  'summary_memory',
  'botmux_reminder',
  'botmux_formatting',
  'whiteboard',
  'botmux_group_join',
  'chat_context_policy',
  'chat_context',
  'shared_group_context',
  'message_location',
  'sender',
  'substitute_trigger',
  'substitute_target',
  'substitute_policy',
  'attachments',
  'mentions',
  'available_bots',
  'botmux_link_refs',
  'botmux_skills',
  'botmux_skills_refresh',
  'botmux_headless_session',
  'botmux_http_response_mode',
  'botmux_silent_schedule',
  'botmux_lead_dispatch',
  'botmux_collab',
  'sender_note',
]);

/**
 * Strip BotMux envelope blocks using a linear cursor walk (O(N), no regex
 * backtracking). When `replacement` is provided (e.g. `' '`), each stripped
 * self-closing or paired block emits `replacement` so adjacent tokens never
 * glue together.
 */
export function stripBotmuxEnvelopeBlocks(
  text: string,
  opts?: { replacement?: string },
): string {
  const replacement = opts?.replacement ?? '';
  let i = 0;
  let out = '';
  // Tags that already appeared once without a matching close tag. Their next
  // occurrences are treated as ordinary text: retrying the close-tag search for
  // each of them would rescan the whole tail every time (quadratic on inputs
  // like '<summary_memory>x'.repeat(N)). Malformed inputs only — every block
  // botmux itself renders is well-formed, so this never triggers in production.
  const deadTags = new Set<string>();
  while (i < text.length) {
    if (text[i] !== '<') {
      out += text[i];
      i++;
      continue;
    }
    let nameEnd = -1;
    for (let j = i + 1; j < text.length; j++) {
      const ch = text[j];
      // '<' is also a name delimiter: a legal tag name never contains '<'.
      // Including it bounds the inner scan when a run of '<' is followed by a
      // single delimiter (otherwise every '<' rescans the whole run — quadratic
      // on inputs like '<'.repeat(N) + ' >').
      if (ch === '>' || ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '/' || ch === '<') {
        nameEnd = j;
        break;
      }
    }
    if (nameEnd === -1) {
      out += text.slice(i);
      break;
    }
    const delim = text[nameEnd];
    if (delim === '<') {
      out += text[i];
      i++;
      continue;
    }
    const tagName = text.slice(i + 1, nameEnd);
    const recognized = BOTMUX_ENVELOPE_TAGS.has(tagName);
    if (recognized && !deadTags.has(tagName)) {
      if (delim === '/') {
        if (text[nameEnd + 1] === '>') {
          if (replacement) out += replacement;
          i = nameEnd + 2;
          continue;
        }
        out += text[i];
        i++;
        continue;
      }
      const openTagEnd = text.indexOf('>', nameEnd);
      if (openTagEnd === -1) {
        out += text.slice(i);
        break;
      }
      const nextLt = text.indexOf('<', nameEnd);
      if (nextLt !== -1 && nextLt < openTagEnd) {
        out += text[i];
        i++;
        continue;
      }
      if (text[openTagEnd - 1] === '/') {
        if (replacement) out += replacement;
        i = openTagEnd + 1;
        continue;
      }
      const closeTag = `</${tagName}>`;
      const closeIdx = text.indexOf(closeTag, openTagEnd + 1);
      if (closeIdx === -1) {
        // No close tag for this open tag. Mark it dead so later same-named open
        // tags skip the tail-rescan, then emit the leading '<' and advance by
        // one — do NOT break: later, *other* well-formed blocks must still be
        // stripped (e.g. '<summary_memory>x<attachments>f</attachments>' keeps
        // stripping the attachments block).
        deadTags.add(tagName);
        out += text[i];
        i++;
        continue;
      }
      if (replacement) out += replacement;
      i = closeIdx + closeTag.length;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

/** Unwrap outer `<botmux_task ...>...</botmux_task>` tags while preserving the
 *  task instruction body. Uses `[^<>]*` so repeated unclosed tags stay O(N). */
export function unwrapBotmuxTaskTags(text: string): string {
  return text
    .replace(/<botmux_task\b[^<>]*>/gi, '')
    .replace(/<\/botmux_task>/gi, '');
}
