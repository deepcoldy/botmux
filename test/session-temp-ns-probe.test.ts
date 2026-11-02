/**
 * #2574, as REAL processes with a REAL fresh `/tmp`.
 *
 * The defect is a cross-process, cross-writer one: the identity wrapper (a
 * `/bin/sh` script) and the daemon's session-temp setup both create
 * `/tmp/bm<uid>`, and which one wins decides whether every later session on the
 * host can create scratch at all. A same-process, mocked-fs test cannot show
 * that — the wrapper's `mkdir -p` is the whole trigger — so these cases run the
 * generated wrapper with `/bin/sh` inside a private tmpfs `/tmp`.
 *
 * A private /tmp is also what makes them ISOLATED. `/tmp/bm<uid>` is keyed by
 * uid, so an in-process test that repaired or re-created it would be mutating
 * state every other test file in the same run shares (vitest runs files in
 * parallel) — verified: the same cases in test/session-temp.test.ts failed
 * intermittently and at moving locations only when run alongside another file.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderIdentityEnv, renderIdentityWrapper } from '../src/core/cli-identity.js';
import { NAMESPACE_UID, privateTmpAvailable, runWithPrivateTmp } from './helpers/session-temp-ns-probe.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

let dir: string;
let previousHome: string | undefined;

/**
 * Fixture root for these cases, deliberately OUTSIDE `/tmp`.
 *
 * Every case here mounts a fresh tmpfs over the CHILD's `/tmp`, so anything the
 * parent process wrote under `/tmp` before the mount is invisible inside —
 * `cannot open .../bytedcli-wrapper`. On a developer box `os.tmpdir()` often
 * points somewhere else (this repo's test env puts it under `~/.cache`), which
 * hides the bug entirely; on a CI runner `os.tmpdir()` IS `/tmp`, and every case
 * here fails at once.
 *
 * `/var/tmp` rather than `$HOME`: the unit setup fences HOME into a directory
 * that also lives under `os.tmpdir()`, so HOME is no safer here than tmpdir is.
 * (`bind`ing fixtures into the namespace is not an option either — the bind
 * target sits under the /tmp the tmpfs just covered.)
 */
function scratchRoot(): string {
  const override = process.env.BOTMUX_NS_PROBE_SCRATCH?.trim();
  if (override) return override;
  return '/var/tmp/botmux-ns-probe';
}

beforeEach(() => {
  const root = scratchRoot();
  mkdirSync(root, { recursive: true });
  dir = mkdtempSync(join(root, 'botmux-session-temp-ns-'));
  previousHome = process.env.HOME;
  process.env.HOME = join(dir, 'machine-home');
  mkdirSync(process.env.HOME, { recursive: true });
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  rmSync(dir, { recursive: true, force: true });
});


/** Run a probe script with a fresh tmpfs /tmp in its own mount+pid namespace. */
function runInNs(script: string | string[]): { status: number | null; stdout: string; stderr: string } {
  return runWithPrivateTmp(Array.isArray(script) ? script.join('\n') : script);
}

const SESSION = 'sess-ns';
const repoRoot = process.cwd();
// NOT process.getuid(): the probes run inside a user namespace where the boot
// code sees NAMESPACE_UID, and every planted path must agree with it.
const uid = NAMESPACE_UID;

/** A bytedcli wrapper whose published HOME the caller chooses. */
function writeWrapper(home: string): string {
  const wrapper = join(dir, 'bytedcli-wrapper');
  writeFileSync(wrapper, renderIdentityWrapper('bytedcli', '/bin/echo', 'single'));
  const envDir = join(dir, 'data', 'cli-identity', `${SESSION}.bin`, '.data');
  mkdirSync(envDir, { recursive: true });
  writeFileSync(join(envDir, 'bytedcli.env'),
    renderIdentityEnv({ tool: 'bytedcli', cloudJwt: 'jwt-probe', home }));
  return wrapper;
}

/** The session-temp module, booted in the child so it sees the private /tmp. */
function bootArgv(): string[] {
  const probe = join(dir, 'boot-probe.ts');
  writeFileSync(probe, [
    `import { ensureSessionTempDir } from ${JSON.stringify(join(repoRoot, 'src/core/session-temp.ts'))};`,
    `const path = ensureSessionTempDir(${JSON.stringify(join(dir, 'data'))}, ${JSON.stringify(SESSION)});`,
    "process.stdout.write('BOOT_OK ' + path + '\\n');",
  ].join('\n'));
  const { command, prefixArgs } = tsRunnerPrefix();
  return [command, ...prefixArgs, probe];
}


