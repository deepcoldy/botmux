import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyQueuedCodexAppLegacyFallback } from '../src/core/session-create.js';

const { emitHookEventMock, forkMock, execSyncMock } = vi.hoisted(() => ({
  emitHookEventMock: vi.fn(),
  forkMock: vi.fn(),
  execSyncMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    fork: (...args: unknown[]) => forkMock(...args),
    execSync: (...args: unknown[]) => execSyncMock(...args),
  };
});

vi.mock('../src/services/hook-runner.js', () => ({
  emitHookEvent: (...args: unknown[]) => emitHookEventMock(...args),
}));

vi.mock('../src/im/lark/client.js', () => {
  class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  }
  return {
    updateMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    MessageWithdrawnError,
  };
});

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{"type":"streaming"}'),
  buildSessionCard: vi.fn(() => '{"type":"session"}'),
  buildTuiPromptCard: vi.fn(() => '{"type":"tui"}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{"type":"tui-resolved"}'),
  getCliDisplayName: vi.fn(() => 'Codex'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: {
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      cliId: 'codex',
      wrapperCli: 'ttadk codex',
      model: 'glm-5.1',
      plugins: ['demo'],
      skills: { include: ['skill:deploy'] },
    },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getLoadedConfigPath: vi.fn(() => '/home/u/.botmux/bots.json'),
  // Provenance travels with the path (see core/config-dir.ts): 'loaded' = the
  // daemon really parsed that file, which is what forkWorker freezes into the
  // worker init message alongside loadedBotsConfigPath.
  getLoadedConfigProvenance: vi.fn(() => 'loaded' as const),
  loadBotConfigs: vi.fn(() => [{
    larkAppId: 'app_test',
    larkAppSecret: 'secret',
    cliId: 'codex',
    wrapperCli: 'ttadk codex',
    model: 'glm-5.1',
    plugins: ['demo'],
    skills: { include: ['skill:deploy'] },
  }]),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'tmux', cliId: 'codex' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  ensureSessionWhiteboard: vi.fn(),
  persistStreamCardState: vi.fn(),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn(() => ({ tokenUsage: null })),
}));

vi.mock('../src/skills/installer.js', () => ({
  ensureSkills: vi.fn(),
  ensureAskSkill: vi.fn(),
  ensureWhiteboardSkill: vi.fn(),
  removeGlobalBotmuxSkills: vi.fn(),
}));

vi.mock('../src/adapters/cli/claude-code.js', () => ({
  claudeJsonlPathForSession: vi.fn(),
  createClaudeCodeAdapter: vi.fn(() => ({
    id: 'claude-code',
    resolvedBin: 'claude',
    skillsDir: '/tmp/claude-skills',
    buildArgs: vi.fn(() => []),
  })),
}));

vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: class {},
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import { __testOnly_resetSessionLifecycleHooks } from '../src/services/session-lifecycle-hooks.js';
import {
  __testOnly_resetOrdinaryImDeliveries,
  forkAdoptWorker,
  forkWorker,
  initWorkerPool,
  promoteQueuedActivationTail,
  sendWorkerInput,
} from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import * as sessionStore from '../src/services/session-store.js';
import { getBot } from '../src/bot-registry.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import { retireCodexAppDispatchAfterBackingMissing } from '../src/utils/codex-app-dispatch-ledger.js';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

function makeFakeWorker() {
  const worker = new EventEmitter() as any;
  worker.killed = false;
  worker.send = vi.fn();
  worker.kill = vi.fn();
  worker.pid = 12345;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  return worker;
}

function makeDs(overrides?: Partial<DaemonSession>): DaemonSession {
  return {
    session: {
      sessionId: 'sid-start-test',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'Start Test',
      status: 'active',
      createdAt: new Date('2026-05-27T00:00:00.000Z').toISOString(),
      chatType: 'group',
      workingDir: '/repo',
    },
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 1234,
    cliVersion: '1.0',
    lastMessageAt: 5678,
    hasHistory: false,
    workingDir: '/repo',
    ...overrides,
  } as DaemonSession;
}

function defaultBot(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      cliId: 'codex',
      wrapperCli: 'ttadk codex',
      model: 'glm-5.1',
      plugins: ['demo'],
      skills: { include: ['skill:deploy'] },
      ...overrides,
    },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  } as any;
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.mocked(sessionStore.updateSession).mockImplementation(() => undefined);
  __testOnly_resetOrdinaryImDeliveries();
  vi.mocked(getBot).mockImplementation(() => defaultBot());
  __testOnly_resetSessionLifecycleHooks();
  forkMock.mockImplementation(() => makeFakeWorker());
  initWorkerPool({
    sessionReply: vi.fn(async () => 'om_reply'),
    getSessionWorkingDir: () => '/repo',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  });
});

describe('ordinary IM worker receipt acknowledgement', () => {
  it('clears the watchdog when the exact live worker generation receives the turn', async () => {
    vi.useFakeTimers();
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    forkWorker(ds, 'hello', false);
    const worker = forkMock.mock.results.at(-1)!.value;

    expect(sendWorkerInput(ds, 'business turn', 'om_business')).toBe(true);
    worker.emit('message', { type: 'turn_input_received', turnId: 'om_business' });
    await vi.advanceTimersByTimeAsync(5_000);

    const businessSends = vi.mocked(worker.send).mock.calls
      .map(call => call[0])
      .filter(message => message?.type === 'message' && message?.turnId === 'om_business');
    expect(businessSends).toHaveLength(1);
    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('retries the exact turn once and reports a visible failure when no receipt ACK arrives', async () => {
    vi.useFakeTimers();
    const sessionReply = vi.fn(async () => 'om_failure');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    forkWorker(ds, 'hello', false);
    const worker = forkMock.mock.results.at(-1)!.value;

    expect(sendWorkerInput(ds, 'business turn', 'om_business')).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    let businessSends = vi.mocked(worker.send).mock.calls
      .map(call => call[0])
      .filter(message => message?.type === 'message' && message?.turnId === 'om_business');
    expect(businessSends).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();
    expect(sessionReply).toHaveBeenCalledWith(
      'om_root',
      expect.stringContaining('Worker 未能接收'),
      'text',
      'app_test',
      'om_business',
    );
    businessSends = vi.mocked(worker.send).mock.calls
      .map(call => call[0])
      .filter(message => message?.type === 'message' && message?.turnId === 'om_business');
    expect(businessSends).toHaveLength(2);
  });

  it('retries immediately when the parent IPC callback rejects the enqueue', async () => {
    vi.useFakeTimers();
    const sessionReply = vi.fn(async () => 'om_failure');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    forkWorker(ds, 'hello', false);
    const worker = forkMock.mock.results.at(-1)!.value;
    vi.mocked(worker.send).mockImplementation((message: any, callback?: (err?: Error | null) => void) => {
      if (message?.type === 'message') callback?.(new Error('channel closed'));
    });

    expect(sendWorkerInput(ds, 'business turn', 'om_business')).toBe(true);
    await vi.runAllTicks();

    const businessSends = vi.mocked(worker.send).mock.calls
      .map(call => call[0])
      .filter(message => message?.type === 'message' && message?.turnId === 'om_business');
    expect(businessSends).toHaveLength(2);
    expect(sessionReply).toHaveBeenCalledWith(
      'om_root',
      expect.stringContaining('Worker 未能接收'),
      'text',
      'app_test',
      'om_business',
    );
  });

  it('retries a turn that the worker received but could not enqueue', async () => {
    vi.useFakeTimers();
    const sessionReply = vi.fn(async () => 'om_failure');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    forkWorker(ds, 'hello', false);
    const worker = forkMock.mock.results.at(-1)!.value;

    expect(sendWorkerInput(ds, 'business turn', 'om_business')).toBe(true);
    worker.emit('message', { type: 'turn_input_received', turnId: 'om_business' });
    worker.emit('message', {
      type: 'turn_input_rejected',
      turnId: 'om_business',
      reason: 'cli_input_unavailable',
    });
    let businessSends = vi.mocked(worker.send).mock.calls
      .map(call => call[0])
      .filter(message => message?.type === 'message' && message?.turnId === 'om_business');
    expect(businessSends).toHaveLength(2);

    worker.emit('message', { type: 'turn_input_received', turnId: 'om_business' });
    worker.emit('message', {
      type: 'turn_input_rejected',
      turnId: 'om_business',
      reason: 'cli_input_unavailable',
    });
    await Promise.resolve();

    expect(sessionReply).toHaveBeenCalledWith(
      'om_root',
      expect.stringContaining('Worker 未能接收'),
      'text',
      'app_test',
      'om_business',
    );
    businessSends = vi.mocked(worker.send).mock.calls
      .map(call => call[0])
      .filter(message => message?.type === 'message' && message?.turnId === 'om_business');
    expect(businessSends).toHaveLength(2);
  });

  it('ignores a stale worker ACK and fails the original generation visibly', async () => {
    vi.useFakeTimers();
    const sessionReply = vi.fn(async () => 'om_failure');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    forkWorker(ds, 'first', false);
    const firstWorker = forkMock.mock.results.at(-1)!.value;
    expect(sendWorkerInput(ds, 'business turn', 'om_business')).toBe(true);

    forkWorker(ds, 'replacement', { resume: true });
    firstWorker.emit('message', { type: 'turn_input_received', turnId: 'om_business' });
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();

    expect(sessionReply).toHaveBeenCalledWith(
      'om_root',
      expect.stringContaining('Worker 未能接收'),
      'text',
      'app_test',
      'om_business',
    );
  });

  it('tracks a cold-start init turn and retries when the worker never receives it', async () => {
    vi.useFakeTimers();
    const sessionReply = vi.fn(async () => 'om_failure');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();

    forkWorker(ds, 'cold start', 'om_kickoff');
    const worker = forkMock.mock.results.at(-1)!.value;
    await vi.advanceTimersByTimeAsync(4_000);
    await Promise.resolve();

    const initSends = vi.mocked(worker.send).mock.calls
      .map(call => call[0])
      .filter(message => message?.type === 'init' && message?.turnId === 'om_kickoff');
    expect(initSends).toHaveLength(2);
    expect(sessionReply).toHaveBeenCalledWith(
      'om_root',
      expect.stringContaining('Worker 未能接收'),
      'text',
      'app_test',
      'om_kickoff',
    );
  });

  it('does not mistake slow startup for delivery failure after init is received', async () => {
    vi.useFakeTimers();
    const sessionReply = vi.fn(async () => 'om_failure');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();

    forkWorker(ds, 'cold start', 'om_kickoff');
    const worker = forkMock.mock.results.at(-1)!.value;
    worker.emit('message', { type: 'turn_input_received', turnId: 'om_kickoff' });
    await vi.advanceTimersByTimeAsync(10_000);

    const initSends = vi.mocked(worker.send).mock.calls
      .map(call => call[0])
      .filter(message => message?.type === 'init' && message?.turnId === 'om_kickoff');
    expect(initSends).toHaveLength(1);
    expect(sessionReply).not.toHaveBeenCalled();
  });
});

describe('persistent backend target handoff', () => {
  it('passes the recorded shared Herdr target back to a replacement worker', () => {
    const target = {
      backendType: 'herdr' as const,
      sessionName: 'original-work',
      agentName: 'botmux-sid-star',
    };
    const ds = makeDs();
    ds.session.backendType = 'herdr';
    ds.session.persistentBackendTarget = target;

    forkWorker(ds, 'resume', true);

    const worker = forkMock.mock.results.at(-1)!.value;
    expect(vi.mocked(worker.send).mock.calls[0][0]).toEqual(expect.objectContaining({
      type: 'init',
      backendType: 'herdr',
      persistentBackendTarget: target,
    }));
  });
});

describe('CLI runtime session freeze', () => {
  it('migrates an old agentFrozen session from its own cliPathOverride', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({
      wrapperCli: undefined,
      cliRuntime: {
        id: 'new-codex',
        displayName: 'New Codex',
        executable: '/opt/new-codex',
        update: { provider: 'none' },
      },
      cliPathOverride: '/opt/new-codex',
    }));
    const ds = makeDs();
    ds.session.cliId = 'codex';
    ds.session.cliPathOverride = '/opt/legacy/vendor-codex';
    ds.session.agentFrozen = true;

    forkWorker(ds, 'resume', true);

    const worker = forkMock.mock.results.at(-1)!.value;
    const init = vi.mocked(worker.send).mock.calls[0][0];
    expect(init).toEqual(expect.objectContaining({
      cliId: 'codex',
      cliPathOverride: '/opt/legacy/vendor-codex',
      cliRuntime: {
        id: 'vendor-codex',
        displayName: 'vendor-codex',
        executable: '/opt/legacy/vendor-codex',
        source: 'legacy-path',
        update: { provider: 'auto' },
      },
    }));
    expect(ds.session.cliRuntime).toEqual(init.cliRuntime);
  });

  it('repairs a missing executable shadow from configured and legacy frozen snapshots', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ wrapperCli: undefined }));
    for (const source of ['configured', 'legacy-path'] as const) {
      const executable = `/opt/frozen-${source}`;
      const ds = makeDs();
      ds.session.cliId = 'codex';
      ds.session.agentFrozen = true;
      ds.session.cliRuntime = {
        id: `frozen-${source}`,
        displayName: `Frozen ${source}`,
        executable,
        source,
        update: source === 'configured' ? { provider: 'none' } : { provider: 'auto' },
      };
      ds.session.cliPathOverride = undefined;

      forkWorker(ds, 'resume', true);

      const worker = forkMock.mock.results.at(-1)!.value;
      const init = vi.mocked(worker.send).mock.calls[0][0];
      expect(init.cliPathOverride).toBe(executable);
      expect(ds.session.cliPathOverride).toBe(executable);
    }
  });

  it('uses the frozen runtime snapshot instead of a stale executable shadow', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ wrapperCli: undefined }));
    const ds = makeDs();
    ds.session.cliId = 'codex';
    ds.session.agentFrozen = true;
    ds.session.cliRuntime = {
      id: 'frozen-vendor',
      displayName: 'Frozen Vendor',
      executable: '/opt/frozen-vendor',
      source: 'configured',
      update: { provider: 'none' },
    };
    ds.session.cliPathOverride = '/opt/stale-other-vendor';

    forkWorker(ds, 'resume', true);

    const worker = forkMock.mock.results.at(-1)!.value;
    const init = vi.mocked(worker.send).mock.calls[0][0];
    expect(init.cliPathOverride).toBe('/opt/frozen-vendor');
    expect(ds.session.cliPathOverride).toBe('/opt/frozen-vendor');
  });

  it('keeps a newly frozen runtime stable after the bot runtime changes', () => {
    const bot = defaultBot({
      wrapperCli: undefined,
      cliRuntime: {
        id: 'vendor-codex',
        displayName: 'VendorCodex',
        executable: '/opt/vendor-codex',
        update: { provider: 'self' },
      },
      // Parsed BotConfig exposes this compatibility shadow to old call sites.
      cliPathOverride: '/opt/vendor-codex',
    });
    vi.mocked(getBot).mockImplementation(() => bot);
    const ds = makeDs();

    forkWorker(ds, 'first turn', false);
    const firstWorker = forkMock.mock.results.at(-1)!.value;
    const firstInit = vi.mocked(firstWorker.send).mock.calls[0][0];
    expect(firstInit).toEqual(expect.objectContaining({
      cliPathOverride: '/opt/vendor-codex',
      cliRuntime: expect.objectContaining({
        id: 'vendor-codex',
        displayName: 'VendorCodex',
        executable: '/opt/vendor-codex',
        source: 'configured',
      }),
    }));

    bot.config.cliRuntime = {
      id: 'other-codex',
      displayName: 'Other Codex',
      executable: '/opt/other-codex',
      update: { provider: 'none' },
    };
    bot.config.cliPathOverride = '/opt/other-codex';
    forkWorker(ds, 'resume', true);

    const resumedWorker = forkMock.mock.results.at(-1)!.value;
    const resumedInit = vi.mocked(resumedWorker.send).mock.calls[0][0];
    expect(resumedInit.cliRuntime).toEqual(firstInit.cliRuntime);
    expect(resumedInit.cliPathOverride).toBe('/opt/vendor-codex');
    expect(ds.session.cliRuntime).toEqual(firstInit.cliRuntime);
  });
});

