import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeService, type BundledRuntimeCandidate } from '../../src/desktop/main/runtime-service.js';
import { ensureBotmuxShim, inspectBotmuxShim, pathProvidesBotmux } from '../../src/desktop/host/cli-shim.js';
import { classifyFleetOwnership, interpreterFromCommand, resolveFleetOwner } from '../../src/desktop/host/fleet-owner.js';
import { bundledRuntimeForHost, dispatchHostLine, FRAME_PREFIX, launchPolicy, runtimeSelfUpdateAllowed, settleRestartMarker, shouldWritePathEntry } from '../../src/desktop/host/desktop-host.js';
import { computeFleetAlignment } from '../../src/desktop/host/alignment.js';
import { decideUpdateAction, isRestartPending, isShellUpdateAvailable, updatePolicyFromConfig } from '../../src/desktop/host/update-policy.js';
import { appRuntimeBinaryPath, classifyBinaryInstall } from '../../src/core/binary-install-shape.js';
import type { DesktopRuntimeState } from '../../src/desktop/shared/types.js';

const paths = { botmuxHome: '/home/.botmux', dataDir: '/home/.botmux/data', logsDir: '/home/.botmux/logs' };
const configuredBots = '[{"larkAppId":"cli_x","larkAppSecret":"secret"}]';
const appBinary = '/Applications/Botmux.app/Contents/Resources/bin/botmux';

function binaryRuntime(): BundledRuntimeCandidate {
  return bundledRuntimeForHost({ standalone: true, execPath: appBinary, argv1: undefined, version: '3.55.0' });
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-native-host-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('native host: bundled binary runtime', () => {
  it('runs the compiled binary directly, with no script path in front of the subcommand', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const svc = createRuntimeService({
      paths, appVersion: '3.55.0', execPath: appBinary, env: { PATH: '/usr/bin' },
      fs: { existsSync: () => true, readFileSync: () => configuredBots },
      run, bundledRuntime: binaryRuntime(), fleetApps: async () => [], fleetOwner: () => null,
    });
    expect(await svc.getState()).toMatchObject({ status: 'stopped', runtimeSource: 'bundled', runtimeManaged: true });
    await svc.start();
    expect(run.mock.calls[0]![0]).toMatchObject({ command: appBinary, args: ['start'] });
  });

  it('treats a fleet started by the bundled binary as its own', async () => {
    const svc = createRuntimeService({
      paths, appVersion: '3.55.0', execPath: appBinary, env: {},
      fs: { existsSync: () => true, readFileSync: () => configuredBots },
      run: vi.fn(), bundledRuntime: binaryRuntime(),
      fleetApps: async () => [{ name: 'botmux-0', status: 'online', script: appBinary }],
      fleetOwner: () => null,
    });
    expect(await svc.getState()).toMatchObject({ status: 'running', runtimeSource: 'bundled', runtimeManaged: true });
  });
});

describe('native host: coexisting with a separately installed CLI', () => {
  const owner = {
    kind: 'external' as const,
    root: '/repo',
    cliPath: '/repo/dist/cli.js',
    binPath: '/repo/dist/cli.js',
    interpreterPath: '/Users/me/.bun/bin/bun',
    version: '',
    runtimeSource: 'global-cli' as const,
  };

  it('follows a fleet owned by another install instead of degrading into a takeover', async () => {
    const svc = createRuntimeService({
      paths, appVersion: '3.55.0', execPath: appBinary, env: {},
      fs: { existsSync: () => true, readFileSync: () => configuredBots },
      run: vi.fn(), bundledRuntime: binaryRuntime(),
      fleetApps: async () => [{ name: 'botmux-0', status: 'online', script: '/repo/dist/index-supervisor.js' }],
      fleetOwner: () => owner,
    });
    expect(await svc.getState()).toMatchObject({
      status: 'running', runtimeSource: 'global-cli', runtimeManaged: true, runtimePath: '/repo/dist/cli.js',
    });
  });

  it('routes start/stop/restart through the owning install, and takeover through the bundled binary', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const svc = createRuntimeService({
      paths, appVersion: '3.55.0', execPath: appBinary, env: {},
      fs: { existsSync: () => true, readFileSync: () => configuredBots },
      run, bundledRuntime: binaryRuntime(),
      fleetApps: async () => [{ name: 'botmux-0', status: 'online', script: '/repo/dist/index-supervisor.js' }],
      fleetOwner: () => owner,
    });
    await svc.restart();
    expect(run.mock.calls[0]![0]).toMatchObject({ command: '/Users/me/.bun/bin/bun', args: ['/repo/dist/cli.js', 'restart'] });
    await svc.takeover();
    expect(run.mock.calls[1]![0]).toMatchObject({ command: appBinary, args: ['restart'] });
  });

  it('without an owner resolver keeps the legacy degraded/takeover signal (Electron path)', async () => {
    const svc = createRuntimeService({
      paths, appVersion: '3.55.0', execPath: appBinary, env: {},
      fs: { existsSync: () => true, readFileSync: () => configuredBots },
      run: vi.fn(), bundledRuntime: binaryRuntime(),
      fleetApps: async () => [{ name: 'botmux-0', status: 'online', script: '/repo/dist/index-supervisor.js' }],
    });
    expect(await svc.getState()).toMatchObject({ status: 'degraded', runtimeManaged: false });
  });
});

