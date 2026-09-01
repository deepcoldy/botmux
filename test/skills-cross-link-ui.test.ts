import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, afterEach } from 'bun:test';
import { SkillsPage } from '../src/dashboard/web/skills-page.js';
import { SkillPacksTab } from '../src/dashboard/web/skills/skill-packs-tab.js';
import { BotAssignmentsTab } from '../src/dashboard/web/skills/bot-assignments-tab.js';
import type { BotRow, SkillPackRow, SkillRow } from '../src/dashboard/web/skills/types.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function jsonRes(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function flush() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

function packRow(over: Partial<SkillPackRow> = {}): SkillPackRow {
  return {
    id: 'p1',
    name: 'Pack 1',
    include: ['skill:a', 'skill:x-missing'],
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    references: [{ larkAppId: 'bot-1', botName: 'Bot 1' }],
    missingSkills: ['x-missing'],
    resolvedSkills: [],
    ...over,
  };
}

const installedSkills: SkillRow[] = [
  { name: 'a', tags: [], rootDir: '/a', entrypoint: 'SKILL.md', source: { type: 'user', root: '/a' } },
  { name: 'b', tags: [], rootDir: '/b', entrypoint: 'SKILL.md', source: { type: 'user', root: '/b' } },
];

function bot(over: Partial<BotRow> = {}): BotRow {
  return { larkAppId: 'bot-1', botName: 'Bot 1', skills: { include: ['pack:p1'] }, ...over };
}