describe('Codex App clean-input feature gate', () => {
  const payload = {
    content: '<user_message>legacy</user_message>',
    codexAppInput: { text: 'clean' },
  };

  it('omits the sidecar by default/off, preserving the legacy init prompt', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app' }));
    const ds = makeDs();
    forkWorker(ds, payload, { turnId: 'om_off' });
    const worker = forkMock.mock.results.at(-1)!.value;
    const init = vi.mocked(worker.send).mock.calls[0][0];
    expect(init.prompt).toBe(payload.content);
    expect(init).not.toHaveProperty('promptCodexAppInput');
  });

  it('attaches the sidecar only when explicitly enabled and stamps the message id', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app', codexAppCleanInput: true }));
    const ds = makeDs();
    forkWorker(ds, payload, { turnId: 'om_on' });
    const worker = forkMock.mock.results.at(-1)!.value;
    const init = vi.mocked(worker.send).mock.calls[0][0];
    expect(init.prompt).toBe(payload.content);
    expect(init.promptCodexAppInput).toEqual({ text: 'clean', clientUserMessageId: 'om_on' });
    expect(init.turnId).toBe('om_on');
  });

  it('keeps clean input and durable metadata atomic on a cold fork', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app', codexAppCleanInput: true }));
    const ds = makeDs();
    forkWorker(ds, payload, { turnId: 'delivery-1', dispatchAttempt: 4 });
    const worker = forkMock.mock.results.at(-1)!.value;

    expect(vi.mocked(worker.send).mock.calls[0][0]).toEqual(expect.objectContaining({
      prompt: payload.content,
      promptCodexAppInput: { text: 'clean', clientUserMessageId: 'delivery-1' },
      turnId: 'delivery-1',
      dispatchAttempt: 4,
    }));
  });

  it('resolves explicit meeting IM origin while keeping the clean live sidecar', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app', codexAppCleanInput: true }));
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    const origin = {
      listenerAppId: 'listener', meetingId: 'meeting', memberId: 'member',
      memberEpoch: 1, agentAppId: 'agent', ownerBootId: 'boot', ownerEpoch: 1,
      membershipGeneration: 1, sinkOwnerGeneration: 1,
      receiverSessionId: ds.session.sessionId, larkMessageId: 'om_vc_im',
    };
    ds.session.vcMeetingImTurnOrigins = { om_vc_im: origin };

    expect(sendWorkerInput(ds, payload, 'om_vc_im')).toBe(true);
    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      content: payload.content,
      codexAppInput: { text: 'clean', clientUserMessageId: 'om_vc_im' },
      turnId: 'om_vc_im',
      codexAppDispatchId: expect.any(String),
      vcMeetingImTurnOrigin: origin,
    }));
  });

  it('freezes non-Lark delivery sinks into every accepted Codex App entry', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app' }));
    const cases = [
      {
        sink: 'doc_comment',
        prepare: (ds: any, turnId: string) => {
          ds.session.docCommentTargets = {
            [turnId]: { fileToken: 'doc', fileType: 'docx', commentId: 'comment', turnId },
          };
        },
      },
      {
        sink: 'http_wait',
        prepare: (ds: any, turnId: string) => {
          ds.pendingWaitPromises = new Map([[turnId, { resolve: vi.fn() }]]);
        },
      },
      {
        sink: 'http_async',
        prepare: (ds: any, turnId: string) => {
          ds.asyncTriggerResults = new Map([[turnId, { status: 'pending', createdAt: Date.now() }]]);
        },
      },
      {
        sink: 'suppressed',
        prepare: (ds: any, turnId: string) => {
          ds.suppressedFinalOutputTurns = new Map([[turnId, 1]]);
        },
      },
    ] as const;

    for (const [index, fixture] of cases.entries()) {
      const turnId = `turn-sink-${index}`;
      const ds = makeDs({ worker: makeFakeWorker() });
      fixture.prepare(ds, turnId);
      expect(sendWorkerInput(ds, `payload-${index}`, turnId, {
        ...(fixture.sink === 'suppressed' ? { dispatchAttempt: 1 } : {}),
      })).toBe(true);
      expect(ds.session.codexAppDispatchLedger?.[0]?.deliverySink).toBe(fixture.sink);
    }
  });

  it('R5-B1-2: preserves codexAppSteerable through the queued admit → promote copy chain (persisted tail + queuedActivationInput + accept-ledger)', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app' }));
    // Worker-null session already behind a queued-activation gate so a new input
    // is ADMITTED to the durable tail (not sent live). This is the exact copy
    // chain codex flagged: admit rebuild → promote exactInput → accept-ledger.
    const ds = makeDs({
      worker: makeFakeWorker(),
      initialStartPending: true,
    } as any);
    ds.session.queuedActivationPending = true; // gate: force admit path
    ds.session.queuedActivationInput = { content: 'opening' };

    // Admit a plain-human steerable follow-up into the tail.
    expect(sendWorkerInput(ds, { content: 'follow', codexAppSteerable: true }, 'turn-steer-tail', {
      codexAppSteerable: true,
    })).toBe(true);
    // The PERSISTED tail entry must carry the frozen flag (admit must not strip).
    const tailEntry = ds.session.queuedActivationTail?.find(e => e.turnId === 'turn-steer-tail');
    expect(tailEntry?.cliInput.codexAppSteerable).toBe(true);

    // Now promote the tail head (simulate the opening ACK draining the gate).
    ds.session.queuedActivationPending = false;
    const promoted = promoteQueuedActivationTail(ds, { send: false });
    expect(promoted).toBe(true);
    // The promoted queuedActivationInput and the fresh accept-ledger entry must
    // both still carry the flag (promote exactInput + acceptCodexAppDispatch COPY).
    expect(ds.session.queuedActivationInput?.codexAppSteerable).toBe(true);
    expect(ds.session.codexAppDispatchLedger?.some(e => e.codexAppSteerable === true)).toBe(true);
  });

  it('R5-B1-2: a missing/false steer authorization stays forced-serial through the same copy chain', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app' }));
    const ds = makeDs({ worker: makeFakeWorker(), initialStartPending: true } as any);
    ds.session.queuedActivationPending = true;
    ds.session.queuedActivationInput = { content: 'opening' };

    // No codexAppSteerable → forced serial; the flag must be absent everywhere.
    expect(sendWorkerInput(ds, { content: 'follow' }, 'turn-serial-tail')).toBe(true);
    const tailEntry = ds.session.queuedActivationTail?.find(e => e.turnId === 'turn-serial-tail');
    expect(tailEntry?.cliInput.codexAppSteerable).toBeUndefined();

    ds.session.queuedActivationPending = false;
    expect(promoteQueuedActivationTail(ds, { send: false })).toBe(true);
    expect(ds.session.queuedActivationInput?.codexAppSteerable).toBeUndefined();
    expect(ds.session.codexAppDispatchLedger?.every(e => e.codexAppSteerable !== true)).toBe(true);
  });

  it('resolves explicit meeting IM origin while keeping the clean cold-fork sidecar', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app', codexAppCleanInput: true }));
    const ds = makeDs();
    const origin = {
      listenerAppId: 'listener', meetingId: 'meeting', memberId: 'member',
      memberEpoch: 1, agentAppId: 'agent', ownerBootId: 'boot', ownerEpoch: 1,
      membershipGeneration: 1, sinkOwnerGeneration: 1,
      receiverSessionId: ds.session.sessionId, larkMessageId: 'om_vc_cold',
    };
    ds.session.vcMeetingImTurnOrigins = { om_vc_cold: origin };

    forkWorker(ds, payload, { resume: true, turnId: 'om_vc_cold' });
    const worker = forkMock.mock.results.at(-1)!.value;
    expect(vi.mocked(worker.send).mock.calls[0][0]).toEqual(expect.objectContaining({
      prompt: payload.content,
      promptCodexAppInput: { text: 'clean', clientUserMessageId: 'om_vc_cold' },
      turnId: 'om_vc_cold',
      vcMeetingImTurnOrigin: origin,
    }));
  });

  it('does not re-attribute an empty restore to the previous turn or its meeting authority', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app', codexAppCleanInput: true }));
    const ds = makeDs({
      currentReplyTarget: {
        rootMessageId: 'om_root',
        turnId: 'om_previous_vc',
        updatedAt: new Date().toISOString(),
      },
      managedTurnOrigin: {
        capability: 'previous-capability',
        turnId: 'om_previous_vc',
      },
    });
    const origin = {
      listenerAppId: 'listener', meetingId: 'meeting', memberId: 'member',
      memberEpoch: 1, agentAppId: 'agent', ownerBootId: 'boot', ownerEpoch: 1,
      membershipGeneration: 1, sinkOwnerGeneration: 1,
      receiverSessionId: ds.session.sessionId, larkMessageId: 'om_previous_vc',
    };
    ds.session.vcMeetingImTurnOrigins = { om_previous_vc: origin };

    forkWorker(ds, '', true);

    const worker = forkMock.mock.results.at(-1)!.value;
    const init = vi.mocked(worker.send).mock.calls[0][0];
    expect(init.prompt).toBe('');
    expect(init.turnId).toBeUndefined();
    expect(init.vcMeetingImTurnOrigin).toBeUndefined();
    expect(init).not.toHaveProperty('promptCodexAppInput');
    expect(ds.managedTurnOrigin).toBeUndefined();
  });

  it('mints a durable identity without borrowing previous-turn routing for a no-id fork', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app', codexAppCleanInput: true }));
    const ds = makeDs({
      currentReplyTarget: {
        rootMessageId: 'om_root',
        turnId: 'om_current_vc',
        updatedAt: new Date().toISOString(),
      },
    });
    const origin = {
      listenerAppId: 'listener', meetingId: 'meeting', memberId: 'member',
      memberEpoch: 1, agentAppId: 'agent', ownerBootId: 'boot', ownerEpoch: 1,
      membershipGeneration: 1, sinkOwnerGeneration: 1,
      receiverSessionId: ds.session.sessionId, larkMessageId: 'om_current_vc',
    };
    ds.session.vcMeetingImTurnOrigins = { om_current_vc: origin };

    forkWorker(ds, payload, { resume: true });

    const worker = forkMock.mock.results.at(-1)!.value;
    const init = vi.mocked(worker.send).mock.calls[0][0];
    expect(init).toEqual(expect.objectContaining({
      prompt: payload.content,
      promptCodexAppInput: {
        text: 'clean',
        clientUserMessageId: expect.stringMatching(/^codex-app-dispatch-/),
      },
      turnId: expect.stringMatching(/^codex-app-dispatch-/),
      codexAppDispatchId: expect.any(String),
    }));
    expect(init.promptCodexAppInput.clientUserMessageId).toBe(init.turnId);
    expect(init.replyTurnId).toBeUndefined();
    expect(init.vcMeetingImTurnOrigin).toBeUndefined();
  });

  it('mints distinct persisted identities for consecutive live no-id inputs without losing reply routing', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app', codexAppCleanInput: true }));
    const worker = makeFakeWorker();
    const ds = makeDs({
      worker,
      currentReplyTarget: {
        rootMessageId: 'om_root',
        turnId: 'om_route',
        updatedAt: new Date().toISOString(),
      },
    });

    expect(sendWorkerInput(ds, { content: 'scheduler one', codexAppInput: { text: 'one' } })).toBe(true);
    expect(sendWorkerInput(ds, { content: 'scheduler two', codexAppInput: { text: 'two' } })).toBe(true);

    const messages = vi.mocked(worker.send).mock.calls.map(call => call[0]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(expect.objectContaining({
      turnId: expect.stringMatching(/^codex-app-dispatch-/),
      replyTurnId: 'om_route',
      codexAppDispatchId: expect.any(String),
    }));
    expect(messages[1]).toEqual(expect.objectContaining({
      turnId: expect.stringMatching(/^codex-app-dispatch-/),
      replyTurnId: 'om_route',
      codexAppDispatchId: expect.any(String),
    }));
    expect(messages[1].turnId).not.toBe(messages[0].turnId);
    expect(ds.session.codexAppDispatchLedger).toHaveLength(2);
    expect(ds.session.codexAppDispatchLedger?.map(entry => entry.replyTurnId)).toEqual([
      'om_route',
      'om_route',
    ]);
  });

  it('copies the inbound turn registry into the durable ledger after mutable reply state advances', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app' }));
    const worker = makeFakeWorker();
    const ds = makeDs({
      worker,
      scope: 'chat',
      currentReplyTarget: {
        rootMessageId: 'om_topic_b', turnId: 'turn-b', updatedAt: new Date().toISOString(),
      },
    });
    ds.session.scope = 'chat';
    ds.session.cliId = 'codex-app';
    ds.session.currentReplyTarget = ds.currentReplyTarget;
    ds.session.turnReplyContexts = {
      'turn-a': {
        target: { mode: 'thread', rootMessageId: 'om_topic_a' },
        quoteTargetId: 'turn-a',
        replyTargetSenderOpenId: 'ou_a',
      },
      'turn-b': { target: { mode: 'thread', rootMessageId: 'om_topic_b' } },
    };

    expect(sendWorkerInput(ds, 'late A input', 'turn-a')).toBe(true);
    expect(ds.session.codexAppDispatchLedger?.[0]?.replyTarget)
      .toEqual({ mode: 'thread', rootMessageId: 'om_topic_a' });
    expect(ds.session.codexAppDispatchLedger?.[0]).toMatchObject({
      quoteTargetId: 'turn-a', replyTargetSenderOpenId: 'ou_a',
    });
  });

  it('rejects an empty double-fork before mutating or killing a ledger-owned live worker', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app' }));
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    ds.session.cliId = 'codex-app';
    ds.session.queued = true;
    ds.session.codexAppDispatchLedger = [
      { dispatchId: 'old', turnId: 'turn-old', state: 'prepared', content: 'old' },
    ];

    forkWorker(ds, '', true);

    expect(forkMock).not.toHaveBeenCalled();
    expect(worker.send).not.toHaveBeenCalled();
    expect(worker.kill).not.toHaveBeenCalled();
    expect(ds.worker).toBe(worker);
    expect(ds.session.queued).toBe(true);
    expect(sessionStore.updateSession).not.toHaveBeenCalled();
  });

  it('routes a non-empty double-fork into the existing durable FIFO without replacing its worker', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app', codexAppCleanInput: true }));
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    ds.session.cliId = 'codex-app';
    ds.session.codexAppDispatchLedger = [
      { dispatchId: 'old', turnId: 'turn-old', state: 'prepared', content: 'old' },
    ];

    forkWorker(ds, { content: 'next', codexAppInput: { text: 'next clean' } }, {
      resume: true,
      turnId: 'turn-next',
      dispatchAttempt: 2,
    });

    expect(forkMock).not.toHaveBeenCalled();
    expect(worker.kill).not.toHaveBeenCalled();
    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      content: 'next',
      turnId: 'turn-next',
      dispatchAttempt: 2,
      codexAppDispatchId: expect.any(String),
    }));
    expect(ds.session.codexAppDispatchLedger?.map(entry => entry.turnId))
      .toEqual(['turn-old', 'turn-next']);
  });

  it('stages a non-Codex double-fork behind a tokened activation without live IPC', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'claude-code' }));
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, initialStartPending: true });
    Object.assign(ds.session, {
      cliId: 'claude-code',
      queuedActivationPending: true,
      queuedActivationToken: 'opening-token',
      queuedActivationInput: { content: 'OPENING_N' },
      queuedActivationTurnId: 'turn-opening',
    });

    forkWorker(ds, { content: 'FOLLOWER_N1' }, {
      resume: true,
      turnId: 'turn-follower',
      dispatchAttempt: 3,
    });

    expect(forkMock).not.toHaveBeenCalled();
    expect(worker.send).not.toHaveBeenCalled();
    expect(worker.kill).not.toHaveBeenCalled();
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        order: 1,
        turnId: 'turn-follower',
        dispatchAttempt: 3,
        userPrompt: 'FOLLOWER_N1',
        cliInput: { content: 'FOLLOWER_N1' },
      }),
    ]);
    expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
  });

  it('rejects a gated non-Codex double-fork when exact-tail persistence fails', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'claude-code' }));
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, initialStartPending: true });
    Object.assign(ds.session, {
      cliId: 'claude-code',
      queuedActivationPending: true,
      queuedActivationToken: 'opening-token',
      queuedActivationInput: { content: 'OPENING_N' },
      queuedActivationTurnId: 'turn-opening',
    });
    vi.mocked(sessionStore.updateSession).mockImplementationOnce(() => {
      throw new Error('tail store unavailable');
    });

    expect(() => forkWorker(ds, 'FOLLOWER_MUST_NOT_SEND', { turnId: 'turn-follower' }))
      .toThrow('tail store unavailable');

    expect(forkMock).not.toHaveBeenCalled();
    expect(worker.send).not.toHaveBeenCalled();
    expect(worker.kill).not.toHaveBeenCalled();
    expect(ds.session.queuedActivationTail).toBeUndefined();
    expect(ds.session.queuedActivationPending).toBe(true);
  });

  it('rolls back an exact tail promotion when its single durable write fails', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'claude-code' }));
    const ds = makeDs({ hasHistory: true, initialStartPending: true });
    ds.session.cliId = 'claude-code';
    ds.session.queuedActivationTail = [{
      id: 'tail-promote-1',
      order: 1,
      userPrompt: 'PROMOTE_ME',
      cliInput: { content: 'PROMOTE_ME' },
      turnId: 'turn-promote',
      dispatchAttempt: 4,
    }];
    ds.session.queuedActivationTailNextOrder = 1;
    vi.mocked(sessionStore.updateSession).mockImplementationOnce(() => {
      throw new Error('promotion store unavailable');
    });

    expect(promoteQueuedActivationTail(ds, { send: false })).toBe(false);

    expect(ds.session.queuedActivationPending).toBeUndefined();
    expect(ds.session.queuedActivationToken).toBeUndefined();
    expect(ds.session.queuedActivationInput).toBeUndefined();
    expect(ds.session.queuedActivationTail).toEqual([expect.objectContaining({
      id: 'tail-promote-1',
      turnId: 'turn-promote',
      dispatchAttempt: 4,
      cliInput: { content: 'PROMOTE_ME' },
    })]);
    expect(ds.pendingPrompt).toBeUndefined();
  });

  // ── Central quarantine guard (resolveQuarantinedForkPlan inside forkWorker) ──
  // These drive the REAL forkWorker + REAL promoteQueuedActivationTail (only the
  // child fork + session store are faked), so they cover the actual wiring codex
  // asked for: restore-time quarantine → next real fork boundary. A helper-only
  // unit test could not catch the P2-A/P2-B defects (wrong fork target / missed
  // entry point) because those live in how forkWorker applies the plan.
  describe('quarantined tail-only owner recovery at the fork boundary', () => {
    function quarantinedDs(cliId: 'codex-app' | 'claude-code'): DaemonSession {
      const ds = makeDs({
        hasHistory: true,
        initialStartPending: true,
        quarantinedActivationTailPromotion: true,
      });
      ds.session.cliId = cliId;
      // The old head that failed to promote at restore, still parked in the tail.
      ds.session.queuedActivationTail = [{
        id: 'tail-head',
        order: 1,
        userPrompt: 'OLD_HEAD',
        cliInput: { content: 'OLD_HEAD' },
        turnId: 'turn-old-head',
        dispatchAttempt: 7,
      }];
      ds.session.queuedActivationTailNextOrder = 1;
      return ds;
    }

    it('REFUSES a non-empty fork while quarantined (returns false, no fork, no promotion, no overtaking)', () => {
      vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app' }));
      const ds = quarantinedDs('codex-app');

      const forked = forkWorker(ds, 'BRAND_NEW_TURN', { turnId: 'turn-new' });

      expect(forked).toBe(false);
      // No worker started — the caller must treat the session as still worker-less.
      expect(forkMock).not.toHaveBeenCalled();
      // Promotion NOT attempted (a non-empty prompt could overtake the old head;
      // the guard bails before touching promotion).
      expect(ds.session.queuedActivationPending).toBeUndefined();
      // Still quarantined; the old head is untouched at the front of the tail.
      expect(ds.quarantinedActivationTailPromotion).toBe(true);
      expect(ds.session.queuedActivationTail?.[0]?.turnId).toBe('turn-old-head');
    });

    it('retry FAILS → refuses the blank fork, keeps worker:null + gate + quarantine (never a live worker beside an unpromoted tail)', () => {
      vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app' }));
      const ds = quarantinedDs('codex-app');
      // Promotion's single durable write still fails transiently.
      vi.mocked(sessionStore.updateSession).mockImplementationOnce(() => {
        throw new Error('promotion store still unavailable');
      });

      const forked = forkWorker(ds, '', true);

      expect(forked).toBe(false);
      expect(forkMock).not.toHaveBeenCalled();
      // Gate stays held and the session stays quarantined for a later boundary.
      expect(ds.initialStartPending).toBe(true);
      expect(ds.quarantinedActivationTailPromotion).toBe(true);
      // Old head not promoted, still parked exactly.
      expect(ds.session.queuedActivationPending).toBeUndefined();
      expect(ds.session.queuedActivationTail?.[0]?.turnId).toBe('turn-old-head');
    });

    it('retry SUCCEEDS (Codex App) → clears quarantine, forks a recovery worker for the PROMOTED OLD HEAD via the ledger', () => {
      vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app' }));
      const ds = quarantinedDs('codex-app');

      const forked = forkWorker(ds, '', true);

      expect(forked).toBe(true);
      // Promotion moved the old head into the tokened activation.
      expect(ds.session.queuedActivationPending).toBe(true);
      expect(ds.session.queuedActivationInput?.content).toBe('OLD_HEAD');
      expect(ds.session.queuedActivationTurnId).toBe('turn-old-head');
      // Quarantine cleared; a real worker was forked to recover it.
      expect(ds.quarantinedActivationTailPromotion).toBeUndefined();
      expect(forkMock).toHaveBeenCalledTimes(1);
      // Codex App recovers through its dispatch ledger, NOT the init prompt arg:
      // the promoted old head travels as the tokened queuedActivationInput (+ the
      // recovered ledger entry), so the worker is spawned with an EMPTY init
      // prompt — never a synthetic opening turn. (The head content is asserted via
      // queuedActivationInput above.)
      const worker = forkMock.mock.results.at(-1)!.value;
      const init = vi.mocked(worker.send).mock.calls[0][0];
      expect(init.type).toBe('init');
      expect(init.prompt).toBe('');
      expect(init.queuedActivationToken).toBeTruthy();
    });

    it('retry SUCCEEDS (non-Codex) → forks the exact queuedActivationInput as the recovery prompt (not an opening builder envelope)', () => {
      vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'claude-code' }));
      const ds = quarantinedDs('claude-code');

      const forked = forkWorker(ds, '', true);

      expect(forked).toBe(true);
      expect(ds.session.queuedActivationPending).toBe(true);
      expect(ds.session.queuedActivationInput?.content).toBe('OLD_HEAD');
      expect(ds.quarantinedActivationTailPromotion).toBeUndefined();
      expect(forkMock).toHaveBeenCalledTimes(1);
      // Non-Codex resubmits the exact recovered input as the worker prompt — a
      // plain 'OLD_HEAD', with no new-topic routing/<user_message> envelope wrapped
      // around it (which forkReservedInitialSession would have produced).
      const worker = forkMock.mock.results.at(-1)!.value;
      const init = vi.mocked(worker.send).mock.calls[0][0];
      expect(init.type).toBe('init');
      expect(init.prompt).toBe('OLD_HEAD');
      expect(init.prompt).not.toContain('<user_message>');
    });

    it('is a pure pass-through for a NON-quarantined session (no promotion side effects)', () => {
      vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app' }));
      const ds = quarantinedDs('codex-app');
      ds.quarantinedActivationTailPromotion = undefined; // not quarantined

      const forked = forkWorker(ds, '', true);

      expect(forked).toBe(true);
      // The old head is left exactly where it was — the guard did not promote it.
      expect(ds.session.queuedActivationPending).toBeUndefined();
      expect(ds.session.queuedActivationTail?.[0]?.turnId).toBe('turn-old-head');
    });
  });

  it('promotes the admitted clean sidecar exactly even after the live config gate flips off', () => {
    let cleanInputEnabled = true;
    vi.mocked(getBot).mockImplementation(() => defaultBot({
      cliId: 'codex-app',
      codexAppCleanInput: cleanInputEnabled,
    }));
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, initialStartPending: true, hasHistory: true });
    Object.assign(ds.session, {
      cliId: 'codex-app',
      queuedActivationPending: true,
      queuedActivationToken: 'opening-token',
      queuedActivationInput: { content: 'OPENING_N' },
      queuedActivationTurnId: 'turn-opening',
    });
    const admittedSidecar = {
      text: 'FOLLOWER_CLEAN_N1',
      additionalContext: {
        hidden: { kind: 'application' as const, value: '<hidden>exact</hidden>' },
      },
    };

    expect(sendWorkerInput(ds, {
      content: '<user_message>FOLLOWER_LEGACY_N1</user_message>',
      codexAppInput: admittedSidecar,
    }, 'turn-follower', { dispatchAttempt: 5 })).toBe(true);
    expect(worker.send).not.toHaveBeenCalled();
    expect(ds.session.queuedActivationTail?.[0]?.cliInput.codexAppInput).toEqual({
      ...admittedSidecar,
      clientUserMessageId: 'turn-follower',
    });

    // Model the opening ACK, then flip the immediate setting before N+1 is
    // promoted. The persisted entry—not current config—is authoritative.
    Object.assign(ds.session, {
      queuedActivationPending: undefined,
      queuedActivationToken: undefined,
      queuedActivationInput: undefined,
      queuedActivationTurnId: undefined,
      queuedActivationDispatchAttempt: undefined,
      queuedActivationResume: undefined,
    });
    cleanInputEnabled = false;

    expect(promoteQueuedActivationTail(ds)).toBe(true);

    const exactSidecar = {
      ...admittedSidecar,
      clientUserMessageId: 'turn-follower',
    };
    expect(ds.session.queuedActivationInput?.codexAppInput).toEqual(exactSidecar);
    expect(ds.session.codexAppDispatchLedger?.at(-1)?.codexAppInput).toEqual(exactSidecar);
    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      turnId: 'turn-follower',
      dispatchAttempt: 5,
      codexAppInput: exactSidecar,
      queuedActivationToken: expect.any(String),
    }));
  });

  it('retries the exact pre-init activation sidecar after the live gate flips off', () => {
    let cleanInputEnabled = true;
    vi.mocked(getBot).mockImplementation(() => defaultBot({
      cliId: 'codex-app',
      codexAppCleanInput: cleanInputEnabled,
    }));
    const ds = makeDs();
    Object.assign(ds.session, {
      cliId: 'codex-app',
      queued: true,
      queuedPrompt: '<user_message>OPENING_LEGACY</user_message>',
      queuedCodexAppText: 'OPENING_CLEAN',
    });
    const exactSidecar = {
      text: 'OPENING_CLEAN',
      additionalContext: {
        hidden: { kind: 'application' as const, value: '<hidden>retry-exact</hidden>' },
      },
      clientUserMessageId: 'turn-exact-retry',
    };
    const failingWorker = makeFakeWorker();
    failingWorker.send = vi.fn(() => {
      throw new Error('init IPC rejected before acceptance');
    });
    forkMock.mockReturnValueOnce(failingWorker);

    expect(() => forkWorker(ds, {
      content: '<user_message>OPENING_LEGACY</user_message>',
      codexAppInput: {
        text: exactSidecar.text,
        additionalContext: exactSidecar.additionalContext,
      },
    }, { turnId: 'turn-exact-retry', dispatchAttempt: 7 }))
      .toThrow('init IPC rejected before acceptance');

    expect(ds.session.queued).toBe(true);
    expect(ds.session.queuedActivationInput?.codexAppInput).toEqual(exactSidecar);
    expect(ds.session.codexAppDispatchLedger).toEqual([]);

    cleanInputEnabled = false;
    const retained = ds.session.queuedActivationInput!;
    forkWorker(ds, retained, {
      turnId: ds.session.queuedActivationTurnId,
      dispatchAttempt: ds.session.queuedActivationDispatchAttempt,
    });

    const retryWorker = forkMock.mock.results.at(-1)!.value;
    const retryInit = vi.mocked(retryWorker.send).mock.calls[0]![0];
    expect(retryInit.promptCodexAppInput).toEqual(exactSidecar);
    expect(ds.session.queuedActivationInput?.codexAppInput).toEqual(exactSidecar);
    expect(ds.session.codexAppDispatchLedger?.at(-1)?.codexAppInput).toEqual(exactSidecar);
  });

  it('rolls back only the new double-fork acceptance when existing-worker IPC fails', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app' }));
    const worker = makeFakeWorker();
    worker.send = vi.fn(() => { throw new Error('ipc failed'); });
    const ds = makeDs({ worker });
    ds.session.cliId = 'codex-app';
    const oldEntry = { dispatchId: 'old', turnId: 'turn-old', state: 'accepted' as const, content: 'old' };
    ds.session.codexAppDispatchLedger = [oldEntry];

    forkWorker(ds, 'next', { turnId: 'turn-next' });

    expect(forkMock).not.toHaveBeenCalled();
    expect(worker.kill).not.toHaveBeenCalled();
    expect(ds.worker).toBe(worker);
    expect(ds.session.codexAppDispatchLedger).toEqual([oldEntry]);
  });

  it('persists queued dequeue and Codex App acceptance until the exact submission ACK', async () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app' }));
    const oldEntry = {
      dispatchId: 'dispatch-existing',
      turnId: 'turn-existing',
      state: 'accepted' as const,
      content: 'existing FIFO item',
    };
    const ds = makeDs();
    Object.assign(ds.session, {
      cliId: 'codex-app',
      queued: true,
      queuedPrompt: 'queued opening',
      queuedCodexAppText: 'queued clean input',
      queuedCodexAppMessageContext: 'queued context',
      codexAppDispatchLedger: [oldEntry],
    });
    const persisted: Array<DaemonSession['session']> = [];
    vi.mocked(sessionStore.updateSession).mockImplementation(session => {
      persisted.push(structuredClone(session));
    });

    forkWorker(ds, 'queued opening', { turnId: 'turn-queued' });

    const firstDequeued = persisted.find(snapshot => snapshot.queued === false);
    expect(firstDequeued).toMatchObject({
      queued: false,
      queuedActivationPending: true,
      queuedActivationToken: expect.any(String),
      queuedActivationInput: { content: 'queued opening' },
      queuedActivationTurnId: 'turn-queued',
      queuedPrompt: 'queued opening',
      queuedCodexAppText: 'queued clean input',
      queuedCodexAppMessageContext: 'queued context',
      codexAppDispatchLedger: [
        oldEntry,
        expect.objectContaining({
          turnId: 'turn-queued',
          state: 'accepted',
          queuedActivationToken: expect.any(String),
        }),
      ],
    });
    expect(persisted).not.toContainEqual(expect.objectContaining({
      queued: false,
      codexAppDispatchLedger: [oldEntry],
    }));
    expect(ds.session).toMatchObject({
      queued: false,
      queuedActivationPending: true,
      queuedActivationToken: expect.any(String),
      queuedActivationInput: { content: 'queued opening' },
      queuedPrompt: 'queued opening',
      codexAppDispatchLedger: [
        oldEntry,
        expect.objectContaining({ turnId: 'turn-queued', state: 'accepted' }),
      ],
    });
    const worker = forkMock.mock.results.at(-1)!.value;
    const init = vi.mocked(worker.send).mock.calls[0]![0];
    expect(init.queuedActivationToken).toBe(ds.session.queuedActivationToken);
    worker.emit('message', {
      type: 'queued_activation_submitted',
      sessionId: ds.session.sessionId,
      activationToken: init.queuedActivationToken,
    });
    await vi.waitFor(() => expect(ds.session.queuedActivationPending).toBeUndefined());
    expect(ds.session.queuedActivationPending).toBeUndefined();
    expect(ds.session.queuedPrompt).toBeUndefined();
    expect(ds.session.queuedActivationInput).toBeUndefined();
  });

  it('recovers a post-init crash journal through the accepted Codex FIFO until its ACK', async () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app' }));
    const accepted = {
      dispatchId: 'dispatch-accepted-before-crash',
      turnId: 'turn-queued',
      state: 'accepted' as const,
      content: 'queued opening',
    };
    const ds = makeDs();
    Object.assign(ds.session, {
      cliId: 'codex-app',
      queued: false,
      queuedActivationPending: true,
      queuedPrompt: 'queued opening',
      queuedCodexAppText: 'queued clean input',
      queuedCodexAppMessageContext: 'queued context',
      codexAppDispatchLedger: [accepted],
    });
    const persisted: Array<DaemonSession['session']> = [];
    vi.mocked(sessionStore.updateSession).mockImplementation(session => {
      persisted.push(structuredClone(session));
    });

    forkWorker(ds, '', true);

    const worker = forkMock.mock.results.at(-1)!.value;
    const init = vi.mocked(worker.send).mock.calls[0][0];
    expect(init).toMatchObject({
      prompt: '',
      resume: true,
      queuedActivationToken: expect.any(String),
      codexAppRecoveredDispatches: [expect.objectContaining({
        ...accepted,
        queuedActivationToken: expect.any(String),
      })],
    });
    expect(init).not.toHaveProperty('codexAppDispatchId');
    expect(ds.session.codexAppDispatchLedger).toEqual([accepted]);
    expect(ds.session.queued).toBe(false);
    expect(ds.session.queuedActivationPending).toBe(true);
    expect(ds.session.queuedPrompt).toBe('queued opening');
    worker.emit('message', {
      type: 'queued_activation_submitted',
      sessionId: ds.session.sessionId,
      activationToken: init.queuedActivationToken,
    });
    await vi.waitFor(() => expect(ds.session.queuedActivationPending).toBeUndefined());
    expect(ds.session.queuedActivationPending).toBeUndefined();
    expect(ds.session.queuedPrompt).toBeUndefined();
    expect(persisted).toContainEqual(expect.objectContaining({
      queued: false,
      queuedActivationPending: undefined,
      queuedPrompt: undefined,
      codexAppDispatchLedger: [accepted],
    }));
  });

  it('durably restores a queued payload and preserves the prior FIFO when child fork throws', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({
      cliId: 'codex-app',
      codexAppCleanInput: true,
    }));
    const oldEntry = {
      dispatchId: 'dispatch-existing',
      turnId: 'turn-existing',
      state: 'accepted' as const,
      content: 'existing FIFO item',
    };
    const ds = makeDs();
    Object.assign(ds.session, {
      cliId: 'codex-app',
      queued: true,
      queuedPrompt: '<queued>wrapped opening</queued>',
      queuedCodexAppText: 'clean opening',
      queuedCodexAppMessageContext: '<context>queued</context>',
      codexAppDispatchLedger: [oldEntry],
    });
    const persisted: Array<DaemonSession['session']> = [];
    vi.mocked(sessionStore.updateSession).mockImplementation(session => {
      persisted.push(structuredClone(session));
    });
    forkMock.mockImplementationOnce(() => { throw new Error('synchronous fork failed'); });

    expect(() => forkWorker(ds, {
      content: '<queued>wrapped opening</queued>',
      codexAppInput: { text: 'clean opening' },
    }, { turnId: 'turn-queued' })).toThrow('synchronous fork failed');

    expect(ds.worker).toBeNull();
    expect(ds.session).toMatchObject({
      queued: true,
      queuedPrompt: '<queued>wrapped opening</queued>',
      queuedCodexAppText: 'clean opening',
      queuedCodexAppMessageContext: '<context>queued</context>',
    });
    expect(ds.session.codexAppDispatchLedger).toEqual([oldEntry]);
    expect(persisted.at(-1)).toMatchObject({
      queued: true,
      queuedPrompt: '<queued>wrapped opening</queued>',
      queuedCodexAppText: 'clean opening',
      queuedCodexAppMessageContext: '<context>queued</context>',
      codexAppDispatchLedger: [oldEntry],
    });
  });

  it('fences the child and atomically restores queued/FIFO state when init IPC throws', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app' }));
    const oldEntry = {
      dispatchId: 'dispatch-existing',
      turnId: 'turn-existing',
      state: 'prepared' as const,
      content: 'existing FIFO item',
    };
    const ds = makeDs();
    Object.assign(ds.session, {
      cliId: 'codex-app',
      queued: true,
      queuedPrompt: 'queued opening',
      queuedCodexAppText: 'queued clean input',
      queuedCodexAppMessageContext: 'queued context',
      codexAppDispatchLedger: [oldEntry],
    });
    const persisted: Array<DaemonSession['session']> = [];
    vi.mocked(sessionStore.updateSession).mockImplementation(session => {
      persisted.push(structuredClone(session));
    });
    const worker = makeFakeWorker();
    worker.send = vi.fn(() => { throw new Error('synchronous init IPC failed'); });
    forkMock.mockReturnValueOnce(worker);

    expect(() => forkWorker(ds, 'queued opening', { turnId: 'turn-queued' }))
      .toThrow('synchronous init IPC failed');

    expect(worker.kill).toHaveBeenCalledOnce();
    expect(ds.worker).toBeNull();
    expect(ds.session).toMatchObject({
      queued: true,
      queuedPrompt: 'queued opening',
      queuedCodexAppText: 'queued clean input',
      queuedCodexAppMessageContext: 'queued context',
    });
    expect(ds.session.codexAppDispatchLedger).toEqual([oldEntry]);
    expect(persisted.at(-1)).toMatchObject({
      queued: true,
      queuedPrompt: 'queued opening',
      codexAppDispatchLedger: [oldEntry],
    });
  });

  it('retains the exact Codex activation journal after init IPC until submission is proved', async () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app' }));
    const ds = makeDs();
    Object.assign(ds.session, {
      cliId: 'codex-app',
      queued: true,
      queuedPrompt: 'queued opening',
      queuedCodexAppText: 'queued clean input',
      codexAppDispatchLedger: [],
    });

    forkWorker(ds, 'queued opening', { turnId: 'turn-queued' });
    const worker = forkMock.mock.results.at(-1)!.value;
    worker.emit('error', new Error('async spawn error after send returned'));
    await Promise.resolve();

    expect(ds.session.queued).toBe(false);
    expect(ds.session.queuedActivationPending).toBe(true);
    expect(ds.session.queuedActivationToken).toEqual(expect.any(String));
    expect(ds.session.queuedActivationInput).toEqual({ content: 'queued opening' });
    expect(ds.session.queuedPrompt).toBe('queued opening');
    expect(ds.session.codexAppDispatchLedger).toEqual([
      expect.objectContaining({ turnId: 'turn-queued', state: 'accepted' }),
    ]);
    expect(ds.worker).toBeNull();
    expect(ds.initialStartPending).toBe(false);
    expect(worker.kill).toHaveBeenCalledOnce();
  });

  it.each(['error', 'exit'] as const)(
    'retains the exact non-Codex activation journal when its worker emits %s before ACK',
    async event => {
      const ds = makeDs();
      Object.assign(ds.session, {
        cliId: 'codex',
        queued: true,
        queuedPrompt: 'BACKLOG_AND_TRIGGER_REPLY',
      });

      forkWorker(ds, { content: 'BACKLOG_AND_TRIGGER_REPLY' }, {
        turnId: 'turn-trigger-reply',
        dispatchAttempt: 3,
      });
      const worker = forkMock.mock.results.at(-1)!.value;
      if (event === 'error') worker.emit('error', new Error('pre-ACK worker error'));
      else worker.emit('exit', 1, null);
      await Promise.resolve();

      expect(ds.worker).toBeNull();
      expect(ds.initialStartPending).toBe(false);
      expect(ds.session).toMatchObject({
        queued: false,
        queuedPrompt: 'BACKLOG_AND_TRIGGER_REPLY',
        queuedActivationPending: true,
        queuedActivationToken: expect.any(String),
        queuedActivationInput: { content: 'BACKLOG_AND_TRIGGER_REPLY' },
        queuedActivationTurnId: 'turn-trigger-reply',
        queuedActivationDispatchAttempt: 3,
        queuedActivationResume: false,
      });
      expect(vi.mocked(sessionStore.updateSession).mock.calls.map(call => call[0]))
        .toContainEqual(expect.objectContaining({
          queued: false,
          queuedActivationPending: true,
          queuedActivationInput: { content: 'BACKLOG_AND_TRIGGER_REPLY' },
        }));
    },
  );

  it('keeps the worker authoritative and restores its journal when ACK persistence fails', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const ds = makeDs();
      Object.assign(ds.session, {
        queued: true,
        queuedPrompt: 'queued opening',
      });
      forkWorker(ds, 'queued opening', { turnId: 'turn-queued' });
      const worker = forkMock.mock.results.at(-1)!.value;
      const init = vi.mocked(worker.send).mock.calls[0]![0];
      vi.mocked(sessionStore.updateSession).mockImplementationOnce(() => {
        throw new Error('ACK journal write failed');
      });

      worker.emit('message', {
        type: 'queued_activation_submitted',
        sessionId: ds.session.sessionId,
        activationToken: init.queuedActivationToken,
      });
      await Promise.resolve();

      expect(ds.worker).toBe(worker);
      expect(worker.kill).not.toHaveBeenCalled();
      expect(ds.hasHistory).toBe(false);
      expect(ds.initialStartPending).toBe(true);
      expect(ds.session).toMatchObject({
        queued: false,
        queuedActivationPending: true,
        queuedActivationToken: init.queuedActivationToken,
        queuedActivationInput: { content: 'queued opening' },
        queuedPrompt: 'queued opening',
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(ds.hasHistory).toBe(true);
      expect(ds.initialStartPending).toBe(false);
      expect(ds.session.queuedActivationPending).toBeUndefined();
      expect(ds.session.queuedActivationToken).toBeUndefined();
      expect(ds.session.queuedActivationInput).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never reports retryable activation failure after init IPC accepted the worker', () => {
    const enforceLiveSessionCap = vi.fn(() => {
      throw new Error('post-send cap projection failed');
    });
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      enforceLiveSessionCap,
    });
    vi.mocked(sessionStore.updateSessionPid).mockImplementationOnce(() => {
      throw new Error('post-send pid persistence failed');
    });
    vi.mocked(dashboardEventBus.publish).mockImplementationOnce(() => {
      throw new Error('post-send dashboard projection failed');
    });
    const ds = makeDs();
    Object.assign(ds.session, {
      queued: true,
      queuedPrompt: 'queued opening',
    });

    expect(() => forkWorker(ds, 'queued opening', { turnId: 'turn-queued' }))
      .not.toThrow();
    expect(ds.worker).toBe(forkMock.mock.results.at(-1)!.value);
    expect(ds.session).toMatchObject({
      queued: false,
      queuedActivationPending: true,
      queuedActivationInput: { content: 'queued opening' },
    });
    expect(enforceLiveSessionCap).toHaveBeenCalledOnce();
  });

  it('retries only an unaccepted ACK follow-up with exponential backoff capped at five seconds', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const callTimes: number[] = [];
      const release = vi.fn((session: DaemonSession) => {
        callTimes.push(Date.now());
        if (callTimes.length < 9) return false;
        session.initialStartPending = false;
        return true;
      });
      initWorkerPool({
        sessionReply: vi.fn(async () => 'om_reply'),
        getSessionWorkingDir: () => '/repo',
        getActiveCount: () => 1,
        closeSession: vi.fn(),
        onQueuedActivationSubmitted: release,
      });
      const ds = makeDs();
      Object.assign(ds.session, {
        queued: true,
        queuedPrompt: 'queued opening',
      });

      forkWorker(ds, 'queued opening', { turnId: 'turn-queued' });
      const worker = forkMock.mock.results.at(-1)!.value;
      const init = vi.mocked(worker.send).mock.calls[0]![0];
      worker.emit('message', {
        type: 'queued_activation_submitted',
        sessionId: ds.session.sessionId,
        activationToken: init.queuedActivationToken,
      });
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 8; i++) await vi.runOnlyPendingTimersAsync();

      expect(release).toHaveBeenCalledTimes(9);
      expect(callTimes.slice(1).map((time, i) => time - callTimes[i]!))
        .toEqual([100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000]);
      expect(ds.initialStartPending).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['accepted', 'prepared'] as const)(
    'does not restore crashed %s N beside hub replay N+1 after exact backing-missing retirement',
    state => {
      vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app' }));
      const ds = makeDs();
      ds.session.cliId = 'codex-app';
      ds.session.codexAppDispatchLedger = [{
        dispatchId: 'old-dispatch', turnId: 'delivery', dispatchAttempt: 1,
        state, content: 'old N',
      }];
      const retired = retireCodexAppDispatchAfterBackingMissing(
        ds.session.codexAppDispatchLedger,
        'delivery',
        1,
      );
      expect(retired.ok).toBe(true);
      if (!retired.ok) return;
      ds.session.codexAppDispatchLedger = retired.ledger;
      sessionStore.updateSession(ds.session);

      forkWorker(ds, 'hub replay N+1', {
        resume: true,
        turnId: 'delivery',
        dispatchAttempt: 2,
      });

      const worker = forkMock.mock.results.at(-1)!.value;
      const init = vi.mocked(worker.send).mock.calls[0][0];
      expect(init.codexAppRecoveredDispatches).toBeUndefined();
      expect(init).toEqual(expect.objectContaining({
        turnId: 'delivery',
        dispatchAttempt: 2,
        codexAppDispatchId: expect.not.stringMatching(/^old-dispatch$/),
      }));
      expect(ds.session.codexAppDispatchLedger).toEqual([
        expect.objectContaining({
          turnId: 'delivery', dispatchAttempt: 2, state: 'accepted',
        }),
      ]);
    },
  );

  it('starts an old queued activation without a sidecar and a modern one with exactly one', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app', codexAppCleanInput: true }));
    const oldPayload = applyQueuedCodexAppLegacyFallback({
      content: '<user_message>QUEUED_OLD\n\nCURRENT_OLD</user_message>',
      codexAppInput: { text: 'CURRENT_OLD' },
    }, { queued: true, queuedText: undefined });
    forkWorker(makeDs(), oldPayload, { turnId: 'om_old_queued' });
    const oldWorker = forkMock.mock.results.at(-1)!.value;
    const oldInit = vi.mocked(oldWorker.send).mock.calls[0][0];
    expect(oldInit.prompt.match(/QUEUED_OLD/g)).toHaveLength(1);
    expect(oldInit.prompt.match(/CURRENT_OLD/g)).toHaveLength(1);
    expect(oldInit).not.toHaveProperty('promptCodexAppInput');

    const modernPayload = applyQueuedCodexAppLegacyFallback({
      content: '<user_message>QUEUED_NEW\n\nCURRENT_NEW</user_message>',
      codexAppInput: { text: 'QUEUED_NEW\n\nCURRENT_NEW' },
    }, { queued: true, queuedText: 'QUEUED_NEW' });
    forkWorker(makeDs(), modernPayload, { turnId: 'om_new_queued' });
    const modernWorker = forkMock.mock.results.at(-1)!.value;
    const modernInit = vi.mocked(modernWorker.send).mock.calls[0][0];
    expect(modernInit.promptCodexAppInput.text.match(/QUEUED_NEW/g)).toHaveLength(1);
    expect(modernInit.promptCodexAppInput.text.match(/CURRENT_NEW/g)).toHaveLength(1);
  });

  it('uses the session-frozen CLI and freezes each live turn at send time', () => {
    const bot = defaultBot({ cliId: 'claude-code', codexAppCleanInput: true });
    vi.mocked(getBot).mockImplementation(() => bot);
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    ds.session.cliId = 'codex-app' as any;
    ds.session.agentFrozen = true;

    expect(sendWorkerInput(ds, payload, 'om_1')).toBe(true);
    expect(worker.send).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'message',
      content: payload.content,
      codexAppInput: { text: 'clean', clientUserMessageId: 'om_1' },
      turnId: 'om_1',
      codexAppDispatchId: expect.any(String),
    }));

    bot.config.codexAppCleanInput = undefined;
    expect(sendWorkerInput(ds, payload, 'om_2')).toBe(true);
    expect(worker.send).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'message', content: payload.content, turnId: 'om_2',
      codexAppDispatchId: expect.any(String),
    }));
  });

  it('never applies the sidecar to a frozen non-Codex-App session', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app', codexAppCleanInput: true }));
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    ds.session.cliId = 'claude-code' as any;
    ds.session.agentFrozen = true;
    sendWorkerInput(ds, payload, 'om_other');
    expect(worker.send).toHaveBeenCalledWith({
      type: 'message', content: payload.content, turnId: 'om_other',
    });
  });

  it('keeps Riff lineage fields while rejecting a Codex App sidecar on the Riff CLI', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({
      cliId: 'riff',
      backendType: 'riff',
      riff: { baseUrl: 'https://riff.example' },
      codexAppCleanInput: true,
    }));
    const ds = makeDs();
    ds.session.riffParentTaskId = 'riff-parent-task';
    ds.session.riffRepoDirs = ['/repo/primary', '/repo/secondary'];

    forkWorker(ds, payload, { turnId: 'om_riff' });

    const worker = forkMock.mock.results.at(-1)!.value;
    const init = vi.mocked(worker.send).mock.calls[0][0];
    expect(init).toEqual(expect.objectContaining({
      type: 'init',
      cliId: 'riff',
      backendType: 'riff',
      backendConfig: { baseUrl: 'https://riff.example' },
      riffParentTaskId: 'riff-parent-task',
      riffRepoDirs: ['/repo/primary', '/repo/secondary'],
      prompt: payload.content,
      turnId: 'om_riff',
    }));
    expect(init).not.toHaveProperty('promptCodexAppInput');
  });
});

