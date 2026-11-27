/**
 * The runtime status of a WeCom connection on its configuration card: the
 * notes that explain a state run by the fleet (in both UI languages, from codes
 * the server sends), and the start / restart / stop buttons, which appear only
 * for a connection the fleet runs or nobody runs.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOT_PROFILE_SHARED_PARTS } from '../src/dashboard/web/bot-defaults-page.js';
import { WecomBotDefaultsCard, wecomRuntimeNotes } from '../src/dashboard/web/wecom-bot-defaults-card.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { t, ui } from '../src/dashboard/web/ui.js';
import { useWecomConnections } from '../src/dashboard/web/wecom-connections-section.js';
import { publishProviderRoster } from '../src/dashboard/web/provider-roster.js';
import type { WecomConnectionDto } from '../src/im/wecom/contract/dashboard-dto.js';
import { WECOM_DESIRED_STOP_REASONS } from '../src/im/wecom/config/fleet-desired-state.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CJK = /[㐀-鿿]/;
const RAW_KEY = /\bbotDefaults\.wecom\.[A-Za-z]+/;

const base: WecomConnectionDto = {
  id: 'a'.repeat(64),
  label: 'WeCom',
  botIdHint: '…abcdef',
  allowedUserCount: 1,
  coreMode: 'managed',
  configuration: 'ready',
  gateway: 'stopped',
  connection: 'unknown',
  ownership: 'fleet',
  canStart: true,
  canStop: true,
  canRestart: false,
};

/** One connection per thing the server can say about a fleet-run connection. */
const variants: WecomConnectionDto[] = [
  ...(['fleet_down', 'fleet_unknown', 'not_in_fleet', 'restarting', 'errored', 'stopped', 'exited'] as const)
    .map(cause => ({ ...base, desired: 'running' as const, notRunning: { cause, exitCode: 1, restarts: 2 } })),
  ...WECOM_DESIRED_STOP_REASONS
    .map(stopReason => ({ ...base, ownership: 'none' as const, desired: 'stopped' as const, stopReason })),
  ...(['legacy_gateway', 'legacy_leftover', 'desired_state_unavailable', 'registry_unavailable', 'stop_pending', 'no_connection_evidence'] as const)
    .map(notice => ({ ...base, notice })),
  ...(['start', 'stop', 'restart'] as const).map(action => ({ ...base, operation: { action, startedAt: 1 } })),
  ...(['start', 'stop', 'restart'] as const).map(action => ({ ...base, lastFailure: { action, reason: 'timeout', message: 'fixture-detail', at: 1 } })),
  { ...base, gateway: 'running', restartRequired: true },
  { ...base, gateway: 'running', configApplyRetrying: true },
];

describe('notes under a WeCom connection\'s runtime status', () => {
  it('explain every state the server reports, in English without Chinese or raw keys, and differently for different states', () => {
    const english = createDashboardTranslator('en');
    const chinese = createDashboardTranslator('zh');
    const seen = new Set<string>();
    for (const connection of variants) {
      const notes = wecomRuntimeNotes(connection, english);
      expect(notes, JSON.stringify(connection)).toHaveLength(1);
      expect(notes[0]).not.toMatch(CJK);
      expect(notes[0]).not.toMatch(RAW_KEY);
      expect(wecomRuntimeNotes(connection, chinese)[0]).toMatch(CJK);
      seen.add(notes[0]);
    }
    expect(seen.size).toBe(variants.length);
  });

  it('names the missing credential variable, in both languages, when the server gives its name', () => {
    const connection = { ...base, ownership: 'none' as const, desired: 'stopped' as const, stopReason: 'credential_env_missing' as const };
    for (const locale of ['en', 'zh'] as const) {
      const translate = createDashboardTranslator(locale);
      const named = wecomRuntimeNotes({ ...connection, credentialEnv: 'WECOM_BOT_SECRET' }, translate)[0];
      const unnamed = wecomRuntimeNotes(connection, translate)[0];
      expect(named).toContain('WECOM_BOT_SECRET');
      expect(unnamed).not.toMatch(/\{name\}/);
      expect(unnamed).not.toMatch(RAW_KEY);
    }
  });

  it('says nothing for a plain running or stopped connection, leaving the server\'s own message to be shown', () => {
    expect(wecomRuntimeNotes({ ...base, gateway: 'running', connection: 'connected' }, createDashboardTranslator('en'))).toEqual([]);
    expect(wecomRuntimeNotes({ ...base, ownership: 'external', message: 'server text' }, createDashboardTranslator('en'))).toEqual([]);
  });
});

let renderer: TestRenderer.ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  ui.setLocale('zh');
  vi.unstubAllGlobals();
});

