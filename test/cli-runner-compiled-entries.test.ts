/**
 * CLI-adapter runners must be launchable in BOTH forms.
 *
 * WHY: `codex-app`, `dsh`, `mira` and `mir` do not exec their CLI directly — each
 * spawns a Node runner as the session process (`resolvedBin` is
 * `process.execPath`, and the runner is argv[0]). Every one of them located that
 * runner by walking up from its own module path:
 *
 *     resolve(here, '..', '..', '<name>-runner.js')      // compiled sibling
 *     resolve(here, '..', '..', '..', 'dist', '…')       // source-tree dist
 *
 * In the compiled binary `here` is `/$bunfs/root`, so both candidates collapse
 * onto the real filesystem root. MEASURED inside a real compiled binary:
 * `/codex-app-runner.js` and `/dist/codex-app-runner.js`, both
 * `existsSync === false` — for all four runners.
 *
 * `runnerPath()` has no fail-closed branch: it returns the non-existent sibling
 * anyway. The binary then re-execs ITSELF with that path as argv[0], normal CLI
 * dispatch does not recognise it, and the process PRINTS THE HELP BANNER AND
 * EXITS 0 — verified against a real binary. So the user asking for a `mira`
 * session got a help dump, and nothing anywhere logged an error.
 *
 * The fix routes argv[0] through `runnerArgv0()`: a hidden `__<name>-runner`
 * token in the compiled form (which `cli.ts` dispatches to a static import), the
 * unchanged script path under Node.
 *
 * TEETH: `isStandaloneBinary()` runs for real — it keys off `process.argv[1]`
 * starting with `/$bunfs/` (src/core/self-spawn.ts), so pointing argv[1] there
 * exercises the genuine branch rather than a mock. Verified end to end against a
 * real compiled binary: all four tokens now reach their runner (each fails with
 * its OWN business error — missing bootstrap env, missing `--dsh-bin`, no Mira
 * cookie DB, mir's OSC marker), while both a runner PATH as argv[0] and a
 * bogus `__not-a-real-runner` token still print help.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNNER_ENTRIES, runnerArgv0, type BotmuxEntry } from '../src/core/self-spawn.js';
import { createCodexAppAdapter } from '../src/adapters/cli/codex-app.js';
import { createDshAdapter } from '../src/adapters/cli/dsh.js';
import { createMiraAdapter } from '../src/adapters/cli/mira.js';
import { createMirAdapter } from '../src/adapters/cli/mir.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REAL_ARGV1 = process.argv[1];

function asCompiledBinary() { process.argv[1] = '/$bunfs/root/cli.js'; }
afterEach(() => { process.argv[1] = REAL_ARGV1; });

/** The four adapters, each with the runner entry it must launch. */
const ADAPTERS: ReadonlyArray<{ id: string; entry: BotmuxEntry; make: () => { buildArgs: (o: never) => string[] } }> = [
  { id: 'codex-app', entry: 'codex-app-runner', make: () => createCodexAppAdapter() as never },
  { id: 'dsh', entry: 'dsh-runner', make: () => createDshAdapter() as never },
  { id: 'mira', entry: 'mira-runner', make: () => createMiraAdapter() as never },
  { id: 'mir', entry: 'mir-runner', make: () => createMirAdapter() as never },
];

const BUILD_ARGS_INPUT = {
  sessionId: 'S1', resume: false, resumeSessionId: null,
  botName: 'B', botOpenId: 'ou_x', locale: 'zh',
} as never;

describe('CLI-adapter runners — compiled binary form', () => {
  it.each(ADAPTERS)('$id passes the hidden token, never a /$bunfs/ path', ({ entry, make }) => {
    asCompiledBinary();
    const args = make().buildArgs(BUILD_ARGS_INPUT);
    expect(args[0]).toBe(`__${entry}`);
    // The whole argv, not just argv[0]: a later element carrying the virtual path
    // would break just as silently.
    for (const a of args) expect(a).not.toContain('$bunfs');
  });

  it('every runner entry is wired end to end: token, dispatch branch, dist filename', () => {
    // Checking one runner and assuming the other three is exactly how three of
    // four would ship broken. RUNNER_ENTRIES is the single source of truth, so
    // iterate it and require each one to appear in cli.ts's dispatch.
    const cliSource = readFileSync(resolve(REPO_ROOT, 'src', 'cli.ts'), 'utf-8');
    expect(RUNNER_ENTRIES.length).toBe(4);
    for (const entry of RUNNER_ENTRIES) {
      asCompiledBinary();
      expect(runnerArgv0(entry, '/ignored')).toBe(`__${entry}`);
      // cli.ts must both recognise the entry and statically import its module —
      // `--compile` cannot bundle a computed specifier, so a dynamic lookup here
      // would embed nothing and the token would still print help.
      expect(cliSource).toContain(`__entrySubcommand === '${entry}'`);
      expect(cliSource).toContain(`await import('./${entry}.js')`);
    }
  });

  it('does not mint tokens for non-runner entries', () => {
    // Guards the reverse error: RUNNER_ENTRIES must not quietly grow to include
    // fleet entries, whose launch path is resolveEntrySpawn, not this one.
    expect([...RUNNER_ENTRIES]).toEqual(['codex-app-runner', 'dsh-runner', 'mira-runner', 'mir-runner']);
  });
});

describe('CLI-adapter runners — Node form unchanged', () => {
  it.each(ADAPTERS)('$id still passes a real runner script path', ({ entry, make }) => {
    const args = make().buildArgs(BUILD_ARGS_INPUT);
    // Verified against a pre-change baseline: byte-identical for all four.
    expect(args[0]).toMatch(new RegExp(`${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.js$`));
    expect(args[0].startsWith('/')).toBe(true);
    expect(args[0]).not.toContain('__');
  });

  it('runnerArgv0 returns the caller-resolved path verbatim under Node', () => {
    // The path is the caller's business (each adapter has its own resolution
    // order, including a test-scoped env override), so this must not rewrite it.
    expect(runnerArgv0('mira-runner', '/somewhere/custom/mira-runner.js'))
      .toBe('/somewhere/custom/mira-runner.js');
  });

  it('the two forms differ only in argv[0]', () => {
    const nodeArgs = createMiraAdapter().buildArgs(BUILD_ARGS_INPUT);
    asCompiledBinary();
    const binArgs = createMiraAdapter().buildArgs(BUILD_ARGS_INPUT);
    expect(binArgs.length).toBe(nodeArgs.length);
    expect(binArgs.slice(1)).toEqual(nodeArgs.slice(1));
    expect(binArgs[0]).not.toBe(nodeArgs[0]);
  });
});
