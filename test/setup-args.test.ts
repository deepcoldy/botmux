import { describe, expect, it } from 'bun:test';
import {
  buildBotFromAddFlags,
  editInputFromFlags,
  isScriptedSetupInvocation,
  maskAppSecret,
  parseSetupCommand,
  SETUP_CLI_USAGE,
} from '../src/setup/setup-args.js';
import { applyBotConfigEdits } from '../src/setup/bot-config-editor.js';

describe('isScriptedSetupInvocation', () => {
  it('recognizes scripted subcommands and help aliases', () => {
    for (const first of ['list', 'add', 'configure', 'edit', 'remove', 'help', '--help', '-h']) {
      expect(isScriptedSetupInvocation([first])).toBe(true);
    }
  });

  it('keeps bare invocation and TUI-era flags on the interactive path', () => {
    expect(isScriptedSetupInvocation([])).toBe(false);
    expect(isScriptedSetupInvocation(['--no-open-platform-auto'])).toBe(false);
    expect(isScriptedSetupInvocation(['--open-platform-auto'])).toBe(false);
  });

  it('routes unknown bare words to the scripted parser instead of hanging the TUI', () => {
    expect(isScriptedSetupInvocation(['frobnicate'])).toBe(true);
  });
});

describe('SETUP_CLI_USAGE', () => {
  it('warns Agents that open_id is app-scoped and must not be copied across Bots', () => {
    expect(SETUP_CLI_USAGE).toContain('ou_xxx 仅限已有目标应用自身');
    expect(SETUP_CLI_USAGE).toContain('勿跨 Bot 复制');
  });
});