describe('adopt worker re-fork forwards the incoming turn (PR#293 issue #3)', () => {
  // A tmux-adopted claude-code session whose bridge worker has exited. When a
  // new Lark turn arrives, the daemon's worker-null branch now routes adopt
  // sessions to forkAdoptWorker (not forkWorker, which would spawn a fresh
  // bmx-* CLI and lose bridge semantics). forkAdoptWorker must carry that
  // turn's prompt + turnId into the init so the worker delivers it to the
  // observed pane instead of dropping it.
  function makeAdoptDs(): DaemonSession {
    return makeDs({
      adoptedFrom: {
        source: 'tmux',
        tmuxTarget: 'work:0.0',
        originalCliPid: 4242,
        sessionId: 'sess-adopt-live',
        cliId: 'claude-code',
        cwd: '/repo',
        paneCols: 200,
        paneRows: 50,
      },
    });
  }

  it('forwards the re-fork prompt + turnId into the adopt init (not dropped)', () => {
    const ds = makeAdoptDs();
    forkAdoptWorker(ds, { prompt: '<bridge>hello from Lark</bridge>', turnId: 'om_refork_turn' });

    const init = vi.mocked((ds.worker as any).send).mock.calls[0][0];
    expect(init).toEqual(expect.objectContaining({
      type: 'init',
      adoptMode: true,
      adoptSource: 'tmux',
      adoptTmuxTarget: 'work:0.0',
      cliId: 'claude-code',
      prompt: '<bridge>hello from Lark</bridge>',
      turnId: 'om_refork_turn',
    }));
  });

  it('defaults to an observe-only empty prompt when no turn rides along (restore path)', () => {
    const ds = makeAdoptDs();
    forkAdoptWorker(ds, { restoredFromMetadata: true });

    const init = vi.mocked((ds.worker as any).send).mock.calls[0][0];
    expect(init).toEqual(expect.objectContaining({
      type: 'init',
      adoptMode: true,
      prompt: '',
    }));
    expect(init.turnId).toBeUndefined();
  });
});

