import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listOnlineDaemonsMock, fetchDaemonIpcMock } = vi.hoisted(() => ({
  listOnlineDaemonsMock: vi.fn(),
  fetchDaemonIpcMock: vi.fn(),
}));

vi.mock('../src/utils/daemon-discovery.js', () => ({
  listOnlineDaemons: (...args: any[]) => listOnlineDaemonsMock(...args),
}));

vi.mock('../src/core/daemon-ipc-auth.js', () => ({
  fetchDaemonIpc: (...args: any[]) => fetchDaemonIpcMock(...args),
}));

vi.mock('../src/bot-registry.js', async () => {
  const actual = await vi.importActual<typeof import('../src/bot-registry.js')>('../src/bot-registry.js');
  return { ...actual, getOwnerOpenId: vi.fn(() => 'ou_owner') };
});

import {
  countHostOverload,
  handleCardAction,
} from '../src/im/lark/card-handler.js';
import {
  OVERLOAD_ACTION_CLEAN_STOPPED,
  type OverloadCardState,
} from '../src/core/host-overload-alert.js';
import {
  _resetOverloadNoncesForTest,
  claimOverloadNonce,
  registerOverloadNonce,
} from '../src/im/lark/overload-nonce.js';

const daemons = [
  { larkAppId: 'cli_a', ipcPort: 7101 },
  { larkAppId: 'cli_b', ipcPort: 7102 },
];

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  _resetOverloadNoncesForTest();
  listOnlineDaemonsMock.mockReset();
  fetchDaemonIpcMock.mockReset();
  listOnlineDaemonsMock.mockReturnValue(daemons);
});

describe('host-overload card actions across bot-scoped daemons', () => {
  it('sums stopped and idle candidates from every daemon', async () => {
    fetchDaemonIpcMock.mockImplementation(async (port: number, path: string) => {
      expect(path).toBe('/api/host-overload/counts');
      return response(port === 7101
        ? { ok: true, stopped: 2, idle: 4 }
        : { ok: true, stopped: 3, idle: 5 });
    });

    await expect(countHostOverload()).resolves.toEqual({ stopped: 5, idle: 9 });
  });

  it('cleans every daemon and reports the summed affected count', async () => {
    fetchDaemonIpcMock.mockImplementation(async (port: number, path: string) => {
      if (path === '/api/host-overload/sweep') {
        return response({ ok: true, affected: port === 7101 ? 0 : 5 });
      }
      if (path === '/api/host-overload/counts') {
        return response({ ok: true, stopped: 0, idle: port === 7101 ? 4 : 5 });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const state: OverloadCardState = {
      nonce: 'nonce-clean-all',
      load15: 30,
      cpu: 10,
      mem: 0.95,
      reasons: ['load', 'memory'],
      stopped: 5,
      idle: 9,
      cleanedN: -1,
      suspendedN: -1,
    };
    registerOverloadNonce(state.nonce);

    const result = await handleCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: {
          action: OVERLOAD_ACTION_CLEAN_STOPPED,
          st: JSON.stringify(state),
        },
      },
    }, {
      activeSessions: new Map(),
      sessionReply: vi.fn(async () => 'om_reply'),
      lastRepoScan: new Map(),
    } as any, 'cli_alert');

    const sweepCalls = fetchDaemonIpcMock.mock.calls.filter(([, path]) => path === '/api/host-overload/sweep');
    expect(sweepCalls.map(([port]) => port).sort()).toEqual([7101, 7102]);
    expect(JSON.stringify(result)).toContain('✓ 已清理 5 个僵尸');
    expect(JSON.stringify(result)).toContain('僵尸会话 0 个');
  });

  // Regression: a partial fan-out failure must NOT be reported as a completed
  // sweep. Field scenario — daemon A holds no zombies and acks 0, daemon B holds
  // 5 but its request fails (500 / network reject). If we treat `ok >= 1` as
  // success we'd burn the button to "✓ 已清理 0 个僵尸" (disabled) while B's 5
  // zombies survive, and the one-shot nonce + 15min re-alert gate leave the owner
  // no retry — the very "显示 0、实际没清" symptom this PR exists to kill.
  it('fails the whole action (retriable) when any discovered daemon does not ack', async () => {
    fetchDaemonIpcMock.mockImplementation(async (port: number, path: string) => {
      if (path === '/api/host-overload/sweep') {
        if (port === 7101) return response({ ok: true, affected: 0 });
        return errorResponse(500, { ok: false, error: 'boom' }); // daemon B (holds the zombies) fails
      }
      if (path === '/api/host-overload/counts') {
        return response({ ok: true, stopped: port === 7101 ? 0 : 5, idle: 0 });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const state: OverloadCardState = {
      nonce: 'nonce-partial-fail',
      load15: 30,
      cpu: 10,
      mem: 0.95,
      reasons: ['load', 'memory'],
      stopped: 5,
      idle: 0,
      cleanedN: -1,
      suspendedN: -1,
    };
    registerOverloadNonce(state.nonce);

    const result = await handleCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: {
          action: OVERLOAD_ACTION_CLEAN_STOPPED,
          st: JSON.stringify(state),
        },
      },
    }, {
      activeSessions: new Map(),
      sessionReply: vi.fn(async () => 'om_reply'),
      lastRepoScan: new Map(),
    } as any, 'cli_alert');

    // Both daemons were attempted (fan-out still happens).
    const sweepCalls = fetchDaemonIpcMock.mock.calls.filter(([, path]) => path === '/api/host-overload/sweep');
    expect(sweepCalls.map(([port]) => port).sort()).toEqual([7101, 7102]);

    // Must surface as a failure toast, NOT a completed card.
    expect(JSON.stringify(result)).not.toContain('✓ 已清理');
    expect(result?.toast?.type).toBe('error');

    // The nonce must be released so the owner can click the button again.
    expect(claimOverloadNonce(state.nonce, OVERLOAD_ACTION_CLEAN_STOPPED)).toBe(true);
  });
});
