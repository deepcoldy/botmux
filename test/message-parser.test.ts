/**
 * Unit tests for message-parser: extractTextContent & extractResources.
 *
 * Covers interactive card parsing (Format A: Lark API simplified format,
 * Format B: original card JSON) and image resource extraction from cards.
 *
 * Run:  pnpm vitest run test/message-parser.test.ts
 */
import { describe, it, expect } from 'vitest';
import { parseApiMessage, extractResources, stripLeadingMentions } from '../src/im/lark/message-parser.js';

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
    expect(result.content).toBe('[卡片: Links]\nSee docs or ask @Alice');
  });

  it('should extract button labels', () => {
    const card = {
      title: '🖥️ Session — 就绪',
      elements: [[
        { tag: 'button', text: '📖 展开输出', type: 'default' },
        { tag: 'button', text: '🖥️ 打开终端', type: 'primary' },
        { tag: 'button', text: '❌ 关闭会话', type: 'danger' },
      ]],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('[卡片: 🖥️ Session — 就绪]');
    expect(result.content).toContain('[📖 展开输出]');
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

  it('should handle card with no title and no useful elements', () => {
    const card = { elements: [[{ tag: 'img', image_key: 'img_xxx' }]] };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toBe('[卡片]\n[图片]');
  });
});

// ─── Interactive card: Format B (original card JSON) ──────────────────────

describe('Interactive card parsing: Format B (original card JSON)', () => {
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

  it('should handle session card (actions only, no div/markdown)', () => {
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
    expect(result.content).toBe('[卡片: 🖥️ Claude 会话已启动]');
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

// ─── extractResources for interactive cards ───────────────────────────────

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
});
