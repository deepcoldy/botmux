/**
 * prompt-hook-injection.test.ts
 *
 * buildFollowUpCliInput 的 hook 注入模式（#794）：
 *   - auto + 支持的 CLI + preflight 通过 → reminder/whiteboard 进 sidecar，PTY 文本只留其余块
 *   - off / 不支持的 CLI / preflight 失败 → inline（历史行为）
 * Run: pnpm vitest run test/prompt-hook-injection.test.ts
 */
// Must stay the first import: this file fakes node:fs, so refuse to run outside
// the data-dir fence instead of touching live botmux data (see the helper).
import './helpers/require-fenced-data-dir.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks（与 prompt-builder.test.ts 同一套） ─────────────────────────────

vi.mock('node:child_process', () => {
  const actual = require('node:child_process') as typeof import('node:child_process');
  return {
    ...actual,
    execFile: vi.fn((_file: string, _args: string[], cb?: (...args: any[]) => void) => {
      if (typeof cb === 'function') cb(null, '', '');
      return {} as any;
    }),
    execSync: vi.fn(() => ''),
    execFileSync: vi.fn(() => ''),
  };
});

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

// A synchronous `require`, NOT `await import()`. An `await import()` inside a mock
// factory HANGS under `bun test`: the file emits no output at all and is eventually
// killed, which looks like "0 tests collected" rather than an error — the most
// dangerous shape of failure, since it reads as success. `require` resolves at the
// same moment for both runners and does not deadlock.
vi.mock('node:fs', () => {
  const memfs = require('memfs') as typeof import('memfs');
  return memfs.fs;
});

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'pty', cliId: 'claude-code' },
  },
}));

vi.mock('../src/im/lark/client.js', () => ({
  downloadMessageResource: vi.fn(),
  listChatBotMembers: vi.fn(async () => []),
}));

const getBotMock = vi.fn(() => ({
  config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' } as Record<string, unknown>,
}));
// core/reply-delivery.ts 读 per-bot replyDelivery 的入口。本文件的 hook 注入用例都以
// **显式 send** 为前提（除下方专门覆盖缺省 send 与显式 transcript 的用例），
// 所以 mock 缺省返回显式 'send' 而非 undefined。
const replyDeliveryMock = vi.fn((..._args: unknown[]): 'send' | 'transcript' | undefined => 'send');
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...args: unknown[]) => getBotMock(...args),
  getAllBots: vi.fn(() => []),
  resolveReplyDelivery: (...args: unknown[]) => replyDeliveryMock(...args),
  getOwnerOpenId: vi.fn(() => undefined),
}));

const getSessionMock = vi.fn(() => undefined as any);
vi.mock('../src/services/session-store.js', () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  createSession: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../src/services/whiteboard-store.js', () => ({
  ensureDefaultWhiteboard: vi.fn(),
  getWhiteboard: vi.fn((id: string) => ({
    id,
    title: 'Whiteboard: repo',
    scope: 'project',
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
  })),
  whiteboardBoardPath: vi.fn((id: string) => `/tmp/test-sessions/whiteboards/${id}/board.md`),
  whiteboardEnabled: vi.fn(() => true),
}));

const activeRegistryMock = vi.fn((): Map<string, any> | undefined => undefined);
vi.mock('../src/core/worker-pool.js', () => ({
  dshRuntimeForSession: vi.fn((): 'official' | 'tui' | undefined => undefined),
  forkWorker: vi.fn(),
  killStalePids: vi.fn(),
  sweepDeadPidMarkers: vi.fn(),
  getActiveSessionsRegistry: (...args: unknown[]) => activeRegistryMock(...args),
  getCurrentCliVersion: vi.fn(() => '1.0.0'),
}));

const preflightMock = vi.fn((..._args: unknown[]) => true);
vi.mock('../src/adapters/hook-installer.js', () => ({
  hasInstalledPromptHookCached: (...args: unknown[]) => preflightMock(...args),
}));

const collectProtectedHttpEgressMock = vi.fn((..._args: unknown[]): unknown[] => []);
vi.mock('../src/core/protected-http-egress.js', () => ({
  collectProtectedHttpEgressPolicies: (...args: unknown[]) => collectProtectedHttpEgressMock(...args),
}));

// ─── 被测模块 ──────────────────────────────────────────────────────────────

import { buildFollowUpCliInput, buildNewTopicCliInput, promptHookRunsInCli } from '../src/core/session-manager.js';
import { plannedOpeningBackendType } from '../src/core/opening-backend.js';
import { prepareHookEnvelopeForReplay } from '../src/core/prompt-hook-replay.js';
import { DEFAULT_CLAUDE_DATA_DIR, sanitizeClaudeInput } from '../src/adapters/cli/claude-code.js';
import { claimPromptContext, claimPromptContextAmongTurns, fingerprintPromptText, prefixOf } from '../src/services/prompt-context-store.js';

const SESSION_ID = 'hook-session-789';
const LARK_APP_ID = 'app_test';
const TURN_ID = 'turn-test-1';

/** 模拟 hook 客户端：按 PTY 文本算指纹 + 前缀后，按 turnId 向宿主 claim。 */
function claimByPrompt(sessionId: string, turnId: string, ptyText: string): string | undefined {
  return claimPromptContext(sessionId, turnId, fingerprintPromptText(ptyText), prefixOf(ptyText));
}

function followUpOpts(overrides: Record<string, unknown> = {}) {
  return {
    cliId: 'claude-code',
    larkAppId: LARK_APP_ID,
    // claude-code 经 spawn chokepoint 钉在本地后端；B3 fail-closed 后必须显式传
    // 本地后端类型才允许 hook 模式（undefined 一律 inline）。
    sessionBackendType: 'pty' as const,
    // hook 模式按 (turnId, fingerprint) 绑定 sidecar；缺失 turnId 会回退 inline。
    turnId: TURN_ID,
    sender: { openId: 'ou_sender', type: 'user' as const, name: 'Sender' },
    mentions: [{ name: 'Bob', openId: 'ou_bob' }],
    ...overrides,
  };
}

function mockLiveWorker(initConfig: Record<string, unknown>): void {
  activeRegistryMock.mockReturnValue(new Map([['test-session-key', {
    session: { sessionId: SESSION_ID, status: 'active' },
    larkAppId: LARK_APP_ID,
    initConfig: { sessionId: SESSION_ID, backendType: 'pty', ...initConfig },
    worker: { killed: false, connected: true },
  }]]));
}

