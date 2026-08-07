/** Responsive horizontal layout for the interactive `botmux list` picker. */

export type SessionPickerColumnKey =
  | 'id'
  | 'bot'
  | 'title'
  | 'dir'
  | 'pid'
  | 'uptime'
  | 'status'
  | 'target';

export interface SessionPickerColumn {
  key: SessionPickerColumnKey;
  width: number;
}

export interface SessionPickerLayout {
  /** Actual terminal width used to build this layout. */
  termWidth: number;
  /** Width reserved for the row/header prefix (`  ❯ ` in normal terminals). */
  prefixWidth: number;
  /** Ordered visible columns. */
  columns: SessionPickerColumn[];
}

interface CompactColumnSpec {
  key: SessionPickerColumnKey;
  min: number;
  preferred: number;
}

const SEPARATOR_WIDTH = 3; // " │ "

const COMPACT_SPECS: CompactColumnSpec[] = [
  { key: 'id', min: 10, preferred: 10 },
  { key: 'bot', min: 8, preferred: 12 },
  { key: 'title', min: 6, preferred: 20 },
  { key: 'dir', min: 8, preferred: 20 },
  { key: 'pid', min: 5, preferred: 8 },
  { key: 'uptime', min: 6, preferred: 7 },
  { key: 'status', min: 6, preferred: 7 },
  { key: 'target', min: 10, preferred: 16 },
];

/** Lower-value columns are removed in this order when even compact widths do not fit. */
const COMPACT_DROP_ORDER: SessionPickerColumnKey[] = [
  'target',
  'pid',
  'uptime',
  'dir',
  'status',
];

/** Extra room goes first to the columns whose truncation costs the most context. */
const COMPACT_GROW_ORDER: SessionPickerColumnKey[] = [
  'title',
  'dir',
  'target',
  'bot',
  'id',
  'pid',
  'uptime',
  'status',
];

function occupiedWidth(prefixWidth: number, columns: readonly SessionPickerColumn[]): number {
  const separators = Math.max(0, columns.length - 1) * SEPARATOR_WIDTH;
  return prefixWidth + separators + columns.reduce((sum, column) => sum + column.width, 0);
}

/** Total physical width of a rendered header/session line. Exported for invariants/tests. */
export function sessionPickerLayoutWidth(layout: SessionPickerLayout): number {
  return occupiedWidth(layout.prefixWidth, layout.columns);
}

/**
 * Compute a one-physical-line layout for the current terminal width.
 *
 * Wide terminals preserve the picker's historical column widths byte-for-byte.
 * Narrow terminals first shrink columns, then progressively hide lower-value
 * columns. At every width the returned prefix + columns + separators is no
 * wider than the terminal, so vertical viewport accounting remains truthful.
 */
export function computeSessionPickerLayout(rawTermWidth: number, multiBot: boolean): SessionPickerLayout {
  const termWidth = Number.isFinite(rawTermWidth) && rawTermWidth > 0
    ? Math.floor(rawTermWidth)
    : 100;
  const prefixWidth = Math.min(4, termWidth);

  // Preserve the existing wide layout exactly. Its fixed portion includes the
  // normal four-column prefix; the remaining >=20 columns are split title/dir.
  const fixedCols = { id: 10, pid: 8, uptime: 7, status: 7, target: 26 };
  const botWidth = multiBot ? 18 : 0;
  const columnCount = multiBot ? 8 : 7;
  const fixedTotal = 4
    + fixedCols.id
    + botWidth
    + fixedCols.pid
    + fixedCols.uptime
    + fixedCols.status
    + fixedCols.target
    + (columnCount - 1) * SEPARATOR_WIDTH;
  if (termWidth >= fixedTotal + 20) {
    const flexTotal = termWidth - fixedTotal;
    const titleWidth = Math.floor(flexTotal * 0.4);
    const dirWidth = flexTotal - titleWidth;
    return {
      termWidth,
      prefixWidth: 4,
      columns: [
        { key: 'id', width: fixedCols.id },
        ...(multiBot ? [{ key: 'bot' as const, width: botWidth }] : []),
        { key: 'title', width: titleWidth },
        { key: 'dir', width: dirWidth },
        { key: 'pid', width: fixedCols.pid },
        { key: 'uptime', width: fixedCols.uptime },
        { key: 'status', width: fixedCols.status },
        { key: 'target', width: fixedCols.target },
      ],
    };
  }

  let specs = COMPACT_SPECS.filter(spec => multiBot || spec.key !== 'bot');
  const asMinimumColumns = (): SessionPickerColumn[] => specs.map(spec => ({
    key: spec.key,
    width: spec.min,
  }));

  for (const key of COMPACT_DROP_ORDER) {
    if (occupiedWidth(prefixWidth, asMinimumColumns()) <= termWidth) break;
    specs = specs.filter(spec => spec.key !== key);
  }

  let columns = asMinimumColumns();
  if (occupiedWidth(prefixWidth, columns) > termWidth) {
    // Ultra-narrow fallback: the title alone is still navigable via the pinned
    // position counter. This also handles widths smaller than the normal prefix.
    const titleWidth = Math.max(0, termWidth - prefixWidth);
    columns = titleWidth > 0 ? [{ key: 'title', width: titleWidth }] : [];
    return { termWidth, prefixWidth, columns };
  }

  let remaining = termWidth - occupiedWidth(prefixWidth, columns);
  for (const key of COMPACT_GROW_ORDER) {
    if (remaining <= 0) break;
    const column = columns.find(candidate => candidate.key === key);
    const spec = specs.find(candidate => candidate.key === key);
    if (!column || !spec) continue;
    const growth = Math.min(remaining, spec.preferred - column.width);
    column.width += growth;
    remaining -= growth;
  }

  // Compact layouts occupy the whole row. Any room beyond preferred widths is
  // useful for the title (or, in the defensive no-title case, the last column).
  if (remaining > 0 && columns.length > 0) {
    const flexible = columns.find(column => column.key === 'title') ?? columns[columns.length - 1];
    flexible.width += remaining;
  }

  return { termWidth, prefixWidth, columns };
}
