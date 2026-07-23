import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeBotmuxVersion } from '../utils/version-info.js';
import { shellPathProbes } from './shared/shell-path-probes.js';

export interface RunCaptureOptions {
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}

export interface RunCaptureResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
}

export interface AppSmokeDeps {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  runCapture: (command: string, args: string[], options?: RunCaptureOptions) => RunCaptureResult;
  log: (line: string) => void;
  error: (line: string) => void;
}

interface AppSmokeOptions {
  appPath: string;
  dashboardUrl: string | null;
  skipDashboard: boolean;
  skipCliStatus: boolean;
}

const DEFAULT_APP_PATH = '/Applications/Botmux.app';
const DEFAULT_DASHBOARD_PORT = '7891';
// Deep Electron bundle verification can take 15+ seconds on a warm machine;
// keep the smoke check strict but avoid false negatives from normal codesign IO.
const CODESIGN_VERIFY_TIMEOUT_MS = 60_000;

export function createDefaultAppSmokeDeps(): AppSmokeDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    homeDir: homedir(),
    exists: existsSync,
    readFile: path => readFileSync(path, 'utf-8'),
    log: line => console.log(line),
    error: line => console.error(line),
    runCapture: (command, args, options) => {
      const result = spawnSync(command, args, {
        encoding: 'utf-8',
        env: options?.env,
        timeout: options?.timeout,
      });
      return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        error: result.error,
        signal: result.signal,
      };
    },
  };
}

export async function runAppSmokeCommand(args: string[], deps: AppSmokeDeps): Promise<number> {
  let options: AppSmokeOptions;
  try {
    options = parseSmokeOptions(args, deps);
  } catch (error) {
    if (error instanceof HelpRequested) return 0;
    deps.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    deps.error(appSmokeUsage());
    return 1;
  }
  const checks: Array<{ label: string; ok: boolean; detail?: string }> = [];

  function record(label: string, ok: boolean, detail?: string): void {
    checks.push({ label, ok, detail });
    const icon = ok ? 'PASS' : 'FAIL';
    const suffix = detail ? ` - ${detail}` : '';
    const line = `[${icon}] ${label}${suffix}`;
    if (ok) deps.log(line);
    else deps.error(line);
  }

  if (deps.platform !== 'darwin') {
    record('macOS platform', false, 'desktop smoke 目前只支持 macOS App 检查');
    return 1;
  }

  const appPath = options.appPath;
  const executablePath = join(appPath, 'Contents', 'MacOS', 'Botmux');
  const infoPlistPath = join(appPath, 'Contents', 'Info.plist');
  const appAsarPath = join(appPath, 'Contents', 'Resources', 'app.asar');

  record('Botmux.app bundle exists', deps.exists(appPath), appPath);
  record('App executable exists', deps.exists(executablePath), executablePath);
  record('app.asar exists', deps.exists(appAsarPath), appAsarPath);

  if (deps.exists(infoPlistPath)) {
    const version = runCaptureText(deps, 'plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', infoPlistPath], 5000);
    record(
      'Info.plist version readable',
      version.ok && isConcreteVersion(version.text),
      version.ok ? version.text : version.error,
    );
  } else {
    record('Info.plist version readable', false, `${infoPlistPath} not found`);
  }

  const sign = deps.runCapture('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
    timeout: CODESIGN_VERIFY_TIMEOUT_MS,
    env: deps.env,
  });
  record('codesign verify', sign.status === 0, commandError(sign));

  if (!options.skipCliStatus) {
    const status = runBotmuxStatus(deps, appPath);
    record('botmux CLI status', status.status === 0, commandError(status));
  }

  if (!options.skipDashboard) {
    const url = options.dashboardUrl ?? defaultCompatUrl(deps);
    const displayUrl = redactDashboardToken(url);
    const compat = runCaptureText(deps, 'curl', ['-fsS', '--max-time', '5', url], 7000);
    if (!compat.ok) {
      record('dashboard compat endpoint', false, `${displayUrl}: ${compat.error}`);
    } else {
      record('dashboard compat endpoint', isCompatPayload(compat.text), `${displayUrl}: ${compat.text.slice(0, 120)}`);
    }
  }

  const failed = checks.filter(check => !check.ok);
  if (failed.length > 0) {
    deps.error(`Botmux Desktop smoke failed: ${failed.length}/${checks.length} checks failed.`);
    return 1;
  }
  deps.log(`Botmux Desktop smoke passed: ${checks.length}/${checks.length} checks passed.`);
  return 0;
}

