import { describe, expect, it, vi } from 'vitest';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { NAV_GROUPS, NAV_ITEMS } from '../src/dashboard/web/nav-items.js';
import {
  CAPABILITY_CATALOG, CORE_NAV_IDS, DEFAULT_WORKSPACE_MODE, WORKSPACE_PERSONALIZATION_STORAGE_KEY,
  WORKSPACE_PRESETS, applyWorkspacePreset, createWorkspacePersonalizationStore, detectActivePreset, filterCatalogCapabilities,
  filterSidebarItemsForWorkspace, isCapabilityExplicitlyPinned, loadWorkspacePersonalization, pinCapability, resolveEffectivePinnedIds,
  saveWorkspacePersonalization, subscribeWorkspacePersonalizationStore, unpinCapability, unpinExplicitCapability,
  type WorkspacePersonalizationState,
} from '../src/dashboard/web/workspace-personalization.js';

const zh = createDashboardTranslator('zh');
const en = createDashboardTranslator('en');
const available = new Set(NAV_ITEMS.map(item => item.id));

function state(overrides: Partial<WorkspacePersonalizationState> = {}): WorkspacePersonalizationState {
  return { mode: 'all', pinnedIds: [], dismissedAutoIds: [], dismissedGuideIds: [], ...overrides };
}

