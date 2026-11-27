// `botmux start` / `restart` typed inside a session served by a dedicated
// core-only service (the WeCom managed core) must not turn the Feishu fleet
// into copies of that core: the supervisor spreads its env into every daemon,
// bot-registry ignores bots.json whenever BOTMUX_CORE_ONLY=1, and a daemon
// records its SESSION_DATA_DIR in the shared ~/.botmux/.data-dir breadcrumb.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFleetDaemonEnv } from '../src/core/fleet-runtime.js';
import { wecomManagedCoreEnvironment } from '../src/im/wecom/config/managed-core-env.js';
import { buildBotWorkerEnv, buildSessionChildEnv, type EnvPolicy } from '../src/core/env-policy.js';
import { pinCoreOnlyServiceDataDir, scrubSessionTurnMarkerEnv } from '../src/utils/child-env.js';
import { buildBotmuxEnvAssignments } from '../src/adapters/backend/tmux-backend.js';
import { atomicWriteFileSync } from '../src/utils/atomic-write.js';
import { config } from '../src/config.js';
import { spawnSyncTsEvalWithRepoImports, spawnSyncTsScript } from './helpers/ts-runner.js';
import { productionFunction } from './helpers/codex-async-answer-function-harness.js';
import { isCoreOnlyEnv } from '../src/core/runtime-mode.js';
import { DAEMON_ENV_KEYS } from '../src/cli/daemon-lifecycle-env.js';
import { captureDetachedRestartEnvFallback } from '../src/core/restart-env-refresh.js';
import type { FleetDaemonEnvFileRead } from '../src/core/fleet-runtime.js';
import { tmuxEnv } from '../src/setup/ensure-tmux.js';
import { prependBotmuxBin, resolveBotmuxWrapperBinDir } from '../src/core/botmux-wrapper.js';

const FEISHU_APP_ID = 'cli_fixture_feishu';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Host { home: string; fleetDataDir: string; coreStateDir: string }

/** A host running a Feishu fleet (one bot, its daemon's data-dir breadcrumb)
 * and a WeCom managed core with its own dedicated store under the same HOME. */
function host(): Host {
  const home = mkdtempSync(join(tmpdir(), 'fleet-env-core-session-'));
  roots.push(home);
  const fleetDataDir = join(home, '.botmux', 'data');
  const coreStateDir = join(home, '.botmux', 'wecom', 'fixture', 'core');
  mkdirSync(fleetDataDir, { recursive: true });
  mkdirSync(coreStateDir, { recursive: true });
  writeFileSync(breadcrumbPath(home), fleetDataDir);
  writeFileSync(join(home, '.botmux', 'bots.json'), JSON.stringify([
    { name: 'feishu-a', larkAppId: FEISHU_APP_ID, larkAppSecret: 'fixture-secret', cliId: 'codex' },
  ]));
  return { home, fleetDataDir, coreStateDir };
}

function breadcrumbPath(home: string): string {
  return join(home, '.botmux', '.data-dir');
}

/** What the gateway hands its managed core (the real producer). */
function managedCoreSpawnEnv(h: Host): NodeJS.ProcessEnv {
  return wecomManagedCoreEnvironment({
    managedCore: {
      botId: 'local_wecom_fixture', cli: 'codex', backend: 'pty',
      workingDirectory: h.home, port: 19998, stateDir: h.coreStateDir,
    },
  }, { HOME: h.home, PATH: process.env.PATH, SESSION_DATA_DIR: h.fleetDataDir });
}

/** The CLI env of a PTY session of that core: the core entry freezes (and, from
 * this build on, marks) its dedicated store, then the worker and session
 * boundaries run; the PTY child inherits the result wholesale. */
function wecomCorePtySessionEnv(
  h: Host,
  options: { coreBuildMarksStore?: boolean; envPolicy?: EnvPolicy } = {},
): NodeJS.ProcessEnv {
  const coreProcessEnv = { ...managedCoreSpawnEnv(h) };
  if (options.coreBuildMarksStore === false) {
    coreProcessEnv.SESSION_DATA_DIR = coreProcessEnv.BOTMUX_CORE_STATE_DIR;
  } else {
    pinCoreOnlyServiceDataDir(coreProcessEnv, coreProcessEnv.BOTMUX_CORE_STATE_DIR!);
  }
  return {
    ...buildSessionChildEnv(buildBotWorkerEnv(coreProcessEnv, options.envPolicy), options.envPolicy),
    BOTMUX_SESSION_ID: 'fixture-session',
    BOTMUX_LARK_APP_ID: 'local_wecom_fixture',
    BOTMUX_API_ONLY: '1',
  };
}

