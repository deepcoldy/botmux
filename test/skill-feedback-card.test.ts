import { describe, expect, it } from 'vitest';
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
});
