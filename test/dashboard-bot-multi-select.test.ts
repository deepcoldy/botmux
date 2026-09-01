/**
 * dashboard-bot-multi-select.test.ts
 *
 * Covers the shared searchable bot multi-select (used by the new-group modal,
 * add-bots dialog, and create-session composer) at two levels:
 *
 *  1. Component (renderToStaticMarkup): the picker is fully controlled — `checked`
 *     reflects the `selected` Set, the empty roster renders the empty label, the
 *     count label appears only when something is selected, and no `name`
 *     attribute is emitted (selection is NOT submitted through the DOM).
 *
 *  2. Consumer regression (react-test-renderer, interactive): the add-bots
 *     dialog must submit EVERY selected bot even when the search box has since
 *     filtered some of them out of view. This is the regression the shared
 *     component introduced: the list renders only search-matching rows, so a
 *     consumer that harvested ids from the DOM (`FormData.getAll('bot')`) would
 *     silently drop a bot that was selected while a different search was active.
 *     The dialog now reads selection from controlled state, so it survives.
 */
import { describe, expect, it, vi, afterEach } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { BotMultiSelect } from '../src/dashboard/web/bot-multi-select.js';
import { AddBotsDialog } from '../src/dashboard/web/groups-page.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const BOTS = [
  { larkAppId: 'cli_a', botName: 'Alpha(Claude)' },
  { larkAppId: 'cli_b', botName: 'Beta(Codex)' },
  { larkAppId: 'cli_c', botName: 'Gamma' },
];

function render(props: Partial<Parameters<typeof BotMultiSelect>[0]> = {}): string {
  return renderToStaticMarkup(createElement(BotMultiSelect, {
    bots: BOTS,
    selected: new Set<string>(),
    onToggle: () => {},
    searchPlaceholder: 'search',
    noMatchLabel: 'no-match',
    emptyLabel: 'empty',
    selectedCountLabel: (n: number) => `${n} selected`,
    ...props,
  }));
}

describe('BotMultiSelect (component)', () => {
  it('renders one checkbox per bot with its larkAppId as value', () => {
    const html = render();
    const checkboxes = html.match(/type="checkbox"/g) ?? [];
    expect(checkboxes.length).toBe(BOTS.length);
    for (const bot of BOTS) expect(html).toContain(`value="${bot.larkAppId}"`);
  });

  it('does NOT emit a form name — selection is controlled state, never harvested from the DOM', () => {
    // Guards the regression: a `name="bot"` here invites callers to read the
    // selection via FormData.getAll, which drops search-filtered-out rows.
    expect(render()).not.toContain('name=');
  });

  it('reflects the controlled selected Set in checked state', () => {
    const html = render({ selected: new Set(['cli_b']) });
    const checkedCount = (html.match(/checked=""|checked="checked"/g) ?? []).length;
    expect(checkedCount).toBe(1);
    expect(/value="cli_b"[^>]*checked|checked[^>]*value="cli_b"/.test(html)).toBe(true);
  });

  it('shows the selected-count label only when something is selected', () => {
    expect(render({ selected: new Set() })).not.toContain('selected');
    expect(render({ selected: new Set(['cli_a', 'cli_c']) })).toContain('2 selected');
  });

  it('renders the empty label (not the list) for an empty roster', () => {
    const html = render({ bots: [] });
    expect(html).toContain('empty');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('type="search"');
  });

  it('renders the search box and all rows for a non-empty roster', () => {
    const html = render();
    expect(html).toContain('type="search"');
    for (const bot of BOTS) expect(html).toContain(bot.botName);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Drive the real add-bots dialog: select a bot, search for a *different* one so
// the first is filtered out of the DOM, select the second, then submit. The
// POST body must carry BOTH ids — proving submission reads controlled state,
// not the (now-partial) rendered checkbox set.
describe('AddBotsDialog (consumer) — submits selections filtered out by search', () => {
  function findSearch(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
    return root.findByProps({ className: 'bot-multi-select-search' });
  }
  function checkboxFor(root: TestRenderer.ReactTestInstance, id: string): TestRenderer.ReactTestInstance | undefined {
    return root.findAllByType('input').find(node => node.props.type === 'checkbox' && node.props.value === id);
  }

  it('keeps a selection made under an earlier search query', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ result: [{ larkAppId: 'cli_a', ok: true }, { larkAppId: 'cli_c', ok: true }] }),
    }));
    vi.stubGlobal('fetch', fetchMock as any);

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(AddBotsDialog, {
        chat: { chatId: 'oc_x', name: 'Room', memberBots: [] } as any,
        bots: BOTS as any,
        tr: createDashboardTranslator('zh'),
        onClose: () => {},
        onReloadGroups: async () => ({}) as any,
      }));
    });
    const root = renderer.root;

    // 1) select Alpha while the list is unfiltered
    act(() => checkboxFor(root, 'cli_a')!.props.onChange({ currentTarget: { checked: true } }));
    // 2) search "Gamma" → Alpha's row is unmounted (no longer in the DOM)
    act(() => findSearch(root).props.onChange({ currentTarget: { value: 'Gamma' } }));
    expect(checkboxFor(root, 'cli_a')).toBeUndefined();       // Alpha really is gone from the DOM
    expect(checkboxFor(root, 'cli_c')).toBeDefined();          // Gamma is visible
    // 3) select Gamma, then submit
    act(() => checkboxFor(root, 'cli_c')!.props.onChange({ currentTarget: { checked: true } }));
    await act(async () => {
      root.findByType('form').props.onSubmit({ preventDefault() {}, currentTarget: {} });
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    // BOTH the search-hidden Alpha and the visible Gamma must be submitted.
    expect(new Set(body.larkAppIds)).toEqual(new Set(['cli_a', 'cli_c']));
  });
});
