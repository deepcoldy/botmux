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
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { BotMultiSelect } from '../src/dashboard/web/bot-multi-select.js';
import { AddBotsDialog, GroupListRow } from '../src/dashboard/web/groups-page.js';
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
      json: async () => ({ result: [{ id: 'cli_a', ok: true }, { id: 'cli_c', ok: true }] }),
    }));
    vi.stubGlobal('fetch', fetchMock as any);

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(AddBotsDialog, {
        chat: { chatId: 'oc_x', name: 'Room', memberBots: [] } as any,
        bots: BOTS as any,
        tr: createDashboardTranslator('zh'),
        onClose: () => {},
        onBotsAdded: () => {},
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

// The auto-close behavior the reviewer required: after a successful add-bots POST
// the dialog decides — on LOCAL optimistic state, not a reloaded snapshot — whether
// anything is left to add, reports the actually-added ids to the parent, and only
// closes when the candidate roster is exhausted AND nothing failed.
describe('AddBotsDialog (consumer) — auto-close + optimistic candidate pruning', () => {
  function checkboxFor(root: TestRenderer.ReactTestInstance, id: string): TestRenderer.ReactTestInstance | undefined {
    return root.findAllByType('input').find(node => node.props.type === 'checkbox' && node.props.value === id);
  }
  function selectAndSubmit(root: TestRenderer.ReactTestInstance, ids: string[]): Promise<void> {
    for (const id of ids) {
      act(() => checkboxFor(root, id)!.props.onChange({ currentTarget: { checked: true } }));
    }
    return act(async () => {
      root.findByType('form').props.onSubmit({ preventDefault() {}, currentTarget: {} });
    });
  }

  it('last batch all-succeeds with no candidates left → reports okIds and calls onClose', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ result: [{ id: 'cli_a', ok: true }, { id: 'cli_b', ok: true }, { id: 'cli_c', ok: true }] }),
    }));
    vi.stubGlobal('fetch', fetchMock as any);
    const onClose = vi.fn();
    const onBotsAdded = vi.fn();

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(AddBotsDialog, {
        chat: { chatId: 'oc_x', name: 'Room', memberBots: [] } as any,
        bots: BOTS as any,
        tr: createDashboardTranslator('zh'),
        onClose,
        onBotsAdded,
      }));
    });

    await selectAndSubmit(renderer.root, ['cli_a', 'cli_b', 'cli_c']);

    expect(onBotsAdded).toHaveBeenCalledWith('oc_x', ['cli_a', 'cli_b', 'cli_c']);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('success but candidates remain → prunes added rows, keeps the dialog open', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ result: [{ id: 'cli_a', ok: true }] }),
    }));
    vi.stubGlobal('fetch', fetchMock as any);
    const onClose = vi.fn();
    const onBotsAdded = vi.fn();

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(AddBotsDialog, {
        chat: { chatId: 'oc_x', name: 'Room', memberBots: [] } as any,
        bots: BOTS as any,
        tr: createDashboardTranslator('zh'),
        onClose,
        onBotsAdded,
      }));
    });
    const root = renderer.root;

    await selectAndSubmit(root, ['cli_a']);

    expect(onBotsAdded).toHaveBeenCalledWith('oc_x', ['cli_a']);
    expect(onClose).not.toHaveBeenCalled();
    // The added bot disappears from the picker; the rest stay selectable.
    expect(checkboxFor(root, 'cli_a')).toBeUndefined();
    expect(checkboxFor(root, 'cli_b')).toBeDefined();
    expect(checkboxFor(root, 'cli_c')).toBeDefined();
  });

  it('partial failure → prunes only the succeeded bot, keeps the failed one and the dialog', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ result: [{ id: 'cli_a', ok: true }, { id: 'cli_b', ok: false, error: 'boom' }] }),
    }));
    vi.stubGlobal('fetch', fetchMock as any);
    const onClose = vi.fn();
    const onBotsAdded = vi.fn();

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(AddBotsDialog, {
        chat: { chatId: 'oc_x', name: 'Room', memberBots: [] } as any,
        bots: BOTS as any,
        tr: createDashboardTranslator('zh'),
        onClose,
        onBotsAdded,
      }));
    });
    const root = renderer.root;

    await selectAndSubmit(root, ['cli_a', 'cli_b']);

    expect(onBotsAdded).toHaveBeenCalledWith('oc_x', ['cli_a']); // only the succeeded id
    expect(onClose).not.toHaveBeenCalled();                       // failure blocks auto-close
    expect(checkboxFor(root, 'cli_a')).toBeUndefined();           // succeeded → pruned
    const failedBox = checkboxFor(root, 'cli_b');
    expect(failedBox).toBeDefined();                              // failed → still selectable
    expect(failedBox!.props.checked).toBe(true);                 // …and its selection is retained
    // The result panel surfaces the per-bot failure reason and the failed count.
    const resultText = JSON.stringify(renderer.toJSON());
    expect(resultText).toContain('boom');                        // per-bot error reason rendered
    expect(resultText).toContain('失败 1');                       // failed count surfaced in the summary
  });

  // The result panel must show each bot's display name (from the roster) beside the
  // raw id, matching the picker checkboxes — not just the bare id.
  it('renders the succeeded bot name alongside its id in the result rows', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ result: [{ id: 'cli_a', ok: true }, { id: 'cli_b', ok: false, error: 'boom' }] }),
    }));
    vi.stubGlobal('fetch', fetchMock as any);

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(AddBotsDialog, {
        chat: { chatId: 'oc_x', name: 'Room', memberBots: [] } as any,
        bots: BOTS as any,
        tr: createDashboardTranslator('zh'),
        onClose: () => {},
        onBotsAdded: () => {},
      }));
    });

    await selectAndSubmit(renderer.root, ['cli_a', 'cli_b']);

    // Assert against the rendered tree so the name+id pairing is checked structurally
    // (JSON.stringify splits "(" + id + ")" into separate text children).
    const resultMains = renderer.root.findAllByProps({ className: 'g-add-bots-result-main' });
    expect(resultMains.length).toBe(2);
    const flat = (children: unknown): string =>
      (Array.isArray(children) ? children : [children]).join('');
    const labels = resultMains.map(main => ({
      name: flat(main.findByType('strong').props.children),
      id: flat(main.findByType('small').props.children),
    }));
    // Both the human name and the id appear (not just the id, which was the bug),
    // matching the picker checkbox format `<strong>name</strong><small>(id)</small>`.
    expect(labels).toContainEqual({ name: 'Alpha(Claude)', id: '(cli_a)' });
    expect(labels).toContainEqual({ name: 'Beta(Codex)', id: '(cli_b)' });
  });
});

