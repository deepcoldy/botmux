import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';

/**
 * install.sh (the `curl … | sh` installer) — asset-name selection.
 *
 * WHY THIS FILE EXISTS: the installer picks a release asset from `uname` output plus
 * a libc probe. Getting the libc wrong is not a cosmetic bug — a glibc-linked binary
 * does not run on musl at all (it dies in the loader naming no cause), so a false
 * positive would hand every ordinary Linux user a binary that cannot start.
 *
 * These tests EXECUTE the real detection block extracted from install.sh, with the
 * probes redirected at a fake root. Asserting on the script's text instead would pass
 * just as happily with the logic deleted.
 */
const INSTALL_SH = resolve(import.meta.dirname, '../install.sh');
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'botmux-install-sh-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Run install.sh's libc-detection block with a controlled environment.
 *
 * `lddOutput`  — what a `ldd --version` shim prints (null = no ldd on PATH at all)
 * `muslLoader` — create `<fake>/lib/ld-musl-x86_64.so.1`
 * `alpineFile` — create `<fake>/etc/alpine-release`
 */
function detectAsset(opts: { lddOutput?: string | null; muslLoader?: boolean; alpineFile?: boolean }) {
  const base = tmp();
  const fake = join(base, 'fake');
  const bin = join(base, 'bin');
  mkdirSync(join(fake, 'lib'), { recursive: true });
  mkdirSync(join(fake, 'usr', 'lib'), { recursive: true });
  mkdirSync(join(fake, 'etc'), { recursive: true });
  mkdirSync(bin, { recursive: true });

  if (opts.muslLoader) writeFileSync(join(fake, 'lib', 'ld-musl-x86_64.so.1'), '');
  if (opts.alpineFile) writeFileSync(join(fake, 'etc', 'alpine-release'), '3.20\n');
  if (opts.lddOutput != null) {
    // musl's ldd exits non-zero for --version; mimic that so the test proves the
    // installer does not depend on the exit status.
    writeFileSync(join(bin, 'ldd'), `#!/bin/sh\nprintf '%s\\n' "${opts.lddOutput}" >&2\nexit 1\n`, { mode: 0o755 });
  }

  // Extract ONLY the real block, then point its three probes at the fake root.
  const src = readFileSync(INSTALL_SH, 'utf-8');
  const block = /^# On Linux, pick the musl build[\s\S]*?\nfi$/m.exec(src);
  expect(block, 'the musl-detection block must still exist in install.sh').toBeTruthy();
  const body = block![0]
    .replaceAll('/lib/ld-musl-*', `${fake}/lib/ld-musl-*`)
    .replaceAll('/usr/lib/ld-musl-*', `${fake}/usr/lib/ld-musl-*`)
    .replaceAll('/etc/alpine-release', `${fake}/etc/alpine-release`);

  const script = join(base, 'probe.sh');
  writeFileSync(script, `os_tag=linux\narch_tag=x64\nasset="botmux-\${os_tag}-\${arch_tag}"\n${body}\necho "$asset"\n`);
  // PATH carries ONLY our shim dir (plus a busybox-ish minimum) so that
  // `command -v ldd` is genuinely false when the test says "no ldd". Including
  // /usr/bin:/bin here would always find the system ldd and make the
  // no-ldd fixtures untestable — they would silently exercise the ldd branch.
  const shellBins = join(base, 'shbin');
  mkdirSync(shellBins, { recursive: true });
  for (const cmd of ['grep', 'ls', 'sh', 'printf']) {
    // Symlink the few utilities the block itself needs, without dragging in ldd.
    try {
      const real = execFileSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf-8' }).trim();
      if (real) writeFileSync(join(shellBins, cmd), `#!/bin/sh\nexec ${real} "$@"\n`, { mode: 0o755 });
    } catch { /* command absent; the block tolerates it */ }
  }
  return execFileSync('sh', [script], {
    encoding: 'utf-8',
    env: { PATH: `${bin}:${shellBins}` },
  }).trim();
}

