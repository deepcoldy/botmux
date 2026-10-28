/**
 * `hook-command.ts` — the hook invocation must work in BOTH forms.
 *
 * WHY: these strings are handed to OTHER processes. `hookCommandFor` and friends
 * land in `~/.claude/settings.json` (and the process-level `--settings`), where
 * Claude Code — plus grok and opencode through the same helpers — read them back
 * and run them through a shell. The compiled single-file binary broke every one
 * of them, two ways over, both MEASURED on a real `bun build --compile` binary:
 *
 *   1. `join(__dirname,'..','cli.js')` yields `/$bunfs/cli.js`, and `/$bunfs/` is
 *      visible ONLY inside the process that owns it — a child sees nothing.
 *   2. The result is embedded in a double-quoted shell word, and `sh` expands the
 *      unescaped `$bunfs` to the empty string, so `"/$bunfs/cli.js"` resolves to
 *      `//cli.js` — not even the literal path.
 *
 * The user-visible symptom is the nastiest kind: running the old compiled form
 * through `sh` prints the botmux HELP BANNER and exits 0 (verified against a real
 * binary), so hooks silently do nothing and nothing anywhere reports an error.
 *
 * HOW THESE TESTS GET TEETH: `isStandaloneBinary()` is called for real, not
 * mocked — it keys off `process.argv[1]` starting with `/$bunfs/` (see
 * src/core/self-spawn.ts), so pointing argv[1] at a `/$bunfs/` path exercises the
 * genuine branch. That matters because the repo's other compiled-mode tests pass
 * a `standalone` flag in as a parameter; here the decision is internal, so a
 * parameter could not reach it.
 *
 * The Node-form cases are equally load-bearing: the fix must not "converge" the
 * two forms, because Node genuinely NEEDS the script path (verified: `node hook
 * claude-code` without it dies with MODULE_NOT_FOUND). Branching is correct here;
 * collapsing it would be the bug.
 */

import { spawnSync } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { shellJoin } from '../src/core/cli-launch-mode.js';
import {
  botmuxInvocation,
  claudeStopFailureHookCommand,
  cursorUsageHookCommand,
  hookCommandParts,
  hookCommandFor,
  nativeSubagentRuntimeHookCommand,
  sessionReadyHookCommand,
  statuslineHookCommand,
  userPromptHookCommand,
} from '../src/adapters/hook-command.js';

const REAL_ARGV1 = process.argv[1];

/** Make `isStandaloneBinary()` report true the way a compiled binary does. */
function asCompiledBinary() {
  process.argv[1] = '/$bunfs/root/cli.js';
}

afterEach(() => { process.argv[1] = REAL_ARGV1; });

