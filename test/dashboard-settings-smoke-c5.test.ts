/**
 * PR3 C5 end-to-end smoke.
 *
 * Wires a real `http.createServer` with the PR2 Route B dispatcher, then
 * drives it via:
 *   1. `handleDashboardSettings` (command path) → real `createDaemonClient`
 *      → real HMAC envelope → server GET `/__daemon/settings-snapshot` →
 *      `composeSections` → `buildSettingsCard` → emitted as `interactive`
 *      via `sessionReply`.
 *   2. `handleSettingsCardAction` (callback path) → real client → real PUT
 *      `/__daemon/settings-write` (with verified `ownerUnionId`). On the
 *      success path the handler returns ONLY `{ card }` (no toast) from
 *      the post-write settings so the Lark callback response carries the
 *      rebuilt card body itself (no out-of-band `updateMessage`,
 *      no toast + card two-pass render flash).
 *
 * No real dashboard or daemon is started. No restart needed.
 */

import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDaemonInternalApi, type DaemonInternalApiDeps } from '../src/dashboard/daemon-internal-api.js';
import { createDaemonClient } from '../src/dashboard/daemon-internal-client.js';
import {
  handleSettingsCardAction,
  SETTINGS_ACTION_REFRESH,
  SETTINGS_ACTION_TOGGLE,
} from '../src/im/lark/settings-card.js';
import { handleDashboardSettings } from '../src/core/dashboard-command/settings.js';
import type { CommandHandlerDeps } from '../src/core/command-handler.js';
import type { CardActionData } from '../src/im/lark/card-handler.js';
import type { LarkMessage } from '../src/types.js';

const SECRET = 'pr3-smoke-secret';
const LARK_APP_ID = 'cli_smoke';
const INVOKER = 'ou_invoker';
const OWNER_UNION = 'on_smoke_owner';

function buildSettings(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    publicReadOnly: false,
    openTerminalInFeishu: false,
    maintenance: {},
    localDevInstall: false,
    ...over,
  };
}

interface SmokeFixture {
  server: Server;
  baseUrl: string;
  state: { settings: Record<string, unknown> };
  /** Number of times the in-process Route B server has been hit. */
  hits: { GET: number; PUT: number };
}

