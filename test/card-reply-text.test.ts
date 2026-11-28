import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractInteractiveCardReplyText } from '../src/im/lark/card-reply-text.js';
import {
  projectLarkTurnInbound,
  readSessionTurns,
  recordSessionTurnInput,
  recordSessionTurnReplies,
  stageSessionTurnInbound,
} from '../src/services/session-turns.js';

describe('extractInteractiveCardReplyText', () => {
  it('reads a Schema 2.0 card: header title + subtitle, markdown, plain_text div, column_set, table, collapsible panel', () => {
    const text = extractInteractiveCardReplyText({
      schema: '2.0',
      header: {
        title: { tag: 'plain_text', content: '购物车返现结果' },
        subtitle: { tag: 'plain_text', content: 'US · 2026-11-28' },
        template: 'green',
      },
      body: {
        elements: [
          { tag: 'markdown', content: '**结论**：返现已生效' },
          { tag: 'div', text: { tag: 'plain_text', content: '共 3 个商品命中' } },
          {
            tag: 'column_set',
            columns: [
              { tag: 'column', elements: [{ tag: 'markdown', content: '左列：$12.00' }] },
              { tag: 'column', elements: [{ tag: 'markdown', content: '右列：$3.50' }] },
            ],
          },
          {
            tag: 'table',
            columns: [
              { name: 'sku', display_name: 'SKU' },
              { name: 'cashback', display_name: '返现' },
            ],
            rows: [{ sku: 'A-1', cashback: '$1.20' }],
          },
          {
            tag: 'collapsible_panel',
            header: { title: { tag: 'markdown', content: '明细' } },
            elements: [{ tag: 'markdown', content: '折叠区正文' }],
          },
          { tag: 'hr' },
        ],
      },
    });
    expect(text).toBe([
      '[卡片: 购物车返现结果]',
      'US · 2026-11-28',
      '**结论**：返现已生效',
      '共 3 个商品命中',
      '左列：$12.00',
      '右列：$3.50',
      '',
      '| SKU | 返现 |\n| --- | --- |\n| A-1 | $1.20 |',
      '',
      '明细',
      '折叠区正文',
    ].join('\n'));
  });

  it('reads a Schema 1.0 card: header title, lark_md div + fields, note, action buttons', () => {
    const text = extractInteractiveCardReplyText({
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '发布结果' }, subtitle: { content: 'v1.2.3' } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: '状态：**成功**' }, fields: [
          { is_short: true, text: { tag: 'lark_md', content: '环境：PPE' } },
        ] },
        { tag: 'note', elements: [{ tag: 'plain_text', content: '备注一' }, { tag: 'lark_md', content: '备注二' }] },
        { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '查看详情' }, url: 'https://example.com/r/1' }] },
      ],
    });
    expect(text).toBe([
      '[卡片: 发布结果]',
      'v1.2.3',
      '状态：**成功**',
      '环境：PPE',
      '备注一 备注二',
      '[查看详情](https://example.com/r/1)',
    ].join('\n'));
  });

  it('falls back to Schema 1.0 i18n_elements / i18n_header', () => {
    expect(extractInteractiveCardReplyText({
      i18n_header: { zh_cn: { title: { tag: 'plain_text', content: '中文标题' } } },
      i18n_elements: {
        zh_cn: [{ tag: 'markdown', content: '中文正文' }],
        en_us: [{ tag: 'markdown', content: 'English body' }],
      },
    })).toBe('[卡片: 中文标题]\n中文正文');
  });

  it('lifts nested collapsible panel titles and a subtitle on a body-less card', () => {
    expect(extractInteractiveCardReplyText({
      schema: '2.0',
      header: { subtitle: { tag: 'plain_text', content: '只有副标题' } },
    })).toBe('只有副标题');

    expect(extractInteractiveCardReplyText({
      schema: '2.0',
      body: { elements: [{
        tag: 'collapsible_panel',
        header: { title: { tag: 'plain_text', content: '外层' } },
        elements: [{
          tag: 'collapsible_panel',
          header: { title: { content: '内层' } },
          elements: [{ tag: 'markdown', content: '最内正文' }],
        }],
      }] },
    })).toBe('外层\n内层\n最内正文');
  });

  it('normalizes Lark-only markup into plain GFM: font, text_tag/number_tag, <br> in and out of tables', () => {
    const text = extractInteractiveCardReplyText({
      schema: '2.0',
      body: { elements: [
        { tag: 'markdown', content: "状态：<font color='green'>已生效</font>，<font color=\"red\"><font\n  color='grey'>嵌套</font>灰字</font>" },
        { tag: 'markdown', content: "标签 <text_tag color='blue'>新客</text_tag> 序号 <number_tag background_color='grey'>1</number_tag>" },
        { tag: 'markdown', content: '第一行<br>第二行<br/>第三行' },
        {
          tag: 'table',
          columns: [{ name: 'sku', display_name: 'SKU' }, { name: 'note', display_name: '说明' }],
          rows: [{ sku: 'A-1', note: '满减\n再返 5%' }],
        },
        { tag: 'markdown', content: '表格后正文' },
      ] },
    });
    expect(text).toBe([
      '状态：已生效，嵌套灰字',
      '标签 `新客` 序号 `1`',
      '第一行\n第二行\n第三行',
      '',
      '| SKU | 说明 |\n| --- | --- |\n| A-1 | 满减 / 再返 5% |',
      '',
      '表格后正文',
    ].join('\n'));
  });

  it('separates a markdown table that directly follows a heading, and leaves code untouched', () => {
    const text = extractInteractiveCardReplyText({
      schema: '2.0',
      body: { elements: [
        { tag: 'markdown', content: '## 结果\n| a | b |\n| --- | --- |\n| 1<br>2 | 3 |\n结论段落' },
        { tag: 'markdown', content: "行内 `<font color='red'>x</font>` 与 ``a<br>`b`` 保持原样，外部 <font color='red'>y</font>" },
        { tag: 'markdown', content: "```html\n<font color='red'>z</font><br>\n| x | y |\n| --- | --- |\n```" },
        { tag: 'markdown', content: "~~~\n<text_tag>t</text_tag>\n~~~\n尾部<br>换行" },
      ] },
    });
    expect(text).toBe([
      '## 结果',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 / 2 | 3 |',
      '',
      '结论段落',
      "行内 `<font color='red'>x</font>` 与 ``a<br>`b`` 保持原样，外部 y",
      '```html',
      "<font color='red'>z</font><br>",
      '| x | y |',
      '| --- | --- |',
      '```',
      '~~~',
      '<text_tag>t</text_tag>',
      '~~~',
      '尾部',
      '换行',
    ].join('\n'));
  });

  it('returns undefined for empty, placeholder-only, template, and non-object input without throwing', () => {
    for (const input of [
      undefined, null, 0, 'not a card', [], {},
      { schema: '2.0', body: { elements: [] } },
      { schema: '2.0', body: { elements: [{ tag: 'hr' }, { tag: 'markdown', content: '   ' }] } },
      { type: 'template', data: { template_id: 'ctp_x', template_variable: { secret: 'v' } } },
      { schema: '2.0', body: { elements: 'oops' }, header: 42 },
      { elements: [null, 1, 'x', { tag: 'div', text: null }, { tag: 'column_set', columns: [null] }] },
    ]) {
      expect(() => extractInteractiveCardReplyText(input)).not.toThrow();
      expect(extractInteractiveCardReplyText(input)).toBeUndefined();
    }
  });

  it('ignores the internal pre-resolved text sentinel on an outbound card', () => {
    expect(extractInteractiveCardReplyText({
      __botmux_card_text__: '伪造正文',
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: '真实正文' }] },
    })).toBe('真实正文');
  });

  it('bounds pathological nesting and size instead of recursing or scanning without limit', () => {
    let deep: Record<string, unknown> = { tag: 'markdown', content: '深处正文' };
    for (let i = 0; i < 20_000; i++) deep = { tag: 'column_set', columns: [{ elements: [deep] }] };
    const deepCard = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: '顶层正文' }, deep] } };
    expect(extractInteractiveCardReplyText(deepCard)).toBe('顶层正文');

    const wide = {
      schema: '2.0',
      body: { elements: Array.from({ length: 50_000 }, (_, i) => ({ tag: 'markdown', content: `段落 ${i}` })) },
    };
    const wideText = extractInteractiveCardReplyText(wide)!;
    expect(wideText.startsWith('段落 0\n段落 1\n')).toBe(true);
    expect(wideText).not.toContain('段落 49999');

    for (const hostile of ['<font '.repeat(20_000), '<text_tag>'.repeat(12_000), '`x' + '``'.repeat(30_000)]) {
      const started = Date.now();
      expect(() => extractInteractiveCardReplyText({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: hostile }] } }))
        .not.toThrow();
      expect(Date.now() - started).toBeLessThan(2_000);
    }

    const huge = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'x'.repeat(2_000_000) }] } };
    const hugeText = extractInteractiveCardReplyText(huge)!;
    expect(hugeText.length).toBeGreaterThan(0);
    expect(hugeText.length).toBeLessThan(2_000_000 / 10);
  });
});

