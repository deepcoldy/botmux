/**
 * ```vega-lite fences → Feishu Card 2.0 `chart` elements.
 *
 * Markdown is the portable carrier: a Web surface can hand the same fence to
 * vega-embed, while Feishu has no Vega runtime and instead renders VChart
 * specs through the native `chart` component. This module accepts a small,
 * explicit Vega-Lite subset and *rebuilds* a VChart spec from the recognised
 * fields. Nothing from the source JSON is forwarded verbatim, so expressions,
 * signals, remote data or unknown VChart options cannot reach the card even
 * if a future validator rule were missing.
 *
 * Anything outside the subset degrades to a one-line notice plus a plain-text
 * table of the inline data, so the numbers are never lost and the raw spec is
 * never shown to the reader.
 */

import { TABLE_AUTO_ROW_STYLE } from './table-style.js';

export const VEGA_LITE_FENCE_LANGS = new Set(['vega-lite', 'vegalite']);

/** Parse-time ceiling for one fence. This only bounds parsing work — the
 * real delivery limit is Feishu's 30KB card request body, enforced after the
 * whole card is assembled (see `fitChartsToCardBudget` in md-card.ts). */
export const MAX_VEGA_LITE_SPEC_BYTES = 30 * 1024;
export const MAX_VEGA_LITE_ROWS = 500;
const MAX_FIELDS_PER_ROW = 20;
const MAX_TITLE_CHARS = 100;
const MAX_FIELD_NAME_CHARS = 128;
export const DEGRADED_TABLE_MAX_ROWS = 50;
const DEGRADED_TABLE_MAX_COLUMNS = 20;
const DEGRADED_CELL_MAX_CHARS = 200;

export interface CardRenderDiagnostic {
  kind: 'chart_degraded';
  /** Stable machine-readable reason, e.g. `data_url_not_allowed`. */
  reason: string;
  /** Chart title when one could be read, for human-facing warnings. */
  title?: string;
}

type Scalar = string | number | boolean | null;
type Row = Record<string, Scalar>;

export type VegaLiteConversion =
  | { ok: true; element: Record<string, unknown>; title?: string }
  | { ok: false; reason: string; title?: string; rows?: Row[]; totalRows?: number };

const TOP_LEVEL_KEYS = new Set(['$schema', 'title', 'description', 'data', 'mark', 'encoding', 'width', 'height']);
const ENCODING_CHANNELS = new Set(['x', 'y', 'color', 'theta']);
const CHANNEL_KEYS = new Set(['field', 'type', 'title']);
const FIELD_TYPES = new Set(['nominal', 'ordinal', 'quantitative', 'temporal']);
/** Keys whose presence anywhere means the spec relies on Vega runtime
 * behaviour we deliberately do not emulate (or must never fetch). */
const FORBIDDEN_DEEP_KEYS: Record<string, string> = {
  url: 'data_url_not_allowed',
  expr: 'expression_not_allowed',
  signal: 'signal_not_allowed',
  params: 'params_not_allowed',
  transform: 'transform_not_allowed',
  datasets: 'datasets_not_allowed',
};

class Unsupported extends Error {
  constructor(readonly reason: string, readonly rows?: Row[], readonly totalRows?: number) { super(reason); }
}

/** Reason codes embed fragments of the source JSON (keys, mark names). Keep
 * them to an inert identifier alphabet so a notice can never be broken up by
 * newlines, quotes or markup. */