describe('resolveFleetOwner', () => {
  const live = () => true;
  function state(entry: string, command?: string) {
    return {
      supervisorPid: 4242,
      supervisorStartedAt: '',
      supervisorEntry: entry,
      ...(command ? { supervisorCommand: command } : {}),
      procs: [],
    } as never;
  }

  it('reconstructs `<interpreter> <root>/dist/cli.js` from a Node/Bun supervisor', () => {
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'index-supervisor.js'), '');
    writeFileSync(join(dir, 'dist', 'cli.js'), '');
    writeFileSync(join(dir, 'package.json'), '{"version":"3.54.1"}');
    const bun = join(dir, 'b u n');
    writeFileSync(bun, '');
    const entry = join(dir, 'dist', 'index-supervisor.js');
    expect(resolveFleetOwner({
      bundledExecPath: appBinary,
      readState: () => state(entry, `${bun} --enable-source-maps ${entry}`),
      pidAlive: live,
    })).toMatchObject({ cliPath: join(dir, 'dist', 'cli.js'), interpreterPath: bun, version: '3.54.1' });
  });

  it('is null when the bundled binary owns the fleet, or nothing is alive', () => {
    const binary = join(dir, 'botmux');
    writeFileSync(binary, '');
    expect(resolveFleetOwner({ bundledExecPath: binary, readState: () => state(binary), pidAlive: live })).toBeNull();
    expect(resolveFleetOwner({ bundledExecPath: appBinary, readState: () => state(binary), pidAlive: () => false })).toBeNull();
    expect(resolveFleetOwner({ bundledExecPath: appBinary, readState: () => null, pidAlive: live })).toBeNull();
  });

  it('drives another compiled binary directly', () => {
    const other = join(dir, 'other-botmux');
    writeFileSync(other, '');
    expect(resolveFleetOwner({ bundledExecPath: appBinary, readState: () => state(other), pidAlive: live }))
      .toMatchObject({ binPath: other, cliPath: other });
  });

  it('parses interpreters out of supervisor command lines', () => {
    expect(interpreterFromCommand('/a/bun --enable-source-maps /x/dist/index-supervisor.js', '/x/dist/index-supervisor.js')).toBe('/a/bun');
    expect(interpreterFromCommand('node /x/s.js', '/x/s.js')).toBeNull();
    expect(interpreterFromCommand(undefined, '/x/s.js')).toBeNull();
  });
});