describe('parseSetupCommand', () => {
  it('parses help', () => {
    expect(parseSetupCommand(['help'])).toEqual({ action: 'help' });
    expect(parseSetupCommand(['--help'])).toEqual({ action: 'help' });
  });

  it('parses list with and without --json', () => {
    expect(parseSetupCommand(['list'])).toEqual({ action: 'list', json: false });
    expect(parseSetupCommand(['list', '--json'])).toEqual({ action: 'list', json: true });
  });

  it('rejects field flags and positionals on list', () => {
    expect(() => parseSetupCommand(['list', '--cli', 'codex'])).toThrow(/list 不接受字段参数/);
    expect(() => parseSetupCommand(['list', 'botmux-0'])).toThrow(/不接受多余参数/);
  });

  it('parses add flags in both --flag value and --flag=value forms', () => {
    const cmd = parseSetupCommand([
      'add',
      '--app-id', 'cli_x',
      '--app-secret=s3cret',
      '--allowed-users', 'alice@example.com',
      '--cli=codex',
      '--working-dir', '~/projects',
      '--json',
    ]);
    expect(cmd).toMatchObject({
      action: 'add',
      json: true,
      createApp: false,
      compatibilityMode: false,
      openPlatformAuto: false,
      flags: {
        appId: 'cli_x',
        appSecret: 's3cret',
        allowedUsers: 'alice@example.com',
        cli: 'codex',
        workingDir: '~/projects',
      },
    });
  });

  it('parses --cli-runtime as an add/edit field without changing legacy flags', () => {
    const runtime = JSON.stringify({
      id: 'vendor-codex',
      displayName: 'VendorCodex',
      executable: 'vendor-codex',
      update: { provider: 'auto' },
    });
    expect(parseSetupCommand(['add', '--cli', 'codex', '--cli-runtime', runtime])).toMatchObject({
      action: 'add',
      flags: { cli: 'codex', cliRuntime: runtime },
    });
    expect(parseSetupCommand(['edit', 'botmux-0', '--cli-runtime=-'])).toMatchObject({
      action: 'edit',
      selector: 'botmux-0',
      flags: { cliRuntime: '-' },
    });
  });

  it('parses --open-platform-auto with last-one-wins against --no-open-platform-auto', () => {
    const on = parseSetupCommand(['add', '--open-platform-auto']);
    expect(on).toMatchObject({ action: 'add', openPlatformAuto: true });
    const off = parseSetupCommand(['add', '--open-platform-auto', '--no-open-platform-auto']);
    expect(off).toMatchObject({ action: 'add', openPlatformAuto: false });
  });

  it('parses one-scan --create-app, defaults automation on, and lets --no-open-platform-auto override it', () => {
    expect(parseSetupCommand([
      'add', '--create-app', '--app-name', 'My Bot', '--allowed-users', 'owner@example.com',
    ])).toMatchObject({
      action: 'add',
      createApp: true,
      compatibilityMode: false,
      openPlatformAuto: true,
      flags: { appName: 'My Bot', allowedUsers: 'owner@example.com' },
    });
    expect(parseSetupCommand(['add', '--create-app', '--no-open-platform-auto'])).toMatchObject({
      action: 'add', createApp: true, openPlatformAuto: false,
    });
  });

  it('requires explicit compatibility mode and keeps custom-name support honest', () => {
    expect(parseSetupCommand(['add', '--create-app', '--compatibility-mode'])).toMatchObject({
      action: 'add', createApp: true, compatibilityMode: true,
    });
    expect(() => parseSetupCommand(['add', '--compatibility-mode'])).toThrow(/必须与 add --create-app/);
    expect(() => parseSetupCommand(['add', '--create-app', '--compatibility-mode', '--app-name', 'Bot'])).toThrow(/不支持 --app-name/);
  });

  it('parses explicit account switching only for the Feishu create-app path', () => {
    expect(parseSetupCommand(['add', '--create-app', '--switch-account'])).toMatchObject({
      action: 'add', createApp: true, switchAccount: true,
    });
    expect(() => parseSetupCommand(['add', '--switch-account'])).toThrow(/必须与 add --create-app/);
    expect(() => parseSetupCommand(['add', '--create-app', '--compatibility-mode', '--switch-account'])).toThrow(/不适用于 SDK 兼容模式/);
    expect(() => parseSetupCommand(['list', '--switch-account'])).toThrow(/add --create-app 或 configure/);
    expect(() => parseSetupCommand(['edit', 'botmux-0', '--switch-account'])).toThrow(/add --create-app 或 configure/);
  });

  it('rejects ambiguous create-app credential combinations and app-name without creation', () => {
    expect(() => parseSetupCommand(['add', '--create-app', '--app-id', 'cli_x'])).toThrow(/不能与 --app-id/);
    expect(() => parseSetupCommand(['add', '--app-name', 'Bot'])).toThrow(/必须与 add --create-app/);
  });

  it('parses configure as a stable retry entry and rejects unrelated flags', () => {
    expect(parseSetupCommand(['configure', 'botmux-1', '--json'])).toEqual({
      action: 'configure',
      selector: 'botmux-1',
      json: true,
      switchAccount: false,
    });
    expect(parseSetupCommand(['configure', 'cli_x', '--switch-account'])).toEqual({
      action: 'configure',
      selector: 'cli_x',
      json: false,
      switchAccount: true,
    });
    expect(() => parseSetupCommand(['configure'])).toThrow(/需要指定机器人/);
    expect(() => parseSetupCommand(['configure', 'a', 'b'])).toThrow(/只接受一个机器人标识/);
    expect(() => parseSetupCommand(['configure', 'botmux-1', '--cli', 'codex'])).toThrow(/不接受字段参数/);
    expect(() => parseSetupCommand(['configure', 'botmux-1', '--open-platform-auto'])).toThrow(/只接受机器人标识、--switch-account 和 --json/);
  });

  it('accepts "-" as a clear value but treats a following --flag as a missing value', () => {
    const cmd = parseSetupCommand(['edit', 'botmux-0', '--default-working-dir', '-']);
    expect(cmd).toMatchObject({ action: 'edit', selector: 'botmux-0', flags: { defaultWorkingDir: '-' } });
    expect(() => parseSetupCommand(['edit', 'botmux-0', '--model', '--json'])).toThrow(/--model 缺少取值/);
    expect(() => parseSetupCommand(['edit', 'botmux-0', '--model'])).toThrow(/--model 缺少取值/);
  });

  it('rejects unknown flags and positionals on add', () => {
    expect(() => parseSetupCommand(['add', '--nope', 'x'])).toThrow(/未知参数 --nope/);
    expect(() => parseSetupCommand(['add', 'stray'])).toThrow(/不接受位置参数/);
  });

  it('requires exactly one selector for edit and remove', () => {
    expect(() => parseSetupCommand(['edit'])).toThrow(/需要指定机器人/);
    expect(() => parseSetupCommand(['edit', 'a', 'b'])).toThrow(/只接受一个机器人标识/);
    expect(parseSetupCommand(['remove', 'botmux-1', '--yes', '--json'])).toEqual({
      action: 'remove', selector: 'botmux-1', yes: true, json: true,
    });
    expect(parseSetupCommand(['remove', 'cli_abc'])).toEqual({
      action: 'remove', selector: 'cli_abc', yes: false, json: false,
    });
  });

  it('rejects unknown subcommands', () => {
    expect(() => parseSetupCommand(['frobnicate'])).toThrow(/未知 setup 子命令/);
  });
});

