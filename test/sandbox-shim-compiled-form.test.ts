/**
 * The in-sandbox `botmux` shim and the relay's host re-exec must work in BOTH
 * runtime forms.
 *
 * WHY THIS FILE EXISTS: 91 test files mention the sandbox and NOT ONE asserted
 * on the shim's contents or on how the relay re-execs the CLI. That is exactly
 * why the compiled binary shipped a broken shim — the unit suite runs
 * `node dist/*.js`, where `dist/cli.js` is right there on disk, so the failure
 * only exists in a form nothing in the repo executed.
 *
 * THE SHIM IS THE HARDEST SHAPE IN THE REPO to get right, because the value
 * crosses two boundaries after it is written:
 *
 *     daemon writes it → host disk → --ro-bind into /run/sbxbin → a DIFFERENT
 *     process inside the sandbox execs it
 *
 * so `/$bunfs/` (process-private) is invisible at both later hops. MEASURED on a
 * real compiled binary, the old line produced:
 *
 *     #!/bin/sh
 *     exec node "/dist/cli.js" "$@"
 *              ↑ does not exist   ↑ and re-introduces a hard node dependency
 *
 * and executing the `/$bunfs/`-flavoured variant through `sh` dies with
 * MODULE_NOT_FOUND, because `sh` expands the unescaped `$bunfs` inside double
 * quotes to the empty string (`"/$bunfs/cli.js"` → `//cli.js`).
 *
 * These two forms CANNOT be converged: the source form must name `dist/cli.js`
 * (a compiled binary has no such file) and the compiled form must name the
 * executable itself. So the contract is pinned per-branch instead, and the shim
 * is EXECUTED rather than string-matched wherever that is possible.
 *
 * TEETH: `isStandaloneBinary()` runs for real — it keys off `process.argv[1]`
 * starting with `/$bunfs/` (src/core/self-spawn.ts) — so pointing argv[1] there
 * exercises the genuine branch rather than a mock.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { botmuxShimExecLine, botmuxCliInvocation } from '../src/adapters/backend/sandbox.js';

const REAL_ARGV1 = process.argv[1];
function asCompiledBinary() { process.argv[1] = '/$bunfs/root/cli.js'; }
afterEach(() => { process.argv[1] = REAL_ARGV1; });

describe('sandbox botmux shim — compiled binary form', () => {
  it('never emits a /$bunfs/ path, and never re-introduces node', () => {
    asCompiledBinary();
    const shim = botmuxShimExecLine();
    // The path is invisible to the process that will run this, AND `sh` would
    // eat the `$bunfs` token anyway.
    expect(shim).not.toContain('$bunfs');
    // `node` as a command word — a path that merely contains "node" (e.g.
    // /root/.../node-versions/...) must not produce a false pass.
    expect(shim).not.toMatch(/(^|\s)node(\s|$)/m);
  });

  it('execs the binary itself, with argv forwarded', () => {
    asCompiledBinary();
    expect(botmuxShimExecLine()).toBe(`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  });

  it('the emitted shim actually runs and forwards args (not merely string-matched)', () => {
    asCompiledBinary();
    const dir = mkdtempSync(join(tmpdir(), 'sbx-shim-'));
    // Stand in for the compiled binary: echo argv back. The shim's shape is what
    // is under test, so substituting the target is legitimate — what matters is
    // that `exec <path> "$@"` parses, runs, and keeps arguments intact.
    const fake = join(dir, 'botmux-fake');
    writeFileSync(fake, '#!/bin/sh\nprintf "GOT:%s\\n" "$@"\n', { mode: 0o755 });
    chmodSync(fake, 0o755);

    const shim = join(dir, 'botmux');
    writeFileSync(shim, botmuxShimExecLine().replace(JSON.stringify(process.execPath), JSON.stringify(fake)), { mode: 0o755 });
    chmodSync(shim, 0o755);

    const r = spawnSync(shim, ['send', 'hello world'], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    // Second argument survives as ONE argument despite the space.
    expect(r.stdout).toBe('GOT:send\nGOT:hello world\n');
  });

  it('the OLD form dies when executed — the regression this pins', () => {
    // Not a test of our code: a demonstration that the shape we no longer emit is
    // genuinely broken, so the assertions above are load-bearing rather than
    // stylistic. `sh` expands the unescaped $bunfs to empty → `//cli.js`.
    const dir = mkdtempSync(join(tmpdir(), 'sbx-oldshim-'));
    const old = join(dir, 'botmux');
    writeFileSync(old, '#!/bin/sh\nexec node "/$bunfs/cli.js" "$@"\n', { mode: 0o755 });
    chmodSync(old, 0o755);
    const r = spawnSync(old, ['send', 'hi'], { encoding: 'utf-8' });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/cannot find module|MODULE_NOT_FOUND/i);
  });
});

describe('sandbox botmux shim — Node form unchanged', () => {
  it('keeps `exec node <dist/cli.js>` (verified byte-identical to pre-change)', () => {
    const shim = botmuxShimExecLine();
    expect(shim.startsWith('#!/bin/sh\nexec node "')).toBe(true);
    expect(shim).toMatch(/[/\\]cli\.js" "\$@"\n$/);
    expect(shim).not.toContain('$bunfs');
  });

  it('quotes the script path so a directory with spaces still works', () => {
    // JSON.stringify is the quoting mechanism; assert the observable property
    // rather than the implementation.
    const shim = botmuxShimExecLine();
    const m = /exec node (".*?") "\$@"/.exec(shim);
    expect(m).not.toBeNull();
    expect(() => JSON.parse(m![1])).not.toThrow();
  });
});

describe('relay host re-exec — botmuxCliInvocation', () => {
  it('compiled: no script argument, so the binary dispatches `send` itself', () => {
    asCompiledBinary();
    // MEASURED: `<binary> "/dist/cli.js" send …` prints the help banner and exits
    // 0, i.e. the relayed send silently does nothing.
    expect(botmuxCliInvocation()).toEqual({ command: process.execPath, args: [] });
  });

  it('Node: keeps the script argument (node cannot resolve `send` alone)', () => {
    const { command, args } = botmuxCliInvocation();
    expect(command).toBe(process.execPath);
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(/[/\\]cli\.js$/);
  });

  it('an explicit cliPath override wins in both forms (tests inject one)', () => {
    expect(botmuxCliInvocation('/custom/cli.js')).toEqual({ command: process.execPath, args: ['/custom/cli.js'] });
    asCompiledBinary();
    expect(botmuxCliInvocation('/custom/cli.js')).toEqual({ command: process.execPath, args: ['/custom/cli.js'] });
  });

  it('the two forms differ exactly by the script argument', () => {
    const nodeForm = botmuxCliInvocation();
    asCompiledBinary();
    const binForm = botmuxCliInvocation();
    // Stated as a relation, so editing either branch alone breaks it.
    expect(nodeForm.args).toHaveLength(binForm.args.length + 1);
  });

  it('SOURCE PIN: the relay spawn consumes the invocation, not a bare path', () => {
    // The helper is only useful if the spawn site actually uses it; a future edit
    // that reverts to `spawn(process.execPath, [cli, 'send', …])` would leave
    // every assertion above passing while the bug returns.
    const src = readFileSync(new URL('../src/adapters/backend/sandbox.ts', import.meta.url), 'utf-8');
    expect(src).toContain("spawn(cliInvocation.command, [...cliInvocation.args, 'send'");
    expect(src).toContain('botmuxCliInvocation(opts.cliPath)');
    // And the shim writer must go through the helper too.
    expect(src).toContain('writeFileSync(shim, botmuxShimExecLine())');
  });
});