/** What a tmux pane of a session receives: the tmux client env carries no
 * BOTMUX* key, so the session's values arrive only through the pane's
 * `env KEY=VAL` prefix (buildBotmuxEnvAssignments over BOTMUX_INJECTED_ENV_KEYS). */
function tmuxPaneEnv(h: Host, sessionEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const pane: NodeJS.ProcessEnv = { HOME: h.home, PATH: process.env.PATH };
  for (const assignment of buildBotmuxEnvAssignments(sessionEnv)) {
    const eq = assignment.indexOf('=');
    if (eq > 0 && !assignment.startsWith('-')) pane[assignment.slice(0, eq)] = assignment.slice(eq + 1);
  }
  return pane;
}

/** CLI pass (supervisor spawn env), then the supervisor's own boot scrub and
 * pass (FleetSupervisor.daemonEnv), then spawnBot's per-bot index. */
function feishuDaemonEnv(sessionEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const supervisorEnv = resolveFleetDaemonEnv(sessionEnv, { status: 'missing' }, {});
  scrubSessionTurnMarkerEnv(supervisorEnv);
  return { ...resolveFleetDaemonEnv(supervisorEnv, { status: 'missing' }), BOTMUX_BOT_INDEX: '0' };
}

/** The bot list bot-registry loads in a process with `env`. */
function loadedBotIds(env: NodeJS.ProcessEnv): string[] {
  const registryUrl = new URL('../src/bot-registry.js', import.meta.url).href;
  const result = spawnSyncTsEvalWithRepoImports([
    `import { loadBotConfigs } from ${JSON.stringify(registryUrl)};`,
    `process.stdout.write(JSON.stringify(loadBotConfigs().map(bot => bot.larkAppId)));`,
  ].join('\n'), { env, encoding: 'utf8', timeout: 60_000 });
  expect(result.status, String(result.stderr ?? '')).toBe(0);
  return JSON.parse(String(result.stdout));
}

/** Boot-time PID/breadcrumb write of a Feishu daemon whose process env is
 * `daemonEnv`: daemon.ts's own writePidFile and getPidFile, with the real
 * config resolution and a fenced HOME. Wrapper scripts are out of scope. */
function bootFeishuDaemonPidFile(h: Host, daemonEnv: NodeJS.ProcessEnv): void {
  vi.stubEnv('SESSION_DATA_DIR', daemonEnv.SESSION_DATA_DIR ?? '');
  const scope: Record<string, any> = {
    config,
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    atomicWriteFileSync,
    join,
    homedir: () => h.home,
    process: { env: daemonEnv, pid: process.pid, execPath: process.execPath, platform: process.platform },
    isCoreOnlyProcess: () => isCoreOnlyEnv(daemonEnv),
    BOTMUX_BIN_DIR: join(h.home, '.botmux', 'bin'),
    __dirname: h.home,
    isStandaloneBinary: () => false,
    botmuxWrapperFiles: () => [],
    logger: { info() {}, warn() {} },
  };
  scope.getPidFile = productionFunction('src/daemon.ts', 'getPidFile', scope);
  productionFunction('src/daemon.ts', 'writePidFile', scope)();
}

const CORE_SESSION_FORMS = [
  { backend: 'pty', sessionEnv: (h: Host) => wecomCorePtySessionEnv(h) },
  { backend: 'tmux', sessionEnv: (h: Host) => tmuxPaneEnv(h, wecomCorePtySessionEnv(h)) },
  {
    backend: 'tmux, strict envPolicy',
    sessionEnv: (h: Host) => tmuxPaneEnv(h, wecomCorePtySessionEnv(h, { envPolicy: { mode: 'strict' } })),
  },
] as const;

