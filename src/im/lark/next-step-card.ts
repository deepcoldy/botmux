/**
 * The「下一步」row a turn's last reply card carries: the CLI's own prediction
 * of the next input (Claude Code's prompt suggestion) as a button. Clicking it
 * is a signed card-click turn (services/card-click-turn.ts): the clicker's
 * permissions are checked and the text is sent to this session as their turn.
 *
 * The row sits directly above the signature footer row. Legacy reply cards get
 * it by a CardKit element insert (the answer body is never rewritten); unified
 * reply cards render it from their record.
 */
import { CARD_CLICK_TURN_ACTION } from '../../services/card-click-turn.js';
import { REPLY_CARD_FOOTER_ELEMENT_ID } from './reply-card-footer-signature.js';

export const NEXT_STEP_ELEMENT_ID = 'botmux_next_step';
/** Marks a card-click turn started from this row (unsigned: it only selects
 * the wording of the in-thread acknowledgement, never what is sent). */
export const NEXT_STEP_CLICK_NOTICE = 'next_step';
/** Button label budget. The full text is what the signed token sends. */
export const NEXT_STEP_LABEL_MAX_CHARS = 80;

export interface NextStepButton {
  text: string;
  payload: string;
  sig: string;
}

function label(text: string): { label: string; shortened: boolean } {
  const chars = [...text];
  return chars.length <= NEXT_STEP_LABEL_MAX_CHARS
    ? { label: text, shortened: false }
    : { label: `${chars.slice(0, NEXT_STEP_LABEL_MAX_CHARS - 1).join('')}…`, shortened: true };
}

export function buildNextStepElement(next: NextStepButton, locale?: 'zh' | 'en'): Record<string, unknown> {
  const en = locale === 'en';
  const shown = label(next.text);
  // A shortened label hides part of what a click sends: the tip shows it all.
  const tip = shown.shortened
    ? `${en ? 'Sends: ' : '将发送：'}${next.text}`
    : (en ? 'Send this as your next message' : '以你的身份发送这条输入');
  return {
    tag: 'column_set',
    element_id: NEXT_STEP_ELEMENT_ID,
    flex_mode: 'none',
    horizontal_spacing: '8px',
    margin: '4px 0px 0px 0px',
    columns: [
      {
        tag: 'column', width: 'auto', vertical_align: 'center',
        elements: [{ tag: 'markdown', text_size: 'notation', content: `<font color='grey'>${en ? '💡 Next step' : '💡 下一步'}</font>` }],
      },
      {
        tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
        elements: [{
          tag: 'button', type: 'default', size: 'small',
          text: { tag: 'plain_text', content: shown.label },
          hover_tips: { tag: 'plain_text', content: tip },
          behaviors: [{ type: 'callback', value: {
            action: CARD_CLICK_TURN_ACTION, payload: next.payload, sig: next.sig, notice: NEXT_STEP_CLICK_NOTICE,
          } }],
        }],
      },
    ],
  };
}

const FOOTER_ROW_IDS = new Set(['botmux_reply_actions', REPLY_CARD_FOOTER_ELEMENT_ID]);

export type NextStepPlacement =
  | { kind: 'present' }
  | { kind: 'insert'; placement: { type: 'insert_before'; targetElementId: string } | { type: 'append' } };

/** Where the row goes in a sent schema-2.0 card: right above its footer row,
 * or at the end of a card without one. Undefined = not a card this can edit. */
export function nextStepPlacement(cardJson: string): NextStepPlacement | undefined {
  let card: any;
  try { card = JSON.parse(cardJson); } catch { return undefined; }
  const elements = card?.body?.elements;
  if (card?.schema !== '2.0' || !Array.isArray(elements)) return undefined;
  if (elements.some((element: any) => element?.element_id === NEXT_STEP_ELEMENT_ID)) return { kind: 'present' };
  const footer = elements.find((element: any) => FOOTER_ROW_IDS.has(element?.element_id));
  return { kind: 'insert', placement: footer
    ? { type: 'insert_before', targetElementId: footer.element_id }
    : { type: 'append' } };
}