describe('skills cross-page linking', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function mockPageFetch(): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).startsWith('/api/skills')) {
        return jsonRes(200, { skills: installedSkills, nativeSkillGroups: [], trustProjectSkills: 'off', delivery: 'auto' });
      }
      if (String(url).startsWith('/api/bots')) return jsonRes(200, { bots: [bot()] });
      if (String(url).startsWith('/api/skill-packs')) return jsonRes(200, { packs: [packRow()] });
      return jsonRes(404, { error: 'not_found' });
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('overview strip surfaces dangling skills and bots-with-missing issues from the graph', async () => {
    mockPageFetch();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(SkillsPage)); });
    await flush();
    const root = renderer.root;
    expect(root.findAllByProps({ 'data-action': 'issue-dangling-skills' })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-action': 'issue-bots-missing' })).toHaveLength(1);
    // p1 IS assigned to bot-1, so no unassigned-packs badge
    expect(root.findAllByProps({ 'data-action': 'issue-unassigned-packs' })).toHaveLength(0);
  });

  it('dangling-skill badge jumps to library, prefills search + install target, and never auto-installs', async () => {
    const fetchMock = mockPageFetch();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(SkillsPage)); });
    await flush();
    const root = renderer.root;
    const badge = root.findByProps({ 'data-action': 'issue-dangling-skills' });
    await act(async () => { badge.props.onClick(); });
    await flush();
    // Library search prefilled with the missing skill
    const search = root.findByProps({ 'data-action': 'search-installed-skills' });
    expect(search.props.value).toBe('x-missing');
    // Install wizard opened with target hint — prefill only
    expect(root.findAllByProps({ 'data-install-target': 'x-missing' })).toHaveLength(1);
    // No install/discover call was made by navigation alone
    const writeCalls = fetchMock.mock.calls.filter((c: any) => c[1]?.method && c[1].method !== 'GET');
    expect(writeCalls).toHaveLength(0);
  });

  it('bots-with-missing badge jumps to bot table and highlights the affected bot row', async () => {
    mockPageFetch();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(SkillsPage)); });
    await flush();
    const root = renderer.root;
    const badge = root.findByProps({ 'data-action': 'issue-bots-missing' });
    await act(async () => { badge.props.onClick(); });
    await flush();
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('skills-bot-row-focus');
  });

  it('packs tab: missing-skill chip redirects to install prefill; bot ref chip opens bot table', async () => {
    const onInstallMissingSkill = vi.fn();
    const onOpenBot = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(SkillPacksTab, {
        skills: installedSkills,
        packs: [packRow()],
        onRefresh: () => {},
        onInstallMissingSkill,
        onOpenBot,
      }));
    });
    const root = renderer.root;
    await act(async () => { root.findByProps({ 'data-action': 'install-missing-skill' }).props.onClick(); });
    expect(onInstallMissingSkill).toHaveBeenCalledWith('x-missing');
    await act(async () => { root.findByProps({ 'data-action': 'open-pack-bot' }).props.onClick(); });
    expect(onOpenBot).toHaveBeenCalledWith('bot-1');
  });

  it('packs tab: focusPackId opens that pack editor once and consumes the intent', async () => {
    const onFocusConsumed = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(SkillPacksTab, {
        skills: installedSkills,
        packs: [packRow()],
        onRefresh: () => {},
        focusPackId: 'p1',
        onFocusConsumed,
      }));
    });
    await flush();
    expect(onFocusConsumed).toHaveBeenCalledTimes(1);
    // Editor dialog open for the focused pack (id input disabled with value p1)
    const idInputs = renderer.root.findAllByType('input').filter((i: any) => i.props.value === 'p1' && i.props.disabled);
    expect(idInputs.length).toBe(1);
  });

  it('bot table: pack chip opens pack, skill chip opens library, focusSkill prefills palette and consumes', async () => {
    const onOpenPack = vi.fn();
    const onOpenSkill = vi.fn();
    const onFocusConsumed = vi.fn();
    const packs = [{ id: 'p1', name: 'Pack 1', include: ['skill:a'] }];
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(BotAssignmentsTab, {
        bots: [bot({ skills: { include: ['pack:p1', 'skill:b'] } })],
        skills: installedSkills,
        statuses: {},
        onSave: async () => {},
        packs,
        focusSkill: 'b',
        onFocusConsumed,
        onOpenPack,
        onOpenSkill,
      }));
    });
    await flush();
    expect(onFocusConsumed).toHaveBeenCalledTimes(1);
    const root = renderer.root;
    // palette search prefilled with the focused skill
    const search = root.findAllByType('input').find((i: any) => i.props.type === 'text');
    expect(search!.props.value).toBe('b');
    await act(async () => { root.findByProps({ 'data-action': 'open-bot-pack' }).props.onClick(); });
    expect(onOpenPack).toHaveBeenCalledWith('p1');
    await act(async () => { root.findByProps({ 'data-action': 'open-bot-skill' }).props.onClick(); });
    expect(onOpenSkill).toHaveBeenCalledWith('b');
  });

  it('library cards render usage chips wired to pack/bot navigation', async () => {
    mockPageFetch();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(SkillsPage)); });
    await flush();
    const root = renderer.root;
    // skill "a" is in pack p1 (assigned to bot-1): both chips enabled
    const cardA = root.findByProps({ 'data-skill': 'a' });
    const packChip = cardA.findByProps({ 'data-action': 'show-skill-packs' });
    const botChip = cardA.findByProps({ 'data-action': 'show-skill-bots' });
    expect(packChip.props.disabled).toBe(false);
    expect(botChip.props.disabled).toBe(false);
    // skill "b" is unreferenced: chips disabled
    const cardB = root.findByProps({ 'data-skill': 'b' });
    expect(cardB.findByProps({ 'data-action': 'show-skill-packs' }).props.disabled).toBe(true);
    // clicking skill a's pack chip lands on the packs tab with the editor open for p1
    await act(async () => { packChip.props.onClick({ stopPropagation: () => {} }); });
    await flush();
    const idInputs = root.findAllByType('input').filter((i: any) => i.props.value === 'p1' && i.props.disabled);
    expect(idInputs.length).toBe(1);
  });
});

