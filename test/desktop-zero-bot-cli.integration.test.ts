import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listFleetApps } from '../src/desktop/main/fleet-apps.js';
import { locateDashboard } from '../src/desktop/main/runtime-actions.js';
import { createRuntimeService } from '../src/desktop/main/runtime-service.js';
import {
  createZeroBotLifecycle,
  isSupervisorOwnedByBundledRuntime,
  readLiveSupervisorSnapshot,
} from '../src/desktop/main/zero-bot-lifecycle.js';
import { readFleetState } from '../src/core/fleet-state-store.js';
import { pidAlive } from '../src/core/fleet-supervisor.js';
import {
  createDesktopHostLeaseRegistry,
  parseStopIfEmptyCliOutcome,
} from '../src/core/desktop-host-leases.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const CLI_DIST = join(REPO_ROOT, 'dist', 'cli.js');
const activeHomes: string[] = [];

async function reserveFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('failed to allocate port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolvePort(port));
    });
  });
}

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-0bot-e2e-'));
  activeHomes.push(dir);
  return dir;
}

function cliEnv(home: string, port: number, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    BOTMUX_FENCED_RUN: '1',
    BOTMUX_TOPIC_SEARCH: '0',
    BOTMUX_DASHBOARD_PORT: String(port),
    SESSION_DATA_DIR: join(home, '.botmux', 'data'),
    ...extra,
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 25_000): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI_DIST, ...args], {
      env,
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      code: typeof err?.status === 'number' ? err.status : 1,
      stdout: String(err?.stdout ?? ''),
      stderr: String(err?.stderr ?? err?.message ?? ''),
    };
  }
}

