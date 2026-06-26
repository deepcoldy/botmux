/**
 * Unit tests for message-parser: extractTextContent & extractResources.
 *
 * Covers interactive card parsing (Format A: Lark API simplified format,
 * Format B: original card JSON) and image resource extraction from cards.
 *
 * Run:  pnpm vitest run test/message-parser.test.ts
 */
import { describe, it, expect } from 'vitest';
import { parseApiMessage, extractResources, parseEventMessage, stripLeadingMentions, createImgNumberer, cardContentHasUpgradeFallback, isPureCardUpgradeFallback, mergeCardText, wrapResolvedCardText, mentionOpenId, CARD_EMBEDDED_PLACEHOLDER } from '../src/im/lark/message-parser.js';
import { buildMarkdownCard } from '../src/im/lark/md-card.js';

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

  it('round-trips a real buildMarkdownCard output without footer leakage', () => {
    const raw = buildMarkdownCard('帮我看下这个 bug', 'ou_owner');
    const result = parseApiMessage(makeMsg('interactive', JSON.parse(raw)));
    expect(result.content).toContain('帮我看下这个 bug');
    expect(result.content).not.toContain('botmux');
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
});

// ─── Structural footer strip (brand-agnostic, for per-bot custom brands) ──

describe('Interactive card parsing: footer stripped structurally (custom brand)', () => {
  it('drops a custom-brand grey notation_small_v2 footer element (no botmux URL to anchor on)', () => {
    // A peer bot configured brandLabel='Acme' — the receiving bot can't know
    // that label, so the URL anchor can't catch it. The text_size+grey
    // structural signal does.
    const card = {
      body: { elements: [
        { tag: 'markdown', content: '正文内容' },
        { tag: 'hr' },
        { tag: 'markdown', text_size: 'notation_small_v2',
          content: "<font color='grey'>[Acme](https://acme.test) · 发送给：<at id=ou_owner></at></font>" },
      ] },
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('正文内容');
    expect(result.content).not.toContain('Acme');
    expect(result.content).not.toContain('发送给');
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

describe('parseEventMessage: mention open_id across both id shapes', () => {
  function makeEvent(mentions: any[]) {
    return {
      sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      message: {
        message_id: 'om_msg',
        message_type: 'text',
        content: JSON.stringify({ text: '@Claude hi' }),
        chat_id: 'oc_chat',
        chat_type: 'group',
        create_time: '1000',
        mentions,
      },
    };
  }

  it('surfaces openId from the WS event object form', () => {
    const { parsed } = parseEventMessage(makeEvent([{ key: '@_user_1', name: 'Claude', id: { open_id: 'ou_claude' } }]));
    expect(parsed.mentions?.[0]?.openId).toBe('ou_claude');
  });

  it('surfaces openId from the REST string form', () => {
    const { parsed } = parseEventMessage(makeEvent([{ key: '@_user_1', name: 'Claude', id: 'ou_claude', id_type: 'open_id' }]));
    expect(parsed.mentions?.[0]?.openId).toBe('ou_claude');
  });
});
