import { describe, expect, it, afterEach } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { botmuxWrapperFiles } from '../src/core/botmux-wrapper.js';
import { writeBotmuxWrapperFiles, writeBotmuxWrapperFilesWithRetry } from '../src/core/botmux-wrapper-writer.js';
import { withFileLock } from '../src/utils/file-lock.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

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
    expect(files.map(f => f.name)).toEqual([
      'botmux',
      'botmux-native-subagent-runtime-hook',
      'botmux.cmd',
      'botmux-native-subagent-runtime-hook.cmd',
    ]);
    const cmd = files.find(f => f.name === 'botmux.cmd')!;
    const nativeHookCmd = files.find(f => f.name === 'botmux-native-subagent-runtime-hook.cmd')!;
    expect(cmd.content).toBe(`@echo off\r\n"${BINARY}" %*\r\n`);
    expect(nativeHookCmd.content).toBe(`@echo off\r\n"${BINARY}" native-subagent-runtime-hook %*\r\n`);
    expect(cmd.content).not.toContain('$bunfs');
  });

  it('the Node (non-standalone) form pins the interpreter — default stays consistent', () => {
    // Same expectation as the pre-existing test, asserted here too so a future
    // edit cannot "fix" standalone by breaking the Node path.
    const viaDefault = botmuxWrapperFiles('/opt/botmux/dist/cli.js', '/usr/bin/node', 'linux');
    const viaExplicitFalse = botmuxWrapperFiles('/opt/botmux/dist/cli.js', '/usr/bin/node', 'linux', false);
    expect(viaDefault[0].content).toBe('#!/bin/sh\nexec "/usr/bin/node" "/opt/botmux/dist/cli.js" "$@"\n');
    expect(viaExplicitFalse).toEqual(viaDefault);
  });

  it('pins whatever interpreter it is handed — Bun hosts the same wrapper shape', () => {
    // Under `bun dist/cli.js` process.execPath IS the bun binary; Bun runs
    // dist/*.js and supplies bun:sqlite, so no runtime-specific branch is needed.
    const [sh] = botmuxWrapperFiles('/opt/botmux/dist/cli.js', '/home/u/.bun/bin/bun', 'linux');
    expect(sh.content).toBe('#!/bin/sh\nexec "/home/u/.bun/bin/bun" "/opt/botmux/dist/cli.js" "$@"\n');
    expect(sh.content).not.toMatch(/exec node /);
  });
});

