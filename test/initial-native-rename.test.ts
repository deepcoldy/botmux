import { describe, expect, it } from 'vitest';
import { shouldDeferInitialPromptForStartup } from '../src/core/startup-commands.js';
import {
  initialNativeRenameStartupCommand,
  initialPiLaunchSessionTitle,
  withInitialNativeRenameStartupCommand,
  type InitialNativeRenameInput,
} from '../src/core/initial-native-rename.js';

function input(overrides: Partial<InitialNativeRenameInput> = {}): InitialNativeRenameInput {
  return {
    cliId: 'claude-code',
    fresh: true,
    adopted: false,
    userDefinedTitle: '本地 dogfood',
    backendType: 'tmux',
    ...overrides,
  };
}

describe('initialNativeRenameStartupCommand', () => {
  it('在 Claude Code、Grok、Cursor 的全新原生会话上追加 /rename', () => {
    expect(initialNativeRenameStartupCommand(input())).toBe('/rename 本地 dogfood');
    expect(initialNativeRenameStartupCommand(input({ cliId: 'grok' }))).toBe('/rename 本地 dogfood');
    expect(initialNativeRenameStartupCommand(input({ cliId: 'cursor' }))).toBe('/rename 本地 dogfood');
  });

  it('Codex 和 Pi 不敲 /rename：Codex 走 thread/name/set，Pi 走 --name', () => {
    expect(initialNativeRenameStartupCommand(input({ cliId: 'codex' }))).toBeUndefined();
    expect(initialNativeRenameStartupCommand(input({ cliId: 'pi' }))).toBeUndefined();
    expect(initialNativeRenameStartupCommand(input({ cliId: 'traex' }))).toBeUndefined();
    expect(initialNativeRenameStartupCommand(input({ cliId: 'seed' }))).toBeUndefined();
  });

  it('冷恢复、接管、wrapper、远端后端、没有用户标题时不追加', () => {
    expect(initialNativeRenameStartupCommand(input({ fresh: false }))).toBeUndefined();
    expect(initialNativeRenameStartupCommand(input({ adopted: true }))).toBeUndefined();
    expect(initialNativeRenameStartupCommand(input({ wrapperCli: 'aiden x claude' }))).toBeUndefined();
    expect(initialNativeRenameStartupCommand(input({ backendType: 'riff' }))).toBeUndefined();
    expect(initialNativeRenameStartupCommand(input({ backendType: 'mojo' }))).toBeUndefined();
    expect(initialNativeRenameStartupCommand(input({ userDefinedTitle: '  ' }))).toBeUndefined();
    expect(initialNativeRenameStartupCommand(input({ userDefinedTitle: undefined }))).toBeUndefined();
  });

  it('把标题折成一行，避免 /rename 被换行拆开', () => {
    expect(initialNativeRenameStartupCommand(input({ userDefinedTitle: '第一行\n第二行' })))
      .toBe('/rename 第一行 第二行');
  });
});

describe('initialPiLaunchSessionTitle', () => {
  it('只把用户标题交给原生 Pi 的 --name', () => {
    expect(initialPiLaunchSessionTitle(input({ cliId: 'pi' }))).toBe('本地 dogfood');
    expect(initialPiLaunchSessionTitle(input({ cliId: 'claude-code' }))).toBeUndefined();
    expect(initialPiLaunchSessionTitle(input({ cliId: 'pi', wrapperCli: 'ttadk pi' }))).toBeUndefined();
    expect(initialPiLaunchSessionTitle(input({ cliId: 'pi', fresh: false }))).toBeUndefined();
    expect(initialPiLaunchSessionTitle(input({ cliId: 'pi', backendType: 'mojo' }))).toBeUndefined();
  });
});

describe('withInitialNativeRenameStartupCommand', () => {
  it('改名行放在已有启动命令之后，没有改名时不把缺省列表变成空数组', () => {
    expect(withInitialNativeRenameStartupCommand(['/effort high'], '/rename 本地 dogfood'))
      .toEqual(['/effort high', '/rename 本地 dogfood']);
    expect(withInitialNativeRenameStartupCommand(undefined, '/rename 本地 dogfood'))
      .toEqual(['/rename 本地 dogfood']);
    expect(withInitialNativeRenameStartupCommand(undefined, undefined)).toBeUndefined();
    expect(withInitialNativeRenameStartupCommand(['/effort high'], undefined)).toEqual(['/effort high']);
  });

  it('Grok / Cursor 加上这条命令后，argv 首轮正文会推迟到 /rename 之后', () => {
    const commands = withInitialNativeRenameStartupCommand(undefined, initialNativeRenameStartupCommand(input({ cliId: 'grok' })));
    expect(shouldDeferInitialPromptForStartup({
      hasStartupCommands: !!commands?.length,
      adoptMode: false,
      passesInitialPromptViaArgs: true,
    })).toBe(true);
  });
});