describe('fleet env after a restart typed in a WeCom core session', () => {
  it('a tmux pane of the core carries the core store but none of its identity', () => {
    const h = host();
    const pane = tmuxPaneEnv(h, wecomCorePtySessionEnv(h));
    expect(pane.SESSION_DATA_DIR).toBe(h.coreStateDir);
    expect(pane.BOTMUX_CORE_ONLY).toBeUndefined();
  });

  it.each(CORE_SESSION_FORMS)('$backend: a supervised Feishu daemon still loads its own bot from bots.json', ({ sessionEnv }) => {
    expect(loadedBotIds(feishuDaemonEnv(sessionEnv(host())))).toEqual([FEISHU_APP_ID]);
  }, 90_000);

  it.each(CORE_SESSION_FORMS)('$backend: the fleet keeps its own store and none of the core identity', ({ sessionEnv }) => {
    const h = host();
    const daemonEnv = feishuDaemonEnv(sessionEnv(h));
    expect(daemonEnv.SESSION_DATA_DIR).toBe(h.fleetDataDir);
    const coreKeys = [...Object.keys(managedCoreSpawnEnv(h)), 'BOTMUX_CORE_ONLY_DATA_DIR'].filter(key => /^BOTMUX_(CORE_|API_)/.test(key));
    for (const key of coreKeys) expect(daemonEnv[key], key).toBeUndefined();
  });

  it.each(CORE_SESSION_FORMS)('$backend: the booted daemon leaves the ~/.botmux/.data-dir breadcrumb on the fleet store', ({ sessionEnv }) => {
    const h = host();
    bootFeishuDaemonPidFile(h, feishuDaemonEnv(sessionEnv(h)));
    expect(readFileSync(breadcrumbPath(h.home), 'utf8')).toBe(h.fleetDataDir);
  });

  it('a core started before the store marker existed is still recognised', () => {
    const h = host();
    const sessionEnv = wecomCorePtySessionEnv(h, { coreBuildMarksStore: false });
    expect(sessionEnv.BOTMUX_CORE_ONLY_DATA_DIR).toBeUndefined();
    const daemonEnv = feishuDaemonEnv(sessionEnv);
    expect(daemonEnv.SESSION_DATA_DIR).toBe(h.fleetDataDir);
    expect(daemonEnv.BOTMUX_CORE_ONLY).toBeUndefined();
  });

  it.each(CORE_SESSION_FORMS)('$backend: an explicit SESSION_DATA_DIR typed in the core session is kept', ({ sessionEnv }) => {
    const h = host();
    const daemonEnv = feishuDaemonEnv({ ...sessionEnv(h), SESSION_DATA_DIR: '/operator/elsewhere' });
    expect(daemonEnv.SESSION_DATA_DIR).toBe('/operator/elsewhere');
    expect(daemonEnv.BOTMUX_CORE_ONLY).toBeUndefined();
    expect(daemonEnv.BOTMUX_CORE_ONLY_DATA_DIR).toBeUndefined();
  });

  it('the store marker is inert: botmux commands in a core tmux pane load the same registry as without it', () => {
    const h = host();
    expect(loadedBotIds(tmuxPaneEnv(h, wecomCorePtySessionEnv(h)))).toEqual([FEISHU_APP_ID]);
  }, 90_000);
});