describe('buildFollowUpCliInput — hook 注入模式', () => {
  let prevDataDir: string | undefined;
  beforeEach(() => {
    prevDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = '/tmp/test-sessions';
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    });
    activeRegistryMock.mockReturnValue(undefined);
    getSessionMock.mockReturnValue(undefined);
    preflightMock.mockReset();
    preflightMock.mockReturnValue(true);
    collectProtectedHttpEgressMock.mockReset();
    collectProtectedHttpEgressMock.mockReturnValue([]);
  });
  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = prevDataDir;
  });

  it.each(['hook', 'inline'] as const)('exposes message location in %s mode', (mode) => {
    preflightMock.mockReturnValue(mode === 'hook');
    for (const root of [undefined, 'om_topic']) {
      const messageLocation = { messageId: 'om_followup', ...(root ? { rootMessageId: root } : {}) };
      const result = buildFollowUpCliInput('followup', SESSION_ID, followUpOpts({ messageLocation }));
      // hook 模式：位置元数据随 sender 一起进 envelope，输入框只剩正文。
      const visible = mode === 'hook' ? claimByPrompt(SESSION_ID, TURN_ID, result.content)! : result.content;
      if (mode === 'hook') {
        expect(result.content).toBe('followup');
        expect(visible).toBeDefined();
      }
      expect(visible).toContain('message_id="om_followup"');
      expect(visible).toContain(`placement="${root ? 'thread' : 'chat'}"`);
      if (root) expect(visible).toContain('root_message_id="om_topic"');
      else expect(visible).not.toContain('root_message_id=');
    }
  });

  it('默认开启 + claude-code + preflight 通过：reminder/whiteboard/sender/mentions 进 sidecar，PTY 文本只剩正文', () => {
    const result = buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts({ whiteboardId: 'wb_1' }));

    // PTY 文本：只剩用户正文，无 user_message 外壳 / sender / mentions / reminder / whiteboard
    expect(result.content).toBe('帮我修个 bug');
    expect(result.content).not.toContain('<user_message>');
    expect(result.content).not.toContain('<sender ');
    expect(result.content).not.toContain('<mentions>');
    expect(result.content).not.toContain('<botmux_reminder>');
    expect(result.content).not.toContain('<whiteboard');

    // sidecar：按 PTY 文本指纹读回，含 reminder + whiteboard + sender + mentions
    const envelope = claimByPrompt(SESSION_ID, TURN_ID, result.content);
    expect(envelope).toBeDefined();
    expect(envelope).toContain('<botmux_reminder>');
    expect(envelope).toContain('<whiteboard');
    expect(envelope).toContain('<sender ');
    expect(envelope).toContain('<mentions>');
    // hook 模式用描述式文案（命令式原文只出现在 inline 路径）
    expect(envelope).toContain('本会话通过 botmux 桥接飞书');
    expect(envelope).not.toContain('至少 botmux send 回应一次');
  });

  it('相同正文的后续 type-ahead 自动保留完整 inline，首轮仍可唯一 claim', () => {
    const first = buildFollowUpCliInput('继续', SESSION_ID, followUpOpts({ turnId: 'turn-duplicate-A' }));
    const second = buildFollowUpCliInput('继续', SESSION_ID, followUpOpts({ turnId: 'turn-duplicate-B' }));
    expect(first.content).toBe('继续');
    expect(second.content).toContain('<user_message>');
    expect(second.content).toContain('<botmux_reminder>');
    expect(second.hookEnvelope).toBeUndefined();

    const claimed = claimPromptContextAmongTurns(
      SESSION_ID,
      ['turn-duplicate-A', 'turn-duplicate-B'],
      fingerprintPromptText(first.content),
      prefixOf(first.content),
    );
    expect(claimed?.turnId).toBe('turn-duplicate-A');
    expect(claimed?.envelope).toContain('<botmux_reminder>');
    expect(claimByPrompt(SESSION_ID, 'turn-duplicate-B', second.content)).toBeUndefined();
  });

  it('sidecar 写盘失败时回退完整 inline，而不是发送去壳正文', async () => {
    const fs = await import('node:fs');
    fs.mkdirSync('/tmp', { recursive: true });
    fs.rmSync('/tmp/test-sessions', { recursive: true, force: true });
    fs.writeFileSync('/tmp/test-sessions', 'not a directory');
    try {
      const result = buildFollowUpCliInput('task requiring delivery', SESSION_ID, followUpOpts({ turnId: 'turn-write-failed' }));
      expect(result.content).toContain('<user_message>');
      expect(result.content).toContain('<botmux_reminder>');
      expect(result.hookEnvelope).toBeUndefined();
    } finally {
      fs.rmSync('/tmp/test-sessions', { force: true, recursive: true });
      fs.mkdirSync('/tmp/test-sessions', { recursive: true });
    }
  });

  it('兼容忽略遗留配置字段 envelopeInjection（off/auto）并默认走 hook 模式', () => {
    for (const legacy of ['off', 'auto', undefined] as const) {
      getBotMock.mockReturnValue({
        config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', ...(legacy ? { envelopeInjection: legacy } : {}) },
      });
      const turnId = `turn-legacy-${legacy ?? 'unset'}`;
      const result = buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts({ turnId }));
      expect(result.content).toBe('帮我修个 bug');
      expect(claimByPrompt(SESSION_ID, turnId, result.content)).toContain('<botmux_reminder>');
    }
  });

  it('不支持的 CLI（codex）即使 auto 也 inline', () => {
    const result = buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts({ cliId: 'codex' }));
    expect(result.content).toContain('<botmux_reminder>');
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });

  it('preflight 失败（hook 未安装）：inline', () => {
    preflightMock.mockReturnValue(false);
    const result = buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts());
    expect(result.content).toContain('<botmux_reminder>');
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });

  it('hook 模式下指纹容忍空白差异：hook 侧按带额外空白的文本也能读回', () => {
    const result = buildFollowUpCliInput('第一行\n第二行', SESSION_ID, followUpOpts());
    expect(result.content).not.toContain('<botmux_reminder>');
    // 模拟 hook 看到的文本（空白被 CLI 归一化）
    const withExtraWhitespace = result.content.replace('第一行\n第二行', '第一行  第二行');
    expect(claimByPrompt(SESSION_ID, TURN_ID, withExtraWhitespace)).toContain('<botmux_reminder>');
  });

  it('无 whiteboardId 时 sidecar 只含 reminder', () => {
    const result = buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts({ whiteboardId: undefined }));
    const envelope = claimByPrompt(SESSION_ID, TURN_ID, result.content);
    expect(envelope).toContain('<botmux_reminder>');
    expect(envelope).not.toContain('<whiteboard');
  });

  it('read-isolation（sandbox）下 preflight 查 per-bot BOT_HOME 的 settings，不是全局', () => {
    // 沙盒 + supportsReadIsolation 的 bot，CLI 经 CLAUDE_CONFIG_DIR 读
    // <BOT_HOME>/claude/settings.json；preflight 必须查这份，否则 per-bot
    // 安装失败时会误判已装 → 每轮系统性丢 reminder。
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', sandbox: true },
    });
    preflightMock.mockClear();
    const result = buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts());
    expect(result.content).not.toContain('<botmux_reminder>');
    expect(preflightMock).toHaveBeenCalledTimes(1);
    const checkedPath = preflightMock.mock.calls[0][0] as string;
    // effectivePath 基于 process.env.SESSION_DATA_DIR（与 worker 一致），不是 mock 的 config
    const dataDir = process.env.SESSION_DATA_DIR ?? '';
    const botmuxHome = dataDir.replace(/\/$/, '').replace(/\/[^\/]*$/, '');
    expect(checkedPath).toBe(`${botmuxHome}/bots/app_test/claude/settings.json`);
    expect(checkedPath).not.toContain('.claude');
  });

  it('read-isolation 下 per-bot 未装 hook（preflight false）→ 回退 inline', () => {
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', sandbox: true },
    });
    preflightMock.mockReturnValue(false);
    const result = buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts());
    expect(result.content).toContain('<botmux_reminder>');
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });

  it('riff 后端 + sandbox：不重定向，preflight 查全局路径（不是 BOT_HOME）', () => {
    // riff 的 CLI 跑在远端，本地 settings 不适用；willRedirect 必须排除 riff，
    // 否则会去查不存在的 BOT_HOME 文件 → 误判 inline（或更糟：BOT_HOME 有旧文件
    // 时误判 hook 模式，但远端 CLI 根本没有 hook → reminder 丢）。
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', sandbox: true, backendType: 'riff' as const },
    });
    preflightMock.mockClear();
    const result = buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts({ sessionBackendType: 'riff' as const }));
    expect(result.content).toContain('<botmux_reminder>');
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });

  it.each([
    { name: 'sandbox: "oncall"', config: { sandbox: 'oncall' as const }, env: undefined, perBot: true },
    { name: 'BOTMUX_SANDBOX=oncall', config: {}, env: 'oncall', perBot: true },
    { name: 'sandbox: "scratch"', config: { sandbox: 'scratch' as const }, env: undefined, perBot: false },
    { name: 'sandbox: true + BOTMUX_SANDBOX=scratch', config: { sandbox: true }, env: 'scratch', perBot: false },
    // 不开沙箱但配了 credentialsSourceDir：worker 同样重定向到 BOT_HOME
    { name: '非沙箱 + credentialsSourceDir', config: { credentialsSourceDir: '/acc/b' }, env: undefined, perBot: true },
    { name: '非沙箱 + 空 credentialsSourceDir', config: { credentialsSourceDir: '  ' }, env: undefined, perBot: false },
    { name: 'scratch + credentialsSourceDir', config: { sandbox: 'scratch' as const, credentialsSourceDir: '/acc/b' }, env: undefined, perBot: false },
  ])('$name：与 worker 同口径，只有 oncall 或非沙箱+凭证来源改查 BOT_HOME 的 settings', ({ config, env, perBot }) => {
    vi.stubEnv('BOTMUX_SANDBOX', env);
    try {
      getBotMock.mockReturnValue({
        config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', ...config },
      });
      preflightMock.mockClear();
      buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts());
      expect(preflightMock).toHaveBeenCalledTimes(1);
      const checkedPath = preflightMock.mock.calls[0][0] as string;
      const botHomeSettings = '/tmp/bots/app_test/claude/settings.json';
      if (perBot) expect(checkedPath).toBe(botHomeSettings);
      else expect(checkedPath).not.toBe(botHomeSettings);
    } finally { vi.unstubAllEnvs(); }
  });

  it('/cli 冻结的 wrapper/source 与 live 默认配置不同：按 worker init 查 per-bot settings', () => {
    getBotMock.mockReturnValue({
      config: {
        larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'codex', wrapperCli: 'gateway codex',
        credentialsSourceDir: '/acc/b',
      },
    });
    mockLiveWorker({ cliId: 'claude-code', wrapperCli: undefined, credentialsSourceDir: '/acc/b', sandbox: 'off' });
    const perBotSettings = '/tmp/bots/app_test/claude/settings.json';
    // 全局有 hook、per-bot 没有：判错路径会把 reminder 放进无人 claim 的 sidecar。
    preflightMock.mockClear();
    preflightMock.mockImplementation((path: unknown) => path !== perBotSettings);
    const result = buildFollowUpCliInput('wrapper probe', SESSION_ID, followUpOpts());
    expect(preflightMock).toHaveBeenCalledTimes(1);
    expect(preflightMock.mock.calls[0][0]).toBe(perBotSettings);
    expect(result.content).toContain('<botmux_reminder>');
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });

  it('运行中删除来源：旧 worker 仍按 init 查 per-bot settings，不跟 live 配置走', () => {
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    });
    mockLiveWorker({ cliId: 'claude-code', credentialsSourceDir: '/acc/a', sandbox: 'off' });
    const perBotSettings = '/tmp/bots/app_test/claude/settings.json';
    preflightMock.mockClear();
    preflightMock.mockImplementation((path: unknown) => path !== perBotSettings);
    const result = buildFollowUpCliInput('source removal probe', SESSION_ID, followUpOpts());
    expect(preflightMock).toHaveBeenCalledTimes(1);
    expect(preflightMock.mock.calls[0][0]).toBe(perBotSettings);
    expect(result.content).toContain('<botmux_reminder>');
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });

  it('运行中新增来源：旧 worker 仍按 init 查全局 settings，不提前切到 per-bot', () => {
    getBotMock.mockReturnValue({
      config: {
        larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code',
        credentialsSourceDir: '/acc/b',
      },
    });
    mockLiveWorker({ cliId: 'claude-code', credentialsSourceDir: undefined, sandbox: 'off' });
    const perBotSettings = '/tmp/bots/app_test/claude/settings.json';
    const globalSettings = `${DEFAULT_CLAUDE_DATA_DIR}/settings.json`;
    // per-bot 有 hook、实际旧 worker 读取的全局没有：只有查全局才能安全回退 inline。
    preflightMock.mockClear();
    preflightMock.mockImplementation((path: unknown) => path === perBotSettings);
    const result = buildFollowUpCliInput('source addition probe', SESSION_ID, followUpOpts());
    expect(preflightMock).toHaveBeenCalledTimes(1);
    expect(preflightMock.mock.calls[0][0]).toBe(globalSettings);
    expect(result.content).toContain('<botmux_reminder>');
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });

  it('已有会话但没有可信存活 worker：不用 live 配置进 hook，回退 inline', () => {
    getSessionMock.mockReturnValue({ sessionId: SESSION_ID, status: 'active' });
    preflightMock.mockClear();
    const result = buildFollowUpCliInput('worker missing probe', SESSION_ID, followUpOpts());
    expect(result.content).toContain('<botmux_reminder>');
    expect(preflightMock).not.toHaveBeenCalled();
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });

  it.each([
    ['worker 已 killed', { killed: true, connected: true }],
    ['worker 断开连接', { killed: false, connected: false }],
  ] as const)('registry 有会话但 %s：不沿用旧 init 判 hook，回退 inline', (_label, workerState) => {
    activeRegistryMock.mockReturnValue(new Map([['test-session-key', {
      session: { sessionId: SESSION_ID, status: 'active' },
      larkAppId: LARK_APP_ID,
      // 旧 init 指向 per-bot 目录，但读它的 worker 已不可信。
      initConfig: { sessionId: SESSION_ID, backendType: 'pty', cliId: 'claude-code', credentialsSourceDir: '/acc/b', sandbox: 'off' },
      worker: workerState,
    }]]));
    getBotMock.mockReturnValue({
      config: {
        larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code',
        credentialsSourceDir: '/acc/b',
      },
    });
    preflightMock.mockClear();
    const result = buildFollowUpCliInput('untrusted worker probe', SESSION_ID, followUpOpts());
    expect(result.content).toContain('<botmux_reminder>');
    expect(preflightMock).not.toHaveBeenCalled();
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });

  it('registry 有会话但缺 initConfig：回退 inline 而非读空 init 抛错', () => {
    activeRegistryMock.mockReturnValue(new Map([['test-session-key', {
      session: { sessionId: SESSION_ID, status: 'active' },
      larkAppId: LARK_APP_ID,
      worker: { killed: false, connected: true },
    }]]));
    preflightMock.mockClear();
    const result = buildFollowUpCliInput('missing init probe', SESSION_ID, followUpOpts());
    expect(result.content).toContain('<botmux_reminder>');
    expect(preflightMock).not.toHaveBeenCalled();
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });

  it('BOTMUX_SANDBOX 非法值：不做 preflight，回退 inline', () => {
    vi.stubEnv('BOTMUX_SANDBOX', 'yes');
    try {
      preflightMock.mockClear();
      const result = buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts());
      expect(preflightMock).not.toHaveBeenCalled();
      expect(result.content).toContain('<botmux_reminder>');
    } finally { vi.unstubAllEnvs(); }
  });

  it('hc 会话的 CLI 跑在本机：走 hook 模式，reminder 进 sidecar', () => {
    const result = buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts({ sessionBackendType: 'hc' as const }));
    expect(result.content).toBe('帮我修个 bug');
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toContain('<botmux_reminder>');
  });

  it('未知后端类型（白名单外）：强制 inline（hardening）', () => {
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    });
    const result = buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts({ sessionBackendType: 'future-remote' as any }));
    expect(result.content).toContain('<botmux_reminder>');
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });

  it('B3 fail-closed：sessionBackendType 缺失（undefined）时强制 inline，不短路进 hook', () => {
    // review B3：旧实现 `opts.sessionBackendType && !LOCAL_BACKENDS.has(...)` 在
    // undefined 时短路放过，误进 hook 模式。改为 fail-closed 后必须 inline。
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    });
    const result = buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts({ sessionBackendType: undefined }));
    expect(result.content).toContain('<botmux_reminder>');
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });

  // ─── replyDelivery=transcript：续轮不注入 reminder，sidecar 不再承载它 ────────

  it('auto + transcript + whiteboard：sidecar 含 whiteboard 与 sender，reminder 两边都没有', () => {
    replyDeliveryMock.mockReturnValue('transcript');
    try {
      const result = buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts({ whiteboardId: 'wb_t' }));
      // hook 模式下 PTY 文本只剩用户正文，外壳与 sender/mentions 都进 sidecar。
      expect(result.content).toBe('帮我修个 bug');
      expect(result.content).not.toContain('<botmux_reminder>');
      expect(result.content).not.toContain('<whiteboard');
      const envelope = claimByPrompt(SESSION_ID, TURN_ID, result.content);
      expect(envelope).toBeDefined();
      expect(envelope).toContain('<whiteboard');
      expect(envelope).toContain('<sender ');
      expect(envelope).not.toContain('<botmux_reminder>');
      // 白板末句改口：不再要求「仍必须 botmux send」。
      expect(envelope).toContain('用户可见结论写进最终回复即可');
      expect(envelope).not.toContain('仍必须');
    } finally {
      replyDeliveryMock.mockReturnValue('send');
    }
  });

  it('auto + transcript 无 whiteboard：envelope 只剩 sender，仍走 hook（reminder 两边都没有）', () => {
    replyDeliveryMock.mockReturnValue('transcript');
    try {
      const result = buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts({ whiteboardId: undefined }));
      expect(result.content).toBe('帮我修个 bug');
      expect(result.content).not.toContain('<botmux_reminder>');
      const envelope = claimByPrompt(SESSION_ID, TURN_ID, result.content);
      expect(envelope).toContain('<sender ');
      expect(envelope).not.toContain('<botmux_reminder>');
    } finally {
      replyDeliveryMock.mockReturnValue('send');
    }
  });

  it('未显式配置 + claude-code：缺省 send，与显式 send 的 PTY 相同且 reminder 进 sidecar', () => {
    replyDeliveryMock.mockReturnValue('send');
    let explicit: string;
    try {
      explicit = buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts({ whiteboardId: undefined })).content;
    } finally {
      replyDeliveryMock.mockReturnValue(undefined);
    }
    try {
      const result = buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts({ whiteboardId: undefined }));
      expect(result.content).toBe(explicit);
      expect(result.content).toBe('帮我修个 bug');
      const envelope = claimByPrompt(SESSION_ID, TURN_ID, result.content);
      expect(envelope).toContain('<botmux_reminder>');
      expect(envelope).toContain('<sender ');
    } finally {
      replyDeliveryMock.mockReturnValue('send');
    }
  });
  it('hook 模式下 empty envelope（noTransport + omitReminder + 无 whiteboard/sender/mentions）去壳且不写 sidecar', () => {
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', apiOnly: true },
    });
    const result = buildFollowUpCliInput('静默续轮', SESSION_ID, followUpOpts({
      chatId: 'oc_api_only',
      omitReminder: true,
      whiteboardId: undefined,
      sender: undefined,
      mentions: undefined,
    }));
    expect(result.content).toBe('静默续轮');
    expect(result.content).not.toContain('<user_message>');
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });

  it('adopt 会话（isAdoptMode / live adoptMode / ds.adoptedFrom）fail-closed 回退 inline', () => {
    // 1. 显式 isAdoptMode: true（如 trigger-session 触发 adopted claude-code）
    const r1 = buildFollowUpCliInput('trigger adopt', SESSION_ID, followUpOpts({ isAdoptMode: true }));
    expect(r1.content).toContain('<botmux_reminder>');
    expect(claimByPrompt(SESSION_ID, TURN_ID, r1.content)).toBeUndefined();

    // 2. 活 worker 的 initConfig.adoptMode = true
    mockLiveWorker({ cliId: 'claude-code', adoptMode: true });
    const r2 = buildFollowUpCliInput('live adopt worker', SESSION_ID, followUpOpts());
    expect(r2.content).toContain('<botmux_reminder>');
    expect(claimByPrompt(SESSION_ID, TURN_ID, r2.content)).toBeUndefined();
    expect(promptHookRunsInCli({ cliId: 'claude-code', sessionBackendType: 'pty', larkAppId: LARK_APP_ID, sessionId: SESSION_ID })).toBe(false);

    // 3. ds.adoptedFrom 置位
    activeRegistryMock.mockReturnValue(new Map([['k', {
      session: { sessionId: SESSION_ID, status: 'active' },
      larkAppId: LARK_APP_ID,
      adoptedFrom: 'tmux-1',
      initConfig: { sessionId: SESSION_ID, backendType: 'pty', cliId: 'claude-code' },
      worker: { killed: false, connected: true },
    }]]));
    const r3 = buildFollowUpCliInput('ds adoptedFrom', SESSION_ID, followUpOpts());
    expect(r3.content).toContain('<botmux_reminder>');
    expect(promptHookRunsInCli({ cliId: 'claude-code', sessionBackendType: 'pty', larkAppId: LARK_APP_ID, sessionId: SESSION_ID })).toBe(false);
  });

  it('非回环沙盒（sandboxNetwork:false / sandboxNetworkPolicy / protectedHttpEgressPolicy / reportedIdentityModel.loopbackShared:false）fail-closed 回退 inline', () => {
    // 1. oncall + sandboxNetwork: false
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', sandbox: 'oncall', sandboxNetwork: false },
    });
    expect(buildFollowUpCliInput('no net oncall', SESSION_ID, followUpOpts()).content).toContain('<botmux_reminder>');
    expect(promptHookRunsInCli({ cliId: 'claude-code', sessionBackendType: 'pty', larkAppId: LARK_APP_ID, sessionId: SESSION_ID })).toBe(false);

    // 2. scratch + sandboxNetwork: false
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', sandbox: 'scratch', sandboxNetwork: false },
    });
    expect(buildFollowUpCliInput('no net scratch', SESSION_ID, followUpOpts()).content).toContain('<botmux_reminder>');

    // 3. sandbox: off + sandboxNetwork: false → 沙盒未启用，loopback 仍共享，正常走 hook
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', sandbox: 'off', sandboxNetwork: false },
    });
    expect(buildFollowUpCliInput('sandbox off', SESSION_ID, followUpOpts()).content).toBe('sandbox off');

    // 4. oncall + sandboxNetworkPolicy（slirp netns 不共享宿主 loopback）
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', sandbox: 'oncall', sandboxNetworkPolicy: { allow: ['example.com'] } },
    });
    expect(buildFollowUpCliInput('slirp policy', SESSION_ID, followUpOpts()).content).toContain('<botmux_reminder>');
    expect(promptHookRunsInCli({ cliId: 'claude-code', sessionBackendType: 'pty', larkAppId: LARK_APP_ID, sessionId: SESSION_ID })).toBe(false);

    // 5. oncall + live plugin protectedHttpEgressPolicy
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', sandbox: 'oncall', plugins: ['egress-plugin'] },
    });
    collectProtectedHttpEgressMock.mockReturnValue([{ pluginId: 'egress-plugin', policy: { allow: ['api.example.com'] }, policyDigest: 'd1' }]);
    expect(buildFollowUpCliInput('protected egress', SESSION_ID, followUpOpts()).content).toContain('<botmux_reminder>');
    expect(promptHookRunsInCli({ cliId: 'claude-code', sessionBackendType: 'pty', larkAppId: LARK_APP_ID, sessionId: SESSION_ID })).toBe(false);
    collectProtectedHttpEgressMock.mockReturnValue([]);

    // 6. live worker 上报 reportedIdentityModel.loopbackShared === false 或 initConfig.protectedHttpEgressPolicy
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', sandbox: 'oncall' },
    });
    activeRegistryMock.mockReturnValue(new Map([['k', {
      session: { sessionId: SESSION_ID, status: 'active' },
      larkAppId: LARK_APP_ID,
      initConfig: { sessionId: SESSION_ID, backendType: 'pty', cliId: 'claude-code', sandbox: 'oncall' },
      reportedIdentityModel: { model: 'single', sandboxEngaged: true, loopbackShared: false, workerPid: 1, workerGeneration: 1, reportedAt: 1 },
      worker: { killed: false, connected: true },
    }]]));
    expect(buildFollowUpCliInput('reported loopback false', SESSION_ID, followUpOpts()).content).toContain('<botmux_reminder>');
    expect(promptHookRunsInCli({ cliId: 'claude-code', sessionBackendType: 'pty', larkAppId: LARK_APP_ID, sessionId: SESSION_ID })).toBe(false);

    mockLiveWorker({ cliId: 'claude-code', sandbox: 'oncall', protectedHttpEgressPolicy: { pluginId: 'p', policy: {}, policyDigest: 'd' } });
    expect(buildFollowUpCliInput('init protected egress', SESSION_ID, followUpOpts()).content).toContain('<botmux_reminder>');
  });

  it('自定义 cliConfigDir 与助理模式 assistantMode 精确检查生效 settings 路径', () => {
    // 1. 非沙盒 bot 配了 cliConfigDir：查 <cliConfigDir>/settings.json，不查全局
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', cliConfigDir: '/profiles/custom-claude' },
    });
    preflightMock.mockClear();
    preflightMock.mockImplementation((path: unknown) => path === '/profiles/custom-claude/settings.json');
    expect(buildFollowUpCliInput('custom profile', SESSION_ID, followUpOpts()).content).toBe('custom profile');
    expect(preflightMock).toHaveBeenCalledWith('/profiles/custom-claude/settings.json');

    // 2. 活 worker 的 initConfig.cliConfigDir 覆盖 live botConfig.cliConfigDir
    mockLiveWorker({ cliId: 'claude-code', cliConfigDir: '/profiles/frozen-worker', sandbox: 'off' });
    preflightMock.mockClear();
    preflightMock.mockImplementation((path: unknown) => path === '/profiles/frozen-worker/settings.json');
    expect(buildFollowUpCliInput('frozen profile', SESSION_ID, followUpOpts()).content).toBe('frozen profile');
    expect(preflightMock).toHaveBeenCalledWith('/profiles/frozen-worker/settings.json');

    // 3. 助理模式活 worker：查 <BOT_HOME>/users/<owner>/claude/settings.json
    const owner = 'ou_0123456789abcdef0123456789abcdef';
    const assistantSettings = `/tmp/bots/app_test/users/${owner}/claude/settings.json`;
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', sandbox: 'oncall', assistantMode: true },
    });
    mockLiveWorker({ cliId: 'claude-code', sandbox: 'oncall', assistantOwnerOpenId: owner });
    preflightMock.mockClear();
    preflightMock.mockImplementation((path: unknown) => path === assistantSettings);
    expect(buildFollowUpCliInput('assistant live', SESSION_ID, followUpOpts()).content).toBe('assistant live');
    expect(preflightMock).toHaveBeenCalledWith(assistantSettings);

    // 4. 助理模式但 assistantOwnerOpenId 非法或未开 oncall 沙盒：fail-closed 回退 inline
    mockLiveWorker({ cliId: 'claude-code', sandbox: 'off', assistantOwnerOpenId: owner });
    preflightMock.mockClear();
    expect(buildFollowUpCliInput('assistant bad sandbox', SESSION_ID, followUpOpts()).content).toContain('<botmux_reminder>');
    expect(preflightMock).not.toHaveBeenCalled();

    mockLiveWorker({ cliId: 'claude-code', sandbox: 'oncall', assistantOwnerOpenId: 'bad_owner' });
    preflightMock.mockClear();
    expect(buildFollowUpCliInput('assistant bad owner', SESSION_ID, followUpOpts()).content).toContain('<botmux_reminder>');
    expect(preflightMock).not.toHaveBeenCalled();
  });
});

