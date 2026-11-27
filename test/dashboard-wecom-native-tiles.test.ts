/**
 * The WeCom-only tiles of the Bot configuration page after their convergence
 * onto the Feishu ones, rendered for real:
 *  - which WeCom-only blocks the card shows, per tab, and where;
 *  - 「授权与额度」: the default access duration as the four Feishu choices,
 *    a configured value off those choices shown as it is and not rewritten;
 *    the message quota limited to 1–1000 (an earlier larger value kept);
 *  - the three talk-command checkboxes in the shared 「Slash 命令」 tile;
 *  - the hand-over targets the Dashboard lists for 「额度耗尽交接」: only the
 *    connections that accept this one, by id and name, never their users.
 */
import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BOT_PROFILE_SHARED_PARTS } from '../src/dashboard/web/bot-defaults-page.js';
import { WecomBotDefaultsCard } from '../src/dashboard/web/wecom-bot-defaults-card.js';
import { WecomNativeCoreSection, WecomTalkCommandsSection } from '../src/dashboard/web/wecom-native-core-section.js';
import { t, ui } from '../src/dashboard/web/ui.js';
import { WecomDashboardConfig } from '../src/dashboard/wecom/config.js';
import { handleWecomConnectionsApi } from '../src/dashboard/wecom/api.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import type { WecomNativeCoreConfig } from '../src/im/wecom/config/native-core-config.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let renderer: TestRenderer.ReactTestRenderer | undefined;
const dirs: string[] = [];
// The dropdown (base-ui) makes instanceof checks in a layout effect; the test renderer has no DOM constructors.
class FakeElement {}
class FakeHTMLElement extends FakeElement {}
beforeEach(() => {
  vi.stubGlobal('Element', FakeElement);
  vi.stubGlobal('HTMLElement', FakeHTMLElement);
  vi.stubGlobal('window', { Element: FakeElement, HTMLElement: FakeHTMLElement, localStorage: { getItem: () => null, setItem: () => {} } });
  vi.stubGlobal('document', { documentElement: {}, addEventListener: () => {}, removeEventListener: () => {} });
  ui.setLocale('zh');
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(child => textOf(child as ReactTestInstance | string)).join('');
const hasClass = (node: ReactTestInstance, name: string) => String(node.props.className ?? '').split(/\s+/).includes(name);

async function render(element: React.ReactElement): Promise<ReactTestInstance> {
  await act(async () => { renderer = TestRenderer.create(element); });
  return renderer!.root;
}

async function click(root: ReactTestInstance, action: string): Promise<void> {
  await act(async () => { root.findByProps({ 'data-action': action }).props.onClick(); });
  await act(async () => { await new Promise(done => setTimeout(done, 0)); });
}

describe('the WeCom-only blocks of the card', () => {
  it('are /summary on the sessions tab, 授权与额度 (with the talk commands in the shared Slash tile) on security, the terminal switch on cards, the quota-limit hand-over on advanced', async () => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      const body = url.endsWith('/config')
        ? { editable: true, revision: 'r1', cli: 'codex', model: '', backend: 'pty', workingDirectory: '/workspace', botConfig: {}, allowedUsers: ['owner'], blockedUsers: [], role: { content: '', injectMode: 'every' }, native: {} }
        : url.endsWith('/fallback-peers') ? { peers: [], trusting: true } : { status: 'unknown', models: [] };
      return { ok: true, status: 200, json: async () => body };
    });
    const root = await render(React.createElement(WecomBotDefaultsCard, {
      shared: BOT_PROFILE_SHARED_PARTS,
      connection: { id: 'a'.repeat(64), label: 'WeCom', configuration: 'ready', ownership: 'dashboard', gateway: 'stopped' } as any,
      cliState: { options: [{ id: 'codex', label: 'Codex' }] } as any,
      activeTab: 'common',
      onTabChange: vi.fn(),
      onRefresh: vi.fn(),
      onAction: vi.fn(),
    }));
    const blocks: string[] = [];
    for (const tab of ['common', 'sessions', 'security', 'cards', 'advanced']) {
      const panel = root.find(node => node.type === 'div' && node.props.id === `bd-panel-${tab}`);
      for (const block of panel.findAll(node => node.type === 'section' && node.props['data-provider-only'] === 'wecom')) {
        let tile: ReactTestInstance | null = block;
        while (tile && !(tile.type === 'section' && hasClass(tile, 'bd-tile'))) tile = tile.parent;
        const where = tile === block ? 'own tile' : `in ${String(tile?.props.id)}`;
        blocks.push(`${tab}: ${textOf(block.findAll(node => node.type === 'h3')[0]!)} (${where})`);
      }
    }
    expect(blocks).toEqual([
      `sessions: ${t('botDefaults.wecom.platform.sessionsTitle')} (own tile)`,
      `security: ${t('botDefaults.wecom.core.securityTitle')} (own tile)`,
      `security: ${t('botDefaults.wecom.core.canTalkDaemonCommands')} (in bd-section-slash-commands)`,
      `cards: ${t('botDefaults.wecom.core.cardsTitle')} (own tile)`,
      `advanced: ${t('botDefaults.wecom.core.advancedTitle')} (own tile)`,
    ]);
    // The shared card tile lists the WeCom card buttons and no stand-in ("代答") button, under no Feishu or raw label.
    const cardTile = textOf(root.find(node => node.type === 'section' && node.props.id === 'bd-section-card-behavior'));
    expect(cardTile).toContain(t('botDefaults.streamingButton.terminal'));
    expect(cardTile).not.toContain(t('botDefaults.streamingButton.substitute'));
    expect(textOf(root)).not.toMatch(/botDefaults\.[A-Za-z]/);
    // 授权与额度 has its seven settings: five switches, the duration choice and the quota.
    const grant = root.find(node => node.type === 'section' && node.props.id === 'bd-section-wecom-core-security');
    expect(grant.findAll(node => node.type === 'label' && hasClass(node, 'toggle-row'))).toHaveLength(5);
    expect(grant.findAll(node => typeof node.type !== 'string' && node.props.dataInput === 'wecomGrantDefaultDuration' && Array.isArray(node.props.options))).toHaveLength(1);
    expect(grant.findAll(node => node.type === 'input' && node.props.type === 'number')).toHaveLength(1);
  });
});

