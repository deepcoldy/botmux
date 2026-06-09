/**
 * Production dispatch path test (PR3 C4 B2):
 *
 * Codex blocker: the card-handler dispatch arm must wire a `patchCard` that
 * issues a real Lark `updateMessage` after the write/refresh resolves. This
 * file exercises the public `handleCardAction(...)` entry and verifies that
 * `updateMessage` is invoked with the post-write rebuilt card JSON — NOT
 * with the raw route-B response.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mock the entire Lark client module BEFORE importing card-handler ────
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

// Make resolveUserUnionId return a valid on_ unionId so write path proceeds.
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

describe('handleCardAction → settings dispatch wires patchCard → updateMessage (B2)', () => {
  it('happy toggle: updateMessage called with rebuilt card JSON (not raw response)', async () => {
    // PUT response carries the merged settings; patchCard rebuilds the card.
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

    // Synchronous ACK shape.
    expect(result.toast).toBeDefined();
    expect(result.ack).toBeUndefined();

    // Give the async patchCard a microtask to flush. The handler's default
    // scheduler is `setImmediate`; in vitest a `setImmediate` task settles
    // after we await a Promise.
    await new Promise(resolve => setImmediate(resolve));

    expect(mockedUpdateMessage).toHaveBeenCalledOnce();
    const [appId, messageId, cardJson] = mockedUpdateMessage.mock.calls[0]!;
    expect(appId).toBe(LARK_APP_ID);
    expect(messageId).toBe(ORIGINAL_MESSAGE_ID);
    // The cardJson must be the REBUILT card, NOT the raw response object.
    expect(typeof cardJson).toBe('string');
    expect(cardJson).toContain('Dashboard');
    // No identity beyond invoker_open_id ever leaks into the rebuilt card.
    expect(cardJson).not.toContain('"union_id"');
    expect(cardJson).not.toContain('"senderUnionId"');
  });

  it('refresh: updateMessage called with rebuilt card from GET snapshot (no PUT)', async () => {
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
    await handleCardAction(data, makeDeps(), LARK_APP_ID);
    await new Promise(resolve => setImmediate(resolve));

    // GET — never PUT during refresh.
    expect(requestSpy).toHaveBeenCalled();
    const putCall = requestSpy.mock.calls.find(c => (c[0] as any).method === 'PUT');
    expect(putCall).toBeUndefined();

    expect(mockedUpdateMessage).toHaveBeenCalledOnce();
    const [, , cardJson] = mockedUpdateMessage.mock.calls[0]!;
    expect(typeof cardJson).toBe('string');
    expect(cardJson).toContain('Dashboard');
  });

  it('missing open_message_id: handler logs but does not throw, no updateMessage', async () => {
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
      // No context, no open_message_id at the envelope.
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);
    await new Promise(resolve => setImmediate(resolve));

    expect(result.toast).toBeDefined();
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });
});
