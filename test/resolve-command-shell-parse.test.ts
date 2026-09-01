import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  macOSBundledCodexCandidates,
  resolveCommand,
} from '../src/adapters/cli/registry.js';
import { shellPathProbes } from '../src/desktop/shared/shell-path-probes.js';

describe('shellPathProbes ladder', () => {
  it('defaults to zsh, interactive flavor first', () => {
    expect(shellPathProbes({})).toEqual([
      { shell: '/bin/zsh', flags: '-ic' },
      { shell: '/bin/zsh', flags: '-lc' },
    ]);
  });

  it('probes the bash login shell before the zsh fallback for bash users', () => {
    expect(shellPathProbes({ SHELL: '/bin/bash' })).toEqual([
      { shell: '/bin/bash', flags: '-ic' },
      { shell: '/bin/bash', flags: '-lc' },
      { shell: '/bin/zsh', flags: '-ic' },
      { shell: '/bin/zsh', flags: '-lc' },
    ]);
  });

  it('dedupes when $SHELL already is /bin/zsh', () => {
    expect(shellPathProbes({ SHELL: '/bin/zsh' })).toEqual([
      { shell: '/bin/zsh', flags: '-ic' },
      { shell: '/bin/zsh', flags: '-lc' },
    ]);
  });

  it('probes the fish login shell before the zsh fallback for fish users', () => {
    expect(shellPathProbes({ SHELL: '/usr/local/bin/fish' })).toEqual([
      { shell: '/usr/local/bin/fish', flags: '-ic' },
      { shell: '/usr/local/bin/fish', flags: '-lc' },
      { shell: '/bin/zsh', flags: '-ic' },
      { shell: '/bin/zsh', flags: '-lc' },
    ]);
  });
});

describe('resolveCommand shell output parsing', () => {
  let dir: string;
  let savedShell: string | undefined;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-shell-parse-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    if (savedShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = savedShell;
  });

  function useFakeShell(script: string): void {
    savedShell = process.env.SHELL;
    const shellPath = join(dir, `fake-shell-${Math.random().toString(36).slice(2)}`);
    writeFileSync(shellPath, script);
    chmodSync(shellPath, 0o755);
    process.env.SHELL = shellPath;
  }

  function useSystemShell(): void {
    savedShell = process.env.SHELL;
    process.env.SHELL = '/bin/sh';
  }

  it('takes the last absolute line so rc-file banners cannot break resolution', () => {
    // Simulates an rc file that echoes a banner before `which` prints its path.
    useFakeShell('#!/bin/sh\necho "Welcome to devbox!"\necho "/opt/fake/bin/mytool"\nexit 0\n');
    expect(resolveCommand('mytool')).toBe('/opt/fake/bin/mytool');
  });

  it('rejects output from probes that did not exit cleanly', () => {
    // A failed `which` must not let an echoed path masquerade as the result.
    useFakeShell('#!/bin/sh\necho "/opt/fake/bin/botmux-test-no-such-tool"\nexit 3\n');
    expect(resolveCommand('botmux-test-no-such-tool')).toBe('botmux-test-no-such-tool');
  });

  it('passes a command containing spaces as one literal positional argument', () => {
    useFakeShell([
      '#!/bin/sh',
      '[ "$4" = "tool with space" ] || exit 4',
      'echo "/opt/fake/bin/tool with space"',
      'exit 0',
      '',
    ].join('\n'));
    expect(resolveCommand('tool with space')).toBe('/opt/fake/bin/tool with space');
  });

  it('does not evaluate semicolons from the command name', () => {
    useSystemShell();
    const marker = join(dir, 'semicolon-was-evaluated');
    const command = `botmux-test-missing; touch ${marker}`;
    expect(resolveCommand(command)).toBe(command);
    expect(existsSync(marker)).toBe(false);
  });

  it('does not evaluate command substitutions from the command name', () => {
    useSystemShell();
    const marker = join(dir, 'substitution-was-evaluated');
    const command = `botmux-test-missing$(touch ${marker})`;
    expect(resolveCommand(command)).toBe(command);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('macOS bundled Codex CLI discovery', () => {
  it('prefers the current ChatGPT app and retains legacy Codex.app paths', () => {
    expect(macOSBundledCodexCandidates('/Users/example')).toEqual([
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      '/Users/example/Applications/ChatGPT.app/Contents/Resources/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
      '/Users/example/Applications/Codex.app/Contents/Resources/codex',
    ]);
  });
});