describe('session.start lifecycle integration', () => {
  it('emits session.start after forkWorker spawns a worker', () => {
    forkWorker(makeDs(), 'hello', false);

    expect(emitHookEventMock).toHaveBeenCalledWith('session.start', expect.objectContaining({
      sessionId: 'sid-start-test',
      reason: 'worker_spawn',
      pid: 12345,
    }));
  });

  it('removes GitHub tokens from the daemon→worker fork env', () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    vi.stubEnv('GH_TOKEN', 'ghs_secret');

    forkWorker(makeDs(), 'hello', false);

    const forkOpts = forkMock.mock.calls.at(-1)?.[2] as { env?: Record<string, string | undefined> } | undefined;
    expect(forkOpts?.env?.GITHUB_TOKEN).toBeUndefined();
    expect(forkOpts?.env?.GH_TOKEN).toBeUndefined();

    vi.unstubAllEnvs();
  });

  it('removes leaked workflow identity from the daemon→worker fork env', () => {
    vi.stubEnv('BOTMUX_WORKFLOW', '1');
    vi.stubEnv('BOTMUX_WORKFLOW_RUN_ID', 'run-leaked');
    vi.stubEnv('BOTMUX_WORKFLOW_NODE_ID', 'node-leaked');
    vi.stubEnv('BOTMUX_V3_GOAL', '1');
    vi.stubEnv('BOTMUX_GOAL_ATTEMPT_DIR', '/tmp/leaked-attempt');

    forkWorker(makeDs(), 'hello', false);

    const forkOpts = forkMock.mock.calls.at(-1)?.[2] as { env?: Record<string, string | undefined> } | undefined;
    expect(forkOpts?.env?.BOTMUX_WORKFLOW).toBeUndefined();
    expect(forkOpts?.env?.BOTMUX_WORKFLOW_RUN_ID).toBeUndefined();
    expect(forkOpts?.env?.BOTMUX_WORKFLOW_NODE_ID).toBeUndefined();
    expect(forkOpts?.env?.BOTMUX_V3_GOAL).toBeUndefined();
    expect(forkOpts?.env?.BOTMUX_GOAL_ATTEMPT_DIR).toBeUndefined();

    vi.unstubAllEnvs();
  });

  it('re-checks the resident-session cap after spawn and again on an idle edge', async () => {
    const enforceLiveSessionCap = vi.fn();
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 31,
      closeSession: vi.fn(),
      enforceLiveSessionCap,
    });
    const ds = makeDs();

    forkWorker(ds, 'hello', false);
    expect(enforceLiveSessionCap).toHaveBeenCalledTimes(1);

    const worker = forkMock.mock.results.at(-1)!.value;
    worker.emit('message', { type: 'ready', port: 3456, token: 'token' });
    worker.emit('message', { type: 'screen_update', content: '', status: 'idle' });
    await Promise.resolve();
    expect(enforceLiveSessionCap).toHaveBeenCalledTimes(2);
  });

  it('persists an exact root-bound dispatch receipt only from the live worker generation', async () => {
    const ds = makeDs();
    ds.session.scope = 'chat';
    ds.session.rootMessageId = 'oc_chat';
    ds.session.replyTargets = {
      om_kickoff: { rootMessageId: 'om_dispatch_root', updatedAt: '2026-07-14T09:00:01.000Z' },
    };
    forkWorker(ds, 'hello', false);
    const worker = forkMock.mock.results.at(-1)!.value;
    vi.mocked(sessionStore.updateSession).mockClear();

    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_kickoff' });
    await Promise.resolve();
    expect(ds.session.dispatchInputReceipts?.om_kickoff).toEqual({
      rootMessageId: 'om_dispatch_root',
      committedAt: expect.any(String),
      workerGeneration: 1,
    });
    expect(ds.session.workerGeneration).toBe(1);
    expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);

    const prior = ds.session.dispatchInputReceipts;
    ds.worker = makeFakeWorker();
    vi.mocked(sessionStore.updateSession).mockClear();
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_stale_worker' });
    await Promise.resolve();
    expect(ds.session.dispatchInputReceipts).toBe(prior);
    expect(sessionStore.updateSession).not.toHaveBeenCalled();
  });

  it('does not fork a worker when the generation reservation cannot be persisted', () => {
    const ds = makeDs();
    const currentWorker = makeFakeWorker();
    ds.worker = currentWorker;
    ds.workerGeneration = 4;
    ds.session.workerGeneration = 4;
    ds.session.cliId = 'codex';
    ds.session.backendType = 'tmux';
    ds.session.sandbox = false;
    ds.session.sandboxHidePaths = [];
    ds.session.sandboxReadonlyPaths = [];
    ds.session.sandboxNetwork = true;
    vi.mocked(sessionStore.updateSession).mockImplementationOnce(() => {
      throw new Error('generation persistence failed');
    });

    expect(() => forkWorker(ds, 'hello', false)).toThrow(
      'generation persistence failed',
    );
    expect(forkMock).not.toHaveBeenCalled();
    expect(currentWorker.send).not.toHaveBeenCalled();
    expect(currentWorker.kill).not.toHaveBeenCalled();
    expect(ds.worker).toBe(currentWorker);
    expect(ds.workerGeneration).toBe(4);
    expect(ds.session.workerGeneration).toBe(4);
  });

  it('rotates the persisted generation before replacement IPC and rejects the old worker receipt', async () => {
    const ds = makeDs();
    ds.session.scope = 'chat';
    ds.session.rootMessageId = 'oc_chat';
    ds.session.replyTargets = {
      om_kickoff: { rootMessageId: 'om_dispatch_root', updatedAt: '2026-07-14T09:00:01.000Z' },
    };

    forkWorker(ds, 'first', false);
    const firstWorker = forkMock.mock.results.at(-1)!.value;
    firstWorker.emit('message', { type: 'turn_input_committed', turnId: 'om_kickoff' });
    await Promise.resolve();
    expect(ds.session.dispatchInputReceipts?.om_kickoff?.workerGeneration).toBe(1);

    // A daemon restore/refork replaces the Node worker. Generation 2 is
    // persisted immediately; the generation-1 receipt remains audit evidence
    // but can no longer satisfy acceptance.
    forkWorker(ds, 'replacement', { resume: true });
    const replacementWorker = forkMock.mock.results.at(-1)!.value;
    expect(ds.worker).toBe(replacementWorker);
    expect(ds.workerGeneration).toBe(2);
    expect(ds.session.workerGeneration).toBe(2);
    expect(ds.session.dispatchInputReceipts?.om_kickoff?.workerGeneration).toBe(1);

    vi.mocked(sessionStore.updateSession).mockClear();
    firstWorker.emit('message', { type: 'turn_input_committed', turnId: 'om_kickoff' });
    await Promise.resolve();
    expect(ds.session.dispatchInputReceipts?.om_kickoff?.workerGeneration).toBe(1);
    expect(sessionStore.updateSession).not.toHaveBeenCalled();
    firstWorker.emit('exit', 0, null);
    await Promise.resolve();
    expect(ds.worker).toBe(replacementWorker);
    expect(ds.session.workerGeneration).toBe(2);

    replacementWorker.emit('message', { type: 'turn_input_committed', turnId: 'om_kickoff' });
    await Promise.resolve();
    expect(ds.session.dispatchInputReceipts?.om_kickoff?.workerGeneration).toBe(2);
    expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
  });

  it('fences the persisted generation when the ACKing worker exits before dispatch polling', async () => {
    const ds = makeDs();
    ds.session.scope = 'chat';
    ds.session.rootMessageId = 'oc_chat';
    ds.session.replyTargets = {
      om_kickoff: { rootMessageId: 'om_dispatch_root', updatedAt: '2026-07-14T09:00:01.000Z' },
    };
    forkWorker(ds, 'first', false);
    const worker = forkMock.mock.results.at(-1)!.value;
    ds.session.pid = worker.pid;
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_kickoff' });
    await Promise.resolve();
    expect(ds.session.dispatchInputReceipts?.om_kickoff?.workerGeneration).toBe(1);

    vi.mocked(sessionStore.updateSession).mockClear();
    worker.emit('exit', 1, null);
    await Promise.resolve();
    expect(ds.worker).toBeNull();
    expect(ds.workerGeneration).toBe(2);
    expect(ds.session.workerGeneration).toBe(2);
    expect(ds.session.pid).toBeUndefined();
    expect(ds.session.dispatchInputReceipts?.om_kickoff?.workerGeneration).toBe(1);
    expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
  });

  it('emits session.start after forkAdoptWorker spawns an adopt worker', () => {
    forkAdoptWorker(makeDs({
      adoptedFrom: {
        tmuxTarget: 'bmx-deadbeef:0.0',
        originalCliPid: 23456,
        sessionId: 'codex-session',
        cliId: 'codex',
        cwd: '/repo',
      },
    }));

    expect(emitHookEventMock).toHaveBeenCalledWith('session.start', expect.objectContaining({
      sessionId: 'sid-start-test',
      reason: 'adopt',
      adoptedFrom: 'bmx-deadbeef:0.0',
      pid: 12345,
    }));
  });

  it('removes GitHub tokens from the daemon→adopt-worker fork env', () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    vi.stubEnv('GH_TOKEN', 'ghs_secret');

    forkAdoptWorker(makeDs({
      adoptedFrom: {
        tmuxTarget: 'bmx-deadbeef:0.0',
        originalCliPid: 23456,
        sessionId: 'codex-session',
        cliId: 'codex',
        cwd: '/repo',
      },
    }));

    const forkOpts = forkMock.mock.calls.at(-1)?.[2] as { env?: Record<string, string | undefined> } | undefined;
    expect(forkOpts?.env?.GITHUB_TOKEN).toBeUndefined();
    expect(forkOpts?.env?.GH_TOKEN).toBeUndefined();

    vi.unstubAllEnvs();
  });

  it('removes leaked workflow identity from the daemon→adopt-worker fork env', () => {
    vi.stubEnv('BOTMUX_WORKFLOW', '1');
    vi.stubEnv('BOTMUX_WORKFLOW_PTY_LOG_PATH', '/tmp/leaked-pty.log');
    vi.stubEnv('BOTMUX_V3_GOAL', '1');
    vi.stubEnv('BOTMUX_GOAL_MANIFEST_PATH', '/tmp/leaked-manifest.json');

    forkAdoptWorker(makeDs({
      adoptedFrom: {
        tmuxTarget: 'bmx-deadbeef:0.0',
        originalCliPid: 23456,
        sessionId: 'codex-session',
        cliId: 'codex',
        cwd: '/repo',
      },
    }));

    const forkOpts = forkMock.mock.calls.at(-1)?.[2] as { env?: Record<string, string | undefined> } | undefined;
    expect(forkOpts?.env?.BOTMUX_WORKFLOW).toBeUndefined();
    expect(forkOpts?.env?.BOTMUX_WORKFLOW_PTY_LOG_PATH).toBeUndefined();
    expect(forkOpts?.env?.BOTMUX_V3_GOAL).toBeUndefined();
    expect(forkOpts?.env?.BOTMUX_GOAL_MANIFEST_PATH).toBeUndefined();

    vi.unstubAllEnvs();
  });

  it('passes plugin bindings and Skill policy to the worker for CLI-generation refresh', () => {
    forkWorker(makeDs(), 'hello', false);

    const worker = forkMock.mock.results.at(-1)!.value;
    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init',
      pluginBindings: ['demo'],
      skillPolicy: { include: ['skill:deploy'] },
    }));
  });

  it('passes the persisted Lark topic title to a fresh Codex worker before its first prompt', () => {
    const ds = makeDs({
      session: {
        ...makeDs().session,
        title: '@TestBot 排查这个 TTP logid',
        nativeSessionTitle: '[BotMux·Lark] 排查这个 TTP logid',
      },
    });
    forkWorker(ds, `
<botmux_routing>routing instructions</botmux_routing>
<user_message>
@TestBot 排查这个 TTP logid 的失败原因
</user_message>
`, false);
    const worker = forkMock.mock.results.at(-1)!.value;
    const init = vi.mocked(worker.send).mock.calls[0][0];

    expect(init).toEqual(expect.objectContaining({
      type: 'init',
      nativeSessionTitle: '[BotMux·Lark] 排查这个 TTP logid',
      nativeSessionTitlePrompt: '排查这个 TTP logid 的失败原因',
    }));
  });

  it('waits when a fresh Codex topic only contains the bot mention', () => {
    const ds = makeDs({
      session: {
        ...makeDs().session,
        title: '@@TestBot',
        nativeSessionTitle: '[BotMux·Lark] @@TestBot',
        chatDisplayName: 'BotMux 标题优化群',
      },
    });
    forkWorker(ds, `
<user_message>
@@TestBot
</user_message>
`, false);
    const worker = forkMock.mock.results.at(-1)!.value;
    const init = vi.mocked(worker.send).mock.calls[0][0];

    expect(init).toEqual(expect.objectContaining({
      nativeSessionTitle: '[BotMux·Lark] BotMux 标题优化群',
    }));
    expect(init).not.toHaveProperty('nativeSessionTitlePrompt');
    expect(ds.session.nativeSessionTitleAwaitingContent).toBe(true);
  });

  it('reapplies the group fallback when a pending Codex worker restarts before any content', () => {
    const ds = makeDs({
      session: {
        ...makeDs().session,
        nativeSessionTitle: '[BotMux·Lark] BotMux 标题优化群',
        nativeSessionTitleAwaitingContent: true,
        chatDisplayName: 'BotMux 标题优化群',
      },
    });
    forkWorker(ds, '<user_message>@@TestBot</user_message>', true);
    const worker = forkMock.mock.results.at(-1)!.value;
    const init = vi.mocked(worker.send).mock.calls[0][0];

    expect(init).toEqual(expect.objectContaining({
      resume: true,
      nativeSessionTitle: '[BotMux·Lark] BotMux 标题优化群',
    }));
    expect(init).not.toHaveProperty('nativeSessionTitlePrompt');
    expect(ds.session.nativeSessionTitleAwaitingContent).toBe(true);
  });

  it('consumes only the first meaningful follow-up for a pending Codex title', () => {
    const worker = makeFakeWorker();
    const ds = makeDs({
      worker,
      session: {
        ...makeDs().session,
        cliId: 'codex',
        nativeSessionTitle: '[BotMux·Lark] 新话题',
        nativeSessionTitleAwaitingContent: true,
      },
    });

    expect(sendWorkerInput(ds, '<user_message>@@TestBot</user_message>', 'om_mention')).toBe(true);
    expect(ds.session.nativeSessionTitleAwaitingContent).toBe(true);
    expect(worker.send).toHaveBeenLastCalledWith({
      type: 'message',
      content: '<user_message>@@TestBot</user_message>',
      turnId: 'om_mention',
    });

    expect(sendWorkerInput(ds, '<user_message>@TestBot 帮我查下当前会话标题</user_message>', 'om_topic')).toBe(true);
    expect(ds.session.nativeSessionTitle).toBe('[BotMux·Lark] 帮我查下当前会话标题');
    expect(ds.session.nativeSessionTitleAwaitingContent).toBeUndefined();
    expect(worker.send).toHaveBeenLastCalledWith({
      type: 'message',
      content: '<user_message>@TestBot 帮我查下当前会话标题</user_message>',
      nativeSessionTitle: '[BotMux·Lark] 帮我查下当前会话标题',
      nativeSessionTitlePrompt: '帮我查下当前会话标题',
      turnId: 'om_topic',
    });

    expect(sendWorkerInput(ds, '<user_message>第二条有效内容</user_message>', 'om_later')).toBe(true);
    expect(worker.send).toHaveBeenLastCalledWith({
      type: 'message',
      content: '<user_message>第二条有效内容</user_message>',
      turnId: 'om_later',
    });
  });

  it('consumes a pending Codex title when a stopped worker resumes', () => {
    const ds = makeDs({
      session: {
        ...makeDs().session,
        cliSessionId: 'codex-native-pending',
        nativeSessionTitle: '[BotMux·Lark] 新话题',
        nativeSessionTitleAwaitingContent: true,
      },
    });
    forkWorker(ds, '<user_message>@TestBot 分析图片安全拦截</user_message>', true);
    const worker = forkMock.mock.results.at(-1)!.value;
    const init = vi.mocked(worker.send).mock.calls[0][0];

    expect(init).toEqual(expect.objectContaining({
      resume: true,
      nativeSessionTitle: '[BotMux·Lark] 分析图片安全拦截',
      nativeSessionTitlePrompt: '分析图片安全拦截',
    }));
    expect(ds.session.nativeSessionTitleAwaitingContent).toBeUndefined();
  });

  it('passes the pending fallback when a stopped Codex worker has no native session id yet', () => {
    const ds = makeDs({
      session: {
        ...makeDs().session,
        nativeSessionTitle: '[BotMux·Lark] 新话题',
        nativeSessionTitleAwaitingContent: true,
      },
    });
    forkWorker(ds, '<user_message>@TestBot 分析 worker 启动失败</user_message>', true);
    const worker = forkMock.mock.results.at(-1)!.value;
    const init = vi.mocked(worker.send).mock.calls[0][0];

    expect(init).toEqual(expect.objectContaining({
      resume: true,
      nativeSessionTitle: '[BotMux·Lark] 分析 worker 启动失败',
      nativeSessionTitlePrompt: '分析 worker 启动失败',
    }));
    expect(ds.session.nativeSessionTitleAwaitingContent).toBeUndefined();
  });

  it('keeps a persisted user-defined title when a fresh Codex worker starts', () => {
    const ds = makeDs({
      session: {
        ...makeDs().session,
        title: '我的手动标题',
        nativeSessionTitle: '我的手动标题',
        nativeSessionTitleUserDefined: true,
      },
    });
    forkWorker(ds, 'hello', false);
    const worker = forkMock.mock.results.at(-1)!.value;
    const init = vi.mocked(worker.send).mock.calls[0][0];

    expect(init).toEqual(expect.objectContaining({
      nativeSessionTitle: '我的手动标题',
    }));
    expect(init).not.toHaveProperty('nativeSessionTitlePrompt');
  });

  it('does not invent a title while resuming a legacy Codex session', () => {
    const ds = makeDs({
      session: {
        ...makeDs().session,
        cliSessionId: 'codex-native-1',
      },
    });
    forkWorker(ds, 'hello', true);
    const worker = forkMock.mock.results.at(-1)!.value;
    const init = vi.mocked(worker.send).mock.calls[0][0];

    expect(init).not.toHaveProperty('nativeSessionTitle');
    expect(init).not.toHaveProperty('nativeSessionTitlePrompt');
  });

  it('reapplies a managed Lark title after its Codex session resumes', () => {
    const ds = makeDs({
      session: {
        ...makeDs().session,
        cliSessionId: 'codex-native-manual',
        nativeSessionTitle: '[BotMux·Lark] 我的持久化标题',
      },
    });
    forkWorker(ds, '继续处理', true);
    const worker = forkMock.mock.results.at(-1)!.value;
    const init = vi.mocked(worker.send).mock.calls[0][0];

    expect(init).toEqual(expect.objectContaining({
      resume: true,
      cliSessionId: 'codex-native-manual',
      nativeSessionTitle: '[BotMux·Lark] 我的持久化标题',
    }));
    expect(init).not.toHaveProperty('nativeSessionTitlePrompt');
  });

  it('persists a generated native title from the current worker', () => {
    const ds = makeDs({
      session: {
        ...makeDs().session,
        nativeSessionTitle: '[BotMux·Lark] 原始内容',
      },
    });
    forkWorker(ds, '<user_message>原始内容</user_message>', false);
    const worker = forkMock.mock.results.at(-1)!.value;
    vi.mocked(sessionStore.updateSession).mockClear();

    worker.emit('message', {
      type: 'native_session_title_generated',
      title: '[BotMux·Lark] 排查图片安全拦截',
    });

    expect(ds.session.nativeSessionTitle).toBe('[BotMux·Lark] 排查图片安全拦截');
    expect(ds.session.nativeSessionTitleAwaitingContent).toBeUndefined();
    expect(ds.initConfig?.nativeSessionTitle).toBe('[BotMux·Lark] 排查图片安全拦截');
    expect(ds.initConfig?.nativeSessionTitlePrompt).toBeUndefined();
    expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
  });

  it('ignores a late generated title after the user explicitly renames the session', () => {
    const ds = makeDs({
      session: {
        ...makeDs().session,
        nativeSessionTitle: '用户标题',
        nativeSessionTitleUserDefined: true,
      },
    });
    forkWorker(ds, '<user_message>原始内容</user_message>', false);
    const worker = forkMock.mock.results.at(-1)!.value;
    vi.mocked(sessionStore.updateSession).mockClear();

    worker.emit('message', {
      type: 'native_session_title_generated',
      title: '[BotMux·Lark] 迟到的模型标题',
    });

    expect(ds.session.nativeSessionTitle).toBe('用户标题');
    expect(sessionStore.updateSession).not.toHaveBeenCalled();
  });
});

