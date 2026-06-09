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
 *      `/__daemon/settings-write` (with verified `ownerUnionId`) → patchCard
 *      rebuilds the card from the post-write settings.
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
    workflowsActionDeps: {
      runsDir: '/tmp/none',
      proxyToDaemon: async () => new Response('{}', { status: 200 }),
      listRuns: async () => [],
      readRunSnapshot: async () => null,
      scrubSnapshotForUnauthed: (s: any) => s,
      TERMINAL_RUN_STATUSES: new Set(['succeeded', 'failed', 'cancelled']),
      isValidRunId: () => true,
    } as any,
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

    await handleDashboardSettings(
      message, '', 'om_root', 'oc_smoke', deps, LARK_APP_ID,
      { createClient, locale: 'en' },
    );

    expect(fx.hits.GET).toBe(1);
    expect(fx.hits.PUT).toBe(0);
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0].msgType).toBe('interactive');
    expect(replyCalls[0].content).toContain('Dashboard');
    // Identity red line — verified union_id and senderId never leak into the card.
    expect(replyCalls[0].content).not.toContain('"union_id"');
    expect(replyCalls[0].content).not.toContain('on_smoke_owner');
  });

  it('callback path: toggle publicReadOnly true → real PUT → server state updated → patchCard receives merged settings', async () => {
    expect((fx.state.settings as any).publicReadOnly).toBe(false);

    const patchSpy = vi.fn(async () => {});
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

    let pending: Promise<void> | undefined;
    const result = await handleSettingsCardAction(data, LARK_APP_ID, {
      createClient,
      isAuthorized: async ({ senderUnionId }) => senderUnionId === OWNER_UNION,
      patchCard: patchSpy,
      // Capture the in-flight write so the test can await it.
      scheduleAsync: (fn) => { pending = fn(); },
      locale: 'en',
    });

    expect(result.toast).toBeDefined();
    expect(result.toast.content).toContain('Saving');

    await pending;

    expect(fx.hits.PUT).toBe(1);
    expect((fx.state.settings as any).publicReadOnly).toBe(true);
    expect(patchSpy).toHaveBeenCalled();
    const payload = patchSpy.mock.calls[0]![2] as any;
    expect(payload.status).toBe(200);
    expect(payload.body?.settings?.publicReadOnly).toBe(true);
  });

  it('callback path: refresh action only GETs the snapshot, never PUTs', async () => {
    const patchSpy = vi.fn(async () => {});
    const data: CardActionData = {
      operator: { open_id: INVOKER, union_id: OWNER_UNION },
      action: { value: { action: SETTINGS_ACTION_REFRESH, invoker_open_id: INVOKER } },
      context: { open_message_id: 'om_card' },
    };

    const createClient = () =>
      createDaemonClient({ dashboardUrl: fx.baseUrl, appId: LARK_APP_ID, secret: SECRET, retries: 0 });

    let pending: Promise<void> | undefined;
    await handleSettingsCardAction(data, LARK_APP_ID, {
      createClient,
      isAuthorized: async () => true,
      patchCard: patchSpy,
      scheduleAsync: (fn) => { pending = fn(); },
      locale: 'en',
    });
    await pending;

    expect(fx.hits.GET).toBe(1);
    expect(fx.hits.PUT).toBe(0);
    expect(patchSpy).toHaveBeenCalledOnce();
  });

  it('callback path: non-owner gate locally denies before any HTTP call', async () => {
    const patchSpy = vi.fn(async () => {});
    const data: CardActionData = {
      operator: { open_id: INVOKER, union_id: 'on_stranger' },
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

    const r = await handleSettingsCardAction(data, LARK_APP_ID, {
      createClient,
      isAuthorized: async ({ senderUnionId }) => senderUnionId === OWNER_UNION,  // stranger denied
      patchCard: patchSpy,
      scheduleAsync: (fn) => { void fn(); },
      locale: 'en',
    });

    expect(r.toast.content).toContain('Owner only');
    // Server NEVER reached for this caller — local gate caught them first.
    expect(fx.hits.GET).toBe(0);
    expect(fx.hits.PUT).toBe(0);
    expect(patchSpy).not.toHaveBeenCalled();
    expect((fx.state.settings as any).publicReadOnly).toBe(false);
  });
});