describe('install.sh — musl vs glibc asset selection', () => {
  it('ldd reporting musl → picks the -musl asset', () => {
    expect(detectAsset({ lddOutput: 'musl libc (x86_64)' })).toBe('botmux-linux-x64-musl');
  });

  it('ldd reporting GNU libc → picks the plain (glibc) asset', () => {
    // THE false-positive direction: ordinary Linux must never be sent to -musl.
    expect(detectAsset({ lddOutput: 'ldd (GNU libc) 2.36' })).toBe('botmux-linux-x64');
  });

  it('REGRESSION: glibc distro WITH musl installed → still the plain asset', () => {
    // Debian/Ubuntu `musl` / `musl-tools` (common for Rust/Go musl cross-compiling)
    // drops /lib/ld-musl-x86_64.so.1 at TOP LEVEL. An earlier version of this block
    // treated "ldd did not say musl" as "unknown, keep probing", so the loader
    // overturned ldd's correct glibc answer — measured on debian:bookworm-slim +
    // musl-tools, which selected the musl asset and would have installed a binary
    // that dies in the loader on first run.
    //
    // Rule now: when ldd EXISTS its answer is authoritative in BOTH directions;
    // filesystem probes are only for images with no ldd at all.
    expect(detectAsset({ lddOutput: 'ldd (GNU libc) 2.36', muslLoader: true })).toBe('botmux-linux-x64');
    // Same with Alpine's marker file also present — still glibc, because ldd said so.
    expect(detectAsset({ lddOutput: 'ldd (GNU libc) 2.36', muslLoader: true, alpineFile: true })).toBe('botmux-linux-x64');
  });

  it('no ldd at all, but an ld-musl loader present → -musl', () => {
    // Slim images may lack ldd; the loader is the direct evidence.
    expect(detectAsset({ lddOutput: null, muslLoader: true })).toBe('botmux-linux-x64-musl');
  });

  it('no ldd and no loader, but /etc/alpine-release → -musl', () => {
    expect(detectAsset({ lddOutput: null, alpineFile: true })).toBe('botmux-linux-x64-musl');
  });

  it('no ldd, no loader, no alpine marker → plain asset (never guess musl)', () => {
    expect(detectAsset({ lddOutput: null })).toBe('botmux-linux-x64');
  });

  it('a glibc box is never sent to -musl even when the loader dir is unreadable', () => {
    // Behavioural guard for the false-positive direction, independent of the source
    // pin below: glibc ldd + no loader + no marker must yield the plain asset.
    expect(detectAsset({ lddOutput: 'ldd (GNU libc) 2.36' })).toBe('botmux-linux-x64');
    expect(detectAsset({ lddOutput: 'ldd (GNU libc) 2.36', alpineFile: false })).toBe('botmux-linux-x64');
  });

  it('SOURCE PIN: all three probes are present and the switch is positive-only', () => {
    // Compare CODE ONLY. The block's comments mention `ldd --version` and musl on
    // purpose, so matching the whole file would let this assertion pass on its own
    // documentation — a mutation replacing the real `ldd --version` pipeline with
    // `true` was measured to slip through exactly that way.
    const code = readFileSync(INSTALL_SH, 'utf-8')
      .split('\n')
      .filter(l => !/^\s*#/.test(l))
      .join('\n');
    // Each probe is independently load-bearing on some image shape; losing one
    // silently narrows detection.
    expect(code).toMatch(/ldd --version/);
    expect(code).toMatch(/ld-musl-/);
    expect(code).toMatch(/alpine-release/);
    // The suffix must only ever be ADDED when musl was observed.
    expect(code).toMatch(/is_musl.*-eq 1.*asset="\$\{asset\}-musl"/);
    // And the musl decision must come from grepping libc output, never a constant.
    expect(code).toMatch(/grep -qi musl/);
  });
});