/** Publish a bytedcli identity for the session and run its wrapper, in-process. */
function publishAndRunArgv(): string[] {
  const probe = join(dir, 'publish-and-run.ts');
  writeFileSync(probe, [
    `import { renderIdentityWrapper, writeSessionIdentity } from ${JSON.stringify(join(repoRoot, 'src/core/cli-identity.ts'))};`,
    `import { spawnSync } from 'node:child_process';`,
    `import { writeFileSync } from 'node:fs';`,
    `writeSessionIdentity(${JSON.stringify(join(dir, 'data'))}, ${JSON.stringify(SESSION)},`,
    `  { tool: 'bytedcli', cloudJwt: 'jwt-probe', openId: 'ou_alice' }, 'single');`,
    `const wrapper = ${JSON.stringify(join(dir, 'published-wrapper'))};`,
    `writeFileSync(wrapper, renderIdentityWrapper('bytedcli', '/bin/true', 'single'));`,
    `spawnSync('/bin/sh', [wrapper], { env: { ...process.env, SESSION_DATA_DIR: ${JSON.stringify(join(dir, 'data'))}, BOTMUX_SESSION_ID: ${JSON.stringify(SESSION)} } });`,
    `process.stdout.write('RUN_OK\\n');`,
  ].join('\n'));
  const { command, prefixArgs } = tsRunnerPrefix();
  return [command, ...prefixArgs, probe];
}