describe('skills review-round semantics', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function statefulFetch(state: { packsMode: 'ok' | 'error' | 'notfound' | 'network'; packs?: SkillPackRow[]; discover?: any }) {
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('/api/skills/discover')) return jsonRes(200, { discovery: state.discover ?? { skills: [] } });
      if (u.startsWith('/api/skill-packs')) {
        if (state.packsMode === 'network') throw new Error('network down');
        if (state.packsMode === 'error') return jsonRes(500, { error: 'boom' });
        if (state.packsMode === 'notfound') return jsonRes(404, { error: 'not_found' });
        return jsonRes(200, { packs: state.packs ?? [packRow()] });
      }
      if (u.startsWith('/api/skills')) {
        return jsonRes(200, { skills: installedSkills, nativeSkillGroups: [], trustProjectSkills: 'off', delivery: 'auto' });
      }
      if (u.startsWith('/api/bots')) return jsonRes(200, { bots: [bot()] });
      return jsonRes(404, { error: 'not_found' });
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('non-404 pack API failure on refresh keeps previous pack data and surfaces packsError', async () => {
    const state = { packsMode: 'ok' as const };
    statefulFetch(state);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(SkillsPage)); });
    await flush();
    const root = renderer.root;
    expect(root.findAllByProps({ 'data-action': 'issue-dangling-skills' })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-packs-error': true })).toHaveLength(0);

    (state as any).packsMode = 'error';
    await act(async () => { root.findByProps({ id: 'skills-refresh' }).props.onClick(); });
    await flush();
    // previous pack graph preserved → badge still derived from p1
    expect(root.findAllByProps({ 'data-action': 'issue-dangling-skills' })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-packs-error': true })).toHaveLength(1);
  });

  it('network failure on packs also preserves data + surfaces packsError', async () => {
    const state = { packsMode: 'ok' as const };
    statefulFetch(state);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(SkillsPage)); });
    await flush();
    (state as any).packsMode = 'network';
    await act(async () => { renderer.root.findByProps({ id: 'skills-refresh' }).props.onClick(); });
    await flush();
    expect(renderer.root.findAllByProps({ 'data-action': 'issue-dangling-skills' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-packs-error': true })).toHaveLength(1);
  });

  it('explicit 404 (older daemon) means "no packs" — no error banner', async () => {
    statefulFetch({ packsMode: 'notfound' });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(SkillsPage)); });
    await flush();
    expect(renderer.root.findAllByProps({ 'data-packs-error': true })).toHaveLength(0);
    // no packs → the pack-derived dangling badge is gone
    expect(renderer.root.findAllByProps({ 'data-action': 'issue-dangling-skills' })).toHaveLength(0);
  });

  it('target skill absent from discovered source → zero preselection + warning, no install call', async () => {
    const fetchMock = statefulFetch({
      packsMode: 'ok',
      discover: { skills: [{ name: 'other-skill', path: 'skills/other' }, { name: 'another', path: 'skills/another' }] },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(SkillsPage)); });
    await flush();
    const root = renderer.root;
    // Arrive via the dangling badge: the inline form is focused with target x-missing.
    await act(async () => { root.findByProps({ 'data-action': 'issue-dangling-skills' }).props.onClick(); });
    await flush();
    const sourceInput = root.findByProps({ 'data-install': 'source' });
    await act(async () => { sourceInput.props.onChange({ currentTarget: { value: 'https://github.com/acme/skills' } }); });
    await act(async () => { root.findByProps({ 'data-action': 'install' }).props.onClick(); });
    await flush();
    // Warning shown, nothing preselected
    expect(JSON.stringify(renderer.toJSON())).toContain('未找到目标 Skill');
    const selectionDialog = root.findByProps({ 'data-install-selection-dialog': true });
    const checkboxes = selectionDialog.findAllByType('input').filter((i: any) => i.props.type === 'checkbox' && !i.props.disabled);
    expect(checkboxes.length).toBeGreaterThan(0);
    for (const cb of checkboxes.filter((c: any) => c.props.checked !== undefined && typeof c.props.onChange === 'function' && c.props.checked !== false)) {
      // only the select-all box may exist unchecked; no candidate is checked
      expect(cb.props.checked).toBe(false);
    }
    const installCalls = fetchMock.mock.calls.filter((c: any) => String(c[0]).startsWith('/api/skills/install'));
    expect(installCalls).toHaveLength(0);
  });

  it('clearing the inline install target removes the sticky prefill', async () => {
    statefulFetch({ packsMode: 'ok' });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(SkillsPage)); });
    await flush();
    const root = renderer.root;
    await act(async () => { root.findByProps({ 'data-action': 'issue-dangling-skills' }).props.onClick(); });
    await flush();
    expect(root.findAllByProps({ 'data-install-target': 'x-missing' })).toHaveLength(1);
    await act(async () => { root.findByProps({ 'data-action': 'clear-install-target' }).props.onClick(); });
    await flush();
    expect(root.findAllByProps({ 'data-install-target': 'x-missing' })).toHaveLength(0);
    expect(root.findAllByProps({ 'data-install': 'source' })).toHaveLength(1);
  });

  it('multiple dangling skills → library name-filter chip with clear', async () => {
    statefulFetch({
      packsMode: 'ok',
      packs: [packRow({ include: ['skill:a', 'skill:x-missing', 'skill:y-missing'], missingSkills: ['x-missing', 'y-missing'] })],
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(SkillsPage)); });
    await flush();
    const root = renderer.root;
    await act(async () => { root.findByProps({ 'data-action': 'issue-dangling-skills' }).props.onClick(); });
    await flush();
    // No wizard for the multi case — a clearable filter instead
    expect(root.findAllByProps({ 'data-install-target': 'x-missing' })).toHaveLength(0);
    const chip = root.findByProps({ 'data-action': 'clear-library-filter' });
    expect(chip.props.title).toContain('x-missing');
    expect(chip.props.title).toContain('y-missing');
    await act(async () => { chip.props.onClick(); });
    expect(root.findAllByProps({ 'data-action': 'clear-library-filter' })).toHaveLength(0);
  });
});

