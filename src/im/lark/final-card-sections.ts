import type { ReplyCardV2 } from './md-card.js';

export const FINAL_CARD_PROPOSAL_ELEMENT_ID = 'botmux_completion_proposal';
export const FINAL_CARD_FEEDBACK_ELEMENT_ID = 'botmux_feedback';
export const FINAL_CARD_FOOTER_ELEMENT_ID = 'botmux_reply_footer';

function containsElementId(value: unknown, elementId: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => containsElementId(item, elementId));
  const record = value as Record<string, unknown>;
  if (record.element_id === elementId) return true;
  return Object.values(record).some(item => containsElementId(item, elementId));
}

/**
 * The one insertion seam for canonical final-answer card sections. Direct CLI
 * sends and daemon fallback replies must both cross this function so proposal,
 * feedback, and footer ordering cannot drift.
 */
export function composeFinalCardSections(
  card: ReplyCardV2,
  sections: {
    completionProposal?: Record<string, unknown>;
    feedback?: Record<string, unknown>;
  },
): ReplyCardV2 {
  const elements = card.body.elements.filter((element) =>
    !containsElementId(element, FINAL_CARD_PROPOSAL_ELEMENT_ID)
    && !containsElementId(element, FINAL_CARD_FEEDBACK_ELEMENT_ID));
  const footerIndex = elements.findIndex(element => containsElementId(element, FINAL_CARD_FOOTER_ELEMENT_ID));
  const insertionIndex = footerIndex > 0
    && (elements[footerIndex - 1] as { tag?: unknown } | undefined)?.tag === 'hr'
    ? footerIndex - 1
    : footerIndex >= 0 ? footerIndex : elements.length;
  const insertion = [sections.completionProposal, sections.feedback]
    .filter((element): element is Record<string, unknown> => !!element);
  elements.splice(insertionIndex, 0, ...insertion);
  card.body.elements = elements;
  return card;
}
