import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { callDashboard, type DashboardResult } from '../../cli/dashboard-endpoint.js';
import { validateBotConfigEntries } from '../../setup/bots-config-validation.js';
import type { DesktopPaths, DesktopRuntimeState, RuntimeSource } from '../shared/types.js';
import { buildBundledBotmuxCommand, buildExternalBotmuxCommand, type BotmuxCommand } from './node-command.js';
import { classifyRuntimeSource, countActiveBotmuxDaemonApps, type FleetAppSummary } from './runtime-source.js';
import { sanitizeDeviceStatusCommandResult } from './device-status.js';

export type BotConfigStatus =
  | { status: 'not_configured'; count: 0 }
  | { status: 'configured'; count: number }
  | { status: 'invalid'; message: string };

/** True when Desktop is running the local 0-bot onboarding dashboard (no configured bots yet). */
export function isZeroBotOnboardingRunning(state: DesktopRuntimeState): boolean {
  return state.status === 'running' && state.botCount === 0;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
}

export interface RunCommandOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

type RunCommand = (cmd: BotmuxCommand, options?: RunCommandOptions) => Promise<RunResult>;
type DashboardEndpointCaller = (path: '/__cli/current') => Promise<DashboardResult>;
const defaultCommandTimeoutMs = 30_000;
const defaultCommandOutputLimitBytes = 1024 * 1024;
const deviceStatusOutputLimitBytes = 4 * 1024;

export interface ExternalRuntimeCandidate {
  kind: 'external';
  root: string;
  cliPath: string;
  binPath: string;
  pathEnv?: string;
  /** Set when binPath is not directly executable: run `<interpreterPath> <cliPath> …`
   *  (a source checkout or npm install started by `bun|node dist/cli.js`). */
  interpreterPath?: string;
  version: string;
  runtimeSource?: 'global-cli';
}

export interface BundledRuntimeCandidate {
  kind: 'bundled';
  root: string;
  cliPath: string;
  nodePath: string;
  version: string;
  runtimeSource: 'bundled';
  /** The bundled runtime is a compiled botmux binary (nodePath === cliPath) that
   *  dispatches its own subcommands, so no script path goes in front of the args. */
  selfDispatching?: boolean;
}

export type RuntimeLaunchTarget = ExternalRuntimeCandidate | BundledRuntimeCandidate;

