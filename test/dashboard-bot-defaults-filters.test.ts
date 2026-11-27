import { Fragment, createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  botDefaultsSectionDomId, botEffectiveSummary, botModifiedSectionIds, type BotDefaultsRow,
} from '../src/dashboard/web/bot-defaults.js';
import { BdTabGrid, BotDefaultsPage } from '../src/dashboard/web/bot-defaults-page.js';
import { t } from '../src/dashboard/web/ui.js';
import { DEFAULT_SESSION_OWNER_REMINDER } from '../src/core/session-owner-reminder-config.js';
import { botDefaultsPayload, sparseOverridesFromRawBotConfig } from '../src/dashboard/bot-payload.js';

const cedar: BotDefaultsRow = {
  larkAppId: 'demo-cedar', botName: 'Cedar', cliId: 'codex', model: 'gpt-5',
  reasoningEffort: 'high', defaultWorkingDir: '/projects/demo', sandboxMode: 'oncall',
  ownerGroupFollow: {
    enabled: true,
    includeRules: [{ field: 'name', op: 'contains', pattern: 'Studio' }],
    excludeRules: [{ field: 'name', op: 'contains', pattern: 'Archive' }],
  },
  startupCommands: 'pnpm --version',
};
const maple: BotDefaultsRow = {
  larkAppId: 'demo-maple', botName: 'Maple', cliId: 'claude-code',
  commandTriggersConfigured: false, blockedUsersConfigured: false,
};

describe('Bot settings summaries', () => {
  it('summarizes manual, default directory and on-call configurations', () => {
    expect(botEffectiveSummary(maple)).toEqual({
      cli: 'claude-code', model: null, autoModel: false, workingDirMode: 'manual', sandbox: 'off',
      followEnabled: false, followRuleCount: 0,
    });
    expect(botEffectiveSummary(cedar)).toMatchObject({
      cli: 'codex', model: 'gpt-5', workingDirMode: 'default', sandbox: 'oncall',
      followEnabled: true, followRuleCount: 2,
    });
    expect(botEffectiveSummary({
      ...cedar, defaultOncall: { enabled: true }, effectiveSandboxMode: 'scratch', ownerGroupFollow: { enabled: true },
    })).toMatchObject({ workingDirMode: 'oncall', sandbox: 'scratch', followEnabled: true, followRuleCount: 0 });
  });

  it('uses daemon sandbox state, supports legacy rows and omits local-only settings when unavailable', () => {
    expect(botEffectiveSummary({ ...maple, sandbox: true }).sandbox).toBe('oncall');
    expect(botEffectiveSummary({ ...maple, sandboxMode: 'off', readIsolation: true }).sandbox).toBe('oncall');
    expect(botEffectiveSummary({ ...cedar, sandboxEnvForce: 'scratch' }).sandbox).toBe('scratch');
    expect(botEffectiveSummary({ ...cedar, sandboxEnvForce: 'scratch', effectiveSandboxMode: 'off' }).sandbox).toBe('off');
    expect(botEffectiveSummary({ ...cedar, cliId: 'riff', apiOnly: true })).toMatchObject({
      sandbox: 'off', followEnabled: false, followRuleCount: 0,
    });
    expect(botEffectiveSummary({ larkAppId: 'legacy' }, 'codex').cli).toBe('codex');
  });

  it('covers overrides across tabs and distinguishes daemon defaults from Bot overrides', () => {
    expect([...botModifiedSectionIds({
      ...maple, p2pMode: 'chat', replyCardMode: 'legacy', usageDisplay: 'streaming',
      streamingCardFoldedLayout: true, autoInviteOwnerOnGroupAdd: true, botToBotSameDir: true,
      replyDelivery: 'transcript', replyDeliveryDefault: 'transcript', sandboxMode: 'off',
      effectiveSandboxMode: 'scratch', replyStyle: {}, ownerGroupFollow: { enabled: false },
      sessionOwnerReminder: DEFAULT_SESSION_OWNER_REMINDER,
      hiddenStreamingCardButtons: [], autoGrantRequestCards: true,
    })]).toEqual([]);
    const modified = botModifiedSectionIds({
      ...cedar, triggerUserAuth: { enabled: true }, streamingCardFoldedLayout: false,
      hideLocalAddresses: true, replyDelivery: 'transcript', replyDeliveryDefault: 'send',
      promptCache: { keepalive: { enabled: false } }, archiveCodex: false, larkToolBinding: false,
      commandTriggersConfigured: true, blockedUsersConfigured: true,
    });
    expect(modified).toEqual(new Set([
      'agent', 'working-dir', 'command-trigger', 'codex-archive', 'prompt-cache', 'startup-commands', 'sandbox',
      'trigger-user-auth', 'lark-tool-binding', 'blocked-users', 'card-behavior', 'local-address', 'reply-delivery',
    ]));
  });

  it('treats resolved owner-reminder defaults as unmodified and preserves offline overrides', () => {
    const online = botDefaultsPayload({ larkAppId: 'owner-default' }, {
      sessionOwnerReminder: DEFAULT_SESSION_OWNER_REMINDER,
      commandTriggersConfigured: false,
      blockedUsersConfigured: false,
    }) as BotDefaultsRow;
    expect(botModifiedSectionIds(online).has('owner-reminder')).toBe(false);

    const saved = { ...DEFAULT_SESSION_OWNER_REMINDER, enabled: true };
    const offline = botDefaultsPayload(
      { larkAppId: 'owner-offline' },
      sparseOverridesFromRawBotConfig({ sessionOwnerReminder: saved }),
    ) as BotDefaultsRow;
    expect(offline.sessionOwnerReminder).toEqual(saved);
    expect(botModifiedSectionIds(offline).has('owner-reminder')).toBe(true);
  });

  it('recognizes explicit standard, topic stop, and a preserved oncall directory as customized', () => {
    expect(botModifiedSectionIds({ ...maple, modelBackendVariant: 'standard' }), 'explicit Standard')
      .toContain('agent');
    expect(botModifiedSectionIds({ ...maple, topicUnavailablePolicy: 'stop' }), 'topic Stop')
      .toContain('reply-delivery');
    expect(botModifiedSectionIds({
      ...maple, defaultOncall: { enabled: false, workingDir: '/repo/x', since: 1 },
    }), 'preserved Oncall directory').toContain('working-dir');
    expect(botModifiedSectionIds({
      ...maple, defaultOncall: { enabled: false, workingDir: '', since: 0 },
    }), 'pristine Oncall state').not.toContain('working-dir');
  });

  it('fails open when an older daemon cannot report trigger or blocked-user configuration', () => {
    const unknown = botModifiedSectionIds({
      ...maple, commandTriggersConfigured: undefined, blockedUsersConfigured: undefined,
    });
    expect([...unknown]).toEqual(expect.arrayContaining(['command-trigger', 'blocked-users']));
    const empty = botModifiedSectionIds({
      ...maple, commandTriggersConfigured: false, blockedUsersConfigured: false,
    });
    expect(empty).not.toContain('command-trigger');
    expect(empty).not.toContain('blocked-users');
  });
});