describe('fleet env after a restart typed anywhere else', () => {
  it('an ordinary session restart keeps its environment as before', () => {
    const h = host();
    const ordinarySession: NodeJS.ProcessEnv = {
      HOME: h.home,
      PATH: process.env.PATH,
      BOTMUX_SESSION_ID: 'fixture-session',
      SESSION_DATA_DIR: '/operator/pinned/data',
      // `botmux serve --api-only` reads these as defaults; outside a core-only
      // process they are inert and stay the operator's business.
      BOTMUX_API_PORT: '18080',
      BOTMUX_CORE_CLI: 'codex',
    };
    const daemonEnv = feishuDaemonEnv(ordinarySession);
    expect(daemonEnv.SESSION_DATA_DIR).toBe('/operator/pinned/data');
    expect(daemonEnv.BOTMUX_API_PORT).toBe('18080');
    expect(daemonEnv.BOTMUX_CORE_CLI).toBe('codex');
  });

  it('a tmux pane of a Feishu session keeps its SESSION_DATA_DIR', () => {
    const h = host();
    // A Feishu worker's session env; only BOTMUX_INJECTED_ENV_KEYS reach the pane.
    const feishuSession: NodeJS.ProcessEnv = {
      ...buildSessionChildEnv(buildBotWorkerEnv({ HOME: h.home, PATH: process.env.PATH, SESSION_DATA_DIR: '/operator/pinned/data' })),
      BOTMUX_SESSION_ID: 'fixture-session',
      BOTMUX_LARK_APP_ID: FEISHU_APP_ID,
    };
    const pane = tmuxPaneEnv(h, feishuSession);
    expect(pane.SESSION_DATA_DIR).toBe('/operator/pinned/data');
    expect(feishuDaemonEnv(pane).SESSION_DATA_DIR).toBe('/operator/pinned/data');
  });

  it('an ordinary shell start with an explicit SESSION_DATA_DIR keeps it', () => {
    const h = host();
    const daemonEnv = feishuDaemonEnv({ HOME: h.home, PATH: process.env.PATH, SESSION_DATA_DIR: '/operator/pinned/data' });
    expect(daemonEnv.SESSION_DATA_DIR).toBe('/operator/pinned/data');
  });
});

/** The worker process of that core (its env, before any session boundary). */
function wecomCoreWorkerEnv(h: Host): NodeJS.ProcessEnv {
  const coreProcessEnv = { ...managedCoreSpawnEnv(h) };
  pinCoreOnlyServiceDataDir(coreProcessEnv, coreProcessEnv.BOTMUX_CORE_STATE_DIR!);
  return buildBotWorkerEnv(coreProcessEnv);
}

/** A tmux pane as it really is: the server's global environment, which the first
 * client seeded (tmuxEnv of the worker that started the server), under the
 * pane's own `env KEY=VAL` prefix. */
function tmuxPaneOnServerEnv(h: Host, serverSeededBy: NodeJS.ProcessEnv, sessionEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...tmuxEnv(serverSeededBy), ...tmuxPaneEnv(h, sessionEnv) };
}

/**
 * `botmux restart` typed with `invokerEnv`: inside a session it refreshes from
 * the persisted file and falls back to a snapshot of the session's own settings
 * (prepareRestartDriverContext), then the supervisor scrubs and resolves again.
 * `file` is what readFleetDaemonEnvFile returns: `failed` for a missing or
 * unreadable ~/.botmux/.env, `loaded` otherwise — never `missing`.
 */
function restartedFleetEnv(invokerEnv: NodeJS.ProcessEnv, file: FleetDaemonEnvFileRead): NodeJS.ProcessEnv {
  const inSession = Boolean(invokerEnv.BOTMUX_SESSION_ID?.trim());
  const cliPass = resolveFleetDaemonEnv({ ...invokerEnv }, file, {
    refreshPersistedEnv: inSession,
    ...(inSession ? { readFailureFallback: captureDetachedRestartEnvFallback(invokerEnv) } : {}),
  });
  scrubSessionTurnMarkerEnv(cliPass);
  return resolveFleetDaemonEnv(cliPass, file, false);
}

const ENV_FILES: ReadonlyArray<{ label: string; file: FleetDaemonEnvFileRead }> = [
  { label: '.env missing or unreadable', file: { status: 'failed' } },
  { label: '.env without host settings', file: { status: 'loaded', text: 'BOTMUX_LANG=zh\n' } },
  { label: '.env with host settings', file: { status: 'loaded', text: 'WEB_EXTERNAL_HOST=file.example\nBOTMUX_WORKER_HTTP_HOST=10.9.9.9\n' } },
];

const REAL_CORE_SESSIONS = [
  { backend: 'pty', sessionEnv: (h: Host) => wecomCorePtySessionEnv(h) },
  { backend: 'tmux', sessionEnv: (h: Host) => tmuxPaneOnServerEnv(h, wecomCoreWorkerEnv(h), wecomCorePtySessionEnv(h)) },
] as const;

