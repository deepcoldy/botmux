/**
 * Unit tests for message-parser: extractTextContent & extractResources.
 *
 * Covers interactive card parsing (Format A: Lark API simplified format,
 * Format B: original card JSON) and image resource extraction from cards.
 *
 * Run:  pnpm vitest run test/message-parser.test.ts
 */
import { describe, it, expect } from 'vitest';
import { parseApiMessage, extractResources, parseEventMessage, stripLeadingMentions, createImgNumberer, cardContentHasUpgradeFallback, isPureCardUpgradeFallback, mergeCardText, wrapResolvedCardText, mentionOpenId, messageMentionsBot, extractPostAtParticipants, extractAudioMeta, AUDIO_PLACEHOLDER, CARD_EMBEDDED_PLACEHOLDER } from '../src/im/lark/message-parser.js';
import { buildMarkdownCard, buildReplyCardFooter } from '../src/im/lark/md-card.js';
import { stampBotmuxCallbackMarkers, hasBotmuxCallbackMarker, BOTMUX_CALLBACK_MARKER_KEY } from '../src/im/lark/callback-button-marker.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeMsg(msgType: string, content: object | string) {
  return {
    message_id: 'om_test',
    msg_type: msgType,
    create_time: '1000',
    sender: { id: 'ou_sender', sender_type: 'user' },
    body: { content: typeof content === 'string' ? content : JSON.stringify(content) },
  };
}

// ─── API message metadata ─────────────────────────────────────────────────

describe('parseApiMessage metadata', () => {
  it('preserves root_id when present', () => {
    const result = parseApiMessage({
      ...makeMsg('text', { text: 'reply' }),
      root_id: 'om_root',
      thread_id: 'omt_thread',
    });
    expect(result.rootId).toBe('om_root');
  });

  it('falls back to thread_id for rootId when root_id is absent', () => {
    const result = parseApiMessage({
      ...makeMsg('text', { text: 'topic root' }),
      thread_id: 'omt_thread',
    });
    expect(result.rootId).toBe('omt_thread');
  });

  it('surfaces server-provided sender_name (with_sender_name=true reads)', () => {
    const msg = makeMsg('text', { text: 'hi' });
    msg.sender = { id: 'ou_bot', sender_type: 'app', sender_name: 'Premium(Claude)' } as any;
    const result = parseApiMessage(msg);
    expect(result.senderName).toBe('Premium(Claude)');
    expect(result.senderType).toBe('app');
  });

  it('omits senderName when the server supplies none or blank', () => {
    expect(parseApiMessage(makeMsg('text', { text: 'hi' })).senderName).toBeUndefined();
    const blank = makeMsg('text', { text: 'hi' });
    blank.sender = { id: 'ou_x', sender_type: 'user', sender_name: '  ' } as any;
    expect(parseApiMessage(blank).senderName).toBeUndefined();
  });
});

// ─── Interactive card: Format A (Lark API simplified) ─────────────────────

describe('Interactive card parsing: Format A (API simplified)', () => {
  it('should extract title and text elements', () => {
    const card = {
      title: '🎁 Bits UT Defect Challenge | Leaderboard Update!',
      elements: [[
        { tag: 'img', image_key: 'img_v3_xxx' },
        { tag: 'text', text: 'Upgrade to the latest app version to view the content' },
        { tag: 'text', text: '' },
      ]],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toBe(
      '[卡片: 🎁 Bits UT Defect Challenge | Leaderboard Update!]\n[图片]Upgrade to the latest app version to view the content',
    );
  });

  it('should handle multiple paragraphs', () => {
    const card = {
      title: 'Test Card',
      elements: [
        [{ tag: 'text', text: 'First paragraph' }],
        [{ tag: 'text', text: 'Second paragraph' }],
      ],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toBe('[卡片: Test Card]\nFirst paragraph\nSecond paragraph');
  });

  it('should handle links and @mentions', () => {
    const card = {
      title: 'Links',
      elements: [[
        { tag: 'text', text: 'See ' },
        { tag: 'a', text: 'docs', href: 'https://example.com' },
        { tag: 'text', text: ' or ask ' },
        { tag: 'at', user_name: 'Alice' },
      ]],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    // href is kept so links aren't lost — Format A separates text from href.
    expect(result.content).toBe('[卡片: Links]\nSee docs(https://example.com) or ask @Alice');
  });

  it('should extract button labels', () => {
    const card = {
      title: '🖥️ Session — 等待输入',
      elements: [[
        { tag: 'button', text: '📖 显示输出', type: 'default' },
        { tag: 'button', text: '🖥️ 打开终端', type: 'primary' },
        { tag: 'button', text: '❌ 关闭会话', type: 'danger' },
      ]],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('[卡片: 🖥️ Session — 等待输入]');
    expect(result.content).toContain('[📖 显示输出]');
    expect(result.content).toContain('[🖥️ 打开终端]');
    expect(result.content).toContain('[❌ 关闭会话]');
  });

  it('should handle mixed text and button elements in same paragraph', () => {
    const card = {
      title: 'Mixed',
      elements: [[
        { tag: 'text', text: 'Choose:' },
        { tag: 'button', text: 'Option A', type: 'primary' },
        { tag: 'button', text: 'Option B', type: 'default' },
      ]],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('Choose:');
    expect(result.content).toContain('[Option A] [Option B]');
  });

  it('should handle card with title only (no elements)', () => {
    const card = { title: 'Empty Card' };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toBe('[卡片: Empty Card]');
  });

  it('should handle card with no title — image-only elements speak for themselves', () => {
    // 没有 title 时不再 push 多余的 `[卡片]` 占位行；image 占位本身已足以说明
    // 来源，并且对接收 bot 的 prompt 而言少一行噪声。
    const card = { elements: [[{ tag: 'img', image_key: 'img_xxx' }]] };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toBe('[图片]');
  });

  it('should fall back to "[卡片]" when title is absent AND no elements yield any content', () => {
    const card = { elements: [] };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toBe('[卡片]');
  });
});

// ─── Interactive card: Format B (original card JSON) ──────────────────────

describe('Interactive card parsing: Format B (original card JSON)', () => {
  it('unwraps user_dsl before parsing API interactive messages', () => {
    const card = {
      user_dsl: JSON.stringify({
        header: { title: { tag: 'plain_text', content: '引用卡片' } },
        body: {
          elements: [
            { tag: 'markdown', content: '卡片正文' },
            { tag: 'img', img_key: 'img_card' },
          ],
        },
      }),
    };
    const numberer = createImgNumberer();
    const resources = extractResources('interactive', JSON.stringify(card), numberer);
    const result = parseApiMessage(makeMsg('interactive', card), numberer);
    expect(result.content).toContain('[卡片: 引用卡片]');
    expect(result.content).toContain('卡片正文');
    expect(result.content).toContain('[图片 1]');
    expect(resources).toEqual([{ type: 'image', key: 'img_card', name: 'img_card.jpg' }]);
  });

  it('should extract header title and div text', () => {
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '📁 项目仓库管理' }, template: 'blue' },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: '当前活跃项目：**/root/my-project**' } },
        { tag: 'hr' },
        { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '▶️ 开始' } }] },
        { tag: 'note', elements: [{ tag: 'lark_md', content: '也可以回复 /repo 切换' }] },
      ],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('[卡片: 📁 项目仓库管理]');
    expect(result.content).toContain('当前活跃项目：**/root/my-project**');
    expect(result.content).toContain('也可以回复 /repo 切换');
  });

  it('should extract markdown content (streaming card)', () => {
    const card = {
      header: { title: { tag: 'plain_text', content: '🖥️ My Project — 工作中' } },
      elements: [
        { tag: 'markdown', content: '```\n$ npm test\nAll 42 tests passed\n```' },
        { tag: 'hr' },
      ],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('[卡片: 🖥️ My Project — 工作中]');
    expect(result.content).toContain('All 42 tests passed');
  });

  it('surfaces buttons inside an action block (recurses el.actions)', () => {
    // action blocks hold children in `actions`, not `elements`. Regression:
    // these used to be dropped, which silently lost real card content like the
    // 确认/创建群组/驾驶舱 controls on Argos alarm cards.
    const card = {
      header: { title: { tag: 'plain_text', content: '🖥️ Claude 会话已启动' } },
      elements: [
        { tag: 'action', actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '🖥️ 打开终端' } },
          { tag: 'button', text: { tag: 'plain_text', content: '❌ 关闭会话' } },
        ]},
      ],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('[卡片: 🖥️ Claude 会话已启动]');
    expect(result.content).toContain('[🖥️ 打开终端]');
    expect(result.content).toContain('[❌ 关闭会话]');
  });

  it('extracts div.fields[] cells and input/select placeholders', () => {
    const card = {
      header: { title: { tag: 'plain_text', content: '报警' } },
      elements: [
        { tag: 'div', fields: [
          { text: { tag: 'lark_md', content: '规则: error_level' } },
          { text: { tag: 'lark_md', content: '报警时间: 17:45' } },
        ]},
        { tag: 'action', actions: [
          { tag: 'input', placeholder: { tag: 'plain_text', content: '输入报警备注' } },
          { tag: 'select_static', placeholder: { tag: 'plain_text', content: '报警是否有帮助？' },
            options: [
              { text: { tag: 'plain_text', content: '正确有效报警' } },
              { text: { tag: 'plain_text', content: '规则不合理' } },
            ]},
        ]},
      ],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('规则: error_level');
    expect(result.content).toContain('报警时间: 17:45');
    expect(result.content).toContain('[输入框: 输入报警备注]');
    expect(result.content).toContain('[下拉: 报警是否有帮助？ | 选项: 正确有效报警 / 规则不合理]');
  });

  it('should recurse into column_set / column elements', () => {
    const card = {
      header: { title: { tag: 'plain_text', content: 'Columns' } },
      elements: [{
        tag: 'column_set',
        columns: [
          { elements: [{ tag: 'div', text: { tag: 'lark_md', content: 'Col 1' } }] },
          { elements: [{ tag: 'div', text: { tag: 'lark_md', content: 'Col 2' } }] },
        ],
      }],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('Col 1');
    expect(result.content).toContain('Col 2');
  });
});