describe('授权与额度', () => {
  const HOUR = 3_600_000;
  const security = async (value: WecomNativeCoreConfig) => {
    const save = vi.fn(async (_patch: { native: WecomNativeCoreConfig }) => {});
    const root = await render(React.createElement(WecomNativeCoreSection, { connectionId: 'a'.repeat(64), value, save, tab: 'security' }));
    const duration = () => root.find(node => typeof node.type !== 'string' && node.props.dataInput === 'wecomGrantDefaultDuration' && Array.isArray(node.props.options));
    const quota = () => root.find(node => node.type === 'input' && node.props.type === 'number');
    return { root, save, duration, quota };
  };

  // Mutation: snapping a configured duration to the nearest choice (or dropping the extra option) turns this red.
  it('offers the four Feishu durations, shows a configured value off them as it is, and keeps it on a save', async () => {
    const off = await security({ grantDefaultDurationMs: 1.5 * HOUR });
    expect(off.duration().props.value).toBe(String(1.5 * HOUR));
    expect(off.duration().props.options.map((option: { value: string }) => option.value))
      .toEqual([HOUR, 8 * HOUR, 24 * HOUR, 7 * 24 * HOUR, 1.5 * HOUR].map(String));
    await click(off.root, 'save-wecom-core-security');
    expect(off.save.mock.calls[0]![0].native.grantDefaultDurationMs).toBe(1.5 * HOUR);
  });

  it('shows one hour when nothing is configured, writes nothing for it, and saves another choice', async () => {
    const unset = await security({});
    expect(unset.duration().props.value).toBe(String(HOUR));
    expect(unset.duration().props.options).toHaveLength(4);
    await click(unset.root, 'save-wecom-core-security');
    expect(unset.save.mock.calls[0]![0].native).not.toHaveProperty('grantDefaultDurationMs');
    await act(async () => { unset.duration().props.onChange(String(24 * HOUR)); });
    await click(unset.root, 'save-wecom-core-security');
    expect(unset.save.mock.calls[1]![0].native.grantDefaultDurationMs).toBe(24 * HOUR);
  });

  // Mutation: raising the page's bound above 1000 turns this red.
  it('takes a message quota from 1 to 1000, refuses others, and keeps a larger value an earlier version allowed', async () => {
    const h = await security({});
    for (const refused of ['1001', '0', '2.5']) {
      await act(async () => { h.quota().props.onChange({ target: { value: refused } }); });
      await click(h.root, 'save-wecom-core-security');
    }
    expect(h.save).not.toHaveBeenCalled();
    await act(async () => { h.quota().props.onChange({ target: { value: '1000' } }); });
    await click(h.root, 'save-wecom-core-security');
    expect(h.save.mock.calls.at(-1)![0].native.messageQuotaDefaultLimit).toBe(1000);
    expect(h.quota().props.max).toBe('1000');

    const legacy = await security({ messageQuotaDefaultLimit: 5000 });
    await click(legacy.root, 'save-wecom-core-security');
    expect(legacy.save.mock.calls[0]![0].native.messageQuotaDefaultLimit).toBe(5000);
  });
});