describe('fleet lifecycle settings after a restart typed in a WeCom core session', () => {
  const cases = REAL_CORE_SESSIONS.flatMap(session => ENV_FILES.map(env => ({ ...session, ...env })));

  it.each(cases)('$backend, $label: every lifecycle setting matches a restart from a plain terminal', ({ sessionEnv, file }) => {
    const h = host();
    const fromSession = restartedFleetEnv(sessionEnv(h), file);
    const fromTerminal = restartedFleetEnv({ HOME: h.home, PATH: process.env.PATH }, file);
    for (const key of DAEMON_ENV_KEYS) expect(fromSession[key], key).toBe(fromTerminal[key]);
  });

  it('keeps a host set explicitly in the core session to something else', () => {
    const h = host();
    const fleet = restartedFleetEnv({ ...wecomCorePtySessionEnv(h), WEB_EXTERNAL_HOST: 'host.example' }, { status: 'failed' });
    expect(fleet.WEB_EXTERNAL_HOST).toBe('host.example');
  });

  it('a Feishu session that runs on loopback keeps it', () => {
    const h = host();
    const feishuSession: NodeJS.ProcessEnv = {
      ...buildSessionChildEnv(buildBotWorkerEnv({
        HOME: h.home,
        PATH: process.env.PATH,
        WEB_EXTERNAL_HOST: '127.0.0.1',
        BOTMUX_WORKER_HTTP_HOST: '127.0.0.1',
      })),
      BOTMUX_SESSION_ID: 'fixture-session',
      BOTMUX_LARK_APP_ID: FEISHU_APP_ID,
    };
    const fleet = restartedFleetEnv(feishuSession, { status: 'failed' });
    expect(fleet.WEB_EXTERNAL_HOST).toBe('127.0.0.1');
    expect(fleet.BOTMUX_WORKER_HTTP_HOST).toBe('127.0.0.1');
  });
});

describe('tmux server environment seeded by a worker', () => {
  it('a WeCom core worker does not hand its loopback terminal host to the shared tmux server', () => {
    const h = host();
    expect(wecomCoreWorkerEnv(h).WEB_EXTERNAL_HOST).toBe('127.0.0.1');
    expect(tmuxEnv(wecomCoreWorkerEnv(h)).WEB_EXTERNAL_HOST).toBeUndefined();
  });

  it('a host set to something else in a core worker still reaches the server', () => {
    const h = host();
    expect(tmuxEnv({ ...wecomCoreWorkerEnv(h), WEB_EXTERNAL_HOST: 'host.example' }).WEB_EXTERNAL_HOST).toBe('host.example');
  });

  it('a Feishu worker\'s exported host keeps seeding the server, loopback included', () => {
    const h = host();
    const feishuWorker = buildBotWorkerEnv({ HOME: h.home, PATH: process.env.PATH, WEB_EXTERNAL_HOST: '127.0.0.1' });
    expect(tmuxEnv(feishuWorker).WEB_EXTERNAL_HOST).toBe('127.0.0.1');
  });
});

describe('a core session that does not refresh from the persisted file', () => {
  // No BOTMUX_SESSION_ID (a shell that dropped it, a launcher that scrubbed the
  // turn markers): `botmux start/restart` then takes lifecycle values from the
  // invoking environment itself rather than from ~/.botmux/.env.
  it.each(ENV_FILES.slice(0, 2))('$label: lifecycle settings still match a plain terminal', ({ file }) => {
    const h = host();
    const { BOTMUX_SESSION_ID: _dropped, ...sessionWithoutId } = wecomCorePtySessionEnv(h);
    const fromSession = restartedFleetEnv(sessionWithoutId, file);
    const fromTerminal = restartedFleetEnv({ HOME: h.home, PATH: process.env.PATH }, file);
    for (const key of DAEMON_ENV_KEYS) expect(fromSession[key], key).toBe(fromTerminal[key]);
  });
});

/** What the core's worker adds for its CLI (worker.ts): the wrapper directory it
 * resolves for itself, exported and put at the front of PATH. */
function withCoreWorkerWrapper(h: Host, sessionEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const wrapperBin = resolveBotmuxWrapperBinDir(wecomCoreWorkerEnv(h));
  return { ...sessionEnv, BOTMUX_WRAPPER_BIN: wrapperBin, PATH: prependBotmuxBin(wrapperBin, sessionEnv.PATH) };
}

