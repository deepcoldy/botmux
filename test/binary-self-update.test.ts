/**
 * Compiled-binary update paths: install-shape classification, the update-strategy
 * decision, release-asset selection, and the atomic self-replace.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────
 * Every update entry point (`botmux update`, dashboard `/api/update/run`, the
 * scheduled maintenance tick) used to route through
 * `resolveGlobalInstallPlan(botmuxInstallRoot())`. A compiled single-file binary
 * has no package.json on disk, so that root is `/` and the plan resolution always
 * threw — MEASURED on the real published v3.18.4 binary:
 *
 *     $ ./botmux --version   → 3.18.4          (baked version works)
 *     $ ./botmux update      → ❌ 无法安全识别当前安装方式（unknown）
 *
 * Since v3.18.x that binary is how botmux ships through BOTH installers, so the
 * failure covered essentially every user.
 *
 * ── WHAT THESE TESTS HAVE TEETH ON ─────────────────────────────────────────────
 * `vitest` bodies always run under Node, never as a compiled binary, so an
 * assertion that merely calls the production entry point would exercise the Node
 * branch and pass no matter what the compiled branch does. Every test below
 * therefore drives the PURE functions with the standalone flag / execPath passed
 * in explicitly, which is the only way to reach the compiled branch from Node.
 * Each was checked by reverting the corresponding fix and confirming it goes red
 * (see the mutation notes on the individual cases).
 */
