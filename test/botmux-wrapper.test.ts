import { describe, expect, it } from 'vitest';
import { prependBotmuxBin, botmuxWrapperFiles, resolveBotmuxWrapperBinDir, resolveStableBotmuxWrapperPath } from '../src/core/botmux-wrapper.js';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('resolveBotmuxWrapperBinDir — single source of truth (core-only isolation)', () => {
  it('core-only → dedicated <SESSION_DATA_DIR>/bin (never shared ~/.botmux/bin)', () => {
    expect(resolveBotmuxWrapperBinDir({ BOTMUX_CORE_ONLY: '1', SESSION_DATA_DIR: '/srv/co/data', HOME: '/home/u' }))
      .toBe('/srv/co/data/bin');
  });
  it('normal fleet → shared ~/.botmux/bin', () => {
    expect(resolveBotmuxWrapperBinDir({ HOME: '/home/u' })).toBe('/home/u/.botmux/bin');
  });
  it('core-only WITHOUT SESSION_DATA_DIR falls back to shared (defensive; entrypoint always sets it)', () => {
    expect(resolveBotmuxWrapperBinDir({ BOTMUX_CORE_ONLY: '1', HOME: '/home/u' })).toBe('/home/u/.botmux/bin');
  });
});

describe('resolveStableBotmuxWrapperPath', () => {
  it('uses the same dedicated wrapper the daemon writes in core-only mode', () => {
    expect(resolveStableBotmuxWrapperPath({
      BOTMUX_CORE_ONLY: '1',
      SESSION_DATA_DIR: '/srv/co/data',
      HOME: '/home/u',
    }, 'linux')).toBe('/srv/co/data/bin/botmux');
  });

  it('does not mistake the MCP gateway override for the daemon-written wrapper', () => {
    expect(resolveStableBotmuxWrapperPath({
      HOME: '/home/u',
      BOTMUX_BIN_PATH: '/opt/custom/gateway',
    }, 'linux')).toBe('/home/u/.botmux/bin/botmux');
  });

  it('uses the Windows wrapper filename', () => {
    expect(resolveStableBotmuxWrapperPath({ HOME: 'C:\\Users\\bot' }, 'win32'))
      .toMatch(/botmux\.cmd$/);
  });

  it('canonicalizes a materialized wrapper directory through a symlinked home', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'botmux-wrapper-home-'));
    const realHome = join(root, 'real');
    const aliasHome = join(root, 'alias');
    mkdirSync(join(realHome, '.botmux', 'bin'), { recursive: true });
    symlinkSync(realHome, aliasHome, 'dir');
    try {
      expect(resolveStableBotmuxWrapperPath({ HOME: aliasHome }, 'linux'))
        .toBe(join(realpathSync(join(realHome, '.botmux', 'bin')), 'botmux'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('prependBotmuxBin', () => {
  it('uses : on POSIX', () => {
    expect(prependBotmuxBin('/home/u/.botmux/bin', '/usr/bin:/bin', ':'))
      .toBe('/home/u/.botmux/bin:/usr/bin:/bin');
  });

  it('uses ; on Windows', () => {
    expect(prependBotmuxBin(
      String.raw`C:\Users\First Last\.botmux\bin`,
      String.raw`C:\Windows\System32;C:\Windows`,
      ';',
    )).toBe(String.raw`C:\Users\First Last\.botmux\bin;C:\Windows\System32;C:\Windows`);
  });

  it('tolerates an empty/undefined current PATH', () => {
    expect(prependBotmuxBin('/bin/dir', undefined, ':')).toBe('/bin/dir:');
    expect(prependBotmuxBin('/bin/dir', '', ':')).toBe('/bin/dir:');
  });
});

describe('botmuxWrapperFiles', () => {
  const cli = String.raw`C:\Users\First Last\AppData\Roaming\npm\node_modules\botmux\dist\cli.js`;
  const node = String.raw`C:\Program Files\nodejs\node.exe`;

  it('writes the main and dedicated native-hook sh wrappers on POSIX', () => {
    const files = botmuxWrapperFiles('/opt/botmux/dist/cli.js', '/usr/bin/node', 'linux');
    expect(files.map(f => f.name)).toEqual(['botmux', 'botmux-native-subagent-runtime-hook']);
    expect(files[0].content).toBe('#!/bin/sh\nexec node "/opt/botmux/dist/cli.js" "$@"\n');
    expect(files[1].content).toBe(
      '#!/bin/sh\nexec node "/opt/botmux/dist/cli.js" native-subagent-runtime-hook "$@"\n',
    );
    expect(files[0].mode).toBe(0o755);
    expect(files[1].mode).toBe(0o755);
  });

  it('adds quoted main + dedicated native-hook cmd wrappers on Windows', () => {
    const files = botmuxWrapperFiles(cli, node, 'win32');
    expect(files.map(f => f.name)).toEqual([
      'botmux',
      'botmux-native-subagent-runtime-hook',
      'botmux.cmd',
      'botmux-native-subagent-runtime-hook.cmd',
    ]);
    const cmd = files.find(f => f.name === 'botmux.cmd')!;
    const nativeHookCmd = files.find(f => f.name === 'botmux-native-subagent-runtime-hook.cmd')!;
    // Quoted node + cli so spaced paths survive; CRLF + %* forward all args.
    expect(cmd.content).toBe(`@echo off\r\n"${node}" "${cli}" %*\r\n`);
    expect(nativeHookCmd.content).toBe(
      `@echo off\r\n"${node}" "${cli}" native-subagent-runtime-hook %*\r\n`,
    );
  });

  it('standalone POSIX keeps the main wrapper generic and the hook wrapper pinned to the subcommand', () => {
    const files = botmuxWrapperFiles('/$bunfs/root/cli.js', '/opt/botmux/bin/botmux', 'linux', true);
    expect(files.map(f => f.name)).toEqual(['botmux', 'botmux-native-subagent-runtime-hook']);
    expect(files[0].content).toBe('#!/bin/sh\nexec "/opt/botmux/bin/botmux" "$@"\n');
    expect(files[1].content).toBe(
      '#!/bin/sh\nexec "/opt/botmux/bin/botmux" native-subagent-runtime-hook "$@"\n',
    );
  });

  it('standalone Windows emits a dedicated native-hook cmd wrapper too', () => {
    const files = botmuxWrapperFiles('/$bunfs/root/cli.js', 'C:\\botmux\\botmux.exe', 'win32', true);
    expect(files.map(f => f.name)).toEqual([
      'botmux',
      'botmux-native-subagent-runtime-hook',
      'botmux.cmd',
      'botmux-native-subagent-runtime-hook.cmd',
    ]);
    expect(files.find(f => f.name === 'botmux-native-subagent-runtime-hook.cmd')!.content).toBe(
      '@echo off\r\n"C:\\botmux\\botmux.exe" native-subagent-runtime-hook %*\r\n',
    );
  });
});