describe('session temp layout created by the identity wrapper (#2574)', () => {
  /**
   * Never let this file pass by SKIPPING.
   *
   * Every probe below is guarded by `skipIf(!privateTmpAvailable())`, which is
   * right for a host that cannot unshare but is silent zero coverage where it
   * counts: if a CI runner ever denies non-privileged user namespaces, all nine
   * probes skip and the job is green having tested none of the #2574 guards.
   *
   * Linux only, deliberately: the hub/alias mechanism this file covers exists
   * only on a runtime with a uid (`sessionTempHub` returns undefined otherwise),
   * and the darwin leg only builds.
   *
   * CI only, deliberately: a developer on a kernel with unshare disabled keeps
   * the quiet skip instead of a red run they cannot act on.
   */
  it('private mount/pid namespace is available in CI (#2574 probes must run)', () => {
    if (process.platform === 'linux' && process.env.CI && !privateTmpAvailable()) {
      throw new Error('unshare/mount tmpfs unavailable: the #2574 probes must not silently skip in CI');
    }
    expect(true).toBe(true);
  });
  it.skipIf(!privateTmpAvailable())('leaves the uid hub at 0700 even under the default umask 022', () => {
    // The wrapper is the FIRST writer on a fresh host: nothing has created the
    // hub yet. `mkdir -p -m 700` would mode only the leaf and leave the hub at
    // 0755, which is what made every later session fail its private-owner check.
    const home = `/tmp/bm${uid}/probe/identity-home/bytedcli/deadbeef`;
    const wrapper = writeWrapper(home);
    const script = [
      'set -e',
      'umask 022',
      `SESSION_DATA_DIR=${JSON.stringify(join(dir, 'data'))} BOTMUX_SESSION_ID=${SESSION} \\`,
      `  PATH=/usr/bin:/bin HOME=${JSON.stringify(process.env.HOME!)} /bin/sh ${JSON.stringify(wrapper)}`,
      `printf 'hub=%s\\n' "$(stat -c %a /tmp/bm$(id -u))"`,
      `printf 'inner=%s\\n' "$(stat -c %a /tmp/bm$(id -u)/probe)"`,
    ].join('\n');

    const run = runInNs(script);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('hub=700');
    // Every intermediate level the wrapper creates is private, not just the leaf.
    expect(run.stdout).toContain('inner=700');
  });

  it.skipIf(!privateTmpAvailable())('a daemon session still boots after the wrapper created the layout first', () => {
    // End to end on one fresh /tmp: wrapper creates the tree, then the daemon's
    // own session-temp setup runs. Before the fix this threw
    // "session temp alias parent is not a private owned directory".
    const wrapper = writeWrapper(`/tmp/bm${uid}/probe/identity-home/bytedcli/deadbeef`);
    const script = [
      'set -e',
      'umask 022',
      `cd ${JSON.stringify(repoRoot)}`,
      `SESSION_DATA_DIR=${JSON.stringify(join(dir, 'data'))} BOTMUX_SESSION_ID=${SESSION} \\`,
      `  PATH=/usr/bin:/bin HOME=${JSON.stringify(process.env.HOME!)} /bin/sh ${JSON.stringify(wrapper)}`,
      `HOME=${JSON.stringify(process.env.HOME!)} ${bootArgv().map(a => JSON.stringify(a)).join(' ')}`,
    ].join('\n');

    const run = runInNs(script);
    expect(run.stderr, 'daemon boot after the wrapper must not throw').not.toContain('not a private owned directory');
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('BOOT_OK ');
  });

  it.skipIf(!privateTmpAvailable())('adopts an alias the wrapper left as a real directory, on the cache filesystem', () => {
    // Same first-writer problem one level down: the wrapper also crosses the
    // alias name, leaving <hub>/<hash>/... as plain directories in /tmp (tmpfs
    // on the hosts this targets). Those must end up on the cache filesystem —
    // adopting the directory in place would keep the scratch on tmpfs, which is
    // the exact outcome #2467 exists to prevent.
    const home = `/tmp/bm${uid}/<hash>/probe/identity-home/bytedcli/deadbeef`;
    void home;
    const script = [
      'set -e',
      `cd ${JSON.stringify(repoRoot)}`,
      // Wrapper-created shape: hub (0755) + alias name as a real directory.
      `mkdir -m 755 /tmp/bm$(id -u)`,
      `  mkdir -m 700 -p /tmp/bm$(id -u)/CACHEHASH/wrapper-profile/wrapper-session`,
      `echo from-tmp > /tmp/bm$(id -u)/CACHEHASH/wrapper-profile/wrapper-session/artifact`,
      `HOME=${JSON.stringify(process.env.HOME!)} SESSION_DATA_DIR=${JSON.stringify(join(dir, 'data'))} \\`,
      `  ${bootArgv().map(a => JSON.stringify(a)).join(' ')}`,
      `printf 'aliaslink=%s\\n' "$(test -L /tmp/bm$(id -u)/CACHEHASH && echo yes || echo no)"`,
      `printf 'hub=%s\\n' "$(stat -c %a /tmp/bm$(id -u))"`,
    ].join('\n');

    // The alias name is a hash of the child's cache path, which depends on the
    // child's HOME; ask the child to report it rather than predicting it.
    const discovery = runInNs([
      'set -e',
      `cd ${JSON.stringify(repoRoot)}`,
      `HOME=${JSON.stringify(process.env.HOME!)} ${bootArgv().map(a => JSON.stringify(a)).join(' ')}`,
    ].join('\n'));
    expect(discovery.status, discovery.stderr).toBe(0);
    const bootedPath = /BOOT_OK (\S+)/.exec(discovery.stdout)?.[1];
    expect(bootedPath).toBeDefined();
    const aliasName = bootedPath!.split('/')[3];
    expect(aliasName).toMatch(/^[0-9a-f]{8}$/);

    const prepared = script.replaceAll('CACHEHASH', aliasName);
    const run = runInNs(prepared);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('aliaslink=yes');
    expect(run.stdout).toContain('hub=700');
    expect(run.stdout).toContain('BOOT_OK ');
  });

  it.skipIf(!privateTmpAvailable())('lands an adopted tree on disk, not on the tmpfs /tmp', () => {
    // Stated as the property that matters: after adoption the session scratch
    // must resolve OUTSIDE /tmp (the private /tmp here IS a tmpfs, as on the
    // Linux hosts this targets).
    const script = [
      'set -e',
      `cd ${JSON.stringify(repoRoot)}`,
      `mkdir -m 755 /tmp/bm$(id -u)`,
      `  mkdir -m 700 -p /tmp/bm$(id -u)/HASH/prof/sess`,
      `echo x > /tmp/bm$(id -u)/HASH/prof/sess/artifact`,
      `HOME=${JSON.stringify(process.env.HOME!)} SESSION_DATA_DIR=${JSON.stringify(join(dir, 'data'))} \\`,
      `  ${bootArgv().map(a => JSON.stringify(a)).join(' ')} > /dev/null`,
      // realpath of the alias must be outside /tmp
      `real=$(realpath /tmp/bm$(id -u)/HASH)`,
      `case "$real" in /tmp/*) echo "STILL_IN_TMP $real";; *) echo "OFF_TMP $real";; esac`,
    ].join('\n');

    const discovery = runInNs([
      'set -e',
      `cd ${JSON.stringify(repoRoot)}`,
      `HOME=${JSON.stringify(process.env.HOME!)} ${bootArgv().map(a => JSON.stringify(a)).join(' ')}`,
    ].join('\n'));
    const aliasName = /BOOT_OK (\S+)/.exec(discovery.stdout)![1].split('/')[3];

    const run = runInNs(script.replaceAll('HASH', aliasName));
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('OFF_TMP');
    expect(run.stdout).not.toContain('STILL_IN_TMP');
  });
});