describe('buildBotFromAddFlags', () => {
  const REQUIRED = {
    appId: 'cli_x',
    appSecret: 's3cret',
    allowedUsers: 'alice@example.com',
  };

  it('builds a minimal bot with TUI-compatible defaults', () => {
    const bot = buildBotFromAddFlags({ ...REQUIRED });
    expect(bot).toEqual({
      larkAppId: 'cli_x',
      larkAppSecret: 's3cret',
      cliId: 'claude-code',
      workingDir: '~',
      allowedUsers: ['alice@example.com'],
    });
  });

  it('lists all missing required flags at once', () => {
    expect(() => buildBotFromAddFlags({})).toThrow(/--app-id --app-secret --allowed-users/);
  });

  it('resolves gateway cli selection keys into cliId + wrapperCli', () => {
    const bot = buildBotFromAddFlags({ ...REQUIRED, cli: 'aiden-x-claude' });
    expect(bot.cliId).toBe('claude-code');
    expect(bot.wrapperCli).toBe('aiden x claude');
  });

  it('builds a Codex-compatible runtime from --cli-runtime JSON', () => {
    const runtime = JSON.stringify({
      id: 'vendor-codex',
      displayName: 'VendorCodex',
      executable: 'vendor-codex',
      update: { provider: 'auto' },
    });
    const bot = buildBotFromAddFlags({ ...REQUIRED, cli: 'codex', cliRuntime: runtime });
    expect(bot.cliRuntime).toMatchObject({
      id: 'vendor-codex',
      displayName: 'VendorCodex',
      executable: 'vendor-codex',
      update: { provider: 'auto' },
    });
    expect(bot.cliPathOverride).toBe('vendor-codex');
  });

  it('rejects malformed --cli-runtime JSON and invalid runtime structure', () => {
    expect(() => buildBotFromAddFlags({ ...REQUIRED, cli: 'codex', cliRuntime: '{bad' }))
      .toThrow(/--cli-runtime 不是合法 JSON/);
    expect(() => buildBotFromAddFlags({ ...REQUIRED, cli: 'codex', cliRuntime: '{"id":"vendor-codex"}' }))
      .toThrow(/cliRuntime|executable/);
  });

  it('keeps path-only setup backwards-compatible but rejects two executable sources', () => {
    const runtime = JSON.stringify({ id: 'vendor-codex', executable: 'vendor-codex', update: { provider: 'none' } });
    expect(buildBotFromAddFlags({ ...REQUIRED, cli: 'codex', cliPath: '/opt/legacy/codex' }))
      .toMatchObject({ cliId: 'codex', cliPathOverride: '/opt/legacy/codex' });
    expect(() => buildBotFromAddFlags({
      ...REQUIRED,
      cli: 'codex',
      cliRuntime: runtime,
      cliPath: '/opt/legacy/codex',
    })).toThrow(/cliRuntime conflicts with cliPathOverride/);
  });

  it('lets an explicit --wrapper-cli override the --cli derived prefix, and "-" clear it', () => {
    const overridden = buildBotFromAddFlags({ ...REQUIRED, cli: 'aiden-x-claude', wrapperCli: 'ccr code' });
    expect(overridden.wrapperCli).toBe('ccr code');
    const cleared = buildBotFromAddFlags({ ...REQUIRED, cli: 'aiden-x-claude', wrapperCli: '-' });
    expect(cleared.wrapperCli).toBeUndefined();
  });

  it('rejects unknown cli selection keys', () => {
    expect(() => buildBotFromAddFlags({ ...REQUIRED, cli: 'not-a-cli' })).toThrow(/未知 CLI 选择项/);
  });

  it('persists brand only for lark and rejects other values', () => {
    expect(buildBotFromAddFlags({ ...REQUIRED, brand: 'lark' }).brand).toBe('lark');
    expect(buildBotFromAddFlags({ ...REQUIRED, brand: 'feishu' }).brand).toBeUndefined();
    expect(() => buildBotFromAddFlags({ ...REQUIRED, brand: 'slack' })).toThrow(/--brand 必须是 feishu 或 lark/);
  });

  it('fixed default dir mode: --default-working-dir alone leaves workingDir unset', () => {
    const bot = buildBotFromAddFlags({ ...REQUIRED, defaultWorkingDir: '/data/proj' });
    expect(bot.defaultWorkingDir).toBe('/data/proj');
    expect(bot.workingDir).toBeUndefined();
  });

  it('allows scan roots and a pinned default dir to coexist when both flags are given', () => {
    const bot = buildBotFromAddFlags({ ...REQUIRED, workingDir: '~/a,~/b', defaultWorkingDir: '/data/proj' });
    expect(bot.workingDir).toBe('~/a,~/b');
    expect(bot.defaultWorkingDir).toBe('/data/proj');
  });

  it('rejects allowed-users entries without a resolvable owner', () => {
    expect(() => buildBotFromAddFlags({ ...REQUIRED, allowedUsers: 'alice' })).toThrow(/完整邮箱/);
  });

  it('stores showInTeam=false and keeps default true unstored', () => {
    expect(buildBotFromAddFlags({ ...REQUIRED, showInTeam: 'false' }).showInTeam).toBe(false);
    expect(buildBotFromAddFlags({ ...REQUIRED, showInTeam: 'true' }).showInTeam).toBeUndefined();
  });
});

