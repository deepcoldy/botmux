/**
 * `claim-botmux-bin.mjs --binary` — point the global `botmux` at a COMPILED
 * binary so local dogfooding runs the form users actually install.
 *
 * WHY THIS MODE EXISTS: the default `use:here` writes `exec node
 * <checkout>/dist/cli.js` — the SOURCE form. Users run a `bun build --compile`
 * single file, where `__dirname` is the virtual `/$bunfs/root`. Every divergence
 * between those two forms is therefore invisible locally and surfaces only after
 * install. That has shipped four times: the Dashboard 404ing every request
 * (88e3d7f24), `setup` throwing `找不到 botmux lark-scopes.json` (2ef5c3a58),
 * `--version` printing `unknown` (c6b88e376), and the daemon overwriting its own
 * binary with a 47-byte shell script (8386f34dd).
 *
 * WHAT THESE TESTS PIN — three invariants, each with teeth:
 *
 *   1. The wrapper is byte-identical to the two PRODUCTION writers of the same
 *      file: `botmuxWrapperFiles(..., standalone=true)` (what the daemon writes)
 *      and `scripts/postinstall-bin.mjs` (what npm install writes). Three
 *      independent implementations of one format drift silently — and a drifted
 *      wrapper is not a test failure, it is ~50 live daemons losing `botmux send`.
 *
 *   2. The wrapper is EXECUTED, not string-matched. A fake binary echoes its
 *      argv, so a wrapper that parses but cannot exec (bad quoting, lost args)
 *      fails here rather than in the fleet.
 *
 *   3. The self-destruct guard fires. install.sh puts the binary at
 *      `~/.botmux/bin/botmux` — the wrapper's own path — so `--binary` pointed
 *      there would replace the executable with a few dozen bytes of `sh`.
 *      VERIFIED by anti-mutation: with the guard stubbed out, a 169,673,928-byte
 *      binary became 63 bytes, reproducing 8386f34dd exactly.
 *
 * Every case runs against a scratch `HOME`, so the real `~/.botmux/bin/botmux`
 * (which this machine's fleet depends on) is never touched.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { botmuxWrapperFiles } from '../src/core/botmux-wrapper.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPT = join(REPO_ROOT, 'scripts', 'claim-botmux-bin.mjs');

/** A stand-in for the compiled binary: executable, and echoes its argv back. */
function fakeBinary(dir: string, name = 'botmux-fake'): string {
  const p = join(dir, name);
  writeFileSync(p, '#!/bin/sh\nprintf "GOT:%s\\n" "$@"\n', { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

function runClaim(args: string[], home: string) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, HOME: home },
    cwd: REPO_ROOT,
  });
  const wrapper = join(home, '.botmux', 'bin', 'botmux');
  return { ...r, wrapper, wrote: existsSync(wrapper) };
}

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'claim-binary-test-'));
  mkdirSync(join(home, '.botmux', 'bin'), { recursive: true });
  return home;
}