describe('a hub replaced by a symlink (#2574)', () => {
  it.skipIf(!privateTmpAvailable())('never receives a write from the wrapper, through realpath or through mkdir', () => {
    // Two ways to leak into a foreign tree, and both must be shut: publishing a
    // path that RESOLVES into it (realpath), and publishing a lexical
    // `<hub>/...` path that the executor's `mkdir -p` then follows. Only a
    // private /tmp can plant this safely: the real hub is shared with every
    // other test file in the run.
    const script = [
      'set -e',
      `cd ${JSON.stringify(repoRoot)}`,
      `mkdir -p /tmp/foreign-tree`,
      `rm -rf /tmp/bm$(id -u)`,
      `ln -s /tmp/foreign-tree /tmp/bm$(id -u)`,
      // Publish THROUGH the real path under test (writeSessionIdentity), so the
      // HOME the wrapper gets is the one the daemon would have published. A
      // hand-written env file with a hub-spelled HOME is a different scenario:
      // it proves only that mkdir follows a link, which is expected.
      `HOME=${JSON.stringify(process.env.HOME!)} ${publishAndRunArgv().map(a => JSON.stringify(a)).join(' ')}`,
      `printf 'entries=%s\\n' "$(find /tmp/foreign-tree -mindepth 1 | wc -l)"`,
    ].join('\n');

    const run = runInNs(script);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('entries=0');
  });
});