describe('BdTabGrid filter with capability-gated Fragment children', () => {
  let renderer: ReactTestRenderer;
  const tile = (id: string) => createElement('section', { className: 'bd-tile', id: botDefaultsSectionDomId(id), key: id }, id);
  const noopFilter = { query: '', modifiedIds: null as ReadonlySet<string> | null, onClear: () => {} };

  afterEach(() => { renderer?.unmount(); });

  function hidden(id: string): boolean | undefined {
    return renderer.root.findByProps({ id: botDefaultsSectionDomId(id) }).props.hidden;
  }
  function emptyShown(): number {
    return renderer.root.findAllByProps({ 'data-bd-filter-empty': true }).length;
  }

  it('applies a text search to tiles nested inside a Fragment', () => {
    const children = createElement(Fragment, null, tile('owner-reminder'), tile('prompt-injection'));
    act(() => {
      renderer = TestRenderer.create(createElement(BdTabGrid, {
        filter: { ...noopFilter, query: t('botDefaults.ownerReminderTitle') },
      }, children));
    });
    expect(hidden('owner-reminder')).toBe(false);
    expect(hidden('prompt-injection')).toBe(true);
    expect(emptyShown()).toBe(0);
  });

  it('reports the empty state only when every Fragment tile is filtered out', () => {
    const children = createElement(Fragment, null, tile('owner-reminder'), tile('prompt-injection'));
    act(() => {
      renderer = TestRenderer.create(createElement(BdTabGrid, {
        filter: { ...noopFilter, query: 'zzz-no-such-setting-xyz' },
      }, children));
    });
    expect(hidden('owner-reminder')).toBe(true);
    expect(hidden('prompt-injection')).toBe(true);
    expect(emptyShown()).toBe(1);
  });

  it('applies modified-only to Fragment tiles and keeps direct children in the same walk', () => {
    const children = [
      createElement(Fragment, { key: 'g' }, tile('owner-reminder'), tile('prompt-injection')),
      null,
      false,
      tile('backend'),
    ];
    act(() => {
      renderer = TestRenderer.create(createElement(BdTabGrid, {
        filter: { ...noopFilter, modifiedIds: new Set(['owner-reminder', 'backend']) },
      }, children));
    });
    expect(hidden('owner-reminder')).toBe(false);
    expect(hidden('prompt-injection')).toBe(true);
    expect(hidden('backend')).toBe(false);
    act(() => {
      renderer.update(createElement(BdTabGrid, {
        filter: { ...noopFilter, modifiedIds: new Set() },
      }, children));
    });
    expect(hidden('owner-reminder')).toBe(true);
    expect(hidden('backend')).toBe(true);
  });
});