function memoryStorage(raw?: string) {
  const values = new Map<string, string>();
  if (raw !== undefined) values.set(WORKSPACE_PERSONALIZATION_STORAGE_KEY, raw);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

type Store = ReturnType<typeof createWorkspacePersonalizationStore>;

function updatePin(store: Store, id: string) {
  return store.update(current => pinCapability(current, id), { replay: 'pin', capabilityId: id });
}

describe('workspace personalization', () => {
  it('defaults to full navigation with fresh empty preferences', () => {
    expect(DEFAULT_WORKSPACE_MODE).toBe('all');
    const defaults = loadWorkspacePersonalization(memoryStorage());
    expect(defaults).toEqual(state());
    expect(filterSidebarItemsForWorkspace(NAV_ITEMS, defaults, [])).toBe(NAV_ITEMS);
    defaults.pinnedIds.push('skills');
    expect(loadWorkspacePersonalization(memoryStorage())).toEqual(state());
  });

  it.each(['all', 'focused'] as const)('round-trips the selected %s mode and all three preference lists', mode => {
    const storage = memoryStorage();
    const preferences = state({
      mode, pinnedIds: ['skills', 'monitoring'], dismissedAutoIds: ['schedules'], dismissedGuideIds: ['workflows'],
    });
    saveWorkspacePersonalization(preferences, storage);
    expect(loadWorkspacePersonalization(storage)).toEqual(preferences);
    expect(JSON.parse(storage.getItem(WORKSPACE_PERSONALIZATION_STORAGE_KEY)!)).toEqual(preferences);
  });

  it.each(['{', '[]', '{"mode":"all","pinnedIds":[]}', '{"mode":"legacy"}', '{"mode":"all","pinnedIds":{},"dismissedAutoIds":[],"dismissedGuideIds":[]}'])(
    'falls back safely for malformed or old storage %s',
    raw => expect(loadWorkspacePersonalization(memoryStorage(raw))).toEqual(state()),
  );

  it('normalizes unknown, repeated, core and non-string IDs on read and write', () => {
    const preferences = state({
      pinnedIds: ['overview', 'skills', 'skills', 'unknown'],
      dismissedAutoIds: ['schedules', 'schedules', 'settings'],
      dismissedGuideIds: ['feedback', 'feedback', 'plugin:sample'],
    });
    const cleaned = state({ pinnedIds: ['skills'], dismissedAutoIds: ['schedules'], dismissedGuideIds: ['feedback'] });
    const storage = memoryStorage(JSON.stringify({ ...preferences, pinnedIds: [...preferences.pinnedIds, 1, null] }));
    expect(loadWorkspacePersonalization(storage)).toEqual(cleaned);
    saveWorkspacePersonalization(preferences, storage);
    expect(JSON.parse(storage.getItem(WORKSPACE_PERSONALIZATION_STORAGE_KEY)!)).toEqual(cleaned);
    expect(preferences.pinnedIds).toHaveLength(4);
  });

  it('can use browser storage by default and tolerates denied reads and writes', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    try {
      saveWorkspacePersonalization(state({ mode: 'focused' }));
      expect(loadWorkspacePersonalization().mode).toBe('focused');
    } finally {
      vi.unstubAllGlobals();
    }
    const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    expect(loadWorkspacePersonalization(denied)).toEqual(state());
    expect(saveWorkspacePersonalization(state(), denied)).toBe(false);
  });

  it('keeps both changes when a tab edits before receiving another tab’s storage event', () => {
    const storage = memoryStorage();
    const first = createWorkspacePersonalizationStore(storage);
    const second = createWorkspacePersonalizationStore(storage);
    expect(updatePin(first, 'skills').pinnedIds).toEqual(['skills']);
    expect(updatePin(second, 'monitoring').pinnedIds).toEqual(['skills', 'monitoring']);
    expect(first.read().pinnedIds).toEqual(['skills', 'monitoring']);
    expect(loadWorkspacePersonalization(storage).pinnedIds).toEqual(['skills', 'monitoring']);
  });

  it('retains an unpersisted edit and merges it with another tab’s write when storage recovers', () => {
    const storage = memoryStorage();
    const write = vi.fn().mockImplementationOnce(() => { throw new Error('quota'); }).mockImplementation(storage.setItem);
    const first = createWorkspacePersonalizationStore({ ...storage, setItem: write });
    const second = createWorkspacePersonalizationStore(storage);

    expect(updatePin(first, 'skills').pinnedIds).toEqual(['skills']);
    expect(updatePin(second, 'monitoring').pinnedIds).toEqual(['monitoring']);
    expect(first.read().pinnedIds).toEqual(['monitoring', 'skills']);
    first.update(current => ({ ...current, mode: 'all' }));
    expect(loadWorkspacePersonalization(storage)).toEqual(state({ mode: 'all', pinnedIds: ['monitoring', 'skills'] }));

    second.update(current => unpinCapability(current, 'skills'));
    expect(first.read().pinnedIds).toEqual(['monitoring']);
  });

  it('waits for a readable snapshot before writing, then reapplies the in-memory edit', () => {
    const storage = memoryStorage();
    const read = vi.fn(storage.getItem);
    const write = vi.fn(storage.setItem);
    const first = createWorkspacePersonalizationStore({ getItem: read, setItem: write });
    const second = createWorkspacePersonalizationStore(storage);

    updatePin(second, 'monitoring');
    read.mockImplementationOnce(() => { throw new Error('unavailable'); });
    expect(updatePin(first, 'skills').pinnedIds).toEqual(['skills']);
    expect(write).not.toHaveBeenCalled();
    first.update(current => ({ ...current, mode: 'all' }));
    expect(loadWorkspacePersonalization(storage)).toEqual(state({ mode: 'all', pinnedIds: ['monitoring', 'skills'] }));
  });

  it('replays a failed preset over the same snapshot and flushes it after storage recovers', () => {
    const storage = memoryStorage();
    const write = vi.fn().mockImplementationOnce(() => { throw new Error('quota'); }).mockImplementation(storage.setItem);
    const store = createWorkspacePersonalizationStore({ ...storage, setItem: write });

    store.update(current => applyWorkspacePreset(current, 'builder'), { replay: 'same-snapshot' });
    expect(store.read().pinnedIds).toEqual(['skills', 'customization', 'plugins', 'connectors', 'terminal']);
    updatePin(store, 'monitoring');
    expect(loadWorkspacePersonalization(storage)).toEqual(state({
      mode: 'focused', pinnedIds: ['skills', 'customization', 'plugins', 'connectors', 'terminal', 'monitoring'],
    }));
  });

  it('drops an outdated pending preset instead of overwriting another tab’s newer preset', () => {
    const storage = memoryStorage();
    let unavailable = true;
    const first = createWorkspacePersonalizationStore({
      getItem: storage.getItem,
      setItem: (key, value) => {
        if (unavailable) throw new Error('unavailable');
        storage.setItem(key, value);
      },
    });
    const second = createWorkspacePersonalizationStore(storage);

    first.update(current => applyWorkspacePreset(current, 'builder'), { replay: 'same-snapshot' });
    second.update(current => applyWorkspacePreset(current, 'minimal'), { replay: 'same-snapshot' });
    expect(first.read()).toEqual(state({ mode: 'focused' }));

    unavailable = false;
    updatePin(first, 'skills');
    expect(loadWorkspacePersonalization(storage)).toEqual(state({ mode: 'focused', pinnedIds: ['skills'] }));
  });

  it('still merges an additive pending pin into another tab’s newer preset', () => {
    const storage = memoryStorage();
    const write = vi.fn().mockImplementationOnce(() => { throw new Error('quota'); }).mockImplementation(storage.setItem);
    const first = createWorkspacePersonalizationStore({ ...storage, setItem: write });
    const second = createWorkspacePersonalizationStore(storage);

    updatePin(first, 'monitoring');
    second.update(current => applyWorkspacePreset(current, 'minimal'), { replay: 'same-snapshot' });
    expect(first.read()).toEqual(state({ mode: 'focused', pinnedIds: ['monitoring'] }));
    first.update(current => ({ ...current, dismissedGuideIds: ['skills'] }));
    expect(loadWorkspacePersonalization(storage)).toEqual(state({
      mode: 'focused', pinnedIds: ['monitoring'], dismissedGuideIds: ['skills'],
    }));
  });

  it('lets a newer remote pin win over an older failed automatic hide', () => {
    const storage = memoryStorage();
    let unavailable = true;
    const first = createWorkspacePersonalizationStore({
      getItem: storage.getItem,
      setItem: (key, value) => {
        if (unavailable) throw new Error('unavailable');
        storage.setItem(key, value);
      },
    });
    const second = createWorkspacePersonalizationStore(storage);

    first.update(current => unpinCapability(current, 'schedules'));
    updatePin(second, 'schedules');
    expect(first.read()).toEqual(state({ mode: 'focused', pinnedIds: ['schedules'] }));

    unavailable = false;
    updatePin(first, 'monitoring');
    expect(loadWorkspacePersonalization(storage)).toEqual(state({
      mode: 'focused', pinnedIds: ['schedules', 'monitoring'],
    }));
  });

  it('lets a newer remote automatic hide win over an older failed pin', () => {
    const storage = memoryStorage();
    let unavailable = true;
    const first = createWorkspacePersonalizationStore({
      getItem: storage.getItem,
      setItem: (key, value) => {
        if (unavailable) throw new Error('unavailable');
        storage.setItem(key, value);
      },
    });
    const second = createWorkspacePersonalizationStore(storage);

    updatePin(first, 'schedules');
    second.update(current => unpinCapability(current, 'schedules'));
    expect(first.read()).toEqual(state({ dismissedAutoIds: ['schedules'] }));

    unavailable = false;
    updatePin(first, 'monitoring');
    expect(loadWorkspacePersonalization(storage)).toEqual(state({
      mode: 'focused', pinnedIds: ['monitoring'], dismissedAutoIds: ['schedules'],
    }));
  });

  it('does not replay an old explicit unpin over a newer preset', () => {
    const storage = memoryStorage(JSON.stringify(state({ mode: 'focused', pinnedIds: ['skills'] })));
    let unavailable = true;
    const first = createWorkspacePersonalizationStore({
      getItem: storage.getItem,
      setItem: (key, value) => {
        if (unavailable) throw new Error('unavailable');
        storage.setItem(key, value);
      },
    });
    const second = createWorkspacePersonalizationStore(storage);

    first.update(current => unpinExplicitCapability(current, 'skills'));
    second.update(current => applyWorkspacePreset(current, 'builder'));
    expect(first.read().pinnedIds).toEqual(['skills', 'customization', 'plugins', 'connectors', 'terminal']);

    unavailable = false;
    updatePin(first, 'monitoring');
    expect(loadWorkspacePersonalization(storage).pinnedIds).toEqual([
      'skills', 'customization', 'plugins', 'connectors', 'terminal', 'monitoring',
    ]);
  });

  it('merges a pending pin without overwriting a newer remote mode', () => {
    const storage = memoryStorage(JSON.stringify(state({ mode: 'focused', pinnedIds: ['feedback'] })));
    const write = vi.fn().mockImplementationOnce(() => { throw new Error('quota'); }).mockImplementation(storage.setItem);
    const first = createWorkspacePersonalizationStore({ ...storage, setItem: write });
    const second = createWorkspacePersonalizationStore(storage);

    updatePin(first, 'skills');
    second.update(current => ({ ...current, mode: 'all' }));
    expect(first.read()).toEqual(state({ mode: 'all', pinnedIds: ['feedback', 'skills'] }));
    expect(first.read()).toEqual(state({ mode: 'all', pinnedIds: ['feedback', 'skills'] }));

    first.update(current => ({ ...current, dismissedGuideIds: ['skills'] }), { replay: 'always' });
    expect(loadWorkspacePersonalization(storage)).toEqual(state({
      mode: 'all', pinnedIds: ['feedback', 'skills'], dismissedGuideIds: ['skills'],
    }));
  });

  it('does not replay a preset without a known baseline over a newer saved preset', () => {
    const storage = memoryStorage();
    let readable = false;
    const write = vi.fn(storage.setItem);
    const first = createWorkspacePersonalizationStore({
      getItem: key => {
        if (!readable) throw new Error('unavailable');
        return storage.getItem(key);
      },
      setItem: write,
    });
    const second = createWorkspacePersonalizationStore(storage);

    first.update(current => applyWorkspacePreset(current, 'builder'));
    expect(write).not.toHaveBeenCalled();
    second.update(current => applyWorkspacePreset(current, 'minimal'));
    readable = true;
    expect(first.read()).toEqual(state({ mode: 'focused' }));

    updatePin(first, 'skills');
    expect(loadWorkspacePersonalization(storage)).toEqual(state({ mode: 'focused', pinnedIds: ['skills'] }));
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('keeps independent pins queued before a later destructive conflict', () => {
    const storage = memoryStorage();
    let unavailable = true;
    const first = createWorkspacePersonalizationStore({
      getItem: storage.getItem,
      setItem: (key, value) => {
        if (unavailable) throw new Error('unavailable');
        storage.setItem(key, value);
      },
    });
    const second = createWorkspacePersonalizationStore(storage);

    updatePin(first, 'monitoring');
    first.update(current => unpinCapability(current, 'schedules'));
    first.update(current => ({ ...current, dismissedGuideIds: [...current.dismissedGuideIds, 'skills'] }), { replay: 'always' });
    second.update(current => ({ ...current, dismissedGuideIds: ['feedback'] }), { replay: 'always' });

    expect(first.read()).toEqual(state({
      pinnedIds: ['monitoring'], dismissedGuideIds: ['feedback', 'skills'],
    }));
    unavailable = false;
    first.update(current => ({ ...current, dismissedGuideIds: [...current.dismissedGuideIds, 'workflows'] }), { replay: 'always' });
    expect(loadWorkspacePersonalization(storage)).toEqual(state({
      pinnedIds: ['monitoring'], dismissedGuideIds: ['feedback', 'skills', 'workflows'],
    }));
  });

  it('re-reads on subscription to catch writes before the listener was installed', () => {
    const storage = memoryStorage();
    const local = createWorkspacePersonalizationStore(storage);
    const remote = createWorkspacePersonalizationStore(storage);
    expect(local.read()).toEqual(state());
    remote.update(current => ({ ...current, mode: 'focused', pinnedIds: ['skills'] }));

    const listeners = new Set<(event: StorageEvent) => void>();
    const target = {
      addEventListener: (_type: 'storage', listener: (event: StorageEvent) => void) => { listeners.add(listener); },
      removeEventListener: (_type: 'storage', listener: (event: StorageEvent) => void) => { listeners.delete(listener); },
    };
    const onChange = vi.fn();
    const unsubscribe = subscribeWorkspacePersonalizationStore(local, target, () => storage, onChange);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(state({ mode: 'focused', pinnedIds: ['skills'] }));

    const dispatch = (key: string | null, storageArea = storage as Storage) => {
      for (const listener of listeners) listener({ key, storageArea } as StorageEvent);
    };
    dispatch('unrelated');
    expect(onChange).toHaveBeenCalledTimes(1);
    updatePin(remote, 'monitoring');
    dispatch(WORKSPACE_PERSONALIZATION_STORAGE_KEY);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(state({ mode: 'focused', pinnedIds: ['skills', 'monitoring'] }));
    dispatch(null);
    expect(onChange).toHaveBeenCalledTimes(3);
    dispatch(WORKSPACE_PERSONALIZATION_STORAGE_KEY, {} as Storage);
    expect(onChange).toHaveBeenCalledTimes(3);
    unsubscribe();
    dispatch(null);
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(listeners).toHaveLength(0);

    const denied = createWorkspacePersonalizationStore({
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    const deniedOnChange = vi.fn();
    const unsubscribeDenied = subscribeWorkspacePersonalizationStore(
      denied,
      target,
      () => { throw new Error('denied'); },
      deniedOnChange,
    );
    expect(deniedOnChange).toHaveBeenCalledTimes(1);
    expect(() => dispatch(WORKSPACE_PERSONALIZATION_STORAGE_KEY)).not.toThrow();
    expect(deniedOnChange).toHaveBeenCalledTimes(1);
    unsubscribeDenied();
  });

  it('keeps core, explicit, automatic and pinned plugin entries in input order', () => {
    const items = [...NAV_ITEMS, { id: 'plugin:sample', plugin: true }, { id: 'unknown' }];
    const focused = state({ mode: 'focused', pinnedIds: ['skills'], dismissedAutoIds: ['decision-board'] });
    expect(filterSidebarItemsForWorkspace(items, focused, ['schedules', 'decision-board', 'unknown']).map(item => item.id))
      .toEqual(['overview', 'sessions', 'groups', 'schedules', 'bot-defaults', 'skills', 'settings', 'plugin:sample']);
    expect(filterSidebarItemsForWorkspace(items, { ...focused, mode: 'all' }, ['schedules'])).toBe(items);
    expect(filterSidebarItemsForWorkspace(items.filter(item => item.id !== 'skills'), focused, []).some(item => item.id === 'skills'))
      .toBe(false);
  });

  it('protects core entries and ignores unknown capabilities', () => {
    const original = state();
    expect(CORE_NAV_IDS).toEqual(['overview', 'sessions', 'groups', 'bot-defaults', 'settings']);
    for (const id of [...CORE_NAV_IDS, 'unknown']) {
      expect(unpinCapability(original, id)).toBe(original);
      expect(pinCapability(original, id)).toBe(original);
    }
  });

  it('separates explicit pins from automatic visibility and keeps live auto items after explicit unpin', () => {
    const automatic = state({ mode: 'focused' });
    expect(isCapabilityExplicitlyPinned(automatic, 'schedules')).toBe(false);
    expect(resolveEffectivePinnedIds(automatic, ['schedules']).has('schedules')).toBe(true);

    const pinned = pinCapability(automatic, 'schedules');
    expect(isCapabilityExplicitlyPinned(pinned, 'schedules')).toBe(true);
    const unpinned = unpinExplicitCapability(pinned, 'schedules');
    expect(isCapabilityExplicitlyPinned(unpinned, 'schedules')).toBe(false);
    expect(unpinned.dismissedAutoIds).toEqual([]);
    expect(resolveEffectivePinnedIds(unpinned, ['schedules']).has('schedules')).toBe(true);

    const hidden = unpinCapability(unpinned, 'schedules');
    expect(hidden.dismissedAutoIds).toEqual(['schedules']);
    expect(resolveEffectivePinnedIds(hidden, ['schedules']).has('schedules')).toBe(false);
  });

  it('keeps an automatic entry removed across signal changes, then restores it on pin', () => {
    const automatic = ['schedules', 'decision-board', 'task-routing'];
    const original = state({ pinnedIds: ['skills', 'schedules'] });
    expect(resolveEffectivePinnedIds(original, automatic)).toEqual(new Set(['skills', ...automatic]));
    const removed = unpinCapability(unpinCapability(original, 'schedules'), 'task-routing');
    expect(removed.pinnedIds).toEqual(['skills']);
    expect(removed.dismissedAutoIds).toEqual(['schedules', 'task-routing']);
    expect(resolveEffectivePinnedIds(removed, [])).toEqual(new Set(['skills']));
    expect(resolveEffectivePinnedIds(removed, automatic)).toEqual(new Set(['skills', 'decision-board']));
    const pinned = pinCapability({ ...removed, mode: 'all' }, 'schedules');
    expect(pinned).toEqual(state({ mode: 'focused', pinnedIds: ['skills', 'schedules'], dismissedAutoIds: ['task-routing'] }));
    expect(resolveEffectivePinnedIds(pinned, automatic)).toEqual(new Set(['skills', 'schedules', 'decision-board']));
    expect(unpinCapability(pinned, 'skills').dismissedAutoIds).toEqual(['task-routing']);
  });

  it('matches all four presets by the set of explicit pins', () => {
    const expected = {
      minimal: [],
      oncall: ['schedules', 'message-listeners', 'monitoring'],
      'multi-agent': ['agent-workbench', 'workflows', 'roles', 'decision-board', 'task-routing'],
      builder: ['skills', 'customization', 'plugins', 'connectors', 'terminal'],
    };
    expect(WORKSPACE_PRESETS.map(preset => preset.id)).toEqual(Object.keys(expected));
    for (const preset of WORKSPACE_PRESETS) {
      const next = applyWorkspacePreset(state({ mode: 'all', pinnedIds: ['feedback'], dismissedGuideIds: ['skills'] }), preset.id);
      expect(next).toEqual(state({ mode: 'focused', pinnedIds: expected[preset.id], dismissedGuideIds: ['skills'] }));
      expect(detectActivePreset({ ...next, pinnedIds: [...next.pinnedIds].reverse() })).toBe(preset.id);
      expect(detectActivePreset({ ...next, mode: 'all' })).toBeNull();
    }
    expect(detectActivePreset(state({ mode: 'focused', pinnedIds: ['feedback'] }))).toBeNull();
  });

  it('keeps explicit suppressions across presets and resets to the cores with live signals', () => {
    const original = state({ pinnedIds: ['agents'], dismissedAutoIds: ['schedules', 'decision-board'], dismissedGuideIds: ['skills'] });
    const oncall = applyWorkspacePreset(original, 'oncall', ['schedules', 'task-routing']);
    expect(oncall.dismissedAutoIds).toEqual(['decision-board']);
    expect(resolveEffectivePinnedIds(oncall, ['schedules', 'task-routing']).has('task-routing')).toBe(true);
    const minimal = applyWorkspacePreset(oncall, 'minimal', ['schedules', 'task-routing']);
    expect(minimal).toEqual(state({ mode: 'focused', dismissedAutoIds: ['schedules', 'task-routing'], dismissedGuideIds: ['skills'] }));
    expect(filterSidebarItemsForWorkspace(NAV_ITEMS, minimal, ['schedules', 'task-routing']).map(item => item.id))
      .toEqual(CORE_NAV_IDS);
  });

  it('searches terms, titles and summaries across locales while respecting the available IDs', () => {
    const search = (query: string, tr = zh, ids = available) =>
      filterCatalogCapabilities(CAPABILITY_CATALOG, ids, query, tr).map(cap => cap.id);
    expect(search('  CrOn  ')).toEqual(['schedules']);
    expect(search('告警', en)).toEqual(['message-listeners', 'monitoring']);
    expect(search('Webhook')).toEqual(['connectors']);
    expect(search('Document')).toEqual(['doc-watches']);
    expect(search('Token 用量', en)).toEqual(['usage']);
    expect(search('distinct responsibilities', zh)).toEqual(['roles']);
    expect(search('   ', zh, new Set(['schedules', 'overview']))).toEqual(['schedules']);
    expect(search('告警', en, new Set(['monitoring']))).toEqual(['monitoring']);
    expect(search('no such capability')).toEqual([]);
  });

  it('maps each of the 24 built-ins exactly once and translates each descriptor in both locales', () => {
    const ids = [...CORE_NAV_IDS, ...CAPABILITY_CATALOG.map(cap => cap.id)];
    expect(CAPABILITY_CATALOG).toHaveLength(19);
    expect([...ids].sort()).toEqual(NAV_ITEMS.map(item => item.id).sort());
    expect(NAV_GROUPS.flatMap(group => group.items).sort()).toEqual([...ids].sort());
    for (const cap of CAPABILITY_CATALOG) {
      for (const key of [cap.summaryKey, cap.guideKey, cap.guideActionLabelKey]) {
        if (!key) continue;
        expect(zh(key)).not.toBe(key);
        expect(en(key)).not.toBe(zh(key));
      }
    }
  });
});