describe('blocker #3: forkAdoptWorker refuses sandbox-enabled bots', () => {
  const adopt = () => makeDs({
    adoptedFrom: {
      tmuxTarget: 'bmx-deadbeef:0.0',
      originalCliPid: 23456,
      sessionId: 'codex-session',
      cliId: 'codex',
      cwd: '/repo',
    },
  });

  it('legacy readIsolation:true → refuses to adopt + clears stale adopt metadata (no fork/session.start)', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ readIsolation: true }));
    const ds = adopt();
    ds.session.adoptedFrom = { ...ds.adoptedFrom } as any;
    forkAdoptWorker(ds);
    expect(forkMock).not.toHaveBeenCalled();
    expect(emitHookEventMock).not.toHaveBeenCalledWith('session.start', expect.anything());
    // fail-closed: no worker=null pseudo-adopt lingers; next msg cold-starts sandboxed
    expect(ds.adoptedFrom).toBeUndefined();
    expect(ds.session.adoptedFrom).toBeUndefined();
  });

  it('new sandbox:true → refuses to adopt (would run unsandboxed) + clears metadata', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ sandbox: true }));
    const ds = adopt();
    ds.session.adoptedFrom = { ...ds.adoptedFrom } as any;
    forkAdoptWorker(ds);
    expect(forkMock).not.toHaveBeenCalled();
    expect(emitHookEventMock).not.toHaveBeenCalledWith('session.start', expect.anything());
    expect(ds.adoptedFrom).toBeUndefined();
    expect(ds.session.adoptedFrom).toBeUndefined();
  });

  it('global BOTMUX_SANDBOX=1 → refuses to adopt even when the bot has no per-bot flag', () => {
    vi.stubEnv('BOTMUX_SANDBOX', '1');
    vi.mocked(getBot).mockImplementation(() => defaultBot());
    forkAdoptWorker(adopt());
    expect(forkMock).not.toHaveBeenCalled();
    expect(emitHookEventMock).not.toHaveBeenCalledWith('session.start', expect.anything());
    vi.unstubAllEnvs();
  });

  it('no sandbox anywhere → adopt proceeds (fork + session.start)', () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot());
    forkAdoptWorker(adopt());
    expect(forkMock).toHaveBeenCalled();
    expect(emitHookEventMock).toHaveBeenCalledWith('session.start', expect.objectContaining({
      reason: 'adopt',
    }));
  });
});