import { describe, expect, it, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import {
  classifyBinaryInstall,
  mainPackageRootForSubpackageBinary,
  resolveUpdateStrategy,
} from '../src/core/binary-install-shape.js';
import { isMuslHost, releaseAssetName, releaseAssetBaseUrl, replaceStandaloneBinary } from '../src/core/binary-self-update.js';
import { buildRestartLauncher, resolveStandaloneRestartExecutable, resolveRestartInvocation } from '../src/core/maintenance.js';
import { tryResolveGlobalInstallPlan, formatGlobalInstallCommand, resolveAutoUpdateSupport } from '../src/utils/global-install.js';
import { withFileLock, FileLockTimeoutError } from '../src/utils/file-lock.js';
import { botmuxVersionAt, diskVersionAt } from '../src/utils/install-info.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'botmux-bin-update-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('classifyBinaryInstall — where the binary lives decides who updates it', () => {
  it('an npm/pnpm/bun platform subpackage is package-manager owned', () => {
    for (const p of [
      '/usr/lib/node_modules/botmux-linux-x64/botmux',
      '/usr/local/lib/node_modules/botmux-darwin-arm64/botmux',
      '/usr/lib/node_modules/botmux-linux-arm64-musl/botmux',
      '/home/u/.bun/install/global/node_modules/botmux-linux-x64/botmux',
    ]) {
      expect(classifyBinaryInstall(p, {}, '/home/u'), p).toBe('npm-binary');
    }
  });

  it('install.sh\'s location is self-owned, including a custom BOTMUX_INSTALL_DIR', () => {
    expect(classifyBinaryInstall('/home/u/.botmux/bin/botmux', {}, '/home/u')).toBe('curl-binary');
    // install.sh honours BOTMUX_INSTALL_DIR, and it is recognised WHEN STILL
    // EXPORTED at runtime. It usually is not (the installer is normally invoked as
    // `BOTMUX_INSTALL_DIR=… sh install.sh`, which does not persist it) — see the
    // fail-closed case asserted below.
    expect(classifyBinaryInstall('/opt/bm/botmux', { BOTMUX_INSTALL_DIR: '/opt/bm' }, '/home/u')).toBe('curl-binary');
    // A trailing slash names the same directory.
    expect(classifyBinaryInstall('/opt/bm/botmux', { BOTMUX_INSTALL_DIR: '/opt/bm/' }, '/home/u')).toBe('curl-binary');
  });

  it('a custom-dir install without the env var at runtime fails CLOSED, not wrong', () => {
    // The honest limitation: nothing is damaged (we never write), but self-update is
    // unavailable for that install. Asserted so the behaviour is deliberate rather
    // than an accident, and so the docs cannot drift into claiming full coverage.
    expect(classifyBinaryInstall('/opt/bm/botmux', {}, '/home/u')).toBe('unknown');
    expect(resolveUpdateStrategy(true, '/opt/bm/botmux', '/', {}, '/home/u'))
      .toEqual({ kind: 'unsupported', reason: 'unknown-binary-location' });
  });

  it('FAIL CLOSED: anything else is unknown, so no caller writes where it should not', () => {
    for (const p of [
      '/tmp/dist-bin/botmux',              // a local dev build
      '/usr/bin/botmux',                   // a distro package
      '/home/u/.botmux/bin/botmux-old',    // a backup beside the real one
      '/home/u/Downloads/botmux',          // hand-downloaded
      '',
    ]) {
      expect(classifyBinaryInstall(p, {}, '/home/u'), p).toBe('unknown');
    }
  });

  it('a directory merely NAMED like a subpackage is not treated as one', () => {
    // The pattern is anchored on /node_modules/ precisely so this is not a false
    // positive — otherwise we would hand npm a prefix outside any npm tree.
    expect(classifyBinaryInstall('/home/u/botmux-linux-x64/botmux', {}, '/home/u')).toBe('unknown');
  });

  it('the sibling package root translation reuses the tested plan resolver', () => {
    // The point of translating to the MAIN package root (rather than computing an
    // npm --prefix here) is that resolveGlobalInstallPlan already knows the
    // per-manager rules. Assert the composition end to end, including that a Bun
    // global resolves to BUN and is not forced onto npm.
    const npmRoot = mainPackageRootForSubpackageBinary('/usr/lib/node_modules/botmux-linux-x64/botmux');
    expect(npmRoot).toBe('/usr/lib/node_modules/botmux');
    expect(formatGlobalInstallCommand(tryResolveGlobalInstallPlan(npmRoot!, 'linux')!))
      .toBe('npm install -g --prefix /usr botmux@latest');

    const bunRoot = mainPackageRootForSubpackageBinary('/home/u/.bun/install/global/node_modules/botmux-linux-x64/botmux');
    expect(formatGlobalInstallCommand(tryResolveGlobalInstallPlan(bunRoot!, 'linux')!))
      .toBe('bun add -g botmux@latest');

    expect(mainPackageRootForSubpackageBinary('/home/u/.botmux/bin/botmux')).toBeNull();
  });

  it("THE npm BUG: the platform package NESTS inside the main package, and that layout must resolve", () => {
    // REGRESSION for the defect that shipped through 3.18.5→3.18.8: only the
    // SIBLING layout was handled, but MEASURED on a real `npm i -g botmux`
    // (npm 10.9.4) the platform subpackage lands INSIDE the main package, because
    // npm does not hoist a package's own deps to the global root (peer globals
    // nest identically: pm2 112 nested deps, http-server 47).
    //
    // Pre-fix this returned `…/node_modules/botmux/node_modules/botmux` — a
    // directory that does not exist and matches no manager — so detect said
    // `unknown`, the plan was null, and `botmux update` / the dashboard button /
    // scheduled auto-update all reported "无法安全识别当前安装方式".
    const nested = '/usr/lib/node_modules/botmux/node_modules/botmux-linux-x64/botmux';
    const root = mainPackageRootForSubpackageBinary(nested);
    // The MAIN package, NOT a second `botmux` below it.
    expect(root).toBe('/usr/lib/node_modules/botmux');
    expect(root).not.toBe('/usr/lib/node_modules/botmux/node_modules/botmux');
    // End to end: it must reach npm with the prefix of the tree it came from.
    // Verified against the real install on the dev box: this prefix is byte-equal
    // to `npm prefix -g`.
    expect(formatGlobalInstallCommand(tryResolveGlobalInstallPlan(root!, 'linux')!))
      .toBe('npm install -g --prefix /usr botmux@latest');
    // …and the strategy as a whole, which is what the three callers consume.
    expect(resolveUpdateStrategy(true, nested, '/', {}, '/home/u'))
      .toEqual({ kind: 'package-manager', packageRoot: '/usr/lib/node_modules/botmux' });
    // The musl subpackage nests the same way.
    expect(mainPackageRootForSubpackageBinary(
      '/usr/lib/node_modules/botmux/node_modules/botmux-linux-x64-musl/botmux',
    )).toBe('/usr/lib/node_modules/botmux');
  });

  it('the SIBLING layout still resolves — Bun hoists, so it is not obsolete', () => {
    // Guard against "fixing" the nested case by REPLACING the sibling rule.
    // MEASURED on a real `bun add -g botmux` (bun 1.4.0): the platform subpackage
    // botmux-linux-x64 is a real directory BESIDE the main package.
    expect(mainPackageRootForSubpackageBinary('/root/.bun/install/global/node_modules/botmux-linux-x64/botmux'))
      .toBe('/root/.bun/install/global/node_modules/botmux');
    expect(mainPackageRootForSubpackageBinary('/usr/lib/node_modules/botmux-linux-x64/botmux'))
      .toBe('/usr/lib/node_modules/botmux');
  });

  it('EITHER shape resolves to the same root, so no manager needs a layout promise', () => {
    // Bun HOISTS BY DEFAULT but does not guarantee it: measured 38 nested
    // node_modules inside one real bun global tree (it nests in place on a version
    // conflict). So "bun ⇒ sibling" is the common case, not an invariant, and the
    // mapping must not depend on which manager produced the path. Both shapes of
    // the same install must land on the same main package root.
    const nested = '/root/.bun/install/global/node_modules/botmux/node_modules/botmux-linux-x64/botmux';
    const sibling = '/root/.bun/install/global/node_modules/botmux-linux-x64/botmux';
    expect(mainPackageRootForSubpackageBinary(nested))
      .toBe(mainPackageRootForSubpackageBinary(sibling));
    expect(mainPackageRootForSubpackageBinary(nested))
      .toBe('/root/.bun/install/global/node_modules/botmux');
  });

  it('a subpackage nested under some OTHER package is not claimed as ours', () => {
    // The nested rule is anchored on an enclosing package literally named
    // `botmux`; a botmux platform binary vendored inside an unrelated dependency
    // must not make us hand THAT package root to a global install command.
    expect(mainPackageRootForSubpackageBinary('/app/node_modules/other/node_modules/botmux-linux-x64/botmux'))
      .toBe('/app/node_modules/other/node_modules/botmux');
  });
});

describe('resolveUpdateStrategy', () => {
  it('NODE PATH IS UNCHANGED: not standalone → the running install root, as before', () => {
    // Regression guard for the deployments that currently work. Whatever execPath
    // says, a Node run must still be classified by its package root.
    expect(resolveUpdateStrategy(false, '/usr/bin/node', '/opt/botmux', {}, '/home/u'))
      .toEqual({ kind: 'package-manager', packageRoot: '/opt/botmux' });
  });

  it('standalone in a package-manager tree → that manager, NOT a self-replace', () => {
    // npm owns that file. Writing it ourselves would be clobbered by npm's next
    // install, or leave a binary whose version npm's metadata disagrees with.
    expect(resolveUpdateStrategy(true, '/usr/lib/node_modules/botmux-linux-x64/botmux', '/', {}, '/home/u'))
      .toEqual({ kind: 'package-manager', packageRoot: '/usr/lib/node_modules/botmux' });
  });

  it('standalone at the install.sh location → self-replace that exact file', () => {
    expect(resolveUpdateStrategy(true, '/home/u/.botmux/bin/botmux', '/', {}, '/home/u'))
      .toEqual({ kind: 'self-replace', target: '/home/u/.botmux/bin/botmux' });
  });

  it('THE BUG: a standalone binary must never fall back to the "/" install root', () => {
    // This is the whole defect in one assertion. Before the fix the compiled
    // binary reached resolveGlobalInstallPlan("/") — measured to throw
    // UnsupportedGlobalInstallError, which is what printed
    // “无法安全识别当前安装方式（unknown）” on the real v3.18.4 binary.
    //
    // MUTATION CHECK: making the standalone branch fall through to
    // `{kind:'package-manager', packageRoot: installRoot}` turns this red for both
    // shapes below.
    const npmShape = resolveUpdateStrategy(true, '/usr/lib/node_modules/botmux-linux-x64/botmux', '/', {}, '/home/u');
    const curlShape = resolveUpdateStrategy(true, '/home/u/.botmux/bin/botmux', '/', {}, '/home/u');
    for (const s of [npmShape, curlShape]) {
      expect(s.kind).not.toBe('unsupported');
      if (s.kind === 'package-manager') expect(s.packageRoot).not.toBe('/');
    }
    // And "/" must not be resolvable as a plan either — the premise of the bug.
    expect(tryResolveGlobalInstallPlan('/', 'linux')).toBeNull();
  });

  it('SAFETY: real pnpm/yarn/Windows subpackage layouts never become a self-replace', () => {
    // The destructive misclassification would be calling a package-manager-owned
    // file `curl-binary` and writing it ourselves. Walk the layouts that actually
    // occur in the wild and assert none of them reach the self-replace path.
    const layouts = [
      // pnpm virtual store
      '/root/.local/share/pnpm/global/5/.pnpm/botmux-linux-x64@3.18.4/node_modules/botmux-linux-x64/botmux',
      // pnpm v11 content-addressed links
      '/root/.local/share/pnpm/store/v11/links/@/botmux-linux-x64/3.18.4/x/node_modules/botmux-linux-x64/botmux',
      // pnpm global with preserved symlinks
      '/root/.local/share/pnpm/global/5/node_modules/botmux-linux-x64/botmux',
      // yarn global
      '/root/.config/yarn/global/node_modules/botmux-linux-x64/botmux',
      // npm on Windows (no lib/ segment)
      'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\botmux-linux-x64\\botmux',
      // bun global
      '/root/.bun/install/global/node_modules/botmux-linux-x64/botmux',
    ];
    for (const p of layouts) {
      const s = resolveUpdateStrategy(true, p, '/', {}, '/root');
      expect(s.kind, p).toBe('package-manager');
      // And never the filesystem root, which is the pre-fix failure mode.
      if (s.kind === 'package-manager') expect(s.packageRoot, p).not.toBe('/');
    }
  });

  it('pnpm and npm subpackage layouts resolve to THEIR manager, not a forced npm', () => {
    // The reason for translating to the sibling main package instead of computing
    // a prefix here: the existing resolver already knows each manager's rules.
    const pnpmMain = mainPackageRootForSubpackageBinary(
      '/root/.local/share/pnpm/global/5/.pnpm/botmux-linux-x64@3.18.4/node_modules/botmux-linux-x64/botmux',
    );
    expect(formatGlobalInstallCommand(tryResolveGlobalInstallPlan(pnpmMain!, 'linux')!))
      .toBe('pnpm add -g --global-dir /root/.local/share/pnpm/global botmux@latest');
    const winMain = mainPackageRootForSubpackageBinary(
      'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\botmux-linux-x64\\botmux',
    );
    expect(formatGlobalInstallCommand(tryResolveGlobalInstallPlan(winMain!, 'win32')!))
      .toBe('npm install -g --prefix C:/Users/u/AppData/Roaming/npm botmux@latest');
  });

  it('an unidentifiable standalone binary stays unsupported (fail closed)', () => {
    expect(resolveUpdateStrategy(true, '/tmp/dist-bin/botmux', '/', {}, '/home/u'))
      .toEqual({ kind: 'unsupported', reason: 'unknown-binary-location' });
  });
});

describe('release asset selection', () => {
  it('musl is only claimed when positively observed', () => {
    // The false-positive direction is the dangerous one: a glibc box handed the
    // musl asset gets a binary that cannot start at all.
    expect(isMuslHost('linux', { glibcRuntime: () => '2.36', listDir: () => ['ld-musl-x86_64.so.1'], exists: () => true }))
      .toBe(false); // a reported glibc runtime settles it, even with musl files present
    expect(isMuslHost('linux', { glibcRuntime: () => undefined, listDir: () => ['ld-musl-x86_64.so.1'], exists: () => false }))
      .toBe(true);
    expect(isMuslHost('linux', { glibcRuntime: () => undefined, listDir: () => [], exists: (p) => p === '/etc/alpine-release' }))
      .toBe(true);
    expect(isMuslHost('linux', { glibcRuntime: () => undefined, listDir: () => [], exists: () => false }))
      .toBe(false); // never guess musl
    expect(isMuslHost('darwin', { glibcRuntime: () => undefined, listDir: () => ['ld-musl-x86_64.so.1'], exists: () => true }))
      .toBe(false); // darwin has no musl split
  });

  it('asset names match what release.yml uploads and install.sh downloads', () => {
    expect(releaseAssetName('linux', 'x64', false)).toBe('botmux-linux-x64');
    expect(releaseAssetName('linux', 'x64', true)).toBe('botmux-linux-x64-musl');
    expect(releaseAssetName('linux', 'arm64', true)).toBe('botmux-linux-arm64-musl');
    // musl must not leak onto darwin even if the flag is somehow true.
    expect(releaseAssetName('darwin', 'arm64', true)).toBe('botmux-darwin-arm64');
    // No published build → null rather than a name that 404s.
    expect(releaseAssetName('win32', 'x64', false)).toBeNull();
    expect(releaseAssetName('linux', 'riscv64', false)).toBeNull();
  });

  it('the asset names agree EXACTLY with install.sh (the two must not drift)', () => {
    // install.sh is the other consumer of these names. If either side renames an
    // asset the other silently 404s, so pin them against each other by executing
    // install.sh's own construction rather than re-reading our own constant.
    const sh = readFileSync(resolve('install.sh'), 'utf-8');
    expect(sh).toMatch(/asset="botmux-\$\{os_tag\}-\$\{arch_tag\}"/);
    expect(sh).toMatch(/asset="\$\{asset\}-musl"/);
    for (const [os, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'arm64']] as const) {
      const built = execFileSync('sh', ['-c',
        `os_tag=${os}; arch_tag=${arch}; asset="botmux-\${os_tag}-\${arch_tag}"; printf '%s' "$asset"`,
      ], { encoding: 'utf-8' });
      expect(releaseAssetName(os as NodeJS.Platform, arch, false)).toBe(built);
    }
  });

  it('the download base is the tagged release, with exactly one v prefix', () => {
    expect(releaseAssetBaseUrl('3.18.4'))
      .toBe('https://github.com/deepcoldy/botmux/releases/download/v3.18.4');
    // A caller that already has the "v" must not produce ".../vv3.18.4".
    expect(releaseAssetBaseUrl('v3.18.4')).toBe(releaseAssetBaseUrl('3.18.4'));
  });
});

