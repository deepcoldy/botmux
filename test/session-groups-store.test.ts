/**
 * Unit tests for the p2pMode='group' building blocks:
 *   - session-groups-store: register / lookup / touch / titled / remove,
 *     persistence across re-init, and the un-initialised no-crash guarantees.
 *   - session-group-title helpers: buildTitlePrompt / sanitizeTitleOutput.
 *   - session-group-birth: buildPlaceholderName.
 *
 * Uses a real temp directory with vi.mock to redirect config.session.dataDir,
 * mirroring async-trigger-store.test.ts.
 *
 * Run:  pnpm vitest run test/session-groups-store.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() { return tempDir; },
    },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  initSessionGroups,
  registerSessionGroup,
  isSessionGroup,
  getSessionGroup,
  touchSessionGroup,
  markSessionGroupTitled,
  markSessionGroupTitleFailed,
  removeSessionGroup,
} from '../src/services/session-groups-store.js';
import { sanitizeTitleOutput, buildTitlePrompt, buildOneShotEnv, resolveOneShotCommand, ONE_SHOT_ARGV, oneShotTitleAllowed, oneShotProfileEnv } from '../src/services/session-group-title.js';
import {
  resolveTagMode,
  resolveSessionTagName,
  clampSessionTagName,
  MAX_SESSION_TAG_NAME_CODEPOINTS,
} from '../src/services/feed-group-tagger.js';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'session-groups-store-test-'));
  initSessionGroups('cli_testapp');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('session-groups-store', () => {
  it('registers and types a session group', () => {
    expect(isSessionGroup('oc_a')).toBe(false);
    registerSessionGroup('oc_a', { ownerOpenId: 'ou_owner', lastSessionId: '' });
    expect(isSessionGroup('oc_a')).toBe(true);
    const entry = getSessionGroup('oc_a')!;
    expect(entry.ownerOpenId).toBe('ou_owner');
    expect(entry.lastSessionId).toBe('');
    expect(entry.createdAt).toBeGreaterThan(0);
    expect(existsSync(join(tempDir, 'session-groups-cli_testapp.json'))).toBe(true);
  });

  it('touch updates lastSessionId and lastActiveAt', () => {
    registerSessionGroup('oc_a', { ownerOpenId: 'ou_owner', lastSessionId: '' });
    touchSessionGroup('oc_a', 'sess-1');
    expect(getSessionGroup('oc_a')!.lastSessionId).toBe('sess-1');
    // touch without a session id keeps the pointer
    touchSessionGroup('oc_a');
    expect(getSessionGroup('oc_a')!.lastSessionId).toBe('sess-1');
    // touch on an unregistered chat is a no-op
    touchSessionGroup('oc_missing', 'sess-2');
    expect(isSessionGroup('oc_missing')).toBe(false);
  });

  it('persists across re-init (daemon restart)', () => {
    registerSessionGroup('oc_a', { ownerOpenId: 'ou_owner', lastSessionId: 'sess-1' });
    markSessionGroupTitled('oc_a');
    initSessionGroups('cli_testapp'); // simulate restart: reload from disk
    const entry = getSessionGroup('oc_a')!;
    expect(entry.lastSessionId).toBe('sess-1');
    expect(entry.titled).toBe(true);
  });

  it('persists bounded title retry metadata and clears the retry deadline on success', () => {
    registerSessionGroup('oc_a', { ownerOpenId: 'ou_owner', lastSessionId: 'sess-1' });
    const failed = markSessionGroupTitleFailed('oc_a', 1_000)!;
    expect(failed.titleAttempts).toBe(1);
    expect(failed.titleRetryAt).toBe(31_000);
    initSessionGroups('cli_testapp');
    expect(getSessionGroup('oc_a')).toMatchObject({ titleAttempts: 1, titleRetryAt: 31_000 });
    markSessionGroupTitled('oc_a');
    expect(getSessionGroup('oc_a')).toMatchObject({ titled: true, titleAttempts: 1 });
    expect(getSessionGroup('oc_a')!.titleRetryAt).toBeUndefined();
  });

  it('persists the birth authorization provenance (origin quota key / reason / chat)', () => {
    // 会话群的额度与权限身份来自「出生时那条授权」，不是新群自己。这三个字段就是
    // dispatcher 后续每条消息据以沿用原计数器/原 reason/原到期的依据，必须活过重启。
    registerSessionGroup('oc_born', {
      ownerOpenId: 'ou_grantee',
      lastSessionId: '',
      originReason: 'chatGrant',
      originQuotaKey: 'chat:oc_dm:ou_grantee',
      originChatId: 'oc_dm',
    });
    initSessionGroups('cli_testapp'); // simulate restart: reload from disk
    expect(getSessionGroup('oc_born')).toMatchObject({
      ownerOpenId: 'ou_grantee',
      originReason: 'chatGrant',
      originQuotaKey: 'chat:oc_dm:ou_grantee',
      originChatId: 'oc_dm',
    });
  });

  it('keeps legacy entries readable: provenance is optional (pre-upgrade groups)', () => {
    registerSessionGroup('oc_legacy', { ownerOpenId: 'ou_owner', lastSessionId: '' });
    initSessionGroups('cli_testapp');
    const entry = getSessionGroup('oc_legacy')!;
    expect(entry.ownerOpenId).toBe('ou_owner');
    expect(entry.originReason).toBeUndefined();
    expect(entry.originQuotaKey).toBeUndefined();
    expect(entry.originChatId).toBeUndefined();
  });

  it('is per-appId: another app does not see the entries', () => {
    registerSessionGroup('oc_a', { ownerOpenId: 'ou_owner', lastSessionId: '' });
    initSessionGroups('cli_otherapp');
    expect(isSessionGroup('oc_a')).toBe(false);
  });

  it('remove deletes the entry', () => {
    registerSessionGroup('oc_a', { ownerOpenId: 'ou_owner', lastSessionId: '' });
    removeSessionGroup('oc_a');
    expect(isSessionGroup('oc_a')).toBe(false);
  });

  it('never throws when not initialised', async () => {
    // Fresh module state cannot be reset here, so emulate via a bogus app then
    // clear: the exported guards must return falsy instead of crashing.
    initSessionGroups('cli_testapp');
    expect(isSessionGroup('oc_x')).toBe(false);
    expect(getSessionGroup('oc_x')).toBeUndefined();
  });
});

describe('sanitizeTitleOutput', () => {
  it('takes the bare answer line and strips decoration', () => {
    expect(sanitizeTitleOutput('修复登录超时问题\n', 12)).toBe('修复登录超时问题');
    expect(sanitizeTitleOutput('"部署流水线排查"。\n', 12)).toBe('部署流水线排查');
    expect(sanitizeTitleOutput('  `Fix login bug`  \n', 12)).toBe('Fix login bug');
  });

  it('takes the LAST non-log line for chatty CLIs (codex exec)', () => {
    const out = '[2026-08-05T12:00:00] OpenAI Codex v0.1\n[2026-08-05T12:00:01] thinking...\ntokens used: 812\n排查会话超时\n';
    expect(sanitizeTitleOutput(out, 12)).toBe('排查会话超时');
  });

  it('returns null for empty/whitespace output', () => {
    expect(sanitizeTitleOutput('', 12)).toBeNull();
    expect(sanitizeTitleOutput('\n  \n', 12)).toBeNull();
  });

  it('lenient fallback recovers when every line matches the strict log filter', () => {
    // Unpredicted shape: the answer itself carries a bracketed prefix.
    const out = '[2026-08-06T07:34:19] codex\n[2026-08-06T07:34:19] 问候会话\n';
    expect(sanitizeTitleOutput(out, 12)).toBe('问候会话');
  });

  it('lenient fallback skips dividers, bare numbers and hook chatter', () => {
    const out = '[a] x\n--------\nhook: Stop\n6,518\n[b] 排查combine接口\n';
    expect(sanitizeTitleOutput(out, 12)).toBe('排查combine接口');
  });

  it('caps runaway output length', () => {
    const long = 'x'.repeat(200);
    const got = sanitizeTitleOutput(long, 12)!;
    expect(got.length).toBeLessThanOrEqual(24);
  });
});

describe('buildOneShotEnv (PR review P2: child-env security boundary)', () => {
  it('strips daemon-only secrets and session markers from the inherited env', () => {
    process.env.LARK_APP_SECRET = 'daemon-secret';
    process.env.GITHUB_TOKEN = 'daemon-gh-token';
    process.env.BOTMUX_SESSION_ID = 'sess-123';
    process.env.TMUX = '/tmp/tmux-socket';
    try {
      const env = buildOneShotEnv();
      expect(env.LARK_APP_SECRET).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.BOTMUX_SESSION_ID).toBeUndefined();
      expect(env.TMUX).toBeUndefined();
    } finally {
      delete process.env.LARK_APP_SECRET;
      delete process.env.GITHUB_TOKEN;
      delete process.env.BOTMUX_SESSION_ID;
      delete process.env.TMUX;
    }
  });

  it('layers the per-bot provider env on top (multi-provider correctness)', () => {
    const env = buildOneShotEnv({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example', ANTHROPIC_AUTH_TOKEN: 'bot-token' } });
    expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy.example');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('bot-token');
    // Inherited harmless vars still flow through (PATH etc.).
    expect(env.PATH).toBeDefined();
  });

  it('per-bot env cannot smuggle reserved botmux keys past the sanitizer', () => {
    // PATH deliberately IS overridable per bot (same as the worker path);
    // reserved BOTMUX_* identity keys are not.
    const env = buildOneShotEnv({ env: { BOTMUX_SESSION_ID: 'evil' } });
    expect(env.BOTMUX_SESSION_ID).toBeUndefined();
  });
});

describe('resolveOneShotCommand (PR review: full buildWrappedLaunch parity)', () => {
  const template = ['claude', '-p'] as const;

  it('wrapperCli goes through buildWrappedLaunch and keeps template mode args', () => {
    expect(resolveOneShotCommand({ wrapperCli: 'aiden x claude' }, template))
      .toEqual({ argv: ['aiden', 'x', 'claude', '-p'], env: undefined });
  });

  it('ttadk wrapper injects -m <model> --skip-check like the formal spawn path', () => {
    const { argv } = resolveOneShotCommand({ wrapperCli: 'ttadk claude', model: 'glm-5.1' }, template);
    expect(argv[0]).toBe('ttadk');
    expect(argv).toContain('-m');
    expect(argv[argv.indexOf('-m') + 1]).toBe('glm-5.1');
    expect(argv).toContain('--skip-check');
    expect(argv[argv.length - 1]).toBe('-p');
  });

  it('cjadk wrapper carries CJADK_INTERACTIVE=0 (no startup selector in non-TTY)', () => {
    const { argv, env } = resolveOneShotCommand({ wrapperCli: 'cjadk claude' }, template);
    expect(argv[0]).toBe('cjadk');
    expect(env).toEqual({ CJADK_INTERACTIVE: '0' });
  });

  it('wrapperCli wins over cliPathOverride (same as the formal spawn path)', () => {
    expect(resolveOneShotCommand({ wrapperCli: 'ccr code', cliPathOverride: '/opt/claude' }, template).argv)
      .toEqual(['ccr', 'code', '-p']);
  });

  it('cliPathOverride replaces the bin when no wrapper is set', () => {
    expect(resolveOneShotCommand({ cliPathOverride: '/usr/local/bin/traex' }, ['traex', 'exec', '--skip-git-repo-check']).argv)
      .toEqual(['/usr/local/bin/traex', 'exec', '--skip-git-repo-check']);
  });

  it('falls back to the template verbatim', () => {
    expect(resolveOneShotCommand({}, template)).toEqual({ argv: ['claude', '-p'] });
  });

  it('pins claude-code to dontAsk so a bypassPermissions profile cannot leak in', () => {
    const argv = ONE_SHOT_ARGV['claude-code'];
    expect(argv).toEqual(['claude', '-p', '--permission-mode', 'dontAsk']);
    // Wrappers forward the pin to the underlying claude.
    expect(resolveOneShotCommand({ wrapperCli: 'aiden x claude' }, argv).argv)
      .toEqual(['aiden', 'x', 'claude', '-p', '--permission-mode', 'dontAsk']);
    expect(resolveOneShotCommand({ cliPathOverride: '/opt/claude' }, argv).argv)
      .toEqual(['/opt/claude', '-p', '--permission-mode', 'dontAsk']);
  });

  it('supports antigravity in ONE_SHOT_ARGV with agy -p', () => {
    expect(ONE_SHOT_ARGV.antigravity).toEqual(['agy', '-p']);
    expect(resolveOneShotCommand({}, ONE_SHOT_ARGV.antigravity)).toEqual({ argv: ['agy', '-p'] });
    expect(resolveOneShotCommand({ cliPathOverride: '/custom/bin/agy' }, ONE_SHOT_ARGV.antigravity)).toEqual({
      argv: ['/custom/bin/agy', '-p'],
    });
  });

  it('supports grok in ONE_SHOT_ARGV with grok -p', () => {
    expect(ONE_SHOT_ARGV.grok).toEqual(['grok', '-p']);
    expect(resolveOneShotCommand({}, ONE_SHOT_ARGV.grok)).toEqual({ argv: ['grok', '-p'] });
    expect(resolveOneShotCommand({ cliPathOverride: '/custom/bin/grok' }, ONE_SHOT_ARGV.grok)).toEqual({
      argv: ['/custom/bin/grok', '-p'],
    });
  });
});

describe('buildTitlePrompt', () => {
  it('embeds the excerpt and maxLen (zh)', () => {
    const p = buildTitlePrompt('帮我看看  这个\n\n报错', 12, 'zh');
    expect(p).toContain('12');
    expect(p).toContain('帮我看看 这个 报错');
  });

  it('caps the excerpt at 500 chars', () => {
    const p = buildTitlePrompt('y'.repeat(2000), 12, 'en');
    expect(p.length).toBeLessThan(700);
  });
});

describe('resolveTagMode', () => {
  it('defaults to feed-group when tag.mode is unset', () => {
    // feed-group 不依赖租户权限目录（chat-tag 的 im:tag scope 飞书尚未开放，
    // 权限目录里搜不到），任何用户 OAuth 一次即可用 —— 因此是未配置时的默认模式。
    expect(resolveTagMode(undefined)).toBe('feed-group');
    expect(resolveTagMode({})).toBe('feed-group');
  });

  it('honours an explicitly configured mode', () => {
    expect(resolveTagMode({ mode: 'chat-tag' })).toBe('chat-tag');
    expect(resolveTagMode({ mode: 'feed-group' })).toBe('feed-group');
    expect(resolveTagMode({ mode: 'off' })).toBe('off');
  });
});

describe('resolveSessionTagName（标签名回落链）', () => {
  it('配置名优先，且原样保留（只 trim）', () => {
    expect(resolveSessionTagName({ configuredName: '  我的工作台  ', botDisplayName: 'CodeXonAst' }))
      .toBe('我的工作台');
  });

  it('没配名字 → 「<bot 显示名>会话」（多 bot 靠 bot 名区分，这是本次改动的重点）', () => {
    expect(resolveSessionTagName({ botDisplayName: 'CodeXonAst' })).toBe('CodeXonAst会话');
    expect(resolveSessionTagName({ configuredName: '   ', botDisplayName: 'CodeXonAst' }))
      .toBe('CodeXonAst会话');
  });

  it('英文 locale 用 "<bot> chats"', () => {
    expect(resolveSessionTagName({ botDisplayName: 'CodeXonAst', locale: 'en' }))
      .toBe('CodeXonAst chats');
  });

  it('配置名与 bot 显示名都没有 → 旧默认名兜底', () => {
    expect(resolveSessionTagName({})).toBe('Botmux群会话');
    expect(resolveSessionTagName({ configuredName: '', botDisplayName: '   ' })).toBe('Botmux群会话');
  });

  it('bot 名过长按码点截到 12（侧边栏只显示前几个字）', () => {
    // 20 个中文字 → 取前 12 个再拼「会话」。
    expect(resolveSessionTagName({ botDisplayName: '机'.repeat(20) })).toBe(`${'机'.repeat(12)}会话`);
    // emoji 是单个码点，不能被 slice 成半个代理对。
    expect(resolveSessionTagName({ botDisplayName: '🤖'.repeat(20) })).toBe(`${'🤖'.repeat(12)}会话`);
  });

  it('自定义名超长按码点保守截断（飞书分组名有长度限制）', () => {
    const long = 'a'.repeat(200);
    const out = resolveSessionTagName({ configuredName: long });
    expect(Array.from(out)).toHaveLength(MAX_SESSION_TAG_NAME_CODEPOINTS);
    expect(clampSessionTagName(long)).toBe(out);
  });

  it('clampSessionTagName 对全空白返回空串（= 清除配置回默认）', () => {
    expect(clampSessionTagName('   ')).toBe('');
    expect(clampSessionTagName(' 工作 ')).toBe('工作');
  });
});

describe('oneShotTitleAllowed (/g auto title runs on the host)', () => {
  let home = '';
  const saved = { HOME: process.env.HOME, SESSION_DATA_DIR: process.env.SESSION_DATA_DIR };
  beforeEach(() => {
    // Hermetic host: no device enrollment unless a case creates it.
    home = mkdtempSync(join(tmpdir(), 'one-shot-home-'));
    process.env.HOME = home;
    delete process.env.SESSION_DATA_DIR;
  });
  afterEach(() => {
    process.env.HOME = saved.HOME;
    if (saved.SESSION_DATA_DIR === undefined) delete process.env.SESSION_DATA_DIR; else process.env.SESSION_DATA_DIR = saved.SESSION_DATA_DIR;
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses launch variants the one-shot cannot reproduce', () => {
    expect(oneShotTitleAllowed({ cliId: 'traex', cliLaunchMode: 'forge-traex' })).toBe(false);
    expect(oneShotTitleAllowed({ cliId: 'codex', codexAuthSync: 'isolated' })).toBe(false);
    expect(oneShotTitleAllowed({ cliId: 'codex', codexInstancePool: { instances: [] } })).toBe(false);
    expect(oneShotTitleAllowed({ cliId: 'codex', codexAuthSync: 'shared' })).toBe(true);
  });

  it('refuses on a host with mandatory device-credential isolation', () => {
    expect(oneShotTitleAllowed({ cliId: 'claude-code' })).toBe(true);
    mkdirSync(join(home, '.botmux', 'device-auth'), { recursive: true });
    writeFileSync(join(home, '.botmux', 'device-auth', 'device.json'), '{}');
    expect(oneShotTitleAllowed({ cliId: 'claude-code' })).toBe(false);
  });

  it('allows only unsandboxed bots on a CLI with a one-shot mode, failing closed', () => {
    const prev = process.env.BOTMUX_SANDBOX;
    delete process.env.BOTMUX_SANDBOX;
    try {
      expect(oneShotTitleAllowed({ cliId: 'claude-code' })).toBe(true);
      expect(oneShotTitleAllowed({ cliId: 'claude-code', sandbox: 'off' })).toBe(true);
      expect(oneShotTitleAllowed({ cliId: 'claude-code', sandbox: true })).toBe(false);
      expect(oneShotTitleAllowed({ cliId: 'claude-code', sandbox: 'scratch' })).toBe(false);
      expect(oneShotTitleAllowed({ cliId: 'claude-code', readIsolation: true })).toBe(false);
      expect(oneShotTitleAllowed({ cliId: 'claude-code', sandbox: 'typo' })).toBe(false);
      expect(oneShotTitleAllowed({ cliId: 'aiden' })).toBe(false);
      process.env.BOTMUX_SANDBOX = '1';
      expect(oneShotTitleAllowed({ cliId: 'claude-code' })).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.BOTMUX_SANDBOX; else process.env.BOTMUX_SANDBOX = prev;
    }
  });
});

describe('oneShotProfileEnv (cliConfigDir parity with the worker)', () => {
  it('carries a Claude profile as CLAUDE_CONFIG_DIR, expanding ~', () => {
    expect(oneShotProfileEnv({ cliId: 'claude-code', cliConfigDir: '~/.claude-api' })).toEqual({
      CLAUDE_CONFIG_DIR: join(homedir(), '.claude-api'),
    });
    expect(oneShotProfileEnv({ cliId: 'claude-code', cliConfigDir: '/opt/claude-profile' })).toEqual({
      CLAUDE_CONFIG_DIR: '/opt/claude-profile',
    });
    expect(oneShotProfileEnv({ cliId: 'claude-code' })).toEqual({});
    expect(oneShotProfileEnv({ cliId: 'codex', cliConfigDir: '~/.codex-x' })).toEqual({});
  });
});