async function renderCard(connection: WecomConnectionDto) {
  vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, json: async () => ({}) }));
  const onAction = vi.fn();
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(WecomBotDefaultsCard, {
      shared: BOT_PROFILE_SHARED_PARTS,
      connection,
      cliState: { options: [{ id: 'codex', label: 'Codex' }] } as any,
      activeTab: 'advanced',
      onTabChange: vi.fn(),
      onRefresh: vi.fn(),
      onAction,
    }));
  });
  const buttons = (label: string) => renderer!.root.findAll(node => node.type === 'button' && node.children.includes(label));
  return { onAction, buttons };
}

describe('start, restart and stop on the configuration card', () => {
  it('restarts a connection the fleet runs', async () => {
    const card = await renderCard({ ...base, gateway: 'running', connection: 'connected', canStart: false, canStop: true, canRestart: true });
    const [restart] = card.buttons(t('botDefaults.wecom.runtimeRestart'));
    expect(restart.props.disabled).toBe(false);
    await act(async () => restart.props.onClick());
    expect(card.onAction).toHaveBeenCalledExactlyOnceWith(base.id, 'restart');
  });

  it('offers no lifecycle buttons for a gateway outside the fleet', async () => {
    const card = await renderCard({ ...base, ownership: 'external', canStart: false, canStop: false, message: 'server text' });
    for (const key of ['botDefaults.wecom.runtimeStart', 'botDefaults.wecom.runtimeRestart', 'botDefaults.wecom.runtimeStop']) {
      expect(card.buttons(t(key))).toEqual([]);
    }
  });
});

describe('the connections list\'s restart', () => {
  it('asks the server to restart only a connection whose state offers it', async () => {
    publishProviderRoster('wecom', 1);
    const running = { ...base, id: 'running', gateway: 'running' as const, canStart: false, canRestart: true };
    const stopped = { ...base, id: 'stopped', canRestart: false };
    const action = vi.fn(async () => ({ ok: true, status: 202 }));
    const client = { list: vi.fn(async () => ({ status: 200, body: { connections: [running, stopped] } })), action };
    let observed!: ReturnType<typeof useWecomConnections>;
    function Probe() {
      observed = useWecomConnections({ client });
      return null;
    }
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Probe));
    });
    await act(async () => observed.onAction('stopped', 'restart'));
    expect(action).not.toHaveBeenCalled();
    await act(async () => observed.onAction('running', 'restart'));
    expect(action).toHaveBeenCalledExactlyOnceWith('running', 'restart');
  });
});

describe('an editable WeCom configuration card', () => {
  const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
    typeof node === 'string' ? node : node.children.map(child => textOf(child as TestRenderer.ReactTestInstance | string)).join('');
  const hasClass = (node: TestRenderer.ReactTestInstance, name: string) => String(node.props.className ?? '').split(/\s+/).includes(name);

  async function renderEditable(connection: WecomConnectionDto) {
    let config: any = { editable: true, revision: '1', cli: 'codex', model: '', backend: 'pty', workingDirectory: '/workspace', botConfig: {}, allowedUsers: ['owner'], blockedUsers: [], role: { content: '', injectMode: 'every' } };
    vi.stubGlobal('fetch', async (input: unknown, init: { method?: string; body?: string } = {}) => {
      const url = String(input);
      if (init.method === 'PATCH') {
        config = { ...config, ...JSON.parse(init.body ?? '{}'), revision: String(Number(config.revision) + 1) };
        return { ok: true, status: 200, json: async () => ({ savedRestartRequired: true, config }) };
      }
      const body = url.endsWith('/config') ? config
        : url.endsWith('/codex-profiles') ? { connectionId: connection.id, status: 'empty', candidates: [] }
          : { status: 'unknown', models: [] };
      return { ok: true, status: 200, json: async () => body };
    });
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(WecomBotDefaultsCard, {
        shared: BOT_PROFILE_SHARED_PARTS,
        connection,
        cliState: { options: [{ id: 'codex', label: 'Codex' }] } as any,
        activeTab: 'common',
        onTabChange: vi.fn(),
        onRefresh: vi.fn(),
        onAction: vi.fn(),
      }));
    });
    return renderer!.root;
  }

  it('carries no standing note above the panels telling to restart after saving', async () => {
    const root = await renderEditable({ ...base, gateway: 'running', connection: 'connected' });
    const body = root.find(node => node.type === 'div' && hasClass(node, 'bd-body'));
    expect(body.children.filter(child => typeof child !== 'string' && child.type === 'p')).toEqual([]);
    expect(textOf(root)).not.toContain(t('botDefaults.wecom.restartRequired'));
  });

  it('confirms a saved Agent setting the way the Feishu card does, for the next new session', async () => {
    const root = await renderEditable({ ...base, gateway: 'running', connection: 'connected' });
    await act(async () => root.findByProps({ 'data-action': 'save-agent' }).props.onClick());
    await act(async () => { await new Promise(done => setTimeout(done, 0)); });
    const text = textOf(root);
    expect(text).toContain(t('botDefaults.agentSaved'));
    expect(text).not.toContain(t('botDefaults.wecom.restartRequired'));
  });
});
