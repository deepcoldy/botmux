import { describe, expect, it } from 'vitest';
import {
  MAX_VEGA_LITE_ROWS,
  MAX_VEGA_LITE_SPEC_BYTES,
  convertVegaLiteFence,
  degradedVegaLiteElements,
} from '../src/im/lark/vega-lite-chart.js';

const rows = [{ d: '09-28', v: 18 }, { d: '09-29', v: 14 }];
const spec = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  title: '上账',
  data: { values: rows },
  mark: 'bar',
  encoding: { x: { field: 'd', type: 'ordinal' }, y: { field: 'v', type: 'quantitative' } },
  ...overrides,
});

describe('convertVegaLiteFence', () => {
  it('rebuilds a vertical bar chart as a VChart spec', () => {
    const result = convertVegaLiteFence(spec({ $schema: 'https://vega.github.io/schema/vega-lite/v5.json', description: 'x', width: 300 }));
    expect(result).toEqual({
      ok: true,
      title: '上账',
      element: {
        tag: 'chart',
        chart_spec: { type: 'bar', data: { values: rows }, title: { text: '上账' }, xField: 'd', yField: 'v' },
      },
    });
  });

  it('infers a horizontal bar when only x is quantitative', () => {
    const result = convertVegaLiteFence(spec({
      encoding: { x: { field: 'v', type: 'quantitative' }, y: { field: 'd', type: 'nominal' } },
    }));
    expect(result.ok && result.element.chart_spec).toMatchObject({ type: 'bar', direction: 'horizontal', xField: 'v', yField: 'd' });
  });

  it('maps line/area series, scatter and donut charts', () => {
    const series = [{ d: 'a', c: 'TH', v: 1 }, { d: 'a', c: 'MY', v: 2 }];
    const line = convertVegaLiteFence(JSON.stringify({
      data: { values: series }, mark: 'line',
      encoding: { x: { field: 'd' }, y: { field: 'v' }, color: { field: 'c' } },
    }));
    expect(line.ok && line.element.chart_spec).toMatchObject({ type: 'line', seriesField: 'c', legends: { visible: true } });
    const area = convertVegaLiteFence(spec({ mark: 'area' }));
    expect(area.ok && area.element.chart_spec).toMatchObject({ type: 'area' });
    const scatter = convertVegaLiteFence(spec({ mark: { type: 'point' } }));
    expect(scatter.ok && scatter.element.chart_spec).toMatchObject({ type: 'scatter' });
    const donut = convertVegaLiteFence(JSON.stringify({
      data: { values: [{ k: '扫码', n: 55 }, { k: '网关', n: 45 }] },
      mark: { type: 'arc', innerRadius: 40 },
      encoding: { theta: { field: 'n', type: 'quantitative' }, color: { field: 'k' } },
    }));
    expect(donut.ok && donut.element.chart_spec).toMatchObject({ type: 'pie', valueField: 'n', categoryField: 'k', innerRadius: 0.5 });
  });

  it('never forwards source fields it does not understand', () => {
    const result = convertVegaLiteFence(spec({ $schema: 'x', description: '内部说明', width: 999, height: 1 }));
    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result);
    for (const leaked of ['$schema', '内部说明', '999', 'description', 'width', 'height']) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it.each([
    ['remote data', spec({ data: { url: 'http://evil.example/x.json' } }), 'data_url_not_allowed'],
    ['named data', spec({ data: { name: 'x', values: rows } }), 'data_name_not_allowed'],
    ['transform', spec({ transform: [{ filter: 'datum.v > 1' }] }), 'transform_not_allowed'],
    ['params', spec({ params: [{ name: 'p', value: 1 }] }), 'params_not_allowed'],
    ['nested expression', spec({ mark: { type: 'bar', color: { expr: 'x' } } }), 'expression_not_allowed'],
    ['signal', spec({ encoding: { x: { field: 'd', signal: 's' }, y: { field: 'v' } } }), 'signal_not_allowed'],
    ['datasets', spec({ datasets: { a: rows } }), 'datasets_not_allowed'],
    ['layer', spec({ layer: [] }), 'layer_not_supported'],
    ['aggregate', spec({ encoding: { x: { field: 'd', aggregate: 'sum' }, y: { field: 'v' } } }), 'encoding_x_aggregate_not_supported'],
    ['unknown channel', spec({ encoding: { x: { field: 'd' }, y: { field: 'v' }, size: { field: 'v' } } }), 'encoding_size_not_supported'],
    ['missing field', spec({ encoding: { x: { field: 'nope' }, y: { field: 'v' } } }), 'encoding_x_field_missing'],
    ['unsupported mark', spec({ mark: 'rect' }), 'mark_rect_not_supported'],
    ['non-scalar value', spec({ data: { values: [{ d: 'a', v: [1] }] } }), 'data_value_invalid'],
    ['arc without color', spec({ mark: 'arc', encoding: { theta: { field: 'v' } } }), 'arc_requires_theta_and_color'],
    ['tooltip channel', spec({ encoding: { x: { field: 'd' }, y: { field: 'v' }, tooltip: { field: 'v' } } }), 'encoding_tooltip_not_supported'],
    ['theta title', JSON.stringify({ data: { values: rows }, mark: 'arc', encoding: { theta: { field: 'v', title: 't' }, color: { field: 'd' } } }), 'encoding_theta_title_not_supported'],
  ])('degrades %s', (_label, source, reason) => {
    expect(convertVegaLiteFence(source)).toMatchObject({ ok: false, reason });
  });

  it('maps channel titles to VChart axes and legend titles', () => {
    const result = convertVegaLiteFence(JSON.stringify({
      data: { values: [{ d: 'a', v: 1, c: 'TH' }] }, mark: 'line',
      encoding: { x: { field: 'd', title: '日期' }, y: { field: 'v', title: '金额' }, color: { field: 'c', title: '国家' } },
    }));
    expect(result.ok && result.element.chart_spec).toMatchObject({
      axes: [{ orient: 'bottom', title: { visible: true, text: '日期' } }, { orient: 'left', title: { visible: true, text: '金额' } }],
      legends: { visible: true, title: { visible: true, text: '国家' } },
    });
  });

  it('treats data columns named like forbidden keys as plain data', () => {
    const values = [{ url: '/home', params: 'a', expr: 'b', hits: 100 }];
    const result = convertVegaLiteFence(JSON.stringify({ data: { values }, mark: 'bar', encoding: { x: { field: 'url' }, y: { field: 'hits' } } }));
    expect(result.ok).toBe(true);
    // …while a forbidden key beside the rows is still caught.
    expect(convertVegaLiteFence(JSON.stringify({ data: { values, url: 'http://x' }, mark: 'bar' }))).toMatchObject({ ok: false, reason: 'data_url_not_allowed' });
  });

  it('keeps reason codes inert even when they quote the source', () => {
    const result = convertVegaLiteFence(spec({ mark: { type: "ba'r\n<X>" } }));
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toMatch(/^[A-Za-z0-9_$?-]+$/);
  });

  it('rejects invalid JSON, oversize specs and too many rows', () => {
    expect(convertVegaLiteFence('{not json')).toMatchObject({ ok: false, reason: 'spec_json_invalid' });
    expect(convertVegaLiteFence('[1]')).toMatchObject({ ok: false, reason: 'spec_json_invalid' });
    const big = spec({ description: 'x'.repeat(MAX_VEGA_LITE_SPEC_BYTES) });
    expect(convertVegaLiteFence(big)).toMatchObject({ ok: false, reason: 'spec_too_large' });
    const many = Array.from({ length: MAX_VEGA_LITE_ROWS + 1 }, (_, i) => ({ d: String(i), v: i }));
    const tooMany = convertVegaLiteFence(spec({ data: { values: many } }));
    expect(tooMany).toMatchObject({ ok: false, reason: 'too_many_data_points' });
    // The leading rows survive for the degraded table.
    expect(tooMany.ok === false && tooMany.rows?.length).toBe(50);
    expect(tooMany.ok === false && tooMany.totalRows).toBe(MAX_VEGA_LITE_ROWS + 1);
    // The notice reports the source row count even when shown at 10 rows.
    const notice = degradedVegaLiteElements(tooMany as Extract<typeof tooMany, { ok: false }>, 10).at(-1) as { content: string };
    expect(notice.content).toContain(`共 ${MAX_VEGA_LITE_ROWS + 1} 行，仅展示前 10 行`);
  });

  it('keeps readable inline rows for the degraded table, but none for remote-only data', () => {
    const withRows = convertVegaLiteFence(spec({ transform: [] }));
    expect(withRows).toMatchObject({ ok: false, rows });
    const remote = convertVegaLiteFence(spec({ data: { url: 'http://x' } }));
    expect(remote.ok === false && remote.rows).toBeUndefined();
  });
});

describe('degradedVegaLiteElements', () => {
  it('renders data as a plain-text table and escapes the notice', () => {
    const elements = degradedVegaLiteElements({
      ok: false,
      reason: 'transform_not_allowed',
      title: '标题 <at id=all></at> [x](http://e)',
      rows: [{ name: '[点我领奖](http://evil.example)', v: 1 }],
    });
    const notice = elements[0] as { content: string };
    expect(notice.content).not.toContain('<at');
    expect(notice.content).not.toContain('[x](http://e)');
    const table = elements[1] as { tag: string; columns: Array<{ data_type: string }>; rows: Array<Record<string, string>> };
    expect(table.tag).toBe('table');
    expect(table.columns.every(column => column.data_type === 'text')).toBe(true);
    expect(table.rows[0]).toEqual({ c0: '[点我领奖](http://evil.example)', c1: '1' });
  });

  it('caps the degraded table and says so', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ i }));
    const elements = degradedVegaLiteElements({ ok: false, reason: 'transform_not_allowed', rows: many });
    expect((elements[1] as { rows: unknown[] }).rows).toHaveLength(50);
    expect((elements[2] as { content: string }).content).toContain('共 60 行');
  });

  it('emits only the notice when no rows are available', () => {
    expect(degradedVegaLiteElements({ ok: false, reason: 'data_url_not_allowed' })).toHaveLength(1);
  });
});