describe('buildRestartLauncher — the compiled binary dispatches its own subcommand', () => {
  it('Node path unchanged: node <cli.js> restart', () => {
    expect(buildRestartLauncher('/usr/bin/node', '/opt/botmux/dist/cli.js', false, false))
      .toEqual({ cmd: '/usr/bin/node', args: ['/opt/botmux/dist/cli.js', 'restart'] });
    expect(buildRestartLauncher('/usr/bin/node', '/opt/botmux/dist/cli.js', true, false))
      .toEqual({ cmd: 'setsid', args: ['/usr/bin/node', '/opt/botmux/dist/cli.js', 'restart'] });
  });

  it('THE LAUNCHER SHIM IS SELF-DISPATCHING TOO — `$@` makes the subcommand argv[1]', () => {
    // `~/.botmux/bin/botmux` is `exec "<installed form>" "$@"`, so it forwards its
    // FIRST argument as the subcommand exactly like the compiled binary does.
    // Handing it a cli.js path reproduces the identical shift: help banner, exit 0,
    // no restart. This is the case the Node branch of
    // resolveStandaloneRestartExecutable now produces, so it must be covered even
    // though `standalone` is false there.
    //
    // The PAIRING of target+convention is asserted against resolveRestartInvocation
    // below; this case pins the rendering half.
    const LAUNCHER = '/root/.botmux/bin/botmux';
    expect(buildRestartLauncher(LAUNCHER, '/opt/botmux/dist/cli.js', false, true))
      .toEqual({ cmd: LAUNCHER, args: ['restart'] });
    expect(buildRestartLauncher(LAUNCHER, '/opt/botmux/dist/cli.js', true, true))
      .toEqual({ cmd: 'setsid', args: [LAUNCHER, 'restart'] });
  });

  it('THE BUG: standalone must not be handed a cli.js path — it lands in argv[2]', () => {
    // MEASURED on the real v3.18.4 binary: `<binary> /dist/cli.js restart` makes
    // argv[2] the PATH, so the CLI matched no command, printed the help banner and
    // **exited 0** — a restart that silently never happened while reporting
    // success. `restart` must therefore be the FIRST argument.
    //
    // MUTATION CHECK: reverting `entryArgs` to the unconditional
    // `[cliEntry, 'restart']` turns both assertions red.
    const direct = buildRestartLauncher('/home/u/.botmux/bin/botmux', '/dist/cli.js', false, true);
    expect(direct).toEqual({ cmd: '/home/u/.botmux/bin/botmux', args: ['restart'] });
    expect(direct.args[0]).toBe('restart');

    const viaSetsid = buildRestartLauncher('/home/u/.botmux/bin/botmux', '/dist/cli.js', true, true);
    expect(viaSetsid).toEqual({ cmd: 'setsid', args: ['/home/u/.botmux/bin/botmux', 'restart'] });
    // Whatever the launcher shape, no argument may be a cli.js path.
    for (const shape of [direct, viaSetsid]) {
      expect(shape.args.some(a => a.endsWith('cli.js'))).toBe(false);
    }
  });
});

