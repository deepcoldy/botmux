/**
 * hook-installer.test.ts
 *
 * 测试 installHook 对 claude-settings 格式的行为：
 *   (a) 写入 PreToolUse AskUserQuestion hook 指向给定 hookCommand
 *   (b) 幂等——二次调用内容不变
 *   (c) 既有无关配置保留（合并而非覆盖）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cleanupTraexAskHooks,
  hasInstalledSessionReadyHook,
  hasInstalledPromptHook,
  installHook,
} from '../src/adapters/hook-installer.js';

// ─── 辅助：在临时目录创建独立的 configPath ─────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'botmux-hook-test-'));
}

// ─── claude-settings 格式 ─────────────────────────────────────────────────────

describe('installHook — claude-settings', () => {
  let tmpDir: string;
  let configPath: string;
  const hookCommand = '/usr/bin/node /path/to/cli.js hook claude-code';

  beforeEach(() => {
    tmpDir = makeTmpDir();
    configPath = join(tmpDir, '.claude', 'settings.json');
  });

  it('(a) 写入 PreToolUse AskUserQuestion hook 指向给定 hookCommand', () => {
    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);

    const settings = JSON.parse(readFileSync(configPath, 'utf-8'));
    const groups: any[] = settings.hooks?.PreToolUse ?? [];
    expect(groups.length).toBeGreaterThanOrEqual(1);

    // 找到含有我们 hookCommand 的 group
    const found = groups.find((g: any) =>
      g.hooks?.some((e: any) => e.command === hookCommand),
    );
    expect(found).toBeDefined();
    expect(found.matcher).toBe('AskUserQuestion');

    // 对应 entry 应有 timeout
    const entry = found.hooks.find((e: any) => e.command === hookCommand);
    expect(entry.type).toBe('command');
    expect(typeof entry.timeout).toBe('number');
    expect(entry.timeout).toBeGreaterThan(0);
  });

  it('(b) 幂等——二次调用后文件内容与第一次完全相同', () => {
    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);
    const contentAfterFirst = readFileSync(configPath, 'utf-8');

    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);
    const contentAfterSecond = readFileSync(configPath, 'utf-8');

    expect(contentAfterSecond).toBe(contentAfterFirst);
  });

  it('(c) 既有无关配置（其他 key 和其他事件）在安装后保留', () => {
    // 预先写入一个含无关 key 和另一事件 hook 的 settings.json
    const existing = {
      theme: 'dark',
      someOtherSetting: 42,
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/usr/bin/some-other-hook' }],
          },
        ],
      },
    };
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);

    const settings = JSON.parse(readFileSync(configPath, 'utf-8'));

    // 无关顶层 key 未被破坏
    expect(settings.theme).toBe('dark');
    expect(settings.someOtherSetting).toBe(42);

    // 其他事件（PreToolUse）的 hook 仍在
    const preToolGroups: any[] = settings.hooks?.PreToolUse ?? [];
    expect(preToolGroups.some((g) => g.hooks?.some((e: any) => e.command === '/usr/bin/some-other-hook'))).toBe(true);

    // PreToolUse 中有我们新写的 hook
    const found = preToolGroups.find((g: any) =>
      g.hooks?.some((e: any) => e.command === hookCommand),
    );
    expect(found).toBeDefined();
    expect(found.matcher).toBe('AskUserQuestion');
  });

  it('(d) sessionStartCommand 时同时写入 SessionStart 就绪 hook，且幂等去重（路径变化也算同一条）', () => {
    const readyCmd = '/usr/bin/node /path/to/cli.js session-ready';
    const hookInstall = {
      configPath,
      format: 'claude-settings' as const,
      sessionStartCommand: readyCmd,
    };
    expect(hasInstalledSessionReadyHook(hookInstall)).toBe(false);
    installHook('claude-code', hookInstall, hookCommand);

    let settings = JSON.parse(readFileSync(configPath, 'utf-8'));
    let ss: any[] = settings.hooks?.SessionStart ?? [];
    expect(ss.some((g) => g.hooks?.some((e: any) => e.command === readyCmd))).toBe(true);
    expect(hasInstalledSessionReadyHook(hookInstall)).toBe(true);

    // 幂等：用 npm-global 风格的不同 cli.js 绝对路径再装，应替换而非叠加（仍只有一条 botmux 就绪 hook）
    const readyCmd2 = '/opt/npm/lib/node_modules/botmux/dist/cli.js session-ready';
    installHook('claude-code', { configPath, format: 'claude-settings', sessionStartCommand: readyCmd2 }, hookCommand);
    settings = JSON.parse(readFileSync(configPath, 'utf-8'));
    ss = settings.hooks?.SessionStart ?? [];
    const botmuxReady = ss.filter((g) => g.hooks?.some((e: any) => e.command.includes('cli.js') && e.command.trimEnd().endsWith('session-ready')));
    expect(botmuxReady.length).toBe(1);
    expect(botmuxReady[0].hooks[0].command).toBe(readyCmd2);
    expect(hasInstalledSessionReadyHook(hookInstall)).toBe(false);
    expect(hasInstalledSessionReadyHook({ ...hookInstall, sessionStartCommand: readyCmd2 })).toBe(true);
  });

  it('ready preflight fails closed for malformed or unrelated SessionStart config', () => {
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: 'malformed-without-hooks' },
          { hooks: [{ type: 'command', command: '/usr/bin/unrelated-ready-hook' }] },
        ],
      },
    }));
    expect(hasInstalledSessionReadyHook({
      configPath,
      format: 'claude-settings',
      sessionStartCommand: '/usr/bin/node /path/to/cli.js session-ready',
    })).toBe(false);
  });

  it('(e) 不传 sessionStartCommand 时不写 SessionStart（保持旧行为）', () => {
    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);
    const settings = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(settings.hooks?.SessionStart).toBeUndefined();
  });

  it('(f) userPromptSubmitCommand 时写入 UserPromptSubmit hook，幂等且结构化识别', () => {
    const promptCmd = '/usr/bin/node /path/to/cli.js user-prompt-hook';
    const hookInstall = {
      configPath,
      format: 'claude-settings' as const,
      userPromptSubmitCommand: promptCmd,
    };
    expect(hasInstalledPromptHook(hookInstall)).toBe(false);
    installHook('claude-code', hookInstall, hookCommand);

    let settings = JSON.parse(readFileSync(configPath, 'utf-8'));
    let ups: any[] = settings.hooks?.UserPromptSubmit ?? [];
    const entry = ups.find((g) => g.hooks?.some((e: any) => e.command === promptCmd));
    expect(entry).toBeDefined();
    // 无 matcher（对所有 prompt 生效），timeout 10s
    expect(entry.matcher).toBeUndefined();
    expect(entry.hooks[0].timeout).toBe(10);
    expect(hasInstalledPromptHook(hookInstall)).toBe(true);

    // 幂等：换 cli.js 绝对路径再装，应替换而非叠加
    const promptCmd2 = '/opt/npm/lib/node_modules/botmux/dist/cli.js user-prompt-hook';
    installHook('claude-code', { configPath, format: 'claude-settings', userPromptSubmitCommand: promptCmd2 }, hookCommand);
    settings = JSON.parse(readFileSync(configPath, 'utf-8'));
    ups = settings.hooks?.UserPromptSubmit ?? [];
    const botmuxUps = ups.filter((g) => g.hooks?.some((e: any) => e.command.includes('cli.js') && e.command.trimEnd().endsWith('user-prompt-hook')));
    expect(botmuxUps.length).toBe(1);
    expect(botmuxUps[0].hooks[0].command).toBe(promptCmd2);
    // 结构化识别：换路径后 preflight 仍为 true（与 hasInstalledSessionReadyHook 的精确字符串匹配不同）
    expect(hasInstalledPromptHook({ configPath, format: 'claude-settings', userPromptSubmitCommand: promptCmd2 })).toBe(true);
  });

  it('(g) UserPromptSubmit preflight 对损坏/无关配置 fail-closed', () => {
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { matcher: 'malformed' },
          { hooks: [{ type: 'command', command: '/usr/bin/other-tool' }] },
        ],
      },
    }));
    expect(hasInstalledPromptHook({
      configPath,
      format: 'claude-settings',
      userPromptSubmitCommand: '/usr/bin/node /path/to/cli.js user-prompt-hook',
    })).toBe(false);
  });

  it('(h) 不传 userPromptSubmitCommand 时不写 UserPromptSubmit（保持旧行为）', () => {
    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);
    const settings = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(settings.hooks?.UserPromptSubmit).toBeUndefined();
  });

  it('(i) UserPromptSubmit 与用户自装 hook 共存（合并而非覆盖）', () => {
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: '/usr/bin/my-own-hook' }] },
        ],
      },
    }));
    installHook('claude-code', {
      configPath,
      format: 'claude-settings',
      userPromptSubmitCommand: '/usr/bin/node /path/to/cli.js user-prompt-hook',
    }, hookCommand);
    const settings = JSON.parse(readFileSync(configPath, 'utf-8'));
    const ups: any[] = settings.hooks?.UserPromptSubmit ?? [];
    expect(ups.some((g) => g.hooks?.some((e: any) => e.command === '/usr/bin/my-own-hook'))).toBe(true);
    expect(ups.some((g) => g.hooks?.some((e: any) => e.command.endsWith('user-prompt-hook')))).toBe(true);
  });

  it('read-isolation inherits only the global Claude env map and refreshes rotated auth', () => {
    const globalPath = join(tmpDir, '.claude-global', 'settings.json');
    mkdirSync(join(tmpDir, '.claude-global'), { recursive: true });
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(globalPath, JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'global-token-v1',
        ANTHROPIC_BASE_URL: 'https://provider.example',
        HTTP_PROXY: 'http://proxy.example',
      },
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: '/usr/bin/global-unrelated-hook' }] },
        ],
      },
      theme: 'global-theme-must-not-be-copied',
    }));
    writeFileSync(configPath, JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'stale-local-token',
        BOT_LOCAL_ONLY: 'preserved',
      },
      theme: 'local-theme',
    }));

    const config = {
      configPath,
      format: 'claude-settings' as const,
      sessionStartCommand: '/usr/bin/node /path/to/cli.js session-ready',
      inheritClaudeEnvFrom: globalPath,
    };
    installHook('claude-code', config, hookCommand);

    let settings = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(settings.env).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'global-token-v1',
      BOT_LOCAL_ONLY: 'preserved',
      ANTHROPIC_BASE_URL: 'https://provider.example',
      HTTP_PROXY: 'http://proxy.example',
    });
    expect(settings.theme).toBe('local-theme');
    expect(JSON.stringify(settings)).not.toContain('global-unrelated-hook');
    expect(statSync(configPath).mode & 0o777).toBe(0o600);

    // Shared provider auth rotates: the next cold-spawn install refreshes it.
    writeFileSync(globalPath, JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'global-token-v2',
        ANTHROPIC_BASE_URL: 'https://provider-2.example',
      },
    }));
    installHook('claude-code', config, hookCommand);
    settings = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe('global-token-v2');
    expect(settings.env.ANTHROPIC_BASE_URL).toBe('https://provider-2.example');
    expect(settings.env.BOT_LOCAL_ONLY).toBe('preserved');

    // Shared deletions are authoritative on the next cold spawn, while keys
    // that only ever existed in the per-bot file remain untouched.
    writeFileSync(globalPath, JSON.stringify({ env: {} }));
    installHook('claude-code', config, hookCommand);
    settings = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(settings.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(settings.env.BOT_LOCAL_ONLY).toBe('preserved');
    expect(statSync(`${configPath}.botmux-inherited-env.json`).mode & 0o777).toBe(0o600);
  });

  it('(c2) 已有同 hookCommand 的 PreToolUse entry 不会重复追加', () => {
    // 第一次安装
    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);
    const afterFirst = JSON.parse(readFileSync(configPath, 'utf-8'));
    const countFirst = (afterFirst.hooks?.PreToolUse ?? []).filter((g: any) =>
      g.hooks?.some((e: any) => e.command === hookCommand),
    ).length;

    // 第二次安装（幂等）
    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);
    const afterSecond = JSON.parse(readFileSync(configPath, 'utf-8'));
    const countSecond = (afterSecond.hooks?.PreToolUse ?? []).filter((g: any) =>
      g.hooks?.some((e: any) => e.command === hookCommand),
    ).length;

    expect(countFirst).toBe(1);
    expect(countSecond).toBe(1); // 不重复
  });

  it('(c3) 不同安装路径的旧 botmux hook 在重装时被去重（避免双卡）', () => {
    // 模拟 dev 源码安装残留的 hook，命令路径与本次 npm-global 安装不同
    const devCommand =
      '"/home/user/.local/share/fnm/.../bin/node" "/workspace/botmux/dist/cli.js" hook claude-code';
    const existing = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'AskUserQuestion',
            hooks: [{ type: 'command', command: devCommand, timeout: 86400 }],
          },
        ],
      },
    };
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

    // 用另一安装路径的 hookCommand 重装
    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);

    const settings = JSON.parse(readFileSync(configPath, 'utf-8'));
    const groups: any[] = settings.hooks?.PreToolUse ?? [];
    // 旧 dev 路径 hook 应被结构化识别并移除，只留下本次安装的一条
    const askGroups = groups.filter((g) => g.matcher === 'AskUserQuestion');
    expect(askGroups.length).toBe(1);
    expect(askGroups[0].hooks.some((e: any) => e.command === devCommand)).toBe(false);
    expect(askGroups[0].hooks.some((e: any) => e.command === hookCommand)).toBe(true);
  });

  it('(d) 迁移旧 PermissionRequest botmux entry 到 PreToolUse', () => {
    const existing = {
      hooks: {
        PermissionRequest: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: hookCommand, timeout: 86400 }],
          },
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/usr/bin/other-permission-hook' }],
          },
        ],
      },
    };
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);

    const settings = JSON.parse(readFileSync(configPath, 'utf-8'));
    const permGroups: any[] = settings.hooks?.PermissionRequest ?? [];
    expect(permGroups.some((g) => g.hooks?.some((e: any) => e.command === hookCommand))).toBe(false);
    expect(permGroups.some((g) => g.hooks?.some((e: any) => e.command === '/usr/bin/other-permission-hook'))).toBe(true);

    const preToolGroups: any[] = settings.hooks?.PreToolUse ?? [];
    expect(preToolGroups.some((g) => g.matcher === 'AskUserQuestion' && g.hooks?.some((e: any) => e.command === hookCommand))).toBe(true);
  });
});

// ─── opencode-plugin 格式 ─────────────────────────────────────────────────────

describe('installHook — opencode-plugin', () => {
  let tmpDir: string;
  let configPath: string;
  // 注意：opencode-plugin 路径下 installHook 会忽略传入的 hookCommand 字符串，
  // 改用 hookCommandParts('opencode') 自行解析 argv（见 P1.2 修复）。这里传个占位即可。
  const hookCommand = '/usr/bin/node /path/to/cli.js hook opencode';

  beforeEach(() => {
    tmpDir = makeTmpDir();
    configPath = join(tmpDir, '.config', 'opencode', 'plugin', 'botmux-ask.js');
  });

  it('插件用 argv 形式 spawn(cmd, args)，不拆 shell 字符串（Codex P1.2 回归）', () => {
    installHook('opencode', { configPath, format: 'opencode-plugin' }, hookCommand);
    const content = readFileSync(configPath, 'utf-8');

    // 监听 question.asked 事件并经 event 钩子拦截（OpenCode 插件无专用 question 钩子）
    expect(content).toContain('question.asked');
    expect(content).toContain('event:');
    // 插件导出必须是「函数」（OpenCode 要求；导出对象会报 "Plugin export is not a function"）
    expect(content).toContain('export const BotmuxAsk = async');
    // 异步 spawn（绝不能用 spawnSync 同步阻塞 OpenCode 单线程事件总线）
    expect(content).toContain('spawn(');
    expect(content).not.toContain('spawnSync(');
    // 答案 POST 回 OpenCode 的 reply 端点解阻塞
    expect(content).toContain('/question/');
    expect(content).toContain('/reply');
    // args 以 JSON 数组嵌入，包含 hook 子命令与 cliId
    expect(content).toContain('"hook"');
    expect(content).toContain('"opencode"');
    expect(content).toContain('cli.js');
    // 绝不能再出现「把带引号命令字符串 .split(" ")」的旧写法
    expect(content).not.toContain('.split(');
    expect(content).not.toContain('parts[0]');
  });

  it('幂等——二次调用后文件内容与第一次完全相同', () => {
    installHook('opencode', { configPath, format: 'opencode-plugin' }, hookCommand);
    const afterFirst = readFileSync(configPath, 'utf-8');

    installHook('opencode', { configPath, format: 'opencode-plugin' }, hookCommand);
    const afterSecond = readFileSync(configPath, 'utf-8');

    expect(afterSecond).toBe(afterFirst);
  });
});

// ─── opencode2-plugin 格式（OpenCode 2.0 新插件 API）─────────────────────────

describe('installHook — opencode2-plugin', () => {
  let tmpDir: string;
  let configPath: string;
  const hookCommand = '/usr/bin/node /path/to/cli.js hook opencode2';

  beforeEach(() => {
    tmpDir = makeTmpDir();
    configPath = join(tmpDir, '.config', 'opencode', 'plugins', 'botmux-ask.js');
  });

  it('V2 插件：default export { id, setup }，事件走 ctx.event.subscribe() 异步迭代流', () => {
    installHook('opencode2', { configPath, format: 'opencode2-plugin' }, hookCommand);
    const content = readFileSync(configPath, 'utf-8');

    // V2 插件契约：default export 必须是对象（V1 的函数导出会被 V2 loader 拒绝）
    expect(content).toContain('export default {');
    expect(content).toContain('id: "botmux.ask"');
    expect(content).toContain('setup: async (ctx) =>');
    expect(content).not.toContain('export const BotmuxAsk = async');
    // 事件流 API（回调式 subscribe 会被静默忽略）
    expect(content).toContain('ctx.event.subscribe()');
    expect(content).toContain('for await (const ev of iterator)');
    expect(content).toContain('question.asked');
    // 异步 spawn（绝不能用 spawnSync 同步阻塞服务端）
    expect(content).toContain('spawn(');
    expect(content).not.toContain('spawnSync(');
    // session-scoped 新 reply 端点（V1 的 /question/{id}/reply 在 V2 是 404）
    expect(content).toContain('/api/session/');
    expect(content).toContain('/question/');
    expect(content).toContain('/reply');
    expect(content).not.toContain('/question/" + id + "/reply');
    // 注册文件发现 + Basic auth + 多 worktree 路由头
    expect(content).toContain('service.json');
    expect(content).toContain('x-opencode-directory');
    expect(content).toContain('"opencode:"');
    // args 以 JSON 数组嵌入，包含 hook 子命令与 cliId
    expect(content).toContain('"hook"');
    expect(content).toContain('"opencode2"');
    expect(content).toContain('cli.js');
    expect(content).not.toContain('.split(');
  });

  it('幂等——二次调用后文件内容与第一次完全相同', () => {
    installHook('opencode2', { configPath, format: 'opencode2-plugin' }, hookCommand);
    const afterFirst = readFileSync(configPath, 'utf-8');

    installHook('opencode2', { configPath, format: 'opencode2-plugin' }, hookCommand);
    const afterSecond = readFileSync(configPath, 'utf-8');

    expect(afterSecond).toBe(afterFirst);
  });
});

// ─── TRAE legacy hook cleanup ────────────────────────────────────────────────

describe('cleanupTraexAskHooks', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    configPath = join(tmpDir, '.trae', 'hooks.json');
  });

  it('removes only legacy botmux TraeX ask hooks and preserves unrelated hooks', () => {
    const existing = {
      version: 1,
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'era-cli ... UserPromptSubmit' }] }],
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'era-cli ... PostToolUse' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'era-cli ... Stop' }] }],
        PreToolUse: [
          {
            matcher: '^(AskUserQuestion|request_user_input)$',
            hooks: [
              { type: 'command', command: '/repo/dist/cli.js hook traex' },
              { type: 'command', command: 'era-cli ... PreToolUse' },
            ],
          },
        ],
        PermissionRequest: [
          { hooks: [{ type: 'command', command: '/opt/botmux/dist/cli.js hook traex' }] },
        ],
      },
    };
    mkdirSync(join(tmpDir, '.trae'), { recursive: true });
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

    cleanupTraexAskHooks([configPath]);

    const settings = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(settings.version).toBe(1);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain('UserPromptSubmit');
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain('PostToolUse');
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('Stop');
    expect(settings.hooks.PreToolUse).toEqual([
      {
        matcher: '^(AskUserQuestion|request_user_input)$',
        hooks: [{ type: 'command', command: 'era-cli ... PreToolUse' }],
      },
    ]);
    expect(settings.hooks.PermissionRequest).toBeUndefined();
  });

  it('ignores malformed hook groups instead of blocking daemon startup', () => {
    const existing = {
      hooks: {
        PreToolUse: 'not-an-array',
        PermissionRequest: [{ hooks: [null, { type: 'command', command: 'not-botmux' }] }],
      },
    };
    mkdirSync(join(tmpDir, '.trae'), { recursive: true });
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

    expect(() => cleanupTraexAskHooks([configPath])).not.toThrow();
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual(existing);
  });
});

/**
 * The generated plugins must not reach a loopback service through the global
 * `fetch`, and — the part a `toContain` check cannot see — the helper they call
 * has to actually EXIST in each generated file.
 *
 * WHY THIS IS EXECUTED, NOT GREPPED: the helper was first interpolated into the
 * V2 template only, while BOTH templates had their call switched over. The V1
 * plugin then died with `ReferenceError: loopbackSafeFetch is not defined` on its
 * fallback path — and every source-contains assertion stayed green, because the
 * call site is present in both. "Changed the call, forgot the definition" is the
 * characteristic generated-template defect, so these tests import the emitted
 * file and run the function.
 *
 * The plugins run inside OpenCode's Bun process, where `fetch` auto-uses
 * `$http_proxy` and `no_proxy` is literal-match only. For the V2 reply path that
 * also means the Basic password from the registration file would be handed to the
 * corporate proxy, not just a failed reply.
 */