describe('botmux launcher for agents', () => {
  function script(target: string, cli?: string) {
    return `#!/bin/sh\nexec "${target}"${cli ? ` "${cli}"` : ''} "$@"\n`;
  }

  it('fills a missing launcher with the same compiled-binary wrapper the daemon writes', () => {
    const binDir = join(dir, 'bin');
    const result = ensureBotmuxShim({ binDir, bundledBinary: appBinary });
    expect(result).toEqual({ before: { kind: 'missing' }, wrote: true });
    expect(readFileSync(join(binDir, 'botmux'), 'utf-8')).toBe(`#!/bin/sh\nexec "${appBinary}" "$@"\n`);
  });

  it('never replaces a live launcher owned by another install', () => {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    const interp = join(dir, 'bun');
    const cli = join(dir, 'cli.js');
    writeFileSync(interp, '');
    writeFileSync(cli, '');
    const content = script(interp, cli);
    writeFileSync(join(binDir, 'botmux'), content);
    expect(ensureBotmuxShim({ binDir, bundledBinary: appBinary })).toMatchObject({ before: { kind: 'live' }, wrote: false });
    expect(readFileSync(join(binDir, 'botmux'), 'utf-8')).toBe(content);
  });

  it('keeps an install.sh binary that sits at the launcher path', () => {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    // A real binary may contain text that looks like a wrapper's exec line; it
    // must still be recognised by its header, not parsed as a script.
    writeFileSync(join(binDir, 'botmux'), Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from(`\nexec "${join(dir, 'gone')}" "$@"\n`)]));
    chmodSync(join(binDir, 'botmux'), 0o755);
    expect(ensureBotmuxShim({ binDir, bundledBinary: appBinary }).wrote).toBe(false);
  });

  it('repairs a launcher whose target is gone (deleted worktree / uninstalled package)', () => {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'botmux'), script(join(dir, 'gone', 'bun'), join(dir, 'gone', 'cli.js')));
    expect(ensureBotmuxShim({ binDir, bundledBinary: appBinary })).toMatchObject({ before: { kind: 'dangling' }, wrote: true });
    expect(readFileSync(join(binDir, 'botmux'), 'utf-8')).toContain(appBinary);
  });

  it('replaces a dangling symlink instead of writing through it', () => {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    symlinkSync(join(dir, 'nowhere'), join(binDir, 'botmux'));
    expect(inspectBotmuxShim(join(binDir, 'botmux'), appBinary).kind).toBe('dangling');
    ensureBotmuxShim({ binDir, bundledBinary: appBinary });
    expect(lstatSync(join(binDir, 'botmux')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(dir, 'nowhere'))).toBe(false);
    expect(readFileSync(join(binDir, 'botmux'), 'utf-8')).toContain(appBinary);
  });

  it('recognises a launcher that already points at the bundled binary', () => {
    const binary = join(dir, 'app-botmux');
    writeFileSync(binary, '');
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'botmux'), script(binary));
    expect(inspectBotmuxShim(join(binDir, 'botmux'), binary).kind).toBe('self');
  });

  it('detects whether a PATH already provides botmux', () => {
    writeFileSync(join(dir, 'botmux'), '');
    expect(pathProvidesBotmux(`/nope:${dir}`)).toBe(true);
    expect(pathProvidesBotmux('/nope')).toBe(false);
    expect(pathProvidesBotmux(undefined)).toBe(false);
  });
});

describe('desktop host wire protocol', () => {
  const parse = (out: string | null) => JSON.parse(out!.slice(FRAME_PREFIX.length));

  it('answers requests with prefixed frames and reports handler errors', async () => {
    const handlers = {
      echo: (params: unknown[]) => params[0],
      boom: () => { throw new Error('nope'); },
    };
    expect(parse(await dispatchHostLine('{"id":1,"method":"echo","params":["hi"]}', handlers)))
      .toEqual({ id: 1, ok: true, result: 'hi' });
    expect(parse(await dispatchHostLine('{"id":2,"method":"boom"}', handlers)))
      .toEqual({ id: 2, ok: false, error: 'nope' });
  });

  it('rejects unknown, prototype and malformed requests without throwing', async () => {
    expect(parse(await dispatchHostLine('{"id":3,"method":"__proto__"}', {})).ok).toBe(false);
    expect(parse(await dispatchHostLine('{"id":4,"method":"toString"}', {})).ok).toBe(false);
    expect(parse(await dispatchHostLine('not json', {})).ok).toBe(false);
    expect(parse(await dispatchHostLine('{"method":"x"}', {})).ok).toBe(false);
    expect(await dispatchHostLine('   ', {})).toBeNull();
  });
});