describe('adoption carries a scratch tree that holds special files (#2574)', () => {
  /**
   * The alias subtree is a CLI's TMPDIR, so it legitimately holds a FIFO and/or
   * a listening unix socket. Cross-filesystem adoption must not open either:
   * `copyFileSync` on a writerless FIFO blocks forever (measured: still running
   * at 12s) and on a socket throws ENXIO (measured). Blocking is the worse of
   * the two — it happens inside the adoption lock, so every other first boot on
   * the host queues behind it.
   */
  function adoptWithSpecialFiles(aliasName: string): string {
    return [
      'set -e',
      `cd ${JSON.stringify(repoRoot)}`,
      `mkdir -m 755 /tmp/bm$(id -u)`,
      `mkdir -m 700 -p /tmp/bm$(id -u)/${aliasName}/prof/sess`,
      `echo regular > /tmp/bm$(id -u)/${aliasName}/prof/sess/regular`,
      // A writerless FIFO: this is what used to hang the adoption.
      `mkfifo /tmp/bm$(id -u)/${aliasName}/prof/sess/pipe`,
      `HOME=${JSON.stringify(process.env.HOME!)} SESSION_DATA_DIR=${JSON.stringify(join(dir, 'data'))} \\`,
      `  ${bootArgv().map(a => JSON.stringify(a)).join(' ')}`,
      `printf 'aliaslink=%s\\n' "$(test -L /tmp/bm$(id -u)/${aliasName} && echo yes || echo no)"`,
      `real=$(realpath /tmp/bm$(id -u)/${aliasName})`,
      `printf 'regular=%s\\n' "$(cat "$real/prof/sess/regular")"`,
    ].join('\n');
  }

  function aliasNameFor(dir: string): string {
    const discovery = runInNs([
      'set -e',
      `cd ${JSON.stringify(repoRoot)}`,
      `HOME=${JSON.stringify(join(dir, 'machine-home'))} ${bootArgv().map(a => JSON.stringify(a)).join(' ')}`,
    ].join('\n'));
    expect(discovery.status, discovery.stderr).toBe(0);
    return /BOOT_OK (\S+)/.exec(discovery.stdout)![1].split('/')[3];
  }

  it.skipIf(!privateTmpAvailable())('does not hang on a writerless FIFO', () => {
    const run = runInNs(adoptWithSpecialFiles(aliasNameFor(dir)));
    // A 30s ceiling: the hang this pins was unbounded, so any finite timeout
    // distinguishes "finished" from "blocked". SIGTERM from the runner is 124.
    expect(run.status, `timed out or failed: ${run.stderr}`).toBe(0);
    expect(run.stdout).toContain('aliaslink=yes');
    expect(run.stdout).toContain('regular=regular');
  });

  it.skipIf(!privateTmpAvailable())('does not fail the adoption on a unix socket', () => {
    const aliasName = aliasNameFor(dir);
    const script = [
      'set -e',
      `cd ${JSON.stringify(repoRoot)}`,
      `mkdir -m 755 /tmp/bm$(id -u)`,
      `mkdir -m 700 -p /tmp/bm$(id -u)/${aliasName}/prof/sess`,
      `echo regular > /tmp/bm$(id -u)/${aliasName}/prof/sess/regular`,
      // A socket that is BOUND while adoption runs, so the entry really is a
      // socket at lstat time.
      `node -e 'const n=require("net");const s=n.createServer();s.listen(process.argv[1],()=>setTimeout(()=>s.close(),8000))' \\`,
      `  /tmp/bm$(id -u)/${aliasName}/prof/sess/sock &`,
      '  sleep 1',
      `HOME=${JSON.stringify(join(dir, 'machine-home'))} SESSION_DATA_DIR=${JSON.stringify(join(dir, 'data'))} \\`,
      `  ${bootArgv().map(a => JSON.stringify(a)).join(' ')}`,
      `printf 'aliaslink=%s\\n' "$(test -L /tmp/bm$(id -u)/${aliasName} && echo yes || echo no)"`,
      `real=$(realpath /tmp/bm$(id -u)/${aliasName})`,
      `printf 'regular=%s\\n' "$(cat "$real/prof/sess/regular")"`,
      'kill %1 2>/dev/null || true',
    ].join('\n');

    const run = runInNs(script);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('aliaslink=yes');
    expect(run.stdout).toContain('regular=regular');
  });
});

describe('adoption merges instead of replacing (#2574)', () => {
  /**
   * The `/tmp` copy and the cache root can both hold a directory of the same
   * name with DIFFERENT children: the cache copy from an earlier session, the
   * `/tmp` copy from the wrapper that just ran. Shallowly dropping the shared
   * name loses the `/tmp` side's children — the session would come up missing
   * files it had just created, with nothing in the log. Same-level file
   * collisions resolve the other way (cache wins), because that is the copy the
   * daemon published paths for.
   */
  it.skipIf(!privateTmpAvailable())('keeps children that exist on only one side, cache winning same-name files', () => {
    const discovery = runInNs([
      'set -e',
      `cd ${JSON.stringify(repoRoot)}`,
      `HOME=${JSON.stringify(join(dir, 'machine-home'))} ${bootArgv().map(a => JSON.stringify(a)).join(' ')}`,
    ].join('\n'));
    const aliasName = /BOOT_OK (\S+)/.exec(discovery.stdout)![1].split('/')[3];

    const script = [
      'set -e',
      `cd ${JSON.stringify(repoRoot)}`,
      `CACHE=${JSON.stringify(join(dir, 'machine-home', '.cache', 'botmux', 'session-tmp'))}`,
      `mkdir -m 755 /tmp/bm$(id -u)`,
      `mkdir -m 700 -p /tmp/bm$(id -u)/${aliasName}/shared/profile`,
      `echo tmp-only > /tmp/bm$(id -u)/${aliasName}/shared/profile/tmp-only`,
      `echo tmp-version > /tmp/bm$(id -u)/${aliasName}/shared/profile/same`,
      `mkdir -m 700 -p "$CACHE/shared/profile"`,
      `echo cache-only > "$CACHE/shared/profile/cache-only"`,
      `echo cache-version > "$CACHE/shared/profile/same"`,
      `HOME=${JSON.stringify(join(dir, 'machine-home'))} SESSION_DATA_DIR=${JSON.stringify(join(dir, 'data'))} \\`,
      `  ${bootArgv().map(a => JSON.stringify(a)).join(' ')} > /dev/null`,
      `real=$(realpath /tmp/bm$(id -u)/${aliasName})`,
      `printf 'tmponly=%s\\n' "$(cat "$real/shared/profile/tmp-only")"`,
      `printf 'cacheonly=%s\\n' "$(cat "$real/shared/profile/cache-only")"`,
      `printf 'same=%s\\n' "$(cat "$real/shared/profile/same")"`,
    ].join('\n');

    const run = runInNs(script);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('tmponly=tmp-only');
    expect(run.stdout).toContain('cacheonly=cache-only');
    expect(run.stdout).toContain('same=cache-version');
  });
});