describe('skills first-load pack failure (packsKnown)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function firstLoadFetch(packsMode: 'error' | 'network' | 'notfound') {
    const fn = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.startsWith('/api/skill-packs')) {
        if (packsMode === 'network') throw new Error('network down');
        if (packsMode === 'error') return jsonRes(500, { error: 'boom' });
        return jsonRes(404, { error: 'not_found' });
      }
      if (u.startsWith('/api/skills')) {
        return jsonRes(200, { skills: installedSkills, nativeSkillGroups: [], trustProjectSkills: 'off', delivery: 'auto' });
      }
      if (u.startsWith('/api/bots')) return jsonRes(200, { bots: [bot()] });
      return jsonRes(404, { error: 'not_found' });
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('FIRST request 500 → error banner, but NO bots-missing badge and NO healthy badge (health unknown)', async () => {
    firstLoadFetch('error');
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(SkillsPage)); });
    await flush();
    const root = renderer.root;
    expect(root.findAllByProps({ 'data-packs-error': true })).toHaveLength(1);
    // bot-1 references pack:p1 — unresolvable, not "missing capabilities"
    expect(root.findAllByProps({ 'data-action': 'issue-bots-missing' })).toHaveLength(0);
    expect(root.findAllByProps({ 'data-skills-healthy': true })).toHaveLength(0);
    // bot table shows the unknown health label
    const botsTab = root.findAllByType('button').find((b: any) => b.props.children === 'Bot 分配')!;
    await act(async () => { botsTab.props.onClick(); });
    expect(JSON.stringify(renderer.toJSON())).toContain('未知（专项包数据未加载）');
  });

  it('FIRST request network error → same unknown semantics', async () => {
    firstLoadFetch('network');
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(SkillsPage)); });
    await flush();
    expect(renderer.root.findAllByProps({ 'data-packs-error': true })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-action': 'issue-bots-missing' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-skills-healthy': true })).toHaveLength(0);
  });

  it('FIRST request 404 is definitive: pack refs ARE broken → bots-missing badge appears', async () => {
    firstLoadFetch('notfound');
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(SkillsPage)); });
    await flush();
    expect(renderer.root.findAllByProps({ 'data-packs-error': true })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-action': 'issue-bots-missing' })).toHaveLength(1);
  });

  it('packs tab under unknown state shows "unavailable", not the "no packs yet" empty state', async () => {
    firstLoadFetch('error');
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(SkillsPage)); });
    await flush();
    const root = renderer.root;
    const packsTab = root.findAllByType('button').find((b: any) => b.props.children === '专项包')!;
    await act(async () => { packsTab.props.onClick(); });
    expect(root.findAllByProps({ 'data-packs-unknown': true })).toHaveLength(1);
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).not.toContain('还没有专项包');
  });
});