const CLAIM_SCRIPT = fileURLToPath(new URL('../scripts/claim-botmux-bin.mjs', import.meta.url));

const WRAPPED_CORE_SESSIONS = [
  { backend: 'pty', sessionEnv: (h: Host) => withCoreWorkerWrapper(h, wecomCorePtySessionEnv(h)) },
  {
    backend: 'tmux',
    // The pane gets BOTMUX_WRAPPER_BIN through its env prefix; its login shim puts it in front of PATH.
    sessionEnv: (h: Host): NodeJS.ProcessEnv => {
      const pane = tmuxPaneOnServerEnv(h, wecomCoreWorkerEnv(h), withCoreWorkerWrapper(h, wecomCorePtySessionEnv(h)));
      return { ...pane, PATH: prependBotmuxBin(pane.BOTMUX_WRAPPER_BIN!, pane.PATH) };
    },
  },
] as const;

describe('the core\'s botmux wrapper directory after a restart typed in its session', () => {
  const cases = WRAPPED_CORE_SESSIONS.flatMap(session => ENV_FILES.map(env => ({ ...session, ...env })));

  it.each(cases)('$backend, $label: the fleet neither uses nor opts out of a wrapper because of the core', ({ sessionEnv, file }) => {
    const h = host();
    const session = sessionEnv(h);
    const coreWrapperBin = session.BOTMUX_WRAPPER_BIN!;
    expect(coreWrapperBin.endsWith(join('core', 'bin'))).toBe(true);
    const fleet = restartedFleetEnv(session, file);
    const fromTerminal = restartedFleetEnv({ HOME: h.home, PATH: process.env.PATH }, file);
    expect(fleet.BOTMUX_WRAPPER_BIN).toBe(fromTerminal.BOTMUX_WRAPPER_BIN);
    expect(fleet.BOTMUX_NO_CLAIM).toBe(fromTerminal.BOTMUX_NO_CLAIM);
    expect(fleet.PATH!.split(':')).toEqual(session.PATH!.split(':').filter(entry => entry !== coreWrapperBin));
    expect(resolveBotmuxWrapperBinDir(fleet)).toBe(resolveBotmuxWrapperBinDir(fromTerminal));
  });

  it('keeps an explicit wrapper directory of another build, and every other PATH entry in order', () => {
    const h = host();
    const session = withCoreWorkerWrapper(h, wecomCorePtySessionEnv(h));
    const coreWrapperBin = session.BOTMUX_WRAPPER_BIN!;
    const candidate = join(h.home, 'candidate', 'bin');
    const neighbour = join(h.home, '.botmux', 'wecom', 'fixture', 'core', 'bin2');
    const fleet = restartedFleetEnv({
      ...session,
      BOTMUX_WRAPPER_BIN: candidate,
      PATH: [coreWrapperBin, join(h.home, 'tools', 'bin'), neighbour, coreWrapperBin, '/usr/bin'].join(':'),
    }, { status: 'failed' });
    expect(fleet.BOTMUX_WRAPPER_BIN).toBe(candidate);
    expect(fleet.PATH).toBe([join(h.home, 'tools', 'bin'), neighbour, '/usr/bin'].join(':'));
  });

  it('still recognises the core\'s directory once the connection\'s store is deleted', () => {
    const h = host();
    mkdirSync(join(h.coreStateDir, 'bin'), { recursive: true });
    // Resolved while the directory existed (realpath form, as the worker exports it).
    const session = withCoreWorkerWrapper(h, wecomCorePtySessionEnv(h));
    const coreWrapperBin = session.BOTMUX_WRAPPER_BIN!;
    rmSync(h.coreStateDir, { recursive: true, force: true });
    const fleet = restartedFleetEnv(session, { status: 'failed' });
    expect(fleet.BOTMUX_WRAPPER_BIN).toBeUndefined();
    expect(fleet.PATH!.split(':')).not.toContain(coreWrapperBin);
  });

  it('drops the directory of a core started before the store marker existed', () => {
    const h = host();
    // A core-only entry without the marker froze SESSION_DATA_DIR to its store and
    // nothing else; its PTY sessions still carry BOTMUX_CORE_ONLY=1.
    const session = withCoreWorkerWrapper(h, wecomCorePtySessionEnv(h, { coreBuildMarksStore: false }));
    expect(session.BOTMUX_CORE_ONLY).toBe('1');
    expect(session.BOTMUX_CORE_ONLY_DATA_DIR).toBeUndefined();
    const coreWrapperBin = session.BOTMUX_WRAPPER_BIN!;
    const fleet = restartedFleetEnv(session, { status: 'failed' });
    const fromTerminal = restartedFleetEnv({ HOME: h.home, PATH: process.env.PATH }, { status: 'failed' });
    expect(fleet.BOTMUX_WRAPPER_BIN).toBe(fromTerminal.BOTMUX_WRAPPER_BIN);
    expect(fleet.PATH!.split(':')).not.toContain(coreWrapperBin);
  });

  it('recognises the core\'s directory spelled through another path to the same store', () => {
    const h = host();
    const alias = join(h.home, 'core-alias');
    symlinkSync(h.coreStateDir, alias);
    const session = withCoreWorkerWrapper(h, wecomCorePtySessionEnv(h));
    const fleet = restartedFleetEnv({ ...session, BOTMUX_WRAPPER_BIN: join(alias, 'bin') }, { status: 'failed' });
    expect(fleet.BOTMUX_WRAPPER_BIN).toBeUndefined();
  });

  it('goes by the core\'s marker when SESSION_DATA_DIR was set to another store for the restart', () => {
    const h = host();
    const session = withCoreWorkerWrapper(h, wecomCorePtySessionEnv(h));
    const coreWrapperBin = session.BOTMUX_WRAPPER_BIN!;
    const elsewhere = join(h.home, 'operator', 'data');
    const fleet = restartedFleetEnv({ ...session, SESSION_DATA_DIR: elsewhere }, { status: 'failed' });
    expect(fleet.SESSION_DATA_DIR).toBe(elsewhere);
    expect(fleet.BOTMUX_WRAPPER_BIN).toBeUndefined();
    expect(fleet.PATH!.split(':')).not.toContain(coreWrapperBin);
  });

  it('a use:here run in the core session leaves the global botmux wrapper alone', () => {
    const h = host();
    const globalWrapper = join(h.home, '.botmux', 'bin', 'botmux');
    const claim = (env: NodeJS.ProcessEnv) => {
      const run = spawnSyncTsScript(CLAIM_SCRIPT, [], { env, encoding: 'utf8', timeout: 60_000 });
      expect(run.status, String(run.stderr ?? '')).toBe(0);
    };
    claim(withCoreWorkerWrapper(h, wecomCorePtySessionEnv(h)));
    expect(existsSync(globalWrapper)).toBe(false);
    // The same run from a plain terminal of this HOME does repoint it.
    claim({ HOME: h.home, PATH: process.env.PATH });
    expect(existsSync(globalWrapper)).toBe(true);
  }, 90_000);

  it('keeps an opt-out the core did not set', () => {
    const h = host();
    const fleet = restartedFleetEnv({ ...wecomCorePtySessionEnv(h), BOTMUX_NO_CLAIM: 'yes' }, { status: 'failed' });
    expect(fleet.BOTMUX_NO_CLAIM).toBe('yes');
  });

  it('a Feishu session keeps its own wrapper directory, opt-out and PATH as they were', () => {
    const h = host();
    const candidate = join(h.home, 'candidate', 'bin');
    const feishuSession: NodeJS.ProcessEnv = {
      ...buildSessionChildEnv(buildBotWorkerEnv({ HOME: h.home, PATH: process.env.PATH })),
      BOTMUX_SESSION_ID: 'fixture-session',
      BOTMUX_LARK_APP_ID: FEISHU_APP_ID,
      BOTMUX_WRAPPER_BIN: candidate,
      BOTMUX_NO_CLAIM: '1',
      PATH: [candidate, join(h.home, '.botmux', 'bin'), '/usr/bin'].join(':'),
    };
    const fleet = restartedFleetEnv(feishuSession, { status: 'failed' });
    expect(fleet.BOTMUX_WRAPPER_BIN).toBe(candidate);
    expect(fleet.BOTMUX_NO_CLAIM).toBe('1');
    expect(fleet.PATH).toBe(feishuSession.PATH);
  });
});