describe('对话权限用户可用的命令', () => {
  const talk = async (value?: WecomNativeCoreConfig) => {
    const save = vi.fn(async (_patch: { native: WecomNativeCoreConfig }) => {});
    const root = await render(React.createElement(WecomTalkCommandsSection, { value, save }));
    const boxes = () => root.findAll(node => node.type === 'input' && node.props.type === 'checkbox');
    const checked = () => boxes().filter(box => box.props.checked).map(box => textOf(box.parent!).trim());
    const toggle = async (command: string, on: boolean) => {
      const box = boxes().find(candidate => textOf(candidate.parent!).trim() === command)!;
      await act(async () => { box.props.onChange({ currentTarget: { checked: on } }); });
    };
    return { root, save, checked, boxes, toggle };
  };

  // Mutation: a different default when nothing is configured, or saving the boxes as shown before the change, turns this red.
  it('shows /status and /stop checked when nothing is configured and saves what is checked, in a fixed order', async () => {
    const h = await talk();
    expect(h.boxes()).toHaveLength(3);
    expect(h.checked()).toEqual(['/status', '/stop']);
    await h.toggle('/restart', true);
    await h.toggle('/stop', false);
    await click(h.root, 'save-wecom-core-talk-commands');
    expect(h.save).toHaveBeenCalledWith({ native: { canTalkDaemonCommands: ['/status', '/restart'] } });
  });

  it('shows the configured commands, an empty list as nothing checked', async () => {
    expect((await talk({ canTalkDaemonCommands: ['/restart'] })).checked()).toEqual(['/restart']);
    await act(async () => renderer?.unmount());
    const none = await talk({ canTalkDaemonCommands: [] });
    expect(none.checked()).toEqual([]);
    await click(none.root, 'save-wecom-core-talk-commands');
    expect(none.save).toHaveBeenCalledWith({ native: { canTalkDaemonCommands: [] } });
  });
});

describe('the hand-over targets of 额度耗尽交接', () => {
  /** Four connections of one host, each with its own configuration file; `self` hands over. */
  function host() {
    const root = mkdtempSync(join(tmpdir(), 'wecom-fallback-peers-'));
    dirs.push(root);
    const files: string[] = [];
    const connection = (name: string, allowedUsers: string[], native: Record<string, unknown> = {}) => {
      const file = join(root, `${name}.json`);
      files.push(file);
      writeFileSync(file, JSON.stringify({ botId: `${name}-bot`, displayName: `${name} bot`, secretEnv: 'FAKE_WECOM_SECRET', coreUrl: 'http://127.0.0.1:19901', allowedUsers, native }));
      return wecomConfigId(file);
    };
    const accepting = connection('accepting', ['alice', 'bob-secret-user']);
    const stranger = connection('stranger', ['carol-secret-user']);
    const distrusting = connection('distrusting', ['alice'], { trustSameOwnerBots: false });
    const self = connection('self', ['alice'], { quotaFallbackBot: { enabled: true, peerId: stranger, kinds: ['usage'] } });
    writeFileSync(join(root, 'config-registry.json'), JSON.stringify({ version: 1, paths: files }));
    return { root, self, accepting, stranger, distrusting };
  }

  // Mutation: listing every other connection, or adding its configuration to the answer, turns this red.
  it('lists only the connections that accept this one, by id and name, and says the configured one is not accepted', () => {
    const h = host();
    const answer = new WecomDashboardConfig(h.root).fallbackPeers(h.self);
    expect(answer).toEqual({
      peers: [{ id: h.accepting, name: 'accepting bot' }],
      current: { id: h.stranger, name: 'stranger bot', accepted: false },
      trusting: true,
    });
    expect(JSON.stringify(answer)).not.toMatch(/alice|secret-user/);
  });

  it('is served to the host admin only, on the connection\'s own path', async () => {
    const h = host();
    const configuration = new WecomDashboardConfig(h.root);
    const call = async (hostAdmin: boolean) => {
      let status = 0;
      let body = '';
      const res = { writeHead: (code: number) => { status = code; }, setHeader: () => {}, end: (text: string) => { body = text; } } as unknown as ServerResponse;
      const url = new URL(`http://127.0.0.1/api/wecom/connections/${h.self}/fallback-peers`);
      await handleWecomConnectionsApi({ method: 'GET' } as IncomingMessage, res, url, { hostAdmin, csrfValid: false, configuration: configuration as any });
      return { status, body: body ? JSON.parse(body) : undefined };
    };
    expect(await call(false)).toMatchObject({ status: 403 });
    const allowed = await call(true);
    expect(allowed.status).toBe(200);
    expect(allowed.body.peers).toEqual([{ id: h.accepting, name: 'accepting bot' }]);
  });
});
