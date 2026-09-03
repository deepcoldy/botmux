/**
 * `resolveCliSpawn` — spawning OUR OWN ordinary CLI subcommands must work in both
 * runtime forms.
 *
 * WHY THIS NEEDED ITS OWN HELPER (and its own test): the repo already routes the
 * hidden entry tokens (`__worker`, `__daemon`, …) through `resolveEntrySpawn` and
 * the adapter runners through `runnerArgv0`, both form-aware. But a third shape —
 * "re-enter the public CLI as a child" — was still hand-rolled as
 * `spawn(process.execPath, [botmuxCliEntry(), …])`, which is the Node form
 * hardcoded.
 *
 * The compiled binary turns that into `<binary> /dist/cli.js start-bot <appId>
 * --json` (`botmuxCliEntry()` resolves to `/dist/cli.js` because `packageRoot()`
 * walks from `/$bunfs/` up to `/`). MEASURED on the real published v3.18.8
 * binary: that argv PRINTS THE HELP BANNER AND EXITS 0, while the correct shape
 * `<binary> start-bot <appId> --json` exits 1 with a real JSON result. The caller
 * in `dashboard/managed-spawn.ts` treats `code === 0` as success, so the failure
 * mode is a dashboard that reports "bot 已上线" having done nothing whatsoever.
 *
 * TEETH: `isStandaloneBinary()` runs for real (it keys off `process.argv[1]`
 * starting with `/$bunfs/`), so these exercise the genuine branch rather than a
 * `standalone` parameter threaded in by the test.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { resolveCliSpawn } from '../src/core/self-spawn.js';

const REAL_ARGV1 = process.argv[1];

/** Make `isStandaloneBinary()` report true the way a compiled binary does. */
function asCompiledBinary() {
  process.argv[1] = '/$bunfs/root/cli.js';
}

afterEach(() => { process.argv[1] = REAL_ARGV1; });

describe('resolveCliSpawn', () => {
  it('Node form keeps the script path — it genuinely needs it', () => {
    const { command, args } = resolveCliSpawn('/opt/botmux/dist/cli.js', ['start-bot', 'cli_x', '--json']);
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['/opt/botmux/dist/cli.js', 'start-bot', 'cli_x', '--json']);
  });

  it('THE BUG: compiled form must put the subcommand FIRST, not a cli.js path', () => {
    // MUTATION CHECK: dropping the standalone branch (always prefixing
    // scriptPath) makes both assertions below red.
    asCompiledBinary();
    const { command, args } = resolveCliSpawn('/dist/cli.js', ['start-bot', 'cli_x', '--json']);
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['start-bot', 'cli_x', '--json']);
    // The specific poison: a path where argv[1] should be. On the real binary this
    // is what produced "help banner + exit 0".
    expect(args[0]).not.toContain('cli.js');
  });

  it('never leaks a /$bunfs/ path to the child (it does not exist outside us)', () => {
    asCompiledBinary();
    const { command, args } = resolveCliSpawn('/$bunfs/root/cli.js', ['stop-bot', 'cli_x']);
    for (const s of [command, ...args]) expect(s).not.toContain('$bunfs');
  });

  it('passes the subcommand through verbatim, including flags and empty lists', () => {
    expect(resolveCliSpawn('/x/cli.js', []).args).toEqual(['/x/cli.js']);
    asCompiledBinary();
    expect(resolveCliSpawn('/x/cli.js', []).args).toEqual([]);
  });
});