function fragment(value: string): string {
  return value.replace(/[^A-Za-z0-9_$-]/g, '?').slice(0, 32) || '?';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Scan everything except the data rows themselves: a column that happens
 * to be called `url` or `params` is data, and rows are already restricted to
 * plain scalars by `readRows`. */
function findForbiddenSpecKey(spec: Record<string, unknown>): string | undefined {
  const data = isPlainObject(spec.data)
    ? Object.fromEntries(Object.entries(spec.data).filter(([key]) => key !== 'values'))
    : spec.data;
  return findForbiddenKey({ ...spec, data });
}

function findForbiddenKey(value: unknown, depth = 0): string | undefined {
  if (depth > 20) return 'spec_too_deep';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenKey(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isPlainObject(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (Object.hasOwn(FORBIDDEN_DEEP_KEYS, key)) return FORBIDDEN_DEEP_KEYS[key];
    const found = findForbiddenKey(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function readTitle(value: unknown): string | undefined {
  const raw = typeof value === 'string'
    ? value
    : isPlainObject(value) && typeof value.text === 'string' ? value.text : undefined;
  const text = raw?.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
  return text ? text.slice(0, MAX_TITLE_CHARS) : undefined;
}

function readRows(data: unknown): Row[] {
  if (!isPlainObject(data)) throw new Unsupported('data_values_required');
  for (const key of Object.keys(data)) {
    if (key !== 'values') throw new Unsupported(`data_${fragment(key)}_not_allowed`);
  }
  if (!Array.isArray(data.values) || data.values.length === 0) throw new Unsupported('data_values_required');
  if (data.values.length > MAX_VEGA_LITE_ROWS) {
    // Too many points to chart, but the leading rows are still worth showing.
    let head: Row[] | undefined;
    try { head = parseRows(data.values.slice(0, DEGRADED_TABLE_MAX_ROWS)); } catch { head = undefined; }
    throw new Unsupported('too_many_data_points', head, data.values.length);
  }
  return parseRows(data.values);
}

function parseRows(values: unknown[]): Row[] {
  return values.map(row => {
    if (!isPlainObject(row)) throw new Unsupported('data_row_invalid');
    const entries = Object.entries(row);
    if (entries.length > MAX_FIELDS_PER_ROW) throw new Unsupported('too_many_fields');
    const out: Row = {};
    for (const [key, value] of entries) {
      if (!key || key.length > MAX_FIELD_NAME_CHARS || key === '__proto__') throw new Unsupported('data_field_invalid');
      if (value !== null && typeof value !== 'string' && typeof value !== 'boolean'
        && !(typeof value === 'number' && Number.isFinite(value))) {
        throw new Unsupported('data_value_invalid');
      }
      out[key] = value as Scalar;
    }
    return out;
  });
}

interface Channel { field: string; type?: string; title?: string }

function readChannel(value: unknown, name: string, rows: Row[]): Channel {
  if (!isPlainObject(value)) throw new Unsupported(`encoding_${name}_invalid`);
  for (const key of Object.keys(value)) {
    if (!CHANNEL_KEYS.has(key)) throw new Unsupported(`encoding_${name}_${fragment(key)}_not_supported`);
  }
  if (typeof value.field !== 'string' || !value.field) throw new Unsupported(`encoding_${name}_field_required`);
  if (!rows.some(row => Object.hasOwn(row, value.field as string))) throw new Unsupported(`encoding_${name}_field_missing`);
  if (value.type !== undefined && (typeof value.type !== 'string' || !FIELD_TYPES.has(value.type))) {
    throw new Unsupported(`encoding_${name}_type_invalid`);
  }
  if (value.title !== undefined && typeof value.title !== 'string') throw new Unsupported(`encoding_${name}_title_invalid`);
  const title = readTitle(value.title);
  return {
    field: value.field,
    ...(typeof value.type === 'string' ? { type: value.type } : {}),
    ...(title ? { title } : {}),
  };
}

function readMark(value: unknown): { type: string; donut: boolean } {
  if (typeof value === 'string') return { type: value, donut: false };
  if (isPlainObject(value) && typeof value.type === 'string') {
    const inner = value.innerRadius;
    return { type: value.type, donut: typeof inner === 'number' && inner > 0 };
  }
  throw new Unsupported('mark_required');
}

function isQuantitative(channel: Channel, rows: Row[]): boolean {
  if (channel.type) return channel.type === 'quantitative';
  return rows.every(row => row[channel.field] === null || typeof row[channel.field] === 'number');
}

function buildChartSpec(spec: Record<string, unknown>, rows: Row[], title: string | undefined): Record<string, unknown> {
  const mark = readMark(spec.mark);
  if (!isPlainObject(spec.encoding)) throw new Unsupported('encoding_required');
  for (const key of Object.keys(spec.encoding)) {
    if (!ENCODING_CHANNELS.has(key)) throw new Unsupported(`encoding_${fragment(key)}_not_supported`);
  }
  const channel = (name: string): Channel | undefined => {
    const value = (spec.encoding as Record<string, unknown>)[name];
    return value === undefined ? undefined : readChannel(value, name, rows);
  };
  const x = channel('x');
  const y = channel('y');
  const color = channel('color');
  const theta = channel('theta');
  const base: Record<string, unknown> = {
    data: { values: rows },
    ...(title ? { title: { text: title } } : {}),
  };
  const legendSpec = (channel: Channel | undefined) => ({
    visible: true,
    ...(channel?.title ? { title: { visible: true, text: channel.title } } : {}),
  });
  const legend = color ? { legends: legendSpec(color) } : {};
  // Axis titles: x is always the bottom axis and y the left one in VChart,
  // including horizontal bars (value on x, category on y).
  const axisTitles = (xChannel: Channel, yChannel: Channel) => {
    const axes = [
      ...(xChannel.title ? [{ orient: 'bottom', title: { visible: true, text: xChannel.title } }] : []),
      ...(yChannel.title ? [{ orient: 'left', title: { visible: true, text: yChannel.title } }] : []),
    ];
    return axes.length > 0 ? { axes } : {};
  };

  if (mark.type === 'arc') {
    if (!theta || !color) throw new Unsupported('arc_requires_theta_and_color');
    if (x || y) throw new Unsupported('arc_does_not_take_x_or_y');
    if (theta.title) throw new Unsupported('encoding_theta_title_not_supported');
    return {
      type: 'pie',
      ...base,
      valueField: theta.field,
      categoryField: color.field,
      ...(mark.donut ? { innerRadius: 0.5 } : {}),
      legends: legendSpec(color),
    };
  }
  if (!x || !y) throw new Unsupported('x_and_y_required');
  if (theta) throw new Unsupported('encoding_theta_not_supported');
  const series = color ? { seriesField: color.field } : {};
  switch (mark.type) {
    case 'bar': {
      // Vega-Lite infers orientation from which axis is quantitative.
      const horizontal = isQuantitative(x, rows) && !isQuantitative(y, rows);
      return {
        type: 'bar',
        ...base,
        ...(horizontal ? { direction: 'horizontal' } : {}),
        xField: x.field,
        yField: y.field,
        ...series,
        ...legend,
        ...axisTitles(x, y),
      };
    }
    case 'line':
    case 'area':
      return { type: mark.type, ...base, xField: x.field, yField: y.field, ...series, ...legend, ...axisTitles(x, y) };
    case 'point':
    case 'circle':
      return { type: 'scatter', ...base, xField: x.field, yField: y.field, ...series, ...legend, ...axisTitles(x, y) };
    default:
      throw new Unsupported(`mark_${fragment(mark.type)}_not_supported`);
  }
}

/** Convert one fence body. Never throws. */
export function convertVegaLiteFence(source: string): VegaLiteConversion {
  if (Buffer.byteLength(source, 'utf8') > MAX_VEGA_LITE_SPEC_BYTES) return { ok: false, reason: 'spec_too_large' };
  let spec: unknown;
  try { spec = JSON.parse(source); } catch { return { ok: false, reason: 'spec_json_invalid' }; }
  if (!isPlainObject(spec)) return { ok: false, reason: 'spec_json_invalid' };
  const title = readTitle(spec.title);
  let rows: Row[] | undefined;
  let totalRows: number | undefined;
  try {
    const forbidden = findForbiddenSpecKey(spec);
    if (forbidden) {
      // Keep inline rows for the degraded table only when they are plainly
      // readable; a spec that also points at remote data yields none.
      try { rows = readRows(spec.data); } catch (rowError) {
        rows = rowError instanceof Unsupported ? rowError.rows : undefined;
        totalRows = rowError instanceof Unsupported ? rowError.totalRows : undefined;
      }
      throw new Unsupported(forbidden);
    }
    for (const key of Object.keys(spec)) {
      if (!TOP_LEVEL_KEYS.has(key)) throw new Unsupported(`${fragment(key)}_not_supported`);
    }
    rows = readRows(spec.data);
    const chartSpec = buildChartSpec(spec, rows, title);
    return { ok: true, element: { tag: 'chart', chart_spec: chartSpec }, ...(title ? { title } : {}) };
  } catch (error) {
    const reason = error instanceof Unsupported ? error.reason : 'spec_invalid';
    const kept = rows ?? (error instanceof Unsupported ? error.rows : undefined);
    const total = totalRows ?? (error instanceof Unsupported ? error.totalRows : undefined);
    return {
      ok: false,
      reason,
      ...(title ? { title } : {}),
      ...(kept ? { rows: kept } : {}),
      ...(kept && total !== undefined ? { totalRows: total } : {}),
    };
  }
}

function plainCell(value: Scalar | undefined): string {
  if (value === null || value === undefined) return '—';
  const text = String(value).replace(/[\u0000-\u001F\u007F]+/g, ' ');
  return text.length > DEGRADED_CELL_MAX_CHARS ? `${text.slice(0, DEGRADED_CELL_MAX_CHARS - 1)}…` : text;
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_~`[\]\\|#])/g, '\\$1');
}

/** Degraded rendering: a one-line notice, then the inline data as a native
 * table whose cells are `text` (not `lark_md`), so chart data can never turn
 * into links, mentions or formatting. */
export function degradedVegaLiteElements(
  result: Extract<VegaLiteConversion, { ok: false }>,
  maxRows = DEGRADED_TABLE_MAX_ROWS,
): Record<string, unknown>[] {
  const label = result.title ? `图表「${escapeMarkdownText(result.title)}」` : '图表';
  const elements: Record<string, unknown>[] = [{
    tag: 'markdown',
    content: `<font color='grey'>（${label}无法在飞书渲染：${escapeMarkdownText(result.reason)}${result.rows?.length ? '，以下为原始数据' : ''}）</font>`,
  }];
  const rows = maxRows > 0 ? result.rows ?? [] : [];
  if (rows.length === 0) return elements;
  const keys = [...new Set(rows.flatMap(row => Object.keys(row)))].slice(0, DEGRADED_TABLE_MAX_COLUMNS);
  const visible = rows.slice(0, Math.min(maxRows, DEGRADED_TABLE_MAX_ROWS));
  elements.push({
    tag: 'table',
    page_size: Math.min(10, Math.max(1, visible.length)),
    ...TABLE_AUTO_ROW_STYLE,
    columns: keys.map((key, index) => ({
      name: `c${index}`,
      display_name: plainCell(key) || ' ',
      data_type: 'text',
      width: 'auto',
    })),
    rows: visible.map(row => Object.fromEntries(keys.map((key, index) => [`c${index}`, plainCell(row[key])]))),
  });
  // Report the source row count, not the rows we happened to keep.
  const total = Math.max(result.totalRows ?? 0, rows.length);
  if (total > visible.length) {
    elements.push({ tag: 'markdown', content: `<font color='grey'>共 ${total} 行，仅展示前 ${visible.length} 行。</font>` });
  }
  return elements;
}