function parseSmokeOptions(args: string[], deps: AppSmokeDeps): AppSmokeOptions {
  const options: AppSmokeOptions = {
    appPath: DEFAULT_APP_PATH,
    dashboardUrl: null,
    skipDashboard: false,
    skipCliStatus: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--app-path') {
      const value = args[index + 1];
      if (!value) throw new Error('--app-path 需要一个 Botmux.app 路径。');
      options.appPath = value;
      index += 1;
    } else if (arg === '--dashboard-url') {
      const value = args[index + 1];
      if (!value) throw new Error('--dashboard-url 需要一个 dashboard 地址。');
      options.dashboardUrl = toCompatUrl(value);
      index += 1;
    } else if (arg === '--skip-dashboard') {
      options.skipDashboard = true;
    } else if (arg === '--skip-cli-status') {
      options.skipCliStatus = true;
    } else if (arg === 'help' || arg === '--help' || arg === '-h') {
      deps.log(appSmokeUsage());
      throw new HelpRequested();
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  return options;
}

export function appSmokeUsage(): string {
  return `用法:
  pnpm desktop:smoke --app-path /Applications/Botmux.app
  pnpm desktop:smoke --dashboard-url http://127.0.0.1:7891
  pnpm desktop:smoke --skip-dashboard

说明:
  执行只读冒烟检查：App 包结构、签名、Info.plist、CLI status 和 dashboard compat。`;
}

export class HelpRequested extends Error {
  constructor() {
    super('help requested');
  }
}

function defaultCompatUrl(deps: AppSmokeDeps): string {
  const token = readDashboardToken(deps);
  const fromEnv = deps.env.BOTMUX_DASHBOARD_URL;
  if (fromEnv) return withLocalDashboardToken(toCompatUrl(fromEnv), token);

  try {
    const port = deps.readFile(join(deps.homeDir, '.botmux', '.dashboard-port')).trim();
    if (/^\d{1,5}$/.test(port)) return withLocalDashboardToken(`http://127.0.0.1:${port}/__desktop/compat`, token);
  } catch {
    // Falling back to the default dashboard port keeps smoke usable before the
    // runtime has written ~/.botmux/.dashboard-port.
  }
  return withLocalDashboardToken(`http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}/__desktop/compat`, token);
}

function toCompatUrl(input: string): string {
  try {
    const url = new URL(input);
    if (!url.pathname || url.pathname === '/') url.pathname = '/__desktop/compat';
    return url.toString();
  } catch {
    return input;
  }
}

function readDashboardToken(deps: AppSmokeDeps): string | null {
  const tokenPath = join(deps.homeDir, '.botmux', '.dashboard-token');
  if (!deps.exists(tokenPath)) return null;
  try {
    return deps.readFile(tokenPath).trim() || null;
  } catch {
    return null;
  }
}

function withLocalDashboardToken(input: string, token: string | null): string {
  if (!token) return input;
  try {
    const url = new URL(input);
    if (!isLoopbackHost(url.hostname) || url.searchParams.has('t')) return input;
    // Only attach the browser token to loopback smoke checks, so a user-supplied
    // remote dashboard URL cannot receive the local machine's token by accident.
    url.searchParams.set('t', token);
    return url.toString();
  } catch {
    return input;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

function redactDashboardToken(input: string): string {
  return input.replace(/([?&]t=)[^&#\s]*/i, '$1<redacted>');
}

function runCaptureText(
  deps: AppSmokeDeps,
  command: string,
  args: string[],
  timeout: number,
): { ok: true; text: string } | { ok: false; error: string } {
  const result = deps.runCapture(command, args, { timeout, env: deps.env });
  if (result.status === 0) return { ok: true, text: result.stdout.trim() };
  return { ok: false, error: commandError(result) };
}

function runBotmuxStatus(deps: AppSmokeDeps, appPath: string): RunCaptureResult {
  const resources = join(appPath, 'Contents', 'Resources');
  const bundledNode = join(resources, 'node', `darwin-${deps.arch}`, 'bin', 'node');
  const bundledCli = join(resources, 'runtime', 'dist', 'cli.js');
  if (deps.exists(bundledNode) && deps.exists(bundledCli)) {
    return deps.runCapture(bundledNode, [bundledCli, 'status'], { timeout: 25000, env: deps.env });
  }
  const direct = deps.runCapture('botmux', ['status'], { timeout: 25000, env: deps.env });
  if (direct.status === 0 || deps.platform !== 'darwin' || !direct.error) return direct;

  // macOS GUI/Codex environments can miss the user's shell PATH even when
  // `botmux` is installed globally. Retry through the user's shell — both rc
  // (-ic) and profile (-lc) flavors, zsh and bash — before reporting no CLI.
  let last = direct;
  for (const probe of shellPathProbes(deps.env)) {
    last = deps.runCapture(probe.shell, [probe.flags, 'botmux status'], { timeout: 25000, env: deps.env });
    if (last.status === 0) return last;
  }
  return last;
}

function commandError(result: RunCaptureResult): string {
  if (result.status === 0) return (result.stdout || result.stderr).trim();
  if (result.error) return result.error.message;
  const output = (result.stderr || result.stdout).replace(/\s+/g, ' ').trim();
  const suffix = result.signal ? `signal ${result.signal}` : `exit ${result.status ?? 'unknown'}`;
  return output ? `${suffix}: ${output}` : suffix;
}

function isCompatPayload(text: string): boolean {
  try {
    const payload = JSON.parse(text) as {
      schemaVersion?: unknown;
      product?: unknown;
      dashboardProtocolVersion?: unknown;
      runtimeVersion?: unknown;
    };
    return payload.schemaVersion === 1
      && payload.product === 'botmux'
      && typeof payload.dashboardProtocolVersion === 'number'
      && typeof payload.runtimeVersion === 'string'
      && isConcreteVersion(payload.runtimeVersion);
  } catch {
    return false;
  }
}

function isConcreteVersion(version: string): boolean {
  const normalized = normalizeBotmuxVersion(version);
  return Boolean(normalized && normalized !== '0.0.0');
}
