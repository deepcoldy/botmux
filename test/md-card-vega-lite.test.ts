import { describe, expect, it } from 'vitest';
import { buildCardBodyElements, buildImageCardElements, type CardRenderDiagnostic } from '../src/im/lark/md-card.js';

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

  it('degrades charts once their combined size exceeds the card budget', () => {
    const diagnostics: CardRenderDiagnostic[] = [];
    const bulky = Array.from({ length: 400 }, (_, i) => ({ d: `day-${i}-${'x'.repeat(40)}`, v: i }));
    const source = [chart('B0', bulky), chart('B1', bulky), chart('B2', bulky)].join('\n\n');
    const elements = buildCardBodyElements(source, '/', 'disabled', undefined, diagnostics);
    expect(elements.filter(element => element.tag === 'chart').length).toBeLessThan(3);
    expect(diagnostics.map(item => item.reason)).toContain('chart_budget_exceeded');
    expect(Buffer.byteLength(JSON.stringify(elements.filter(element => element.tag === 'chart')))).toBeLessThanOrEqual(60 * 1024);
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