describe('managed turn authority worker generations', () => {
  it('revokes the old capability immediately when a normal double-fork replacement fails', () => {
    const oldWorker = makeFakeWorker();
    const ds = makeDs({
      worker: oldWorker,
      managedTurnOrigin: { capability: 'old-capability', turnId: 'turn-old' },
    });
    forkMock.mockImplementationOnce(() => { throw new Error('replacement fork failed'); });

    expect(() => forkWorker(ds, 'replacement', false)).toThrow('replacement fork failed');

    expect(oldWorker.send).toHaveBeenCalledWith({ type: 'close' });
    expect(oldWorker.kill).toHaveBeenCalled();
    expect(ds.worker).toBeNull();
    expect(ds.managedTurnOrigin).toBeUndefined();
  });

  it('revokes the old capability immediately when an adopt double-fork replacement fails', () => {
    const oldWorker = makeFakeWorker();
    const ds = makeDs({
      worker: oldWorker,
      managedTurnOrigin: { capability: 'old-adopt-capability', turnId: 'turn-old-adopt' },
      adoptedFrom: {
        source: 'tmux',
        tmuxTarget: 'bmx-deadbeef:0.0',
        originalCliPid: 23456,
        sessionId: 'codex-session',
        cliId: 'codex',
        cwd: '/repo',
      },
    });
    forkMock.mockImplementationOnce(() => { throw new Error('adopt replacement fork failed'); });

    expect(() => forkAdoptWorker(ds)).toThrow('adopt replacement fork failed');

    expect(oldWorker.send).toHaveBeenCalledWith({ type: 'close' });
    expect(oldWorker.kill).toHaveBeenCalled();
    expect(ds.worker).toBeNull();
    expect(ds.managedTurnOrigin).toBeUndefined();
  });

  it('revokes the exact live capability at terminal and leaves a rotated turn untouched', async () => {
    const ds = makeDs();
    forkWorker(ds, 'first', false);
    const worker = forkMock.mock.results.at(-1)!.value;

    worker.emit('message', {
      type: 'managed_turn_origin',
      sessionId: ds.session.sessionId,
      capability: 'terminal-capability',
      turnId: 'turn-terminal',
    });
    worker.emit('message', {
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'turn-terminal',
      status: 'completed',
    });
    await vi.waitFor(() => expect(ds.managedTurnOrigin).toBeUndefined());

    worker.emit('message', {
      type: 'managed_turn_origin',
      sessionId: ds.session.sessionId,
      capability: 'next-capability',
      turnId: 'turn-next',
    });
    worker.emit('message', {
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'turn-terminal',
      status: 'completed',
    });
    await Promise.resolve();
    expect(ds.managedTurnOrigin).toEqual({
      capability: 'next-capability',
      turnId: 'turn-next',
    });
  });

  it('revokes a live origin across an intentional CLI restart and accepts only the next turn token', () => {
    const ds = makeDs();
    forkWorker(ds, 'first', false);
    const worker = forkMock.mock.results.at(-1)!.value;

    worker.emit('message', {
      type: 'managed_turn_origin',
      sessionId: ds.session.sessionId,
      capability: 'before-restart',
      turnId: 'turn-before-restart',
      dispatchAttempt: 4,
    });
    expect(ds.managedTurnOrigin).toEqual({
      capability: 'before-restart',
      turnId: 'turn-before-restart',
      dispatchAttempt: 4,
    });

    // Intentional restart keeps the Node worker alive, so this explicit
    // message is the only host-side revocation edge.
    worker.emit('message', {
      type: 'managed_turn_origin_revoked',
      sessionId: ds.session.sessionId,
      capability: 'before-restart',
      turnId: 'turn-before-restart',
      dispatchAttempt: 4,
    });
    expect(ds.managedTurnOrigin).toBeUndefined();

    // The first real turn on the replacement CLI rotates/re-publishes.
    worker.emit('message', {
      type: 'managed_turn_origin',
      sessionId: ds.session.sessionId,
      capability: 'after-restart',
      turnId: 'turn-after-restart',
      dispatchAttempt: 5,
    });
    expect(ds.managedTurnOrigin).toEqual({
      capability: 'after-restart',
      turnId: 'turn-after-restart',
      dispatchAttempt: 5,
    });

    // A late duplicate revoke for the old token cannot erase the new turn.
    worker.emit('message', {
      type: 'managed_turn_origin_revoked',
      sessionId: ds.session.sessionId,
      capability: 'before-restart',
      turnId: 'turn-before-restart',
      dispatchAttempt: 4,
    });
    expect(ds.managedTurnOrigin).toEqual({
      capability: 'after-restart',
      turnId: 'turn-after-restart',
      dispatchAttempt: 5,
    });
  });

  it('clears authority on refork and ignores a stale worker announcement', () => {
    const ds = makeDs();
    forkWorker(ds, 'first', false);
    const firstWorker = forkMock.mock.results.at(-1)!.value;
    firstWorker.emit('message', {
      type: 'managed_turn_origin',
      sessionId: ds.session.sessionId,
      capability: 'first-capability',
      turnId: 'turn-first',
    });
    expect(ds.managedTurnOrigin).toEqual({
      capability: 'first-capability',
      turnId: 'turn-first',
    });

    forkWorker(ds, 'second', false);
    const secondWorker = forkMock.mock.results.at(-1)!.value;
    expect(ds.managedTurnOrigin).toBeUndefined();

    firstWorker.emit('message', {
      type: 'managed_turn_origin',
      sessionId: ds.session.sessionId,
      capability: 'stale-capability',
      turnId: 'turn-stale',
    });
    expect(ds.managedTurnOrigin).toBeUndefined();

    secondWorker.emit('message', {
      type: 'managed_turn_origin',
      sessionId: ds.session.sessionId,
      capability: 'second-capability',
      turnId: 'turn-second',
      dispatchAttempt: 2,
    });
    expect(ds.managedTurnOrigin).toEqual({
      capability: 'second-capability',
      turnId: 'turn-second',
      dispatchAttempt: 2,
    });

    firstWorker.emit('message', {
      type: 'managed_turn_origin_revoked',
      sessionId: ds.session.sessionId,
      capability: 'first-capability',
      turnId: 'turn-first',
    });
    expect(ds.managedTurnOrigin).toEqual({
      capability: 'second-capability',
      turnId: 'turn-second',
      dispatchAttempt: 2,
    });

    firstWorker.emit('exit', 0);
    expect(ds.managedTurnOrigin).toEqual({
      capability: 'second-capability',
      turnId: 'turn-second',
      dispatchAttempt: 2,
    });

    secondWorker.emit('exit', 0);
    expect(ds.managedTurnOrigin).toBeUndefined();
  });
});

