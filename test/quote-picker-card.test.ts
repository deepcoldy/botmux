/**
 * Tests for the `/quote` picker card JSON.
 *
 * The card is stateless on Lark's side — every button has to carry the full
 * state back — so most of what can break here is a value field silently going
 * missing. These assertions pin the round-trip.
 */
import { describe, it, expect } from 'vitest';
import { buildQuotePickerCard, quotePickerFilter, type QuotePickerEntry } from '../src/im/lark/card-builder.js';

const entries: QuotePickerEntry[] = [
  { containerId: 'omt_a', containerKind: 'thread', title: '接口格式讨论', starterName: '孙晓雪', lastMessageAt: Date.now() - 60_000 },
  { containerId: 'omt_b', containerKind: 'thread', title: 'fork 权限', starterName: '李嘉瑞', lastMessageAt: Date.now() - 600_000 },
  { containerId: 'om_c',  containerKind: 'root',   title: '普通群回复链' },
];

function parse(json: string): any { return JSON.parse(json); }

/** Collect every `behaviors[].value` object anywhere in the card tree. */
function allValues(node: any, out: any[] = []): any[] {
  if (Array.isArray(node)) { node.forEach(n => allValues(n, out)); return out; }
  if (node && typeof node === 'object') {
    for (const b of node.behaviors ?? []) if (b?.value) out.push(b.value);
    Object.values(node).forEach(v => allValues(v, out));
  }
  return out;
}

describe('buildQuotePickerCard', () => {
  it('renders one selectable row per 话题 with its select action', () => {
    const card = parse(buildQuotePickerCard(entries, 'oc_1', 'om_root', 'ou_me'));
    const selects = allValues(card).filter(v => v.action === 'quote_select');
    expect(selects.map(v => v.container_id)).toEqual(['omt_a', 'omt_b', 'om_c']);
    // container_kind rides along so the confirm handler knows which Lark
    // container to read without re-deriving it from the id prefix.
    expect(selects.map(v => v.container_kind)).toEqual(['thread', 'thread', 'root']);
  });

  it('pins every action to the invoker so a passer-by cannot repoint the card', () => {
    const card = parse(buildQuotePickerCard(entries, 'oc_1', 'om_root', 'ou_me'));
    const values = allValues(card);
    expect(values.length).toBeGreaterThan(0);
    expect(values.every(v => v.invoker_open_id === 'ou_me')).toBe(true);
  });

  it('shows no confirm button until a 话题 is selected', () => {
    const card = parse(buildQuotePickerCard(entries, 'oc_1', 'om_root', 'ou_me'));
    expect(allValues(card).some(v => v.action === 'quote_confirm')).toBe(false);
    expect(JSON.stringify(card)).toContain('点击上方任意话题');
  });

  it('adds a confirm carrying the selection once one is picked', () => {
    const card = parse(buildQuotePickerCard(
      entries, 'oc_1', 'om_root', 'ou_me', 'zh', { selectedContainerId: 'omt_b' },
    ));
    const confirm = allValues(card).find(v => v.action === 'quote_confirm');
    expect(confirm).toMatchObject({ container_id: 'omt_b', container_kind: 'thread', title: 'fork 权限' });
  });

  it('carries the follow-up token through select and confirm for one-round mode', () => {
    const card = parse(buildQuotePickerCard(
      entries, 'oc_1', 'om_root', 'ou_me', 'zh', { selectedContainerId: 'omt_a' }, 'qtok1',
    ));
    expect(allValues(card).every(v => v.follow_up === 'qtok1')).toBe(true);
    // Button copy changes so the user can see the instruction will run.
    expect(JSON.stringify(card)).toContain('读取并执行我的指令');
  });

  it('carries the exclusion list through re-render actions', () => {
    // The re-render handler only sees root_id, so it cannot recompute which
    // 话题 the invoker is sitting in. Without this the current 话题 would
    // reappear in its own picker after the first click.
    const card = parse(buildQuotePickerCard(
      entries, 'oc_1', 'om_root', 'ou_me', 'zh', { selectedContainerId: 'omt_a' }, '', 'public', 'om_root,omt_here',
    ));
    expect(allValues(card).every(v => v.exclude_ids === 'om_root,omt_here')).toBe(true);
  });

  it('renders an empty-state instead of a bare card when no 话题 exist', () => {
    const card = buildQuotePickerCard([], 'oc_1', 'om_root', 'ou_me');
    expect(card).toContain('没有找到其他话题');
    expect(allValues(parse(card)).some(v => v.action === 'quote_select')).toBe(false);
  });

  it('paginates and disables the edge buttons', () => {
    const many: QuotePickerEntry[] = Array.from({ length: 12 }, (_, i) => ({
      containerId: `omt_${i}`, containerKind: 'thread', title: `话题${i}`, lastMessageAt: 1000 - i,
    }));
    const first = parse(buildQuotePickerCard(many, 'oc_1', 'om_root', 'ou_me', 'zh', { page: 0 }));
    const pageActions = allValues(first).filter(v => v.action === 'quote_page');
    expect(pageActions.length).toBe(2);
    expect(JSON.stringify(first)).toContain('第 1 / 3 页');
    // Page 0 shows the 5 most recent, not all 12.
    expect(allValues(first).filter(v => v.action === 'quote_select')).toHaveLength(5);
  });

  it('clamps an out-of-range page rather than rendering an empty list', () => {
    const card = buildQuotePickerCard(entries, 'oc_1', 'om_root', 'ou_me', 'zh', { page: 99 });
    expect(allValues(parse(card)).filter(v => v.action === 'quote_select').length).toBeGreaterThan(0);
  });
});

describe('quotePickerFilter', () => {
  it('matches on title and starter name, case-insensitively', () => {
    expect(quotePickerFilter(entries, '接口').map(e => e.containerId)).toEqual(['omt_a']);
    expect(quotePickerFilter(entries, '李嘉瑞').map(e => e.containerId)).toEqual(['omt_b']);
    expect(quotePickerFilter(entries, 'FORK').map(e => e.containerId)).toEqual(['omt_b']);
  });

  it('returns everything for an empty or whitespace query', () => {
    expect(quotePickerFilter(entries, '')).toHaveLength(3);
    expect(quotePickerFilter(entries, '   ')).toHaveLength(3);
    expect(quotePickerFilter(entries, undefined)).toHaveLength(3);
  });
});