afterEach(() => {
  while (activeHomes.length > 0) {
    const home = activeHomes.pop()!;
    const botmuxHome = join(home, '.botmux');
    const statePath = join(botmuxHome, 'fleet-state.json');
    try {
      if (existsSync(statePath)) {
        const state = readFleetState(statePath);
        if (state?.supervisorPid && pidAlive(state.supervisorPid)) {
          runCli(['stop'], { ...process.env, HOME: home, BOTMUX_FENCED_RUN: '1' }, 10_000);
        }
        // Fallback kill if stop failed in a broken-config test.
        const after = existsSync(statePath) ? readFleetState(statePath) : null;
        if (after?.supervisorPid && pidAlive(after.supervisorPid)) {
          try { process.kill(after.supervisorPid, 'SIGKILL'); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    rmSync(home, { recursive: true, force: true });
  }
});

describe('0-bot CLI + Desktop end-to-end onboarding lifecycle', () => {
  it('keeps bare `botmux start` rejecting missing config, and fails closed on corrupted bots.json even with --allow-empty', async () => {
    const home = makeTempHome();
    const port = await reserveFreePort();
    const env = cliEnv(home, port);

    const bare = runCli(['start'], env);
    expect(bare.code).not.toBe(0);
    expect(`${bare.stdout}\n${bare.stderr}`).toContain('botmux setup');
    expect(existsSync(join(home, '.botmux', 'bots.json'))).toBe(false);

    // Corrupted bots.json must fail closed and stay untouched under --allow-empty.
    const botmuxHome = join(home, '.botmux');
    const botsJson = join(botmuxHome, 'bots.json');
    execFileSync('mkdir', ['-p', botmuxHome]);
    const broken = '{ invalid json';
    writeFileSync(botsJson, broken);

    const failed = runCli(['start', '--allow-empty'], env);
    expect(failed.code).not.toBe(0);
    expect(readFileSync(botsJson, 'utf-8')).toBe(broken);

    const nonArray = '{}';
    writeFileSync(botsJson, nonArray);
    const failedNonArray = runCli(['start', '--allow-empty'], env);
    expect(failedNonArray.code).not.toBe(0);
    expect(readFileSync(botsJson, 'utf-8')).toBe(nonArray);
  });

  it('boots 0-bot supervisor strictly on 127.0.0.1 with 0o700 ~/.botmux, locates Dashboard, and cleanly reaps on quit via stop --if-empty', async () => {
    const home = makeTempHome();
    const port = await reserveFreePort();
    const botmuxHome = join(home, '.botmux');
    const paths = {
      botmuxHome,
      dataDir: join(botmuxHome, 'data'),
      logsDir: join(botmuxHome, 'logs'),
    };
    const bundled = {
      kind: 'bundled' as const,
      root: REPO_ROOT,
      cliPath: CLI_DIST,
      nodePath: process.execPath,
      version: '1.0.0',
      runtimeSource: 'bundled' as const,
    };

    const rawRuntime = createRuntimeService({
      paths,
      appVersion: '1.0.0',
      execPath: process.execPath,
      env: cliEnv(home, port, { BOTMUX_SESSION_ID: 'leaked-session-marker' }),
      fs: { existsSync, readFileSync },
      bundledRuntime: bundled,
      fleetApps: () => listFleetApps(paths),
    });

    const lifecycle = createZeroBotLifecycle({
      runtime: rawRuntime,
      readLiveSupervisor: () => readLiveSupervisorSnapshot(botmuxHome),
      isOwnedByApp: live => isSupervisorOwnedByBundledRuntime(live, bundled),
    });

    // Cold state: 0 bots, idle -> not_configured + runtimeManaged: true
    const before = await lifecycle.runtime.getState();
    expect(before.status).toBe('not_configured');
    expect(before.runtimeManaged).toBe(true);
    expect(before.botCount).toBe(0);

    // Start 0-bot onboarding runtime
    const startResult = await lifecycle.runtime.start();
    expect(startResult.code).toBe(0);
    expect(existsSync(join(botmuxHome, 'bots.json'))).toBe(false);
    expect(statSync(botmuxHome).mode & 0o777).toBe(0o700);

    const runningState = await lifecycle.runtime.getState();
    expect(runningState.status).toBe('running');
    expect(runningState.botCount).toBe(0);
    expect(runningState.onlineDaemonCount).toBe(0);
    expect(runningState.runtimeManaged).toBe(true);

    // Dashboard URL is strictly 127.0.0.1, passes /__desktop/compat, and serves /api/settings + /api/dashboard/v1/summary cleanly.
    const located = await locateDashboard(lifecycle.runtime);
    expect(located.ok).toBe(true);
    if (!located.ok) throw new Error(located.message);
    const parsedUrl = new URL(located.url);
    expect(parsedUrl.hostname).toBe('127.0.0.1');
    const token = parsedUrl.searchParams.get('t');
    expect(token).toBeTruthy();

    const authCookie = `botmux_dashboard_token=${token}`;
    const settingsRes = await fetch(`${parsedUrl.origin}/api/settings`, {
      headers: { cookie: authCookie },
    });
    expect(settingsRes.status).toBe(200);
    const settingsBody = await settingsRes.json() as { authed?: boolean; configuredBotCount?: number };
    expect(settingsBody.authed).toBe(true);
    expect(settingsBody.configuredBotCount).toBe(0);

    const summaryRes = await fetch(`${parsedUrl.origin}/api/dashboard/v1/summary`, {
      headers: { cookie: authCookie },
    });
    expect(summaryRes.status).toBe(200);

    const supervisorBeforeQuit = readLiveSupervisorSnapshot(botmuxHome);
    expect(supervisorBeforeQuit).not.toBeNull();
    const supervisorPid = supervisorBeforeQuit!.supervisorPid;
    expect(pidAlive(supervisorPid)).toBe(true);

    // Mismatched --supervisor-pid must refuse to stop the live supervisor.
    const wrongPidStop = runCli(['stop', '--if-empty', '--supervisor-pid', String(supervisorPid + 9999)], cliEnv(home, port));
    expect(wrongPidStop.code).toBe(0);
    expect(pidAlive(supervisorPid)).toBe(true);

    // Quit without adding any bot: cleanly reaps supervisor & dashboard, leaves NO watchdog-stopped marker.
    const cleanupOutcome = await lifecycle.cleanupOnQuit({ totalTimeoutMs: 10_000 });
    expect(cleanupOutcome).toBe('stopped');
    expect(pidAlive(supervisorPid)).toBe(false);
    expect(existsSync(join(botmuxHome, 'watchdog-stopped'))).toBe(false);

    const afterQuit = await lifecycle.runtime.getState();
    expect(afterQuit.status).toBe('not_configured');
  }, 45_000);

  it('transitions seamlessly from 0-bot to 1-bot without restarting Dashboard and protects the 1-bot fleet from stop --if-empty', async () => {
    const home = makeTempHome();
    const port = await reserveFreePort();
    const botmuxHome = join(home, '.botmux');
    const paths = {
      botmuxHome,
      dataDir: join(botmuxHome, 'data'),
      logsDir: join(botmuxHome, 'logs'),
    };
    const bundled = {
      kind: 'bundled' as const,
      root: REPO_ROOT,
      cliPath: CLI_DIST,
      nodePath: process.execPath,
      version: '1.0.0',
      runtimeSource: 'bundled' as const,
    };

    const rawRuntime = createRuntimeService({
      paths,
      appVersion: '1.0.0',
      execPath: process.execPath,
      env: cliEnv(home, port),
      fs: { existsSync, readFileSync },
      bundledRuntime: bundled,
      fleetApps: () => listFleetApps(paths),
    });

    const lifecycle = createZeroBotLifecycle({
      runtime: rawRuntime,
      readLiveSupervisor: () => readLiveSupervisorSnapshot(botmuxHome),
      isOwnedByApp: live => isSupervisorOwnedByBundledRuntime(live, bundled),
    });

    expect((await lifecycle.runtime.start()).code).toBe(0);
    const supervisorBefore = readLiveSupervisorSnapshot(botmuxHome)!;
    const located = await locateDashboard(lifecycle.runtime);
    expect(located.ok).toBe(true);
    if (!located.ok) throw new Error(located.message);
    const parsedUrl = new URL(located.url);
    const token = parsedUrl.searchParams.get('t')!;

    // Persist a local bot in bots.json (simulating Dashboard onboarding save) and verify
    // runtime-service transitions to botCount: 1 while supervisor stays alive AND stop --if-empty refuses to stop it.
    writeFileSync(join(botmuxHome, 'bots.json'), JSON.stringify([
      {
        larkAppId: 'local_first_bot',
        apiOnly: true,
        localIdentity: true,
        cliId: 'claude-code',
        defaultWorkingDir: home,
      },
    ], null, 2));

    const settingsRes = await fetch(`${parsedUrl.origin}/api/settings`, {
      headers: { cookie: `botmux_dashboard_token=${token}` },
    });
    const settingsBody = await settingsRes.json() as { configuredBotCount?: number };
    expect(settingsBody.configuredBotCount).toBe(1);

    const stateAfterFirstBot = await lifecycle.runtime.getState();
    expect(stateAfterFirstBot.status).toBe('running');
    expect(stateAfterFirstBot.botCount).toBe(1);
    expect(stateAfterFirstBot.runtimeManaged).toBe(true);

    // Direct CLI `stop --if-empty` must refuse once 1+ bot exists.
    const guardStop = runCli(['stop', '--if-empty', '--supervisor-pid', String(supervisorBefore.supervisorPid)], cliEnv(home, port));
    expect(guardStop.code).toBe(0);
    expect(pidAlive(supervisorBefore.supervisorPid)).toBe(true);

    // Desktop quit cleanup must also refuse (skip) even if observeState was never called.
    const quitOutcome = await lifecycle.cleanupOnQuit();
    expect(quitOutcome).toBe('skipped-configured');
    expect(pidAlive(supervisorBefore.supervisorPid)).toBe(true);

    // `botmux stop --supervisor-pid <pid>` without `--if-empty` must fail closed (exit 2)
    // without touching the live 1-bot fleet or writing watchdog-stopped.
    const barePidStop = runCli(['stop', '--supervisor-pid', '99999999'], cliEnv(home, port));
    expect(barePidStop.code).toBe(2);
    expect(pidAlive(supervisorBefore.supervisorPid)).toBe(true);
    expect(existsSync(join(botmuxHome, 'watchdog-stopped'))).toBe(false);

    // Plain `botmux restart` (without `--allow-empty`) must fail closed on structurally
    // invalid bots.json entries like `[null]` and leave the live supervisor untouched.
    writeFileSync(join(botmuxHome, 'bots.json'), '[null]');
    const badRestart = runCli(['restart'], cliEnv(home, port));
    expect(badRestart.code).not.toBe(0);
    expect(pidAlive(supervisorBefore.supervisorPid)).toBe(true);
  }, 45_000);

  it('enforces 127.0.0.1 loopback bind on `start --allow-empty` even when BOTMUX_SESSION_ID and BOTMUX_DASHBOARD_HOST=0.0.0.0 are inherited', async () => {
    const home = makeTempHome();
    const port = await reserveFreePort();
    const botmuxHome = join(home, '.botmux');
    execFileSync('mkdir', ['-p', '-m', '700', botmuxHome]);
    // Persisted .env sets only the test port; inherited session env tries to force 0.0.0.0.
    writeFileSync(join(botmuxHome, '.env'), `BOTMUX_DASHBOARD_PORT=${port}\n`, { mode: 0o600 });
    const env = cliEnv(home, port, {
      BOTMUX_SESSION_ID: 'sess_inherited_test',
      BOTMUX_DASHBOARD_HOST: '0.0.0.0',
    });

    const startRes = runCli(['start', '--allow-empty'], env);
    expect(startRes.code).toBe(0);
    const dashLog = readFileSync(join(botmuxHome, 'logs', 'dashboard-out.log'), 'utf-8');
    expect(dashLog).toContain(`listening on 127.0.0.1:${port}`);
    expect(dashLog).not.toContain('listening on 0.0.0.0:');
  }, 45_000);

  it('fences stop --if-empty against another attested Desktop host lease and enforces 0->1 start-bot dependency preflight with clean JSON output', async () => {
    const home = makeTempHome();
    const port = await reserveFreePort();
    const botmuxHome = join(home, '.botmux');
    const env = cliEnv(home, port);

    expect(runCli(['start', '--allow-empty'], env).code).toBe(0);
    const sup = readLiveSupervisorSnapshot(botmuxHome)!;
    expect(sup).not.toBeNull();

    // Standalone `--host-pid` without `--if-empty` must fail closed (exit 2).
    const bareHostPidStop = runCli(['stop', '--host-pid', String(process.pid)], env);
    expect(bareHostPidStop.code).toBe(2);
    expect(pidAlive(sup.supervisorPid)).toBe(true);

    // Register an attested Desktop host lease for the current process, then run
    // `stop --if-empty --host-pid <otherPid>`: CLI must see our live lease under
    // the fleet lock, emit skipped:other-host, and leave the supervisor alive.
    const lease = createDesktopHostLeaseRegistry(botmuxHome, { selfPid: process.pid });
    expect(await lease.ensureRegistered()).toBe(true);
    try {
      const fencedStop = runCli(
        ['stop', '--if-empty', '--supervisor-pid', String(sup.supervisorPid), '--host-pid', String(process.pid + 12345)],
        env,
      );
      expect(fencedStop.code).toBe(0);
      expect(parseStopIfEmptyCliOutcome(fencedStop.stdout)).toBe('skipped:other-host');
      expect(pidAlive(sup.supervisorPid)).toBe(true);
    } finally {
      lease.unregister();
    }

    // 0->1 start-bot dependency preflight: an hc bot with a missing hc binary must
    // return clean structured JSON `{ ok: false, reason: 'dependency_missing' }`
    // with zero stdout pollution and must not spawn the daemon.
    writeFileSync(join(botmuxHome, 'bots.json'), JSON.stringify([
      {
        larkAppId: 'local_hc_missing',
        apiOnly: true,
        localIdentity: true,
        cliId: 'claude-code',
        backendType: 'hc',
        defaultWorkingDir: home,
      },
    ], null, 2));
    const missingDepStart = runCli(
      ['start-bot', 'local_hc_missing', '--json'],
      cliEnv(home, port, { BOTMUX_HC_BIN: join(home, 'nonexistent-hc') }),
    );
    expect(missingDepStart.code).toBe(1);
    const parsedMissing = JSON.parse(missingDepStart.stdout.trim());
    expect(parsedMissing).toMatchObject({ ok: false, reason: 'dependency_missing' });
    expect(parsedMissing.message).toContain('herdr-core');
  }, 45_000);

  it('never publishes an unfenced host lease when the fleet mutation lock times out', async () => {
    const home = makeTempHome();
    const botmuxHome = join(home, '.botmux');
    mkdirSync(botmuxHome, { recursive: true });
    const lockTarget = join(botmuxHome, 'pm2-fleet-mutation');
    const holder = spawnTsEvalWithRepoImports(`
      import { withFileLock } from './src/utils/file-lock.js';
      await withFileLock(process.env.PROBE_LOCK, async () => {
        console.log('LOCKED');
        await new Promise(resolve => { process.stdin.once('data', resolve); });
      }, { maxWaitMs: 2_000 });
    `, {
      env: { ...process.env, PROBE_LOCK: lockTarget },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let lease: ReturnType<typeof createDesktopHostLeaseRegistry> | undefined;
    try {
      await new Promise<void>((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error('lock holder did not start')), 5_000);
        holder.stdout?.on('data', chunk => {
          if (!String(chunk).includes('LOCKED')) return;
          clearTimeout(timer);
          resolveReady();
        });
      });
      lease = createDesktopHostLeaseRegistry(botmuxHome, { selfPid: process.pid, lockMaxWaitMs: 30 });
      expect(await lease.ensureRegistered()).toBe(false);
      expect(existsSync(join(botmuxHome, '.desktop-host-leases', `host-${process.pid}.json`))).toBe(false);
      expect(holder.exitCode).toBeNull();
    } finally {
      lease?.unregister();
      if (holder.exitCode === null && holder.signalCode === null) holder.stdin?.write('release');
      if (holder.exitCode === null && holder.signalCode === null) {
        await new Promise<void>(resolveExit => {
          const timer = setTimeout(() => { holder.kill('SIGKILL'); resolveExit(); }, 2_000);
          holder.once('exit', () => { clearTimeout(timer); resolveExit(); });
        });
      }
    }
  }, 10_000);
});