describe('version alignment (the app runtime is the reference)', () => {
  const owner = (version: string, isCheckout = false) => ({ version, isCheckout });

  it('auto-aligns an older packaged install, only offers it for a git checkout', () => {
    expect(computeFleetAlignment({ appVersion: '3.55.0', owner: owner('3.40.1'), fleetRunning: true }))
      .toEqual({ kind: 'owner-older', ownerVersion: '3.40.1', appVersion: '3.55.0', auto: true });
    expect(computeFleetAlignment({ appVersion: '3.55.0', owner: owner('3.40.1', true), fleetRunning: true }))
      .toMatchObject({ kind: 'owner-older', auto: false });
  });

  it('never downgrades a newer install and treats equal versions as aligned', () => {
    expect(computeFleetAlignment({ appVersion: '3.55.0', owner: owner('3.56.0'), fleetRunning: true }).kind).toBe('owner-newer');
    expect(computeFleetAlignment({ appVersion: '3.55.0', owner: owner('3.55.0'), fleetRunning: true }).kind).toBe('aligned');
    expect(computeFleetAlignment({ appVersion: '3.55.0', owner: null, fleetRunning: true }).kind).toBe('aligned');
  });

  it('does nothing when versions are unknown or nothing runs', () => {
    expect(computeFleetAlignment({ appVersion: '3.55.0', owner: owner(''), fleetRunning: true }).kind).toBe('unknown');
    expect(computeFleetAlignment({ appVersion: '0.0.0', owner: owner('3.1.0'), fleetRunning: true }).kind).toBe('unknown');
    expect(computeFleetAlignment({ appVersion: '3.55.0', owner: owner('3.1.0'), fleetRunning: false }).kind).toBe('unknown');
  });
});

describe('launch policy', () => {
  const ok = { code: 0, stdout: '', stderr: '' };
  function state(status: DesktopRuntimeState['status'], runtimeSource: DesktopRuntimeState['runtimeSource'] = 'bundled'): DesktopRuntimeState {
    return {
      status, appVersion: '3.55.0', runtimeVersion: null, runtimeSource, runtimeManaged: true,
      runtimePath: null, botCount: 1, onlineDaemonCount: 0, attentionCount: 0, dashboardUrl: null,
    };
  }
  function runtime() {
    return { start: vi.fn().mockResolvedValue(ok), takeover: vi.fn().mockResolvedValue(ok), restartBundled: vi.fn().mockResolvedValue(ok) };
  }
  const base = { log: () => {} };

  it('starts the app runtime when nothing runs', async () => {
    const rt = runtime();
    expect(await launchPolicy({ ...base, runtime: rt, state: state('stopped'), alignment: async () => ({ kind: 'unknown' }), runtimeReplaced: false, appLaunch: true, ownedByApp: () => true })).toBe('started');
    expect(rt.start).toHaveBeenCalled();
  });

  it('restarts its own fleet only after the runtime binary was replaced', async () => {
    const rt = runtime();
    expect(await launchPolicy({ ...base, runtime: rt, state: state('running'), alignment: async () => ({ kind: 'aligned' }), runtimeReplaced: false, appLaunch: true, ownedByApp: () => true })).toBe('none');
    expect(await launchPolicy({ ...base, runtime: rt, state: state('running'), alignment: async () => ({ kind: 'aligned' }), runtimeReplaced: true, appLaunch: true, ownedByApp: () => true })).toBe('restarted');
    expect(rt.restartBundled).toHaveBeenCalledTimes(1);
  });

  it('takes over an older packaged install, but leaves a checkout or newer install alone', async () => {
    const rt = runtime();
    const running = state('running', 'global-cli');
    expect(await launchPolicy({ ...base, runtime: rt, state: running, runtimeReplaced: false, appLaunch: true, ownedByApp: () => false,
      alignment: async () => ({ kind: 'owner-older', ownerVersion: '3.1.0', appVersion: '3.55.0', auto: true }) })).toBe('aligned');
    expect(await launchPolicy({ ...base, runtime: rt, state: running, runtimeReplaced: false, appLaunch: true, ownedByApp: () => false,
      alignment: async () => ({ kind: 'owner-older', ownerVersion: '3.1.0', appVersion: '3.55.0', auto: false }) })).toBe('none');
    expect(await launchPolicy({ ...base, runtime: rt, state: running, runtimeReplaced: false, appLaunch: true, ownedByApp: () => false,
      alignment: async () => ({ kind: 'owner-newer', ownerVersion: '3.60.0', appVersion: '3.55.0' }) })).toBe('none');
    expect(rt.takeover).toHaveBeenCalledTimes(1);
  });
});

describe('app runtime binary is self-updatable', () => {
  it('is classified as a self-owned standalone install, so botmux update / maintenance replace it in place', () => {
    expect(classifyBinaryInstall(appRuntimeBinaryPath('/Users/u'), {}, '/Users/u', p => p)).toBe('curl-binary');
    expect(classifyBinaryInstall('/Applications/Botmux.app/Contents/Resources/bin/botmux', {}, '/Users/u', p => p)).toBe('unknown');
  });
});

