/**
 * The main bot's own workflow node turn (design 2026-11-03 §6.5) and
 * 交接带发起人身份 (§10): when the handoff carries the initiator's delegation,
 * the turn's tool identity is published BEFORE the CLI gets the turn — in a
 * new node session and when an existing one is reused. Without a delegation
 * (the switch off) the turn starts exactly as before, with no identity step.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    session: { get dataDir() { return tempDir; } },
    daemon: { backendType: 'pty', workingDir: '~', workingDirs: ['~'] },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

const order = vi.hoisted(() => [] as string[]);
const wp = vi.hoisted(() => ({
  forkWorker: vi.fn((_ds: unknown, _prompt: unknown, turnId: unknown) => { order.push(`fork:${String(typeof turnId === 'object' ? (turnId as any).turnId : turnId)}`); }),
  sendWorkerInput: vi.fn((_ds: unknown, _payload: unknown, turnId: unknown) => { order.push(`send:${String(turnId)}`); return true; }),
}));

vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: wp.forkWorker,
  sendWorkerInput: wp.sendWorkerInput,
  getCurrentCliVersion: vi.fn(() => '1.0.0-test'),
  withActiveSessionKeyLock: vi.fn(async (_map: Map<string, any>, _key: string, action: () => any) => action()),
  setActiveSessionIfActive: vi.fn((map: Map<string, any>, key: string, ds: any) => {
    const current = map.get(key);
    if (current && current !== ds) return false;
    map.set(key, ds);
    return true;
  }),
  isRelayableRealSession: (ds: any) => !!ds?.worker,
  isDisposableCommandScratch: () => false,
  closeSession: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../src/bot-registry.js', () => {
  const bot = { config: { larkAppId: 'cli_main', cliId: 'claude-code' }, botName: '主 Bot', botOpenId: 'ou_bot' };
  return {
    getBot: vi.fn(() => bot),
    getAllBots: vi.fn(() => [bot]),
    getOwnerOpenId: vi.fn(() => undefined),
    findOncallChat: vi.fn(() => undefined),
    effectiveDefaultWorkingDir: vi.fn(() => undefined),
  };
});

vi.mock('../src/services/message-queue.js', () => ({ ensureQueue: vi.fn() }));
vi.mock('../src/core/session-activity.js', () => ({
  announceSessionRow: vi.fn(),
  announcePendingRepoSession: vi.fn(),
  markSessionActivity: vi.fn(),
  clearAgentAttention: vi.fn(() => false),
  stampHumanActivity: vi.fn(),
}));

import { deliverWorkflowNodeTurn } from '../src/core/session-manager.js';
import * as sessionStore from '../src/services/session-store.js';
import { sessionKey } from '../src/core/types.js';

const MARKER = {
  runId: 'r', nodeId: 'write', attemptId: 'write#001/attempts/001', handoffMessageId: 'om_handoff',
  nonce: `wfh_${'a'.repeat(24)}`, publishRoot: 'om_node_card', orchestratorAppId: 'cli_main', registeredAt: new Date(0).toISOString(),
};
const INPUT = {
  larkAppId: 'cli_main', chatId: 'oc_chat', publishRoot: 'om_node_card', handoffMessageId: 'om_handoff',
  marker: MARKER, prompt: '【工作流任务】t · write', attachments: [], sessionTitle: '工作流 t · write',
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wf-self-turn-'));
  sessionStore.init('cli_main');
  order.length = 0;
  wp.forkWorker.mockClear();
  wp.sendWorkerInput.mockClear();
});
afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

const prepare = () => vi.fn(async (ds: any, turnId: string) => {
  // The marker is already on the session when the identity is resolved.
  expect(ds.session.workflowNode).toMatchObject({ handoffMessageId: turnId });
  order.push(`identity:${turnId}`);
});

describe('deliverWorkflowNodeTurn identity step', () => {
  it('a delegated handoff publishes the identity before the new session\'s first turn', async () => {
    const prepareTurnIdentity = prepare();
    await deliverWorkflowNodeTurn({ ...INPUT, prepareTurnIdentity }, new Map(), () => false);
    expect(prepareTurnIdentity).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['identity:om_handoff', 'fork:om_handoff']);
  });

  it('…and before the turn is handed to a reused node session', async () => {
    const map = new Map<string, any>();
    const session = sessionStore.createSession('oc_chat', 'om_node_card', 'node', 'group');
    session.larkAppId = 'cli_main';
    sessionStore.updateSession(session);
    map.set(sessionKey('om_node_card', 'cli_main'), {
      session, worker: { killed: false }, larkAppId: 'cli_main', chatId: 'oc_chat', chatType: 'group', scope: 'thread',
    });
    const prepareTurnIdentity = prepare();
    await deliverWorkflowNodeTurn({ ...INPUT, prepareTurnIdentity }, map, () => false);
    expect(order).toEqual(['identity:om_handoff', 'send:om_handoff']);
  });

  it('without a delegation the turn starts as before, with no identity step', async () => {
    await deliverWorkflowNodeTurn(INPUT, new Map(), () => false);
    expect(order).toEqual(['fork:om_handoff']);
  });
});

describe('deliverWorkflowNodeTurn working dir (design §15.4)', () => {
  const forkedDs = () => wp.forkWorker.mock.calls.at(-1)![0] as { workingDir?: string; session: { workingDir?: string } };

  it('a new node session starts in the run\'s (already checked) directory and keeps it on record', async () => {
    await deliverWorkflowNodeTurn({ ...INPUT, workingDir: '/srv/task' }, new Map(), () => false);
    expect(forkedDs().workingDir).toBe('/srv/task');
    expect(forkedDs().session.workingDir).toBe('/srv/task');
  });

  it('without one it starts where it always did (the bot\'s default)', async () => {
    await deliverWorkflowNodeTurn(INPUT, new Map(), () => false);
    expect(forkedDs().workingDir).toBeUndefined();
    expect(forkedDs().session.workingDir).toBeUndefined();
  });
});
