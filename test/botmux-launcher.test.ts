import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * `scripts/botmux-launcher.sh` is the package's `bin` entry: the ONLY thing that
 * gives pnpm and bun users a working `botmux` command, because neither runs the
 * postinstall that writes ~/.botmux/bin/botmux.
 *
 * MEASURED on v3.18.13 before this launcher existed (isolated HOME each):
 *   npm i -g botmux    → postinstall ran      → command works
 *   bun add -g botmux  → "Blocked 2 postinstalls" → NO command
 *   pnpm add -g botmux → script not run          → NO command
 * Both failures exit 0 and print "installed", so the user only finds out at
 * `botmux: command not found`.
 *
 * These tests drive the real script with a fake platform binary, so they cover
 * the layout resolution rather than restating it. The layouts are the ones real
 * global installs produce (verified against actual npm/pnpm/bun installs).
 */
const LAUNCHER = resolve(import.meta.dirname, '../scripts/botmux-launcher.sh');

/** A stand-in for the compiled binary: prints a marker plus the argv it got. */
function writeFakeBinary(path: string): void {
  writeFileSync(path, '#!/bin/sh\necho "FAKE-BINARY $*"\n', { mode: 0o755 });
}

/**
 * Build `<root>/node_modules/botmux` with the launcher in place, and drop a fake
 * platform binary into the requested layout.
 *
 * `nested`  → <main>/node_modules/botmux-<plat>/botmux   (npm)
 * `sibling` → <main>/../botmux-<plat>/botmux             (pnpm, bun)
 * `none`    → no platform package at all
 */
function makeInstall(layout: 'nested' | 'sibling' | 'none'): { dir: string; main: string } {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-launcher-'));
  const nm = join(dir, 'node_modules');
  const main = join(nm, 'botmux');
  mkdirSync(join(main, 'scripts'), { recursive: true });
  // Copy rather than symlink: the launcher must work as a plain file too.
  const body = spawnSync('cat', [LAUNCHER], { encoding: 'utf-8' }).stdout;
  const shipped = join(main, 'scripts', 'botmux-launcher.sh');
  writeFileSync(shipped, body, { mode: 0o755 });

  const plat = `botmux-${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`;
  if (layout === 'nested') {
    const d = join(main, 'node_modules', plat);
    mkdirSync(d, { recursive: true });
    writeFakeBinary(join(d, 'botmux'));
  } else if (layout === 'sibling') {
    const d = join(nm, plat);
    mkdirSync(d, { recursive: true });
    writeFakeBinary(join(d, 'botmux'));
  }
  return { dir, main };
}

function runLauncher(entry: string, args: string[] = ['--version']) {
  return spawnSync(entry, args, { encoding: 'utf-8', timeout: 20_000 });
}

const onPosix = process.platform === 'win32' ? describe.skip : describe;

onPosix('botmux-launcher.sh', () => {
  it.each(['nested', 'sibling'] as const)(
    'resolves the platform binary in the %s layout (npm vs pnpm/bun)',
    (layout) => {
      const { dir, main } = makeInstall(layout);
      try {
        const r = runLauncher(join(main, 'scripts', 'botmux-launcher.sh'));
        expect(r.stdout.trim(), `stderr=${r.stderr}`).toBe('FAKE-BINARY --version');
        expect(r.status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('resolves through a symlinked bin entry (how managers put it on PATH)', () => {
    const { dir, main } = makeInstall('sibling');
    try {
      const binDir = join(dir, 'bin');
      mkdirSync(binDir, { recursive: true });
      const link = join(binDir, 'botmux');
      symlinkSync(join(main, 'scripts', 'botmux-launcher.sh'), link);
      const r = runLauncher(link);
      expect(r.stdout.trim(), `stderr=${r.stderr}`).toBe('FAKE-BINARY --version');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes argv through verbatim, including flags and spaces', () => {
    const { dir, main } = makeInstall('nested');
    try {
      const r = runLauncher(join(main, 'scripts', 'botmux-launcher.sh'), ['send', '--no-mention', 'a b']);
      expect(r.stdout.trim()).toBe('FAKE-BINARY send --no-mention a b');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails loudly (exit 1 + actionable stderr) when no platform package installed', () => {
    const { dir, main } = makeInstall('none');
    try {
      const r = runLauncher(join(main, 'scripts', 'botmux-launcher.sh'));
      // Exit code matters: a silent 0 would make wrapper scripts think it worked.
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('no platform binary found');
      expect(r.stderr).toContain('Reinstall');
      expect(r.stdout).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not pick a non-executable candidate (a bad unpack must not be exec-ed)', () => {
    const { dir, main } = makeInstall('nested');
    try {
      const plat = `botmux-${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`;
      chmodSync(join(main, 'node_modules', plat, 'botmux'), 0o644);
      const r = runLauncher(join(main, 'scripts', 'botmux-launcher.sh'));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('no platform binary found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is POSIX sh (no bashisms) — pnpm and npm shims both exec it with /bin/sh', () => {
    expect(spawnSync('sh', ['-n', LAUNCHER], { encoding: 'utf-8' }).status).toBe(0);
  });
});