describe('app update policy coexists with the CLI auto-update', () => {
  it('one switch for both: maintenance.autoUpdate', () => {
    expect(updatePolicyFromConfig({ autoUpdate: { enabled: true } })).toBe('cli-auto');
    expect(updatePolicyFromConfig({ autoUpdate: { enabled: false } })).toBe('remind');
    expect(updatePolicyFromConfig(undefined)).toBe('remind');
  });

  it('leaves the file to the daemon when the daemon runs from it, applies it itself otherwise', () => {
    const base = { available: true, policy: 'cli-auto' as const };
    expect(decideUpdateAction({ ...base, fleetOwnedByApp: true, fleetRunning: true })).toBe('leave-to-cli');
    expect(decideUpdateAction({ ...base, fleetOwnedByApp: false, fleetRunning: true })).toBe('auto-apply');
    expect(decideUpdateAction({ ...base, fleetOwnedByApp: true, fleetRunning: false })).toBe('auto-apply');
  });

  it('only reminds when auto-update is off, and does nothing without a newer version', () => {
    expect(decideUpdateAction({ available: true, policy: 'remind', fleetOwnedByApp: false, fleetRunning: true })).toBe('remind');
    expect(decideUpdateAction({ available: false, policy: 'cli-auto', fleetOwnedByApp: false, fleetRunning: true })).toBe('none');
  });

  it('flags a restart when the runtime file is newer than the app-owned fleet', () => {
    const started = '2026-11-05T10:00:00.000Z';
    const later = Date.parse(started) + 60_000;
    expect(isRestartPending({ fleetOwnedByApp: true, fleetRunning: true, supervisorStartedAt: started, runtimeMtimeMs: later })).toBe(true);
    expect(isRestartPending({ fleetOwnedByApp: true, fleetRunning: true, supervisorStartedAt: started, runtimeMtimeMs: Date.parse(started) - 1 })).toBe(false);
    expect(isRestartPending({ fleetOwnedByApp: false, fleetRunning: true, supervisorStartedAt: started, runtimeMtimeMs: later })).toBe(false);
  });

  it('offers a new Botmux.app only when that release actually ships the arm64 app', () => {
    expect(isShellUpdateAvailable('3.56.0', '3.57.0', true)).toBe(true);
    expect(isShellUpdateAvailable('3.56.0', '3.57.0', false)).toBe(false);
    expect(isShellUpdateAvailable('3.57.0', '3.57.0', true)).toBe(false);
    expect(isShellUpdateAvailable(undefined, '3.57.0', true)).toBe(false);
  });
});

