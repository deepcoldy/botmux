import { describe, expect, it } from 'vitest';
import { buildSessionItems } from '../src/dashboard/web/command-palette-sources.js';
import { excerptMatchRanges, focusExcerpt, searchPalette, splitHighlights, type PaletteItem } from '../src/dashboard/web/command-palette-model.js';
import { contentMatchesForQuery, type ContentSearchMatch } from '../src/dashboard/web/store.js';
import { groupWorkbenchSessionsForDimension } from '../src/dashboard/web/agent-workbench-model.js';

function matches(entries: Array<[string, number, string]>): ReadonlyMap<string, ContentSearchMatch> {
  return new Map(entries.map(([id, rank, snippet]) => [id, { rank, snippet, time: 1000 }]));
}
function itemKeys(result: ReturnType<typeof searchPalette>) {
  return result.rows.flatMap(row => row.type === 'item' ? [row.item.key] : []);
}
const rows = [
  { sessionId: 'meta', status: 'working', title: '风险方案', lastMessageAt: 4000 },
  { sessionId: 'content-a', status: 'idle', title: '数据库迁移', lastMessageAt: 3000 },
  { sessionId: 'content-b', status: 'closed', title: '发布流程', lastMessageAt: 1000 },
];

describe('content hits in palette and Workbench models', () => {
  it('ranks metadata matches first, then content-only sessions by server rank and counts each session once', () => {
    const content = matches([['content-a', 2, '风险来自这里'], ['content-b', 0, '风险来自那里'], ['meta', 1, '风险双重命中']]);
    const items = buildSessionItems(rows, 5000, undefined, content);
    const result = searchPalette({ items, query: '风险', scope: 'session', contentMatches: content });
    expect(itemKeys(result)).toEqual(['session:meta', 'session:content-b', 'session:content-a']);
    expect(result.counts.session).toBe(3); expect(result.counts.all).toBe(3);
    expect(items.find(item => item.key === 'session:meta')?.excerpt).toBe('风险双重命中');
  });

  it('preserves metadata ordering/counts and the empty start panel without eligible content matches', () => {
    const original = buildSessionItems(rows, 5000);
    const empty = new Map<string, ContentSearchMatch>();
    const current = buildSessionItems(rows, 5000, undefined, empty);
    for (const query of ['', '风险', '迁移']) {
      const before = searchPalette({ items: original, query, scope: 'all' });
      expect(searchPalette({ items: current, query, scope: 'all', contentMatches: empty })).toEqual(before);
    }
    expect(current.every(item => item.excerpt === undefined)).toBe(true);
  });

  it('rebuilds cached items as snippets arrive/change/disappear, and hides the previous query immediately', () => {
    const cache = new WeakMap<object, PaletteItem>();
    const before = buildSessionItems(rows, 5000, cache);
    const content = matches([['content-a', 0, '风险初稿']]);
    const loaded = buildSessionItems(rows, 5000, cache, content);
    expect(loaded[0]).toBe(before[0]);
    expect(loaded.find(item => item.key === 'session:content-a')?.excerpt).toBe('风险初稿');
    const changed = buildSessionItems(rows, 5000, cache, matches([['content-a', 0, '风险修订']]));
    expect(changed.find(item => item.key === 'session:content-a')?.excerpt).toBe('风险修订');
    const stale = new Map([['default',{ query: '风险', matches: content }]]);
    const eligible = contentMatchesForQuery(stale, '另一个词');
    const next = buildSessionItems(rows, 5000, cache, eligible);
    expect(next.every(item => item.excerpt === undefined)).toBe(true);
    expect(searchPalette({ items: next, query: '另一个词', scope: 'session', contentMatches: eligible }).counts.session).toBe(0);
    expect(contentMatchesForQuery(stale, '').size).toBe(0);
  });

  it('highlights each literal query word in a snippet without treating the snippet as metadata', () => {
    const text = '风险来自 NEEDLE，另一个 needle';
    const chunks = splitHighlights(text, excerptMatchRanges(text, '风险 needle'));
    expect(chunks.filter(chunk => chunk.hit).map(chunk => chunk.text)).toEqual(['风险', 'NEEDLE', 'needle']);
    const content = matches([['content-a', 0, text]]);
    const items = buildSessionItems(rows, 5000, undefined, content);
    expect(searchPalette({ items, query: 'needle', scope: 'session' }).counts.session).toBe(0);
  });

  it('retains content-matched sessions in the sidebar without changing metadata matches, grouping or empty input', () => {
    const options = { query: '风险', dimension: 'status', now: 5000 } satisfies Parameters<typeof groupWorkbenchSessionsForDimension>[1];
    const without = groupWorkbenchSessionsForDimension(rows, options);
    const withContent = groupWorkbenchSessionsForDimension(rows, options, new Set(['content-b']));
    const ids = (groups: ReturnType<typeof groupWorkbenchSessionsForDimension>) => groups.flatMap(group => group.sessions.map(row => row.sessionId));
    expect(ids(without)).toEqual(['meta']);
    expect(ids(withContent)).toContain('meta'); expect(ids(withContent)).toContain('content-b');
    expect(ids(withContent)).not.toContain('content-a');
    expect(groupWorkbenchSessionsForDimension(rows, options, new Set())).toEqual(without);
    const blank = { ...options, query: '' };
    expect(groupWorkbenchSessionsForDimension(rows, blank, new Set(['content-b'])))
      .toEqual(groupWorkbenchSessionsForDimension(rows, blank));
  });
});


describe('single-line excerpt focus', () => {
  it('moves a hit around the eightieth code point into the visible prefix and recomputes its highlights', () => {
    const excerpt = '…' + '前'.repeat(79) + 'NEEDLE' + '余'.repeat(60);
    const focused = focusExcerpt(excerpt, 'absent needle');
    expect(focused.startsWith('…')).toBe(true);
    expect(focused.startsWith('……')).toBe(false);
    expect(Array.from(focused.slice(0, focused.indexOf('NEEDLE'))).length).toBeLessThanOrEqual(21);
    const ranges = excerptMatchRanges(focused, 'absent needle');
    expect(ranges).toHaveLength(1);
    expect(focused.slice(ranges[0].start, ranges[0].end)).toBe('NEEDLE');
  });

  it('returns the original excerpt when the earliest hit is within twenty code points', () => {
    for (const before of [0, 20]) {
      const excerpt = '前'.repeat(before) + '命中' + '余'.repeat(70) + '后词';
      expect(focusExcerpt(excerpt, '后词 命中')).toBe(excerpt);
    }
  });

  it('returns the original excerpt when no query word matches', () => {
    const excerpt = '…' + '没有相关内容'.repeat(30);
    expect(focusExcerpt(excerpt, 'needle 风险')).toBe(excerpt);
    expect(focusExcerpt(excerpt, '')).toBe(excerpt);
  });

  it('counts Chinese and emoji as code points and preserves surrogate pairs', () => {
    const excerpt = '…' + '中😀'.repeat(40) + 'needle tail';
    const focused = focusExcerpt(excerpt, 'needle');
    expect(focused).toBe('…' + '中😀'.repeat(10) + 'needle tail');
    expect(focused).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    const ranges = excerptMatchRanges(focused, 'needle');
    expect(focused.slice(ranges[0].start, ranges[0].end)).toBe('needle');
  });
});
