import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FleetSupervisor, pidAlive } from '../src/core/fleet-supervisor.js';
import { readFleetState } from '../src/core/fleet-state-store.js';
import {
  fleetHealthMembers,
  fleetStopWaitMs,
  WECOM_FLEET_EXIT_WAIT_MS,
  resolveDashboardSpec,
  resolveFleetBots,
  resolveFleetMembers,
  resolveTopicIndexSpec,
  wecomFleetMemberNames,
} from '../src/core/fleet-runtime.js';
import { resolveWecomFleetMembers } from '../src/core/fleet-wecom-members.js';
import { resolveCliSpawn } from '../src/core/self-spawn.js';
import { FLEET_DAEMON_EXIT_WAIT_MS } from '../src/core/shutdown-budgets.js';
import { WECOM_GATEWAY_KILL_TIMEOUT_MS } from '../src/im/wecom/config/gateway-budgets.js';
import type { FleetState } from '../src/core/fleet-supervisor-policy.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import { setWecomFleetDesiredState, wecomFleetDesiredStatePath } from '../src/im/wecom/config/fleet-desired-state.js';
import { isWecomFleetMemberName, wecomFleetConfigHash, WecomFleetUnavailableError } from '../src/im/wecom/config/fleet-members.js';
import { hasParsableWecomConfig } from '../src/im/wecom/config/fleet-config-presence.js';
import {
  WECOM_FLEET_MEMBER_ENV,
  WECOM_GATEWAY_NO_RESTART_EXIT_CODE,
  wecomFleetMemberName,
} from '../src/im/wecom/contract/fleet-member.js';

const dirs: string[] = [];
const supervisors: FleetSupervisor[] = [];
afterEach(async () => {
  for (const sup of supervisors.splice(0)) await sup.stopAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(join(homedir(), '.botmux'), { recursive: true, force: true });
});
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wecom-members-'));
  dirs.push(dir);
  return dir;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await delay(25);
  }
  return fn();
}

function validConfig(botId: string): string {
  return `${JSON.stringify({
    botId,
    coreUrl: 'http://127.0.0.1:18080',
    secretFile: '/nonexistent/secret',
    allowedUsers: ['user-1'],
  }, null, 2)}\n`;
}

/** Write a configuration and list it in the registry of `wecomRoot`. */
function addConnection(wecomRoot: string, file: string, text = validConfig('bot')): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  const registry = join(wecomRoot, 'config-registry.json');
  const paths: string[] = existsSync(registry) ? JSON.parse(readFileSync(registry, 'utf8')).paths : [];
  mkdirSync(wecomRoot, { recursive: true });
  writeFileSync(registry, JSON.stringify({ version: 1, paths: [...new Set([...paths, file])] }));
  return wecomConfigId(file);
}

function writeBots(bots: unknown[]): void {
  mkdirSync(join(homedir(), '.botmux'), { recursive: true });
  writeFileSync(join(homedir(), '.botmux', 'bots.json'), JSON.stringify(bots));
}

const BOTS = [
  { name: 'alpha', larkAppId: 'cli_alpha', larkAppSecret: 's' },
  { larkAppId: 'cli_beta', larkAppSecret: 's' },
];

describe('fleet members without WeCom configuration', () => {
  it('are exactly the bots, the dashboard and the topic indexer, and the health gate covers the bots and the dashboard', () => {
    writeBots(BOTS);
    const members = resolveFleetMembers();
    expect(members).toEqual([...resolveFleetBots(), resolveDashboardSpec(), resolveTopicIndexSpec()]);
    expect(members.map(m => m.name)).toEqual(['botmux-alpha', 'botmux-1', 'botmux-dashboard', 'topic-index']);
    expect(fleetHealthMembers().map(m => m.name)).toEqual(['botmux-alpha', 'botmux-1', 'botmux-dashboard']);
    expect(wecomFleetMemberNames()).toEqual([]);
  });
});

