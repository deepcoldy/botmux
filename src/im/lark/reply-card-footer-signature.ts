/** Identity shared by reply-card producers and the card parser. Current cards
 * use a multi-code-point invisible text sentinel. A single invisible separator
 * can occur in ordinary text, so it is not sufficiently specific on its own.
 *
 * This differs from the historical zero-width Markdown link: Lark could drop
 * that link while simplifying a card, whereas U+2063 plain text survives the
 * round trip. Repeating the known-surviving character keeps the marker hidden
 * while making an accidental match in user-authored text vanishingly unlikely. */
export const REPLY_CARD_FOOTER_ELEMENT_ID = 'botmux_reply_footer';
export const REPLY_CARD_FOOTER_MARKER = '\u2063\u2063\u2063\u2063';

/** The「工作流 ›」sidebar entry button a workflow task card carries at the
 * right end of its signature row (design 2026-11-03 §11). It is navigation
 * chrome like the footer: the parser drops it, so a navigation link never
 * becomes part of the text bots read from each other's cards (a handoff card
 * IS the executing bot's turn input). */
export const WORKFLOW_SIDEBAR_ENTRY_ELEMENT_ID = 'botmux_wf_entry';
/** Its label per locale. Kept here, beside the id, because the parser also
 * recognizes it by label in Feishu's simplified card rendering, which may
 * drop element ids. */
export const WORKFLOW_SIDEBAR_ENTRY_LABEL = { zh: '工作流 ›', en: 'Workflow ›' } as const;

/** Promoted H1/H2 heading widgets encode their original ATX level in the
 * element id. Lark strips `text_size` when a message is read back, so the id
 * is the only carrier that survives server normalization (same production
 * mechanism as the footer id above); the parser rebuilds `#` / `##` from it
 * so cross-session reads keep the heading hierarchy. */
export function replyCardHeadingElementId(level: 1 | 2, seq: number): string {
  return `botmux_md_h${level}_${seq}`;
}
export const REPLY_CARD_HEADING_ELEMENT_ID_RE = /^botmux_md_h([12])_\d+$/;