async function spinUpServer(): Promise<SmokeFixture> {
  const state = { settings: buildSettings() };
  const hits = { GET: 0, PUT: 0 };

  // Minimal stubbed deps for the Route B dispatcher — we only exercise
  // settings paths so the other endpoint handlers can throw.
  const deps: DaemonInternalApiDeps = {
    secret: SECRET,
    getSessions: () => [],
    getSchedules: () => [],
    resolveDashboardSettings: () => state.settings as any,
    buildGroupsMatrix: async () => ({ chats: [], bots: [] }),
    settingsApplierDeps: {
      readGlobalConfig: () => ({}),
      mergeDashboardConfig: (patch: any) => {
        state.settings = { ...state.settings, ...patch };
        return state.settings as any;
      },
      mergeMaintenanceConfig: (patch: any) => {
        state.settings = { ...state.settings, maintenance: { ...(state.settings.maintenance as any), ...patch } };
        return (state.settings.maintenance as any);
      },
      parseMaintenancePatch: (b: any) => ({ ok: true, patch: b ?? {} }),
      isLocalDevInstall: () => false,
      resolveDashboardSettings: () => state.settings as any,
    },
    groupsActionDeps: {
      registryList: () => [],
      registryGetByAppId: () => undefined,
      proxyToDaemon: async () => new Response('{}', { status: 200 }),
      closeSessionsMatching: async () => [],
    },
    proxyToDaemon: async () => new Response('{}', { status: 200 }),
    ownerOf: () => undefined,
    scheduleOwnerOf: () => undefined,
    settingsOwnerDeps: {
      // Owner gate: only OWNER_UNION accepted.
      resolveOwnerCandidates: async () => [{ unionId: OWNER_UNION, name: 'owner' }],
    },
  };

  const api = createDaemonInternalApi(deps);
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url ?? '').startsWith('/__daemon/settings-snapshot')) hits.GET += 1;
    if (req.method === 'PUT' && (req.url ?? '').startsWith('/__daemon/settings-write')) hits.PUT += 1;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const handled = await api.handle(req, res, url);
    if (!handled) {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}`, state, hits };
}

describe('PR3 smoke — end-to-end /dashboard settings', () => {
  let fx: SmokeFixture;

  beforeEach(async () => { fx = await spinUpServer(); });
  afterEach(async () => { await new Promise<void>(resolve => fx.server.close(() => resolve())); });

  it('command path: handleDashboardSettings → real Route B GET → interactive card', async () => {
    const replyCalls: Array<{ content: string; msgType?: string }> = [];
    const deps: CommandHandlerDeps = {
      activeSessions: new Map() as any,
      sessionReply: vi.fn(async (_rid: string, content: string, msgType?: string) => {
        replyCalls.push({ content, msgType });
        return 'om_reply';
      }),
      getActiveCount: () => 0,
      lastRepoScan: new Map() as any,
    };
    const message: LarkMessage = {
      senderId: INVOKER,
      senderUnionId: OWNER_UNION,
      content: '/dashboard settings',
      chatId: 'oc_smoke',
      rootMessageId: 'om_root',
    } as LarkMessage;

    const createClient = () =>
      createDaemonClient({ dashboardUrl: fx.baseUrl, appId: LARK_APP_ID, secret: SECRET, retries: 0 });

    const dmCalls: Array<{ openId: string; content: string; msgType?: string }> = [];
    const sendUserMessage = async (_a: string, openId: string, content: string, msgType?: string) => {
      dmCalls.push({ openId, content, msgType });
      return 'om_dm';
    };

    await handleDashboardSettings(
      message, '', 'om_root', 'oc_smoke', deps, LARK_APP_ID, INVOKER,
      { createClient, sendUserMessage, locale: 'en' },
    );

    expect(dmCalls.length).toBe(1);
    expect(dmCalls[0].openId).toBe(INVOKER);
    expect(dmCalls[0].msgType).toBe('interactive');

    expect(fx.hits.GET).toBe(1);
    expect(fx.hits.PUT).toBe(0);
    // Topic only gets confirmation; the card itself was DMed.
    expect(replyCalls.length).toBe(1);
    expect(replyCalls[0].content).toContain('📬');
    expect(replyCalls[0].msgType).toBeUndefined();
    // DM card contains the dashboard title; no identity leak.
    expect(dmCalls[0].content).toContain('Dashboard');
    expect(dmCalls[0].content).not.toContain('"union_id"');
    expect(dmCalls[0].content).not.toContain('on_smoke_owner');
  });

  it('callback path: toggle publicReadOnly true → real PUT → result.card carries the post-write card (PR3 pass 2)', async () => {
    expect((fx.state.settings as any).publicReadOnly).toBe(false);

    const data: CardActionData = {
      operator: { open_id: INVOKER, union_id: OWNER_UNION },
      action: {
        value: {
          action: SETTINGS_ACTION_TOGGLE,
          invoker_open_id: INVOKER,
          field: 'publicReadOnly',
          next_value: 'true',
        },
      },
      context: { open_message_id: 'om_card' },
    };

    const createClient = () =>
      createDaemonClient({ dashboardUrl: fx.baseUrl, appId: LARK_APP_ID, secret: SECRET, retries: 0 });

    const result = await handleSettingsCardAction(data, LARK_APP_ID, {
      createClient,
      getOwnerOpenId: () => INVOKER,
      // Server PUT requires ownerUnionId; tests skip the real Lark contact API.
      resolveUserUnionId: async () => ({ unionId: OWNER_UNION }),
      locale: 'en',
    });

    // codex pass 3: success path is CARD-ONLY (no toast). No out-of-band
    // updateMessage; the card body itself shows the post-write state.
    expect(result.toast).toBeUndefined();
    expect(result.card).toBeDefined();
    expect(result.card?.type).toBe('raw');

    // Server-side state really changed (real Route B PUT hit the server).
    expect(fx.hits.PUT).toBe(1);
    expect((fx.state.settings as any).publicReadOnly).toBe(true);

    // The card body carries the post-write rendering — it reflects the new
    // publicReadOnly=true state (current value primary disabled = "✓ On").
    const cardJson = JSON.stringify(result.card?.data);
    expect(cardJson).toContain('Dashboard');
    expect(cardJson).toContain('✓ On');
    // Identity hardening still holds in the smoke pipeline.
    expect(cardJson).not.toContain('"union_id"');
    expect(cardJson).not.toContain('on_smoke_owner');
  });

  it('callback path: refresh action only GETs the snapshot, never PUTs', async () => {
    const data: CardActionData = {
      operator: { open_id: INVOKER, union_id: OWNER_UNION },
      action: { value: { action: SETTINGS_ACTION_REFRESH, invoker_open_id: INVOKER } },
      context: { open_message_id: 'om_card' },
    };

    const createClient = () =>
      createDaemonClient({ dashboardUrl: fx.baseUrl, appId: LARK_APP_ID, secret: SECRET, retries: 0 });

    const result = await handleSettingsCardAction(data, LARK_APP_ID, {
      createClient,
      getOwnerOpenId: () => INVOKER,
      resolveUserUnionId: async () => ({ unionId: OWNER_UNION }),
      locale: 'en',
    });

    expect(fx.hits.GET).toBe(1);
    expect(fx.hits.PUT).toBe(0);
    expect(result.card).toBeDefined();
  });

  it('callback path: non-owner gate locally denies before any HTTP call', async () => {
    const data: CardActionData = {
      // Stranger is the actor (operator) AND matches the invoker_open_id
      // so the invoker-lock passes. The per-bot admin gate is what must
      // reject — allowedUsers contains INVOKER, not the stranger.
      operator: { open_id: 'ou_stranger' },
      action: {
        value: {
          action: SETTINGS_ACTION_TOGGLE,
          invoker_open_id: 'ou_stranger',
          field: 'publicReadOnly',
          next_value: 'true',
        },
      },
      context: { open_message_id: 'om_card' },
    };

    const createClient = () =>
      createDaemonClient({ dashboardUrl: fx.baseUrl, appId: LARK_APP_ID, secret: SECRET, retries: 0 });

    const r = await handleSettingsCardAction(data, LARK_APP_ID, {
      createClient,
      getOwnerOpenId: () => INVOKER,  // owner is INVOKER, stranger denied
      locale: 'en',
    });

    expect(r.toast?.content).toContain('bot-admin only');
    // Server NEVER reached for this caller — local gate caught them first.
    expect(fx.hits.GET).toBe(0);
    expect(fx.hits.PUT).toBe(0);
    // No card returned on the deny path — toast-only is the right shape.
    expect(r.card).toBeUndefined();
    expect((fx.state.settings as any).publicReadOnly).toBe(false);
  });
});
