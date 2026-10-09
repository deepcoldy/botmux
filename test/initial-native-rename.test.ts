import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { shouldDeferInitialPromptForStartup } from '../src/core/startup-commands.js';
import {
  initialNativeRenameStartupCommand,
  initialPiLaunchSessionTitle,
  spawnHasStartupWork,
  type InitialNativeRenameInput,
} from '../src/core/initial-native-rename.js';

const rename = (title: string) => `/rename ${title}`;

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
    expect(initialNativeRenameStartupCommand(input(), rename)).toBe('/rename 本地 dogfood');
    expect(initialNativeRenameStartupCommand(input({ cliId: 'grok' }), rename)).toBe('/rename 本地 dogfood');
    expect(initialNativeRenameStartupCommand(input({ cliId: 'cursor' }), rename)).toBe('/rename 本地 dogfood');
  });

  it('适配器没声明 buildSessionRenameCommand 时不敲', () => {
    expect(initialNativeRenameStartupCommand(input(), undefined)).toBeUndefined();
    expect(initialNativeRenameStartupCommand(input({ cliId: 'cursor' }), undefined)).toBeUndefined();
  });

  it('Codex 和 Pi 不敲 /rename：Codex 走 thread/name/set，Pi 走 --name', () => {
    expect(initialNativeRenameStartupCommand(input({ cliId: 'codex' }), rename)).toBeUndefined();
    expect(initialNativeRenameStartupCommand(input({ cliId: 'pi' }), rename)).toBeUndefined();
    expect(initialNativeRenameStartupCommand(input({ cliId: 'traex' }), rename)).toBeUndefined();
    expect(initialNativeRenameStartupCommand(input({ cliId: 'seed' }), rename)).toBeUndefined();
  });

  it('冷恢复、接管、wrapper、远端后端、没有用户标题时不追加', () => {
    expect(initialNativeRenameStartupCommand(input({ fresh: false }), rename)).toBeUndefined();
    expect(initialNativeRenameStartupCommand(input({ adopted: true }), rename)).toBeUndefined();
    expect(initialNativeRenameStartupCommand(input({ wrapperCli: 'aiden x claude' }), rename)).toBeUndefined();
    expect(initialNativeRenameStartupCommand(input({ backendType: 'riff' }), rename)).toBeUndefined();
    expect(initialNativeRenameStartupCommand(input({ backendType: 'mojo' }), rename)).toBeUndefined();
    expect(initialNativeRenameStartupCommand(input({ userDefinedTitle: '  ' }), rename)).toBeUndefined();
    expect(initialNativeRenameStartupCommand(input({ userDefinedTitle: undefined }), rename)).toBeUndefined();
  });

  it('把标题折成一行，避免 /rename 被换行拆开', () => {
    expect(initialNativeRenameStartupCommand(input({ userDefinedTitle: '第一行\n第二行' }), rename))
      .toBe('/rename 第一行 第二行');
  });

  it('命令文本走适配器，而不是在这里再写死 /rename', () => {
    expect(initialNativeRenameStartupCommand(input({ cliId: 'cursor' }), title => `/cursor-rename ${title}`))
      .toBe('/cursor-rename 本地 dogfood');
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

describe('spawnHasStartupWork', () => {
  it('改名单独携带，但仍让 argv 首轮正文推迟到 /rename 之后', () => {
    const command = initialNativeRenameStartupCommand(input({ cliId: 'grok' }), rename);
    expect(spawnHasStartupWork(undefined, command)).toBe(true);
    expect(spawnHasStartupWork(['/effort high'], undefined)).toBe(true);
    expect(spawnHasStartupWork(undefined, undefined)).toBe(false);
    expect(shouldDeferInitialPromptForStartup({
      hasStartupCommands: spawnHasStartupWork(undefined, command),
      adoptMode: false,
      passesInitialPromptViaArgs: true,
    })).toBe(true);
  });
});

describe('initial native rename is not replayed on in-worker restart', () => {
  const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
  const poolSource = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');

  it('keeps /rename off startupCommands and consumes it with a flag spawnCli does not re-arm', () => {
    expect(poolSource).toContain('startupCommands: agentCfg.startupCommands');
    expect(poolSource).toContain('initialNativeRename');
    expect(poolSource).not.toContain('withInitialNativeRenameStartupCommand');

    const rearmStart = workerSource.indexOf('hasRunStartupCommands = !shouldRunStartupCommandsOnSpawn');
    const rearmEnd = workerSource.indexOf('bareShellLaunchBlocked = false', rearmStart);
    const rearmRegion = workerSource.slice(rearmStart, rearmEnd);
    expect(rearmRegion).not.toContain('hasRunInitialNativeRename');

    const flushStart = workerSource.indexOf('if (!hasRunStartupCommands)');
    const flushEnd = workerSource.indexOf('Commands deferred behind a previous rename', flushStart);
    const flushRegion = workerSource.slice(flushStart, flushEnd);
    expect(flushRegion.indexOf('await runStartupCommands()'))
      .toBeLessThan(flushRegion.indexOf('await runInitialNativeRename()'));

    const renameStart = workerSource.indexOf('async function runInitialNativeRename()');
    const renameEnd = workerSource.indexOf('const freshnessInputQueue', renameStart);
    const renameRegion = workerSource.slice(renameStart, renameEnd);
    expect(renameRegion).toContain('if (!cmd || hasRunInitialNativeRename) return');
    expect(renameRegion).toContain('if (cliRestartInProgress) return');
    expect(renameRegion).toContain('hasRunInitialNativeRename = true;');
    expect(renameRegion.indexOf('hasRunInitialNativeRename = true'))
      .toBeLessThan(renameRegion.indexOf('sendRawCommandLineWithRecoveryFence'));
  });
});