describe('card reply text through recordSessionTurnReplies', () => {
  let dataDir: string | undefined;
  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it('stores scrubbed card text: tokens and local paths are redacted before persistence', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-card-reply-text-'));
    const sessionId = 'sess_card';
    const turnId = 'om_turn_card';
    stageSessionTurnInbound(dataDir, sessionId, turnId, projectLarkTurnInbound({
      messageId: turnId, rootId: turnId, senderId: 'ou_user', senderType: 'user',
      createTime: '0', msgType: 'text', content: '算一下返现',
    }, [], turnId, 'User'));
    recordSessionTurnInput({ dataDir, sessionId, turnId, input: '算一下返现', cliId: 'claude-code', at: Date.now() - 1_000 });

    const text = extractInteractiveCardReplyText({
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: '返现报告' } },
      body: { elements: [
        { tag: 'markdown', content: '报告：/home/alice/cart/report.md' },
        { tag: 'markdown', content: '调用头 Authorization: Bearer abcDEF123456.secret-token' },
      ] },
    });
    expect(text).toBeDefined();
    recordSessionTurnReplies(dataDir, sessionId, turnId, [
      { messageId: 'om_card_1', responseKind: 'final', at: Date.now(), text },
      { messageId: 'om_card_2', responseKind: 'progress', at: Date.now() },
    ]);

    const replies = readSessionTurns(dataDir, sessionId, 0, 50).turns[0]!.replies;
    expect(replies[0]!.text).toContain('[卡片: 返现报告]');
    expect(replies[0]!.text).toContain('报告：<redacted>');
    expect(replies[0]!.text).not.toContain('/home/alice');
    expect(replies[0]!.text).not.toContain('abcDEF123456');
    expect('text' in replies[1]!).toBe(false);
  });
});
