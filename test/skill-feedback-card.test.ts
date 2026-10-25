import { describe, expect, it, vi } from 'vitest';
import { buildCanonicalFinalReplyCard, buildMarkdownCard } from '../src/im/lark/md-card.js';
import { renderFeedbackCard } from '../src/im/lark/skill-feedback-card.js';
import { normalizeFeedbackPolicy } from '../src/services/feedback-policy.js';
import MarkdownIt from 'markdown-it';

const policy = normalizeFeedbackPolicy({
  enabled: true,
  negativeFollowup: { reasons: [{ key: 'missing_context', label: '缺少关键信息' }] },
});
const baseCard = JSON.parse(buildCanonicalFinalReplyCard({ markdown: 'final answer', feedback: { policy }, brand: 'botmux' }));

function visible(card: unknown): string { return JSON.stringify(card); }

describe('final answer feedback card state machine', () => {
  it('renders configured initial actions before the footer without internal levels', () => {
    expect(visible(baseCard)).toContain('结论可用');
    expect(visible(baseCard)).toContain('有效推进');
    const elements = baseCard.body.elements;
    expect(elements.findIndex((element: any) => element.element_id === 'botmux_feedback')).toBeLessThan(elements.findIndex((element: any) => element.element_id === 'botmux_reply_footer'));
    expect(visible(baseCard)).not.toMatch(/L0|L1|L2/);
  });

  it('keeps button components, shows the selected label, and locks re-selection by default', () => {
    const card = renderFeedbackCard(baseCard, policy, { result: 'conclusive_usable' });
    expect(visible(card)).toContain('已选择：**结论可用**');
    expect(visible(card)).toContain('"disabled":true');
    expect(visible(card)).not.toContain('missing_context');
    expect((card as any).body.elements.filter((element: any) => element.element_id === 'botmux_feedback')).toHaveLength(1);
  });

  it('keeps buttons enabled only when re-selection is configured', () => {
    const reselectPolicy = normalizeFeedbackPolicy({ enabled: true, allowReselect: true });
    const reselectBase = JSON.parse(buildCanonicalFinalReplyCard({ markdown: 'answer', feedback: { policy: reselectPolicy } }));
    const card = renderFeedbackCard(reselectBase, reselectPolicy, { result: 'conclusive_usable' });
    expect(visible(card)).toContain('已选择：**结论可用**');
    expect(visible(card)).toContain('"disabled":false');
  });

  it('preserves all non-feedback elements when the card has no footer', () => {
    const noFooter = structuredClone(baseCard);
    noFooter.body.elements = noFooter.body.elements.filter((element: any) =>
      element.element_id !== 'botmux_reply_footer' && element.tag !== 'hr');
    noFooter.body.elements.push({ tag: 'markdown', element_id: 'after_feedback', content: 'keep me' });
    const card = renderFeedbackCard(noFooter, policy, { result: 'conclusive_usable' });
    const elements = (card as any).body.elements;
    expect(elements).toContainEqual(expect.objectContaining({ element_id: 'after_feedback', content: 'keep me' }));
    expect(elements.filter((element: any) => element.element_id === 'botmux_feedback')).toHaveLength(1);
  });

  it('expands reasons and comment form for a negative choice', () => {
    const card = renderFeedbackCard(baseCard, policy, { result: 'incorrect' });
    expect(visible(card)).toContain('已选择：**结论有误**');
    expect(visible(card)).toContain('缺少关键信息');
    expect(visible(card)).toContain('可以补充哪里需要改进');
    expect(visible(card)).toContain('提交补充');
    expect(visible(card)).toContain('form_submit');
  });

  it('renders selected reason and completed comment without echoing text', () => {
    const card = renderFeedbackCard(baseCard, policy, { result: 'incorrect', reasonKey: 'missing_context', comment: 'private detail' });
    expect(visible(card)).toContain('✓ 缺少关键信息');
    expect(visible(card)).toContain('已补充说明');
    expect(visible(card)).not.toContain('private detail');
  });

  it('collapses negative follow-up after changing to positive', () => {
    const card = renderFeedbackCard(baseCard, policy, { result: 'conclusive_usable', reasonKey: 'missing_context', comment: 'old' });
    expect(visible(card)).not.toContain('缺少关键信息');
    expect(visible(card)).not.toContain('已补充说明');
  });

  it('ordinary markdown cards remain feedback-free', () => {
    expect(buildMarkdownCard('streaming or progress')).not.toContain('botmux_feedback');
  });

  it('restores rendered table cells to sendable text without changing other card content', () => {
    const renderedCell = (content: string) => ({
      id: 'rendered-cell',
      tag: 'markdown',
      property: {
        elements: [{ tag: 'plain_text', property: { content, textAlign: 'left' } }],
        markdownElements: [],
        originTag: 'lark_md',
      },
    });
    const platformCard = structuredClone(baseCard);
    const table = {
      tag: 'table',
      columns: [
        { name: 'psm', display_name: 'Service', data_type: 'lark_md' },
        { name: 'qps', display_name: 'Peak QPS', data_type: 'lark_md' },
        { name: 'count', display_name: 'Count', data_type: 'number' },
      ],
      rows: Array.from({ length: 33 }, (_, index) => ({
        psm: renderedCell(`service-${index}`),
        qps: renderedCell(`${index}.50`),
        count: index,
      })),
    };
    platformCard.body.elements.unshift(table);
    const before = structuredClone(platformCard);
    const card = renderFeedbackCard(platformCard, policy, { result: 'conclusive_usable' }) as any;

    expect(card.body.elements[0].rows).toEqual(Array.from({ length: 33 }, (_, index) => ({
      psm: `service-${index}`, qps: `${index}.50`, count: index,
    })));
    expect(card.body.elements[0].columns).toEqual(table.columns);
    expect(card.body.elements.find((element: any) => element.tag === 'markdown' && !element.element_id))
      .toEqual(before.body.elements.find((element: any) => element.tag === 'markdown' && !element.element_id));
    expect(card.body.elements.find((element: any) => element.element_id === 'botmux_reply_footer'))
      .toEqual(before.body.elements.find((element: any) => element.element_id === 'botmux_reply_footer'));
    expect(platformCard).toEqual(before);
  });

  it('normalizes nested text tables while preserving links, code, and typed cells', () => {
    const platformCard = structuredClone(baseCard);
    const options = [{ text: 'ready', color: 'green' }];
    const persons = ['ou_member'];
    platformCard.body.elements.unshift({
      tag: 'column_set',
      columns: [{ tag: 'column', elements: [{
        tag: 'table',
        columns: [
          { name: 'detail', display_name: 'Detail', data_type: 'markdown' },
          { name: 'literal', display_name: 'Literal', data_type: 'text' },
          { name: 'options', display_name: 'State', data_type: 'options' },
          { name: 'persons', display_name: 'Owner', data_type: 'persons' },
        ],
        rows: [{
          detail: { tag: 'markdown', property: {
            elements: [
              { tag: 'a', property: { href: 'https://example.com/report', content: 'Report' } },
              { tag: 'plain_text', property: { content: ' ' } },
              { tag: 'code_span', property: { content: 'default_pstream' } },
            ],
            markdownElements: [{ tag: 'plain_text', property: { content: 'duplicate metadata' } }],
          } },
          literal: 'unchanged',
          options,
          persons,
        }],
      }] }],
    });

    const card = renderFeedbackCard(platformCard, policy, { result: 'conclusive_usable' }) as any;
    const row = card.body.elements[0].columns[0].elements[0].rows[0];
    expect(row).toEqual({
      detail: '[Report](https://example.com/report) `default_pstream`',
      literal: 'unchanged',
      options,
      persons,
    });
  });

  it('keeps plain-text columns literal and rendered markdown text non-interactive', () => {
    const platformCard = structuredClone(baseCard);
    platformCard.body.elements.unshift({
      tag: 'table',
      columns: [
        { name: 'text', data_type: 'text' },
        { name: 'markdown', data_type: 'lark_md' },
        { name: 'authored', data_type: 'markdown' },
      ],
      rows: [{
        text: { tag: 'markdown', property: { elements: [
          { tag: 'a', property: { href: 'https://example.com', content: 'Report' } },
          { tag: 'plain_text', property: { content: ' ' } },
          { tag: 'code_span', property: { content: 'default_pstream' } },
        ] } },
        markdown: { tag: 'plain_text', property: { content: '[literal](https://example.com) *not bold*' } },
        authored: '[Report](https://example.com)',
      }],
    });
    const card = renderFeedbackCard(platformCard, policy, { result: 'conclusive_usable' }) as any;
    const row = card.body.elements[0].rows[0];
    const parser = new MarkdownIt();
    expect(row.text).toBe('Report default_pstream');
    expect(parser.renderInline(row.markdown)).toBe('[literal](https://example.com) *not bold*');
    expect(parser.renderInline(row.authored)).toBe('<a href="https://example.com">Report</a>');
  });

  it('preserves rendered link labels and destinations containing markdown delimiters', () => {
    const platformCard = structuredClone(baseCard);
    platformCard.body.elements.unshift({
      tag: 'table',
      columns: [{ name: 'link', data_type: 'markdown' }],
      rows: [{ link: { tag: 'a', property: { content: 'Report [v1]', href: 'https://example.com/a)b' } } }],
    });
    const card = renderFeedbackCard(platformCard, policy, { result: 'conclusive_usable' }) as any;
    const tokens = new MarkdownIt().parseInline(card.body.elements[0].rows[0].link, {})[0].children!;
    expect(tokens.find(token => token.type === 'link_open')?.attrGet('href'))
      .toBe('https://example.com/a%29b');
    expect(tokens.find(token => token.type === 'text')?.content).toBe('Report [v1]');
    expect(tokens[tokens.length - 1].type).toBe('link_close');
  });

  it.each([' a ', '   ', '`value`'])('round-trips rendered code-span content %j', (content) => {
    const platformCard = structuredClone(baseCard);
    platformCard.body.elements.unshift({
      tag: 'table', columns: [{ name: 'code', data_type: 'lark_md' }],
      rows: [{ code: { tag: 'code_span', property: { content } } }],
    });
    const card = renderFeedbackCard(platformCard, policy, { result: 'conclusive_usable' }) as any;
    const tokens = new MarkdownIt().parseInline(card.body.elements[0].rows[0].code, {})[0].children!;
    expect(tokens.find(token => token.type === 'code_inline')?.content).toBe(content);
  });

  it('keeps table-shaped callback values and typed cells opaque', () => {
    const opaque = {
      tag: 'table', columns: [{ name: 'value', data_type: 'lark_md' }],
      rows: [{ value: { tag: 'plain_text', property: { content: 'business payload' } } }],
    };
    const platformCard = structuredClone(baseCard);
    platformCard.body.elements.unshift({
      tag: 'table', columns: [{ name: 'options', data_type: 'options' }],
      rows: [{ options: opaque }],
    });
    platformCard.body.elements.push({
      tag: 'button', text: { tag: 'plain_text', content: 'Business action' },
      behaviors: [{ type: 'callback', value: opaque }],
    });
    const card = renderFeedbackCard(platformCard, policy, { result: 'conclusive_usable' }) as any;
    expect(card.body.elements[0].rows[0].options).toEqual(opaque);
    expect(card.body.elements[card.body.elements.length - 1].behaviors[0].value).toEqual(opaque);
  });

  it('preserves literal entities and serializes nested link and code text exactly once', () => {
    const platformCard = structuredClone(baseCard);
    platformCard.body.elements.unshift({
      tag: 'table',
      columns: [
        { name: 'literal', data_type: 'lark_md' },
        { name: 'link', data_type: 'markdown' },
        { name: 'code', data_type: 'markdown' },
      ],
      rows: [{
        literal: { tag: 'plain_text', property: { content: '&copy; &amp; &#65;' } },
        link: { tag: 'a', property: {
          href: 'https://example.com/report',
          elements: [{ tag: 'plain_text', property: { content: 'Report [v1]' } }],
        } },
        code: { tag: 'code_span', property: {
          elements: [{ tag: 'plain_text', property: { content: 'default_pstream' } }],
        } },
      }],
    });
    const card = renderFeedbackCard(platformCard, policy, { result: 'conclusive_usable' }) as any;
    const row = card.body.elements[0].rows[0];
    const parser = new MarkdownIt();
    const tokens = (content: string) => parser.parseInline(content, {})[0].children!;
    expect(tokens(row.literal).map(token => token.content).join('')).toBe('&copy; &amp; &#65;');
    expect(tokens(row.link).find(token => token.type === 'text')?.content).toBe('Report [v1]');
    expect(tokens(row.code).find(token => token.type === 'code_inline')?.content).toBe('default_pstream');
  });

  it.each([
    'https://example.com/?x=1&copy;=2',
    'https://example.com/a&#65;b',
    'https://example.com/?x=1&y=2',
  ])('preserves rendered link destination %s', (href) => {
    const platformCard = structuredClone(baseCard);
    platformCard.body.elements.unshift({
      tag: 'table', columns: [{ name: 'link', data_type: 'lark_md' }],
      rows: [{ link: { tag: 'a', property: { content: 'Report', href } } }],
    });
    const card = renderFeedbackCard(platformCard, policy, { result: 'conclusive_usable' }) as any;
    const tokens = new MarkdownIt().parseInline(card.body.elements[0].rows[0].link, {})[0].children!;
    expect(tokens.find(token => token.type === 'link_open')?.attrGet('href')).toBe(href);
  });

  it('restores ordered, unordered, and nested lists from CardKit item nodes', () => {
    const platformCard = structuredClone(baseCard);
    platformCard.body.elements.unshift({
      tag: 'table', columns: [{ name: 'steps', data_type: 'markdown' }],
      rows: [{ steps: { tag: 'list', property: { items: [
        { elements: [{ tag: 'code_span', property: { content: 'a.ts' } }],
          level: 0, order: 1, type: 'ol' },
        { elements: [{ tag: 'plain_text', property: { content: 'nested item' } }],
          level: 1, type: 'ul' },
        { elements: [{ tag: 'plain_text', property: { content: 'next item' } }],
          level: 0, order: 2, type: 'ol' },
      ] } } }],
    });
    const before = structuredClone(platformCard);
    const card = renderFeedbackCard(platformCard, policy, { result: 'conclusive_usable' }) as any;
    const content = card.body.elements[0].rows[0].steps;
    expect(content).toBe('1. `a.ts`\n    - nested item\n2. next item');
    const tokens = new MarkdownIt().parse(content, {});
    expect(tokens.filter(token => token.type === 'ordered_list_open'))
      .toHaveLength(1);
    expect(tokens.filter(token => token.type === 'bullet_list_open'))
      .toHaveLength(1);
    expect(tokens.filter(token => token.type === 'list_item_open'))
      .toHaveLength(3);
    expect(platformCard).toEqual(before);
  });

  it.each([
    { url: { url: 'https://example.com/report?x=1&y=2' }, href: 'https://example.com/fallback' },
    { url: 'https://example.com/report?x=1&y=2', href: 'https://example.com/fallback' },
    { href: 'https://example.com/report?x=1&y=2' },
  ])('preserves CardKit link nodes and their URL precedence: %j', (destination) => {
    const platformCard = structuredClone(baseCard);
    platformCard.body.elements.unshift({
      tag: 'table',
      columns: [{ name: 'link', data_type: 'lark_md' }, { name: 'text', data_type: 'text' }],
      rows: [{
        link: { tag: 'link', property: { content: 'PR [925]', ...destination } },
        text: { tag: 'link', property: { content: 'PR [925]', ...destination } },
      }],
    });
    const card = renderFeedbackCard(platformCard, policy, { result: 'conclusive_usable' }) as any;
    const row = card.body.elements[0].rows[0];
    const tokens = new MarkdownIt().parseInline(row.link, {})[0].children!;
    expect(tokens.find(token => token.type === 'link_open')?.attrGet('href'))
      .toBe('https://example.com/report?x=1&y=2');
    expect(tokens.find(token => token.type === 'text')?.content).toBe('PR [925]');
    expect(row.text).toBe('PR [925]');
  });

  it.each([
    { attributes: ['bold'], expected: '<strong>important</strong>' },
    { attributes: ['italic'], expected: '<em>important</em>' },
    { attributes: ['bold', 'italic'], expected: '<em><strong>important</strong></em>' },
  ])('preserves CardKit plain-text emphasis %j', ({ attributes, expected }) => {
    const platformCard = structuredClone(baseCard);
    const styled = { tag: 'plain_text', property: {
      content: 'important', textStyle: { attributes },
    } };
    platformCard.body.elements.unshift({
      tag: 'table',
      columns: [{ name: 'markdown', data_type: 'markdown' }, { name: 'text', data_type: 'text' }],
      rows: [{ markdown: styled, text: styled }],
    });
    const card = renderFeedbackCard(platformCard, policy, { result: 'conclusive_usable' }) as any;
    const row = card.body.elements[0].rows[0];
    expect(new MarkdownIt().renderInline(row.markdown)).toBe(expected);
    expect(row.text).toBe('important');
  });

  it('warns about unrecognized text cell tags without logging cell content', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const platformCard = structuredClone(baseCard);
    const unknown = { tag: 'future_card_node', property: { secret: 'private answer content' } };
    platformCard.body.elements.unshift({
      tag: 'table', columns: [{ name: 'cell', data_type: 'lark_md' }],
      rows: [{ cell: unknown }],
    });
    try {
      const card = renderFeedbackCard(platformCard, policy, { result: 'conclusive_usable' }) as any;
      expect(card.body.elements[0].rows[0].cell).toEqual(unknown);
      const logs = stderr.mock.calls.map(([message]) => String(message)).join('');
      expect(logs).toContain('[WARN]');
      expect(logs).toContain('future_card_node');
      expect(logs).not.toContain('private answer content');
    } finally {
      stderr.mockRestore();
    }
  });

  it('renders adjacent emphasized runs without exposing markdown delimiters', () => {
    const platformCard = structuredClone(baseCard);
    platformCard.body.elements.unshift({
      tag: 'table', columns: [{ name: 'detail', data_type: 'markdown' }],
      rows: [{ detail: { tag: 'markdown', property: { elements: [
        { tag: 'plain_text', property: { content: 'first', textStyle: { attributes: ['bold'] } } },
        { tag: 'plain_text', property: { content: 'second', textStyle: { attributes: ['bold'] } } },
      ] } } }],
    });
    const card = renderFeedbackCard(platformCard, policy, { result: 'conclusive_usable' }) as any;
    expect(new MarkdownIt().renderInline(card.body.elements[0].rows[0].detail))
      .toBe('<strong>firstsecond</strong>');
  });

  it('preserves mixed adjacent emphasis transitions without literal stars', () => {
    const platformCard = structuredClone(baseCard);
    platformCard.body.elements.unshift({
      tag: 'table', columns: [{ name: 'detail', data_type: 'markdown' }],
      rows: [{ detail: { tag: 'markdown', property: { elements: [
        { tag: 'plain_text', property: { content: 'first', textStyle: { attributes: ['bold'] } } },
        { tag: 'plain_text', property: { content: 'second', textStyle: { attributes: ['bold', 'italic'] } } },
        { tag: 'plain_text', property: { content: 'third', textStyle: { attributes: ['italic'] } } },
      ] } } }],
    });
    const card = renderFeedbackCard(platformCard, policy, { result: 'conclusive_usable' }) as any;
    expect(new MarkdownIt().renderInline(card.body.elements[0].rows[0].detail))
      .toBe('<strong>first</strong><em><strong>second</strong></em><em>third</em>');
  });

  it.each([
    ['a', 'b', 'c'],
    ['A.', 'B', 'C'],
    ['A', '.B', 'C'],
    ['A', 'B.', 'C'],
    ['A', '前😀', '重点'],
  ])('preserves text and per-character emphasis for every adjacent style transition: %j', (...contents) => {
    const styles = [[], ['bold'], ['italic'], ['bold', 'italic']];
    const platformCard = structuredClone(baseCard);
    const cases = styles.flatMap(first => styles.flatMap(second => styles.map(third => [first, second, third])));
    platformCard.body.elements.unshift({
      tag: 'table', columns: [{ name: 'detail', data_type: 'markdown' }],
      rows: cases.map(attributes => ({ detail: { tag: 'markdown', property: {
        elements: attributes.map((style, index) => ({
          tag: 'plain_text', property: { content: contents[index], textStyle: { attributes: style } },
        })),
      } } })),
    });
    const card = renderFeedbackCard(platformCard, policy, { result: 'conclusive_usable' }) as any;
    const parser = new MarkdownIt();
    for (const [index, row] of card.body.elements[0].rows.entries()) {
      const tokens = parser.parseInline(row.detail, {})[0].children!;
      const actual: Array<{ character: string; bold: boolean; italic: boolean }> = [];
      let bold = 0;
      let italic = 0;
      for (const token of tokens) {
        if (token.type === 'strong_open') bold++;
        if (token.type === 'strong_close') bold--;
        if (token.type === 'em_open') italic++;
        if (token.type === 'em_close') italic--;
        if (token.type === 'text') {
          for (const character of token.content) actual.push({ character, bold: bold > 0, italic: italic > 0 });
        }
      }
      expect(actual).toEqual(cases[index].flatMap((style: string[], position: number) =>
        Array.from(contents[position]).map(character => ({
          character, bold: style.includes('bold'), italic: style.includes('italic'),
        }))));
      if (contents[0] === 'a' && !cases[index].some(style => style.includes('bold') && style.includes('italic'))) {
        expect(row.detail).not.toMatch(/&#\d+;/);
      }
    }
  });

  it.each([
    { attributes: ['bold'], expected: '共 **19 处** 受影响' },
    { attributes: ['italic'], expected: '共 *19 处* 受影响' },
  ])('keeps ordinary styled text readable without numeric references: %j', ({ attributes, expected }) => {
    const platformCard = structuredClone(baseCard);
    platformCard.body.elements.unshift({
      tag: 'table', columns: [{ name: 'detail', data_type: 'lark_md' }],
      rows: [{ detail: { tag: 'markdown', property: { elements: [
        { tag: 'plain_text', property: { content: '共 ' } },
        { tag: 'plain_text', property: { content: '19 处', textStyle: { attributes } } },
        { tag: 'plain_text', property: { content: ' 受影响' } },
      ] } } }],
    });
    const card = renderFeedbackCard(platformCard, policy, { result: 'conclusive_usable' }) as any;
    expect(card.body.elements[0].rows[0].detail).toBe(expected);
  });

  it.each([
    { content: 'A.', before: '', after: 'B' },
    { content: '19)', before: '', after: '处' },
    { content: '前😀', before: '', after: '重点' },
    { content: '.B', before: 'A', after: '' },
  ])('preserves emphasis across punctuation boundaries: %j', ({ content, before, after }) => {
    const platformCard = structuredClone(baseCard);
    platformCard.body.elements.unshift({
      tag: 'table', columns: [{ name: 'detail', data_type: 'markdown' }],
      rows: [['bold'], ['italic']].map(attributes => ({ detail: {
        tag: 'markdown', property: { elements: [
          { tag: 'plain_text', property: { content: before } },
          { tag: 'plain_text', property: { content, textStyle: { attributes } } },
          { tag: 'plain_text', property: { content: after } },
        ] },
      } })),
    });
    const card = renderFeedbackCard(platformCard, policy, { result: 'conclusive_usable' }) as any;
    for (const [index, row] of card.body.elements[0].rows.entries()) {
      expect(new MarkdownIt().renderInline(row.detail))
        .toBe(index === 0 ? `${before}<strong>${content}</strong>${after}` : `${before}<em>${content}</em>${after}`);
    }
  });

  it.each(['ol', 'ul'])('retains block-level lists embedded in item elements: %s', (type) => {
    const platformCard = structuredClone(baseCard);
    platformCard.body.elements.unshift({
      tag: 'table', columns: [{ name: 'detail', data_type: 'lark_md' }],
      rows: [{ detail: { tag: 'list', property: { items: [
        { elements: [
          { tag: 'plain_text', property: { content: 'parent' } },
          { tag: 'list', property: { items: [
            { elements: [{ tag: 'plain_text', property: { content: 'child' } }],
              level: 0, order: 4, type },
          ] } },
        ], level: 0, order: 1, type: 'ol' },
      ] } } }],
    });
    const card = renderFeedbackCard(platformCard, policy, { result: 'conclusive_usable' }) as any;
    const tokens = new MarkdownIt().parse(card.body.elements[0].rows[0].detail, {});
    expect(tokens.filter(token => token.type === 'list_item_open').map(token => token.level))
      .toEqual([1, 3]);
    expect(tokens.filter(token => token.type === 'inline').map(token => token.content))
      .toEqual(['parent', 'child']);
    if (type === 'ol') {
      expect(tokens.filter(token => token.type === 'ordered_list_open').map(token => token.attrGet('start')))
        .toEqual([null, 4]);
    }
  });

  it.each([
    { levels: [0, 2], order: 1, itemLevels: [1, 3] },
    { levels: [0, 2], order: 100, itemLevels: [1, 3] },
    { levels: [0, 2, 3, 1], order: 1, itemLevels: [1, 3, 5, 3] },
    { levels: [2, 4, 0], order: 1, itemLevels: [1, 3, 1] },
  ])('derives skipped list levels from existing ancestors: %j', ({ levels, order, itemLevels }) => {
    const platformCard = structuredClone(baseCard);
    platformCard.body.elements.unshift({
      tag: 'table', columns: [{ name: 'detail', data_type: 'markdown' }],
      rows: [{ detail: { tag: 'list', property: { items: levels.map((level, index) => ({
        elements: [{ tag: 'plain_text', property: { content: `item ${index}` } }],
        level, order, type: level === 0 || index === 0 ? 'ol' : 'ul',
      })) } } }],
    });
    const card = renderFeedbackCard(platformCard, policy, { result: 'conclusive_usable' }) as any;
    const tokens = new MarkdownIt().parse(card.body.elements[0].rows[0].detail, {});
    expect(tokens.filter(token => token.type === 'list_item_open').map(token => token.level))
      .toEqual(itemLevels);
    expect(tokens.filter(token => token.type === 'inline').map(token => token.content))
      .toEqual(levels.map((_, index) => `item ${index}`));
  });

  it('retains nested-list hierarchy below a three-digit ordered parent', () => {
    const platformCard = structuredClone(baseCard);
    platformCard.body.elements.unshift({
      tag: 'table', columns: [{ name: 'detail', data_type: 'markdown' }],
      rows: [{ detail: { tag: 'list', property: { items: [
        { elements: [{ tag: 'plain_text', property: { content: 'parent' } }],
          level: 0, order: 100, type: 'ol' },
        { elements: [{ tag: 'plain_text', property: { content: 'child' } }],
          level: 1, type: 'ul' },
      ] } } }],
    });
    const card = renderFeedbackCard(platformCard, policy, { result: 'conclusive_usable' }) as any;
    const tokens = new MarkdownIt().parse(card.body.elements[0].rows[0].detail, {});
    expect(tokens.find(token => token.type === 'ordered_list_open')?.attrGet('start')).toBe(100);
    expect(tokens.filter(token => token.type === 'bullet_list_open')).toHaveLength(1);
    expect(tokens.filter(token => token.type === 'list_item_open')).toHaveLength(2);
  });
});
