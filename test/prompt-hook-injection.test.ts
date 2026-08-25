/**
 * prompt-hook-injection.test.ts
 *
 * buildFollowUpCliInput 的 hook 注入模式（#794）：
 *   - auto + 支持的 CLI + preflight 通过 → reminder/whiteboard 进 sidecar，PTY 文本只留其余块
 *   - off / 不支持的 CLI / preflight 失败 → inline（历史行为）
 * Run: pnpm vitest run test/prompt-hook-injection.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks（与 prompt-builder.test.ts 同一套） ─────────────────────────────

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_file: string, _args: string[], cb?: (...args: any[]) => void) => {
    if (typeof cb === 'function') cb(null, '', '');
    return {} as any;
  }),
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''),
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

vi.mock('node:fs', async () => {
  const memfs = await import('memfs');
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
  config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', envelopeInjection: 'auto' as const },
}));
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...args: unknown[]) => getBotMock(...args),
  getAllBots: vi.fn(() => []),
}));

vi.mock('../src/services/session-store.js', () => ({
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

vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: vi.fn(),
  killStalePids: vi.fn(),
  sweepDeadPidMarkers: vi.fn(),
  getActiveSessionsRegistry: vi.fn(() => undefined),
  getCurrentCliVersion: vi.fn(() => '1.0.0'),
}));

const preflightMock = vi.fn((..._args: unknown[]) => true);
vi.mock('../src/adapters/hook-installer.js', () => ({
  hasInstalledPromptHookCached: (...args: unknown[]) => preflightMock(...args),
}));

// ─── 被测模块 ──────────────────────────────────────────────────────────────

import { buildFollowUpCliInput, buildNewTopicCliInput } from '../src/core/session-manager.js';
import { claimPromptContext, fingerprintPromptText, prefixOf } from '../src/services/prompt-context-store.js';

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

describe('buildFollowUpCliInput — hook 注入模式', () => {
  let prevDataDir: string | undefined;
  beforeEach(() => {
    prevDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = '/tmp/test-sessions';
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', envelopeInjection: 'auto' as const },
    });
    preflightMock.mockReturnValue(true);
  });
  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = prevDataDir;
  });

  it('auto + claude-code + preflight 通过：reminder/whiteboard/sender/mentions 进 sidecar，PTY 文本只剩正文', () => {
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

  it('off：完全 inline（reminder 在 PTY 文本里，无 sidecar）', () => {
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', envelopeInjection: 'off' as const },
    });
    const result = buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts());
    expect(result.content).toContain('<botmux_reminder>');
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });

  it('缺省（未配置 envelopeInjection）：inline', () => {
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    });
    const result = buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts());
    expect(result.content).toContain('<botmux_reminder>');
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
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', envelopeInjection: 'auto' as const, sandbox: true },
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
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', envelopeInjection: 'auto' as const, sandbox: true },
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
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', envelopeInjection: 'auto' as const, sandbox: true, backendType: 'riff' as const },
    });
    preflightMock.mockClear();
    const result = buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts({ sessionBackendType: 'riff' as const }));
    expect(result.content).toContain('<botmux_reminder>');
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });

  it('未知后端类型（白名单外）：强制 inline（hardening）', () => {
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', envelopeInjection: 'auto' as const },
    });
    const result = buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts({ sessionBackendType: 'future-remote' as any }));
    expect(result.content).toContain('<botmux_reminder>');
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });

  it('B3 fail-closed：sessionBackendType 缺失（undefined）时强制 inline，不短路进 hook', () => {
    // review B3：旧实现 `opts.sessionBackendType && !LOCAL_BACKENDS.has(...)` 在
    // undefined 时短路放过，误进 hook 模式。改为 fail-closed 后必须 inline。
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', envelopeInjection: 'auto' as const },
    });
    const result = buildFollowUpCliInput('帮我修个 bug', SESSION_ID, followUpOpts({ sessionBackendType: undefined }));
    expect(result.content).toContain('<botmux_reminder>');
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });
});

describe('buildNewTopicCliInput — hook 注入模式（opening）', () => {
  let prevDataDir: string | undefined;
  beforeEach(() => {
    prevDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = '/tmp/test-sessions';
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', envelopeInjection: 'auto' as const },
    });
    preflightMock.mockReturnValue(true);
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

  it('auto + claude-code + preflight 通过 + turnId：whiteboard/sender/mentions 进 sidecar，PTY 文本只剩正文', () => {
    const result = buildNewTopicCliInput(
      '帮我修个 bug', SESSION_ID, 'claude-code', undefined,
      undefined,
      [{ name: 'Bob', openId: 'ou_bob' }],
      undefined, undefined,
      { name: 'Bot', openId: 'ou_bot' },
      undefined,
      { openId: 'ou_sender', type: 'user' as const, name: 'Sender' },
      openingOpts(),
    );

    // PTY 文本：只剩用户正文，无 user_message 外壳 / sender / mentions / whiteboard
    expect(result.content).toBe('帮我修个 bug');
    expect(result.content).not.toContain('<user_message>');
    expect(result.content).not.toContain('<sender ');
    expect(result.content).not.toContain('<mentions>');
    expect(result.content).not.toContain('<whiteboard');

    // sidecar：含 whiteboard + sender + mentions
    const envelope = claimByPrompt(SESSION_ID, TURN_ID, result.content);
    expect(envelope).toBeDefined();
    expect(envelope).toContain('<whiteboard');
    expect(envelope).toContain('<sender ');
    expect(envelope).toContain('<mentions>');
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

  it('off：完全 inline（无 sidecar）', () => {
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', envelopeInjection: 'off' as const },
    });
    const result = buildNewTopicCliInput(
      '帮我修个 bug', SESSION_ID, 'claude-code', undefined,
      undefined, undefined, undefined, undefined,
      { name: 'Bot', openId: 'ou_bot' },
      undefined,
      { openId: 'ou_sender', type: 'user' as const, name: 'Sender' },
      openingOpts(),
    );
    expect(result.content).toContain('<user_message>');
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
  });

  it('无 whiteboard/sender/mentions（envelope 为空）：回退 inline，保留外壳', () => {
    // envelope 为空时不写 sidecar，回退 inline——外壳保留给会话发现/标题提取用。
    const result = buildNewTopicCliInput(
      '帮我修个 bug', SESSION_ID, 'claude-code', undefined,
      undefined, undefined, undefined, undefined,
      undefined,
      undefined,
      undefined,
      openingOpts({ whiteboardId: undefined }),
    );
    expect(result.content).toContain('<user_message>');
    expect(claimByPrompt(SESSION_ID, TURN_ID, result.content)).toBeUndefined();
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