describe('claim-botmux-bin --binary — global botmux points at the compiled binary', () => {
  it('writes a wrapper byte-identical to what the daemon writes for a standalone binary', () => {
    const home = scratchHome();
    const binary = fakeBinary(home);
    const r = runClaim(['--binary', binary], home);

    expect(r.status).toBe(0);
    expect(r.wrote).toBe(true);

    // The daemon's writer is the reference implementation. `nodePath` carries the
    // binary path in the standalone branch (see botmuxWrapperFiles' signature).
    const [reference] = botmuxWrapperFiles('/unused/dist/cli.js', realpathSync(binary), 'linux', true);
    expect(readFileSync(r.wrapper, 'utf-8')).toBe(reference.content);

    // No `node` as a command word — the whole point of the compiled binary is
    // that it needs no Node. Matched as a word so a path containing "node"
    // (e.g. /root/node-versions/...) cannot produce a false pass.
    expect(readFileSync(r.wrapper, 'utf-8')).not.toMatch(/(^|\s)node(\s|$)/m);
  });

  it('the wrapper actually execs and forwards argv verbatim (including spaces)', () => {
    const home = scratchHome();
    fakeBinary(home);
    runClaim(['--binary', join(home, 'botmux-fake')], home);

    const r = spawnSync(join(home, '.botmux', 'bin', 'botmux'), ['send', 'hello world'], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    // Two args, the second one intact as ONE argument despite the space.
    expect(r.stdout).toBe('GOT:send\nGOT:hello world\n');
  });

  it('REFUSES to write when the target is the wrapper path itself (8386f34dd)', () => {
    const home = scratchHome();
    // Exactly the install.sh layout: the binary IS ~/.botmux/bin/botmux.
    const inPlace = join(home, '.botmux', 'bin', 'botmux');
    writeFileSync(inPlace, '#!/bin/sh\nprintf "GOT:%s\\n" "$@"\n', { mode: 0o755 });
    chmodSync(inPlace, 0o755);
    const sizeBefore = statSync(inPlace).size;

    const r = runClaim(['--binary', inPlace], home);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('拒绝写入');
    // The teeth: the file is untouched. Without the guard this shrinks to a
    // ~60-byte `sh` stub (measured on a real 169MB binary: 63 bytes).
    expect(statSync(inPlace).size).toBe(sizeBefore);
  });

  it('resolves a symlinked target to its real path (matches both production writers)', () => {
    // WHY A DEDICATED CASE: every other test here builds paths under `mkdtemp`,
    // and on this machine `/tmp` is a real directory, so `realpathSync(p) === p`
    // and a missing realpath call is INDISTINGUISHABLE. Verified: stubbing the
    // realpath out left the whole file green until this case existed.
    //
    // It matters because both production writers store a resolved path —
    // postinstall-bin.mjs realpaths before writing, and the daemon passes
    // `process.execPath`, which the OS has already resolved. A wrapper written
    // through a symlink would therefore differ from what a restart writes, and
    // the two would fight over the file on every boot.
    const home = scratchHome();
    const real = fakeBinary(home, 'real-binary');
    const link = join(home, 'link-to-binary');
    symlinkSync(real, link);

    const r = runClaim(['--binary', link], home);
    expect(r.status).toBe(0);

    const content = readFileSync(r.wrapper, 'utf-8');
    expect(content).toContain(`exec "${real}"`);
    // The symlink path must NOT survive into the wrapper.
    expect(content).not.toContain(link);
    // And it still execs — resolving must not break the exec itself.
    const exec = spawnSync(r.wrapper, ['ok'], { encoding: 'utf-8' });
    expect(exec.stdout).toBe('GOT:ok\n');
  });

  it('fails closed when the binary is missing, and names how to build one', () => {
    const home = scratchHome();
    const r = runClaim(['--binary', join(home, 'does-not-exist')], home);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('找不到编译版二进制');
    // The message has to carry the build command, otherwise the failure is a
    // dead end for whoever hits it.
    expect(r.stderr).toContain('build-bun-binary.mjs');
    expect(r.wrote).toBe(false);
  });

  it('rejects a directory (a wrapper that execs one is broken, not merely wrong)', () => {
    const home = scratchHome();
    const dir = join(home, 'a-directory');
    mkdirSync(dir, { recursive: true });
    const r = runClaim(['--binary', dir], home);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('不是文件');
    expect(r.wrote).toBe(false);
  });

  it('without --binary the source form is unchanged (backward compatible)', () => {
    const home = scratchHome();
    const r = runClaim([], home);
    expect(r.status).toBe(0);
    const content = readFileSync(r.wrapper, 'utf-8');

    // Must still equal the daemon's NON-standalone form, so the existing
    // `use:here` behaviour cannot be broken by the --binary addition.
    const [reference] = botmuxWrapperFiles(join(REPO_ROOT, 'dist', 'cli.js'), process.execPath, 'linux', false);
    expect(content).toBe(reference.content);
    expect(content).toContain('exec node ');
  });

  it('BOTMUX_NO_CLAIM still short-circuits in --binary mode', () => {
    const home = scratchHome();
    const binary = fakeBinary(home);
    const r = spawnSync(process.execPath, [SCRIPT, '--binary', binary], {
      encoding: 'utf-8',
      env: { PATH: process.env.PATH, HOME: home, BOTMUX_NO_CLAIM: '1' },
      cwd: REPO_ROOT,
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(home, '.botmux', 'bin', 'botmux'))).toBe(false);
  });
});