describe('skills polish: dangling install rows + unknown-state display', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('multi-dangling filter renders actionable install rows; clicking opens wizard with that target', async () => {
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('/api/skill-packs')) {
        return jsonRes(200, { packs: [packRow({ include: ['skill:a', 'skill:x-missing', 'skill:y-missing'], missingSkills: ['x-missing', 'y-missing'] })] });
      }
      if (u.startsWith('/api/skills')) return jsonRes(200, { skills: installedSkills, nativeSkillGroups: [], trustProjectSkills: 'off', delivery: 'auto' });
      if (u.startsWith('/api/bots')) return jsonRes(200, { bots: [bot()] });
      return jsonRes(404, {});
    });
    vi.stubGlobal('fetch', fn);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(SkillsPage)); });
    await flush();
    const root = renderer.root;
    await act(async () => { root.findByProps({ 'data-action': 'issue-dangling-skills' }).props.onClick(); });
    await flush();
    // Both dangling skills are visible as installable rows
    expect(root.findAllByProps({ 'data-missing-skill': 'x-missing' })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-missing-skill': 'y-missing' })).toHaveLength(1);
    // Clicking install on y-missing opens the wizard targeted at it — no write calls
    const row = root.findByProps({ 'data-missing-skill': 'y-missing' });
    await act(async () => { row.findByProps({ 'data-action': 'install-dangling-skill' }).props.onClick(); });
    await flush();
    expect(root.findAllByProps({ 'data-install-target': 'y-missing' })).toHaveLength(1);
    const writes = fn.mock.calls.filter((c: any) => c[1]?.method && c[1].method !== 'GET');
    expect(writes).toHaveLength(0);
  });

  it('unknown pack state: no fake zeros, neutral chips, first-load banner copy', async () => {
    const fn = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.startsWith('/api/skill-packs')) return jsonRes(500, { error: 'boom' });
      if (u.startsWith('/api/skills')) return jsonRes(200, { skills: installedSkills, nativeSkillGroups: [], trustProjectSkills: 'off', delivery: 'auto' });
      if (u.startsWith('/api/bots')) return jsonRes(200, { bots: [bot()] });
      return jsonRes(404, {});
    });
    vi.stubGlobal('fetch', fn);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(SkillsPage)); });
    await flush();
    const root = renderer.root;
    let rendered = JSON.stringify(renderer.toJSON());
    // First-load copy, not "previous data retained"
    expect(rendered).toContain('尚未成功加载过');
    expect(rendered).not.toContain('已保留上次数据');
    // Library usage chip reads "? 包", not "0 包"
    expect(rendered).toContain('? 包');
    // Bot table: final count is —, pack chip neutral (unknown), not missing-red
    const botsTab = root.findAllByType('button').find((b: any) => b.props.children === 'Bot 分配')!;
    await act(async () => { botsTab.props.onClick(); });
    rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('skills-chip-unknown');
    expect(rendered).not.toContain('skills-chip-missing');
    const row = root.findAllByProps({ 'data-action': 'open-bot-pack' });
    expect(row[0].props.title).toBeTruthy();
    // Packs tab header count is —
    const packsTab = root.findAllByType('button').find((b: any) => b.props.children === '专项包')!;
    await act(async () => { packsTab.props.onClick(); });
    expect(root.findAllByProps({ 'data-packs-unknown': true })).toHaveLength(1);
  });
});