describe('generated OpenCode plugins — loopback requests bypass the proxy', () => {
  const CASES = [
    { label: 'V1 (opencode-plugin)', cliId: 'opencode', format: 'opencode-plugin' as const },
    { label: 'V2 (opencode2-plugin)', cliId: 'opencode', format: 'opencode2-plugin' as const },
  ];

  for (const { label, cliId, format } of CASES) {
    it(`${label}: defines loopbackSafeFetch wherever it is called`, () => {
      const dir = makeTmpDir();
      const configPath = join(dir, 'plugin', 'botmux-ask.js');
      installHook(cliId, { configPath, format }, '/usr/bin/node /x/cli.js hook opencode');
      const src = readFileSync(configPath, 'utf-8');
      // A call without a definition is the defect; assert on the PAIR.
      const calls = (src.match(/loopbackSafeFetch\(/g) ?? []).length;
      const defs = (src.match(/(?:async\s+)?function\s+loopbackSafeFetch\b/g) ?? []).length;
      expect(calls).toBeGreaterThan(0);
      expect(defs).toBe(1);
      // And it must be built on node:http — that is the whole point.
      expect(src).toContain("await import(\"node:http\")");
      expect(src).toContain('isLiteralLoopback');
    });

    it(`${label}: the emitted helper RUNS and reaches a loopback server directly`, async () => {
      const dir = makeTmpDir();
      const configPath = join(dir, 'plugin', 'botmux-ask.js');
      installHook(cliId, { configPath, format }, '/usr/bin/node /x/cli.js hook opencode');
      const src = readFileSync(configPath, 'utf-8');

      // Pull just the two helper functions out of the generated file and evaluate
      // them. Importing the whole plugin would start its OpenCode wiring; this
      // still executes the REAL emitted text, which is what the guard is about.
      const from = src.indexOf('function isLiteralLoopback');
      expect(from).toBeGreaterThan(-1);
      const to = src.indexOf('\n}', src.indexOf('function loopbackSafeFetch'));
      expect(to).toBeGreaterThan(from);
      const helperSrc = src.slice(from, to + 2);

      const { createServer } = await import('node:http');
      const servers: import('node:http').Server[] = [];
      try {
        let direct = 0;
        const server = createServer((_q, r) => {
          direct++;
          r.writeHead(200, { 'content-type': 'application/json' });
          r.end('{"ok":true}');
        });
        servers.push(server);
        await new Promise<void>(res => server.listen(0, '127.0.0.1', () => res()));
        const port = (server.address() as { port: number }).port;

        // `new Function` has no dynamic-import callback, so the generated
        // `await import("node:http")` cannot resolve inside it. Hand the module in
        // through a local `import` binding instead of rewriting the emitted text —
        // the body under test stays byte-for-byte what we ship.
        const nodeHttp = await import('node:http');
        // eslint-disable-next-line no-new-func
        const make = new Function('__import', `const _i = __import; ${helperSrc.replace(/await import\("node:http"\)/g, '_i("node:http")')}\nreturn { isLiteralLoopback, loopbackSafeFetch };`);
        const { isLiteralLoopback, loopbackSafeFetch } = make(
          (spec: string) => (spec === 'node:http' ? nodeHttp : (() => { throw new Error(`unexpected import ${spec}`); })()),
        ) as {
          isLiteralLoopback: (u: string) => boolean;
          loopbackSafeFetch: (u: string, i?: unknown) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
        };

        // Classification: loopback vs remote (remote must keep the native fetch).
        expect(isLiteralLoopback(`http://127.0.0.1:${port}/x`)).toBe(true);
        expect(isLiteralLoopback('http://localhost:1/x')).toBe(true);
        expect(isLiteralLoopback('https://api.example.com/x')).toBe(false);

        const res = await loopbackSafeFetch(`http://127.0.0.1:${port}/api/x`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });
        expect(res.ok).toBe(true);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('{"ok":true}');
        expect(direct).toBe(1);
      } finally {
        await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
      }
    });
  }
});
