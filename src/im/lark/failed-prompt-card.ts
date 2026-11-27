import type { FailedTurnRecord } from '../../types.js';
import { turnRetryOffer } from '../../services/turn-failure-notice.js';
import type { Locale } from '../../i18n/index.js';
const escapeMd = (text: string): string => text.replace(/[\\`*_{}\[\]<>]/g, '\\$&');

export const FAILED_PROMPT_FIELD = 'failed_prompt';
export const FAILED_IMAGE_FIELD = 'failed_image';
export const MAX_FAILED_PROMPT_CHARS = 8_000;
export function failedPromptCanRetry(record: FailedTurnRecord): boolean {
  if (record.codexAppInput || record.silent || record.crossChatOrigin || record.recovery) return false;
  return turnRetryOffer(record) === 'safe' || (record.status === 'failed' && record.directFailure === true && !!record.traexPromptCheckpoint);
}
function label(en: boolean, english: string, chinese: string): string { return en ? english : chinese; }
function button(text: string, action: string, record: FailedTurnRecord, ids: { rootId: string; sessionId: string }, mode?: string): any {
  return { tag: 'button', type: 'default', text: { tag: 'plain_text', content: text },
    behaviors: [{ type: 'callback', value: { action, turn_id: record.turnId, session_id: ids.sessionId, root_id: ids.rootId, ...(mode ? { mode } : {}) } }] };
}
export function appendFailedPromptActions(cardJson: string, input: {
  cliId: string; localOwnedSession: boolean; record?: FailedTurnRecord; turnId: string;
  rootId: string; sessionId: string; locale?: Locale;
}): string {
  if (input.cliId !== 'traex' || !input.localOwnedSession || !input.record || input.record.turnId !== input.turnId) return cardJson;
  const card = JSON.parse(cardJson);
  if (card.schema !== '2.0' || !Array.isArray(card.body?.elements)) return cardJson;
  if (card.body.elements.some((element: any) => element.element_id === 'botmux_failed_prompt')) return cardJson;
  // Replace the legacy retry row while retaining repair and terminal actions.
  for (const element of card.body.elements) {
    if (element.tag === 'action') element.actions = element.actions.filter((a: any) => a.value?.action !== 'retry_turn');
  }
  card.body.elements = card.body.elements.filter((e: any) => e.tag !== 'action' || e.actions.length);
  const record = input.record;
  const en = input.locale !== 'zh';
  const safe = failedPromptCanRetry(record);
  const images = (record.attachments ?? []).filter(a => a.type === 'image');
  const elements: any[] = [{ tag: 'markdown', content: label(en, '**Saved prompt**\n', '**已保存的输入**\n') + escapeMd(record.userPrompt.slice(0, 1200)) }];
  for (const image of images.slice(0, 3)) {
    if (image.resourceKey?.startsWith('img_')) elements.push({ tag: 'img', img_key: image.resourceKey, alt: { tag: 'plain_text', content: image.name }, mode: 'fit_horizontal' });
  }
  elements.push({ tag: 'markdown', content: safe && !record.traexPromptCheckpoint
    ? label(en, 'This input never reached the CLI. Retry sends it once from the current conversation checkpoint.', '该输入未送达 CLI。重试会从当前会话检查点重发一次。')
    : safe
    ? label(en, 'No tools or assistant output were recorded. Retry restores the saved conversation checkpoint and resends this prompt once. An unchanged image may fail again.', '没有工具或助手输出。重试会恢复已保存的会话检查点并重发一次；原图仍可能再次失败。')
    : label(en, 'Work may already have run. Continue checks the current state before proceeding. Conversation rollback cannot undo file edits, commits, or sent messages.', '可能已经执行了部分工作。继续前会检查现场；会话回退无法撤销文件修改、提交或已发送的消息。') });
  const actions = [button(safe ? label(en, 'Retry', '重试') : label(en, 'Continue from current state', '从当前状态继续'), 'retry_turn', record, input, safe ? 'resend' : 'continue')];
  if (safe) actions.push(button(label(en, 'Edit prompt', '编辑输入'), 'edit_failed_prompt', record, input));
  elements.push({ tag: 'column_set', flex_mode: 'flow', columns: actions.map(action => ({ tag: 'column', width: 'auto', elements: [action] })) });
  card.body.elements.push({ tag: 'collapsible_panel', element_id: 'botmux_failed_prompt', expanded: true,
    header: { title: { tag: 'plain_text', content: label(en, 'Recover this prompt', '恢复本轮输入') } }, elements });
  return JSON.stringify(card);
}
export function buildFailedPromptEditCard(record: FailedTurnRecord, ids: { rootId: string; sessionId: string }, locale?: Locale): string {
  const en = locale !== 'zh';
  const images = (record.attachments ?? []).filter(a => a.type === 'image');
  const fields: any[] = [{ tag: 'input', name: FAILED_PROMPT_FIELD, input_type: 'multiline_text', required: true,
    max_length: MAX_FAILED_PROMPT_CHARS, default_value: record.userPrompt,
    placeholder: { tag: 'plain_text', content: label(en, 'Edit your original prompt', '编辑原始输入') } }];
  if (images.length) fields.push({ tag: 'select_static', name: FAILED_IMAGE_FIELD, initial_option: 'keep', required: true,
    placeholder: { tag: 'plain_text', content: label(en, 'Original image attachments', '原始图片附件') },
    options: [
      { text: { tag: 'plain_text', content: label(en, 'Keep the original image', '保留原图') }, value: 'keep' },
      { text: { tag: 'plain_text', content: label(en, 'Remove the original image', '移除原图') }, value: 'remove' },
    ] });
  const submit = button(label(en, 'Retry edited prompt', '重试编辑后的输入'), 'retry_edited_prompt', record, ids);
  submit.name = 'retry_edited_prompt'; submit.action_type = 'form_submit'; submit.type = 'primary';
  fields.push(submit);
  return JSON.stringify({ schema: '2.0', config: { wide_screen_mode: true }, body: { elements: [
    { tag: 'markdown', content: label(en, 'Nothing is sent until you choose **Retry edited prompt**. To replace an image, send a new message in this topic with the edited text and replacement attachment.', '点击**重试编辑后的输入**才会发送。替换图片时，请在本话题发送编辑后的文本和新附件。') },
    { tag: 'form', name: 'failed_prompt_edit', elements: fields },
  ] } });
}
