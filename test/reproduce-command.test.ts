import { describe, it, expect } from 'vitest';
import { buildReproduceCommand, selectReproduceLaunch } from '../src/adapters/backend/reproduce-command.js';

// Dashboard「复现命令」跨后端准确性（codex review issue 1）。
describe('buildReproduceCommand', () => {
  const baseEnv = {
    SESSION_DATA_DIR: '/home/u/.botmux/data/s1',
    BOTMUX_SESSION_ID: 'sess-1',
    BOTMUX_LARK_APP_ID: 'cli_app',
    CLAUDE_CONFIG_DIR: '/home/u/.botmux/claude/cli_app',
    // 不在注入 allowlist 里的键不应出现：
    PATH: '/usr/bin:/bin',
    HOME: '/home/u',
  } as NodeJS.ProcessEnv;

  it('riff backend returns null (no local command — never fabricate one)', () => {
    expect(buildReproduceCommand({
      backendType: 'riff',
      bin: '/opt/claude',
      args: ['--session-id', 's1'],
      cwd: '/repo',
      env: baseEnv,
    })).toBeNull();
  });

  it('empty bin returns null', () => {
    expect(buildReproduceCommand({
      backendType: 'pty',
      bin: '',
      args: [],
      env: baseEnv,
    })).toBeNull();
  });

  it('pty backend: cd + injected botmux env + bin + args, shell-quoted', () => {
    const cmd = buildReproduceCommand({
      backendType: 'pty',
      bin: '/opt/claude',
      args: ['--session-id', 's1', '--model', 'x'],
      cwd: '/repo path',
      env: baseEnv,
    })!;
    expect(cmd).toContain("cd '/repo path' &&");
    // 权威注入 env（BOTMUX keys）必须在，带引号：
    expect(cmd).toContain("SESSION_DATA_DIR='/home/u/.botmux/data/s1'");
    expect(cmd).toContain("BOTMUX_SESSION_ID='sess-1'");
    expect(cmd).toContain("CLAUDE_CONFIG_DIR='/home/u/.botmux/claude/cli_app'");
    // 非 allowlist 的 PATH/HOME 不应作为前缀注入（由用户 rcfile 提供）：
    expect(cmd).not.toContain("PATH='/usr/bin:/bin'");
    expect(cmd).not.toContain("HOME='/home/u'");
    // bin + args：
    expect(cmd).toContain("'/opt/claude' '--session-id' 's1' '--model' 'x'");
  });

  it('tmux backend also emits the authoritative injected env (parity with pty)', () => {
    const cmd = buildReproduceCommand({
      backendType: 'tmux',
      bin: '/opt/codex',
      args: ['resume'],
      cwd: '/repo',
      env: { ...baseEnv, CODEX_HOME: '/home/u/.botmux/codex/cli_app' },
    })!;
    expect(cmd).toContain("CODEX_HOME='/home/u/.botmux/codex/cli_app'");
    expect(cmd).toContain("'/opt/codex' 'resume'");
  });

  it('per-bot injectEnv (provider creds) are included and quoted', () => {
    const cmd = buildReproduceCommand({
      backendType: 'pty',
      bin: '/opt/claude',
      args: [],
      env: baseEnv,
      injectEnv: { ANTHROPIC_API_KEY: 'sk-secret with space' },
    })!;
    expect(cmd).toContain("ANTHROPIC_API_KEY='sk-secret with space'");
  });

  it('single quotes in values are safely escaped for bash paste', () => {
    const cmd = buildReproduceCommand({
      backendType: 'pty',
      bin: '/opt/claude',
      args: ["it's"],
      env: {},
    })!;
    // ' → '\'' 序列
    expect(cmd).toContain("'it'\\''s'");
  });

  it('no cwd → command without leading cd', () => {
    const cmd = buildReproduceCommand({
      backendType: 'pty',
      bin: '/opt/claude',
      args: [],
      env: {},
    })!;
    expect(cmd.startsWith('cd ')).toBe(false);
    expect(cmd).toContain("'/opt/claude'");
  });
});

// selectReproduceLaunch：复现命令的 bin/args 决策——绝不含 sandbox wrapper（codex P1）。
// 输入永远是**基础 CLI** bin/args（sandbox 包装前的快照）；此函数只决定是否套 wrapperCli。
describe('selectReproduceLaunch (never surfaces sandbox wrapper)', () => {
  const base = { baseBin: '/opt/claude', baseArgs: ['--session-id', 's1'] };

  it('Linux bwrap/sandbox on: returns the base CLI, never bwrap', () => {
    const r = selectReproduceLaunch({ ...base, sandboxOn: true });
    expect(r.bin).toBe('/opt/claude');
    expect(r.args).toEqual(['--session-id', 's1']);
    expect(r.bin).not.toContain('bwrap');
  });

  it('macOS Seatbelt (write sandbox, sandboxOn=false but bin was going to be sandbox-exec): base only', () => {
    // reproduce 决策只看 base 快照——不含 sandbox-exec -f，无论平台。
    const r = selectReproduceLaunch({ ...base, sandboxOn: false });
    expect(r.bin).toBe('/opt/claude');
    expect(r.args.join(' ')).not.toContain('sandbox-exec');
    expect(r.args.join(' ')).not.toContain('-f ');
  });

  it('wrapperCli set + sandbox off: returns wrapper form (aiden x claude ...)', () => {
    const r = selectReproduceLaunch({
      ...base,
      wrapperCli: 'aiden x claude',
      sandboxOn: false,
      binResolver: (b) => b,
    });
    expect(r.bin).toBe('aiden');
    // wrapper tokens 前置，基础 CLI args 跟随（aiden wrapper 会 strip 部分 unsafe args，
    // 但 --session-id 应保留）。
    expect(r.args[0]).toBe('x');
    expect(r.args).toContain('--session-id');
  });

  it('wrapperCli set + sandbox ON: wrapper ignored (matches worker: wrapper vs bwrap mutually exclusive), base only', () => {
    const r = selectReproduceLaunch({
      ...base,
      wrapperCli: 'aiden x claude',
      sandboxOn: true,
      binResolver: (b) => b,
    });
    expect(r.bin).toBe('/opt/claude');
    expect(r.args).toEqual(['--session-id', 's1']);
  });

  it('no wrapper, no sandbox: base CLI unchanged', () => {
    const r = selectReproduceLaunch({ ...base, sandboxOn: false });
    expect(r.bin).toBe('/opt/claude');
    expect(r.args).toEqual(['--session-id', 's1']);
  });
});