describe('editInputFromFlags', () => {
  it('rejects --app-name outside add --create-app', () => {
    expect(() => editInputFromFlags({ appName: 'Bot' })).toThrow(/仅与 add --create-app/);
  });

  it('maps only the provided flags', () => {
    expect(editInputFromFlags({})).toEqual({});
    expect(editInputFromFlags({ model: 'opus', backend: 'tmux' })).toEqual({
      model: 'opus',
      backendType: 'tmux',
    });
  });

  it('clears wrapperCli when switching to a plain cli, keeps it for gateway keys', () => {
    expect(editInputFromFlags({ cli: 'codex' })).toEqual({ cliChoice: 'codex', wrapperCli: null, cliRuntime: null });
    expect(editInputFromFlags({ cli: 'ttadk-x-codex' })).toEqual({
      cliChoice: 'codex',
      wrapperCli: 'ttadk codex',
      cliRuntime: null,
    });
  });

  it('lets an explicit --wrapper-cli outrank the --cli derived value', () => {
    expect(editInputFromFlags({ cli: 'codex', wrapperCli: 'cjadk codex' })).toEqual({
      cliChoice: 'codex',
      wrapperCli: 'cjadk codex',
      cliRuntime: null,
    });
  });

  it('passes tri-state clears through and rejects brand on edit', () => {
    expect(editInputFromFlags({ defaultWorkingDir: '-' })).toEqual({ defaultWorkingDir: '-' });
    expect(() => editInputFromFlags({ brand: 'lark' })).toThrow(/--brand 仅在 add 时可指定/);
  });

  it('maps --cli-runtime JSON and clear into the editor tri-state', () => {
    const runtime = JSON.stringify({
      id: 'vendor-codex',
      executable: 'vendor-codex',
      update: { provider: 'none' },
    });
    expect(editInputFromFlags({ cliRuntime: runtime })).toEqual({
      cliRuntime: {
        id: 'vendor-codex',
        executable: 'vendor-codex',
        update: { provider: 'none' },
      },
    });
    expect(editInputFromFlags({ cliRuntime: '-' })).toEqual({ cliRuntime: null });
  });

  it('clears a stored runtime when an edit switches to a non-Codex CLI', () => {
    const base = {
      larkAppId: 'cli_x',
      larkAppSecret: 's',
      cliId: 'codex',
      cliRuntime: {
        id: 'vendor-codex',
        executable: 'vendor-codex',
        update: { provider: 'none' },
      },
    };
    const updated = applyBotConfigEdits(base, editInputFromFlags({ cli: 'claude-code' }));
    expect(updated.cliId).toBe('claude-code');
    expect(updated.cliRuntime).toBeUndefined();
    expect(updated.cliPathOverride).toBeUndefined();
  });
});

describe('applyBotConfigEdits defaultWorkingDir (via edit flags)', () => {
  it('sets, keeps, and clears defaultWorkingDir tri-state', () => {
    const base = { larkAppId: 'cli_x', larkAppSecret: 's', workingDir: '~/repos' };
    const withDefault = applyBotConfigEdits(base, editInputFromFlags({ defaultWorkingDir: '/data/proj' }));
    expect(withDefault.defaultWorkingDir).toBe('/data/proj');
    const untouched = applyBotConfigEdits(withDefault, editInputFromFlags({ model: 'opus' }));
    expect(untouched.defaultWorkingDir).toBe('/data/proj');
    const cleared = applyBotConfigEdits(withDefault, editInputFromFlags({ defaultWorkingDir: '-' }));
    expect(cleared.defaultWorkingDir).toBeUndefined();
  });
});

describe('maskAppSecret', () => {
  it('masks short secrets fully and long ones down to head/tail', () => {
    expect(maskAppSecret(undefined)).toBe('');
    expect(maskAppSecret('short')).toBe('••••');
    expect(maskAppSecret('abcd1234efgh5678')).toBe('abcd••••5678');
  });
});
