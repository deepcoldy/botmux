import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { callDashboard, type DashboardResult } from '../../cli/dashboard-endpoint.js';
import type { DesktopPaths, DesktopRuntimeState, RuntimeSource } from '../shared/types.js';
import { buildExternalBotmuxCommand, type BotmuxCommand } from './node-command.js';
import { classifyRuntimeSource, countActiveBotmuxDaemonApps, type Pm2AppSummary } from './runtime-source.js';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
}

type RunCommand = (cmd: BotmuxCommand) => Promise<RunResult>;
type DashboardEndpointCaller = (path: '/__cli/current') => Promise<DashboardResult>;
const defaultCommandTimeoutMs = 30_000;

export interface ExternalRuntimeCandidate {
  kind: 'external';
  root: string;
  cliPath: string;
  binPath: string;
  pathEnv?: string;
  version: string;
  runtimeSource?: Exclude<RuntimeSource, 'none'>;
}

export type RuntimeLaunchTarget = ExternalRuntimeCandidate;

function defaultRun(cmd: BotmuxCommand, timeoutMs = defaultCommandTimeoutMs): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(cmd.command, cmd.args, { env: cmd.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Timeout is surfaced as an ordinary failed action so renderer controls
      // can recover and show the last error without waiting for child close.
      child.kill();
      resolve({
        code: 1,
        stdout,
        stderr: `Command timed out after ${timeoutMs}ms`,
        signal: null,
      });
    }, timeoutMs);

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('error', error => {
      finish({ code: 1, stdout, stderr: stderr || error.message, signal: null });
    });
    child.on('close', (code, signal) => {
      // Signal-only exits still represent a failed desktop action to the UI.
      finish({
        code: code ?? 1,
        stdout,
        stderr: signal && !stderr ? `Process terminated by signal ${signal}` : stderr,
        signal,
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
  pm2Apps?: (runtime: ExternalRuntimeCandidate) => Promise<Pm2AppSummary[]>;
}

export function createRuntimeService(deps: RuntimeServiceDeps) {
  const run = deps.run ?? ((cmd: BotmuxCommand) => defaultRun(cmd, deps.commandTimeoutMs));
  const botsPath = join(deps.paths.botmuxHome, 'bots.json');
  const installCliMessage = 'Install the global botmux CLI with `npm install -g botmux`, then reopen Botmux Desktop.';

  function command(runtime: ExternalRuntimeCandidate, args: string[]): BotmuxCommand {
    return buildExternalBotmuxCommand({
      binPath: runtime.binPath,
      botmuxHome: deps.paths.botmuxHome,
      args,
      baseEnv: deps.env,
      pathEnv: runtime.pathEnv,
    });
  }

  function currentExternalRuntime(): ExternalRuntimeCandidate | null {
    return deps.discoverExternalRuntime ? deps.discoverExternalRuntime() : deps.externalRuntime ?? null;
  }

  function activeRuntime(): ExternalRuntimeCandidate | null {
    return currentExternalRuntime();
  }

  function rejectedCliRequired(): RunResult {
    return {
      code: 1,
      stdout: '',
      stderr: installCliMessage,
      signal: null,
    };
  }

  async function runCliAction(args: string[]): Promise<RunResult> {
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
    return run(command(runtime, args));
  }

  function externalSource(runtime: ExternalRuntimeCandidate): RuntimeSource {
    return runtime.runtimeSource ?? 'global-cli';
  }

  function readBotConfig(): { status: 'not_configured'; count: 0 } | { status: 'configured'; count: number } | { status: 'invalid'; message: string } {
    if (!deps.fs.existsSync(botsPath)) return { status: 'not_configured', count: 0 };
    try {
      const parsed = JSON.parse(deps.fs.readFileSync(botsPath, 'utf-8'));
      if (!Array.isArray(parsed)) return { status: 'invalid', message: 'bots.json must contain a JSON array' };
      if (parsed.length === 0) return { status: 'not_configured', count: 0 };
      for (let i = 0; i < parsed.length; i += 1) {
        const bot = parsed[i] as { larkAppId?: unknown; larkAppSecret?: unknown } | null;
        if (!bot || typeof bot !== 'object') return { status: 'invalid', message: `bots.json entry ${i} must be an object` };
        if (typeof bot.larkAppId !== 'string' || bot.larkAppId.length === 0) {
          return { status: 'invalid', message: `bots.json entry ${i} is missing larkAppId` };
        }
        if (typeof bot.larkAppSecret !== 'string' || bot.larkAppSecret.length === 0) {
          return { status: 'invalid', message: `bots.json entry ${i} is missing larkAppSecret` };
        }
      }
      return { status: 'configured', count: parsed.length };
    } catch (err) {
      return { status: 'invalid', message: err instanceof Error ? err.message : String(err) };
    }
  }

  let stateInFlight: Promise<DesktopRuntimeState> | null = null;

  async function computeState(): Promise<DesktopRuntimeState> {
    const config = readBotConfig();
    const active = currentExternalRuntime();
    const selectedSource = active ? externalSource(active) : 'none';

    if (config.status === 'invalid') {
      // A malformed bots.json is actionable user state, not an empty setup.
      return {
        status: 'degraded',
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

    if (config.status === 'not_configured') {
      return {
        status: 'not_configured',
        appVersion: deps.appVersion,
        runtimeVersion: active?.version ?? null,
        runtimeSource: selectedSource,
        runtimeManaged: Boolean(active),
        runtimePath: active?.cliPath ?? null,
        botCount: 0,
        onlineDaemonCount: 0,
        attentionCount: 0,
        dashboardUrl: null,
        message: active ? undefined : installCliMessage,
      };
    }

    if (!active) {
      return {
        status: 'degraded',
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

    if (deps.pm2Apps) {
      try {
        const pm2Apps = await deps.pm2Apps(active);
        const source = classifyRuntimeSource({ pm2Apps });
        const onlineDaemonCount = countActiveBotmuxDaemonApps(pm2Apps);
        if (source.running) {
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
        // PM2 discovery failure should be visible in the rail instead of
        // silently pretending the runtime is stopped.
        return {
          status: 'degraded',
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

  const service = {
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
    async start(): Promise<RunResult> {
      return runCliAction(['start']);
    },
    async stop(): Promise<RunResult> {
      return runCliAction(['stop']);
    },
    async restart(): Promise<RunResult> {
      return runCliAction(['restart']);
    },
    async takeover(): Promise<RunResult> {
      const state = await this.getState();
      // Compatibility shim for the old IPC name: "takeover" now means adopt
      // the selected global CLI runtime. It never stops or replaces a runtime.
      return {
        code: state.runtimeManaged ? 0 : 1,
        stdout: '',
        stderr: state.runtimeManaged
          ? ''
          : 'Current botmux runtime is not controlled by the selected CLI',
        signal: null,
      };
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
      // Falling back to rotation is decided by the IPC locator only when the
      // dashboard explicitly reports that no active token exists yet.
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
  };
  return service;
}