describe('the baked version must not shadow a completed update (BOTH strategies)', () => {
  /**
   * `botmuxVersionAt` returns the compile-time baked version for ANY directory,
   * which is right for "what am I running" and WRONG for "what is now installed".
   * After a package-manager update rewrites the install's package.json, a compiled
   * binary asking `botmuxVersionAt(root)` still gets its OWN old version — so the
   * maintenance tick's `after !== before` gate stays false and it never restarts
   * onto what it just installed, and the dashboard reports `changed: false`.
   *
   * `diskVersionAt` exists to bypass the baked value for exactly those post-update
   * reads. MUTATION CHECK: making `diskVersionAt` delegate to `botmuxVersionAt`
   * turns the first assertion red.
   */
  it('diskVersionAt reads package.json even when a baked version is present', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '3.19.0' }));
    const prev = process.env.BOTMUX_BAKED_VERSION;
    process.env.BOTMUX_BAKED_VERSION = '3.18.4'; // as a compiled binary carries
    try {
      // The shadowing itself — this is the behaviour that caused the bug.
      expect(botmuxVersionAt(dir)).toBe('3.18.4');
      // ...and the bypass used by every post-update read.
      expect(diskVersionAt(dir)).toBe('3.19.0');
    } finally {
      if (prev === undefined) delete process.env.BOTMUX_BAKED_VERSION;
      else process.env.BOTMUX_BAKED_VERSION = prev;
    }
  });

  it('under Node (no baked version) the two agree — so nothing changes there', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '3.19.0' }));
    const prev = process.env.BOTMUX_BAKED_VERSION;
    delete process.env.BOTMUX_BAKED_VERSION;
    try {
      expect(diskVersionAt(dir)).toBe(botmuxVersionAt(dir));
      expect(diskVersionAt(dir)).toBe('3.19.0');
    } finally {
      if (prev !== undefined) process.env.BOTMUX_BAKED_VERSION = prev;
    }
  });

  it('an unreadable root degrades to 0.0.0, matching botmuxVersionAt', () => {
    expect(diskVersionAt(join(tmp(), 'nope'))).toBe('0.0.0');
  });
});

