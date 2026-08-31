// Child processes the dashboard forks on the HOST: `botmux start-bot/stop-bot`
// (onboarding brings a bot online without a fleet restart), the global
// npm/pnpm/bun install behind the update button, and — for a local-dev
// checkout — the `git pull` / `pnpm build` steps behind the local update button.
//
// One shared rule, and the reason this lives in its own module: every one of
// them runs with `redactChildEnv(process.env)`, never raw process.env. The
// dashboard holds the Feishu H5 login family by design (index-dashboard.ts is
// the only channel for it, APP_SECRET included) plus whatever the host
// environment carries; a global install additionally runs arbitrary npm
// lifecycle scripts, and `start-bot` hands its env to pm2, which persists it
// into the managed app's metadata and dump.pm2. Neither has any consumer for
// those credentials.
//
// Extracted from dashboard.ts so the env each child actually receives can be
// asserted in a test — dashboard.ts is a side-effect module (importing it binds
// ports and starts probes), so nothing inside it is reachable from a unit test.
import { spawn } from 'node:child_process';
import { botmuxCliEntry } from '../utils/install-info.js';
import { resolveCliSpawn } from '../core/self-spawn.js';
import { globalInstallUpdateCwd } from '../core/maintenance.js';
import { redactChildEnv } from '../utils/child-env.js';
import type { GlobalInstallPlan } from '../utils/global-install.js';

export interface BotLifecycleSpawnResult {
  ok: boolean;
  message?: string;
}

/** `botmux <verb>-bot <appId> --json` with a redacted env. */
function spawnBotLifecycleCli(
  verb: 'start-bot' | 'stop-bot',
  appId: string,
  timeoutLabel: string,
  okMessage: (processName: string) => string,
): Promise<BotLifecycleSpawnResult> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    const done = (r: BotLifecycleSpawnResult) => { if (!settled) { settled = true; resolve(r); } };
    try {
      const { command, args } = resolveCliSpawn(botmuxCliEntry(), [verb, appId, '--json']);
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        // NOT process.env: this child re-enters the botmux CLI, which invokes
        // pm2 — pm2 bakes the caller env into the managed app and into
        // dump.pm2, so a raw copy would persist the dashboard's H5 APP_SECRET
        // on disk and hand it to every bot daemon. The fresh daemon resolves
        // its own settings from ~/.botmux/.env (index-daemon.ts) and bots.json.
        env: redactChildEnv(process.env),
        // Run from HOME, not the dashboard's cwd (pm2 `cwd: PKG_ROOT`): a global
        // package update replaces that dir, so a still-running dashboard would spawn
        // start-bot in a deleted directory (uv_cwd/ENOENT). See globalInstallUpdateCwd.
        cwd: globalInstallUpdateCwd(),
      });
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        done({ ok: false, message: timeoutLabel });
      }, 30_000);
      timer.unref?.();
      child.stdout?.on('data', (d) => { out += String(d); });
      child.stderr?.on('data', (d) => { err += String(d); });
      child.on('error', (e) => {
        clearTimeout(timer);
        done({ ok: false, message: e instanceof Error ? e.message : String(e) });
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        // `<verb>-bot --json` prints a single result object; prefer its own
        // message/processName over the raw exit code.
        let parsed: any;
        try { parsed = JSON.parse(out.trim()); } catch { /* non-JSON → fall through */ }
        if (code === 0) {
          done({ ok: true, message: parsed?.processName ? okMessage(parsed.processName) : undefined });
        } else {
          done({ ok: false, message: parsed?.message || err.trim() || `${verb} 退出码 ${code}` });
        }
      });
    } catch (e) {
      done({ ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  });
}

/**
 * Bring a freshly-onboarded bot online without a fleet-wide restart by spawning
 * `botmux start-bot <appId> --json` (see cli.ts:ensureBotDaemonStarted). The new
 * daemon is forked+supervised by pm2 (reparented off this process), self-registers
 * and opens its Feishu WSClient, then publishes a descriptor the DaemonRegistry
 * auto-discovers — so no dashboard reload is needed either. Runs `botmux` on the
 * SAME host as the dashboard (shared pm2 home / bots.json — the documented
 * dashboard↔daemon co-location assumption). Resolves best-effort; the caller
 * falls back to the restart hint on failure.
 */
export function spawnStartBotLive(appId: string): Promise<BotLifecycleSpawnResult> {
  return spawnBotLifecycleCli('start-bot', appId, 'start-bot 超时（30s）', name => `${name} 已上线`);
}

export function spawnStopBotLive(appId: string): Promise<BotLifecycleSpawnResult> {
  return spawnBotLifecycleCli('stop-bot', appId, 'stop-bot 超时（30s）', name => `${name} 已停止`);
}

/**
 * Run the ownership-aware npm/pnpm/Bun update for the manual-update flow WITHOUT blocking
 * the event loop (async spawn, not execSync — the dashboard must keep serving
 * during the ~10-30s install). Resolves on exit 0; rejects with the tail of
 * stdout/stderr on a non-zero exit, spawn error, or 3-minute timeout. Args are
 * a fixed literal — no shell interpolation of untrusted input.
 */
export function runGlobalInstall(plan: GlobalInstallPlan): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
      cwd: globalInstallUpdateCwd(),
      // A package install runs arbitrary lifecycle scripts (preinstall/postinstall
      // of botmux AND of every dependency) with this env. `plan.env` still wins —
      // it carries the registry/ownership knobs the plan resolved.
      env: { ...redactChildEnv(process.env), ...plan.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // resolve npm.cmd / pnpm.cmd / bun.exe
    });
    let tail = '';
    const capture = (d: Buffer): void => { tail = (tail + d.toString()).slice(-2000); };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${plan.manager} install timed out after 180s`));
    }, 180_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${plan.manager} exited ${code}: ${tail.trim().slice(-500)}`));
    });
  });
}

/**
 * Run one local-dev update step (`git pull --ff-only` / `pnpm build`) in `dir`,
 * capturing output so a failure surfaces an actionable tail rather than a bare
 * exit code. Like the other host children this runs on `redactChildEnv` — the
 * git/pnpm child (and any lifecycle/hook it spawns) must not inherit the
 * dashboard's Feishu H5 credentials; the denylist still keeps PATH/HOME/etc. so
 * the tools resolve normally. 300s timeout (a cold `pnpm build` is slower than a
 * package install). No shell interpolation of untrusted input.
 */
export function runLocalDevStep(dir: string, command: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: dir,
      env: redactChildEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // resolve git / pnpm .cmd shims on win32
    });
    let tail = '';
    const capture = (d: Buffer): void => { tail = (tail + d.toString()).slice(-4000); };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`\`${command} ${args.join(' ')}\` timed out after 300s`));
    }, 300_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`\`${command} ${args.join(' ')}\` exited ${code}: ${tail.trim().slice(-800)}`));
    });
  });
}
