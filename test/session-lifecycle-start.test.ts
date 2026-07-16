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
import { forkAdoptWorker, forkWorker, initWorkerPool, sendWorkerInput } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import * as sessionStore from '../src/services/session-store.js';
import { getBot } from '../src/bot-registry.js';
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
  vi.clearAllMocks();
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
    expect(worker.send).toHaveBeenLastCalledWith({
      type: 'message',
      content: payload.content,
      codexAppInput: { text: 'clean', clientUserMessageId: 'om_1' },
      turnId: 'om_1',
    });

    bot.config.codexAppCleanInput = undefined;
    expect(sendWorkerInput(ds, payload, 'om_2')).toBe(true);
    expect(worker.send).toHaveBeenLastCalledWith({
      type: 'message', content: payload.content, turnId: 'om_2',
    });
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

describe('session.start lifecycle integration', () => {
  it('emits session.start after forkWorker spawns a worker', () => {
    forkWorker(makeDs(), 'hello', false);

    expect(emitHookEventMock).toHaveBeenCalledWith('session.start', expect.objectContaining({
      sessionId: 'sid-start-test',
      reason: 'worker_spawn',
      pid: 12345,
    }));
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

  it('passes plugin bindings and Skill policy to the worker for CLI-generation refresh', () => {
    forkWorker(makeDs(), 'hello', false);

    const worker = forkMock.mock.results.at(-1)!.value;
    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init',
      pluginBindings: ['demo'],
      skillPolicy: { include: ['skill:deploy'] },
    }));
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
    expect(worker.send).toHaveBeenLastCalledWith({
      type: 'message',
      content: '<user_message>legacy follow-up</user_message>',
      codexAppInput: { text: 'clean follow-up', clientUserMessageId: 'turn-live-clean' },
      turnId: 'turn-live-clean',
    });

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

  it('still surfaces a VC receiver IM-turn (no dispatchAttempt) fork error exactly once', async () => {
    const sessionReply = vi.fn(async () => 'om_error_reply');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/repo', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    (ds.session as unknown as { vcMeetingReceiver: unknown }).vcMeetingReceiver = {
      meetingId: 'm1', memberId: 'mem1', memberEpoch: 1,
    };
    // A listener-group @agent IM turn has no durable dispatchAttempt; the gate is
    // precise, so its startup failure is still surfaced (not blanket-suppressed).
    forkWorker(ds, 'deliver', { turnId: 'im-turn' });
    const worker = forkMock.mock.results.at(-1)!.value;

    worker.emit('error', new Error('spawn ENOENT'));
    await Promise.resolve();
    await Promise.resolve();

    expect(sessionReply).toHaveBeenCalledTimes(1);
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