describe('daemon wrapper write — refuses to clobber the running executable', () => {
  function write(dir: string, files: ReturnType<typeof botmuxWrapperFiles>, runningExecutable: string) {
    return writeBotmuxWrapperFiles({
      binDir: dir, files, runningExecutable, lockTarget: join(dir, 'global-install-lock'),
    });
  }

  it('skips when the wrapper path IS the running binary (the self-destruct case)', () => {
    const dir = tmp();
    const bin = join(dir, 'botmux');
    writeFileSync(bin, 'ELF-ish payload', { mode: 0o755 });
    const sizeBefore = statSync(bin).size;
    const inoBefore = statSync(bin).ino;

    const result = write(dir, botmuxWrapperFiles('/unused', bin, 'linux', true), bin);
    expect(result.skipped).toContain(bin);
    expect(statSync(bin).size).toBe(sizeBefore);
    expect(statSync(bin).ino).toBe(inoBefore);
  });

  it('skips through symlinks on either side (realpath, not string compare)', () => {
    const dir = tmp();
    const realBin = join(dir, 'real-botmux');
    writeFileSync(realBin, 'payload', { mode: 0o755 });
    const linkedWrapper = join(dir, 'botmux');
    symlinkSync(realBin, linkedWrapper);

    const result = write(dir, botmuxWrapperFiles('/unused', realBin, 'linux', true), realBin);
    expect(result.skipped).toContain(linkedWrapper);
    expect(readFileSync(realBin, 'utf8')).toBe('payload');
  });

  it('does NOT skip a genuine wrapper file (guard must not disable normal writes)', () => {
    const dir = tmp();
    const wrapper = join(dir, 'botmux');
    writeFileSync(wrapper, '#!/bin/sh\nexec node "/opt/old/dist/cli.js" "$@"\n', { mode: 0o755 });
    const files = botmuxWrapperFiles('/opt/new/dist/cli.js', process.execPath, 'linux', false);
    const result = write(dir, files, process.execPath);

    expect(result.written).toContain(wrapper);
    expect(readFileSync(wrapper, 'utf8')).toBe(files[0].content);
  });

  it('does NOT skip when the wrapper does not exist yet (first boot)', () => {
    const dir = tmp();
    const wrapper = join(dir, 'botmux');
    const files = botmuxWrapperFiles('/opt/new/dist/cli.js', process.execPath, 'linux', false);
    const result = write(dir, files, process.execPath);

    expect(result.written).toContain(wrapper);
    expect(readFileSync(wrapper, 'utf8')).toBe(files[0].content);
  });

  it('holds the global install lock through the wrapper read/check/write sequence', async () => {
    const dir = tmp();
    const binDir = join(dir, 'bin');
    const wrapper = join(binDir, 'botmux');
    const lockTarget = join(dir, 'global-install-lock');
    const options = {
      binDir,
      files: botmuxWrapperFiles('/opt/new/dist/cli.js', process.execPath, 'linux', false),
      runningExecutable: process.execPath,
      lockTarget,
    };
    let child: ReturnType<typeof spawnTsEvalWithRepoImports> | undefined;
    let stdout = '', stderr = '';
    try {
      await withFileLock(lockTarget, async () => {
        child = spawnTsEvalWithRepoImports(`
          import { writeBotmuxWrapperFiles } from './src/core/botmux-wrapper-writer.js';
          const options = ${JSON.stringify(options)};
          console.log('WRITER_READY');
          const result = writeBotmuxWrapperFiles(options);
          console.log('WRITER_DONE=' + JSON.stringify(result));
        `, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout?.on('data', chunk => { stdout += String(chunk); });
        child.stderr?.on('data', chunk => { stderr += String(chunk); });
        const deadline = Date.now() + 10_000;
        while (!stdout.includes('WRITER_READY') && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(stdout, stderr).toContain('WRITER_READY');
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(existsSync(wrapper), stdout).toBe(false);
      });
      const status = await new Promise<number | null>((resolve, reject) => {
        child!.once('error', reject);
        child!.once('exit', code => resolve(code));
      });
      expect(status, `${stdout}\n${stderr}`).toBe(0);
      expect(readFileSync(wrapper, 'utf8')).toBe(options.files[0].content);
    } finally {
      if (child && child.exitCode === null) child.kill();
    }
  }, 20_000);

  it('retries lock contention after the installer releases the lock', async () => {
    const dir = tmp();
    const binDir = join(dir, 'bin');
    const wrapper = join(binDir, 'botmux');
    const lockTarget = join(dir, 'global-install-lock');
    const files = botmuxWrapperFiles('/opt/new/dist/cli.js', process.execPath, 'linux', false);
    const errors: unknown[] = [];
    let cancel: (() => void) | undefined;
    try {
      await withFileLock(lockTarget, async () => {
        cancel = writeBotmuxWrapperFilesWithRetry({
          binDir, files, runningExecutable: process.execPath, lockTarget,
          lockOptions: { maxWaitMs: 0 }, retryDelayMs: 20,
          onResult: () => undefined,
          onError: error => { errors.push(error); },
        });
        expect(existsSync(wrapper)).toBe(false);
        await new Promise(resolve => setTimeout(resolve, 60));
        expect(existsSync(wrapper)).toBe(false);
      });
      const deadline = Date.now() + 2_000;
      while (!existsSync(wrapper) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(existsSync(wrapper)).toBe(true);
      expect(errors).toEqual([]);
      expect(readFileSync(wrapper, 'utf8')).toBe(files[0].content);
    } finally {
      cancel?.();
    }
  }, 10_000);

  it('does not replay a delayed source write over a release installed while waiting', async () => {
    const dir = tmp();
    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const wrapper = join(binDir, 'botmux');
    const lockTarget = join(dir, 'global-install-lock');
    const files = botmuxWrapperFiles('/opt/old/dist/cli.js', process.execPath, 'linux', false);
    writeFileSync(wrapper, files[0].content);
    const candidate = join(dir, 'candidate');
    writeFileSync(candidate, 'official-new-binary');
    const errors: unknown[] = [];
    let cancel: (() => void) | undefined;
    let resolveResult!: (result: { deferred: string[] }) => void;
    const resultPromise = new Promise<{ deferred: string[] }>(resolve => { resolveResult = resolve; });
    try {
      await withFileLock(lockTarget, async () => {
        cancel = writeBotmuxWrapperFilesWithRetry({
          binDir, files, runningExecutable: process.execPath, lockTarget,
          lockOptions: { maxWaitMs: 0 }, retryDelayMs: 20,
          onResult: result => { resolveResult(result); },
          onError: error => { errors.push(error); },
        });
        // The release installer wins while this daemon is waiting for the lock.
        renameSync(candidate, wrapper);
        await new Promise(resolve => setTimeout(resolve, 60));
      });
      const result = await resultPromise;
      expect(result.deferred).toContain(wrapper);
      expect(errors).toEqual([]);
      expect(readFileSync(wrapper, 'utf8')).toBe('official-new-binary');
    } finally {
      cancel?.();
    }
  }, 10_000);

  it('observes atomic replacements of a symlink launcher target across retries', async () => {
    const dir = tmp();
    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const target = join(dir, 'launcher-target');
    const wrapper = join(binDir, 'botmux');
    const lockTarget = join(dir, 'global-install-lock');
    const files = botmuxWrapperFiles('/daemon/dist/cli.js', process.execPath, 'linux', false);
    writeFileSync(target, files[0].content);
    symlinkSync(target, wrapper);
    const competitor = join(dir, 'competitor');
    writeFileSync(competitor, 'competitor launcher');
    const errors: unknown[] = [];
    let cancel: (() => void) | undefined;
    let resolveResult!: (result: { deferred: string[] }) => void;
    const resultPromise = new Promise<{ deferred: string[] }>(resolve => { resolveResult = resolve; });
    try {
      await withFileLock(lockTarget, async () => {
        cancel = writeBotmuxWrapperFilesWithRetry({
          binDir, files, runningExecutable: process.execPath, lockTarget,
          lockOptions: { maxWaitMs: 0 }, retryDelayMs: 20,
          onResult: result => { resolveResult(result); },
          onError: error => { errors.push(error); },
        });
        // A cooperating winner replaces the symlink TARGET, leaving the link's
        // own lstat metadata unchanged.
        renameSync(competitor, target);
        await new Promise(resolve => setTimeout(resolve, 60));
      });
      const result = await resultPromise;
      expect(result.deferred).toContain(wrapper);
      expect(errors).toEqual([]);
      expect(lstatSync(wrapper).isSymbolicLink()).toBe(true);
      expect(readFileSync(wrapper, 'utf8')).toBe('competitor launcher');
    } finally {
      cancel?.();
    }
  }, 10_000);
});