describe('worker startup failure delivery', () => {
  it('keeps the clean init payload and reports a structured failure once to its exact originating turn', async () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app', codexAppCleanInput: true }));
    const sessionReply = vi.fn(async () => 'om_error_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();

    forkWorker(ds, {
      content: '<user_message>legacy</user_message>',
      codexAppInput: { text: 'clean', clientUserMessageId: 'preserved-id' },
    }, { turnId: 'turn-clean-start' });
    const worker = forkMock.mock.results.at(-1)!.value;
    const init = vi.mocked(worker.send).mock.calls[0][0];
    expect(init).toEqual(expect.objectContaining({
      prompt: '<user_message>legacy</user_message>',
      promptCodexAppInput: { text: 'clean', clientUserMessageId: 'preserved-id' },
      turnId: 'turn-clean-start',
    }));

    worker.emit('message', { type: 'error', message: 'nested codex dependency missing', turnId: 'turn-clean-start' });
    worker.emit('message', { type: 'error', message: 'duplicate error', turnId: 'turn-clean-start' });
    worker.emit('exit', 1);
    await Promise.resolve();
    await Promise.resolve();

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply).toHaveBeenCalledWith(
      'om_root',
      expect.stringContaining('nested codex dependency missing'),
      'text',
      'app_test',
      'turn-clean-start',
      undefined,
    );
  });

  it('keeps a live clean sidecar on one IPC and scopes crash-relaunch failure to that turn', async () => {
    vi.mocked(getBot).mockImplementation(() => defaultBot({ cliId: 'codex-app', codexAppCleanInput: true }));
    const sessionReply = vi.fn(async () => 'om_error_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    forkWorker(ds, 'opening', false);
    const worker = forkMock.mock.results.at(-1)!.value;
    worker.emit('message', { type: 'ready', port: 3456, token: 'token' });
    await Promise.resolve();
    await Promise.resolve();
    sessionReply.mockClear();

    expect(sendWorkerInput(ds, {
      content: '<user_message>legacy follow-up</user_message>',
      codexAppInput: { text: 'clean follow-up' },
    }, 'turn-live-clean')).toBe(true);
    expect(worker.send).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'message',
      content: '<user_message>legacy follow-up</user_message>',
      codexAppInput: { text: 'clean follow-up', clientUserMessageId: 'turn-live-clean' },
      turnId: 'turn-live-clean',
      codexAppDispatchId: expect.any(String),
    }));

    worker.emit('message', { type: 'error', message: 'CLI relaunch dependency disappeared', turnId: 'turn-live-clean' });
    await Promise.resolve();
    await Promise.resolve();

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply).toHaveBeenCalledWith(
      'om_root',
      expect.stringContaining('CLI relaunch dependency disappeared'),
      'text',
      'app_test',
      'turn-live-clean',
      undefined,
    );
  });

  it('replies to the originating Lark turn on a structured init error and dedupes the exit fallback', async () => {
    const sessionReply = vi.fn(async () => 'om_error_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs({
      currentReplyTarget: { rootMessageId: 'om_root', turnId: 'turn-start', updatedAt: new Date().toISOString() },
    });
    forkWorker(ds, 'hello', { turnId: 'turn-start' });
    const worker = forkMock.mock.results.at(-1)!.value;

    worker.emit('message', { type: 'error', message: '找不到可执行文件「missing-agent」', turnId: 'turn-start' });
    worker.emit('exit', 1);
    await Promise.resolve();
    await Promise.resolve();

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply).toHaveBeenCalledWith(
      'om_root',
      expect.stringContaining('missing-agent'),
      'text',
      'app_test',
      'turn-start',
      // scopedReply now forwards an (empty) opts arg after the vc-agent merge
      // added beforeQuoteFallback support; the startup-failure delivery is
      // otherwise unchanged.
      undefined,
    );
  });

  it('leaves a durable VC meeting delivery startup failure to the receipt chain (no out-of-band reply)', async () => {
    const sessionReply = vi.fn(async () => 'om_error_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    // A dedicated meeting receiver session: durable delivery failures are fenced
    // to the receipt/lease chain (workerGeneration → ambiguous → retry), so they
    // must NOT be surfaced out-of-band (which could also post on a silent delivery).
    (ds.session as unknown as { vcMeetingReceiver: unknown }).vcMeetingReceiver = {
      meetingId: 'm1', memberId: 'mem1', memberEpoch: 1,
    };
    forkWorker(ds, 'deliver', { turnId: 'vc-delivery' });
    const worker = forkMock.mock.results.at(-1)!.value;

    // A durable meeting delivery attempt carries a dispatchAttempt.
    worker.emit('message', {
      type: 'error', message: 'boom during delivery', turnId: 'vc-delivery', dispatchAttempt: 3,
    });
    worker.emit('exit', 1);
    await Promise.resolve();
    await Promise.resolve();

    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('leaves a durable VC delivery pre-ready worker exit to the receipt chain (no reply)', async () => {
    const sessionReply = vi.fn(async () => 'om_error_reply');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/repo', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    (ds.session as unknown as { vcMeetingReceiver: unknown }).vcMeetingReceiver = {
      meetingId: 'm1', memberId: 'mem1', memberEpoch: 1,
    };
    // Dispatched (queued) into a worker that dies before ready — no structured
    // error precedes it, so the abrupt-exit guard must use the frozen init attempt.
    forkWorker(ds, 'deliver', { turnId: 'vc-delivery', dispatchAttempt: 3 });
    const worker = forkMock.mock.results.at(-1)!.value;

    worker.emit('exit', 9);
    await Promise.resolve();
    await Promise.resolve();

    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('leaves a durable VC delivery fork-level error to the receipt chain (no reply)', async () => {
    const sessionReply = vi.fn(async () => 'om_error_reply');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/repo', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    (ds.session as unknown as { vcMeetingReceiver: unknown }).vcMeetingReceiver = {
      meetingId: 'm1', memberId: 'mem1', memberEpoch: 1,
    };
    forkWorker(ds, 'deliver', { turnId: 'vc-delivery', dispatchAttempt: 3 });
    const worker = forkMock.mock.results.at(-1)!.value;

    // OS-level fork failure (e.g. spawn ENOENT) surfaces via the child 'error' event.
    worker.emit('error', new Error('spawn ENOENT'));
    await Promise.resolve();
    await Promise.resolve();

    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('keeps a VC receiver IM-turn fork error out of auxiliary Lark UI', async () => {
    const sessionReply = vi.fn(async () => 'om_error_reply');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/repo', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    (ds.session as unknown as { vcMeetingReceiver: unknown }).vcMeetingReceiver = {
      meetingId: 'm1', memberId: 'mem1', memberEpoch: 1,
    };
    // A listener-group @agent IM turn has no durable dispatchAttempt, but a
    // startup diagnostic is not the exact authorized reply action.
    forkWorker(ds, 'deliver', { turnId: 'im-turn' });
    const worker = forkMock.mock.results.at(-1)!.value;

    worker.emit('error', new Error('spawn ENOENT'));
    await Promise.resolve();
    await Promise.resolve();

    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('posts a generic fallback when the worker exits before ready or structured error', async () => {
    const sessionReply = vi.fn(async () => 'om_error_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    forkWorker(ds, 'hello', false);
    const worker = forkMock.mock.results.at(-1)!.value;

    worker.emit('exit', 9);
    await Promise.resolve();
    await Promise.resolve();

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0]?.[1]).toContain('exit code: 9');
  });

  it('keeps a fatal CLI relaunch error user-visible after the worker was ready', async () => {
    const sessionReply = vi.fn(async () => 'om_error_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    forkWorker(ds, 'hello', false);
    const worker = forkMock.mock.results.at(-1)!.value;

    worker.emit('message', { type: 'ready', port: 3456, token: 'token' });
    await Promise.resolve();
    await Promise.resolve();
    sessionReply.mockClear();
    worker.emit('message', { type: 'error', message: 'CLI relaunch dependency disappeared' });
    await Promise.resolve();
    await Promise.resolve();

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0]?.[1]).toContain('CLI relaunch dependency disappeared');
  });

  it('marks an adopt fork failure as requiring attention and replies once', async () => {
    const sessionReply = vi.fn(async () => 'om_error_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs({
      adoptedFrom: {
        tmuxTarget: 'bmx-deadbeef:0.0',
        originalCliPid: 23456,
        sessionId: 'codex-session',
        cliId: 'codex',
        cwd: '/repo',
      },
    });
    forkAdoptWorker(ds);
    const worker = forkMock.mock.results.at(-1)!.value;

    worker.emit('error', new Error('adopt fork ENOENT'));
    await Promise.resolve();
    await Promise.resolve();

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0]?.[1]).toContain('adopt fork ENOENT');
    expect(emitHookEventMock).toHaveBeenCalledWith('session.requires_attention', expect.objectContaining({
      sessionId: 'sid-start-test',
      reason: 'worker_fork_error',
      message: 'adopt fork ENOENT',
    }));
  });
});