describe('BotDefaultsPage summary and filters', () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/api/bots') return Response.json({ bots: [cedar, maple] });
      if (path === '/api/agents') return Response.json({ agents: [], links: {} });
      return Response.json({ ok: true });
    }));
  });

  async function mount() {
    await act(async () => { renderer = TestRenderer.create(createElement(BotDefaultsPage)); });
  }

  afterEach(async () => {
    if (renderer) await act(async () => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  function tile(id: string) {
    return renderer.root.findByProps({ id: botDefaultsSectionDomId(id) });
  }

  function click(props: Record<string, string>) {
    return act(async () => { renderer.root.findByProps(props).props.onClick(); });
  }

  function input(value: string) {
    return act(async () => {
      renderer.root.findByProps({ 'data-input': 'botDefaultsFilter' }).props.onChange({ currentTarget: { value } });
    });
  }

  it('matches titles and translated field labels, combines filters and clears no results', async () => {
    await mount();
    await input(t('botDefaults.ownerGroupFollowEnabled').toLocaleUpperCase());
    expect(tile('working-dir').props.hidden).toBe(false);
    expect(tile('agent').props.hidden).toBe(true);
    await input(t('botDefaults.sectionRole'));
    expect(tile('role').props.hidden).toBe(false);
    await click({ 'data-action': 'bot-defaults-modified-only' });
    expect(tile('role').props.hidden).toBe(true);
    expect(renderer.root.findByProps({ 'data-bd-filter-empty': true })).toBeDefined();
    await click({ 'data-action': 'bot-defaults-clear-filter' });
    expect(tile('role').props.hidden).toBeFalsy();
    expect(renderer.root.findByProps({ 'data-input': 'botDefaultsFilter' }).props.value).toBe('');
    expect(renderer.root.findByProps({ 'data-action': 'bot-defaults-modified-only' }).props['aria-pressed']).toBe(false);
  });

  it('keeps mounted drafts and reapplies the modified filter to the selected Bot', async () => {
    await mount();
    const titleInput = { 'data-input': 'ownerGroupFollowRulePattern' };
    const pattern = () => renderer.root.findAllByProps(titleInput)[0]!;
    expect(pattern().props.value).toBe('Studio');
    await act(async () => { pattern().props.onChange({ currentTarget: { value: 'Studio Draft' } }); });
    await input('missing query');
    expect(tile('working-dir').props.hidden).toBe(true);
    await click({ 'data-action': 'bot-defaults-clear-filter' });
    expect(pattern().props.value).toBe('Studio Draft');
    await click({ 'data-action': 'bot-defaults-modified-only' });
    expect(tile('working-dir').props.hidden).toBe(false);
    await act(async () => {
      renderer.root.find(node => node.props.role === 'button' && node.props['data-appid'] === maple.larkAppId).props.onClick();
    });
    expect(tile('working-dir').props.hidden).toBe(true);
    expect(renderer.root.findByProps({ 'data-action': 'bot-defaults-modified-only' }).props['aria-pressed']).toBe(true);
  });

  it('reveals the target tab and scrolls to the indexed setting when a summary item is clicked', async () => {
    const scrollIntoView = vi.fn();
    const sandbox = { scrollIntoView, style: {}, offsetWidth: 100, classList: { add: vi.fn(), remove: vi.fn() } };
    const getElementById = vi.fn(id => id === botDefaultsSectionDomId('sandbox') ? sandbox : null);
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('window', {
      requestAnimationFrame: (callback: FrameRequestCallback) => { frame = callback; return 1; },
      cancelAnimationFrame: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
      setTimeout: vi.fn(), matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal('document', { getElementById, querySelector: () => null });
    await mount();
    await input('missing query');
    await click({ 'data-bd-summary': 'sandbox' });
    expect(renderer.root.findByProps({ id: 'bd-tab-security' }).props['aria-selected']).toBe(true);
    expect(tile('sandbox').props.hidden).toBeFalsy();
    expect(renderer.root.findByProps({ 'data-input': 'botDefaultsFilter' }).props.value).toBe('');
    expect(frame).toBeDefined();
    await act(async () => { frame!(0); });
    expect(getElementById).toHaveBeenCalledWith(botDefaultsSectionDomId('sandbox'));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });
});
