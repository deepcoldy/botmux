/**
 * `botmux __desktop-host` — the runtime half of the native (Swift) Botmux.app.
 *
 * The Swift shell only owns windows, the menu-bar item, the login item and the
 * WKWebView bridge. Everything that touches the fleet (state, start/stop,
 * dashboard discovery, logs, device status) stays in TypeScript and runs here, in
 * the very binary the app bundles, so it is the same code path the CLI uses.
 *
 * Wire protocol (newline-delimited JSON):
 *   stdin  ← {"id":1,"method":"getState","params":[]}
 *   stdout → <FRAME_PREFIX>{"id":1,"ok":true,"result":{…}}
 *   stdout → <FRAME_PREFIX>{"event":"state","data":{…}}
 * Frames carry a prefix because the shared logger also writes to stdout; the
 * shell ignores every line without it. stdin EOF (the app quit) ends the host
 * but never stops the fleet — the daemon outlives the app by design.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { replaceStandaloneBinary } from '../../core/binary-self-update.js';
import { globalInstallUpdateLockTarget } from '../../core/maintenance.js';
import { withFileLock } from '../../utils/file-lock.js';
import { readFleetState } from '../../core/fleet-state-store.js';
import { pidAlive } from '../../core/fleet-supervisor.js';
import { isStandaloneBinary } from '../../core/self-spawn.js';
import { appRuntimeBinaryPath } from '../../core/binary-install-shape.js';
import { resolveBotmuxWrapperBinDir } from '../../core/botmux-wrapper.js';
import { botmuxVersion } from '../../utils/install-info.js';
import { ensurePathEntry } from '../../../scripts/install-path-entry.mjs';
import { shouldAutoStartCliRuntime } from '../main/auto-start.js';
import { probeShellPathEnv } from '../main/external-runtime.js';
import { listFleetApps } from '../main/fleet-apps.js';
import {
  createRuntimeStateMonitor,
  listTargets,
  locateDashboard,
  runRuntimeAction,
  selectDesktopDashboardUrl,
  tailLogTarget,
} from '../main/runtime-actions.js';
import { createRuntimeService, type BundledRuntimeCandidate } from '../main/runtime-service.js';
import type { DesktopPaths, DesktopRuntimeState } from '../shared/types.js';
import { fetchReleaseLatestVersion, isNewerVersion } from '../../core/update-check.js';
import { computeFleetAlignment, type FleetAlignment } from './alignment.js';
import { readGlobalConfig, type MaintenanceConfig } from '../../global-config.js';
import { GITHUB_REPO, releasesUrl } from '../../core/restart-report.js';
import {
  decideUpdateAction,
  isRestartPending,
  isShellUpdateAvailable,
  shellAssetName,
  updatePolicyFromConfig,
  type UpdatePolicy,
} from './update-policy.js';

function safeMaintenanceConfig(): MaintenanceConfig | undefined {
  try {
    return readGlobalConfig().maintenance;
  } catch {
    return undefined;
  }
}
import { ensureBotmuxShim, pathProvidesBotmux } from './cli-shim.js';
import { classifyFleetOwnership } from './fleet-owner.js';

export const FRAME_PREFIX = '\u001eBOTMUX ';

/** `<binary> --version` in probe mode; null when it does not run or report semver. */
export function probeBinaryVersion(binary: string): string | null {
  const result = spawnSync(binary, ['--version'], {
    encoding: 'utf-8',
    timeout: 15_000,
    env: { ...process.env, BOTMUX_INSTALL_PROBE: '1' },
  });
  const out = result.status === 0 ? result.stdout.trim() : '';
  return /^\d+\.\d+\.\d+/.test(out) ? out : null;
}

export type HostHandler = (params: unknown[]) => unknown;

export interface HostRequest {
  id: number | string;
  method: string;
  params?: unknown[];
}