describe('buildNewTopicCliInput — hook 注入模式（opening）', () => {
  let prevDataDir: string | undefined;
  beforeEach(() => {
    prevDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = '/tmp/test-sessions';
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    });
    activeRegistryMock.mockReturnValue(undefined);
    getSessionMock.mockReturnValue(undefined);
    preflightMock.mockReset();
    preflightMock.mockReturnValue(true);
    collectProtectedHttpEgressMock.mockReset();
    collectProtectedHttpEgressMock.mockReturnValue([]);
  });
  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = prevDataDir;
  });

  const openingOpts = (overrides: Record<string, unknown> = {}) => ({
    larkAppId: LARK_APP_ID,
    whiteboardId: 'wb_1',
    turnId: TURN_ID,
    sessionBackendType: 'pty' as const,
    ...overrides,
  });

  it('默认开启 + claude-code + preflight 通过 + turnId：whiteboard/sender/mentions/availableBots 进 sidecar，PTY 文本只剩正文且保留 trustedCaller', () => {
    const trustedCaller = { openId: 'ou_creator', unionId: 'on_creator', isBot: false };
    const result = buildNewTopicCliInput(
      '帮我修个 bug', SESSION_ID, 'claude-code', undefined,
      undefined,
      [{ name: 'Bob', openId: 'ou_bob' }],
      [{ name: 'Helper', displayName: 'Helper', openId: 'ou_helper' }],
      undefined,
      { name: 'Bot', openId: 'ou_bot' },
      undefined,
      { openId: 'ou_sender', type: 'user' as const, name: 'Sender' },
      openingOpts({ trustedCaller }),
    );

    // PTY 文本：只剩用户正文，无 user_message 外壳 / sender / mentions / whiteboard / available_bots
    expect(result.content).toBe('帮我修个 bug');
    expect(result.trustedCaller).toEqual(trustedCaller);
    expect(result.content).not.toContain('<user_message>');
    expect(result.content).not.toContain('<sender ');
    expect(result.content).not.toContain('<mentions>');
    expect(result.content).not.toContain('<whiteboard');
    expect(result.content).not.toContain('<available_bots');

    // sidecar：含 whiteboard + sender + mentions + available_bots
    const envelope = claimByPrompt(SESSION_ID, TURN_ID, result.content);
    expect(envelope).toBeDefined();
    expect(envelope).toContain('<whiteboard');
    expect(envelope).toContain('<sender ');
    expect(envelope).toContain('<mentions>');
    expect(envelope).toContain('<available_bots');
  });

  it('缺 turnId：回退 inline（有 user_message 外壳，无 sidecar）', () => {
    const result = buildNewTopicCliInput(
      '帮我修个 bug', SESSION_ID, 'claude-code', undefined,
      undefined, undefined, undefined, undefined,
      { name: 'Bot', openId: 'ou_bot' },
      undefined,
      { openId: 'ou_sender', type: 'user' as const, name: 'Sender' },
      openingOpts({ turnId: undefined }),
    );
    expect(result.content).toContain('<user_message>');
    expect(result.content).toContain('<sender ');
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });

  it('遗留配置含 envelopeInjection: off：兼容忽略，opening 仍默认走 hook 模式', () => {
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', envelopeInjection: 'off' },
    });
    const result = buildNewTopicCliInput(
      '帮我修个 bug', SESSION_ID, 'claude-code', undefined,
      undefined, undefined, undefined, undefined,
      { name: 'Bot', openId: 'ou_bot' },
      undefined,
      { openId: 'ou_sender', type: 'user' as const, name: 'Sender' },
      openingOpts(),
    );
    expect(result.content).toBe('帮我修个 bug');
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toContain('<sender ');
  });

  it('无 whiteboard/sender/mentions/availableBots（envelope 为空）且有 turnId：去 <user_message> 外壳、不写 sidecar、保留 trustedCaller', () => {
    const trustedCaller = { openId: 'ou_sched', isBot: false };
    const result = buildNewTopicCliInput(
      '帮我修个 bug', SESSION_ID, 'claude-code', undefined,
      undefined, undefined, undefined, undefined,
      undefined,
      undefined,
      undefined,
      openingOpts({ whiteboardId: undefined, trustedCaller }),
    );
    expect(result.content).toBe('帮我修个 bug');
    expect(result.content).not.toContain('<user_message>');
    expect(result.trustedCaller).toEqual(trustedCaller);
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });

  it('opening envelope 超过 8000 字符上限：无损回退 inline', () => {
    const hugeMentions = Array.from({ length: 160 }, (_, idx) => ({
      name: `Collaborator_${idx}_${'x'.repeat(30)}`,
      openId: `ou_${String(idx).padStart(32, '0')}`,
    }));
    const result = buildNewTopicCliInput(
      '帮我修个 bug', SESSION_ID, 'claude-code', undefined,
      undefined, hugeMentions, undefined, undefined,
      { name: 'Bot', openId: 'ou_bot' },
      undefined,
      { openId: 'ou_sender', type: 'user' as const, name: 'Sender' },
      openingOpts(),
    );
    expect(result.content).toContain('<user_message>');
    expect(result.content).toContain('<mentions>');
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });

  it('已登记在 activeSessions 的全新 opening（worker: null、无历史/generation）：走 hook 模式并叠加冻结会话字段', () => {
    const owner = 'ou_abcdef0123456789abcdef0123456789';
    const assistantSettings = `/tmp/bots/app_test/users/${owner}/claude/settings.json`;
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', sandbox: 'oncall', assistantMode: true },
    });
    activeRegistryMock.mockReturnValue(new Map([['k', {
      session: { sessionId: SESSION_ID, status: 'active', assistantOwnerOpenId: owner },
      larkAppId: LARK_APP_ID,
      worker: null,
      hasHistory: false,
    }]]));
    preflightMock.mockImplementation((path: unknown) => path === assistantSettings);
    const result = buildNewTopicCliInput(
      '全新话题消息', SESSION_ID, 'claude-code', undefined,
      undefined, undefined, undefined, undefined,
      { name: 'Bot', openId: 'ou_bot' },
      undefined,
      { openId: 'ou_sender', type: 'user' as const, name: 'Sender' },
      openingOpts(),
    );
    expect(result.content).toBe('全新话题消息');
    expect(preflightMock).toHaveBeenCalledWith(assistantSettings);
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toContain('<sender ');
  });

  it('已登记在 activeSessions 的 /fork 子会话（worker: null + pendingForkSession: true）：走 hook 模式且未设 sandbox 折算为 off', () => {
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', sandbox: 'oncall' },
    });
    activeRegistryMock.mockReturnValue(new Map([['k', {
      session: { sessionId: SESSION_ID, status: 'active', pendingForkSession: true, cliSessionId: 'parent-cli-sid' },
      larkAppId: LARK_APP_ID,
      worker: null,
      hasHistory: true,
    }]]));
    const globalSettings = `${DEFAULT_CLAUDE_DATA_DIR}/settings.json`;
    preflightMock.mockImplementation((path: unknown) => path === globalSettings);
    const result = buildNewTopicCliInput(
      '分身任务', SESSION_ID, 'claude-code', undefined,
      undefined, undefined, undefined, undefined,
      { name: 'Bot', openId: 'ou_bot' },
      undefined,
      { openId: 'ou_sender', type: 'user' as const, name: 'Sender' },
      openingOpts(),
    );
    expect(result.content).toBe('分身任务');
    expect(preflightMock).toHaveBeenCalledWith(globalSettings);
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toContain('<sender ');
  });

  it.each([
    ['已有 hasHistory', { worker: null, hasHistory: true, session: { sessionId: SESSION_ID, status: 'active' } }],
    ['已有 workerGeneration', { worker: null, hasHistory: false, workerGeneration: 1, session: { sessionId: SESSION_ID, status: 'active', workerGeneration: 1 } }],
    ['已有 cliSessionId', { worker: null, hasHistory: false, session: { sessionId: SESSION_ID, status: 'active', cliSessionId: 'prior-sid' } }],
    ['已有 initConfig', { worker: null, hasHistory: false, initConfig: { backendType: 'pty', cliId: 'claude-code' }, session: { sessionId: SESSION_ID, status: 'active' } }],
    ['死亡 worker', { worker: { killed: true, connected: false }, hasHistory: false, initConfig: { backendType: 'pty', cliId: 'claude-code' }, session: { sessionId: SESSION_ID, status: 'active' } }],
    ['adopted 会话', { worker: null, hasHistory: false, adoptedFrom: 'tmux-1', session: { sessionId: SESSION_ID, status: 'active', adoptedFrom: 'tmux-1' } }],
  ] as const)('已登记在 activeSessions 的非全新 opening（%s）：fail-closed 回退 inline', (_label, dsEntry) => {
    activeRegistryMock.mockReturnValue(new Map([['k', { larkAppId: LARK_APP_ID, ...dsEntry }]]));
    preflightMock.mockClear();
    const result = buildNewTopicCliInput(
      '不应误走 hook', SESSION_ID, 'claude-code', undefined,
      undefined, undefined, undefined, undefined,
      { name: 'Bot', openId: 'ou_bot' },
      undefined,
      { openId: 'ou_sender', type: 'user' as const, name: 'Sender' },
      openingOpts(),
    );
    expect(result.content).toContain('<user_message>');
    expect(preflightMock).not.toHaveBeenCalled();
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });

  it('未登记但持久化行已有先前 workerGeneration 的 opening：fail-closed 回退 inline', () => {
    getSessionMock.mockReturnValue({ sessionId: SESSION_ID, status: 'active', workerGeneration: 2 });
    preflightMock.mockClear();
    const result = buildNewTopicCliInput(
      '旧持久化行', SESSION_ID, 'claude-code', undefined,
      undefined, undefined, undefined, undefined,
      { name: 'Bot', openId: 'ou_bot' },
      undefined,
      { openId: 'ou_sender', type: 'user' as const, name: 'Sender' },
      openingOpts(),
    );
    expect(result.content).toContain('<user_message>');
    expect(preflightMock).not.toHaveBeenCalled();
  });

  it('plannedOpeningBackendType 严格与 forkWorker 后端优先级和远端配对规则一致', () => {
    expect(plannedOpeningBackendType({ initConfig: { backendType: 'tmux' } as any, session: { backendType: 'pty' } }, 'claude-code', { backendType: 'herdr' })).toBe('tmux');
    expect(plannedOpeningBackendType({ initConfig: undefined, session: { backendType: 'tmux' } }, 'claude-code', { backendType: 'herdr' })).toBe('tmux');
    expect(plannedOpeningBackendType({ initConfig: undefined, session: { backendType: undefined } }, 'claude-code', { backendType: 'herdr' })).toBe('herdr');
    expect(plannedOpeningBackendType({ initConfig: undefined, session: { backendType: undefined } }, 'claude-code', { backendType: undefined })).toBe('pty');
    // claude-code 遇到误配的远端后端 → 折回 daemon 默认本地后端
    expect(plannedOpeningBackendType({ initConfig: undefined, session: { backendType: undefined } }, 'claude-code', { backendType: 'riff' })).toBe('pty');
    // 远端 CLI 强制走其同名远端后端
    expect(plannedOpeningBackendType({ initConfig: undefined, session: { backendType: 'pty' } }, 'riff', { backendType: 'pty' })).toBe('riff');
    // Retired initConfig from a different CLI must not shadow the new CLI's planned backend.
    expect(plannedOpeningBackendType({ initConfig: { cliId: 'codex', backendType: 'tmux' } as any, session: { backendType: undefined } }, 'claude-code', { backendType: 'pty' })).toBe('pty');
  });

  it('首字节为 ! 或 /（含不可见字符或前导空白，或前挂 sharedGroupContext）：fail-closed 保留 <user_message> 防 Bash/斜杠命令直达输入框', () => {
    const zwsp = String.fromCharCode(0x200B);
    const dangerousInputs = [
      '!rm -rf /tmp/x',
      `${zwsp}!id`,
      '!env\nline2',
      '/exit',
      '   /exit',
      '/exit\nexplain',
      '/config',
      '/permissions',
      '/hooks',
      '/clear',
      '/var/log/app.log',
    ];
    for (const [idx, text] of dangerousInputs.entries()) {
      const opening = buildNewTopicCliInput(
        text, SESSION_ID, 'claude-code', undefined,
        undefined, undefined, undefined, undefined,
        { name: 'Bot', openId: 'ou_bot' },
        undefined,
        { openId: 'ou_sender', type: 'user' as const, name: 'Sender' },
        openingOpts({ turnId: `t-open-${idx}`, sharedGroupContext: '<shared_group_context>bg</shared_group_context>' }),
      );
      expect(opening.content, `opening ${text}`).toContain('<user_message>');
      expect(sanitizeClaudeInput(opening.content).trimStart(), `opening ${text}`).not.toMatch(/^[/!]/);
      expect(claimByPrompt(SESSION_ID, `t-open-${idx}`, opening.content)).toBeUndefined();

      const followUp = buildFollowUpCliInput(text, SESSION_ID, followUpOpts({
        turnId: `t-fu-${idx}`,
        sharedGroupContext: '<shared_group_context>bg</shared_group_context>',
      }));
      expect(followUp.content, `followup ${text}`).toContain('<user_message>');
      expect(sanitizeClaudeInput(followUp.content).trimStart(), `followup ${text}`).not.toMatch(/^[/!]/);
      expect(claimByPrompt(SESSION_ID, `t-fu-${idx}`, followUp.content)).toBeUndefined();
    }
  });

  it('process.env.SESSION_DATA_DIR 未设时仍按 config.session.dataDir 查 per-bot BOT_HOME settings', () => {
    delete process.env.SESSION_DATA_DIR;
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', sandbox: 'oncall' },
    });
    preflightMock.mockClear();
    const res = buildNewTopicCliInput(
      '查一下状态', SESSION_ID, 'claude-code', undefined,
      undefined, undefined, undefined, undefined,
      { name: 'Bot', openId: 'ou_bot' },
      undefined,
      { openId: 'ou_sender', type: 'user' as const, name: 'Sender' },
      openingOpts(),
    );
    expect(res.content).toBe('查一下状态');
    expect(preflightMock).toHaveBeenCalledWith('/tmp/bots/app_test/claude/settings.json');
  });

  it('freshCliOpening（pending cliLaunchSnapshot）与 freshColdOpening（worker-null 空启动首轮）可进 hook，已有 lastCliInput 的续轮仍 fail-closed', () => {
    // 1. quota-fallback pending fresh CLI launch
    activeRegistryMock.mockReturnValue(new Map([['k', {
      session: {
        sessionId: SESSION_ID,
        status: 'active',
        workerGeneration: 1,
        cliLaunchSnapshot: { state: 'pending', cliId: 'claude-code' },
      },
      larkAppId: LARK_APP_ID,
      worker: null,
      workerGeneration: 1,
      hasHistory: false,
    }]]));
    const freshCli = buildNewTopicCliInput(
      '切换后继续', SESSION_ID, 'claude-code', undefined,
      undefined, undefined, undefined, undefined,
      { name: 'Bot', openId: 'ou_bot' },
      undefined,
      { openId: 'ou_sender', type: 'user' as const, name: 'Sender' },
      openingOpts({ turnId: 't-fresh-cli' }),
    );
    expect(freshCli.content).toBe('切换后继续');
    expect(freshCli.hookEnvelope).toContain('<sender ');
    expect(claimByPrompt(SESSION_ID, 't-fresh-cli', freshCli.content)).toContain('<sender ');

    // 2. worker-null empty-start cold opening (freshColdOpening: true, no lastCliInput)
    activeRegistryMock.mockReturnValue(new Map([['k', {
      session: { sessionId: SESSION_ID, status: 'active', workerGeneration: 1 },
      larkAppId: LARK_APP_ID,
      worker: null,
      workerGeneration: 1,
      hasHistory: true,
    }]]));
    const emptyCold = buildNewTopicCliInput(
      '空启动首条消息', SESSION_ID, 'claude-code', undefined,
      undefined, undefined, undefined, undefined,
      { name: 'Bot', openId: 'ou_bot' },
      undefined,
      { openId: 'ou_sender', type: 'user' as const, name: 'Sender' },
      openingOpts({ turnId: 't-empty-cold', freshColdOpening: true }),
    );
    expect(emptyCold.content).toBe('空启动首条消息');
    expect(claimByPrompt(SESSION_ID, 't-empty-cold', emptyCold.content)).toContain('<sender ');

    // 3. Same worker-null session once lastCliInput exists -> fail-closed inline
    activeRegistryMock.mockReturnValue(new Map([['k', {
      session: { sessionId: SESSION_ID, status: 'active', workerGeneration: 1, lastCliInput: 'earlier' },
      larkAppId: LARK_APP_ID,
      worker: null,
      workerGeneration: 1,
      hasHistory: true,
    }]]));
    const withPriorInput = buildNewTopicCliInput(
      '已有前置输入', SESSION_ID, 'claude-code', undefined,
      undefined, undefined, undefined, undefined,
      { name: 'Bot', openId: 'ou_bot' },
      undefined,
      { openId: 'ou_sender', type: 'user' as const, name: 'Sender' },
      openingOpts({ turnId: 't-prior-input', freshColdOpening: true }),
    );
    expect(withPriorInput.content).toContain('<user_message>');
  });

  it('prepareHookEnvelopeForReplay：活 worker 走新 turnId sidecar，休眠 fork 回退内联不丢信封', () => {
    const envelope = '<botmux_reminder>本会话通过 botmux 桥接飞书</botmux_reminder>\n\n<sender name="User" />';
    const liveDs = {
      session: { sessionId: SESSION_ID, status: 'active' },
      larkAppId: LARK_APP_ID,
      worker: { killed: false, connected: true },
      initConfig: { sessionId: SESSION_ID, cliId: 'claude-code', backendType: 'pty', sandbox: 'off' },
    } as any;

    const liveReplay = prepareHookEnvelopeForReplay({
      ds: liveDs,
      content: '重发任务',
      turnId: 'retry-live-1',
      hookEnvelope: envelope,
      willUseLiveWorker: true,
    });
    expect(liveReplay.content).toBe('重发任务');
    expect(liveReplay.hookEnvelope).toBe(envelope);
    expect(claimByPrompt(SESSION_ID, 'retry-live-1', liveReplay.content)).toBe(envelope);

    const dormantReplay = prepareHookEnvelopeForReplay({
      ds: { ...liveDs, worker: null },
      content: '重发任务',
      turnId: 'retry-fork-2',
      hookEnvelope: envelope,
      willUseLiveWorker: false,
    });
    expect(dormantReplay.content).toContain('<botmux_reminder>');
    expect(dormantReplay.content).toContain('重发任务');
    expect(dormantReplay.hookEnvelope).toBeUndefined();
    expect(claimByPrompt(SESSION_ID, 'retry-fork-2', dormantReplay.content)).toBeUndefined();
  });

  it('skill catalog 追加到 prompt 尾部后：全量指纹 miss，prefix 兜底仍能 claim', () => {
    // opening 是 CLI generation 的首轮，prepareSessionSkillPrompt 会把 skill catalog
    // 追加到 prompt 尾部（${opts.prompt}\n\n${catalog}），这才是 claude-code 真正
    // typed 进 PTY 的文本。sidecar 按「catalog 追加前」的 ptyText 写指纹，所以 hook
    // fire 时全量指纹 exact match 会 miss，只能靠 prefix 兜底（前 30 归一字符，catalog
    // 在尾 → 前 30 不变 → turnId 定域 0/1 条 → 救回）。本测试锁住这条 fallback 路径。
    // 注意：消息需长于 PREFIX_FALLBACK_LEN（30 字符），否则前 30 字符本身就被追加改变。
    const longMessage = '帮我修个 bug，这个问题出现在用户登录模块，需要排查一下认证流程的 token 刷新逻辑';
    const result = buildNewTopicCliInput(
      longMessage, SESSION_ID, 'claude-code', undefined,
      undefined,
      [{ name: 'Bob', openId: 'ou_bob' }],
      undefined, undefined,
      { name: 'Bot', openId: 'ou_bot' },
      undefined,
      { openId: 'ou_sender', type: 'user' as const, name: 'Sender' },
      openingOpts(),
    );
    expect(result.content).toBe(longMessage);

    // 模拟 prepareSessionSkillPrompt 把 catalog 追加到尾部
    const catalog = '<botmux_skills>\n- skill-a\n- skill-b\n</botmux_skills>';
    const typedText = `${result.content}\n\n${catalog}`;

    // 全量指纹 miss（typed 文本 ≠ sidecar 的 ptyText），且 exact miss 不消费 sidecar
    const exactMiss = claimPromptContext(SESSION_ID, TURN_ID, fingerprintPromptText(typedText));
    expect(exactMiss).toBeUndefined();

    // 但 sidecar 还在，用 prefix 兜底能 claim 回 envelope
    const rescued = claimPromptContext(SESSION_ID, TURN_ID, fingerprintPromptText(typedText), prefixOf(typedText));
    expect(rescued).toBeDefined();
    expect(rescued).toContain('<sender ');
    expect(rescued).toContain('<mentions>');
  });
});