describe('fleet ownership is three-way', () => {
  const live = () => true;
  function state(entry: string | undefined, command?: string) {
    return { supervisorPid: 4242, supervisorStartedAt: '', ...(entry ? { supervisorEntry: entry } : {}), ...(command ? { supervisorCommand: command } : {}), procs: [] } as never;
  }

  it('an owner whose launcher cannot be rebuilt is someone else, never the app', () => {
    mkdirSync(join(dir, 'dist'));
    const entry = join(dir, 'dist', 'index-supervisor.js');
    writeFileSync(entry, '');
    // cli.js and the interpreter are missing (checkout mid-build, deleted worktree)
    expect(classifyFleetOwnership({ bundledExecPath: appBinary, readState: () => state(entry, `/nope/bun ${entry}`), pidAlive: live }))
      .toEqual({ kind: 'unknown-external', entry });
    expect(classifyFleetOwnership({ bundledExecPath: appBinary, readState: () => state(join(dir, 'gone.js')), pidAlive: live }).kind)
      .toBe('unknown-external');
    expect(classifyFleetOwnership({ bundledExecPath: appBinary, readState: () => state(undefined), pidAlive: live }).kind)
      .toBe('unknown-external');
  });

  it('is "app" only when the supervisor entry is the app runtime', () => {
    const binary = join(dir, 'botmux');
    writeFileSync(binary, '');
    expect(classifyFleetOwnership({ bundledExecPath: binary, readState: () => state(binary), pidAlive: live }).kind).toBe('app');
    expect(classifyFleetOwnership({ bundledExecPath: binary, readState: () => state(binary), pidAlive: () => false }).kind).toBe('none');
  });

  it('drives a `bun src/index-supervisor.ts` dev fleet through src/cli.ts, not by exec-ing the .ts file', () => {
    mkdirSync(join(dir, 'src'));
    const entry = join(dir, 'src', 'index-supervisor.ts');
    writeFileSync(entry, '');
    writeFileSync(join(dir, 'src', 'cli.ts'), '');
    const bun = join(dir, 'bun');
    writeFileSync(bun, '');
    expect(resolveFleetOwner({ bundledExecPath: appBinary, readState: () => state(entry, `${bun} ${entry}`), pidAlive: live }))
      .toMatchObject({ interpreterPath: bun, cliPath: join(dir, 'src', 'cli.ts') });
  });

  it('knows the version of a compiled-binary owner (npm / install.sh), so alignment can act on it', () => {
    const other = join(dir, 'other-botmux');
    writeFileSync(other, '');
    const owner = resolveFleetOwner({ bundledExecPath: appBinary, readState: () => state(other), pidAlive: live, probeVersion: () => '3.40.0' });
    expect(owner?.version).toBe('3.40.0');
    expect(computeFleetAlignment({ appVersion: '3.55.0', owner: { version: owner!.version, isCheckout: false }, fleetRunning: true }))
      .toMatchObject({ kind: 'owner-older', auto: true });
  });

  it('never offers a deleted compiled-binary owner (uninstalled install.sh binary) as a drivable external owner', () => {
    // No script suffix: this is the compiled-binary branch. Without the exists
    // guard the mutation below classifies it as external{version:''} (a drivable
    // owner of unknown version) and resolveFleetOwner no longer returns null.
    const gone = join(dir, 'gone-botmux');
    const deps = { bundledExecPath: appBinary, readState: () => state(gone), pidAlive: live };
    expect(classifyFleetOwnership(deps)).toEqual({ kind: 'unknown-external', entry: gone });
    expect(resolveFleetOwner(deps)).toBeNull();
  });
});

describe('launch policy edges', () => {
  const ok = { code: 0, stdout: '', stderr: '' };
  const base = { log: () => {} };
  function state(status: DesktopRuntimeState['status'], runtimeSource: DesktopRuntimeState['runtimeSource']): DesktopRuntimeState {
    return { status, appVersion: '3.55.0', runtimeVersion: null, runtimeSource, runtimeManaged: true, runtimePath: null, botCount: 1, onlineDaemonCount: 0, attentionCount: 0, dashboardUrl: null };
  }

  it('never auto-takes-over on a background host relaunch (after its own update, a crash, a runtime swap)', async () => {
    const rt = { start: vi.fn(), takeover: vi.fn().mockResolvedValue(ok), restartBundled: vi.fn() };
    expect(await launchPolicy({ ...base, runtime: rt, state: state('running', 'global-cli'), runtimeReplaced: false, appLaunch: false, ownedByApp: () => false,
      alignment: async () => ({ kind: 'owner-older', ownerVersion: '3.1.0', appVersion: '3.55.0', auto: true }) })).toBe('none');
    expect(rt.takeover).not.toHaveBeenCalled();
  });

  it('reports a failed restart onto the reseeded runtime so the marker survives for the next launch', async () => {
    const rt = { start: vi.fn(), takeover: vi.fn(), restartBundled: vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'boom' }) };
    expect(await launchPolicy({ ...base, runtime: rt, state: state('running', 'bundled'), runtimeReplaced: true, appLaunch: true, ownedByApp: () => true,
      alignment: async () => ({ kind: 'aligned' }) })).toBe('restart-failed');
  });

  it('does not auto-start anything but the app runtime', async () => {
    const rt = { start: vi.fn().mockResolvedValue(ok), takeover: vi.fn(), restartBundled: vi.fn() };
    expect(await launchPolicy({ ...base, runtime: rt, state: state('stopped', 'global-cli'), runtimeReplaced: false, appLaunch: true, ownedByApp: () => false,
      alignment: async () => ({ kind: 'unknown' }) })).toBe('none');
    expect(rt.start).not.toHaveBeenCalled();
  });

  it('never auto-starts an explicitly stopped fleet on a background host relaunch (self-update exit / crash / mtime swap)', async () => {
    const rt = { start: vi.fn().mockResolvedValue(ok), takeover: vi.fn(), restartBundled: vi.fn() };
    // The stopped + bundled state that the pre-fix policy started unconditionally,
    // even though this is a relaunch, not an app launch.
    expect(await launchPolicy({ ...base, runtime: rt, state: state('stopped', 'bundled'), runtimeReplaced: false, appLaunch: false, ownedByApp: () => false,
      alignment: async () => ({ kind: 'unknown' }) })).toBe('none');
    expect(rt.start).not.toHaveBeenCalled();
  });

  it('a stopped fleet with a reseed marker on a background relaunch is left stopped and the marker settles to remove', async () => {
    const rt = { start: vi.fn().mockResolvedValue(ok), takeover: vi.fn(), restartBundled: vi.fn() };
    const outcome = await launchPolicy({ ...base, runtime: rt, state: state('stopped', 'bundled'), runtimeReplaced: true, appLaunch: false, ownedByApp: () => true,
      alignment: async () => ({ kind: 'aligned' }) });
    expect(outcome).toBe('none');
    expect(rt.start).not.toHaveBeenCalled();
    expect(rt.restartBundled).not.toHaveBeenCalled();
    // No old-build fleet is running, so the marker must not linger.
    expect(settleRestartMarker(outcome)).toBe('remove');
  });

  it('still restarts its own reseeded fleet on a BACKGROUND relaunch (the one relaunch action that survives the gate)', async () => {
    const rt = { start: vi.fn(), takeover: vi.fn(), restartBundled: vi.fn().mockResolvedValue(ok) };
    expect(await launchPolicy({ ...base, runtime: rt, state: state('running', 'bundled'), runtimeReplaced: true, appLaunch: false, ownedByApp: () => true,
      alignment: async () => ({ kind: 'aligned' }) })).toBe('restarted');
    expect(rt.restartBundled).toHaveBeenCalledTimes(1);
    expect(rt.takeover).not.toHaveBeenCalled();
  });
});