// ─── botmux footer chrome filtering ───────────────────────────────────────

describe('Interactive card parsing: botmux footer is stripped from prompt', () => {
  it('drops the Format B grey footer element but keeps body', () => {
    const card = {
      body: { elements: [
        { tag: 'markdown', content: '正文内容' },
        { tag: 'hr' },
        { tag: 'markdown', text_size: 'notation_small_v2',
          content: "<font color='grey'>[botmux](https://github.com/deepcoldy/botmux) · 发送给：<at id=ou_owner></at></font>" },
      ] },
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('正文内容');
    expect(result.content).not.toContain('botmux');
    expect(result.content).not.toContain('发送给');
  });

  it('drops the Format A (API simplified) footer line', () => {
    const card = {
      elements: [
        [{ tag: 'text', text: '正文内容' }],
        [
          { tag: 'a', text: 'botmux', href: 'https://github.com/deepcoldy/botmux' },
          { tag: 'text', text: ' · 发送给：' },
          { tag: 'at', user_name: 'Owner' },
        ],
      ],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('正文内容');
    expect(result.content).not.toContain('botmux');
  });

  it('preserves an ambiguous legacy default-brand-only line', () => {
    const formatA = {
      elements: [[
        { tag: 'a', text: 'botmux', href: 'https://github.com/deepcoldy/botmux' },
      ]],
    };
    const formatB = {
      body: { elements: [{
        tag: 'markdown',
        text_size: 'notation_small_v2',
        content: "<font color='grey'>[botmux](https://github.com/deepcoldy/botmux)</font>",
      }] },
    };

    expect(parseApiMessage(makeMsg('interactive', formatA)).content)
      .toContain('botmux(https://github.com/deepcoldy/botmux)');
    expect(parseApiMessage(makeMsg('interactive', formatB)).content)
      .toContain('[botmux](https://github.com/deepcoldy/botmux)');
  });

  it('only applies marker-less legacy footer compatibility at the card tail', () => {
    const formatA = {
      elements: [
        [
          { tag: 'a', text: 'botmux', href: 'https://github.com/deepcoldy/botmux' },
          { tag: 'text', text: ' · 发送给：' },
          { tag: 'at', user_name: 'Owner' },
        ],
        [{ tag: 'text', text: '后续正文' }],
      ],
    };
    const formatB = {
      body: { elements: [
        {
          tag: 'markdown',
          text_size: 'notation_small_v2',
          content: "<font color='grey'>[botmux](https://github.com/deepcoldy/botmux) · 发送给：<at id=ou_owner></at></font>",
        },
        { tag: 'markdown', content: '后续正文' },
      ] },
    };

    expect(parseApiMessage(makeMsg('interactive', formatA)).content).toContain('botmux');
    expect(parseApiMessage(makeMsg('interactive', formatB)).content).toContain('[botmux]');
  });

  it('drops a Format A usage-only footer when the bot brand is disabled', () => {
    const card = {
      elements: [
        [{ tag: 'text', text: '正文内容' }],
        [
          { tag: 'text', text: '上下文 159.9K/258.4K (62%)' },
          { tag: 'text', text: ' · Token ↑3.7M ↓23.3K ' },
          {
            tag: 'a',
            text: '·',
            href: 'https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1',
          },
          { tag: 'text', text: ' 发送给：' },
          { tag: 'at', user_name: 'Owner' },
        ],
      ],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('正文内容');
    expect(result.content).not.toContain('上下文 159.9K');
    expect(result.content).not.toContain('Token ↑3.7M');
    expect(result.content).not.toContain('发送给');
  });

  it('drops a Format A token-only footer when context is missing', () => {
    const card = {
      elements: [
        [{ tag: 'text', text: '正文内容' }],
        [
          { tag: 'text', text: 'Token ↑3.7M ↓23.3K ' },
          {
            tag: 'a',
            text: '·',
            href: 'https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1',
          },
          { tag: 'text', text: ' 发送给：' },
          { tag: 'at', user_name: 'Owner' },
        ],
      ],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('正文内容');
    expect(result.content).not.toContain('Token ↑3.7M');
    expect(result.content).not.toContain('发送给');
  });

  it('drops a Format A context-only footer when cumulative tokens are missing', () => {
    const card = {
      elements: [
        [{ tag: 'text', text: '正文内容' }],
        [
          { tag: 'text', text: '上下文 159.9K/258.4K (62%) ' },
          {
            tag: 'a',
            text: '·',
            href: 'https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1',
          },
          { tag: 'text', text: ' 发送给：' },
          { tag: 'at', user_name: 'Owner' },
        ],
      ],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('正文内容');
    expect(result.content).not.toContain('上下文 159.9K');
    expect(result.content).not.toContain('发送给');
  });

  it('drops a Format A custom-brand footer through its stable hidden marker', () => {
    const card = {
      elements: [
        [{ tag: 'text', text: '正文内容' }],
        [
          { tag: 'text', text: 'Acme · 发送给：' },
          { tag: 'at', user_name: 'Owner' },
          {
            tag: 'a',
            text: '\u200B',
            href: 'https://github.com/deepcoldy/bot%6Dux#reply-card-footer',
          },
        ],
      ],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('正文内容');
    expect(result.content).not.toContain('Acme');
    expect(result.content).not.toContain('发送给');
  });

  it('accepts a semantically equivalent decoded marker URL from Lark', () => {
    const card = {
      elements: [
        [{ tag: 'text', text: '正文内容' }],
        [
          { tag: 'text', text: 'Acme ' },
          {
            tag: 'a',
            text: '·',
            href: 'https://github.com/deepcoldy/botmux#reply-card-footer-v1',
          },
        ],
      ],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('正文内容');
    expect(result.content).not.toContain('Acme');
  });

  it('preserves marker-prefix URLs and exact marker URLs with ordinary link text', () => {
    const formatA = {
      elements: [
        [{
          tag: 'a',
          text: '·',
          href: 'https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1-guide',
        }],
        [{
          tag: 'a',
          text: '协议文档',
          href: 'https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1',
        }],
      ],
    };
    const formatB = {
      body: { elements: [
        {
          tag: 'markdown',
          content: "<font color='grey'>"
            + '[·](https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1-guide)'
            + '</font>',
        },
        {
          tag: 'markdown',
          content: '[协议文档](https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1)',
        },
      ] },
    };

    const textA = parseApiMessage(makeMsg('interactive', formatA)).content;
    expect(textA).toContain('reply-card-footer-v1-guide');
    expect(textA).toContain('协议文档');
    const textB = parseApiMessage(makeMsg('interactive', formatB)).content;
    expect(textB).toContain('reply-card-footer-v1-guide');
    expect(textB).toContain('协议文档');
  });

  it('drops an English custom-brand footer through its visible separator marker', () => {
    const card = {
      elements: [
        [{ tag: 'text', text: 'body' }],
        [
          { tag: 'text', text: 'Acme ' },
          {
            tag: 'a',
            text: '·',
            href: 'https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1',
          },
          {
            tag: 'text',
            text: ' Context 50.3K/258.4K (19%) · Tokens ↑1M ↓2K · Sent to: ',
          },
          { tag: 'at', user_name: 'Owner' },
        ],
      ],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('body');
    expect(result.content).not.toContain('Acme');
    expect(result.content).not.toContain('Context 50.3K');
    expect(result.content).not.toContain('Tokens ↑1M');
    expect(result.content).not.toContain('Sent to');
  });

  it('keeps a marker-less English usage-and-recipient paragraph as user data', () => {
    const card = {
      elements: [
        [{ tag: 'text', text: 'body' }],
        [
          {
            tag: 'text',
            text: 'Context 50.3K/258.4K (19%) · Tokens ↑1M ↓2K · Sent to: ',
          },
          { tag: 'at', user_name: 'Owner' },
        ],
      ],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('body');
    expect(result.content).toContain('Context 50.3K/258.4K (19%)');
    expect(result.content).toContain('Tokens ↑1M ↓2K');
    expect(result.content).toContain('Sent to: @Owner');
  });

  it('keeps a marker-less custom-brand footer-shaped paragraph as user data', () => {
    const card = {
      elements: [
        [{ tag: 'text', text: 'body' }],
        [
          {
            tag: 'text',
            text: 'Acme · Context 50.3K/258.4K (19%) · Tokens ↑1M ↓2K · Sent to: ',
          },
          { tag: 'at', user_name: 'Owner' },
        ],
      ],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('Acme · Context 50.3K/258.4K (19%)');
    expect(result.content).toContain('Tokens ↑1M ↓2K');
    expect(result.content).toContain('Sent to: @Owner');
  });

  it('keeps ordinary prose that mentions context and tokens', () => {
    const card = {
      elements: [[
        { tag: 'text', text: '上下文和 Token 是两个不同指标，请分别分析。' },
      ]],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('上下文和 Token 是两个不同指标');
  });

  it('keeps a usage-shaped body paragraph when it is not the final paragraph', () => {
    const card = {
      elements: [
        [{ tag: 'text', text: '上下文 12.3K/100K (12%) · Token ↑67.9K ↓123' }],
        [{ tag: 'text', text: '这是正文中的观测值，不是页脚。' }],
      ],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('上下文 12.3K/100K (12%)');
    expect(result.content).toContain('这是正文中的观测值');
  });

  it('keeps a pure usage-shaped final body paragraph when no recipient chrome proves it is a footer', () => {
    const card = {
      elements: [
        [{ tag: 'text', text: '本轮统计如下：' }],
        [{ tag: 'text', text: '上下文 12.3K/100K (12%) · Token ↑67.9K ↓123' }],
      ],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('本轮统计如下');
    expect(result.content).toContain('上下文 12.3K/100K (12%)');
  });

  it('keeps a single usage-shaped body paragraph instead of reducing the card to a placeholder', () => {
    const card = {
      elements: [[
        { tag: 'text', text: '上下文 12.3K/100K (12%) · Token ↑67.9K ↓123' },
      ]],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('上下文 12.3K/100K (12%)');
    expect(result.content).not.toBe('[卡片]');
  });

  it('keeps a sentence that merely contains the compact usage shape', () => {
    const card = {
      elements: [[
        { tag: 'text', text: '请记录：上下文 12.3K/100K (12%) · Token ↑67.9K ↓123，稍后对比。' },
      ]],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('请记录：上下文');
    expect(result.content).toContain('稍后对比');
  });

  it('drops the live split-font signed footer appended after a command', () => {
    const card = {
      elements: [[
        { tag: 'text', text: '/repo /data00/home/chenjihong.daryl/botmux/.worktree/peer-bot-repo-permission\n' },
        { tag: 'a', text: 'botmux', href: 'https://github.com/deepcoldy/botmux' },
        { tag: 'text', text: "<font color='grey'> </font>" },
        { tag: 'a', text: '·', href: 'https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1' },
        { tag: 'text', text: "<font color='grey'> 发送给：</font>" },
        { tag: 'at', user_name: 'jihong traex' },
      ]],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toBe('/repo /data00/home/chenjihong.daryl/botmux/.worktree/peer-bot-repo-permission');
  });

  it('keeps ordinary links that mention botmux and the marker URL without footer structure', () => {
    const card = {
      elements: [[
        { tag: 'text', text: '正文提到 ' },
        { tag: 'a', text: 'botmux', href: 'https://github.com/deepcoldy/botmux' },
        { tag: 'text', text: ' 以及 ' },
        { tag: 'a', text: 'footer spec', href: 'https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1' },
        { tag: 'text', text: '，但这不是签名页脚。' },
      ]],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('botmux(https://github.com/deepcoldy/botmux)');
    expect(result.content).toContain('footer spec(https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1)');
    expect(result.content).toContain('不是签名页脚');
  });

  it('keeps a usage-shaped final line when it belongs to the same body paragraph', () => {
    const card = {
      elements: [[
        {
          tag: 'text',
          text: '正文中的指标如下：\n上下文 12.3K/100K (12%) · Token ↑67.9K ↓123',
        },
      ]],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('正文中的指标如下');
    expect(result.content).toContain('上下文 12.3K/100K (12%)');
  });

  it('round-trips a real buildMarkdownCard output without footer leakage', () => {
    const raw = buildMarkdownCard('帮我看下这个 bug', 'ou_owner');
    const result = parseApiMessage(makeMsg('interactive', JSON.parse(raw)));
    expect(result.content).toContain('帮我看下这个 bug');
    expect(result.content).not.toContain('botmux');
    expect(result.content).not.toContain('发送给');
  });

  it('round-trips standalone reply headings without losing section text', () => {
    const raw = buildMarkdownCard(
      '# 执行结果\n\n核心链路已验证。\n\n## 下一步\n\n请在飞书确认排版。',
      'ou_owner',
    );
    const result = parseApiMessage(makeMsg('interactive', JSON.parse(raw)));

    expect(result.content).toContain('执行结果');
    expect(result.content).toContain('核心链路已验证。');
    expect(result.content).toContain('下一步');
    expect(result.content).toContain('请在飞书确认排版。');
    expect(result.content).not.toContain('botmux');
    expect(result.content).not.toContain('发送给');
  });

  it('round-trips native reply tables as readable pipe Markdown', () => {
    const raw = buildMarkdownCard([
      '## 验证结果',
      '',
      '| 项目 | 结果 |',
      '| --- | --- |',
      '| build | pass |',
      '| test | 280 passed |',
    ].join('\n'), 'ou_owner');
    const result = parseApiMessage(makeMsg('interactive', JSON.parse(raw)));

    expect(result.content).toContain('| 项目 | 结果 |');
    expect(result.content).toContain('| --- | --- |');
    expect(result.content).toContain('| build | pass |');
    expect(result.content).toContain('| test | 280 passed |');
    expect(result.content).not.toContain('botmux');
    expect(result.content).not.toContain('发送给');
  });

  it('escapes pipes and folds newlines when flattening third-party table cells', () => {
    const card = {
      schema: '2.0',
      body: { elements: [{
        tag: 'table',
        columns: [
          { name: 'name', display_name: { tag: 'plain_text', content: '名称' } },
          { name: 'detail', display_name: '详情' },
        ],
        rows: [{ name: 'A | B', detail: 'line 1\nline 2' }],
      }] },
    };
    const result = parseApiMessage(makeMsg('interactive', card));

    expect(result.content).toContain('| 名称 | 详情 |');
    expect(result.content).toContain('| A \\| B | line 1<br>line 2 |');
  });

  it('round-trips CardKit-normalized table cells returned by the live message API', () => {
    const normalizedCell = (content: string) => ({
      tag: 'markdown',
      property: {
        elements: [{
          tag: 'plain_text',
          property: { content, textAlign: 'left' },
        }],
        markdownElements: [],
        originTag: 'lark_md',
      },
    });
    const card = {
      schema: '2.0',
      body: { elements: [{
        tag: 'table',
        columns: [
          { name: 'c0', display_name: normalizedCell('检查项') },
          { name: 'c1', display_name: '预期结果' },
        ],
        rows: [{
          c0: normalizedCell('标题层级'),
          c1: normalizedCell('H1/H2 明显大于正文'),
        }],
      }] },
    };
    const result = parseApiMessage(makeMsg('interactive', card));

    expect(result.content).toContain('| 检查项 | 预期结果 |');
    expect(result.content).toContain('| 标题层级 | H1/H2 明显大于正文 |');
  });

  it('round-trips a live-normalized layout header, tag, body, and native table together', () => {
    const normalizedMarkdown = (...contents: string[]) => ({
      tag: 'markdown',
      property: {
        elements: contents.map((content, index) => ({
          tag: index === 0 ? 'plain_text' : 'code_span',
          property: { content, textAlign: 'left' },
        })),
        markdownElements: [],
        originTag: 'lark_md',
      },
    });
    // Fixture mirrors `botmux quoted --raw` after CardKit normalisation; it is
    // intentionally not the JSON emitted by the reply-card builder.
    const card = {
      schema: '2.0',
      config: { enable_forward_interaction: false, streaming_mode: false, width_mode: 'fill' },
      header: {
        template: 'orange',
        text_tag_list: [{
          color: 'red',
          tag: 'text_tag',
          text: { content: '需要你', tag: 'plain_text' },
        }],
        title: { content: '需要确认 · 回复卡样式是否收口', tag: 'plain_text' },
      },
      body: { direction: 'vertical', elements: [
        { tag: 'markdown', content: '请确认下面三项。' },
        {
          tag: 'table',
          columns: [
            { name: 'c0', display_name: normalizedMarkdown('检查项') },
            { name: 'c1', display_name: normalizedMarkdown('实现配置') },
          ],
          rows: [{
            c0: normalizedMarkdown('卡片宽度'),
            c1: normalizedMarkdown('Card 2.0 ', 'width_mode: fill'),
          }, {
            c0: normalizedMarkdown('标题层级'),
            c1: normalizedMarkdown('H1/H2 ', 'heading-2'),
          }],
        },
      ] },
    };
    const result = parseApiMessage(makeMsg('interactive', card));

    expect(result.content).toContain('[卡片: 需要确认 · 回复卡样式是否收口]');
    expect(result.content).toContain('[标签: 需要你]');
    expect(result.content).toContain('请确认下面三项。');
    expect(result.content).toContain('| 检查项 | 实现配置 |');
    expect(result.content).toContain('| 卡片宽度 | Card 2.0 width_mode: fill |');
    expect(result.content).toContain('| 标题层级 | H1/H2 heading-2 |');
  });

  it('rebuilds ATX headings from element ids after Lark strips text_size', () => {
    // Fixture mirrors the live read-back shape: text_size is gone entirely and
    // the content survives only inside the normalized rendered tree, so the
    // element id is the single carrier of heading hierarchy.
    const normalizedHeading = (elementId: string, content: string) => ({
      tag: 'markdown',
      element_id: elementId,
      property: {
        elements: [{ tag: 'plain_text', property: { content, textAlign: 'left' } }],
        markdownElements: [],
        originTag: 'lark_md',
      },
    });
    const card = {
      schema: '2.0',
      body: { direction: 'vertical', elements: [
        normalizedHeading('botmux_md_h1_1', '执行结果'),
        { tag: 'markdown', content: '核心链路已验证。' },
        normalizedHeading('botmux_md_h2_2', '验证命令'),
        { tag: 'markdown', content: 'bun run build' },
      ] },
    };
    const result = parseApiMessage(makeMsg('interactive', card));

    expect(result.content).toContain('# 执行结果\n核心链路已验证。');
    expect(result.content).toContain('## 验证命令\nbun run build');
    // The bare glued form the pre-fix reader produced must be gone.
    expect(result.content).not.toContain('执行结果\n核心链路已验证。\n验证命令');
  });

  it('keeps builder → parser heading round-trip promotable on re-send', () => {
    const raw = buildMarkdownCard('# 执行结果\n\n核心链路已验证。\n\n## 验证命令\n\n收尾');
    const result = parseApiMessage(makeMsg('interactive', JSON.parse(raw)));
    expect(result.content).toContain('# 执行结果');
    expect(result.content).toContain('## 验证命令');
  });

  it('leaves foreign heading-like element ids untouched', () => {
    const card = {
      schema: '2.0',
      body: { elements: [
        { tag: 'markdown', element_id: 'botmux_md_h3_1', content: '不是我们的层级' },
        { tag: 'markdown', element_id: 'vendor_md_h1_1', content: '第三方组件' },
      ] },
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('不是我们的层级');
    expect(result.content).toContain('第三方组件');
    expect(result.content).not.toContain('# ');
  });

  it('round-trips a footer whose custom brand contains an unmatched bracket', () => {
    const raw = buildMarkdownCard('正文内容', 'ou_owner', 'Acme [beta');
    const result = parseApiMessage(makeMsg('interactive', JSON.parse(raw)));
    expect(result.content).toContain('正文内容');
    expect(result.content).not.toContain('Acme [beta');
    expect(result.content).not.toContain('发送给');
  });

  it('keeps body text that merely mentions botmux without the repo link', () => {
    // The filter anchors on the canonical repo URL, so genuine prose about
    // botmux survives — only the footer chrome is removed.
    const card = {
      body: { elements: [
        { tag: 'markdown', content: 'botmux 这个项目挺好用的' },
      ] },
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('botmux 这个项目挺好用的');
  });

  it('keeps a real canonical Botmux repository link in Format A body text', () => {
    const card = {
      elements: [[
        { tag: 'text', text: '项目地址：' },
        {
          tag: 'a',
          text: 'botmux',
          href: 'https://github.com/deepcoldy/botmux',
        },
        { tag: 'text', text: '，请查看 README。' },
      ]],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain(
      '项目地址：botmux(https://github.com/deepcoldy/botmux)，请查看 README。',
    );
  });

  it('keeps a real canonical Botmux repository link in Format B body text', () => {
    const card = {
      body: { elements: [{
        tag: 'markdown',
        content: '项目地址：[botmux](https://github.com/deepcoldy/botmux)，请查看 README。',
      }] },
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain(
      '项目地址：[botmux](https://github.com/deepcoldy/botmux)，请查看 README。',
    );
  });
});

// ─── Structural footer strip (brand-agnostic, for per-bot custom brands) ──

describe('Interactive card parsing: footer stripped structurally (custom brand)', () => {
  it.each([
    { name: 'without text_size', textSize: undefined },
    { name: 'with Card 2.0 notation', textSize: 'notation' },
    { name: 'with legacy notation_small_v2', textSize: 'notation_small_v2' },
  ])('drops a schema 2.0 footer $name when it carries the exact split-font marker', ({ textSize }) => {
    const card = {
      schema: '2.0',
      body: { elements: [
        { tag: 'markdown', content: '/repo /data00/home/chenjihong.daryl/botmux/.worktree/peer-bot-repo-permission' },
        { tag: 'hr' },
        {
          element_id: 'botmux_reply_footer',
          tag: 'markdown',
          ...(textSize === undefined ? {} : { text_size: textSize }),
          content: '[botmux](https://github.com/deepcoldy/botmux)'
            + "<font color='grey'> </font>"
            + '[·](https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1)'
            + "<font color='grey'> 发送给：</font><at id=ou_owner></at>",
        },
      ] },
    };

    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toBe('/repo /data00/home/chenjihong.daryl/botmux/.worktree/peer-bot-repo-permission');
  });

  it.each([
    {
      name: 'wrong marker text',
      footer: {
        element_id: 'botmux_reply_footer',
        tag: 'markdown',
        text_size: 'notation',
        content: '[footer spec](https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1)',
      },
      expected: 'footer spec',
    },
    {
      name: 'wrong marker URL',
      footer: {
        element_id: 'botmux_reply_footer',
        tag: 'markdown',
        content: '[·](https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1-guide)',
      },
      expected: 'reply-card-footer-v1-guide',
    },
    {
      name: 'unexpected text_size',
      footer: {
        element_id: 'botmux_reply_footer',
        tag: 'markdown',
        text_size: 'normal_v2',
        content: '[·](https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1)',
      },
      expected: 'reply-card-footer-v1',
    },
  ])('keeps a schema 2.0 element-id collision with $name', ({ footer, expected }) => {
    const card = {
      schema: '2.0',
      body: { elements: [
        { tag: 'markdown', content: '正文内容' },
        footer,
      ] },
    };

    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('正文内容');
    expect(result.content).toContain(expected);
  });

  it('drops a footer carrying the complete Botmux structural signature', () => {
    const footer = buildReplyCardFooter({
      brand: 'Acme',
      recipientOpenIds: ['ou_owner'],
    })!;
    const card = {
      body: { elements: [
        { tag: 'markdown', content: '正文内容' },
        { tag: 'hr' },
        footer.element,
      ] },
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('正文内容');
    expect(result.content).not.toContain('Acme');
    expect(result.content).not.toContain('发送给');
  });

  it('keeps third-party body content that only collides with the public element id', () => {
    const card = {
      body: { elements: [{
        tag: 'markdown',
        element_id: 'botmux_reply_footer',
        content: '这是第三方卡片正文',
      }] },
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('这是第三方卡片正文');
  });

  it('drops a custom-brand grey footer carrying the stable separator marker', () => {
    const card = {
      body: { elements: [
        { tag: 'markdown', content: '正文内容' },
        { tag: 'hr' },
        { tag: 'markdown', text_size: 'notation_small_v2',
          content: "<font color='grey'>[Acme](https://acme.test) "
            + '[·](https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1) '
            + '发送给：<at id=ou_owner></at></font>' },
      ] },
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('正文内容');
    expect(result.content).not.toContain('Acme');
    expect(result.content).not.toContain('发送给');
  });

  it('keeps a third-party grey notation element without a Botmux id or marker', () => {
    const card = {
      body: { elements: [
        { tag: 'markdown', content: '正文内容' },
        { tag: 'hr' },
        {
          tag: 'markdown',
          text_size: 'notation_small_v2',
          content: "<font color='grey'>报警来源：第三方监控系统</font>",
        },
      ] },
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('正文内容');
    expect(result.content).toContain('报警来源：第三方监控系统');
  });

  it('drops the canonical footer nested beside a voice button', () => {
    const footer = buildReplyCardFooter({
      brand: 'Acme',
      recipientOpenIds: ['ou_owner'],
      locale: 'en',
    })!;
    const card = {
      body: { elements: [
        { tag: 'markdown', content: 'body' },
        { tag: 'hr' },
        {
          tag: 'column_set',
          columns: [
            { tag: 'column', elements: [footer.element] },
            {
              tag: 'column',
              elements: [{
                tag: 'button',
                text: { tag: 'plain_text', content: 'Voice summary' },
              }],
            },
          ],
        },
      ] },
    };

    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('body');
    expect(result.content).toContain('[Voice summary]');
    expect(result.content).not.toContain('Acme');
    expect(result.content).not.toContain('Sent to');
  });

  it('keeps a small-text element that is NOT a grey footer (foreign card content survives)', () => {
    // notation_small_v2 alone is not enough — the botmux footer is always grey.
    // A foreign card's small note without grey font must not be dropped.
    const card = {
      body: { elements: [
        { tag: 'markdown', text_size: 'notation_small_v2', content: '报警时间 17:45' },
      ] },
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('报警时间 17:45');
  });
});

// ─── botmux internal callback buttons are stripped from flattened text ────

describe('botmux internal callback buttons (🔊 语音总结 …) dropped from prompt', () => {
  // botmux reply/session cards carry callback buttons whose only affordance is
  // a callback into the sender bot's daemon. Flattening them as `[🔊 语音总结]`
  // leaks unusable chrome into peer bots' prompts (history / cross-bot relay /
  // quote) — the receiving bot can never click them. They are identified
  // structurally by `value.action` from botmux's internal vocabulary + no
  // jump URL; third-party and valueless buttons stay.
  it('Format B: drops the production voice-summary button (column_set + behaviors callback), keeps the reply body', () => {
    // Exact shape the cli.ts reply path builds: the button lives inside a
    // column_set's auto-width column and carries its action under
    // behaviors:[{type:'callback', value}] — NOT top-level value.
    const card = {
      body: { elements: [
        { tag: 'markdown', content: '这是机器人的回复内容' },
        { tag: 'hr' },
        { tag: 'column_set', flex_mode: 'none', columns: [
          { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
            elements: [{ tag: 'markdown', text_size: 'notation', content: ' ' }] },
          { tag: 'column', width: 'auto', vertical_align: 'center', elements: [{
            tag: 'button',
            text: { tag: 'plain_text', content: '🔊 语音总结' },
            type: 'default',
            behaviors: [{
              type: 'callback',
              value: { action: 'voice_summary', session_id: 's1', root_id: 'om_1', lark_app_id: 'cli_a1', chat_id: 'oc_1' },
            }],
          }] },
        ] },
      ] },
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('这是机器人的回复内容');
    expect(result.content).not.toContain('语音总结');
  });

  it('Format B: drops session-card controls (关闭会话/重启), keeps third-party callbacks', () => {
    const card = {
      body: { elements: [
        { tag: 'action', actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '❌ 关闭会话' },
            value: { action: 'close', session_id: 's1' } },
          { tag: 'button', text: { tag: 'plain_text', content: '🔄 重启' },
            value: { action: 'restart', session_id: 's1' } },
          // Third-party card button with its own callback vocabulary — kept.
          { tag: 'button', text: { tag: 'plain_text', content: '确认' },
            value: { action: 'ack_alarm', rule_id: 'r1' } },
          // Button with no value at all — always kept.
          { tag: 'button', text: { tag: 'plain_text', content: '🖥️ 打开终端' } },
        ] },
      ] },
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).not.toContain('关闭会话');
    expect(result.content).not.toContain('重启');
    expect(result.content).toContain('[确认]');
    expect(result.content).toContain('[🖥️ 打开终端]');
  });

  it('Format B: real buildReplyCardFooter + real voice button — neither chrome leaks', () => {
    // End-to-end sanity with the REAL builders: footer signature strip (master)
    // and callback-button strip (this change) must jointly leave only the body.
    const footer = buildReplyCardFooter({ recipientOpenIds: ['ou_55cda5a6c00f49eef42043a7746499b4'] })!;
    const card = {
      body: { elements: [
        { tag: 'markdown', content: '修复已完成，详见上面。' },
        { tag: 'hr' },
        { tag: 'column_set', flex_mode: 'none', columns: [
          { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
            elements: [footer.element] },
          { tag: 'column', width: 'auto', vertical_align: 'center', elements: [{
            tag: 'button',
            text: { tag: 'plain_text', content: '🔊 语音总结' },
            type: 'default',
            behaviors: [{
              type: 'callback',
              value: { action: 'voice_summary', session_id: 's1', root_id: 'om_1', lark_app_id: 'cli_a1', chat_id: 'oc_1' },
            }],
          }] },
        ] },
      ] },
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('修复已完成，详见上面。');
    expect(result.content).not.toContain('语音总结');
    expect(result.content).not.toContain('发送给');
    expect(result.content).not.toContain('botmux');
  });

  it('Format B: a jump-URL button is kept even under a botmux action name', () => {
    // A real link always wins over the cleanup heuristic — the open_url
    // behavior means the reader can actually follow it.
    const card = {
      body: { elements: [
        { tag: 'button', text: { tag: 'plain_text', content: '分析报告' },
          value: { action: 'voice_summary', session_id: 's1' },
          behaviors: [{ type: 'open_url', default_url: 'https://example.com/report' }] },
      ] },
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('[分析报告](https://example.com/report)');
  });

  it('Format A: drops the voice-summary button while keeping bare buttons', () => {
    // Format A is the API simplified list view; nodes keep `value` when the
    // card supplies it, so the same structural filter applies.
    const card = {
      title: '回复',
      elements: [[
        { tag: 'text', text: '回复正文' },
        { tag: 'button', text: '🔊 语音总结',
          value: { action: 'voice_summary', session_id: 's1' } },
        { tag: 'button', text: 'Option A', type: 'primary' },
      ]],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('回复正文');
    expect(result.content).not.toContain('语音总结');
    expect(result.content).toContain('[Option A]');
  });

  it('marker path: a stamped button is dropped even with an UNKNOWN action (future-proof)', () => {
    // The egress stamp (`__bm_cb`) is the long-term contract: a future botmux
    // button with an action the legacy wordlist has never heard of must still
    // be stripped, WITHOUT anyone updating the wordlist.
    const card = {
      body: { elements: [
        { tag: 'button', text: { tag: 'plain_text', content: '🆕 未来按钮' },
          value: { action: 'some_future_action', __bm_cb: 1 } },
      ] },
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).not.toContain('未来按钮');
  });

  it('roundtrip: every callback button in a real egress-stamped card vanishes, jump URL stays', () => {
    // Full pipeline: stampBotmuxCallbackMarkers (what client.ts applies on
    // send/reply/ephemeral/update) → parseApiMessage (what the peer bot sees).
    // A custom-brand bot with a session card and a voice-reply card must leak
    // zero callback chrome while its genuine jump button survives.
    const sessionCard = JSON.stringify({
      body: { elements: [
        { tag: 'markdown', content: '会话正文' },
        { tag: 'action', actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '❌ 关闭会话' },
            type: 'danger', value: { action: 'close', session_id: 's1' } },
          { tag: 'button', text: { tag: 'plain_text', content: '🆕 某未来功能' },
            value: { action: 'totally_new_action', session_id: 's1' } },
          { tag: 'button', text: { tag: 'plain_text', content: '📄 打开报告' },
            behaviors: [{ type: 'open_url', default_url: 'https://example.com/report' }] },
        ] },
      ] },
    });
    const stamped = stampBotmuxCallbackMarkers(sessionCard);
    const result = parseApiMessage(makeMsg('interactive', stamped));
    expect(result.content).toContain('会话正文');
    expect(result.content).not.toContain('关闭会话');
    expect(result.content).not.toContain('某未来功能');   // unknown action — marker wins
    expect(result.content).toContain('[📄 打开报告](https://example.com/report)');
    // sanity: the stamp actually fired (not passing by accident)
    expect(stamped).toContain('__bm_cb');
  });
});

// ─── stampBotmuxCallbackMarkers: egress stamp unit behavior ───────────────

describe('stampBotmuxCallbackMarkers (egress choke-point stamp)', () => {
  it('stamps legacy top-level value and v2 behaviors callback, skips jump buttons', () => {
    const card = JSON.stringify({
      body: { elements: [
        { tag: 'button', text: { tag: 'plain_text', content: 'A' }, value: { action: 'close', session_id: 's' } },
        { tag: 'button', text: { tag: 'plain_text', content: 'B' },
          behaviors: [{ type: 'callback', value: { action: 'voice_summary' } }] },
        { tag: 'button', text: { tag: 'plain_text', content: 'C' }, value: { action: 'cfg' },
          behaviors: [{ type: 'open_url', default_url: 'https://example.com' }] },
      ] },
    });
    const out = JSON.parse(stampBotmuxCallbackMarkers(card));
    const [a, b, c] = out.body.elements;
    expect(a.value[BOTMUX_CALLBACK_MARKER_KEY]).toBe(1);
    expect(b.behaviors[0].value[BOTMUX_CALLBACK_MARKER_KEY]).toBe(1);
    // jump button untouched: its value must stay marker-free
    expect(c.value[BOTMUX_CALLBACK_MARKER_KEY]).toBeUndefined();
    expect(hasBotmuxCallbackMarker(a)).toBe(true);
    expect(hasBotmuxCallbackMarker(b)).toBe(true);
    expect(hasBotmuxCallbackMarker(c)).toBe(false);
  });

  it('reaches buttons nested in column_set / i18n sections', () => {
    const card = JSON.stringify({
      body: { elements: [{ tag: 'column_set', columns: [
        { tag: 'column', elements: [{ tag: 'button', text: { tag: 'plain_text', content: 'X' },
          behaviors: [{ type: 'callback', value: { action: 'voice_summary' } }] }] },
      ] }] },
      i18n_elements: { zh_cn: [{ tag: 'button', text: { tag: 'plain_text', content: 'Y' }, value: { action: 'close' } }] },
    });
    const out = JSON.parse(stampBotmuxCallbackMarkers(card));
    const nested = out.body.elements[0].columns[0].elements[0];
    expect(nested.behaviors[0].value[BOTMUX_CALLBACK_MARKER_KEY]).toBe(1);
    expect(out.i18n_elements.zh_cn[0].value[BOTMUX_CALLBACK_MARKER_KEY]).toBe(1);
  });

  it('is idempotent and tolerates non-JSON input unchanged', () => {
    const card = JSON.stringify({ body: { elements: [{ tag: 'button', text: { tag: 'plain_text', content: 'A' }, value: { action: 'close' } }] } });
    const once = stampBotmuxCallbackMarkers(card);
    expect(stampBotmuxCallbackMarkers(once)).toBe(once);
    expect(stampBotmuxCallbackMarkers('not-json{')).toBe('not-json{');
  });
});

// ─── mergeCardText: A+B union ─────────────────────────────────────────────

describe('mergeCardText', () => {
  it('fills a B field value B left blank from A (e.g. 值班人 names)', () => {
    const textB = '[卡片: 报警]\n规则: error_level报警\n值班人:';
    const textA = '规则: error_level报警值班人: 赵方涛田大露';
    const merged = mergeCardText(textA, textB);
    expect(merged).toContain('值班人: 赵方涛田大露');
    // 规则 already in B → not duplicated
    expect(merged.match(/error_level报警/g)?.length).toBe(1);
  });

  it('does NOT fill a label whose value B already renders on adjacent lines', () => {
    const textB = '[卡片: 报警]\n[ 检测结果 ]:\n条件组 1';
    const textA = '[ 检测结果 ]:条件组 1';
    const merged = mergeCardText(textA, textB);
    expect(merged.match(/条件组 1/g)?.length).toBe(1);
  });

  it('marks client-only sub-cards (A holes) with an honest placeholder', () => {
    const textB = '[卡片: 报警]\nArgos分析';
    const textA = '日志指标\n请升级至最新版本客户端，以查看内容\nArgos分析';
    const merged = mergeCardText(textA, textB);
    expect(merged).toContain(CARD_EMBEDDED_PLACEHOLDER);
    expect(merged).not.toContain('请升级至最新版本客户端');
  });

  it('falls back to the non-empty side when the other is empty/fallback', () => {
    expect(mergeCardText('', '[卡片: x]\n正文')).toBe('[卡片: x]\n正文');
    expect(mergeCardText('[卡片: y]\n正文', '请升级至最新版本客户端，以查看内容')).toContain('正文');
  });

  it('preserves header metadata present only in A without duplicating B metadata', () => {
    const textA = '[卡片: 需要确认]\n[标签: 需要你]\n正文';
    expect(mergeCardText(textA, '[卡片: 需要确认]\n正文')).toBe(
      '[卡片: 需要确认]\n[标签: 需要你]\n正文',
    );
    expect(mergeCardText(textA, '[卡片: 需要确认]\n[标签: 需要你]\n正文'))
      .toBe('[卡片: 需要确认]\n[标签: 需要你]\n正文');
  });

  it('unions distinct header tags by value instead of dropping a second tag by kind', () => {
    const textA = '[卡片: 进度]\n[标签: 进行中]\n[标签: 需要你]\n正文';
    const textB = '[卡片: 进度]\n[标签: 进行中]\n正文';
    expect(mergeCardText(textA, textB)).toBe(
      '[卡片: 进度]\n[标签: 需要你]\n[标签: 进行中]\n正文',
    );
  });
});

describe('wrapResolvedCardText sentinel', () => {
  it('extractCardContent returns the merged text verbatim through parseApiMessage', () => {
    const text = '[卡片: 报警]\n值班人: 赵方涛田大露\n' + CARD_EMBEDDED_PLACEHOLDER;
    const msg = makeMsg('interactive', {});
    msg.body.content = wrapResolvedCardText(text);
    expect(parseApiMessage(msg).content).toBe(text);
  });

  it('still exposes image resources alongside the sentinel text', () => {
    // Sentinel carries B structure so extractResources keeps finding images.
    const wrapped = JSON.stringify({
      __botmux_card_text__: '[卡片: x]\n正文',
      elements: [{ tag: 'img', image_key: 'img_abc' }],
    });
    const resources = extractResources('interactive', wrapped);
    expect(resources.map(r => r.key)).toContain('img_abc');
  });
});

// ─── Template card ────────────────────────────────────────────────────────

describe('Interactive card parsing: template card', () => {
  it('should return fallback for template-based cards', () => {
    const card = { type: 'template', data: { template_id: 'AAqk1234', template_variable: { name: 'test' } } };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toBe('[卡片 (模板)]');
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────

describe('Interactive card parsing: edge cases', () => {
  it('should return [卡片] for invalid JSON', () => {
    const msg = makeMsg('interactive', 'not json at all');
    msg.body.content = 'not json at all';
    const result = parseApiMessage(msg);
    expect(result.content).toBe('[卡片]');
  });

  it('should return [卡片] for empty content', () => {
    const msg = makeMsg('interactive', '');
    msg.body.content = '';
    const result = parseApiMessage(msg);
    expect(result.content).toBe('[卡片]');
  });

  it('should return [卡片] for empty object', () => {
    const result = parseApiMessage(makeMsg('interactive', {}));
    expect(result.content).toBe('[卡片]');
  });

  it('should skip empty text nodes in API format', () => {
    const card = {
      title: 'T',
      elements: [[{ tag: 'text', text: '' }, { tag: 'text', text: '' }]],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toBe('[卡片: T]');
  });
});

// ─── isCardUpgradeFallback: REST re-resolution gate for `botmux history` ──

describe('cardContentHasUpgradeFallback (broad re-resolution trigger)', () => {
  it('matches the bare upgrade notice', () => {
    expect(cardContentHasUpgradeFallback('请升级至最新版本客户端，以查看内容')).toBe(true);
  });

  it('matches an embedded fallback buried mid-body (complex card)', () => {
    // Argos-style card: renders fine at the top, but nested sub-cards fall back.
    const c = '[卡片: 报警]\n规则: error_level\n请升级至最新版本客户端，以查看内容\nArgos智能分析';
    expect(cardContentHasUpgradeFallback(c)).toBe(true);
  });

  it('does NOT match normal card content', () => {
    expect(cardContentHasUpgradeFallback('[卡片: 标题]\n正文内容')).toBe(false);
  });
});

describe('isPureCardUpgradeFallback (replace gate)', () => {
  it('matches the bare upgrade notice', () => {
    expect(isPureCardUpgradeFallback('请升级至最新版本客户端，以查看内容')).toBe(true);
  });

  it('matches the notice prefixed by a leading image placeholder', () => {
    // This is exactly what im.message.list returns for a whole-card fallback.
    expect(isPureCardUpgradeFallback('[图片]请升级至最新版本客户端，以查看内容')).toBe(true);
  });

  it('matches the notice prefixed by a numbered file placeholder', () => {
    expect(isPureCardUpgradeFallback('[文件 1: a.pdf]请升级至最新版本客户端')).toBe(true);
  });

  it('does NOT match a card whose body merely quotes the phrase mid-text', () => {
    // Regression: a message discussing the fallback string itself must not be
    // mistaken for the fallback, or the REST-resolved real body gets discarded.
    const real = '✅ 实锤了。message.list 返回 `请升级至最新版本客户端，以查看内容` 这个 fallback';
    expect(isPureCardUpgradeFallback(real)).toBe(false);
  });

  it('does NOT match an embedded fallback when real content leads', () => {
    const c = '[卡片: 报警]\n规则: error_level\n请升级至最新版本客户端';
    expect(isPureCardUpgradeFallback(c)).toBe(false);
  });
});

// ─── extractResources for interactive cards ───────────────────────────────

describe('Post message parsing', () => {
  it('renders post code block with fence boundaries for API and event messages', () => {
    const post = {
      zh_cn: {
        content: [[
          { tag: 'text', text: '前文' },
          { tag: 'code_block', language: 'JSON', text: 'print hello\n' },
          { tag: 'text', text: '后文' },
        ]],
      },
    };
    const expected = '前文\n```JSON\nprint hello\n```\n后文';

    expect(parseApiMessage(makeMsg('post', post)).content).toBe(expected);

    const event = {
      sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      message: {
        message_id: 'om_post_code',
        message_type: 'post',
        content: JSON.stringify(post),
        chat_id: 'oc_chat',
        chat_type: 'group',
        create_time: '1000',
      },
    };
    expect(parseEventMessage(event).parsed.content).toBe(expected);
  });

  it('uses a longer fence when post code contains triple backticks', () => {
    const post = {
      content: [[
        { tag: 'code_block', language: 'md', text: 'before\n```\ninside\n```\nafter\n' },
      ]],
    };

    expect(parseApiMessage(makeMsg('post', post)).content).toBe('````md\nbefore\n```\ninside\n```\nafter\n````');
  });

  it('does not render unsupported post nodes as noisy text', () => {
    const post = {
      zh_cn: {
        content: [
          [
            { tag: 'text', text: '普通' },
            { tag: 'unknown_text', text: '未知文本' },
            { tag: 'unknown_object', value: { nested: true } },
          ],
          [
            { tag: 'a', text: '文档', href: 'https://example.com' },
            { tag: 'at', user_name: 'Alice' },
          ],
        ],
      },
    };

    expect(parseApiMessage(makeMsg('post', post)).content).toBe('普通\n文档@Alice');
  });

  it('renders img tag in post body as [图片] placeholder when no numberer', () => {
    // Regression: previously dropped to empty string, hiding attached images
    // from `botmux thread messages` and misleading downstream readers.
    const post = {
      zh_cn: {
        title: '',
        content: [
          [{ tag: 'text', text: 'see attached:' }],
          [{ tag: 'img', image_key: 'img_v3_xxx', width: 100, height: 100 }],
        ],
      },
    };
    const result = parseApiMessage(makeMsg('post', post));
    expect(result.content).toBe('see attached:\n[图片]');
  });

  it('renders file tag in post body as [文件: name] placeholder', () => {
    const post = {
      zh_cn: {
        content: [
          [{ tag: 'text', text: 'doc:' }],
          [{ tag: 'file', file_key: 'file_xxx', file_name: 'spec.pdf' }],
        ],
      },
    };
    const result = parseApiMessage(makeMsg('post', post));
    expect(result.content).toBe('doc:\n[文件: spec.pdf]');
  });
});

// ─── Audio (voice) messages: placeholder + metadata extraction ────────────

describe('Audio message parsing', () => {
  it('renders audio content as [语音] placeholder via parseApiMessage', () => {
    const result = parseApiMessage(makeMsg('audio', { file_key: 'file_voice', duration: 2000 }));
    expect(result.msgType).toBe('audio');
    expect(result.content).toBe(AUDIO_PLACEHOLDER);
    expect(result.content).toBe('[语音]');
  });

  it('renders audio content as [语音] placeholder via parseEventMessage', () => {
    const event = {
      sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      message: {
        message_id: 'om_audio',
        message_type: 'audio',
        content: JSON.stringify({ file_key: 'file_voice', duration: 2000 }),
        chat_id: 'oc_chat',
        chat_type: 'group',
        create_time: '1000',
      },
    };
    const { parsed, resources } = parseEventMessage(event);
    expect(parsed.msgType).toBe('audio');
    expect(parsed.messageId).toBe('om_audio');
    expect(parsed.content).toBe('[语音]');
    // audio 不进 extractResources 的图片/文件清单
    expect(resources).toEqual([]);
  });

  it('never leaks raw file_key JSON into parsed content', () => {
    const raw = JSON.stringify({ file_key: 'file_secret', duration: 5000 });
    expect(parseApiMessage(makeMsg('audio', raw)).content).not.toContain('file_secret');
  });
});

describe('extractAudioMeta', () => {
  it('extracts file_key and durationMs from valid audio content', () => {
    expect(extractAudioMeta(JSON.stringify({ file_key: 'file_voice', duration: 2000 })))
      .toEqual({ fileKey: 'file_voice', durationMs: 2000 });
  });

  it('returns durationMs undefined when duration is absent', () => {
    expect(extractAudioMeta(JSON.stringify({ file_key: 'file_voice' })))
      .toEqual({ fileKey: 'file_voice', durationMs: undefined });
  });

  it('ignores non-number duration', () => {
    expect(extractAudioMeta(JSON.stringify({ file_key: 'file_voice', duration: '2s' })))
      .toEqual({ fileKey: 'file_voice', durationMs: undefined });
  });

  it('returns null for invalid JSON', () => {
    expect(extractAudioMeta('not json')).toBeNull();
  });

  it('returns null when file_key is missing', () => {
    expect(extractAudioMeta(JSON.stringify({ duration: 2000 }))).toBeNull();
  });

  it('returns null when file_key is empty or not a string', () => {
    expect(extractAudioMeta(JSON.stringify({ file_key: '' }))).toBeNull();
    expect(extractAudioMeta(JSON.stringify({ file_key: 123 }))).toBeNull();
  });
});

describe('extractResources: interactive cards', () => {
  it('should extract image_key from API format elements', () => {
    const card = {
      title: 'Card with images',
      elements: [
        [{ tag: 'img', image_key: 'img_v3_aaa' }, { tag: 'text', text: 'desc' }],
        [{ tag: 'img', image_key: 'img_v3_bbb' }],
      ],
    };
    const resources = extractResources('interactive', JSON.stringify(card));
    expect(resources).toHaveLength(2);
    expect(resources[0]).toEqual({ type: 'image', key: 'img_v3_aaa', name: 'img_v3_aaa.jpg' });
    expect(resources[1]).toEqual({ type: 'image', key: 'img_v3_bbb', name: 'img_v3_bbb.jpg' });
  });

  it('should return empty for card without images', () => {
    const card = { title: 'No images', elements: [[{ tag: 'text', text: 'hello' }]] };
    const resources = extractResources('interactive', JSON.stringify(card));
    expect(resources).toHaveLength(0);
  });

  it('should return empty for template cards', () => {
    const card = { type: 'template', data: { template_id: 'xxx' } };
    const resources = extractResources('interactive', JSON.stringify(card));
    expect(resources).toHaveLength(0);
  });
});

// ─── stripLeadingMentions ──────────────────────────────────────────────────

describe('stripLeadingMentions', () => {
  it('strips a single leading mention with multi-word name', () => {
    const out = stripLeadingMentions('@Botmux Oncall /oncall bind ~/iserver/botmux', [
      { name: 'Botmux Oncall' },
    ]);
    expect(out).toBe('/oncall bind ~/iserver/botmux');
  });

  it('strips multiple leading mentions in sequence', () => {
    const out = stripLeadingMentions('@Alice @Bob /restart', [
      { name: 'Alice' },
      { name: 'Bob' },
    ]);
    expect(out).toBe('/restart');
  });

  it('leaves content untouched when there is no leading mention', () => {
    const out = stripLeadingMentions('hello @Bot how are you', [{ name: 'Bot' }]);
    expect(out).toBe('hello @Bot how are you');
  });

  it('falls back to single-word @<word> regex when no mentions list given', () => {
    const out = stripLeadingMentions('@bot /status', undefined);
    expect(out).toBe('/status');
  });

  it('preserves trailing content unchanged when stripping', () => {
    const out = stripLeadingMentions('@Botmux 介绍下当前项目', [{ name: 'Botmux' }]);
    expect(out).toBe('介绍下当前项目');
  });

  it('strips prefix-overlapping names by length-desc so "@Claude分身" wins over "@Claude"', () => {
    // Regression: chain @Claude @Claude分身 @CoCo /close — naive iteration
    // matches "@Claude" first, slices 7 chars, leaves "分身 @CoCo /close"
    // which never rematches and silently breaks /close detection.
    const out = stripLeadingMentions('@Claude @Claude分身 @CoCo /close', [
      { name: 'Claude' },
      { name: 'Claude分身' },
      { name: 'CoCo' },
    ]);
    expect(out).toBe('/close');
  });
});

// ─── Shared numberer: cmdQuoted invariant ─────────────────────────────────
// cmdQuoted renders a single quoted message by chaining extractResources →
// parseApiMessage. Both calls must share one numberer so the `[图片 N]`
// placeholders inside the rendered `content` align 1:1 with the indices of
// the returned `resources` array. If they used independent numberers
// (the bug Codex caught), a multi-image post would emit `[图片 1] [图片 2]`
// inside content but resources[0]/resources[1] would still be the same two
// keys — alignment LOOKS right by accident at N=2 but breaks the moment we
// add a 2nd numbering source (e.g. nested merge_forward).

describe('cmdQuoted shared-numberer invariant', () => {
  it('post with two images: [图片 1]/[图片 2] in content map to resources[0]/[1] keys when one numberer is shared', () => {
    const postContent = JSON.stringify({
      zh_cn: {
        title: '截图',
        content: [
          [{ tag: 'text', text: '第一张：' }, { tag: 'img', image_key: 'img_aaa' }],
          [{ tag: 'text', text: '第二张：' }, { tag: 'img', image_key: 'img_bbb' }],
        ],
      },
    });
    const msg = {
      message_id: 'om_post',
      msg_type: 'post',
      create_time: '1000',
      sender: { id: 'ou_u', sender_type: 'user' },
      body: { content: postContent },
    };

    // Match the cmdQuoted call order exactly: extractResources first, then
    // parseApiMessage. Same numberer instance threaded through both.
    const numberer = createImgNumberer();
    const resources = extractResources(msg.msg_type, msg.body.content, numberer);
    const parsed = parseApiMessage(msg, numberer);

    expect(resources).toEqual([
      { type: 'image', key: 'img_aaa', name: 'img_aaa.jpg' },
      { type: 'image', key: 'img_bbb', name: 'img_bbb.jpg' },
    ]);
    expect(parsed.content).toContain('[图片 1]');
    expect(parsed.content).toContain('[图片 2]');
    expect(parsed.content.indexOf('[图片 1]')).toBeLessThan(parsed.content.indexOf('[图片 2]'));
  });

  it('post with one image + one file: image and file counters are independent ([图片 1] + [文件 1])', () => {
    // Regression: extractResources used to share a global counter so this
    // would emit `[图片 1]` + `[文件 2]`, but formatAttachmentsHint emits
    // <image n="1"> + <file n="1"> — the bot saw [文件 2] in prompt but only
    // <file n="1"> in attachments and read the wrong file. Per-type counters
    // align placeholders with the attachment footer.
    const postContent = JSON.stringify({
      zh_cn: {
        title: '混合',
        content: [
          [{ tag: 'text', text: '图：' }, { tag: 'img', image_key: 'img_aaa' }],
          [{ tag: 'text', text: '文件：' }, { tag: 'file', file_key: 'file_bbb', file_name: 'spec.pdf' }],
        ],
      },
    });
    const msg = {
      message_id: 'om_mixed',
      msg_type: 'post',
      create_time: '1000',
      sender: { id: 'ou_u', sender_type: 'user' },
      body: { content: postContent },
    };
    const numberer = createImgNumberer();
    const resources = extractResources(msg.msg_type, msg.body.content, numberer);
    const parsed = parseApiMessage(msg, numberer);
    expect(resources).toEqual([
      { type: 'image', key: 'img_aaa', name: 'img_aaa.jpg' },
      { type: 'file', key: 'file_bbb', name: 'spec.pdf' },
    ]);
    expect(parsed.content).toContain('[图片 1]');
    expect(parsed.content).toContain('[文件 1: spec.pdf]');
  });

  it('image message: [图片 1] in content matches the single resource', () => {
    const imgContent = JSON.stringify({ image_key: 'img_zzz' });
    const msg = {
      message_id: 'om_img',
      msg_type: 'image',
      create_time: '1000',
      sender: { id: 'ou_u', sender_type: 'user' },
      body: { content: imgContent },
    };
    const numberer = createImgNumberer();
    const resources = extractResources(msg.msg_type, msg.body.content, numberer);
    const parsed = parseApiMessage(msg, numberer);
    expect(resources).toEqual([{ type: 'image', key: 'img_zzz', name: 'img_zzz.jpg' }]);
    expect(parsed.content).toBe('[图片 1]');
  });
});

// ─── parseEventMessage: parentId surfacing for quote-reply ────────────────

describe('parseEventMessage: parentId surfacing', () => {
  function makeEvent(extras: Partial<{ parent_id: string; root_id: string }>) {
    return {
      sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      message: {
        message_id: 'om_msg',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
        chat_id: 'oc_chat',
        chat_type: 'group',
        create_time: '1000',
        ...extras,
      },
    };
  }

  it('surfaces parent_id on the parsed message when the user used quote-reply', () => {
    const { parsed } = parseEventMessage(makeEvent({ parent_id: 'om_quoted', root_id: 'om_quoted' }));
    expect(parsed.parentId).toBe('om_quoted');
  });

  it('leaves parentId undefined when the event has no parent_id', () => {
    const { parsed } = parseEventMessage(makeEvent({}));
    expect(parsed.parentId).toBeUndefined();
  });

  it('treats empty-string parent_id as absent', () => {
    const { parsed } = parseEventMessage(makeEvent({ parent_id: '' }));
    expect(parsed.parentId).toBeUndefined();
  });
});

describe('parseEventMessage: shared resource numbering', () => {
  const makeImageEvent = (messageId: string, imageKey: string) => ({
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
    message: {
      message_id: messageId,
      message_type: 'image',
      content: JSON.stringify({ image_key: imageKey }),
      chat_id: 'oc_chat',
      chat_type: 'group',
      create_time: '1000',
    },
  });

  it('continues numbering and deduplicates resources across paired events', () => {
    const numberer = createImgNumberer();
    const first = parseEventMessage(makeImageEvent('om_first', 'img_a'), numberer);
    const second = parseEventMessage(makeImageEvent('om_second', 'img_b'), numberer);
    const duplicate = parseEventMessage(makeImageEvent('om_third', 'img_a'), numberer);

    expect(first.parsed.content).toBe('[图片 1]');
    expect(second.parsed.content).toBe('[图片 2]');
    expect(duplicate.parsed.content).toBe('[图片 1]');
    expect(duplicate.resources).toEqual([]);
  });
});

// ─── mentionOpenId: tolerate both Lark mention.id shapes ──────────────────
//
// WS event (im.message.receive_v1) → id is an OBJECT { open_id, ... }.
// REST API (im.message.get / list) → id is a bare STRING "ou_xxx" + id_type.
// The helper must read open_id from either so a Lark shape convergence can't
// silently break @-detection.

describe('mentionOpenId', () => {
  it('reads open_id from the WS event object form', () => {
    expect(mentionOpenId({ id: { open_id: 'ou_abc', union_id: 'on_x', user_id: '' } })).toBe('ou_abc');
  });

  it('reads the bare string form when id_type is open_id', () => {
    expect(mentionOpenId({ id: 'ou_abc', id_type: 'open_id' })).toBe('ou_abc');
  });

  it('reads the bare string form when id_type is absent (mentions are open_id-keyed)', () => {
    expect(mentionOpenId({ id: 'ou_abc' })).toBe('ou_abc');
  });

  it('returns undefined for a string id whose id_type is not open_id', () => {
    // union_id/user_id strings (possible without open_id scope) must not be
    // returned as an open_id and mis-compared against a botOpenId.
    expect(mentionOpenId({ id: 'on_abc', id_type: 'union_id' })).toBeUndefined();
    expect(mentionOpenId({ id: 'b199821f', id_type: 'user_id' })).toBeUndefined();
  });

  it('returns undefined for empty / missing ids', () => {
    expect(mentionOpenId({ id: { open_id: '' } })).toBeUndefined();
    expect(mentionOpenId({ id: '' })).toBeUndefined();
    expect(mentionOpenId({ id: null })).toBeUndefined();
    expect(mentionOpenId({})).toBeUndefined();
    expect(mentionOpenId(undefined)).toBeUndefined();
    expect(mentionOpenId(null)).toBeUndefined();
  });
});

describe('parseEventMessage: mention identity formats', () => {
  function makeMentionEvent(mention: any) {
    return {
      sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      message: {
        message_id: 'om_msg',
        message_type: 'text',
        content: JSON.stringify({ text: '@BotA hello' }),
        chat_id: 'oc_chat',
        chat_type: 'group',
        create_time: '1000',
        mentions: [mention],
      },
    };
  }

  it('surfaces openId from the WS event object form', () => {
    const { parsed } = parseEventMessage(makeMentionEvent({
      key: '@_bot',
      name: 'BotA',
      id: { open_id: 'ou_bot_a_open_id' },
    }));
    expect(parsed.mentions?.[0]).toMatchObject({
      key: '@_bot',
      name: 'BotA',
      openId: 'ou_bot_a_open_id',
    });
  });

  it('keeps string open_id mention ids as openId', () => {
    const { parsed } = parseEventMessage(makeMentionEvent({
      key: '@_bot',
      name: 'BotA',
      id: 'ou_bot_a_open_id',
    }));
    expect(parsed.mentions?.[0]).toMatchObject({
      key: '@_bot',
      name: 'BotA',
      openId: 'ou_bot_a_open_id',
    });
  });

  it('does not expose app_id mention ids as openId', () => {
    const { parsed } = parseEventMessage(makeMentionEvent({
      key: '@_bot',
      name: 'BotA',
      id: 'app-bot-a',
      id_type: 'app_id',
    }));
    expect(parsed.mentions?.[0]).toMatchObject({
      key: '@_bot',
      name: 'BotA',
      idType: 'app_id',
    });
    expect(parsed.mentions?.[0].openId).toBeUndefined();
  });

  it('does not expose a bare cli_ app_id as openId when id_type is omitted', () => {
    expect(mentionOpenId({ id: 'cli_bot_without_type' })).toBeUndefined();
  });
});

// ─── messageMentionsBot: single-source @-gate across realtime/poll/preview ──
// Regression guard: this replaced three ad-hoc @-detections. It MUST recognize
// every mention shape the old realtime code did (5 app_id forms + open_id, WS
// object + REST bare-string) and scan inline `at` tags in BOTH content (realtime
// event) and body.content (REST message-list). Table-driven so a dropped shape
// announces itself.
describe('messageMentionsBot', () => {
  const BOT_OPEN = 'ou_this_bot';
  const BOT_APP = 'cli_this_bot';

  const matchCases: Array<[string, any]> = [
    ['WS object open_id', { mentions: [{ id: { open_id: BOT_OPEN } }] }],
    ['REST bare-string open_id + id_type', { mentions: [{ id: BOT_OPEN, id_type: 'open_id' }] }],
    ['REST bare-string open_id (no id_type)', { mentions: [{ id: BOT_OPEN }] }],
    ['app_id: top-level snake_case', { mentions: [{ app_id: BOT_APP }] }],
    ['app_id: top-level camelCase', { mentions: [{ appId: BOT_APP }] }],
    ['app_id: id string + id_type', { mentions: [{ id: BOT_APP, id_type: 'app_id' }] }],
    ['app_id: id string + camelCase idType', { mentions: [{ id: BOT_APP, idType: 'app_id' }] }],
    ['app_id: id object', { mentions: [{ id: { app_id: BOT_APP } }] }],
    ['inline at in realtime content', { content: JSON.stringify({ zh_cn: { content: [[{ tag: 'at', user_id: BOT_OPEN }]] } }) }],
    ['inline at in REST body.content', { body: { content: JSON.stringify({ zh_cn: { content: [[{ tag: 'at', user_id: BOT_OPEN }]] } }) } }],
  ];
  for (const [label, message] of matchCases) {
    it(`matches: ${label}`, () => {
      expect(messageMentionsBot(message, BOT_APP, BOT_OPEN)).toBe(true);
    });
  }

  const noMatchCases: Array<[string, any]> = [
    ['a different user open_id', { mentions: [{ id: { open_id: 'ou_someone_else' } }] }],
    ['a different bot app_id', { mentions: [{ app_id: 'cli_other_bot' }] }],
    ['no mentions and no inline at', { content: JSON.stringify({ text: 'hello' }) }],
    ['inline at for another user', { body: { content: JSON.stringify({ zh_cn: { content: [[{ tag: 'at', user_id: 'ou_someone_else' }]] } }) } }],
    ['empty message', {}],
  ];
  for (const [label, message] of noMatchCases) {
    it(`does not match: ${label}`, () => {
      expect(messageMentionsBot(message, BOT_APP, BOT_OPEN)).toBe(false);
    });
  }

  it('returns false when neither botOpenId nor larkAppId is known', () => {
    expect(messageMentionsBot({ mentions: [{ id: { open_id: BOT_OPEN } }] }, undefined, undefined)).toBe(false);
  });

  it('matches an app_id mention even when botOpenId is not yet resolved', () => {
    expect(messageMentionsBot({ mentions: [{ app_id: BOT_APP }] }, BOT_APP, undefined)).toBe(true);
  });
});

describe('extractPostAtParticipants (post inline @ → routing-only participants)', () => {
  const post = (nodes: any[]) => ({ content: JSON.stringify({ zh_cn: { title: '', content: [nodes] } }) });

  it('classifies ou_ → openId, cli_ → appId, carries user_name', () => {
    const out = extractPostAtParticipants(post([
      { tag: 'text', text: 'hi ' },
      { tag: 'at', user_id: 'ou_human', user_name: '张三' },
      { tag: 'at', user_id: 'cli_bot', user_name: 'OtherBot' },
    ]));
    expect(out).toEqual([
      { key: '@_post_at_1', name: '张三', openId: 'ou_human', idType: 'open_id' },
      { key: '@_post_at_2', name: 'OtherBot', appId: 'cli_bot', idType: 'app_id' },
    ]);
  });

  it('an `all` inline at is surfaced WITHOUT an executable id (→ core marks incomplete)', () => {
    const out = extractPostAtParticipants(post([{ tag: 'at', user_id: 'all', user_name: '所有人' }]));
    expect(out).toHaveLength(1);
    expect(out[0].openId).toBeUndefined();
    expect(out[0].appId).toBeUndefined();
  });

  it('non-post shapes / parse errors → empty', () => {
    expect(extractPostAtParticipants({ content: '{"text":"plain"}' })).toEqual([]);
    expect(extractPostAtParticipants({ content: 'not json' })).toEqual([]);
    expect(extractPostAtParticipants(undefined)).toEqual([]);
  });
});