describe('adoption is serialised across booting processes (#2574)', () => {
  /**
   * A daemon and the CLIs it spawns all reach adoption on their first session.
   * Two of them walking the same `/tmp` tree while a third renames entries out
   * of it lost files and threw ENOENT from lstat/rename (measured before the
   * lock existed). Held here as a real multi-process race: N interpreters
   * adopting one tree at once must all succeed and lose nothing.
   */
  it.skipIf(!privateTmpAvailable())('lets N processes adopt one tree with nothing lost', () => {
    const discovery = runInNs([
      'set -e',
      `cd ${JSON.stringify(repoRoot)}`,
      `HOME=${JSON.stringify(join(dir, 'machine-home'))} ${bootArgv().map(a => JSON.stringify(a)).join(' ')}`,
    ].join('\n'));
    const aliasName = /BOOT_OK (\S+)/.exec(discovery.stdout)![1].split('/')[3];

    const files = 20;
    const writers = Array.from({ length: files }, (_, i) =>
      `echo v${i} > /tmp/bm$(id -u)/${aliasName}/p/s/f${i}`).join('; ');
    const { command, prefixArgs } = tsRunnerPrefix();
    const boot = JSON.stringify(join(repoRoot, 'src/core/session-temp.ts'));
    // The racers must enter the critical section TOGETHER, or they just take
    // turns and prove nothing. Each one blocks on a start file until the script
    // creates it, so import/boot cost does not stagger them.
    const gate = join(dir, 'go');
    const racer = [
      `HOME=${JSON.stringify(join(dir, 'machine-home'))}`,
      `SESSION_DATA_DIR=${JSON.stringify(join(dir, 'data'))}`,
      `GATE=${JSON.stringify(gate)}`,
      `${[command, ...prefixArgs].map(a => JSON.stringify(a)).join(' ')}`,
      `-e "const m = await import('${boot}');` +
      `const fs = await import('node:fs');` +
      `while (!fs.existsSync(process.env.GATE)) {}` +
      `m.ensureSessionTempDir('${join(dir, 'data')}', 'r'+process.argv[1])"`,
    ].join(' ');
    const spawnAll = Array.from({ length: 12 }, (_, i) => `(${racer} ${i} || echo FAIL${i}) &`).join(' ');
    const release = `sleep 1; : > ${JSON.stringify(gate)}`;

    const script = [
      'set -e',
      `cd ${JSON.stringify(repoRoot)}`,
      `mkdir -m 755 /tmp/bm$(id -u)`,
      `mkdir -m 700 -p /tmp/bm$(id -u)/${aliasName}/p/s`,
      writers,
      spawnAll,
      release,
      'wait',
      `printf 'aliaslink=%s\\n' "$(test -L /tmp/bm$(id -u)/${aliasName} && echo yes || echo no)"`,
      `real=$(realpath /tmp/bm$(id -u)/${aliasName})`,
      `printf 'kept=%s\\n' "$(ls "$real/p/s" | wc -l)"`,
      `printf 'lockleft=%s\\n' "$(test -e /tmp/bm$(id -u)/${aliasName}.adopt-lock && echo yes || echo no)"`,
    ].join('\n');

    const run = runInNs(script);
    expect(run.stdout).not.toContain('FAIL');
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('aliaslink=yes');
    expect(run.stdout).toContain(`kept=${files}`);
    // A leftover lock would wedge the next boot on the host.
    expect(run.stdout).toContain('lockleft=no');
  });
});
