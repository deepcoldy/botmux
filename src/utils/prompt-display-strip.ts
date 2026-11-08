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
