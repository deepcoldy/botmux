/**
 * Regression tests for 「Dashboard 改了 Bot 的启动命令后，会话重启仍然执行旧命令」.
 *
 * `/restart`、卡片 / Dashboard 重启、CLI 崩溃自动重启都不 refork：worker 用 fork
 * 时刻的 lastInitConfig 原地 respawn。daemon 侧 latestLaunchCommandsForRespawn 把
 * 当前 Bot 的 startupCommands / launchShell 捎带在 restart IPC 上（与 env / model
 * 同一套三分态），worker 侧的覆盖见 respawn-config-patch.test.ts，真实 worker 端到端
 * 见 worker-restart-startup-commands.integration.test.ts。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const getBotMock = vi.fn();
vi.mock('../src/bot-registry.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  getBot: (...args: unknown[]) => getBotMock(...args),
}));

vi.mock('../src/services/session-store.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  updateSession: vi.fn(),
}));

import {
  latestLaunchCommandsForRespawn,
  requestSessionRestart,
  __testOnly_resetRestartCoordinator,
} from '../src/core/worker-pool.js';

let sessionCounter = 0;

function makeDs(session: Record<string, unknown> = {}) {
  const send = vi.fn();
  const ds: any = {
    session: {
      sessionId: `startup-restart-${++sessionCounter}`,
      backendType: 'pty',
      cliId: 'claude-code',
      ...session,
    },
    larkAppId: 'cli_app1',
    hasHistory: true,
    worker: { killed: false, send },
  };
  return { ds, send };
}

function observer() {
  return { source: 'slash' as const, notify: vi.fn(async () => {}) };
}

/** A per-session `/cli` selection, frozen with its own launch commands. */
function cliSnapshot(startupCommands: string[], launchShell: string | null = null) {
  return {
    version: 1, state: 'resolved', cliId: 'codex', cliRuntime: null, cliPathOverride: null,
    wrapperCli: null, cliLaunchMode: null, reasoningEffort: null, modelBackendVariant: null,
    launchShell, startupCommands,
  };
}

beforeEach(() => {
  getBotMock.mockReset();
  __testOnly_resetRestartCoordinator();
});

afterEach(() => {
  __testOnly_resetRestartCoordinator();
});

describe('latestLaunchCommandsForRespawn', () => {
  it('reads the bot config at call time, not a fork-time copy', () => {
    const config: Record<string, unknown> = { startupCommands: ['/effort max', '/effort ultracode'] };
    getBotMock.mockReturnValue({ config });
    const { ds } = makeDs();
    expect(latestLaunchCommandsForRespawn(ds).startupCommands).toEqual(['/effort max', '/effort ultracode']);
    config.startupCommands = ['/effort xhigh'];
    config.launchShell = 'bash';
    expect(latestLaunchCommandsForRespawn(ds)).toEqual({ startupCommands: ['/effort xhigh'], launchShell: 'bash' });
  });

  it('returns null when the bot has none (explicitly cleared)', () => {
    getBotMock.mockReturnValue({ config: { startupCommands: [] } });
    expect(latestLaunchCommandsForRespawn(makeDs().ds)).toEqual({ startupCommands: null, launchShell: null });
  });

  it('returns undefined (keep the worker snapshot) when the bot lookup fails', () => {
    getBotMock.mockImplementation(() => { throw new Error('gone'); });
    expect(latestLaunchCommandsForRespawn(makeDs().ds)).toEqual({ startupCommands: undefined, launchShell: undefined });
  });

  it('keeps a frozen per-session /cli selection: its own commands win over a later bot edit', () => {
    getBotMock.mockReturnValue({ config: { startupCommands: ['/effort xhigh'], launchShell: 'zsh' } });
    const { ds } = makeDs({ cliLaunchSnapshot: cliSnapshot(['/model o3'], 'bash') });
    expect(latestLaunchCommandsForRespawn(ds)).toEqual({ startupCommands: ['/model o3'], launchShell: 'bash' });
    const empty = makeDs({ cliLaunchSnapshot: cliSnapshot([]) }).ds;
    expect(latestLaunchCommandsForRespawn(empty)).toEqual({ startupCommands: null, launchShell: null });
  });

  it('carries nothing for a Codex profile session, whose launch gate rejects startup commands', () => {
    // The profile is frozen on the session; a later bot edit adding commands
    // must not turn the next restart into a fatal unsupported_launch.
    getBotMock.mockReturnValue({ config: { startupCommands: ['/status'], launchShell: 'bash' } });
    const { ds } = makeDs({ cliId: 'codex', codexProfile: 'work' });
    expect(latestLaunchCommandsForRespawn(ds)).toEqual({ startupCommands: undefined, launchShell: undefined });
  });

  it('carries nothing for adopted sessions (observed, never driven)', () => {
    getBotMock.mockReturnValue({ config: { startupCommands: ['/effort xhigh'] } });
    const { ds } = makeDs({ adoptedFrom: { kind: 'tmux' } });
    expect(latestLaunchCommandsForRespawn(ds)).toEqual({ startupCommands: undefined, launchShell: undefined });
  });
});

describe('requestSessionRestart carries the current startup commands', () => {
  it('sends the commands configured now, after an edit made while the worker was running', () => {
    const config: Record<string, unknown> = { startupCommands: ['/effort max', '/effort ultracode'] };
    getBotMock.mockReturnValue({ config });
    const { ds, send } = makeDs();
    config.startupCommands = ['/effort xhigh'];
    requestSessionRestart(ds, observer());
    const msg = send.mock.calls[0][0];
    expect(msg.type).toBe('restart');
    expect(msg.startupCommands).toEqual(['/effort xhigh']);
    expect(msg.launchShell).toBeNull();
  });

  it('two sessions of the same bot each get their own value: the /cli-frozen one keeps its snapshot', () => {
    getBotMock.mockReturnValue({ config: { startupCommands: ['/effort xhigh'] } });
    const plain = makeDs();
    const frozen = makeDs({ cliLaunchSnapshot: cliSnapshot(['/model o3']) });
    requestSessionRestart(plain.ds, observer());
    requestSessionRestart(frozen.ds, observer());
    expect(plain.send.mock.calls[0][0].startupCommands).toEqual(['/effort xhigh']);
    expect(frozen.send.mock.calls[0][0].startupCommands).toEqual(['/model o3']);
  });

  it('a joined second request does not resend', () => {
    getBotMock.mockReturnValue({ config: { startupCommands: ['/effort xhigh'] } });
    const { ds, send } = makeDs();
    const first = requestSessionRestart(ds, observer())!;
    const second = requestSessionRestart(ds, observer())!;
    expect(second.joined).toBe(true);
    expect(second.attemptId).toBe(first.attemptId);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
