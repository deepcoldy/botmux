import { describe, expect, it } from 'vitest';
import {
  buildCanonicalFinalReplyCard,
  buildCardBodyElements,
  buildContextualReplyCard,
  buildImageCardElements,
  buildMarkdownCard,
  createReplyCard,
  fitChartsToCardBudget,
  type CardRenderDiagnostic,
} from '../src/im/lark/md-card.js';
import { TURN_REPLY_CARD_MAX_BYTES, turnReplyCardRequestBytes } from '../src/im/lark/turn-reply-card-size.js';
import { attachOncallGroupButton } from '../src/im/lark/oncall-group.js';

const chart = (title: string, values: unknown[] = [{ d: 'a', v: 1 }, { d: 'b', v: 2 }]) => [
  '```vega-lite',
  JSON.stringify({ title, data: { values }, mark: 'bar', encoding: { x: { field: 'd' }, y: { field: 'v' } } }),
  '```',
].join('\n');

describe('buildCardBodyElements · vega-lite fences', () => {
  it('turns a fence into a native chart between the surrounding prose', () => {
    const elements = buildCardBodyElements(`前言\n\n${chart('A')}\n\n结语`, '/', 'disabled');
    expect(elements.map(element => element.tag)).toEqual(['markdown', 'chart', 'markdown']);
    expect(elements[1].chart_spec).toMatchObject({ type: 'bar', title: { text: 'A' } });
  });

  it('also accepts the `vegalite` info string', () => {
    const elements = buildCardBodyElements(chart('A').replace('vega-lite', 'vegalite'), '/', 'disabled');
    expect(elements[0].tag).toBe('chart');
  });

  it('leaves ordinary code fences untouched', () => {
    const elements = buildCardBodyElements('```json\n{"mark":"bar"}\n```', '/', 'disabled');
    expect(elements).toEqual([{ tag: 'markdown', content: '```json\n{"mark":"bar"}\n```' }]);
  });

  it('degrades a rejected spec, never echoing it, and reports why', () => {
    const diagnostics: CardRenderDiagnostic[] = [];
    const source = '```vega-lite\n{"title":"远程","data":{"url":"http://evil.example/x.json"},"mark":"bar"}\n```';
    const elements = buildCardBodyElements(source, '/', 'disabled', undefined, diagnostics);
    expect(JSON.stringify(elements)).not.toContain('evil.example');
    expect(elements.map(element => element.tag)).toEqual(['markdown']);
    expect(diagnostics).toEqual([{ kind: 'chart_degraded', reason: 'data_url_not_allowed', title: '远程' }]);
  });

  it('degrades charts beyond five per card', () => {
    const diagnostics: CardRenderDiagnostic[] = [];
    const source = Array.from({ length: 6 }, (_, i) => chart(`C${i}`)).join('\n\n');
    const elements = buildCardBodyElements(source, '/', 'disabled', undefined, diagnostics);
    expect(elements.filter(element => element.tag === 'chart')).toHaveLength(5);
    expect(diagnostics).toEqual([{ kind: 'chart_degraded', reason: 'too_many_charts', title: 'C5' }]);
    // The sixth chart's data survives as a table.
    expect(elements.at(-1)?.tag).toBe('table');
  });

  it('fits every card builder under the 30KB request limit, degrading charts step by step', () => {
    // Deterministic pseudo-random specs: many rows, long labels, quotes and
    // backslashes (double-escaped in the request body), several fences, and
    // fences that degrade on their own.
    let seed = 42;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const label = (n: number) => `标签"\\${'x'.repeat(Math.floor(rand() * 40))}-${n}`;
    for (let trial = 0; trial < 40; trial++) {
      const fences = Array.from({ length: 1 + Math.floor(rand() * 6) }, (_, f) => {
        const count = 1 + Math.floor(rand() * 520);
        const values = Array.from({ length: count }, (_, i) => ({ d: label(i), v: i, c: rand() > 0.5 ? 'A' : 'B' }));
        const mark = rand() > 0.8 ? 'rect' : 'bar';
        return ['```vega-lite', JSON.stringify({ title: `T${trial}-${f}`, data: { values }, mark, encoding: { x: { field: 'd' }, y: { field: 'v' }, color: { field: 'c' } } }), '```'].join('\n');
      }).filter(fence => Buffer.byteLength(fence) < 30 * 1024);
      const markdown = `## 报表 ${trial}\n\n${fences.join('\n\n')}`;
      for (const json of [
        buildMarkdownCard(markdown, 'ou_x', undefined, 'zh', '/', 'disabled'),
        buildCanonicalFinalReplyCard({ markdown, workingDir: '/', localHomeLinkMode: 'disabled' }),
        buildContextualReplyCard({ title: 't', assistantText: markdown, assistantLabel: 'bot', workingDir: '/', localHomeLinkMode: 'disabled' }),
      ]) {
        expect(turnReplyCardRequestBytes(json, `oc_${'0'.repeat(32)}`)).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
      }
    }
  });

  it('stays under 30KB after the daemon attaches the on-call button', () => {
    // Reachable input from review: two ~366-row charts whose labels carry
    // quotes and CJK, fitted inside the builder and then decorated.
    const chatId = `oc_${'a'.repeat(32)}`;
    const policy = { enabled: true, chatIds: [chatId] };
    for (const rowsPerChart of [300, 340, 366, 380]) {
      const values = Array.from({ length: rowsPerChart }, (_, i) => ({ d: `标签"${i}"`, v: i }));
      const markdown = [chart('A', values), chart('B', values)].join('\n\n');
      for (const built of [
        buildCanonicalFinalReplyCard({ markdown, workingDir: '/', localHomeLinkMode: 'disabled' }),
        buildContextualReplyCard({ title: 't', assistantText: markdown, assistantLabel: 'bot', workingDir: '/', localHomeLinkMode: 'disabled' }),
      ]) {
        const decorated = attachOncallGroupButton(built, policy, chatId, 'group');
        expect(decorated).not.toBe(built);
        expect(turnReplyCardRequestBytes(decorated, chatId)).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
      }
    }
  });

  it('keeps small charts intact and reports charts it had to shrink', () => {
    const small = buildMarkdownCard(chart('S'), undefined, '', 'zh', '/', 'disabled');
    expect(JSON.parse(small).body.elements.some((element: { tag: string }) => element.tag === 'chart')).toBe(true);
    const bulky = Array.from({ length: 480 }, (_, i) => ({ d: `day-${i}-${'"\\'.repeat(8)}`, v: i }));
    const card = createReplyCard(buildCardBodyElements(chart('Big', bulky), '/', 'disabled'));
    const diagnostics: CardRenderDiagnostic[] = [];
    const result = fitChartsToCardBudget(card, { diagnostics });
    expect(result.fits).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
    expect(card.body.elements.some((element: { tag: string }) => element.tag === 'chart')).toBe(false);
    // The data survives as a table.
    expect(card.body.elements.some((element: { tag: string }) => element.tag === 'table')).toBe(true);
    expect(diagnostics).toEqual([{ kind: 'chart_degraded', reason: 'card_budget_exceeded', title: 'Big' }]);
  });

  it('keeps shrinking degraded tables down to the notice when even 50 rows do not fit', () => {
    const wide = Array.from({ length: 50 }, (_, i) => Object.fromEntries(
      Array.from({ length: 10 }, (_, c) => [`col${c}`, `${i}-${'宽'.repeat(12)}`]),
    ));
    const fence = ['```vega-lite', JSON.stringify({ title: 'W', data: { values: wide }, mark: 'rect' }), '```'].join('\n');
    expect(Buffer.byteLength(fence)).toBeLessThan(30 * 1024);
    const card = createReplyCard(buildCardBodyElements(`${fence}\n\n${fence}`, '/', 'disabled'));
    const result = fitChartsToCardBudget(card);
    expect(result.fits).toBe(true);
    const tables = card.body.elements.filter((element: { tag: string }) => element.tag === 'table');
    // Two 50-row tables of this width cannot both fit in 30KB, so the pass
    // must have taken at least one fence past stage 1.
    expect(tables.some((table: { rows: unknown[] }) => table.rows.length <= 10)).toBe(true);
  });

  it('never touches elements that did not come from a chart fence', () => {
    const table = `| a |\n| - |\n${Array.from({ length: 800 }, (_, i) => `| ${'x'.repeat(40)}${i} |`).join('\n')}`;
    const card = createReplyCard(buildCardBodyElements(table, '/', 'disabled'));
    const before = JSON.stringify(card);
    expect(fitChartsToCardBudget(card).fits).toBe(false);
    expect(JSON.stringify(card)).toBe(before);
  });

  it('threads diagnostics through the image-aware entry used by botmux send', () => {
    const diagnostics: CardRenderDiagnostic[] = [];
    buildImageCardElements('```vega-lite\n{bad\n```', [], '/', 'disabled', undefined, diagnostics);
    buildImageCardElements('![](img:0)\n\n```vega-lite\n[1]\n```', ['img_v3_key'], '/', 'disabled', undefined, diagnostics);
    expect(diagnostics).toEqual([
      { kind: 'chart_degraded', reason: 'spec_json_invalid' },
      { kind: 'chart_degraded', reason: 'spec_json_invalid' },
    ]);
  });
});
