import { t, type Locale } from '../../i18n/index.js';
import { TRAEX_TOOL_IMAGE_UPLOAD_ERROR_CODE } from '../../services/traex-tool-image-recovery.js';

/** Keep the canonical reply/signature and add the explicit repair affordance
 * only for an owned local TRAE session and the exact native upload failure. */
export function appendTraexImageRecoveryAction(cardJson: string, input: {
  cliId: string; errorCode?: string; localOwnedSession: boolean;
  rootId: string; sessionId: string; turnId: string; locale?: Locale;
}): string {
  if (input.cliId !== 'traex' || input.errorCode !== TRAEX_TOOL_IMAGE_UPLOAD_ERROR_CODE
    || !input.localOwnedSession || !input.rootId || !input.sessionId || !input.turnId) return cardJson;
  const card = JSON.parse(cardJson);
  if (card.schema !== '2.0' || !Array.isArray(card.body?.elements)) return cardJson;
  card.body.elements.push({ tag: 'column_set', flex_mode: 'flow', columns: [{ tag: 'column', width: 'auto', elements: [{
    tag: 'button', type: 'primary', text: { tag: 'plain_text', content: t('card.btn.purge_tool_images_continue', undefined, input.locale) },
    behaviors: [{ type: 'callback', value: {
      action: 'purge_images_continue', image_kind: 'traex_tool_images', cli_id: 'traex',
      root_id: input.rootId, session_id: input.sessionId, turn_id: input.turnId,
    } }],
  }] }] });
  return JSON.stringify(card);
}