// The reviewer's disabled-button requirement: when a chat already has every roster
// bot, the "添加 bot" button is rendered disabled (no click → no toast), and it
// re-enables from the snapshot once a bot is missing again.
describe('GroupListRow — add-bots button disabled when nothing to add', () => {
  const EMPTY_ROLE_CONTEXT = {
    profiles: [],
    entriesById: new Map(),
    groupRoleContentByBot: new Map(),
    loaded: false,
  } as any;

  function addBotsButton(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance | undefined {
    return root.findAllByType('button').find(node =>
      typeof node.props.className === 'string' && node.props.className.includes('add-bots'));
  }

  function renderRow(memberBots: Array<{ larkAppId: string; inChat: boolean }>) {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(GroupListRow, {
        chat: { chatId: 'oc_x', name: 'Room', memberBots } as any,
        bots: BOTS as any,
        roleContext: EMPTY_ROLE_CONTEXT,
        tr: createDashboardTranslator('zh'),
        onAddBots: vi.fn(),
        onSaveProfile: vi.fn(),
        onManage: vi.fn(),
      }));
    });
    return renderer;
  }

  it('disables the button when every roster bot is already in the chat', () => {
    const renderer = renderRow([
      { larkAppId: 'cli_a', inChat: true },
      { larkAppId: 'cli_b', inChat: true },
      { larkAppId: 'cli_c', inChat: true },
    ]);
    const btn = addBotsButton(renderer.root);
    expect(btn).toBeDefined();
    expect(btn!.props.disabled).toBe(true);
    // A title communicates why it is greyed out instead of a post-click toast.
    expect(typeof btn!.props.title).toBe('string');
    expect(btn!.props.title!.length).toBeGreaterThan(0);
  });

  it('keeps the button enabled while any roster bot is still missing', () => {
    const renderer = renderRow([
      { larkAppId: 'cli_a', inChat: true },
      { larkAppId: 'cli_b', inChat: false },
    ]);
    const btn = addBotsButton(renderer.root);
    expect(btn).toBeDefined();
    expect(btn!.props.disabled).toBe(false);
    expect(btn!.props.title).toBeUndefined();
  });

  it('re-enables from the snapshot when membership drops back below the roster', () => {
    const renderer = renderRow([
      { larkAppId: 'cli_a', inChat: true },
      { larkAppId: 'cli_b', inChat: true },
      { larkAppId: 'cli_c', inChat: true },
    ]);
    expect(addBotsButton(renderer.root)!.props.disabled).toBe(true);

    // A bot leaves the chat (snapshot update) → the button must become clickable again.
    act(() => {
      renderer.update(createElement(GroupListRow, {
        chat: {
          chatId: 'oc_x',
          name: 'Room',
          memberBots: [
            { larkAppId: 'cli_a', inChat: true },
            { larkAppId: 'cli_b', inChat: false },
            { larkAppId: 'cli_c', inChat: true },
          ],
        } as any,
        bots: BOTS as any,
        roleContext: EMPTY_ROLE_CONTEXT,
        tr: createDashboardTranslator('zh'),
        onAddBots: vi.fn(),
        onSaveProfile: vi.fn(),
        onManage: vi.fn(),
      }));
    });
    expect(addBotsButton(renderer.root)!.props.disabled).toBe(false);
  });
});