/** Decode one stdin line and run it. Pure over `handlers`, so it is unit-testable. */
export async function dispatchHostLine(
  line: string,
  handlers: Record<string, HostHandler>,
): Promise<string | null> {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let request: HostRequest;
  try {
    request = JSON.parse(trimmed) as HostRequest;
  } catch {
    return frame({ id: null, ok: false, error: 'invalid JSON request' });
  }
  if (!request || (typeof request.id !== 'number' && typeof request.id !== 'string') || typeof request.method !== 'string') {
    return frame({ id: null, ok: false, error: 'malformed request' });
  }
  // Own-property lookup only: a method name like "__proto__" must not reach
  // Object.prototype members.
  const handler = Object.prototype.hasOwnProperty.call(handlers, request.method)
    ? handlers[request.method]
    : undefined;
  if (!handler) return frame({ id: request.id, ok: false, error: `unknown method: ${request.method}` });
  try {
    const result = await handler(Array.isArray(request.params) ? request.params : []);
    return frame({ id: request.id, ok: true, result: result ?? null });
  } catch (error) {
    return frame({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export function frame(payload: unknown): string {
  return `${FRAME_PREFIX}${JSON.stringify(payload)}\n`;
}

export function bundledRuntimeForHost(input: {
  standalone: boolean;
  execPath: string;
  argv1: string | undefined;
  version: string;
}): BundledRuntimeCandidate {
  if (input.standalone) {
    return {
      kind: 'bundled',
      root: dirname(input.execPath),
      cliPath: input.execPath,
      nodePath: input.execPath,
      version: input.version,
      runtimeSource: 'bundled',
      selfDispatching: true,
    };
  }
  // Dev: `bun dist/cli.js __desktop-host` (or src/cli.ts under bun).
  const cliPath = input.argv1 ?? join(process.cwd(), 'dist', 'cli.js');
  return {
    kind: 'bundled',
    root: dirname(dirname(cliPath)),
    cliPath,
    nodePath: input.execPath,
    version: input.version,
    runtimeSource: 'bundled',
  };
}

export type LaunchOutcome = 'started' | 'restarted' | 'restart-failed' | 'aligned' | 'none';

/**
 * Only the runtime properly seeded at `~/.botmux/app-runtime/botmux` may be
 * replaced in place by an in-app update. When `RuntimeInstaller.ensure` could not
 * seed it (disk full, permissions, AV) the Swift shell falls back to the binary
 * INSIDE the signed .app bundle; replacing that file would invalidate the code
 * signature (the next launch is killed by the OS) or fail with an opaque error.
 * Such a state is only recoverable by reinstalling the app, so every update
 * entry point must refuse instead of writing into the bundle. Dev mode (a
 * non-compiled runtime) has its own earlier gate and is never self-updatable.
 */
export function runtimeSelfUpdateAllowed(input: { standalone: boolean; runtimePath: string; home: string }): boolean {
  return input.standalone && input.runtimePath === appRuntimeBinaryPath(input.home);
}

/**
 * What to do with the persisted `.restart-needed` marker after launch policy
 * runs. A failed restart onto the reseeded runtime KEEPS it so the next launch
 * retries; every other outcome (including a stopped fleet, for which there is no
 * old-build fleet to restart) removes it.
 */
export function settleRestartMarker(outcome: LaunchOutcome): 'keep' | 'remove' {
  return outcome === 'restart-failed' ? 'keep' : 'remove';
}

/** The shell PATH line is written at most once per seeded runtime, and never
 *  when a login shell already resolves `botmux`. */
export function shouldWritePathEntry(input: { markerExists: boolean; shellProvidesBotmux: boolean }): boolean {
  return !input.markerExists && !input.shellProvidesBotmux;
}

export interface DesktopUpdateStatus {
  current: string;
  latest: string | null;
  available: boolean;
  checkedAt: number | null;
  inProgress: boolean;
  error?: string;
  /** Who updates the app runtime — see update-policy.ts. */
  policy: UpdatePolicy;
  /** `maintenance.autoUpdate.time` when policy is cli-auto. */
  autoUpdateTime?: string;
  /** The runtime file is newer than the running app-owned fleet. */
  restartPending: boolean;
  /** A newer Botmux.app build is published (the shell itself, not the runtime). */
  shell: { current: string | null; latest: string | null; available: boolean; url: string | null };
}

export interface DesktopOverview {
  state: DesktopRuntimeState;
  alignment: FleetAlignment;
  update: DesktopUpdateStatus;
}

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000;

export async function runDesktopHost(): Promise<void> {
  const home = homedir();
  const botmuxHome = join(home, '.botmux');
  const paths: DesktopPaths = {
    botmuxHome,
    dataDir: join(botmuxHome, 'data'),
    logsDir: join(botmuxHome, 'logs'),
  };
  // The host runs from the binary bundled with the app (its protocol matches the
  // shell); the FLEET runs from the self-updatable runtime the app passes in
  // (~/.botmux/app-runtime/botmux). A runtime updated to a release that predates
  // this host keeps working, because the host never runs from it.
  const runtimePath = isStandaloneBinary() ? (process.env.BOTMUX_DESKTOP_RUNTIME || process.execPath) : process.execPath;
  const version = runtimePath === process.execPath ? botmuxVersion() : (probeBinaryVersion(runtimePath) ?? botmuxVersion());
  const bundled = bundledRuntimeForHost({
    standalone: isStandaloneBinary(),
    execPath: runtimePath,
    argv1: process.argv[1],
    version,
  });
  const write = (text: string) => { process.stdout.write(text); };
  const emit = (event: string, data: unknown) => write(frame({ event, data }));
  const log = (message: string) => process.stderr.write(`[desktop-host] ${message}\n`);

  const fleetStatePath = join(botmuxHome, 'fleet-state.json');
  const readState = () => (existsSync(fleetStatePath) ? readFleetState(fleetStatePath) : null);
  const ownership = () => classifyFleetOwnership({ bundledExecPath: bundled.cliPath, readState, pidAlive });
  const fleetOwner = () => {
    const owned = ownership();
    return owned.kind === 'external' ? owned.runtime : null;
  };
  /** Only a supervisor whose entry IS the app runtime counts as the app's fleet. */
  const ownedByApp = () => ownership().kind === 'app';
  // Markers always live next to the Swift-seeded runtime
  // (~/.botmux/app-runtime), never derived from bundled.cliPath: in the
  // reseed-failure fallback that path is INSIDE the signed .app bundle, and the
  // restart marker is written by RuntimeInstaller only beside the out-of-bundle
  // runtime it actually replaced.
  const runtimeDir = dirname(appRuntimeBinaryPath(home));
  // Persisted (not a one-shot env): survives host crashes/relaunches until the
  // restart onto the reseeded runtime actually succeeds.
  const restartMarker = join(runtimeDir, '.restart-needed');
  const pathMarker = join(runtimeDir, '.path-entry-written');
  // False only when the runtime could not be seeded outside the bundle — every
  // update entry point must then refuse rather than write into the signed .app.
  const selfUpdateAllowed = runtimeSelfUpdateAllowed({ standalone: isStandaloneBinary(), runtimePath, home });
  const RESEED_FAILED_MESSAGE = '运行时未成功植入到 App 运行时目录（~/.botmux/app-runtime），请重新安装 Botmux App 后再更新';
  const runtime = createRuntimeService({
    paths,
    appVersion: version,
    execPath: process.execPath,
    env: process.env,
    fs: { existsSync, readFileSync },
    bundledRuntime: bundled,
    shellPathEnv: () => probeShellPathEnv(),
    fleetApps: () => listFleetApps(paths),
    fleetOwner,
  });

  const shellVersion = process.env.BOTMUX_DESKTOP_SHELL_VERSION || null;
  const update: DesktopUpdateStatus = {
    current: version, latest: null, available: false, checkedAt: null, inProgress: false,
    policy: 'remind', restartPending: false,
    shell: { current: shellVersion, latest: null, available: false, url: null },
  };
  const readPolicy = () => {
    const maintenance = safeMaintenanceConfig();
    update.policy = updatePolicyFromConfig(maintenance);
    update.autoUpdateTime = update.policy === 'cli-auto' ? maintenance?.autoUpdate?.time : undefined;
  };
  const runtimeMtime = () => {
    try { return statSync(bundled.cliPath).mtimeMs; } catch { return null; }
  };
  const startedMtime = runtimeMtime();
  let lastState: DesktopRuntimeState | null = null;
  const overview = (state: DesktopRuntimeState): DesktopOverview => {
    const owner = fleetOwner();
    const fleetRunning = state.status === 'running' || state.status === 'degraded';
    readPolicy();
    update.restartPending = bundled.selfDispatching === true && isRestartPending({
      fleetOwnedByApp: ownedByApp(),
      fleetRunning,
      supervisorStartedAt: readState()?.supervisorStartedAt,
      runtimeMtimeMs: runtimeMtime(),
    });
    return {
      state,
      alignment: computeFleetAlignment({
        appVersion: version,
        owner: owner ? { version: owner.version, isCheckout: existsSync(join(owner.root, '.git')) } : null,
        fleetRunning: state.status === 'running' || state.status === 'degraded',
      }),
      update: { ...update },
    };
  };
  const publish = () => { if (lastState) emit('overview', overview(lastState)); };
  const monitor = createRuntimeStateMonitor({
    runtime,
    sendState: state => {
      lastState = state;
      emit('state', state);
      publish();
      // Something else (the daemon's maintenance auto-update, a manual
      // `botmux update`) replaced the runtime binary under us: exit so the app
      // relaunches this host from the new build.
      const now = runtimeMtime();
      if (bundled.selfDispatching && startedMtime !== null && now !== null && now !== startedMtime && !update.inProgress) {
        log('runtime binary was replaced; relaunching host');
        setTimeout(() => process.exit(0), 100);
      }
    },
  });

  async function checkForUpdate(): Promise<DesktopUpdateStatus> {
    if (!bundled.selfDispatching) return { ...update };
    if (!selfUpdateAllowed) {
      // Reseed failure fallback: the runtime is the binary inside the signed
      // bundle. Do not offer or silently apply an update that would overwrite it.
      update.available = false;
      update.latest = null;
      update.error = RESEED_FAILED_MESSAGE;
      update.checkedAt = Date.now();
      publish();
      return { ...update };
    }
    try {
      const lookup = await fetchReleaseLatestVersion();
      update.latest = lookup.version;
      update.available = Boolean(lookup.version && isNewerVersion(lookup.version, version));
      update.error = undefined;
      if (lookup.version) await checkShellUpdate(lookup.version);
    } catch (error) {
      update.error = error instanceof Error ? error.message : String(error);
    }
    update.checkedAt = Date.now();
    publish();

    const fleetRunning = Boolean(lastState && (lastState.status === 'running' || lastState.status === 'degraded'));
    readPolicy();
    const action = decideUpdateAction({ available: update.available, policy: update.policy, fleetOwnedByApp: ownedByApp(), fleetRunning });
    if (action === 'auto-apply') {
      log(`auto-updating app runtime ${version} → ${update.latest} (maintenance.autoUpdate is on; fleet not run by the app runtime)`);
      void applyUpdate({ restartFleet: false }).then(
        result => { if (!result.ok) log(`auto-update failed: ${result.message}`); },
        error => log(`auto-update failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
    return { ...update };
  }

  async function checkShellUpdate(latest: string): Promise<void> {
    if (!shellVersion) return;
    const url = `https://github.com/${GITHUB_REPO}/releases/download/v${latest}/${shellAssetName(latest)}`;
    let exists = false;
    try {
      const response = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8_000) });
      exists = response.status === 200 || (response.status >= 300 && response.status < 400);
    } catch { /* offline or blocked: just no shell reminder */ }
    update.shell = {
      current: shellVersion,
      latest,
      available: isShellUpdateAvailable(shellVersion, latest, exists),
      url: releasesUrl(latest),
    };
  }

  async function applyUpdate(opts: { restartFleet?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
    if (!bundled.selfDispatching) return { ok: false, message: '开发模式运行，不支持应用内更新' };
    if (!selfUpdateAllowed) return { ok: false, message: RESEED_FAILED_MESSAGE };
    if (update.inProgress) return { ok: false, message: '更新已在进行中' };
    update.inProgress = true;
    publish();
    try {
      // In-process, with the same function and the same cross-process lock as
      // `botmux update` and the daemon's maintenance auto-update — so the two
      // updaters serialize on this file, and a release that predates this host
      // can still be installed (nothing here depends on the target's CLI).
      const lookup = await fetchReleaseLatestVersion();
      const target = lookup.version;
      if (!target) return { ok: false, message: '无法获取最新版本（网络不可达或 registry 异常）' };
      if (!isNewerVersion(target, version)) return { ok: true, message: `已是最新版本（${version}）` };
      const lock = globalInstallUpdateLockTarget();
      mkdirSync(dirname(lock), { recursive: true });
      const replaced = await withFileLock(lock, () => replaceStandaloneBinary(target, bundled.cliPath), { maxWaitMs: 5_000 });
      const output = `${replaced.asset} → ${replaced.target}（${version} → ${target}，source=${replaced.source}）`;
      // The binary at our own path was replaced. If the fleet runs from it,
      // restart so it picks the new build up; a fleet owned by another install
      // is aligned separately (see alignment).
      if (opts.restartFleet !== false && ownedByApp() && lastState && lastState.status === 'running') {
        const restarted = await runtime.restartBundled();
        if (restarted.code !== 0) log(`restart after update failed: ${(restarted.stderr || restarted.stdout).trim()}`);
      }
      // Exit so the app relaunches the host from the new binary.
      setTimeout(() => process.exit(0), 200);
      return { ok: true, message: output };
    } finally {
      update.inProgress = false;
      publish();
    }
  }

  const handlers: Record<string, HostHandler> = {
    getState: () => runtime.getState(),
    getOverview: async () => overview(await runtime.getState()),
    getDeviceStatus: () => runtime.getDeviceStatus(),
    start: () => runRuntimeAction(runtime.start, monitor),
    stop: () => runRuntimeAction(runtime.stop, monitor),
    restart: () => runRuntimeAction(runtime.restart, monitor),
    takeover: () => runRuntimeAction(runtime.takeover.bind(runtime), monitor),
    locateDashboard: () => locateDashboard(runtime),
    getDashboardUrl: async () => {
      const result = await runtime.dashboard();
      return result.code === 0 ? selectDesktopDashboardUrl(result.stdout) : null;
    },
    listLogTargets: () => listTargets(paths),
    tailLogs: params => tailLogTarget(paths, params[0]),
    getAgentCli: () => agentCli,
    checkUpdate: () => checkForUpdate(),
    applyUpdate: () => applyUpdate(),
  };

  // Make `botmux` callable from agents before anything else: sessions get
  // ~/.botmux/bin prepended by the daemon, and a terminal gets it through the
  // shell profile line the npm/curl installers already write.
  let agentCli: { shim: string; wroteShim: boolean; pathProfiles: string[] } = { shim: 'unknown', wroteShim: false, pathProfiles: [] };
  if (bundled.selfDispatching) {
    try {
      const binDir = resolveBotmuxWrapperBinDir(process.env);
      const shim = ensureBotmuxShim({ binDir, bundledBinary: bundled.cliPath });
      let pathProfiles: string[] = [];
      // Once per machine: a user who removes the line again has decided, and
      // the host relaunches often (after every runtime update).
      if (shouldWritePathEntry({ markerExists: existsSync(pathMarker), shellProvidesBotmux: pathProvidesBotmux(probeShellPathEnv()) })) {
        const result = ensurePathEntry({ installDir: binDir });
        pathProfiles = result.written;
        for (const failure of result.failed) log(`PATH entry not written to ${failure.file}: ${failure.error}`);
        if (result.failed.length === 0) writeFileSync(pathMarker, `${new Date().toISOString()}\n`);
      }
      agentCli = { shim: shim.before.kind, wroteShim: shim.wrote, pathProfiles };
      log(`botmux launcher: ${shim.before.kind}${shim.wrote ? ' → app runtime' : ''}${pathProfiles.length ? `; PATH added in ${pathProfiles.join(', ')}` : ''}`);
    } catch (error) {
      log(`botmux launcher setup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', line => {
    void dispatchHostLine(line, handlers).then(out => { if (out) write(out); });
  });
  const closed = new Promise<void>(resolve => rl.once('close', () => resolve()));

  try {
    const outcome = await launchPolicy({
      runtime,
      state: await runtime.getState(),
      alignment: () => runtime.getState().then(state => overview(state).alignment),
      runtimeReplaced: existsSync(restartMarker),
      // Auto-takeover only when the APP starts — never when the host merely
      // relaunched (after its own update, a crash, a runtime swap), which would
      // otherwise restart every bot at an arbitrary background moment.
      appLaunch: process.env.BOTMUX_DESKTOP_APP_LAUNCH === '1',
      ownedByApp,
      log,
    });
    // A stopped fleet + marker + background relaunch returns 'none' here: there
    // is no old-build fleet to restart, so removing the marker is the correct
    // outcome (settleRestartMarker), not a conflict with restart-failed keeping it.
    if (settleRestartMarker(outcome) === 'remove') rmSync(restartMarker, { force: true });
  } catch (error) {
    log(`launch policy failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  monitor.start();
  emit('ready', { version });
  if (bundled.selfDispatching) {
    setTimeout(() => { void checkForUpdate(); }, 10_000).unref?.();
    setInterval(() => { void checkForUpdate(); }, UPDATE_CHECK_INTERVAL_MS).unref?.();
  }

  await closed;
  monitor.stop();
}

/**
 * What the app does to the fleet when it starts:
 *  · the app runtime was reseeded and its fleet runs → restart it onto the new
 *    (marker persists until that succeeds)            build. The ONLY action a
 *                                                         background host relaunch
 *                                                         may take.
 *  · nothing runs                          → start the app runtime — APP LAUNCH
 *                                             ONLY, so a fleet the user explicitly
 *                                             stopped is never resurrected by a
 *                                             host crash / self-update exit / mtime swap
 *  · an older PACKAGED install owns it     → take over (align to the app version),
 *    — on app launch only                    never on a background host relaunch
 *  · a git checkout, a newer install, or   → leave it; offered in the menu only
 *    an owner we cannot identify
 */
export async function launchPolicy(input: {
  runtime: Pick<ReturnType<typeof createRuntimeService>, 'start' | 'takeover' | 'restartBundled'>;
  state: DesktopRuntimeState;
  alignment: () => Promise<FleetAlignment>;
  runtimeReplaced: boolean;
  appLaunch: boolean;
  ownedByApp: () => boolean;
  log: (message: string) => void;
}): Promise<LaunchOutcome> {
  const report = (label: string, result: { code: number; stdout: string; stderr: string }) => {
    if (result.code !== 0) input.log(`${label} failed: ${(result.stderr || result.stdout).trim()}`);
    return result.code === 0;
  };
  const running = input.state.status === 'running' || input.state.status === 'degraded';
  // Before the app-launch gate on purpose: restarting an app-owned fleet onto a
  // runtime the app just reseeded must also happen when the host merely
  // relaunched (that is exactly when a self-update/reseed lands).
  if (running && input.ownedByApp() && input.runtimeReplaced) {
    return report('restart onto the new app runtime', await input.runtime.restartBundled()) ? 'restarted' : 'restart-failed';
  }
  // Everything else is an app-launch decision. A background host relaunch never
  // starts or takes over anything — the fleet outlives the app by design, and a
  // fleet the user stopped stays stopped.
  if (!input.appLaunch) return 'none';
  if (!running) {
    // The runtimeSource === 'bundled' guard stays: on a first app launch where a
    // separately installed CLI owns a stopped fleet, auto-starting the app
    // runtime would hijack that install's fleet.
    if (shouldAutoStartCliRuntime(input.state) && input.state.runtimeSource === 'bundled') {
      report('auto-start', await input.runtime.start());
      return 'started';
    }
    return 'none';
  }
  const alignment = await input.alignment();
  if (alignment.kind === 'owner-older' && alignment.auto) {
    input.log(`aligning fleet ${alignment.ownerVersion} → app ${alignment.appVersion}`);
    report('align', await input.runtime.takeover());
    return 'aligned';
  }
  return 'none';
}
