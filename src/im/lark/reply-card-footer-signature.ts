/** Versioned identity shared by reply-card producers and the card parser.
 * The marker uses visible link text because Lark may discard zero-width links
 * while simplifying a card into Format A. */
export const REPLY_CARD_FOOTER_ELEMENT_ID = 'botmux_reply_footer';
export const REPLY_CARD_FOOTER_MARKER_URL =
  'https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1';
export const REPLY_CARD_FOOTER_MARKER =
  `[·](${REPLY_CARD_FOOTER_MARKER_URL})`;

/** Promoted H1/H2 heading widgets encode their original ATX level in the
 * element id. Lark strips `text_size` when a message is read back, so the id
 * is the only carrier that survives server normalization (same production
 * mechanism as the footer id above); the parser rebuilds `#` / `##` from it
 * so cross-session reads keep the heading hierarchy. */
export function replyCardHeadingElementId(level: 1 | 2, seq: number): string {
  return `botmux_md_h${level}_${seq}`;
}
export const REPLY_CARD_HEADING_ELEMENT_ID_RE = /^botmux_md_h([12])_\d+$/;
