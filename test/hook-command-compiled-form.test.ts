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

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hookCommandParts,
  hookCommandFor,
  nativeSubagentRuntimeHookCommand,
  sessionReadyHookCommand,
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
    expect(hookCommandFor('claude-code')).toBe(`"${process.execPath}" hook claude-code`);
    expect(sessionReadyHookCommand()).toBe(`"${process.execPath}" session-ready`);
    expect(userPromptHookCommand()).toBe(`"${process.execPath}" user-prompt-hook`);
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

describe('hook-command — Node form stays byte-identical', () => {
  it('keeps the dist/cli.js script path (Node cannot resolve the subcommand alone)', () => {
    // Guard against "converging" the branches: verified that `node hook
    // claude-code` without the script path fails with MODULE_NOT_FOUND, so this
    // path must keep the argument.
    const parts = hookCommandParts('claude-code');
    expect(parts.cmd).toBe(process.execPath);
    expect(parts.args).toHaveLength(3);
    expect(parts.args[0]).toMatch(/[/\\]cli\.js$/);
    expect(parts.args.slice(1)).toEqual(['hook', 'claude-code']);
  });

  it('quotes the executable and the script, but not the subcommand tokens', () => {
    const s = hookCommandFor('claude-code');
    expect(s).toBe(`"${process.execPath}" "${hookCommandParts('claude-code').args[0]}" hook claude-code`);
    // The trailing tokens are bare — callers must not re-split the string, but a
    // shell has to see `hook` and the cliId as separate words.
    expect(s.endsWith(' hook claude-code')).toBe(true);
  });

  it('session-ready, user-prompt-hook, and native runtime hook carry the script path too', () => {
    const script = hookCommandParts('x').args[0];
    expect(sessionReadyHookCommand()).toBe(`"${process.execPath}" "${script}" session-ready`);
    expect(userPromptHookCommand()).toBe(`"${process.execPath}" "${script}" user-prompt-hook`);
    expect(nativeSubagentRuntimeHookCommand()).toMatch(
      /^".+[/\\]\.botmux[/\\]bin[/\\]botmux-native-subagent-runtime-hook(?:\.cmd)?"$/,
    );
    expect(nativeSubagentRuntimeHookCommand()).not.toContain(script);
  });

  it('the two forms differ exactly by the script argument', () => {
    const nodeForm = hookCommandParts('claude-code');
    asCompiledBinary();
    const binForm = hookCommandParts('claude-code');
    // Same subcommand, one fewer argument — states the contract as a relation so
    // a future edit to either branch alone breaks it.
    expect(nodeForm.args).toHaveLength(binForm.args.length + 1);
    expect(nodeForm.args.slice(1)).toEqual(binForm.args);
  });
});