describe('promptHookRunsInCli — the UserPromptSubmit hook runs on every submit of the session\'s CLI', () => {
  let prevDataDir: string | undefined;
  beforeEach(() => {
    prevDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = '/tmp/test-sessions';
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' } as never,
    });
    preflightMock.mockReset();
    preflightMock.mockReturnValue(true);
  });
  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = prevDataDir;
  });
  const target = (overrides: Record<string, unknown> = {}) => ({
    cliId: 'claude-code' as const, sessionBackendType: 'tmux' as const, larkAppId: LARK_APP_ID, ...overrides,
  });

  it('claude-code on this host with the hook in the settings it reads — whether or not hook injection is on', () => {
    expect(promptHookRunsInCli(target())).toBe(true);
    expect(preflightMock).toHaveBeenLastCalledWith(`${DEFAULT_CLAUDE_DATA_DIR}/settings.json`);
    preflightMock.mockReturnValue(false);
    expect(promptHookRunsInCli(target())).toBe(false);
  });

  it('looks where the CLI reads: its config profile, or the per-bot copy under read isolation', () => {
    expect(promptHookRunsInCli(target({ cliConfigDir: '/profiles/work' }))).toBe(true);
    expect(preflightMock).toHaveBeenLastCalledWith('/profiles/work/settings.json');
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', sandbox: true } as never,
    });
    expect(promptHookRunsInCli(target())).toBe(true);
    expect(preflightMock).toHaveBeenLastCalledWith('/tmp/bots/app_test/claude/settings.json');
  });

  it('runs on every backend that hosts the CLI on this host, hc included', () => {
    for (const sessionBackendType of ['pty', 'tmux', 'herdr', 'zellij', 'zmx', 'hc'] as const) {
      expect(promptHookRunsInCli(target({ sessionBackendType }))).toBe(true);
    }
  });

  it('never for a CLI that does not install it, a backend not on this host or not known, or a bot not known', () => {
    for (const cliId of ['seed', 'relay', 'codex', 'cursor'] as const) expect(promptHookRunsInCli(target({ cliId }))).toBe(false);
    expect(promptHookRunsInCli(target({ sessionBackendType: 'riff' }))).toBe(false);
    expect(promptHookRunsInCli(target({ sessionBackendType: undefined }))).toBe(false);
    expect(preflightMock).not.toHaveBeenCalled();
    getBotMock.mockImplementation(() => { throw new Error('unknown bot'); });
    expect(promptHookRunsInCli(target())).toBe(false);
  });
});
