import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { emitHookEventMock, forkMock, execSyncMock } = vi.hoisted(() => ({
  emitHookEventMock: vi.fn(),
  forkMock: vi.fn(),
  execSyncMock: vi.fn(),
}));

const { prepareSessionSkillPromptMock, prepareSkillDeliveryMock } = vi.hoisted(() => ({
  prepareSessionSkillPromptMock: vi.fn((opts: any) => ({ prompt: opts.prompt, manifest: null })),
  prepareSkillDeliveryMock: vi.fn(() => ({ prompt: false, readonlyRoots: [], diagnostics: [] })),
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
    },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
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

vi.mock('../src/core/skills/session-runtime.js', () => ({
  prepareSessionSkillPrompt: (...args: unknown[]) => prepareSessionSkillPromptMock(...args),
}));

vi.mock('../src/core/skills/delivery.js', () => ({
  prepareSkillDelivery: (...args: unknown[]) => prepareSkillDeliveryMock(...args),
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
import { forkAdoptWorker, forkWorker, initWorkerPool } from '../src/core/worker-pool.js';
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

beforeEach(() => {
  vi.clearAllMocks();
  __testOnly_resetSessionLifecycleHooks();
  forkMock.mockImplementation(() => makeFakeWorker());
  prepareSessionSkillPromptMock.mockImplementation((opts: any) => ({ prompt: opts.prompt, manifest: null }));
  prepareSkillDeliveryMock.mockReturnValue({ prompt: false, readonlyRoots: [], diagnostics: [] });
  initWorkerPool({
    sessionReply: vi.fn(async () => 'om_reply'),
    getSessionWorkingDir: () => '/repo',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
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

  it('reports fatal skill delivery config instead of forking a worker', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    prepareSessionSkillPromptMock.mockReturnValue({
      prompt: 'hello',
      manifest: {
        sessionId: 'sid-start-test',
        cliId: 'codex',
        workingDir: '/repo',
        policyMode: 'priority',
        prioritySkills: [{ name: 'deploy' }],
        diagnostics: [],
        generatedAt: '2026-06-14T00:00:00.000Z',
      },
    });
    prepareSkillDeliveryMock.mockReturnValue({
      prompt: false,
      readonlyRoots: [],
      diagnostics: ['native_skill_delivery_not_supported'],
      fatal: true,
    });

    forkWorker(makeDs(), 'hello', false);
    await Promise.resolve();

    expect(forkMock).not.toHaveBeenCalled();
    expect(sessionReply).toHaveBeenCalledWith(
      'om_root',
      expect.stringContaining('native_skill_delivery_not_supported'),
      undefined,
      'app_test',
      undefined,
    );
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