describe('hook-command — compiled binary form', () => {
  it('never emits a /$bunfs/ path (it does not exist outside the process)', () => {
    asCompiledBinary();
    const strings = [
      hookCommandFor('claude-code'),
      sessionReadyHookCommand(),
      userPromptHookCommand(),
      claudeStopFailureHookCommand(),
      statuslineHookCommand(),
      cursorUsageHookCommand(),
      nativeSubagentRuntimeHookCommand(),
      ...hookCommandParts('claude-code').args,
      hookCommandParts('claude-code').cmd,
    ];
    for (const s of strings) expect(s).not.toContain('$bunfs');
  });

  it('drops the script path entirely and passes the subcommand to the binary', () => {
    asCompiledBinary();
    // The compiled binary dispatches ordinary subcommands itself — MEASURED:
    // `<binary> hook claude-code`, `<binary> session-ready` and
    // `<binary> user-prompt-hook` all run and exit 0 with no script argument.
    expect(hookCommandParts('claude-code')).toEqual({
      cmd: process.execPath,
      args: ['hook', 'claude-code'],
    });
    expect(hookCommandFor('claude-code')).toBe(`'${process.execPath}' hook claude-code`);
    expect(sessionReadyHookCommand()).toBe(`'${process.execPath}' session-ready`);
    expect(userPromptHookCommand()).toBe(`'${process.execPath}' user-prompt-hook`);
    expect(claudeStopFailureHookCommand()).toBe(`'${process.execPath}' __claude-stop-failure-v1`);
    // statusLine.command 走进程级 --settings，同样由 Claude 经 shell 执行。
    expect(statuslineHookCommand()).toBe(`'${process.execPath}' statusline`);
    expect(cursorUsageHookCommand()).toContain(`'${process.execPath}' __cursor-usage-v1`);
    expect(nativeSubagentRuntimeHookCommand()).toMatch(
      /^".+[/\\]\.botmux[/\\]bin[/\\]botmux-native-subagent-runtime-hook(?:\.cmd)?"$/,
    );
  });

  it('keeps the native runtime hook on the canonical stable wrapper path under a symlinked HOME', () => {
    if (process.platform === 'win32') return;
    asCompiledBinary();
    const root = mkdtempSync(join(tmpdir(), 'botmux-hook-compiled-home-'));
    const realHome = join(root, 'real-home');
    const aliasHome = join(root, 'alias-home');
    mkdirSync(join(realHome, '.botmux', 'bin'), { recursive: true });
    symlinkSync(realHome, aliasHome, 'dir');
    try {
      expect(nativeSubagentRuntimeHookCommand({ HOME: aliasHome }, 'linux'))
        .toBe(`"${join(realpathSync(join(realHome, '.botmux', 'bin')), 'botmux-native-subagent-runtime-hook')}"`);
      expect(nativeSubagentRuntimeHookCommand({ HOME: aliasHome }, 'linux')).not.toContain(aliasHome);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('survives a shell round-trip with the subcommand intact', () => {
    asCompiledBinary();
    // What `sh` actually does to the string is the whole failure mode, so assert
    // on the post-expansion words rather than on the source text. `$bunfs` would
    // vanish here; a real path does not.
    const cmd = sessionReadyHookCommand();
    const expanded = cmd.replace(/\$\w+/g, '');
    expect(expanded).toBe(cmd);
    expect(cmd.endsWith(' session-ready')).toBe(true);
  });
});

describe('hook-command — source and dist path contracts', () => {
  it('passes the TypeScript CLI entry to Bun in a source checkout', () => {
    const root = join(tmpdir(), 'botmux source fixture');
    const moduleUrl = pathToFileURL(join(root, 'src', 'adapters', 'hook-command.ts')).href;
    expect(botmuxInvocation(['zcode-session-hook'], false, moduleUrl, true)).toEqual({
      cmd: process.execPath,
      args: [join(root, 'src', 'cli.ts'), 'zcode-session-hook'],
    });
  });

  it('passes the TypeScript CLI entry through tsx for a Node source checkout', () => {
    const root = join(tmpdir(), 'botmux node source fixture');
    const moduleUrl = pathToFileURL(join(root, 'src', 'adapters', 'hook-command.ts')).href;
    const result = botmuxInvocation(['zcode-session-hook'], false, moduleUrl, false);
    expect(result.cmd).toBe(process.execPath);
    expect(result.args[0]).toBe('--import');
    expect(result.args[1]).toMatch(/[/\\]tsx[/\\]/);
    expect(result.args[2]).toBe(join(root, 'src', 'cli.ts'));
    expect(result.args.slice(3)).toEqual(['zcode-session-hook']);
  });

  it('retains the JavaScript CLI entry in a compiled dist tree', () => {
    const root = join(tmpdir(), 'botmux dist fixture');
    const moduleUrl = pathToFileURL(join(root, 'dist', 'adapters', 'hook-command.js')).href;
    expect(botmuxInvocation(['zcode-session-hook'], false, moduleUrl, false)).toEqual({
      cmd: process.execPath,
      args: [join(root, 'dist', 'cli.js'), 'zcode-session-hook'],
    });
  });
});

describe('hook-command — non-standalone form', () => {
  it('keeps the dist/cli.js script path when invoked from a compiled JavaScript module', () => {
    const moduleUrl = pathToFileURL(join(tmpdir(), 'botmux', 'dist', 'adapters', 'hook-command.js')).href;
    const parts = botmuxInvocation(['hook', 'claude-code'], false, moduleUrl);
    expect(parts.cmd).toBe(process.execPath);
    expect(parts.args).toHaveLength(3);
    expect(parts.args[0]).toMatch(/[/\\]cli\.js$/);
    expect(parts.args.slice(1)).toEqual(['hook', 'claude-code']);
  });

  it('quotes every interpreter argument and leaves subcommand tokens separate', () => {
    const parts = hookCommandParts('claude-code');
    const s = hookCommandFor('claude-code');
    const prefix = shellJoin([parts.cmd, ...parts.args.slice(0, -2)]);
    expect(s).toBe(`${prefix} hook claude-code`);
    // The trailing tokens are bare — callers must not re-split the string, but
    // a shell has to see `hook` and the cliId as separate words.
    expect(s.endsWith(' hook claude-code')).toBe(true);
  });

  it('session-ready, user-prompt-hook, and native runtime hook carry the runtime entry', () => {
    const parts = hookCommandParts('x');
    const prefix = shellJoin([parts.cmd, ...parts.args.slice(0, -2)]);
    expect(sessionReadyHookCommand()).toBe(`${prefix} session-ready`);
    expect(userPromptHookCommand()).toBe(`${prefix} user-prompt-hook`);
    expect(claudeStopFailureHookCommand()).toBe(`${prefix} __claude-stop-failure-v1`);
    expect(statuslineHookCommand()).toBe(`${prefix} statusline`);

    expect(nativeSubagentRuntimeHookCommand()).toMatch(
      /^".+[/\\]\.botmux[/\\]bin[/\\]botmux-native-subagent-runtime-hook(?:\.cmd)?"$/,
    );
    expect(nativeSubagentRuntimeHookCommand()).not.toContain(parts.args[0]);
  });

  it('the Node/dist and standalone forms differ exactly by the script argument', () => {
    const moduleUrl = pathToFileURL(join(tmpdir(), 'botmux', 'dist', 'adapters', 'hook-command.js')).href;
    const nodeForm = botmuxInvocation(['hook', 'claude-code'], false, moduleUrl, false);
    const binForm = botmuxInvocation(['hook', 'claude-code'], true, moduleUrl, true);
    // Node/dist has the cli.js script; standalone dispatches the same
    // subcommand directly to the binary.
    expect(nodeForm.args).toHaveLength(binForm.args.length + 1);
    expect(nodeForm.args.slice(1)).toEqual(binForm.args);
  });
});


describe('Cursor user-hook environment guard', () => {
  it('skips the executable entirely when either managed-session variable is absent', () => {
    if (process.platform === 'win32') return;
    // In this source test the generated cli.js path is intentionally absent.
    // Successful silent execution proves the shell never tries to launch it.
    for (const missing of ['BOTMUX_SESSION_ID', 'SESSION_DATA_DIR']) {
      const result = spawnSync('/bin/sh', ['-c', cursorUsageHookCommand('linux')], {
        env: { ...process.env, BOTMUX_SESSION_ID: 'own', SESSION_DATA_DIR: '/tmp/data', [missing]: '' }, encoding: 'utf8',
      });
      expect(result.status).toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toBe('');
    }
  });
  it('uses cmd guards for Windows rather than POSIX test syntax', () => {
    expect(cursorUsageHookCommand('win32')).toMatch(/^if defined BOTMUX_SESSION_ID if defined SESSION_DATA_DIR /);
  });
});