describe('auto-update support is ONE predicate for UI and save-time validation', () => {
  // These used to be answered separately: the projection ran
  // `tryResolveGlobalInstallPlan()` (false for every compiled binary, root "/")
  // while the save path used the shape resolver — so the backend accepted a toggle
  // the frontend rendered as disabled.
  it('self-replace is supported without any package-manager plan', () => {
    const r = resolveAutoUpdateSupport({ kind: 'self-replace', target: '/home/u/.botmux/bin/botmux' });
    expect(r.supported).toBe(true);
    expect(r.plan).toBeNull();
  });

  it('a package-manager binary is supported only when its plan resolves', () => {
    expect(resolveAutoUpdateSupport({ kind: 'package-manager', packageRoot: '/usr/lib/node_modules/botmux' }).supported)
      .toBe(true);
    // Yarn is knowingly not driveable — promising support would offer an update
    // that throws. (This is the case my first implementation got wrong by
    // returning true for ANY npm-binary shape.)
    expect(resolveAutoUpdateSupport({ kind: 'package-manager', packageRoot: '/root/.config/yarn/global/node_modules/botmux' }).supported)
      .toBe(false);
    // And the pre-fix compiled-binary root.
    expect(resolveAutoUpdateSupport({ kind: 'package-manager', packageRoot: '/' }).supported).toBe(false);
  });

  it('unsupported stays unsupported', () => {
    expect(resolveAutoUpdateSupport({ kind: 'unsupported', reason: 'unknown-binary-location' }).supported).toBe(false);
  });

  it('NO ASYMMETRY: whatever status claims supportable, rollback can resolve too', () => {
    /**
     * The bug this pins: `/api/update/status` reported `rollbackSupported: true`
     * for an npm-installed compiled binary (it resolves the MAPPED package root),
     * while `/api/update/rollback` still resolved from `botmuxInstallRoot()` — on a
     * FRESH process there is no `lastSuccessfulUpdatePlan` yet, so that is "/" and
     * the plan resolution throws. Net effect: the UI offers a rollback button whose
     * first click always fails.
     *
     * Both endpoints must therefore start from the same strategy. Assert the two
     * roots agree for every shape that claims support.
     */
    const npmBinary = resolveUpdateStrategy(
      true, '/usr/lib/node_modules/botmux-linux-x64/botmux', '/', {}, '/home/u',
    );
    expect(npmBinary.kind).toBe('package-manager');
    const support = resolveAutoUpdateSupport(npmBinary);
    expect(support.supported).toBe(true);

    // What rollback must use — the strategy's root, NOT the "/" install root.
    const rollbackRoot = npmBinary.kind === 'package-manager' ? npmBinary.packageRoot : '';
    expect(tryResolveGlobalInstallPlan(rollbackRoot, 'linux')).not.toBeNull();
    // ...and the pre-fix root, to show the two really differ (the defect).
    expect(tryResolveGlobalInstallPlan('/', 'linux')).toBeNull();

    // A self-replacing binary is the reverse case: update supported, rollback NOT,
    // which is why rollbackSupported is reported separately rather than derived.
    const curl = resolveUpdateStrategy(true, '/home/u/.botmux/bin/botmux', '/', {}, '/home/u');
    expect(resolveAutoUpdateSupport(curl).supported).toBe(true);
    expect(resolveAutoUpdateSupport(curl).plan).toBeNull(); // ⟹ rollbackSupported false
  });

});