describe('restart-pending boundary', () => {
  it('ignores mtime jitter right around the supervisor start', () => {
    const started = '2026-11-05T10:00:00.000Z';
    expect(isRestartPending({ fleetOwnedByApp: true, fleetRunning: true, supervisorStartedAt: started, runtimeMtimeMs: Date.parse(started) + 500 })).toBe(false);
  });
});

describe('launch marker settlement', () => {
  it('keeps the marker only for restart-failed, removes it for every other outcome', () => {
    expect(settleRestartMarker('restart-failed')).toBe('keep');
    for (const outcome of ['started', 'restarted', 'aligned', 'none'] as const) {
      expect(settleRestartMarker(outcome)).toBe('remove');
    }
  });
});

describe('shell PATH entry is written at most once', () => {
  it.each([
    [{ markerExists: false, shellProvidesBotmux: false }, true],
    [{ markerExists: true, shellProvidesBotmux: false }, false],
    [{ markerExists: false, shellProvidesBotmux: true }, false],
    [{ markerExists: true, shellProvidesBotmux: true }, false],
  ])('%j => %s', (input, expected) => {
    expect(shouldWritePathEntry(input)).toBe(expected);
  });
});

describe('in-app self-update only targets the seeded app runtime', () => {
  const home = '/Users/u';
  const seeded = appRuntimeBinaryPath(home);

  it('allows the compiled binary at ~/.botmux/app-runtime', () => {
    expect(runtimeSelfUpdateAllowed({ standalone: true, runtimePath: seeded, home })).toBe(true);
  });

  it('refuses the binary inside the signed .app bundle (reseed-failure fallback)', () => {
    expect(runtimeSelfUpdateAllowed({ standalone: true, runtimePath: '/Applications/Botmux.app/Contents/Resources/bin/botmux', home })).toBe(false);
  });

  it('refuses dev mode (non-compiled runtime)', () => {
    expect(runtimeSelfUpdateAllowed({ standalone: false, runtimePath: process.execPath, home })).toBe(false);
    expect(runtimeSelfUpdateAllowed({ standalone: false, runtimePath: seeded, home })).toBe(false);
  });

  it('does not pass a sibling-looking directory by prefix', () => {
    expect(runtimeSelfUpdateAllowed({ standalone: true, runtimePath: `${seeded}-old`, home })).toBe(false);
  });
});
