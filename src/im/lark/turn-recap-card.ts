/**
 * The「本轮回顾」panel: collapsed by default, above the「下一步」row (when
 * present) and the signature footer of a turn's last reply card. Legacy reply
 * cards get it by a CardKit element insert after they were sent; unified
 * reply cards render it from their record.
 */
import { NEXT_STEP_ELEMENT_ID } from './next-step-card.js';
import { REPLY_CARD_FOOTER_ELEMENT_ID } from './reply-card-footer-signature.js';

export const TURN_RECAP_ELEMENT_ID = 'botmux_turn_recap';

export function buildRecapElement(markdown: string, locale?: 'zh' | 'en'): Record<string, unknown> {
  return {
    tag: 'collapsible_panel', element_id: TURN_RECAP_ELEMENT_ID, expanded: false,
    background_color: 'grey-50', padding: '4px 12px 12px 12px', margin: '4px 0px 0px 0px',
    border: { color: 'grey-50', corner_radius: '8px' },
    header: {
      title: { tag: 'plain_text', content: locale === 'en' ? '🧭 Turn recap' : '🧭 本轮回顾' },
      background_color: 'grey-50', padding: '10px 12px 10px 12px',
      icon: { tag: 'standard_icon', token: 'down_outlined', color: 'grey', size: '16px 16px' },
      icon_position: 'right', icon_expanded_angle: -180,
    },
    elements: [{ tag: 'markdown', content: markdown }],
  };
}

/** Rows the panel goes above, nearest first. */
const ANCHOR_IDS = [NEXT_STEP_ELEMENT_ID, 'botmux_reply_actions', REPLY_CARD_FOOTER_ELEMENT_ID];

export type RecapPlacement =
  | { kind: 'present' }
  | { kind: 'insert'; placement: { type: 'insert_before'; targetElementId: string } | { type: 'append' } };

/** Where the panel goes in a sent schema-2.0 card, or undefined when this is
 * not a card the panel can be added to. A read-back lists the panel once it
 * was inserted, so a card that already carries one is updated in place. */
export function recapPlacement(cardJson: string): RecapPlacement | undefined {
  let card: any;
  try { card = JSON.parse(cardJson); } catch { return undefined; }
  const elements = card?.body?.elements;
  if (card?.schema !== '2.0' || !Array.isArray(elements)) return undefined;
  if (elements.some((element: any) => element?.element_id === TURN_RECAP_ELEMENT_ID)) return { kind: 'present' };
  for (const id of ANCHOR_IDS) {
    if (elements.some((element: any) => element?.element_id === id)) {
      return { kind: 'insert', placement: { type: 'insert_before', targetElementId: id } };
    }
  }
  return { kind: 'insert', placement: { type: 'append' } };
}

/** CardKit's answer to inserting an element id the card already has. */
export function isDuplicateElementIdError(error: unknown): boolean {
  return /Duplicate ID/i.test(error instanceof Error ? error.message : String(error));
}