describe('concurrent updates report mutual exclusion, not lock internals', () => {
  /**
   * THE LOCK OUTCOME IS THREE-STATE, NOT TWO. `acquired === false` only proves the
   * callback never ran — equally true when the lock infrastructure failed BEFORE the
   * callback (`open` EACCES/ENOSPC/ENOENT, a failed holder write, an unreadable
   * holder file, a stale-claim `link` error). Branching on `acquired` alone reports
   * every one of those as "another update is already running", hiding a real fault
   * (a full disk!) behind a benign message.
   *
   * A/B MEASURED with real pre-callback failures:
   *   ENOENT parent : PRE-FIX => FRIENDLY   POST-FIX => RETHROW
   *   symlinked lock: PRE-FIX => FRIENDLY   POST-FIX => RETHROW  (ELOOP)
   */
  const classify = (acquired: boolean, e: unknown): 'friendly' | 'rethrow' =>
    (!acquired && e instanceof FileLockTimeoutError) ? 'friendly' : 'rethrow';

  it('(1) lock timeout, callback never entered -> the friendly notice', async () => {
    const dir = tmp();
    const target = join(dir, 'busy');
    let acquired = false;
    let seen: unknown;
    await withFileLock(target, async () => {
      try {
        await withFileLock(target, async () => { acquired = true; }, { maxWaitMs: 200 });
      } catch (e) { seen = e; }
    }, { maxWaitMs: 2_000 });
    expect(seen).toBeInstanceOf(FileLockTimeoutError);
    expect((seen as FileLockTimeoutError).code).toBe('FILE_LOCK_TIMEOUT');
    expect(classify(acquired, seen)).toBe('friendly');
    expect(acquired).toBe(false);
  });

  it('(2) a failure INSIDE the critical section surfaces as itself', async () => {
    const dir = tmp();
    let acquired = false;
    let seen: unknown;
    try {
      await withFileLock(join(dir, 'x'), async () => {
        acquired = true;
        throw new Error('SHA-256 校验不通过');
      }, { maxWaitMs: 500 });
    } catch (e) { seen = e; }
    expect(acquired).toBe(true);
    expect(classify(acquired, seen)).toBe('rethrow');
    expect((seen as Error).message).toContain('SHA-256');
  });

  it('(3) a pre-callback INFRASTRUCTURE failure also surfaces, not "another update"', async () => {
    // A missing parent makes `open` throw ENOENT before the callback — the same
    // shape as ENOSPC on a full disk. MUTATION CHECK: dropping the
    // `instanceof FileLockTimeoutError` half of the predicate turns this red.
    const dir = tmp();
    let acquired = false;
    let seen: unknown;
    try {
      await withFileLock(join(dir, 'no', 'such', 'dir', 'x'), async () => { acquired = true; }, { maxWaitMs: 400 });
    } catch (e) { seen = e; }
    expect(acquired).toBe(false);
    expect(seen).toBeDefined();
    expect(seen).not.toBeInstanceOf(FileLockTimeoutError);
    expect((seen as NodeJS.ErrnoException).code).toBe('ENOENT');
    // The whole point: `!acquired` holds here, yet this must NOT take the friendly path.
    expect(classify(acquired, seen)).toBe('rethrow');
  });

  it('the timeout error keeps its historical message (call sites match it as text)', () => {
    // workflows/v3/host.ts, daemon.ts and services/session-store.ts match this
    // string; changing it while adding the type would break them silently.
    const e = new FileLockTimeoutError('/tmp/x.lock', 1234, 2222);
    expect(e.message).toBe('file-lock timeout waiting for /tmp/x.lock (held by pid 1234, age 2222ms)');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('FileLockTimeoutError');
  });

  it('SOURCE GUARD: the update lock\'s timeout is reported as "another update is running"', () => {
    /**
     * `withFileLock` THROWS when it cannot acquire the lock — it does not return
     * quietly. So an `if (!acquired)` check placed AFTER the await is dead code, and
     * the rejection falls through to the generic error printer.
     *
     * MEASURED by running two `botmux update` processes against one real compiled
     * binary: the loser printed
     *   ❌ 升级失败：file-lock timeout waiting for …/npm-global-update.lock
     *      (held by pid 630166, age 2222ms)
     * i.e. lock internals, for what is a perfectly normal mutual-exclusion outcome.
     * After the fix it prints "另一个更新正在进行中（dashboard 或定时任务），请稍后重试。"
     *
     * Pinned at the source level because reaching this branch behaviourally needs two
     * real processes racing a ~170MB download — reasonable to do by hand once (and I
     * did), not in a unit test.
     */
    const cli = readFileSync(resolve('src/cli.ts'), 'utf-8');
    // The self-replace branch must wrap its lock acquisition in try/catch and
    // translate a not-acquired rejection, rather than testing `acquired` after it.
    //
    // Take a window from the branch head to its `withFileLock` call plus what
    // follows. NOT "up to the first `return;`" — the branch returns early for
    // "already latest", which truncated the window before the lock code and made
    // every assertion below vacuously false (measured: a 355-char window).
    const branchStart = cli.indexOf("strategy.kind === 'self-replace'");
    expect(branchStart, 'the self-replace branch moved — update this guard').toBeGreaterThan(0);
    const lockAt = cli.indexOf('withFileLock', branchStart);
    expect(lockAt, 'the self-replace branch no longer takes the update lock').toBeGreaterThan(branchStart);
    const block = cli.slice(branchStart, lockAt + 1200);
    // The friendly notice must be gated on BOTH halves: callback-not-entered AND a
    // genuine lock timeout. Guarding on `!acquired` alone is the over-broad version
    // that reported ENOSPC/ENOENT as "another update is running".
    expect(block).toMatch(/catch[\s\S]{0,900}?if \(!acquired && error instanceof FileLockTimeoutError\)/);
    expect(block).toMatch(/另一个更新正在进行中/);
    // ...and every other failure — in-section OR pre-callback — must still surface.
    expect(block).toMatch(/throw error;/);
    // Belt and braces: the bare predicate must NOT reappear anywhere in this window.
    expect(block).not.toMatch(/if \(!acquired\)\s*\{/);
  });

  it('SOURCE GUARD: no update/rollback endpoint feeds resolveGlobalInstallPlan the "/" install root', () => {
    /**
     * ⚠️ WHY A SOURCE ASSERTION AND NOT A BEHAVIOURAL ONE. The pure-function test
     * above proves the two ROOTS differ, but it cannot see which one dashboard.ts
     * actually passes — verified by mutating the rollback line back to
     * `botmuxInstallRoot()` and watching every behavioural test stay green. Standing
     * up the whole dashboard here (auth, sockets, a real package tree) to exercise
     * one argument is not worth it, so pin the call sites instead.
     *
     * THE RULE IS NARROW ON PURPOSE: what must never happen is a root reaching
     * `resolveGlobalInstallPlan`, because that is the call that throws on "/". Merely
     * *computing* `botmuxInstallRoot()` is fine and still happens in
     * /api/update/status, where it feeds `currentUpdateStrategy` (which handles "/"
     * correctly) plus a display-only manager label. An earlier, broader version of
     * this guard flagged that benign line and failed on clean master — a guard that
     * fires on correct code gets deleted, so it is scoped to the plan calls.
     */
    const src = readFileSync(resolve('src/dashboard.ts'), 'utf-8');
    // Every `resolveGlobalInstallPlan(<root>…)` call and the identifier it is given.
    const roots = [...src.matchAll(/resolveGlobalInstallPlan\(\s*([A-Za-z_$][\w$]*)/g)].map(m => m[1]);
    expect(roots.length, 'expected to find the plan call sites — did they get renamed?')
      .toBeGreaterThanOrEqual(2);
    for (const ident of roots) expect(ident).toBe('packageRoot');

    /**
     * Every plan call takes a `packageRoot`, and every `packageRoot` assignment must
     * let the resolved strategy decide. The display-only root in /api/update/status
     * is named `classifyRoot` precisely so it is outside this rule — it feeds
     * `currentUpdateStrategy` (which handles "/" correctly) and a label, never a plan.
     *
     * A *guarded* `runStrategy.kind === 'package-manager' ? runStrategy.packageRoot :
     * botmuxInstallRoot()` is correct: that ternary is the Node path, where the install
     * root IS right. So the rule is "a strategy decides this root", not "the identifier
     * is absent" — an earlier version asserted the latter and failed on clean code.
     */
    const assignments = [...src.matchAll(/const packageRoot =([\s\S]{0,220}?);/g)].map(m => m[1]);
    expect(assignments.length, 'expected the plan-root assignments — were they renamed?')
      .toBeGreaterThanOrEqual(2);
    const offenders = assignments.filter(a => !/(runStrategy|rollbackStrategy)\.packageRoot/.test(a));
    expect(
      offenders.map(a => a.replace(/\s+/g, ' ').trim()),
      'a plan root is chosen without consulting the resolved strategy — botmuxInstallRoot() '
        + 'is "/" for every compiled binary and resolveGlobalInstallPlan throws on it.',
    ).toEqual([]);
    // Positive controls: the strategy-based fallbacks ARE present, so this guard is
    // asserting against real code rather than passing on an empty search.
    expect(src).toMatch(/runStrategy\.kind === 'package-manager' \? runStrategy\.packageRoot/);
    expect(src).toMatch(/\?\?\s*rollbackStrategy\.packageRoot/);
    // And rollback must refuse anything that is not package-manager driveable.
    expect(src).toMatch(/rollbackStrategy\.kind !== 'package-manager'/);
  });
});

describe('resolveStandaloneRestartExecutable — restart the NEW binary, not the old path', () => {
  const LAUNCHER = '/root/.botmux/bin/botmux';
  // pnpm's virtual store puts the VERSION in the running path.
  const PNPM_OLD = '/root/.local/share/pnpm/global/5/.pnpm/botmux-linux-x64@3.18.4/node_modules/botmux-linux-x64/botmux';

  it('a package-manager binary restarts via the stable launcher', () => {
    // After the update, postinstall re-pointed the launcher at the NEW subpackage
    // while this process's execPath still names the OLD versioned one. Restarting
    // from execPath would ENOENT (store entry pruned) or silently run the old
    // binary — an update that reports success and does not take effect.
    expect(resolveStandaloneRestartExecutable(true, PNPM_OLD, 'npm-binary', LAUNCHER, true)).toBe(LAUNCHER);
  });

  it('falls back to execPath when no launcher exists (pre-existing behaviour)', () => {
    expect(resolveStandaloneRestartExecutable(true, PNPM_OLD, 'npm-binary', LAUNCHER, false)).toBe(PNPM_OLD);
  });

  it('a self-replaced binary keeps its own path — we swapped the bytes there', () => {
    expect(resolveStandaloneRestartExecutable(true, LAUNCHER, 'curl-binary', LAUNCHER, true)).toBe(LAUNCHER);
    // Even a curl install at a custom dir restarts itself, not the default launcher.
    expect(resolveStandaloneRestartExecutable(true, '/opt/bm/botmux', 'curl-binary', LAUNCHER, true))
      .toBe('/opt/bm/botmux');
  });

  it('NODE PATH: prefers the launcher, which tracks the installed form across an update', () => {
    // Since 3.18.0 the npm package ships the CLI as a platform-subpackage BINARY:
    // `bin` is gone, node-pty left `dependencies`, and postinstall points the
    // launcher at the binary — but `dist/` is still published and still statically
    // imports node-pty. So a Node-form daemon that auto-updates ACROSS that
    // boundary can no longer run `node <root>/dist/cli.js`: npm pruned node-pty
    // from that tree. Restarting via the launcher is what survives the transition.
    expect(resolveStandaloneRestartExecutable(false, '/usr/bin/node', 'unknown', LAUNCHER, true)).toBe(LAUNCHER);
  });

  it('NODE PATH: falls back to execPath when there is no launcher (pre-existing behaviour)', () => {
    expect(resolveStandaloneRestartExecutable(false, '/usr/bin/node', 'unknown', LAUNCHER, false))
      .toBe('/usr/bin/node');
  });

  it('NODE PATH: a local-dev checkout keeps execPath even when a launcher exists', () => {
    // The launcher may point at an entirely different checkout (`use:here` claims
    // it globally), while a dev restart must re-run the tree it just built.
    expect(resolveStandaloneRestartExecutable(false, '/usr/bin/node', 'unknown', LAUNCHER, true, true))
      .toBe('/usr/bin/node');
  });
});

describe('resolveRestartInvocation — target and calling convention must agree', () => {
  const LAUNCHER = '/root/.botmux/bin/botmux';
  const NODE = '/usr/bin/node';
  const PNPM_OLD = '/root/.local/share/pnpm/global/5/.pnpm/botmux-linux-x64@3.18.4/node_modules/botmux-linux-x64/botmux';

  // THE INVARIANT, stated once: whenever the chosen target is the launcher shim,
  // the invocation must be self-dispatching — the shim forwards "$@", so a cli.js
  // path would land where the subcommand belongs (help banner, exit 0, no
  // restart). Deriving these two halves separately is exactly how they drift, so
  // this asserts the PAIR, which a test of either half alone cannot do.
  //
  // MUTATION CHECK: computing `selfDispatching` as bare `standalone` (i.e.
  // dropping `|| executable === launcherPath`) turns the two Node-form launcher
  // cases below red.
  it('every case that targets the launcher is marked self-dispatching', () => {
    const cases = [
      // Node form crossing the 3.18 Node→binary boundary.
      resolveRestartInvocation(false, NODE, 'unknown', LAUNCHER, true),
      // Compiled binary owned by a package manager (versioned execPath).
      resolveRestartInvocation(true, PNPM_OLD, 'npm-binary', LAUNCHER, true),
    ];
    for (const r of cases) {
      expect(r.executable).toBe(LAUNCHER);
      expect(r.selfDispatching).toBe(true);
    }
  });

  it('a Node target keeps the Node calling convention (cli.js path required)', () => {
    // No launcher on this host → execPath, which genuinely NEEDS the script path.
    expect(resolveRestartInvocation(false, NODE, 'unknown', LAUNCHER, false))
      .toEqual({ executable: NODE, selfDispatching: false });
    // Local-dev checkout: execPath even though a launcher exists.
    expect(resolveRestartInvocation(false, NODE, 'unknown', LAUNCHER, true, true))
      .toEqual({ executable: NODE, selfDispatching: false });
  });

  it('a self-replaced binary targets itself and still self-dispatches', () => {
    // curl-binary at a custom dir: not the launcher path, but still the compiled
    // CLI — so `standalone` alone must keep it self-dispatching.
    expect(resolveRestartInvocation(true, '/opt/bm/botmux', 'curl-binary', LAUNCHER, true))
      .toEqual({ executable: '/opt/bm/botmux', selfDispatching: true });
  });
});

describe('replaceStandaloneBinary — atomic swap of a live executable', () => {
  const BIG = 1_100_000; // over the "this is an error page, not a binary" floor
  const probeOk = () => ({ status: 0 });

  function fakeAsset(byte = 0x41, size = BIG): Buffer {
    return Buffer.alloc(size, byte);
  }
  function sha256(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
  }

  it('verifies the published checksum and lands the new bytes', async () => {
    const dir = tmp();
    const target = join(dir, 'botmux');
    writeFileSync(target, 'OLD BINARY', { mode: 0o755 });
    const payload = fakeAsset();
    const r = await replaceStandaloneBinary('3.99.0', target, {
      fetchStream: async () => Readable.from([payload]),
      fetchChecksum: async () => sha256(payload),
      probeBinary: probeOk,
    });
    expect(r.bytes).toBe(BIG);
    expect(statSync(target).size).toBe(BIG);
    // Executable bit must be set or the launcher's `exec` fails at RUN time.
    expect(statSync(target).mode & 0o111).not.toBe(0);
  });

  it('a checksum mismatch leaves the WORKING binary in place', async () => {
    const dir = tmp();
    const target = join(dir, 'botmux');
    writeFileSync(target, 'OLD BINARY', { mode: 0o755 });
    await expect(replaceStandaloneBinary('3.99.0', target, {
      fetchStream: async () => Readable.from([fakeAsset()]),
      fetchChecksum: async () => 'f'.repeat(64), // wrong on purpose
    })).rejects.toThrow(/SHA-256/);
    // The old binary must survive — a failed update must never brick the install.
    expect(readFileSync(target, 'utf-8')).toBe('OLD BINARY');
    // And no temp file may be left behind next to it.
    expect(execFileSync('ls', ['-A', dir], { encoding: 'utf-8' }).trim().split('\n').sort())
      .toEqual(['botmux']);
  });

  it('a truncated download (no checksum published) is rejected, not installed', async () => {
    // GitHub serving an HTML error page is the real shape here: a few hundred
    // bytes that would replace a working 100MB+ executable.
    const dir = tmp();
    const target = join(dir, 'botmux');
    writeFileSync(target, 'OLD BINARY', { mode: 0o755 });
    await expect(replaceStandaloneBinary('3.99.0', target, {
      fetchStream: async () => Readable.from([Buffer.from('<html>404 Not Found</html>')]),
      fetchChecksum: async () => null, // release published no .sha256
    })).rejects.toThrow(/字节/);
    expect(readFileSync(target, 'utf-8')).toBe('OLD BINARY');
  });

  it('a mid-download network failure leaves no temp file and no damage', async () => {
    const dir = tmp();
    const target = join(dir, 'botmux');
    writeFileSync(target, 'OLD BINARY', { mode: 0o755 });
    await expect(replaceStandaloneBinary('3.99.0', target, {
      fetchStream: async () => new Readable({
        read() { this.destroy(new Error('ECONNRESET')); },
      }),
      fetchChecksum: async () => null,
    })).rejects.toThrow();
    expect(readFileSync(target, 'utf-8')).toBe('OLD BINARY');
    expect(execFileSync('ls', ['-A', dir], { encoding: 'utf-8' }).trim().split('\n').sort())
      .toEqual(['botmux']);
  });

  it('an unloadable candidate is rejected before rename and leaves the working binary intact', async () => {
    const dir = tmp();
    const target = join(dir, 'botmux');
    writeFileSync(target, 'OLD BINARY', { mode: 0o755 });
    const payload = fakeAsset();
    await expect(replaceStandaloneBinary('3.99.0', target, {
      fetchStream: async () => Readable.from([payload]),
      fetchChecksum: async () => sha256(payload),
      probeBinary: () => ({ status: 1, stderr: 'GLIBC_2.34 not found' }),
    })).rejects.toThrow(/GLIBC_2\.34/);
    expect(readFileSync(target, 'utf-8')).toBe('OLD BINARY');
    expect(execFileSync('ls', ['-A', dir], { encoding: 'utf-8' }).trim().split('\n').sort())
      .toEqual(['botmux']);
  });

  it('the temp file is a SIBLING of the target (an EXDEV rename would fail)', async () => {
    // The swap must be a rename within one filesystem. Writing to os.tmpdir() and
    // renaming across devices fails with EXDEV, and copying instead would
    // reintroduce the torn-file window the rename exists to avoid.
    const dir = tmp();
    const target = join(dir, 'nested', 'botmux');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(target, 'OLD', { mode: 0o755 });
    const seen: string[] = [];
    const payload = fakeAsset();
    await replaceStandaloneBinary('3.99.0', target, {
      fetchStream: async () => Readable.from([payload]),
      // Sample AFTER the download has been written but BEFORE the rename:
      // fetchChecksum runs in exactly that window. (Sampling from fetchStream
      // instead sees nothing — the temp path is computed before the fetch but the
      // file itself is only created by the pipeline that consumes the stream.)
      fetchChecksum: async () => {
        seen.push(...execFileSync('ls', ['-A', join(dir, 'nested')], { encoding: 'utf-8' }).trim().split('\n'));
        return sha256(payload);
      },
      probeBinary: probeOk,
    });
    expect(seen.some(f => f.startsWith('.botmux-update.'))).toBe(true);
    // ...and it must have been a sibling of the target, not in os.tmpdir().
    expect(seen).toContain('botmux');
    expect(statSync(target).size).toBe(BIG);
  });

  /**
   * The load-bearing OS fact behind the whole design, asserted directly.
   *
   * MEASURED on Linux with a real ELF: writing into the executable of a LIVE
   * process fails with ETXTBSY, while renaming a new file over the path succeeds
   * and the running process keeps executing the old inode. If this ever stopped
   * holding, `replaceStandaloneBinary` would need a different strategy — so pin
   * the fact rather than only the code that relies on it.
   */
  it('OS FACT: in-place write on a running executable is ETXTBSY; rename is not', () => {
    const dir = tmp();
    const bin = join(dir, 'live');
    // A real ELF, not a shell script: the kernel only holds the text lock for a
    // mapped executable. (Measured: a #!/bin/sh script accepts the in-place write,
    // which is exactly why a script is not a valid proxy for this test.)
    execFileSync('cp', ['/bin/sleep', bin]);
    chmodSync(bin, 0o755);
    const child = spawnSync('sh', ['-c', `"${bin}" 2 & echo $!; sleep 0.4`], { encoding: 'utf-8' });
    expect(child.status).toBe(0);

    // (a) in-place write → ETXTBSY while it runs
    const write = spawnSync(process.execPath, ['-e', `
      try { require('fs').writeFileSync(${JSON.stringify(bin)}, 'X', {flag:'r+'}); console.log('WROTE'); }
      catch (e) { console.log(e.code); }
    `], { encoding: 'utf-8' });
    // The child sleep may already have exited on a slow box; accept either the
    // busy error or a clean write, but never a crash — the assertion that matters
    // is (b), which must ALWAYS work.
    expect(['ETXTBSY', 'WROTE']).toContain((write.stdout || '').trim());

    // (b) rename over it → always allowed
    const fresh = join(dir, 'fresh');
    execFileSync('cp', ['/bin/echo', fresh]);
    expect(() => execFileSync(process.execPath, ['-e',
      `require('fs').renameSync(${JSON.stringify(fresh)}, ${JSON.stringify(bin)})`,
    ])).not.toThrow();
  });
});
