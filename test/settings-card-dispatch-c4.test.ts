/**
 * Production dispatch path test (PR3 C4 B2 — UI revision pass 2).
 *
 * The card-handler dispatch arm now invokes `handleSettingsCardAction` with
 * NO `patchCard`. The settings handler returns `{toast, card}` directly so
 * the event-dispatcher passes the rebuilt card body back to Lark in the
 * SAME callback response. This eliminates the stale-render flash that the
 * earlier `patchCard → updateMessage` pattern caused (spinner → old card →
 * push arrives → new card).
 *
 * Slow fallback: if the handler exceeds the event-dispatcher 2.5s ACK-safe
 * cutoff, `patchTimedOutCardActionResult` will call `updateMessage` on the
 * eventually-resolved `{card}`. That path is owned by the dispatcher and
 * tested in `event-dispatcher.test.ts`; here we only assert the fast path
 * does NOT call `updateMessage`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Lark client module so we can assert updateMessage is NOT called.
vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/im/lark/client.js')>(
    '../src/im/lark/client.js',
  );
  return {
    ...actual,
    updateMessage: vi.fn(async () => {}),
    resolveUserUnionId: vi.fn(async () => ({})),
  };
});

// Mock the daemon-internal-client-wrapper to inject a fake client.
vi.mock('../src/daemon-internal-client-wrapper.js', () => ({
  createDaemonClientFor: vi.fn(),
}));

// Mock per-bot owner lookup so dispatch reaches the write path.
vi.mock('../src/bot-registry.js', async () => {
  const actual = await vi.importActual<typeof import('../src/bot-registry.js')>('../src/bot-registry.js');
  return {
    ...actual,
    getOwnerOpenId: vi.fn(() => 'ou_alice'),
  };
});

import { updateMessage, resolveUserUnionId } from '../src/im/lark/client.js';
import { createDaemonClientFor } from '../src/daemon-internal-client-wrapper.js';
import { handleCardAction, type CardActionData } from '../src/im/lark/card-handler.js';

vi.mocked(resolveUserUnionId).mockResolvedValue({ unionId: 'on_alice' });

const mockedUpdateMessage = vi.mocked(updateMessage);
const mockedCreateClient = vi.mocked(createDaemonClientFor);

const LARK_APP_ID = 'cli_test';
const INVOKER = 'ou_alice';
const OWNER_UNION = 'on_alice';
const ORIGINAL_MESSAGE_ID = 'om_original';

beforeEach(() => {
  mockedUpdateMessage.mockClear();
  mockedCreateClient.mockReset();
});

function buildSettings(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    publicReadOnly: false,
    openTerminalInFeishu: false,
    maintenance: {},
    localDevInstall: false,
    ...over,
  };
}

function makeDeps(): any {
  return {
    activeSessions: new Map(),
    sessionReply: vi.fn(async () => 'om_reply'),
    getActiveCount: () => 0,
    lastRepoScan: new Map(),
  };
}

describe('handleCardAction → settings dispatch returns {toast, card} (PR3 pass 2)', () => {
  it('happy toggle: result.card carries the rebuilt card; updateMessage NOT called on the fast path', async () => {
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'PUT' && req.path === '/__daemon/settings-write') {
        return {
          status: 200, raw: '',
          body: { ok: true, settings: buildSettings({ publicReadOnly: true }) },
        };
      }
      throw new Error('unexpected request: ' + JSON.stringify(req));
    });
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER, union_id: OWNER_UNION },
      action: {
        value: {
          action: 'dash_settings_toggle',
          invoker_open_id: INVOKER,
          field: 'publicReadOnly',
          next_value: 'true',
        },
      },
      context: { open_message_id: ORIGINAL_MESSAGE_ID },
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

    // Toast + card in the same response. Lark's client renders both atomically.
    expect(result.toast).toBeDefined();
    expect(result.card).toBeDefined();
    expect(result.card?.type).toBe('raw');
    const cardJson = JSON.stringify(result.card?.data);
    expect(cardJson).toContain('Dashboard');
    // Identity hardening still holds — no raw union_id leaks into the rebuilt card.
    expect(cardJson).not.toContain('"union_id"');
    expect(cardJson).not.toContain('"senderUnionId"');

    // Settle any pending microtasks just in case some background path exists.
    await new Promise(resolve => setImmediate(resolve));
    // Fast path MUST NOT touch updateMessage — that's the stale-render bug.
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });

  it('refresh: result.card carries the snapshot card; no PUT, no updateMessage on the fast path', async () => {
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'GET' && req.path === '/__daemon/settings-snapshot') {
        return {
          status: 200, raw: '',
          body: { settings: buildSettings({ openTerminalInFeishu: true }) },
        };
      }
      throw new Error('unexpected request: ' + JSON.stringify(req));
    });
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER, union_id: OWNER_UNION },
      action: { value: { action: 'dash_settings_refresh', invoker_open_id: INVOKER } },
      context: { open_message_id: ORIGINAL_MESSAGE_ID },
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

    expect(requestSpy).toHaveBeenCalled();
    const putCall = requestSpy.mock.calls.find(c => (c[0] as any).method === 'PUT');
    expect(putCall).toBeUndefined();

    expect(result.card).toBeDefined();
    const cardJson = JSON.stringify(result.card?.data);
    expect(cardJson).toContain('Dashboard');

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });

  it('missing open_message_id: handler does not throw — fast-path response is still valid', async () => {
    const requestSpy = vi.fn(async () => ({
      status: 200, raw: '',
      body: { ok: true, settings: buildSettings() },
    }));
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER, union_id: OWNER_UNION },
      action: {
        value: {
          action: 'dash_settings_toggle',
          invoker_open_id: INVOKER,
          field: 'publicReadOnly',
          next_value: 'true',
        },
      },
      // No context, no open_message_id — fast path doesn't need it.
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);
    await new Promise(resolve => setImmediate(resolve));

    expect(result.toast).toBeDefined();
    // The fast path doesn't depend on open_message_id; updateMessage stays untouched.
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });
});
