import { describe, expect, it, afterEach } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { botmuxWrapperFiles } from '../src/core/botmux-wrapper.js';

/**
 * Regression tests for the compiled-binary wrapper self-destruct.
 *
 * THE BUG (reproduced before this fix existed): install.sh puts the
 * `bun build --compile` executable at `~/.botmux/bin/botmux`. The daemon's
 * writePidFile() unconditionally wrote a wrapper to that SAME path, built from
 * `join(__dirname, 'cli.js')` — which inside a compiled binary is the virtual,
 * process-private `/$bunfs/root/cli.js`. Net effect on `botmux start`:
 * a 94,582,912-byte executable was replaced by a 47-byte shell script (inode
 * changed, so it really was clobbered), and that script was itself broken three
 * ways: the path does not exist outside the process, it requires `node` (defeating
 * the self-contained binary), and `sh` expanded the unquoted `$bunfs` to empty so
 * it resolved `//root/cli.js`.
 *
 * There was NO test coverage for any of this: the smoke test writes
 * `bots.json = '[]'`, so no bot daemon ever boots and writePidFile is never
 * reached. These tests cover the two halves of the fix directly.
 */

const tempDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'botmux-wrapper-guard-'));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('botmuxWrapperFiles — standalone (compiled binary) form', () => {
  const BUNFS_CLI = '/$bunfs/root/cli.js';
  const BINARY = '/home/u/.botmux/bin/botmux';

  it('never emits a /$bunfs/ path (it does not exist outside the process)', () => {
    for (const f of botmuxWrapperFiles(BUNFS_CLI, BINARY, 'linux', true)) {
      expect(f.content).not.toContain('$bunfs');
      expect(f.content).not.toContain('/root/cli.js');
    }
  });

  it('never requires node — that is the whole point of the self-contained binary', () => {
    const [sh] = botmuxWrapperFiles(BUNFS_CLI, BINARY, 'linux', true);
    // Match `node` as a command word, so a path that merely contains "node"
    // (e.g. /opt/nodex/bin/botmux) does not produce a false pass.
    expect(sh.content).not.toMatch(/(^|\s)node(\s|$)/m);
  });

  it('execs the binary itself and forwards argv verbatim', () => {
    const [sh] = botmuxWrapperFiles(BUNFS_CLI, BINARY, 'linux', true);
    expect(sh.name).toBe('botmux');
    expect(sh.content).toBe(`#!/bin/sh\nexec "${BINARY}" "$@"\n`);
    expect(sh.mode).toBe(0o755);
  });

  it('the emitted sh actually runs and passes args through (not just string-shaped)', () => {
    // Asserting on the string alone would pass even if the wrapper were
    // unrunnable. Execute it: a fake "binary" echoes its argv back.
    const dir = tmp();
    const fakeBinary = join(dir, 'fake-botmux');
    writeFileSync(fakeBinary, '#!/bin/sh\nprintf "GOT:%s\\n" "$@"\n', { mode: 0o755 });
    chmodSync(fakeBinary, 0o755);

    const [sh] = botmuxWrapperFiles(BUNFS_CLI, fakeBinary, 'linux', true);
    const wrapper = join(dir, 'botmux');
    writeFileSync(wrapper, sh.content, { mode: 0o755 });
    chmodSync(wrapper, 0o755);

    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const r = spawnSync(wrapper, ['send', 'hello world'], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    // Proves exec reached the binary AND kept "hello world" as ONE argument.
    expect(r.stdout).toBe('GOT:send\nGOT:hello world\n');
  });

  it('windows .cmd form also targets the binary, never node', () => {
    const files = botmuxWrapperFiles(BUNFS_CLI, BINARY, 'win32', true);
    expect(files.map(f => f.name)).toEqual(['botmux', 'botmux.cmd']);
    const cmd = files.find(f => f.name === 'botmux.cmd')!;
    expect(cmd.content).toBe(`@echo off\r\n"${BINARY}" %*\r\n`);
    expect(cmd.content).not.toContain('$bunfs');
  });

  it('the Node (non-standalone) form is unchanged — default stays backward-compatible', () => {
    // Same expectation as the pre-existing test, asserted here too so a future
    // edit cannot "fix" standalone by breaking the Node path.
    const viaDefault = botmuxWrapperFiles('/opt/botmux/dist/cli.js', '/usr/bin/node', 'linux');
    const viaExplicitFalse = botmuxWrapperFiles('/opt/botmux/dist/cli.js', '/usr/bin/node', 'linux', false);
    expect(viaDefault[0].content).toBe('#!/bin/sh\nexec node "/opt/botmux/dist/cli.js" "$@"\n');
    expect(viaExplicitFalse).toEqual(viaDefault);
  });
});

describe('daemon wrapper write — refuses to clobber the running executable', () => {
  /**
   * Mirrors the guard in src/daemon.ts writePidFile(). Kept as a local
   * reimplementation because writePidFile is not exported and pulling in daemon.ts
   * boots a whole daemon; the SOURCE PIN below ties this logic to the real one so
   * the two cannot silently drift.
   */
  function wouldSkip(wrapperPath: string, execPath: string): boolean {
    const { realpathSync } = require('node:fs') as typeof import('node:fs');
    try {
      return realpathSync(wrapperPath) === realpathSync(execPath);
    } catch {
      return false;
    }
  }

  it('skips when the wrapper path IS the running binary (the self-destruct case)', () => {
    const dir = tmp();
    const bin = join(dir, 'botmux');
    // Stand in for the 94MB ELF install.sh drops at ~/.botmux/bin/botmux.
    writeFileSync(bin, 'ELF-ish payload', { mode: 0o755 });
    const sizeBefore = statSync(bin).size;
    const inoBefore = statSync(bin).ino;

    expect(wouldSkip(bin, bin)).toBe(true);
    // And the file is untouched — the point of the guard.
    expect(statSync(bin).size).toBe(sizeBefore);
    expect(statSync(bin).ino).toBe(inoBefore);
  });

  it('skips through symlinks on either side (realpath, not string compare)', () => {
    const dir = tmp();
    const realBin = join(dir, 'real-botmux');
    writeFileSync(realBin, 'payload', { mode: 0o755 });
    const linkedWrapper = join(dir, 'botmux');
    symlinkSync(realBin, linkedWrapper);
    // Different strings, same inode → must still skip.
    expect(linkedWrapper).not.toBe(realBin);
    expect(wouldSkip(linkedWrapper, realBin)).toBe(true);
  });

  it('does NOT skip a genuine wrapper file (guard must not disable normal writes)', () => {
    // Reverse direction: if this returned true, the guard would suppress the
    // wrapper for every ordinary Node install and break `botmux send` in sessions.
    const dir = tmp();
    const wrapper = join(dir, 'botmux');
    writeFileSync(wrapper, '#!/bin/sh\nexec node "/opt/botmux/dist/cli.js" "$@"\n', { mode: 0o755 });
    const someNode = process.execPath;
    expect(wouldSkip(wrapper, someNode)).toBe(false);
  });

  it('does NOT skip when the wrapper does not exist yet (first boot)', () => {
    const dir = tmp();
    expect(wouldSkip(join(dir, 'botmux'), process.execPath)).toBe(false);
  });

  it('SOURCE PIN: daemon.ts really has the guard and passes standalone through', () => {
    // These pin the wiring, because every behavioral test above runs against a
    // local reimplementation. If daemon.ts loses the guard, the bug returns while
    // the tests above still pass — so assert on the real source.
    const src = readFileSync(resolve('src/daemon.ts'), 'utf-8');
    const region = src.slice(src.indexOf('function writePidFile('), src.indexOf('PID file written'));
    expect(region).toContain('isStandaloneBinary()');
    // The wrapper generator must receive the standalone flag (4th arg).
    expect(region).toMatch(/botmuxWrapperFiles\(\s*cliScript,\s*process\.execPath,\s*process\.platform,\s*standalone\s*\)/);
    // The clobber guard itself.
    expect(region).toContain('realpathSync(wrapper) === realpathSync(process.execPath)');
    // It must `continue` (skip this file), not fall through to the write.
    expect(region).toMatch(/isRunningBinary\s*\)\s*\{[\s\S]{0,400}?continue;/);
  });
});
