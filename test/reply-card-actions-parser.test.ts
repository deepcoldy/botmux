import { describe, it, expect } from 'vitest';
import { extractCardContent } from '../src/im/lark/message-parser.js';
import { stampBotmuxCallbackMarkers } from '../src/im/lark/callback-button-marker.js';
import {
  buildReplyCardActionOverflow,
  buildReplyCardChromeRow,
} from '../src/im/lark/reply-card-actions.js';
import { buildReplyCardFooter } from '../src/im/lark/md-card.js';

function cardWith(bodyElements: any[]) {
  return JSON.stringify({
    schema: '2.0',
    body: { elements: bodyElements },
  });
}

describe('reply-card action menu in parsed card history', () => {
  const binding = { larkAppId: 'cli_x', chatId: 'oc_x', rootId: 'om_root', sessionId: 'sess_x' };

  it('drops the stamped overflow menu (including options) from model-visible text', () => {
    const footer = buildReplyCardFooter({ brand: 'botmux' })!;
    const row = buildReplyCardChromeRow({ footer, controls: [buildReplyCardActionOverflow(binding, 'zh')] });
    const raw = stampBotmuxCallbackMarkers(cardWith([
      { tag: 'markdown', content: '这是给模型看的正文' },
      { tag: 'hr' },
      row,
    ]));
    const text = extractCardContent(raw);
    expect(text).toContain('这是给模型看的正文');
    expect(text).not.toContain('打开终端');
    expect(text).not.toContain('切换模型');
    expect(text).not.toContain('关闭会话');
    expect(text).not.toContain('[下拉');
  });

  it('still renders an unstamped third-party overflow as a dropdown', () => {
    const raw = cardWith([
      {
        tag: 'overflow',
        value: { foo: 'bar' },
        options: [
          { text: { tag: 'plain_text', content: '外部选项A' }, value: 'a' },
        ],
      },
    ]);
    const text = extractCardContent(raw);
    expect(text).toContain('外部选项A');
  });
});

describe('stamped select_static controls in parsed history', () => {
  it('drops the botmux model-picker select but keeps a third-party select', () => {
    const botmuxPicker = stampBotmuxCallbackMarkers(cardWith([
      {
        tag: 'action',
        actions: [{
          tag: 'select_static',
          placeholder: { tag: 'plain_text', content: '切换模型' },
          options: [
            { text: { tag: 'plain_text', content: 'fable' }, value: 'fable' },
            { text: { tag: 'plain_text', content: 'opus' }, value: 'opus' },
          ],
          value: { action: 'reply_model_pick' },
        }],
      },
    ]));
    const text = extractCardContent(botmuxPicker);
    expect(text).not.toContain('fable');
    expect(text).not.toContain('[下拉');

    const thirdParty = cardWith([
      {
        tag: 'action',
        actions: [{
          tag: 'select_static',
          placeholder: { tag: 'plain_text', content: '外部选择' },
          options: [{ text: { tag: 'plain_text', content: '选项一' }, value: 'x' }],
        }],
      },
    ]);
    expect(extractCardContent(thirdParty)).toContain('选项一');
  });
});

describe('unstamped botmux controls still dropped via the internal-action wordlist', () => {
  // The egress marker is the primary signal; the wordlist is the fallback for a
  // delivery path that never stamped the card (no "old card" rationale — these
  // controls are new, the fallback just covers an unstamped send).
  function unstampedOverflow(action: string): string {
    return cardWith([
      { tag: 'markdown', content: '正文' },
      {
        tag: 'overflow',
        value: { action },
        options: [
          { text: { tag: 'plain_text', content: '打开终端' }, value: 'terminal' },
          { text: { tag: 'plain_text', content: '切换模型' }, value: 'model' },
        ],
      },
    ]);
  }

  it('drops an unstamped reply_card_menu overflow via the wordlist', () => {
    const text = extractCardContent(unstampedOverflow('reply_card_menu'));
    expect(text).toContain('正文');
    expect(text).not.toContain('打开终端');
    expect(text).not.toContain('切换模型');
    expect(text).not.toContain('[下拉');
  });

  it('keeps dropping an unstamped reply_model_pick select via the wordlist', () => {
    const raw = cardWith([{
      tag: 'action',
      actions: [{
        tag: 'select_static',
        placeholder: { tag: 'plain_text', content: '切换模型' },
        options: [{ text: { tag: 'plain_text', content: 'fable' }, value: 'fable' }],
        value: { action: 'reply_model_pick' },
      }],
    }]);
    const text = extractCardContent(raw);
    expect(text).not.toContain('fable');
    expect(text).not.toContain('[下拉');
  });
});
