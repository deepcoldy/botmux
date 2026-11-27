import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  botDefaultsSectionDomId, botEffectiveSummary, botModifiedSectionIds, type BotDefaultsRow,
} from '../src/dashboard/web/bot-defaults.js';
import { BotDefaultsPage } from '../src/dashboard/web/bot-defaults-page.js';
import { t } from '../src/dashboard/web/ui.js';

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
const maple: BotDefaultsRow = { larkAppId: 'demo-maple', botName: 'Maple', cliId: 'claude-code' };

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
