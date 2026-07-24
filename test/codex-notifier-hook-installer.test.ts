import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  botmuxCodexNotifierHookCommand,
  installCodexNotifierHook,
  isCodexNotifierHookInstalled,
} from '../src/features/codex-notifier/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function hooksPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-hooks-'));
  tempDirs.push(dir);
  return join(dir, 'hooks.json');
}

function shimCommand(path: string, home = 'home', suffix = ''): string {
  const shim = join(dirname(path), home, '.botmux', 'bin', 'botmux');
  mkdirSync(dirname(shim), { recursive: true });
  writeFileSync(shim, '#!/bin/sh\n');
  chmodSync(shim, 0o700);
  return `${shim} codex-watch-hook${suffix}`;
}

describe('Codex notifier Hook installer', () => {
  it('installs a stable built-in command with restrictive file permissions', () => {
    const path = hooksPath();
    const command = shimCommand(path);
    const result = installCodexNotifierHook({
      path,
      command,
    });

    expect(result).toEqual({
      path,
      command,
      changed: true,
    });
    expect(isCodexNotifierHookInstalled(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      hooks: {
        Stop: [{
          matcher: '*',
          hooks: [{
            type: 'command',
            command,
            timeout: 10,
          }],
        }],
        UserPromptSubmit: [{
          matcher: '*',
          hooks: [{
            type: 'command',
            command,
            timeout: 10,
          }],
        }],
      },
    });
  });

  it('keeps legacy migration on Stop and removes the unsupported prompt hook', () => {
    const path = hooksPath();
    const command = shimCommand(path);
    writeFileSync(path, `${JSON.stringify({
      hooks: {
        UserPromptSubmit: [{
          matcher: '*',
          hooks: [
            { type: 'command', command },
            { type: 'command', command: '/Applications/Flux.app/prompt-hook' },
          ],
        }],
      },
    })}\n`);

    installCodexNotifierHook({ path, command, mode: 'legacy-stop' });

    const hooks = JSON.parse(readFileSync(path, 'utf8')).hooks;
    expect(hooks.Stop).toEqual([{
      matcher: '*',
      hooks: [{ type: 'command', command, timeout: 10 }],
    }]);
    expect(hooks.UserPromptSubmit).toEqual([{
      matcher: '*',
      hooks: [{ type: 'command', command: '/Applications/Flux.app/prompt-hook' }],
    }]);
    expect(isCodexNotifierHookInstalled(path)).toBe(false);
  });

  it('preserves unrelated Flux hooks and the first already trusted command bytes', () => {
    const path = hooksPath();
    const trustedCommand = shimCommand(path, 'trusted-home', ' --trusted');
    const duplicateCommand = shimCommand(path, 'duplicate-home');
    const newCommand = shimCommand(path, 'new-home');
    writeFileSync(path, `${JSON.stringify({
      version: 1,
      hooks: {
        Stop: [
          {
            matcher: 'first',
            hooks: [
              { type: 'command', command: '/Applications/Flux.app/stop-hook' },
              { type: 'command', command: trustedCommand, timeout: 5 },
              { type: 'prompt', prompt: 'keep me' },
            ],
          },
          {
            matcher: 'duplicate',
            hooks: [{ type: 'command', command: duplicateCommand }],
          },
        ],
        SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'session-start' }] }],
      },
    }, null, 2)}\n`);

    const result = installCodexNotifierHook({
      path,
      command: newCommand,
    });
    const root = JSON.parse(readFileSync(path, 'utf8'));

    expect(result.command).toBe(trustedCommand);
    expect(root.version).toBe(1);
    expect(root.hooks.SessionStart).toHaveLength(1);
    expect(root.hooks.Stop).toEqual([
      {
        matcher: 'first',
        hooks: [
          { type: 'command', command: '/Applications/Flux.app/stop-hook' },
          { type: 'prompt', prompt: 'keep me' },
        ],
      },
      {
        matcher: '*',
        hooks: [{ type: 'command', command: trustedCommand, timeout: 10 }],
      },
    ]);
    expect(root.hooks.Stop.flatMap((entry: any) => entry.hooks)
      .filter((hook: any) => String(hook.command ?? '').includes('codex-watch-hook'))).toHaveLength(1);
    expect(root.hooks.UserPromptSubmit).toEqual([{
      matcher: '*',
      hooks: [{ type: 'command', command: trustedCommand, timeout: 10 }],
    }]);
  });

  it('is byte-stable after the first reconciliation', () => {
    const path = hooksPath();
    const stableCommand = shimCommand(path, 'stable-home');
    installCodexNotifierHook({ path, command: stableCommand });
    const before = readFileSync(path, 'utf8');
    const result = installCodexNotifierHook({
      path,
      command: shimCommand(path, 'replacement-home'),
    });

    expect(result.changed).toBe(false);
    expect(result.command).toBe(stableCommand);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('does not claim or delete an unrelated command with the same subcommand token', () => {
    const path = hooksPath();
    const unrelated = '/legacy/checkout/node cli.js codex-watch-hook --trusted';
    writeFileSync(path, `${JSON.stringify({
      hooks: {
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: unrelated }] }],
      },
    })}\n`);
    const command = shimCommand(path);

    installCodexNotifierHook({ path, command });

    const commands = JSON.parse(readFileSync(path, 'utf8')).hooks.Stop
      .flatMap((entry: any) => entry.hooks)
      .map((hook: any) => hook.command);
    expect(commands).toContain(unrelated);
    expect(commands).toContain(command);
    expect(isCodexNotifierHookInstalled(path)).toBe(true);
  });

  it('replaces an owned Hook whose shim is missing or whose PATH cannot resolve Node', () => {
    const path = hooksPath();
    const missingShim = join(dirname(path), 'missing', '.botmux', 'bin', 'botmux');
    const staleShim = join(dirname(path), 'stale', '.botmux', 'bin', 'botmux');
    mkdirSync(dirname(staleShim), { recursive: true });
    writeFileSync(staleShim, '#!/bin/sh\n');
    chmodSync(staleShim, 0o700);
    const replacement = shimCommand(path, 'replacement-home');
    writeFileSync(path, `${JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: '*',
            hooks: [{
              type: 'command',
              command: `/usr/bin/env PATH=/missing/node/bin ${missingShim} codex-watch-hook`,
            }],
          },
          {
            matcher: '*',
            hooks: [{
              type: 'command',
              command: `/usr/bin/env PATH=/missing/node/bin ${staleShim} codex-watch-hook`,
            }],
          },
        ],
      },
    })}\n`);

    const result = installCodexNotifierHook({ path, command: replacement });

    expect(result.command).toBe(replacement);
    expect(isCodexNotifierHookInstalled(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).hooks.Stop).toEqual([{
      matcher: '*',
      hooks: [{ type: 'command', command: replacement, timeout: 10 }],
    }]);
    expect(JSON.parse(readFileSync(path, 'utf8')).hooks.UserPromptSubmit).toEqual([{
      matcher: '*',
      hooks: [{ type: 'command', command: replacement, timeout: 10 }],
    }]);
  });

  it('does not rewrite malformed JSON', () => {
    const path = hooksPath();
    writeFileSync(path, '{broken');
    const before = readFileSync(path, 'utf8');

    expect(() => installCodexNotifierHook({ path })).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(isCodexNotifierHookInstalled(path)).toBe(false);
  });

  it('builds the default command from the stable BotMux shim and current Node runtime', () => {
    const command = botmuxCodexNotifierHookCommand('/Users/test user', '/runtime/bin/node');
    expect(command).toContain('PATH=/runtime/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
    expect(command).toContain("'/Users/test user/.botmux/bin/botmux'");
    expect(command).toMatch(/ codex-watch-hook$/);
  });

  it('uses the pinned botmux.cmd wrapper on Windows', () => {
    expect(botmuxCodexNotifierHookCommand(
      'C:\\Users\\test user',
      'C:\\Program Files\\nodejs\\node.exe',
      'win32',
    )).toBe('"C:\\Users\\test user\\.botmux\\bin\\botmux.cmd" codex-watch-hook');
  });
});