function defaultRun(
  cmd: BotmuxCommand,
  timeoutMs = defaultCommandTimeoutMs,
  maxOutputBytes = defaultCommandOutputLimitBytes,
  signal?: AbortSignal,
): Promise<RunResult> {
  if (signal?.aborted) {
    return Promise.resolve({
      code: 1,
      stdout: '',
      stderr: 'Command aborted',
      signal: null,
    });
  }
  return new Promise(resolve => {
    const child = spawn(cmd.command, cmd.args, { env: cmd.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let terminationMessage: string | null = null;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let postKillTimer: NodeJS.Timeout | undefined;

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (postKillTimer) clearTimeout(postKillTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve(terminationMessage !== null
        ? { code: 1, stdout, stderr: terminationMessage, signal: result.signal ?? null }
        : result);
    };

    const terminateChild = (forceDelayMs: number, message: string) => {
      if (settled || terminationMessage !== null) return;
      terminationMessage = message;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (child.exitCode !== null || child.signalCode !== null) {
        finish({ code: 1, stdout, stderr: message, signal: child.signalCode });
        return;
      }
      // Wait for actual child exit (bounded by SIGTERM -> forceDelayMs -> SIGKILL
      // -> 200ms fallback) so abortGraceMs genuinely lets the child stop before
      // callers inspect fleet-state.json.
      child.kill();
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        postKillTimer = setTimeout(() => {
          finish({ code: 1, stdout, stderr: message, signal: null });
        }, 200);
        postKillTimer.unref?.();
      }, forceDelayMs);
    };
    const onAbort = () => {
      terminateChild(500, 'Command aborted');
    };
    const timer = setTimeout(() => {
      terminateChild(1_000, `Command timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    const appendOutput = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      if (settled || terminationMessage !== null) return;
      const text = String(chunk);
      const bytes = Buffer.byteLength(text);
      if (outputBytes + bytes > maxOutputBytes) {
        child.kill('SIGKILL');
        finish({
          code: 1,
          stdout,
          stderr: `Command output exceeded ${maxOutputBytes} bytes`,
          signal: null,
        });
        return;
      }
      outputBytes += bytes;
      if (target === 'stdout') stdout += text;
      else stderr += text;
    };

    child.stdout.on('data', chunk => {
      appendOutput('stdout', chunk);
    });
    child.stderr.on('data', chunk => {
      appendOutput('stderr', chunk);
    });
    child.on('error', error => {
      finish({ code: 1, stdout, stderr: stderr || error.message, signal: null });
    });
    child.on('exit', (_code, exitSignal) => {
      // On abort/timeout, settle immediately on child exit instead of waiting for
      // stdio 'close' in case a grandchild inherited open pipes.
      if (terminationMessage !== null) {
        finish({ code: 1, stdout, stderr: terminationMessage, signal: exitSignal });
      }
    });
    child.on('close', (code, closeSignal) => {
      // Signal-only exits still represent a failed desktop action to the UI.
      finish({
        code: code ?? 1,
        stdout,
        stderr: closeSignal && !stderr ? `Process terminated by signal ${closeSignal}` : stderr,
        signal: closeSignal,
      });
    });
  });
}

function dashboardEndpointResultToRunResult(result: DashboardResult): RunResult {
  if (result.ok) {
    const stdout = result.localUrl
      ? `${result.url}\n本地直连(平台异常时可用): ${result.localUrl}`
      : result.url;
    return { code: 0, stdout, stderr: '', signal: null };
  }
  const detail = result.detail ? `: ${result.detail}` : '';
  return { code: 1, stdout: '', stderr: `${result.reason}${detail}`, signal: null };
}

export interface RuntimeServiceDeps {
  paths: DesktopPaths;
  appVersion: string;
  execPath: string;
  env: NodeJS.ProcessEnv;
  fs: {
    existsSync(path: string): boolean;
    readFileSync(path: string, encoding: BufferEncoding): string;
  };
  run?: RunCommand;
  dashboardEndpoint?: DashboardEndpointCaller;
  commandTimeoutMs?: number;
  externalRuntime?: ExternalRuntimeCandidate | null;
  discoverExternalRuntime?: () => ExternalRuntimeCandidate | null;
  bundledRuntime?: BundledRuntimeCandidate;
  /** Probed user shell PATH for bundled-runtime spawns (see probeShellPathEnv). */
  shellPathEnv?: () => string | undefined;
  fleetApps?: () => Promise<FleetAppSummary[]>;
  /**
   * Coexistence with a separately installed CLI. Returns the runtime that owns
   * the LIVE fleet when it is not the bundled one (a global npm/curl install or a
   * source checkout), else null. When provided, Desktop follows that owner:
   * the fleet is reported as running/managed and start/stop/restart are routed
   * through the owner's own CLI instead of replacing it with the bundled runtime.
   * Switching to the bundled runtime stays an explicit `takeover`.
   */
  fleetOwner?: () => ExternalRuntimeCandidate | null;
}

export function createRuntimeService(deps: RuntimeServiceDeps) {
  const run = deps.run ?? ((cmd: BotmuxCommand, options?: RunCommandOptions) => defaultRun(
    cmd,
    options?.timeoutMs ?? deps.commandTimeoutMs,
    options?.maxOutputBytes ?? defaultCommandOutputLimitBytes,
    options?.signal,
  ));
  const botsPath = join(deps.paths.botmuxHome, 'bots.json');
  const installCliMessage = deps.bundledRuntime
    ? 'The bundled botmux runtime is unavailable. Reinstall Botmux Desktop.'
    : 'Install the global botmux CLI with `npm install -g botmux`, then reopen Botmux Desktop.';

  function command(runtime: RuntimeLaunchTarget, args: string[], extraEnv?: NodeJS.ProcessEnv): BotmuxCommand {
    if (runtime.kind === 'bundled') {
      return buildBundledBotmuxCommand({
        nodePath: runtime.nodePath,
        cliPath: runtime.selfDispatching ? undefined : runtime.cliPath,
        botmuxHome: deps.paths.botmuxHome,
        args,
        baseEnv: deps.env,
        pathEnv: deps.shellPathEnv?.(),
        extraEnv,
      });
    }
    return buildExternalBotmuxCommand({
      binPath: runtime.binPath,
      botmuxHome: deps.paths.botmuxHome,
      args,
      baseEnv: deps.env,
      pathEnv: runtime.pathEnv,
      interpreterPath: runtime.interpreterPath,
      extraEnv,
    });
  }

  function zeroBotLoopbackExtraEnv(): NodeJS.ProcessEnv {
    return {
      BOTMUX_DASHBOARD_HOST: deps.env.BOTMUX_DASHBOARD_HOST?.trim() || '127.0.0.1',
    };
  }

  function currentExternalRuntime(): ExternalRuntimeCandidate | null {
    return deps.discoverExternalRuntime ? deps.discoverExternalRuntime() : deps.externalRuntime ?? null;
  }

  function activeRuntime(): RuntimeLaunchTarget | null {
    return deps.bundledRuntime ?? currentExternalRuntime();
  }

  function rejectedCliRequired(): RunResult {
    return {
      code: 1,
      stdout: '',
      stderr: installCliMessage,
      signal: null,
    };
  }

  function invokeRun(cmd: BotmuxCommand, options?: RunCommandOptions): Promise<RunResult> {
    if (!options) return run(cmd);
    const cleaned: RunCommandOptions = {};
    if (options.timeoutMs !== undefined) cleaned.timeoutMs = options.timeoutMs;
    if (options.maxOutputBytes !== undefined) cleaned.maxOutputBytes = options.maxOutputBytes;
    if (options.signal !== undefined) cleaned.signal = options.signal;
    return Object.keys(cleaned).length > 0 ? run(cmd, cleaned) : run(cmd);
  }

  async function runCliAction(
    args: string[],
    options?: RunCommandOptions & { extraEnv?: NodeJS.ProcessEnv },
  ): Promise<RunResult> {
    // A fleet owned by another install is driven through that install, so the
    // app and a manually installed CLI never fight over the same bots.
    const owner = deps.fleetOwner?.() ?? null;
    if (owner) return invokeRun(command(owner, args, options?.extraEnv), options);
    const runtime = activeRuntime();
    if (!runtime) return rejectedCliRequired();

    const state = await service.getState();
    if (!state.runtimeManaged && (state.status === 'running' || state.status === 'degraded')) {
      return {
        code: 1,
        stdout: '',
        stderr: state.message ?? 'Current botmux runtime is not controlled by the selected CLI',
        signal: null,
      };
    }
    return invokeRun(command(runtime, args, options?.extraEnv), options);
  }

  async function runStartOrRestartAction(
    action: 'start' | 'restart',
    options?: RunCommandOptions,
  ): Promise<RunResult> {
    // External CLIs (including older global installs via fleetOwner) may reject
    // `--allow-empty`; only pass `--allow-empty` + loopback override to our
    // bundled runtime when 0 bots are configured.
    const owner = deps.fleetOwner?.() ?? null;
    if (owner) return invokeRun(command(owner, [action]), options);
    const runtime = activeRuntime();
    if (!runtime) return rejectedCliRequired();

    const state = await service.getState();
    if (!state.runtimeManaged && (state.status === 'running' || state.status === 'degraded')) {
      return {
        code: 1,
        stdout: '',
        stderr: state.message ?? 'Current botmux runtime is not controlled by the selected CLI',
        signal: null,
      };
    }
    const inv = startOrRestartInvocation(action, runtime);
    return invokeRun(command(runtime, inv.args, inv.extraEnv), options);
  }

  function externalSource(runtime: RuntimeLaunchTarget): RuntimeSource {
    return runtime.runtimeSource ?? 'global-cli';
  }

  function isRuntimeOwned(runtime: RuntimeLaunchTarget, sourcePath: string | null, sourceVersion: string | null): boolean {
    if (runtime.kind !== 'bundled') return true;
    const ownedPath = Boolean(sourcePath && (sourcePath === runtime.cliPath || sourcePath.startsWith(`${runtime.root}/`)));
    return ownedPath && (!sourceVersion || sourceVersion === runtime.version);
  }

  function readBotConfig(): BotConfigStatus {
    if (!deps.fs.existsSync(botsPath)) return { status: 'not_configured', count: 0 };
    try {
      const parsed = JSON.parse(deps.fs.readFileSync(botsPath, 'utf-8'));
      const validation = validateBotConfigEntries(parsed);
      if (!validation.ok) return { status: 'invalid', message: validation.message };
      if (validation.count === 0) return { status: 'not_configured', count: 0 };
      return { status: 'configured', count: validation.count };
    } catch (err) {
      return { status: 'invalid', message: err instanceof Error ? err.message : String(err) };
    }
  }

  let stateInFlight: Promise<DesktopRuntimeState> | null = null;

  async function computeState(): Promise<DesktopRuntimeState> {
    const config = readBotConfig();
    const active = activeRuntime();
    const selectedSource = active ? externalSource(active) : 'none';

    if (config.status === 'invalid') {
      // A malformed bots.json is actionable user state, not an empty setup.
      return {
        status: 'degraded',
        degradedReason: 'invalid_bots_json',
        appVersion: deps.appVersion,
        runtimeVersion: active?.version ?? null,
        runtimeSource: selectedSource,
        runtimeManaged: false,
        runtimePath: active?.cliPath ?? null,
        botCount: 0,
        onlineDaemonCount: 0,
        attentionCount: 1,
        dashboardUrl: null,
        message: active ? config.message : `${config.message}. ${installCliMessage}`,
      };
    }

    if (!active) {
      if (config.status === 'not_configured') {
        return {
          status: 'not_configured',
          appVersion: deps.appVersion,
          runtimeVersion: null,
          runtimeSource: 'none',
          runtimeManaged: false,
          runtimePath: null,
          botCount: 0,
          onlineDaemonCount: 0,
          attentionCount: 0,
          dashboardUrl: null,
          message: installCliMessage,
        };
      }
      return {
        status: 'degraded',
        degradedReason: 'missing_runtime',
        appVersion: deps.appVersion,
        runtimeVersion: null,
        runtimeSource: 'none',
        runtimeManaged: false,
        runtimePath: null,
        botCount: config.count,
        onlineDaemonCount: 0,
        attentionCount: 1,
        dashboardUrl: null,
        message: installCliMessage,
      };
    }

    if (deps.fleetApps) {
      try {
        const apps = await deps.fleetApps();
        const source = classifyRuntimeSource({ apps });
        const onlineDaemonCount = countActiveBotmuxDaemonApps(apps);
        if (source.running) {
          if (!isRuntimeOwned(active, source.sourcePath, source.sourceVersion)) {
            const owner = deps.fleetOwner?.() ?? null;
            if (owner) {
              return {
                status: 'running',
                appVersion: deps.appVersion,
                runtimeVersion: owner.version || null,
                runtimeSource: 'global-cli',
                runtimeManaged: true,
                runtimePath: owner.cliPath,
                botCount: config.count,
                onlineDaemonCount,
                attentionCount: 0,
                dashboardUrl: null,
                message: '跟随已安装的 botmux CLI（未接管）',
              };
            }
            return {
              status: 'degraded',
              degradedReason: 'external_unmanaged',
              appVersion: deps.appVersion,
              runtimeVersion: active.version,
              runtimeSource: 'global-cli',
              runtimeManaged: false,
              runtimePath: source.sourcePath,
              botCount: config.count,
              onlineDaemonCount,
              attentionCount: 1,
              dashboardUrl: null,
              message: '检测到由其他 botmux 安装启动的运行时，无法定位它的启动方式。',
            };
          }
          return {
            status: 'running',
            appVersion: deps.appVersion,
            runtimeVersion: active.version,
            runtimeSource: selectedSource,
            runtimeManaged: true,
            runtimePath: source.sourcePath ?? active.cliPath,
            botCount: config.count,
            onlineDaemonCount,
            attentionCount: 0,
            dashboardUrl: null,
          };
        }
      } catch (err) {
        // Fleet discovery failure should be visible in the rail instead of
        // silently pretending the runtime is stopped.
        return {
          status: 'degraded',
          degradedReason: 'fleet_discovery',
          appVersion: deps.appVersion,
          runtimeVersion: active.version,
          runtimeSource: selectedSource,
          runtimeManaged: false,
          runtimePath: active.cliPath,
          botCount: config.count,
          onlineDaemonCount: 0,
          attentionCount: 1,
          dashboardUrl: null,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    if (config.status === 'not_configured') {
      return {
        status: 'not_configured',
        appVersion: deps.appVersion,
        runtimeVersion: active.version,
        runtimeSource: selectedSource,
        runtimeManaged: true,
        runtimePath: active.cliPath,
        botCount: 0,
        onlineDaemonCount: 0,
        attentionCount: 0,
        dashboardUrl: null,
      };
    }

    return {
      status: 'stopped',
      appVersion: deps.appVersion,
      runtimeVersion: active.version,
      runtimeSource: selectedSource,
      runtimeManaged: true,
      runtimePath: active.cliPath,
      botCount: config.count,
      onlineDaemonCount: 0,
      attentionCount: 0,
      dashboardUrl: null,
    };
  }

  function startOrRestartInvocation(
    action: 'start' | 'restart',
    runtime: RuntimeLaunchTarget,
  ): {
    args: string[];
    extraEnv?: NodeJS.ProcessEnv;
  } {
    if (runtime.kind === 'bundled' && readBotConfig().status === 'not_configured') {
      return {
        args: [action, '--allow-empty'],
        extraEnv: zeroBotLoopbackExtraEnv(),
      };
    }
    return { args: [action] };
  }

  const service = {
    readBotConfigStatus(): BotConfigStatus {
      return readBotConfig();
    },
    getState(): Promise<DesktopRuntimeState> {
      if (stateInFlight) return stateInFlight;
      // Desktop has both polling and renderer-initiated refreshes. Coalesce
      // overlapping state reads so slow PM2 probes do not amplify into several
      // concurrent `pm2 jlist` calls and false degraded states.
      stateInFlight = computeState().finally(() => {
        stateInFlight = null;
      });
      return stateInFlight;
    },
    async start(options?: { signal?: AbortSignal }): Promise<RunResult> {
      return runStartOrRestartAction('start', { signal: options?.signal });
    },
    async stop(options?: { timeoutMs?: number }): Promise<RunResult> {
      return runCliAction(['stop'], { timeoutMs: options?.timeoutMs });
    },
    async stopIfEmpty(options?: { supervisorPid?: number; timeoutMs?: number }): Promise<RunResult> {
      const runtime = deps.bundledRuntime ?? activeRuntime();
      if (!runtime) return rejectedCliRequired();
      const args = ['stop', '--if-empty'];
      if (typeof options?.supervisorPid === 'number' && Number.isSafeInteger(options.supervisorPid) && options.supervisorPid > 0) {
        args.push('--supervisor-pid', String(options.supervisorPid));
      }
      return invokeRun(command(runtime, args), { timeoutMs: options?.timeoutMs });
    },
    async restart(options?: { signal?: AbortSignal }): Promise<RunResult> {
      return runStartOrRestartAction('restart', { signal: options?.signal });
    },
    async takeover(): Promise<RunResult> {
      const state = await this.getState();
      const runtime = activeRuntime();
      if (!runtime) return rejectedCliRequired();
      if (runtime.kind === 'bundled') {
        const inv = startOrRestartInvocation('restart', runtime);
        // Replace core processes only. The generated ecosystem pins their
        // interpreter to bundled Node, while unrelated plugin services survive.
        return invokeRun(command(runtime, inv.args, inv.extraEnv));
      }
      return {
        code: state.runtimeManaged ? 0 : 1,
        stdout: '',
        stderr: state.runtimeManaged
          ? ''
          : 'Current botmux runtime is not controlled by the selected CLI',
        signal: null,
      };
    },
    async restartBundled(options?: { signal?: AbortSignal }): Promise<RunResult> {
      if (!deps.bundledRuntime) return rejectedCliRequired();
      const inv = startOrRestartInvocation('restart', deps.bundledRuntime);
      return invokeRun(command(deps.bundledRuntime, inv.args, inv.extraEnv), { signal: options?.signal });
    },
    async dashboard(): Promise<RunResult> {
      const runtime = activeRuntime();
      if (!runtime) return rejectedCliRequired();
      return run(command(runtime, ['dashboard']));
    },
    async currentDashboard(): Promise<RunResult> {
      const runtime = activeRuntime();
      if (!runtime) return rejectedCliRequired();
      // Desktop embeds the existing authenticated dashboard session by default.
      // The IPC locator falls back to the get-or-create command only when the
      // read-only probe reports that no active token exists yet.
      const result = deps.dashboardEndpoint
        ? await deps.dashboardEndpoint('/__cli/current')
        : await callDashboard({
            configDir: deps.paths.botmuxHome,
            defaultPort: 7891,
            envPort: deps.env.BOTMUX_DASHBOARD_PORT,
            path: '/__cli/current',
          });
      return dashboardEndpointResultToRunResult(result);
    },
    async getDeviceStatus() {
      const runtime = activeRuntime();
      if (!runtime) return { ok: false as const, reason: 'cli_unavailable' as const };
      // Device credentials stay inside the host CLI. Electron receives only the
      // command's public status JSON, then reconstructs an allow-listed DTO
      // before anything can cross the renderer IPC boundary.
      const result = await run(command(runtime, ['device', 'status', '--json']), {
        maxOutputBytes: deviceStatusOutputLimitBytes,
      });
      return sanitizeDeviceStatusCommandResult(result);
    },
  };
  return service;
}
