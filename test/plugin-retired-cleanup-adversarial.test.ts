import './helpers/require-fenced-data-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { installLocalPlugin, installNpmPlugin } from '../src/core/plugins/install.js';
import * as paths from '../src/core/plugins/paths.js';
import * as registry from '../src/services/plugin-registry-store.js';
import { pluginRegistryRevision, type PluginMutationGuard } from '../src/core/plugins/mutation-guard.js';
import { withPluginServiceLock, withPluginServiceLockSync } from '../src/core/plugins/service-manager.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

// Forward to the real filesystem; spies inject faults at individual I/O boundaries.
vi.mock('node:fs', async original => ({
  ...await original<typeof import('node:fs')>(),
}));
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
}));

let home: string;
let sequence: number;
const repository = fileURLToPath(new URL('..', import.meta.url));

function source(id = 'sample', marker = id, root = join(home, `source-${sequence++}`)): string {
  fs.mkdirSync(join(root, 'dist'), { recursive: true });
  fs.writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: `@adversarial/${id}`, version: '1.0.0', keywords: ['botmux-plugin'],
    botmux: { schemaVersion: 1, id },
  }));
  fs.writeFileSync(join(root, 'dist', 'marker'), marker);
  return root;
}

function retired(suffix = '123-456'): string {
  // Completed uninstalls leave a valid registry; do not model absence with a missing file.
  if (!fs.existsSync(paths.pluginRegistryPath())) registry.writePluginRegistry({ schemaVersion: 1, plugins: {} });
  const dir = `${paths.pluginHome('sample')}.removed-${suffix}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'recovery-data'), 'keep until proven unreferenced');
  return dir;
}

function marker(id = 'sample'): string {
  return fs.readFileSync(join(paths.pluginRuntimeDir(id), 'marker'), 'utf8');
}

function guard(token?: string): PluginMutationGuard {
  return {
    id: 'sample', packageName: '@adversarial/sample', version: '1.0.0',
    expectedState: null, expectedRevision: pluginRegistryRevision(),
    ...(token ? { authorityDigest: createHash('sha256').update(token).digest('hex') } : {}),
  };
}

function tokenFile(): string {
  return join(paths.botmuxHome(), '.dashboard-token');
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'botmux-retired-adversarial-')));
  sequence = 0;
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  fs.mkdirSync(paths.pluginsHome(), { recursive: true });
  // Assert the configured repository fence before any production operation.
  expect(paths.pluginsHome()).toBe(join(home, '.botmux', 'plugins'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('retired cleanup: independent adversarial verification', () => {
  it('CONTROL: preserves a renamed recovery home while its original record is registered', () => {
    installLocalPlugin(source('sample', 'old'));
    const recovery = `${paths.pluginHome('sample')}.removed-123-456`;
    fs.renameSync(paths.pluginHome('sample'), recovery);
    installLocalPlugin(source('sample', 'replacement'));
    expect(marker()).toBe('replacement');
    expect(fs.readFileSync(join(recovery, 'dist', 'marker'), 'utf8')).toBe('old');
  });

  it.each(['.', 'nested-package'])('MANUAL-LINK-CHAIN: keeps source %s whose dist symlink resolves outside the retired home', relativePackage => {
    const recovery = retired();
    const packageHome = join(recovery, relativePackage);
    fs.mkdirSync(packageHome, { recursive: true });
    const external = source('sample', 'external-runtime');
    fs.copyFileSync(join(external, 'package.json'), join(packageHome, 'package.json'));
    fs.symlinkSync(join(external, 'dist'), join(packageHome, 'dist'), 'dir');

    const installed = installLocalPlugin(packageHome, { link: true });
    expect(installed.record.source).toMatchObject({ spec: packageHome, link: true });
    expect(fs.readlinkSync(installed.runtimeDir)).toBe(join(packageHome, 'dist'));
    expect({
      recoveryPresent: fs.existsSync(recovery),
      packagePresent: fs.existsSync(join(packageHome, 'package.json')),
      externalMarker: fs.readFileSync(join(external, 'dist', 'marker'), 'utf8'),
      installedIsSymlink: fs.lstatSync(installed.runtimeDir).isSymbolicLink(),
      installedRuntimeReadable: fs.existsSync(join(installed.runtimeDir, 'marker')),
    }, 'a successful linked install must preserve intermediate source paths').toEqual({
      recoveryPresent: true,
      packagePresent: true,
      externalMarker: 'external-runtime',
      installedIsSymlink: true,
      installedRuntimeReadable: true,
    });
    expect(marker()).toBe('external-runtime');
  });

  it('MANUAL-OTHER-PLUGIN: keeps a retired home used by another registered linked plugin', () => {
    const recovery = retired();
    const otherSource = source('other', 'other-live-runtime', join(recovery, 'other-source'));
    installLocalPlugin(otherSource, { link: true });
    expect(marker('other')).toBe('other-live-runtime');

    installLocalPlugin(source('sample', 'replacement'));
    expect(marker()).toBe('replacement');
    expect(registry.getInstalledPlugin('other')?.source).toMatchObject({ spec: otherSource, link: true });
    expect(fs.existsSync(join(paths.pluginRuntimeDir('other'), 'marker')),
      'cleanup for sample must not break a different registered plugin').toBe(true);
    expect(marker('other')).toBe('other-live-runtime');
  });

  it.each(['current', 'existing'])('LINK-GC-REFUSAL: %s linked installation suppresses even otherwise eligible collection', which => {
    const recovery = retired();
    if (which === 'existing') installLocalPlugin(source('other'), { link: true });
    const installed = installLocalPlugin(source(), { link: which === 'current' });
    expect(marker()).toBe('sample');
    expect(fs.lstatSync(installed.runtimeDir).isSymbolicLink()).toBe(which === 'current');
    expect(fs.readFileSync(join(recovery, 'recovery-data'), 'utf8')).toBe('keep until proven unreferenced');
    if (which === 'existing') expect(marker('other')).toBe('other');
  });

  it.each(['package', 'dist'])('COPY-SOURCE: preserves the %s realpath and skips collection for a symlinked runtime', inside => {
    const recovery = retired();
    const removable = retired('123-457');
    let pkg: string;
    if (inside === 'package') {
      pkg = join(recovery, 'nested-package');
      fs.mkdirSync(pkg);
      const external = source('sample', 'external-runtime');
      fs.copyFileSync(join(external, 'package.json'), join(pkg, 'package.json'));
      fs.symlinkSync(join(external, 'dist'), join(pkg, 'dist'), 'dir');
    } else {
      pkg = source('sample', 'external-runtime');
      fs.renameSync(join(pkg, 'dist'), join(recovery, 'runtime'));
      fs.symlinkSync(join(recovery, 'runtime'), join(pkg, 'dist'), 'dir');
    }
    installLocalPlugin(pkg, { link: false });
    expect(marker()).toBe('external-runtime');
    expect(fs.existsSync(recovery)).toBe(true);
    expect(fs.existsSync(removable)).toBe(true);
  });

  it.each(['current', 'existing'])('COPY-NESTED-LINK: keeps retired data referenced inside a %s copied runtime', which => {
    const recovery = retired();
    const dependentId = which === 'current' ? 'sample' : 'other';
    const pkg = source(dependentId);
    fs.symlinkSync(join(recovery, 'recovery-data'), join(pkg, 'dist', 'shared-data'));
    if (which === 'existing') {
      installLocalPlugin(pkg, { link: false });
      expect(fs.readFileSync(join(paths.pluginRuntimeDir('other'), 'shared-data'), 'utf8'))
        .toBe('keep until proven unreferenced');
    }

    installLocalPlugin(which === 'current' ? pkg : source(), { link: false });
    const dependent = registry.getInstalledPlugin(dependentId)!;
    expect(dependent.source).toMatchObject({ type: 'local', spec: pkg });
    expect(dependent.source.link).not.toBe(true);
    expect({
      registered: !!dependent,
      runtimePresent: fs.existsSync(paths.pluginRuntimeDir(dependentId)),
      sharedDataReadable: fs.existsSync(join(paths.pluginRuntimeDir(dependentId), 'shared-data')),
      recoveryPresent: fs.existsSync(recovery),
    }, 'copy mode preserves interior symlinks and can still depend on a retired home').toEqual({
      registered: true, runtimePresent: true, sharedDataReadable: true, recoveryPresent: true,
    });
  });

  it('REGISTERED-PLUGIN: updating a still-registered plugin keeps its recovery home', () => {
    // The guard this pins: `if (registry.plugins[pluginId]) return`. Dropping it
    // still passes every other case in this file, because those all start from a
    // completed uninstall (record absent) and hit the same early return for a
    // different reason. Here the record is PRESENT, so only that guard stands
    // between an in-place update and the only copy of the previous runtime.
    installLocalPlugin(source('sample', 'registered-v1'));
    const recovery = `${paths.pluginHome('sample')}.removed-123-456`;
    fs.mkdirSync(recovery, { recursive: true });
    fs.writeFileSync(join(recovery, 'recovery-data'), 'previous runtime kept for recovery');
    installLocalPlugin(source('sample', 'registered-v2'));
    expect(marker()).toBe('registered-v2');
    expect(fs.readFileSync(join(recovery, 'recovery-data'), 'utf8'),
      'a registered plugin is not proof its retired home is garbage').toBe('previous runtime kept for recovery');
  });

  it('MISSING-REGISTRY: preserves recovery data when registry absence cannot prove completed uninstall', () => {
    const recovery = retired();
    fs.rmSync(paths.pluginRegistryPath());
    expect(fs.existsSync(paths.pluginRegistryPath())).toBe(false);
    installLocalPlugin(source(), { guard: guard() });
    expect(marker()).toBe('sample');
    expect(fs.readFileSync(join(recovery, 'recovery-data'), 'utf8')).toBe('keep until proven unreferenced');
    expect(registry.getInstalledPlugin('sample')?.version).toBe('1.0.0');
  });

  it.each([
    ['null', null],
    ['array', []],
    ['missing schema', { plugins: {} }],
    ['unknown schema', { schemaVersion: 2, plugins: {} }],
    ['missing plugin map', { schemaVersion: 1 }],
    ['array plugin map', { schemaVersion: 1, plugins: [] }],
    ['null record', { schemaVersion: 1, plugins: { sample: null } }],
    ['partial record', { schemaVersion: 1, plugins: { sample: { id: 'sample', version: '1.0.0' } } }],
    ['mismatched key', { schemaVersion: 1, plugins: { sample: { id: 'other', packageName: '@test/other', version: '1.0.0', manifest: { id: 'other' } } } }],
  ])('MALFORMED-REGISTRY: %s is not proof of safe collection', (_name, raw) => {
    const recovery = retired();
    fs.writeFileSync(paths.pluginRegistryPath(), JSON.stringify(raw));
    installLocalPlugin(source());
    expect(marker()).toBe('sample');
    expect(fs.readFileSync(join(recovery, 'recovery-data'), 'utf8')).toBe('keep until proven unreferenced');
  });

  it('MALFORMED-WITH-MIGRATION: legacy MCP migration must not turn discarded invalid records into GC authority', () => {
    const recovery = retired();
    const other = installLocalPlugin(source('other')).record;
    fs.writeFileSync(paths.pluginRegistryPath(), JSON.stringify({
      schemaVersion: 1,
      plugins: {
        sample: { id: 'sample', version: '1.0.0' },
        other: {
          ...other,
          contributions: {
            mcp: { name: 'other', transport: 'stdio', command: ['node', 'fixture-only.js'] },
          },
        },
      },
    }));
    installLocalPlugin(source());
    expect(marker()).toBe('sample');
    expect(fs.existsSync(paths.pluginMcpPrivatePath('other'))).toBe(true);
    expect(fs.existsSync(join(recovery, 'recovery-data')),
      'a lazy migration must not erase evidence that the registry was incompletely parsed').toBe(true);
  });

  it('PARTIAL-REGISTRY: does not treat a torn registry as proof a recovery home is unregistered', () => {
    installLocalPlugin(source('sample', 'recoverable-runtime'));
    const recovery = `${paths.pluginHome('sample')}.removed-123-456`;
    fs.renameSync(paths.pluginHome('sample'), recovery);
    const savedRegistry = fs.readFileSync(paths.pluginRegistryPath(), 'utf8');
    // An operator/editor restore was interrupted halfway through its write.
    fs.writeFileSync(paths.pluginRegistryPath(), savedRegistry.slice(0, savedRegistry.length / 2));

    try { installLocalPlugin(source('sample', 'replacement')); } catch { /* refusal is safe too */ }
    expect(fs.existsSync(join(recovery, 'dist', 'marker')),
      'parse failure is not a successful absence check for destructive GC').toBe(true);
    expect(fs.readFileSync(join(recovery, 'dist', 'marker'), 'utf8')).toBe('recoverable-runtime');
  });

  it('PARTIAL-RM: retries partially deleted trees without blocking installation or deleting the new runtime', () => {
    const denied = retired();
    const removable = retired('123-457');
    const realRm = fs.rmSync;
    let failed = false;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (String(path) === denied && !failed) {
        failed = true;
        realRm(join(denied, 'recovery-data'));
        fs.writeFileSync(join(denied, 'remaining'), 'unfinished cleanup');
        throw Object.assign(new Error('injected partial recursive removal'), { code: 'EACCES' });
      }
      return realRm(path, options);
    });
    const pkg = source();
    installLocalPlugin(pkg);
    expect(failed).toBe(true);
    expect(marker()).toBe('sample');
    expect(fs.readFileSync(join(denied, 'remaining'), 'utf8')).toBe('unfinished cleanup');
    expect(fs.existsSync(removable)).toBe(false);
    expect(warning).toHaveBeenCalled();

    // Reproduce a subsequent completed uninstall whose final retired rm was deferred.
    const later = `${paths.pluginHome('sample')}.removed-124-458`;
    withPluginServiceLockSync(() => {
      fs.renameSync(paths.pluginHome('sample'), later);
      registry.removeInstalledPlugin('sample');
    });
    installLocalPlugin(pkg);
    expect(marker()).toBe('sample');
    expect(fs.existsSync(denied)).toBe(false);
    expect(fs.existsSync(later)).toBe(false);
  });

  it('PARTIAL-COMMIT: rolls back a published runtime when the atomic registry rename fails and permits retry', () => {
    const recovery = retired();
    registry.writePluginRegistry({ schemaVersion: 1, plugins: {} });
    const previous = fs.readFileSync(paths.pluginRegistryPath(), 'utf8');
    const realRename = fs.renameSync;
    let injected = false;
    const failCommit = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === paths.pluginRegistryPath()) {
        injected = true;
        expect(marker()).toBe('new');
        throw Object.assign(new Error('injected registry rename failure'), { code: 'EIO' });
      }
      return realRename(from, to);
    });
    const pkg = source('sample', 'new');
    expect(() => installLocalPlugin(pkg)).toThrow(/injected registry rename failure/);
    expect(injected).toBe(true);
    expect(fs.existsSync(recovery)).toBe(false);
    expect(fs.existsSync(paths.pluginRuntimeDir('sample'))).toBe(false);
    expect(fs.readFileSync(paths.pluginRegistryPath(), 'utf8')).toBe(previous);
    expect(registry.getInstalledPlugin('sample')).toBeUndefined();
    failCommit.mockRestore();
    installLocalPlugin(pkg);
    expect(marker()).toBe('new');
    expect(registry.getInstalledPlugin('sample')?.version).toBe('1.0.0');
  });

  it('LONG-LOCK: cannot steal a live lifecycle lock after a simulated hour and can retry after release', () => {
    const recovery = retired();
    const pkg = source();
    const lockPath = join(paths.pluginsHome(), 'service-manager.lock');
    vi.useFakeTimers({ toFake: ['Date'] });
    withPluginServiceLockSync(() => {
      const owner = fs.statSync(lockPath);
      const payload = fs.readFileSync(lockPath, 'utf8');
      vi.setSystemTime(Date.now() + 60 * 60_000);
      // Advance real lock retry accounting without a 30-second wall-clock wait.
      const sleep = vi.spyOn(Atomics, 'wait').mockImplementation(() => {
        vi.setSystemTime(Date.now() + 10_000);
        return 'timed-out';
      });
      try {
        expect(() => installLocalPlugin(pkg)).toThrow(expect.objectContaining({ code: 'FILE_LOCK_TIMEOUT' }));
        expect(fs.statSync(lockPath).ino).toBe(owner.ino);
        expect(fs.readFileSync(lockPath, 'utf8')).toBe(payload);
        expect(fs.existsSync(recovery)).toBe(true);
        expect(fs.existsSync(paths.pluginRuntimeDir('sample'))).toBe(false);
        expect(fs.readdirSync(paths.pluginsHome()).some(name => name.startsWith('.sample-dist-next-'))).toBe(false);
      } finally { sleep.mockRestore(); }
    });
    vi.useRealTimers();
    installLocalPlugin(pkg);
    expect(marker()).toBe('sample');
    expect(fs.existsSync(recovery)).toBe(false);
  });

  it('WAITING-REVOCATION: a real competing installer rechecks authority after waiting on the lifecycle lock', async () => {
    const recovery = retired();
    const pkg = source();
    fs.writeFileSync(tokenFile(), 'original');
    const confirmed = guard('original');
    let child: ReturnType<typeof spawnTsEvalWithRepoImports> | undefined;
    let output = '';
    let errors = '';
    let result!: Promise<number | null>;
    try {
      await withPluginServiceLock(async () => {
        child = spawnTsEvalWithRepoImports(`
          import { installLocalPlugin } from './src/core/plugins/install.js';
          try {
            installLocalPlugin(${JSON.stringify(pkg)}, { guard: ${JSON.stringify(confirmed)} });
            console.log(JSON.stringify({ installed: true }));
          } catch (error) {
            console.log(JSON.stringify({ error: error.message }));
          }
        `, { cwd: repository, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout!.on('data', chunk => { output += chunk; });
        child.stderr!.on('data', chunk => { errors += chunk; });
        result = new Promise((resolve, reject) => {
          child!.once('error', reject);
          child!.once('close', resolve);
        });
        await vi.waitFor(() => {
          expect(fs.readdirSync(paths.pluginsHome()).some(name => name.startsWith('.sample-dist-next-')),
            `child must stage before waiting; stderr=${errors}`).toBe(true);
        }, { timeout: 10_000, interval: 20 });
        expect(fs.existsSync(recovery)).toBe(true);
        expect(registry.getInstalledPlugin('sample')).toBeUndefined();
        fs.writeFileSync(tokenFile(), 'revoked-while-waiting');
      });
      await vi.waitFor(() => { expect(child!.exitCode).not.toBeNull(); }, { timeout: 10_000 });
      expect(await result).toBe(0);
      expect(output).toContain('plugin_authority_revoked');
      expect(fs.existsSync(recovery)).toBe(true);
      expect(registry.getInstalledPlugin('sample')).toBeUndefined();
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (result) await result;
    }
  }, 25_000);

  it('LONG-CLEANUP-REVOCATION: rechecks authority when slow cleanup returns after manual token rotation', () => {
    const recovery = retired();
    const pkg = source();
    fs.writeFileSync(tokenFile(), 'original');
    const confirmed = guard('original');
    vi.useFakeTimers({ toFake: ['Date'] });
    const realRm = fs.rmSync;
    let rotated = false;
    vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (String(path) === recovery) {
        expect(fs.existsSync(join(paths.pluginsHome(), 'service-manager.lock'))).toBe(true);
        vi.setSystemTime(Date.now() + 120_000);
        fs.writeFileSync(tokenFile(), 'rotated-during-slow-cleanup');
        rotated = true;
      }
      return realRm(path, options);
    });
    let error: unknown;
    try { installLocalPlugin(pkg, { guard: confirmed }); } catch (caught) { error = caught; }
    expect(rotated).toBe(true);
    expect({
      error: error instanceof Error ? error.message : error,
      registered: registry.getInstalledPlugin('sample') !== undefined,
      runtimePresent: fs.existsSync(paths.pluginRuntimeDir('sample')),
    }, 'authority changed after entry validation but before install commit').toEqual({
      error: 'plugin_authority_revoked', registered: false, runtimePresent: false,
    });
  });

  it('LONG-CLEANUP-REVOCATION-NPM: the npm path rechecks authority after slow cleanup too', () => {
    // Both install paths call cleanupRetiredPluginHomes before committing, and
    // both re-assert the guard afterwards. Only the local path was covered, so
    // deleting the npm re-check left the whole suite green.
    const recovery = retired();
    registry.writePluginRegistry({ schemaVersion: 1, plugins: {} });
    fs.writeFileSync(tokenFile(), 'original');
    const confirmed = guard('original');
    const realRm = fs.rmSync;
    let rotated = false;
    vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (String(path) === recovery && !rotated) {
        fs.writeFileSync(tokenFile(), 'rotated-during-slow-cleanup');
        rotated = true;
      }
      return realRm(path, options);
    });
    const exec = vi.spyOn(cp, 'execFileSync').mockImplementation(((_command: string, args: readonly string[]) => {
      const prefix = args[args.indexOf('--prefix') + 1];
      const dir = join(prefix, 'node_modules', confirmed.packageName);
      fs.mkdirSync(join(dir, 'dist'), { recursive: true });
      fs.writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: confirmed.packageName, version: confirmed.version,
        keywords: ['botmux-plugin'], botmux: { schemaVersion: 1, id: confirmed.id },
      }));
      fs.writeFileSync(join(dir, 'dist', 'marker'), 'npm');
      return Buffer.alloc(0);
    }) as never);
    let error: unknown;
    try { installNpmPlugin(`${confirmed.packageName}@${confirmed.version}`, { guard: confirmed }); }
    catch (caught) { error = caught; }
    expect(exec).toHaveBeenCalled();
    expect(rotated).toBe(true);
    expect({
      error: error instanceof Error ? error.message : error,
      registered: registry.getInstalledPlugin('sample') !== undefined,
      runtimePresent: fs.existsSync(paths.pluginRuntimeDir('sample')),
    }, 'the npm path must not commit after cleanup outlives the confirmation').toEqual({
      error: 'plugin_authority_revoked', registered: false, runtimePresent: false,
    });
  });
});