describe('install source is sent verbatim (backend owns classification)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('does not rewrite the pasted source and fires no install on navigation/prefill', async () => {
    const fn = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.startsWith('/api/skills/discover')) return jsonRes(200, { discovery: { skills: [
        { name: 'deploy', path: 'skills/deploy' },
        { name: 'review', path: 'skills/review' },
      ] } });
      if (u.startsWith('/api/skill-packs')) return jsonRes(200, { packs: [packRow()] });
      if (u.startsWith('/api/skills')) return jsonRes(200, { skills: installedSkills, nativeSkillGroups: [], trustProjectSkills: 'off', delivery: 'auto' });
      if (u.startsWith('/api/bots')) return jsonRes(200, { bots: [bot()] });
      return jsonRes(404, {});
    });
    vi.stubGlobal('fetch', fn);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(SkillsPage)); });
    await flush();
    const root = renderer.root;

    // Navigating to the install entry from a dangling skill must not install.
    await act(async () => { root.findByProps({ 'data-action': 'issue-dangling-skills' }).props.onClick(); });
    await flush();
    expect(fn.mock.calls.filter((c: any) => String(c[0]).startsWith('/api/skills/install'))).toHaveLength(0);

    // Type an agentbuddy identifier into the single-page form and scan.
    const sourceInput = root.findByProps({ 'data-install': 'source' });
    await act(async () => { sourceInput.props.onChange({ currentTarget: { value: 'agentbuddy:acme/deploy' } }); });
    await act(async () => { root.findByProps({ 'data-action': 'install' }).props.onClick(); });
    await flush();

    const discoverCall = fn.mock.calls.find((c: any) => String(c[0]).startsWith('/api/skills/discover'));
    expect(discoverCall).toBeDefined();
    // Verbatim: no `git+` prefix, no `github:` rewrite, no trimming of intent.
    expect(JSON.parse(String((discoverCall as any)[1].body)).source).toBe('agentbuddy:acme/deploy');
  });

  it('single-page form keeps deep-scan discovery and immediate install in the same fullDepth mode', async () => {
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('/api/skills/discover')) {
        return jsonRes(200, { discovery: {
          skills: [{ name: 'nested-only', path: 'skills/category/nested-only' }],
          deepScanned: true,
        } });
      }
      if (u.startsWith('/api/skills/install')) {
        return jsonRes(200, { job: {
          id: 'job-1',
          status: 'succeeded',
          skills: [{ name: 'nested-only' }],
        } });
      }
      if (u.startsWith('/api/skill-packs')) return jsonRes(200, { packs: [] });
      if (u.startsWith('/api/skills')) return jsonRes(200, { skills: installedSkills, nativeSkillGroups: [], trustProjectSkills: 'off', delivery: 'auto' });
      if (u.startsWith('/api/bots')) return jsonRes(200, { bots: [bot({ skills: { include: [] } })] });
      return jsonRes(404, {});
    });
    vi.stubGlobal('fetch', fn);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(SkillsPage)); });
    await flush();
    const root = renderer.root;

    expect(root.findAllByProps({ 'data-install': 'source' })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-install': 'path' })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-install': 'ref' })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-install': 'full-depth' })).toHaveLength(1);
    expect(root.findAllByProps({ className: 'skills-install-wizard' })).toHaveLength(0);

    await act(async () => {
      root.findByProps({ 'data-install': 'source' }).props.onChange({ currentTarget: { value: 'https://github.com/acme/nested-skills' } });
    });
    await act(async () => { root.findByProps({ 'data-action': 'install' }).props.onClick(); });
    await flush();

    const installCall = fn.mock.calls.find((call: any) => String(call[0]).startsWith('/api/skills/install'));
    expect(installCall).toBeDefined();
    expect(JSON.parse(String((installCall as any)[1].body))).toMatchObject({
      source: 'https://github.com/acme/nested-skills',
      skillNames: ['nested-only'],
      fullDepth: true,
    });
  });
});