describe('forkWorker session agent config freeze', () => {
  it('freezes sandbox read and network policy on fresh sessions before spawning', () => {
    vi.mocked(getBot).mockReturnValueOnce({
      config: {
        larkAppId: 'app_test',
        larkAppSecret: 'secret',
        cliId: 'codex',
        wrapperCli: 'ttadk codex',
        model: 'glm-5.1',
        sandbox: true,
        sandboxHidePaths: ['~/.ssh'],
        sandboxReadonlyPaths: ['/srv/source-a-readonly', '/srv/source-b-readonly'],
        sandboxNetwork: false,
      },
      resolvedAllowedUsers: [],
      botOpenId: 'ou_bot',
      botName: 'TestBot',
    } as any);
    const ds = makeDs();

    forkWorker(ds, 'hello', false);

    expect(ds.session.sandbox).toBe(true);
    expect(ds.session.sandboxHidePaths).toEqual(['~/.ssh']);
    expect((ds.session as any).sandboxReadonlyPaths).toEqual(['/srv/source-a-readonly', '/srv/source-b-readonly']);
    expect((ds.session as any).sandboxNetwork).toBe(false);
    const worker = forkMock.mock.results.at(-1)!.value;
    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init',
      sandbox: true,
      sandboxHidePaths: ['~/.ssh'],
      sandboxReadonlyPaths: ['/srv/source-a-readonly', '/srv/source-b-readonly'],
      sandboxNetwork: false,
    }));
  });

  it('records cli wrapper and model on fresh sessions before spawning', () => {
    const ds = makeDs();

    forkWorker(ds, 'hello', false);

    expect(ds.session.cliId).toBe('codex');
    expect(ds.session.wrapperCli).toBe('ttadk codex');
    expect(ds.session.model).toBe('glm-5.1');
    const worker = forkMock.mock.results.at(-1)!.value;
    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init',
      cliId: 'codex',
      wrapperCli: 'ttadk codex',
      model: 'glm-5.1',
    }));
  });

  it('fills wrapper and model on fresh sessions that already stamped cliId', () => {
    const ds = makeDs();
    ds.session.cliId = 'codex' as any;

    forkWorker(ds, 'hello', false);

    expect(ds.session.cliId).toBe('codex');
    expect(ds.session.wrapperCli).toBe('ttadk codex');
    expect(ds.session.model).toBe('glm-5.1');
    const worker = forkMock.mock.results.at(-1)!.value;
    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init',
      cliId: 'codex',
      wrapperCli: 'ttadk codex',
      model: 'glm-5.1',
    }));
  });

  it('resumes a frozen session with its recorded cli/wrapper/model, ignoring bot config changes', () => {
    const ds = makeDs();
    // A session that was already frozen on a prior spawn: bot config has since
    // been switched (codex/ttadk/glm-5.1), but the frozen session must not budge.
    ds.session.cliId = 'claude-code' as any;
    ds.session.wrapperCli = 'aiden x claude';
    ds.session.model = 'opus';
    ds.session.agentFrozen = true;

    forkWorker(ds, '', true);

    const worker = forkMock.mock.results.at(-1)!.value;
    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init',
      cliId: 'claude-code',
      wrapperCli: 'aiden x claude',
      model: 'opus',
      resume: true,
    }));
  });

  it('back-fills wrapper/model from bot config on the first resume of a legacy (pre-freeze) session', () => {
    // Created before agentFrozen/wrapperCli/model existed: cliId was stamped
    // historically, but wrapper/model are absent and it has no freeze marker.
    // The bot launches via a `ttadk codex` wrapper — the first post-upgrade resume
    // must restore that wrapper, not silently relaunch as bare `codex`.
    const ds = makeDs();
    ds.session.cliId = 'codex' as any;

    forkWorker(ds, '', true);

    expect(ds.session.wrapperCli).toBe('ttadk codex');
    expect(ds.session.model).toBe('glm-5.1');
    expect(ds.session.agentFrozen).toBe(true);
    const worker = forkMock.mock.results.at(-1)!.value;
    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init',
      cliId: 'codex',
      wrapperCli: 'ttadk codex',
      model: 'glm-5.1',
      resume: true,
    }));
  });
});

// PR #307: forkWorker back-fills the effective launch dir onto session.workingDir so
// a sibling bot can inherit it (cross-bot same-dir, decoupled from oncall). The guards
// are the correctness boundary — keep them covered.
describe('forkWorker session.workingDir back-fill (cross-bot inherit enabler)', () => {
  let tmp = '';
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'botmux-backfill-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  function initPool(getSessionWorkingDir: () => string) {
    initWorkerPool({ sessionReply: vi.fn(async () => 'om_reply'), getSessionWorkingDir, getActiveCount: () => 1, closeSession: vi.fn() });
  }

  it('fills an EMPTY session.workingDir with the resolved effective dir + persists it', () => {
    initPool(() => tmp);                 // resolves to an existing, non-home dir
    const ds = makeDs();
    ds.session.workingDir = undefined;   // default/fallback session — nothing pinned
    forkWorker(ds, 'hi', false);
    expect(ds.session.workingDir).toBe(tmp);
    expect(vi.mocked(sessionStore.updateSession)).toHaveBeenCalledWith(ds.session);
  });

  it('NEVER overwrites an already-pinned session.workingDir', () => {
    initPool(() => tmp);                 // a different dir than the pin
    const ds = makeDs();
    ds.session.workingDir = '/pinned-repo';   // oncall/repo-card pinned
    forkWorker(ds, 'hi', false);
    expect(ds.session.workingDir).toBe('/pinned-repo');
  });

  it('NEVER pins the homedir crash-fallback when the resolved dir is missing', () => {
    initPool(() => join(tmp, 'gone'));   // does not exist → forkWorker falls back to homedir()
    const ds = makeDs();
    ds.session.workingDir = undefined;
    forkWorker(ds, 'hi', false);
    expect(ds.session.workingDir).toBeFalsy();   // cwd(homedir) !== rawCwd(missing) → not persisted
  });

  it('NEVER pins a legitimately-resolved $HOME (a sibling must not inherit the home dir)', () => {
    initPool(() => homedir());           // bot workingDir unset/~ → resolves to $HOME
    const ds = makeDs();
    ds.session.workingDir = undefined;
    forkWorker(ds, 'hi', false);
    expect(ds.session.workingDir).toBeFalsy();   // cwd === homedir() → excluded by guard
  });

  it('NEVER pins a SYMLINK that resolves to $HOME (realpath-compared)', () => {
    const homeLink = join(tmp, 'homelink');
    symlinkSync(homedir(), homeLink);    // a different textual path that realpaths to $HOME
    initPool(() => homeLink);
    const ds = makeDs();
    ds.session.workingDir = undefined;
    forkWorker(ds, 'hi', false);
    expect(ds.session.workingDir).toBeFalsy();   // realpath(homeLink) === realpath($HOME) → excluded
  });
});
