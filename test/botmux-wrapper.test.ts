import { describe, expect, it } from 'vitest';
import { prependBotmuxBin, botmuxWrapperFiles } from '../src/core/botmux-wrapper.js';

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

  it('writes only the sh wrapper on POSIX', () => {
    const files = botmuxWrapperFiles('/opt/botmux/dist/cli.js', '/usr/bin/node', 'linux');
    expect(files.map(f => f.name)).toEqual(['botmux']);
    expect(files[0].content).toBe('#!/bin/sh\nexec node "/opt/botmux/dist/cli.js" "$@"\n');
    expect(files[0].mode).toBe(0o755);
  });

  it('adds a quoted botmux.cmd pinning the current node on Windows', () => {
    const files = botmuxWrapperFiles(cli, node, 'win32');
    expect(files.map(f => f.name)).toEqual(['botmux', 'botmux.cmd']);
    const cmd = files.find(f => f.name === 'botmux.cmd')!;
    // Quoted node + cli so spaced paths survive; CRLF + %* forward all args.
    expect(cmd.content).toBe(`@echo off\r\n"${node}" "${cli}" %*\r\n`);
  });
});