describe('resolveWecomFleetMembers', () => {
  it('makes a member only of a running connection whose configuration exists', () => {
    const base = tmp();
    const wecomRoot = join(base, 'wecom');
    const running = addConnection(wecomRoot, join(base, 'running', 'config.json'));
    const stopped = addConnection(wecomRoot, join(base, 'stopped', 'config.json'));
    addConnection(wecomRoot, join(base, 'unrecorded', 'config.json'));
    const deletedFile = join(base, 'deleted', 'config.json');
    const deleted = addConnection(wecomRoot, deletedFile);
    rmSync(deletedFile);
    setWecomFleetDesiredState(running, 'running', { root: wecomRoot });
    setWecomFleetDesiredState(stopped, 'stopped', { root: wecomRoot });
    setWecomFleetDesiredState(deleted, 'running', { root: wecomRoot });

    const resolution = resolveWecomFleetMembers({ distDir: '/opt/dist', baseEnv: {}, readEnvFileText: () => undefined, wecomRoot });
    expect(resolution.members.map(m => m.name)).toEqual([wecomFleetMemberName(running)]);
    expect(resolution.indeterminate).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('leaves a running connection whose configuration is unreadable indeterminate', () => {
    const base = tmp();
    const wecomRoot = join(base, 'wecom');
    const file = join(base, 'locked', 'config.json');
    const id = addConnection(wecomRoot, file);
    setWecomFleetDesiredState(id, 'running', { root: wecomRoot });
    chmodSync(file, 0o000);
    try {
      const resolution = resolveWecomFleetMembers({ distDir: '/opt/dist', baseEnv: {}, readEnvFileText: () => undefined, wecomRoot });
      expect(resolution.members).toEqual([]);
      expect(resolution.indeterminate).toEqual([wecomFleetMemberName(id)]);
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it('builds a gateway member spec that runs `wecom --config <file>` in the supervisor\'s own shape', () => {
    const base = tmp();
    const wecomRoot = join(base, 'wecom');
    const file = join(base, 'conn', 'config.json');
    const text = validConfig('bot-a');
    const id = addConnection(wecomRoot, file, text);
    setWecomFleetDesiredState(id, 'running', { root: wecomRoot });

    const [spec] = resolveWecomFleetMembers({ distDir: '/opt/dist', baseEnv: {}, readEnvFileText: () => undefined, wecomRoot }).members;
    const expected = resolveCliSpawn(join('/opt/dist', 'cli.js'), ['wecom', '--config', file]);
    expect(spec).toMatchObject({
      name: wecomFleetMemberName(id),
      appId: '',
      group: 'wecom',
      logBaseName: wecomFleetMemberName(id),
      external: {
        command: expected.command,
        args: expected.args,
        cwd: dirname(file),
        configHash: wecomFleetConfigHash(text),
      },
    });
    expect(spec.external!.env![WECOM_FLEET_MEMBER_ENV]).toBe('1');
    expect(spec.external!.restartPolicy!.noRestartExitCodes).toContain(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);

    writeFileSync(file, validConfig('bot-b'));
    const [changed] = resolveWecomFleetMembers({ distDir: '/opt/dist', baseEnv: {}, readEnvFileText: () => undefined, wecomRoot }).members;
    expect(changed.external!.configHash).not.toBe(spec.external!.configHash);
  });

  it('adds the Dashboard\'s .env allowlist where the base env has no value, and nothing else', () => {
    const base = tmp();
    const wecomRoot = join(base, 'wecom');
    const id = addConnection(wecomRoot, join(base, 'conn', 'config.json'));
    setWecomFleetDesiredState(id, 'running', { root: wecomRoot });
    const envFileText = [
      'HTTPS_PROXY=http://proxy.example:3128',
      'CLI_ID=from-file',
      'GITHUB_TOKEN=not-for-the-gateway',
      'BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET=dashboard-only',
    ].join('\n');

    const [spec] = resolveWecomFleetMembers({
      distDir: '/opt/dist',
      baseEnv: { CLI_ID: 'from-fleet' },
      readEnvFileText: () => envFileText,
      wecomRoot,
    }).members;
    expect(spec.external!.env).toEqual({
      HTTPS_PROXY: 'http://proxy.example:3128',
      [WECOM_FLEET_MEMBER_ENV]: '1',
    });
  });

  it('makes one member, and leaves a note, when two connections map to the same member name', () => {
    // Two configuration ids sharing the 12 hex digits of the name: the registry
    // cannot produce that on demand, so the connection list is handed in.
    const shared = wecomFleetMemberName('f'.repeat(64));
    const connection = (file: string, id: string) => ({
      configId: id,
      file,
      memberName: shared,
      desired: 'running' as const,
      config: { presence: 'present' as const, text: validConfig('bot') },
    });
    const resolution = resolveWecomFleetMembers({
      distDir: '/opt/dist',
      baseEnv: {},
      readEnvFileText: () => undefined,
      connections: [
        connection('/first/config.json', 'f'.repeat(64)),
        connection('/second/config.json', `${'f'.repeat(12)}${'0'.repeat(52)}`),
      ],
    });

    expect(resolution.members.map(m => m.name)).toEqual([shared]);
    expect(resolution.members[0].external!.args).toContain('/first/config.json');
    expect(resolution.indeterminate).toEqual([]);
    expect(resolution.notes.some(note => note.includes('/second/config.json'))).toBe(true);
  });

  it('reads ~/.botmux/.env only when there is a gateway to start', () => {
    const base = tmp();
    const wecomRoot = join(base, 'wecom');
    const id = addConnection(wecomRoot, join(base, 'conn', 'config.json'));
    let reads = 0;
    const readEnvFileText = () => { reads += 1; return 'HTTPS_PROXY=http://p:1'; };

    resolveWecomFleetMembers({ distDir: '/opt/dist', baseEnv: {}, readEnvFileText, wecomRoot }); // unrecorded
    setWecomFleetDesiredState(id, 'stopped', { root: wecomRoot });
    resolveWecomFleetMembers({ distDir: '/opt/dist', baseEnv: {}, readEnvFileText, wecomRoot });
    expect(reads).toBe(0);

    setWecomFleetDesiredState(id, 'running', { root: wecomRoot });
    resolveWecomFleetMembers({ distDir: '/opt/dist', baseEnv: {}, readEnvFileText, wecomRoot });
    expect(reads).toBe(1);
  });

  it('refuses to answer when the desired-state file or the registry is damaged', () => {
    const base = tmp();
    const wecomRoot = join(base, 'wecom');
    const id = addConnection(wecomRoot, join(base, 'conn', 'config.json'));
    setWecomFleetDesiredState(id, 'running', { root: wecomRoot });
    const resolve = () => resolveWecomFleetMembers({ distDir: '/opt/dist', baseEnv: {}, readEnvFileText: () => undefined, wecomRoot });
    expect(resolve().members).toHaveLength(1);

    writeFileSync(wecomFleetDesiredStatePath(wecomRoot), '{ damaged');
    expect(resolve).toThrow(WecomFleetUnavailableError);

    rmSync(wecomFleetDesiredStatePath(wecomRoot));
    setWecomFleetDesiredState(id, 'running', { root: wecomRoot });
    writeFileSync(join(wecomRoot, 'config-registry.json'), '{"version":7}');
    expect(resolve).toThrow(WecomFleetUnavailableError);
  });
});

describe('fleet members with WeCom configuration', () => {
  function configureHomeConnection(): string {
    const wecomRoot = join(homedir(), '.botmux', 'wecom');
    const id = addConnection(wecomRoot, join(wecomRoot, 'config.json'));
    setWecomFleetDesiredState(id, 'running', { root: wecomRoot });
    return wecomFleetMemberName(id);
  }

  it('appends running WeCom members after the dashboard but keeps them out of the health gate', () => {
    writeBots(BOTS);
    const name = configureHomeConnection();

    expect(resolveFleetMembers().map(m => m.name)).toEqual(['botmux-alpha', 'botmux-1', 'botmux-dashboard', 'topic-index', name]);
    expect(fleetHealthMembers().map(m => m.name)).toEqual(['botmux-alpha', 'botmux-1', 'botmux-dashboard']);
    expect(wecomFleetMemberNames()).toEqual([name]);
  });

  it('still returns the Feishu members when the WeCom source is damaged', () => {
    writeBots(BOTS);
    configureHomeConnection();
    writeFileSync(wecomFleetDesiredStatePath(join(homedir(), '.botmux', 'wecom')), 'not json');
    const logged: string[] = [];

    expect(resolveFleetMembers({ log: m => logged.push(m) })).toEqual([...resolveFleetBots(), resolveDashboardSpec(), resolveTopicIndexSpec()]);
    expect(logged.some(line => line.includes('wecom'))).toBe(true);
  });
});

describe('hasParsableWecomConfig', () => {
  it('needs a registered configuration that parses', () => {
    const base = tmp();
    const wecomRoot = join(base, 'wecom');
    expect(hasParsableWecomConfig(wecomRoot)).toBe(false);

    mkdirSync(wecomRoot, { recursive: true });
    writeFileSync(join(wecomRoot, 'config.json'), '{"botId":"x"}'); // default path, invalid
    expect(hasParsableWecomConfig(wecomRoot)).toBe(false);

    addConnection(wecomRoot, join(base, 'elsewhere', 'config.json'), validConfig('bot'));
    expect(hasParsableWecomConfig(wecomRoot)).toBe(true);
  });
});

describe('WeCom member naming and budgets', () => {
  it('recognises gateway member names and nothing a Feishu member is called', () => {
    expect(isWecomFleetMemberName(wecomFleetMemberName(wecomConfigId('/x/config.json')))).toBe(true);
    for (const name of ['botmux-dashboard', 'botmux-0', 'botmux-wecom-abc', 'botmux-plugin-x', 'wecom-', 'wecom-XYZ123456789']) {
      expect(isWecomFleetMemberName(name)).toBe(false);
    }
  });

});

describe('stop wait with WeCom gateways', () => {
  const state = (procs: Array<{ name: string; pid: number; status: 'online' | 'stopped' | 'launching' }>): FleetState => ({
    supervisorPid: 0,
    supervisorStartedAt: '',
    procs: procs.map(p => ({ ...p, appId: '', generation: 1, restarts: 0, lastExitCode: null, startedAt: null })),
  });
  const gateway = wecomFleetMemberName(wecomConfigId('/x/config.json'));

  it('is exactly the requested wait for a fleet without a live gateway', () => {
    const feishuOnly = state([
      { name: 'botmux-0', pid: process.pid, status: 'online' },
      { name: 'botmux-dashboard', pid: process.pid, status: 'online' },
    ]);
    for (const requested of [0, 15_000, FLEET_DAEMON_EXIT_WAIT_MS]) {
      expect(fleetStopWaitMs(requested, null)).toBe(requested);
      expect(fleetStopWaitMs(requested, feishuOnly)).toBe(requested);
      expect(fleetStopWaitMs(requested, state([{ name: gateway, pid: 0, status: 'stopped' }]))).toBe(requested);
      expect(fleetStopWaitMs(requested, state([{ name: gateway, pid: 0, status: 'launching' }]))).toBe(requested);
    }
  });

  it('covers a live gateway\'s whole kill timeout, never shortening a longer request', () => {
    const withGateway = state([{ name: gateway, pid: process.pid, status: 'online' }]);
    expect(fleetStopWaitMs(FLEET_DAEMON_EXIT_WAIT_MS, withGateway)).toBeGreaterThan(WECOM_GATEWAY_KILL_TIMEOUT_MS);
    const longer = WECOM_GATEWAY_KILL_TIMEOUT_MS * 10;
    expect(fleetStopWaitMs(longer, withGateway)).toBe(longer);
  });

  // External protocol value: systemd's DefaultTimeoutStopSec. The Linux boot unit
  // runs `ExecStop=botmux stop` without a TimeoutStopSec of its own.
  const SYSTEMD_DEFAULT_TIMEOUT_STOP_MS = 90_000;

  it('the longest wait for a fleet with a live gateway stays inside systemd\'s default stop timeout', () => {
    const withGateway = state([{ name: gateway, pid: process.pid, status: 'online' }]);
    expect(fleetStopWaitMs(FLEET_DAEMON_EXIT_WAIT_MS, withGateway)).toBe(WECOM_FLEET_EXIT_WAIT_MS);
    expect(WECOM_FLEET_EXIT_WAIT_MS).toBeLessThan(SYSTEMD_DEFAULT_TIMEOUT_STOP_MS);
  });

  // What `ExecStop=botmux stop` spends besides that wait must fit in what is
  // left of systemd's 90 s: starting the CLI (one to two seconds on a cold
  // cache), taking the fleet mutation lock (a `botmux wecom` command holds it
  // for milliseconds, but may sit on the desired-state file's 5 s lock wait while
  // it does), and the final check of the supervisor. 10 s covers that with room.
  const STOP_COMMAND_OUTSIDE_THE_WAIT_MS = 10_000;

  it('leaves `botmux stop` room around that wait before systemd kills the unit', () => {
    expect(SYSTEMD_DEFAULT_TIMEOUT_STOP_MS - WECOM_FLEET_EXIT_WAIT_MS).toBeGreaterThanOrEqual(STOP_COMMAND_OUTSIDE_THE_WAIT_MS);
  });

  it('gives each gateway member the gateway\'s own kill timeout', () => {
    const base = tmp();
    const wecomRoot = join(base, 'wecom');
    const id = addConnection(wecomRoot, join(base, 'conn', 'config.json'));
    setWecomFleetDesiredState(id, 'running', { root: wecomRoot });
    const [spec] = resolveWecomFleetMembers({ distDir: '/opt/dist', baseEnv: {}, readEnvFileText: () => undefined, wecomRoot }).members;
    expect(spec.external!.killTimeoutMs).toBe(WECOM_GATEWAY_KILL_TIMEOUT_MS);
  });
});

describe('group reconcile against the real WeCom resolver (live supervisor)', () => {
  it('stops a connection set to stopped, removes one whose configuration was deleted, starts a new running one', async () => {
    const base = tmp();
    const wecomRoot = join(base, 'wecom');
    const statePath = join(base, 'fleet.json');
    const launches = join(base, 'launches');
    // Stand-in gateway: the supervisor runs `<execPath> <dist>/cli.js wecom --config <file>`.
    const dist = join(base, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'cli.js'),
      `require('fs').appendFileSync(${JSON.stringify(launches)}, process.argv.slice(2).join(' ') + String.fromCharCode(10));`
      + `process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`);
    const fileA = join(base, 'a', 'config.json');
    const fileB = join(base, 'b', 'config.json');
    const fileC = join(base, 'c', 'config.json');
    const a = addConnection(wecomRoot, fileA);
    const b = addConnection(wecomRoot, fileB);
    setWecomFleetDesiredState(a, 'running', { root: wecomRoot });
    setWecomFleetDesiredState(b, 'running', { root: wecomRoot });
    const resolve = () => resolveWecomFleetMembers({ distDir: dist, baseEnv: {}, readEnvFileText: () => undefined, wecomRoot });

    const sup = new FleetSupervisor({ statePath, distDir: dist, daemonEnv: {}, cwd: base, log: () => {}, resolveGroup: resolve });
    supervisors.push(sup);
    sup.start(resolve().members);
    const row = (id: string) => readFleetState(statePath)?.procs.find(p => p.name === wecomFleetMemberName(id));
    expect(await waitFor(() => row(a)?.status === 'online' && row(b)?.status === 'online')).toBe(true);
    const pids = [row(a)!.pid, row(b)!.pid];

    setWecomFleetDesiredState(a, 'stopped', { root: wecomRoot });
    rmSync(fileB);
    const c = addConnection(wecomRoot, fileC);
    setWecomFleetDesiredState(c, 'running', { root: wecomRoot });
    const result = await sup.reconcileGroup('wecom');

    expect(result).toMatchObject({
      status: 'reconciled',
      removed: [wecomFleetMemberName(a), wecomFleetMemberName(b)],
      started: [wecomFleetMemberName(c)],
    });
    expect(row(a)).toBeUndefined();
    expect(row(b)).toBeUndefined();
    expect(pids.some(pidAlive)).toBe(false);
    // The first two gateways can be stopped before either wrote a line, so the
    // file may not exist yet when the third one has only just been spawned.
    expect(await waitFor(() => existsSync(launches) && readFileSync(launches, 'utf8').includes(`wecom --config ${fileC}`))).toBe(true);
    expect(row(c)).toMatchObject({ status: 'online' });
  });
});

describe('what a WeCom resolution tells the supervisor about each member besides its spec', () => {
  it('carries each connection\'s recorded intent, with when and by whom it was recorded', async () => {
    const base = tmp();
    const wecomRoot = join(base, 'wecom');
    const byPerson = addConnection(wecomRoot, join(base, 'a', 'config.json'));
    const byGateway = addConnection(wecomRoot, join(base, 'b', 'config.json'));
    const { setWecomFleetDesiredStopped } = await import('../src/im/wecom/config/fleet-desired-state.js');
    setWecomFleetDesiredState(byPerson, 'running', { root: wecomRoot, now: () => new Date('2026-11-18T10:00:00.000Z') });
    setWecomFleetDesiredStopped(byGateway, 'replaced', { root: wecomRoot, now: () => new Date('2026-11-18T11:00:00.000Z') });

    const resolution = resolveWecomFleetMembers({ distDir: '/opt/dist', baseEnv: {}, readEnvFileText: () => undefined, wecomRoot });
    expect(resolution.intents?.get(wecomFleetMemberName(byPerson)))
      .toEqual({ desired: 'running', recordedAt: Date.parse('2026-11-18T10:00:00.000Z'), automatic: false });
    expect(resolution.intents?.get(wecomFleetMemberName(byGateway)))
      .toEqual({ desired: 'stopped', recordedAt: Date.parse('2026-11-18T11:00:00.000Z'), automatic: true });
  });

  it('names a member whose own gateway reports, in its runtime record, that it is shutting down', async () => {
    const { readDurableProcessIdentity } = await import('../src/utils/process-identity.js');
    const { wecomBotRoot } = await import('../src/im/wecom/config/runtime.js');
    const base = tmp();
    const wecomRoot = join(base, 'wecom');
    const id = addConnection(wecomRoot, join(base, 'a', 'config.json'), validConfig('bot-a'));
    setWecomFleetDesiredState(id, 'running', { root: wecomRoot });
    const record = (phase: string, processStart = readDurableProcessIdentity(process.pid)!, configId = id) => {
      mkdirSync(wecomBotRoot('bot-a', wecomRoot), { recursive: true });
      writeFileSync(join(wecomBotRoot('bot-a', wecomRoot), 'runtime.json'), JSON.stringify({
        version: 1, configId, pid: process.pid, processStart, instanceId: 'i', connection: 'connected', phase, updatedAt: Date.now(),
      }));
    };
    const resolve = () => resolveWecomFleetMembers({ distDir: '/opt/dist', baseEnv: {}, readEnvFileText: () => undefined, wecomRoot });

    record('stopping');
    expect(resolve().shuttingDown?.get(wecomFleetMemberName(id))).toBe(process.pid);
    record('running');
    expect(resolve().shuttingDown?.size).toBe(0);
    // A record whose birth identity is not this process's, or of another configuration, proves nothing.
    record('stopping', 'someone-else');
    expect(resolve().shuttingDown?.size).toBe(0);
    record('stopping', undefined, 'f'.repeat(64));
    expect(resolve().shuttingDown?.size).toBe(0);
  });
});
