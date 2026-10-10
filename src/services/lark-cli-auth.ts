/**
 * Per-person `lark-cli` application + user authorization.
 *
 * `lark-cli` has two independent identities that must both follow the message
 * sender:
 *
 *   1. the OAuth application (app id + secret) that issues a device code;
 *   2. the human who approves that device code.
 *
 * A private HOME only isolates (2). Copying one machine/operator application
 * into every private HOME still makes every sender authorize through the same
 * app, and people outside that app's availability scope see
 * "you do not have permission to use this app". Worse, the link visibly carries
 * another person's application identity.
 *
 * The minimal fix keeps the original per-sender HOME contract and runs
 * `config init` inside that HOME. Its browser page lets the sender select an
 * application they already created or create one when needed; Botmux must not
 * force a new application. Only after that per-person selection exists do we
 * start `auth login` in the same HOME. Nothing is copied from the daemon
 * operator, a shared bootstrap app, or the receiving Bot's app. A small marker
 * distinguishes an app selected in-place from an old HOME seeded from shared
 * machine material; an unmarked HOME is cleared before setup so shared app
 * credentials can never be accepted as personal state.
 *
 * The resulting layout is:
 *
 *   ~/.botmux/data/lark-cli-home/<sender-open-id>/.lark-cli/config.json
 *   ~/.botmux/data/lark-cli-home/<sender-open-id>/.local/share/lark-cli/...
 *
 * (`Library/Application Support/lark-cli` is also recognized on macOS.)
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import xtermHeadless from '@xterm/headless';
import { sessionTempDir } from '../core/session-temp.js';
import type { Brand } from '../im/lark/lark-hosts.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { scrubCliIdentityEnv, scrubSessionTurnMarkerEnv } from '../utils/child-env.js';
import { logger } from '../utils/logger.js';
import { isUsableOpenId } from '../utils/user-token.js';

const { Terminal } = xtermHeadless;

/** Root under which every sender owns a complete lark-cli installation. */
const LARK_CLI_HOME_ROOT_DEFAULT = join(
  homedir(), '.botmux', 'data', 'lark-cli-home',
);
let larkCliHomeRootOverride: string | null = null;

/** @internal test-only */
export function __setLarkCliHomeRootForTest(root: string | null): void {
  larkCliHomeRootOverride = root;
}

/** Device-code challenges live about 10 minutes. */
const CHALLENGE_TTL_MS = 9 * 60_000;
/** Bound a normal lark-cli invocation. */
const LARK_CLI_TIMEOUT_MS = 30_000;
/** `config init` waits for a person to select or create an app in the browser. */
const APP_SETUP_TIMEOUT_MS = 10 * 60_000;
/** It should print the setup link promptly; otherwise the process is wedged. */
const APP_SETUP_URL_TIMEOUT_MS = 30_000;
const MAX_SETUP_OUTPUT_CHARS = 64 * 1024;

/** Baseline scopes used by trigger-user lark-cli calls. */
export const LARK_CLI_DEVICE_SCOPES = [
  'offline_access',
  'docx:document:readonly',
  'docs:document.content:read',
  'drive:drive.metadata:readonly',
  'drive:drive.search:readonly',
  'wiki:wiki:readonly',
  'sheets:spreadsheet:read',
  'sheets:spreadsheet.meta:read',
  'im:message:readonly',
  'im:resource',
];

export function larkCliLoginScopes(extraScopes: readonly string[] = []): string[] {
  return [...new Set([...LARK_CLI_DEVICE_SCOPES, ...extraScopes])];
}

/** Preserve the original path-safe, app-scoped sender HOME contract. */
export function larkCliHomeFor(openId: string): string {
  if (!isUsableOpenId(openId)) {
    throw new Error(`[lark-cli-auth] unusable open_id: ${JSON.stringify(openId)}`);
  }
  return join(larkCliHomeRootOverride ?? LARK_CLI_HOME_ROOT_DEFAULT, openId);
}

function larkCliConfigPath(home: string): string {
  return join(home, '.lark-cli', 'config.json');
}

function larkCliDataDirs(home: string): string[] {
  return [
    join(home, '.local', 'share', 'lark-cli'),
    join(home, 'Library', 'Application Support', 'lark-cli'),
  ];
}

function configuredAppId(home: string): string | null {
  try {
    const cfg = JSON.parse(readFileSync(larkCliConfigPath(home), 'utf8')) as
      { apps?: Array<{ appId?: unknown }> };
    const app = cfg.apps?.find(entry =>
      typeof entry.appId === 'string' && /^cli_[A-Za-z0-9_]+$/.test(entry.appId));
    return typeof app?.appId === 'string' ? app.appId : null;
  } catch {
    return null;
  }
}

function personalAppMarkerPath(home: string): string {
  return join(home, '.botmux-personal-app');
}

function markPersonalApp(home: string): boolean {
  if (!configuredAppId(home)) return false;
  try {
    atomicWriteFileSync(personalAppMarkerPath(home), 'v1\n', { mode: 0o600 });
    return true;
  } catch (error) {
    logger.warn(`[lark-cli-auth] could not mark personal app setup: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Whether this sender completed Botmux's isolated `config init`.
 *
 * The legacy marker name says "personal app", but it means an application the
 * sender personally selected for this HOME; the application may already have
 * existed before Botmux initiated setup.
 */
export function hasPersonalLarkCliApp(openId: string): boolean {
  try {
    const home = larkCliHomeFor(openId);
    return existsSync(personalAppMarkerPath(home)) && configuredAppId(home) !== null;
  }
  catch { return false; }
}

function hasConfiguredAppToken(openId: string): boolean {
  try {
    const home = larkCliHomeFor(openId);
    if (!hasPersonalLarkCliApp(openId)) return false;
    const appId = configuredAppId(home);
    if (!appId) return false;
    const prefix = `${appId}_`;
    return larkCliDataDirs(home).some(dir => {
      try {
        return readdirSync(dir).some(name => name.startsWith(prefix) && name.endsWith('.enc'));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export function hasLarkCliHome(openId: string): boolean {
  return hasConfiguredAppToken(openId);
}

/** Forget only this person's personal app and user authorization. */
export function clearLarkCliAuth(openId: string): void {
  const setup = appSetups.get(openId);
  if (setup) {
    try { setup.child.kill(); } catch { /* best effort */ }
    appSetups.delete(openId);
  }
  try { rmSync(larkCliHomeFor(openId), { recursive: true, force: true }); }
  catch { /* absence is the desired state */ }
}

export interface LarkCliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type LarkCliRunner = (args: string[], home: string) => Promise<LarkCliResult>;
let runnerOverride: LarkCliRunner | null = null;
/** @internal test-only */
export function __setLarkCliRunnerForTest(runner: LarkCliRunner | null): void {
  runnerOverride = runner;
}

/** Test seam for the blocking `config init` setup process. */
export type LarkCliAppSetupRunner = (
  home: string,
  args: readonly string[],
) => Promise<LarkCliResult>;
let appSetupRunnerOverride: LarkCliAppSetupRunner | null = null;
/** @internal test-only */
export function __setLarkCliAppSetupRunnerForTest(runner: LarkCliAppSetupRunner | null): void {
  appSetupRunnerOverride = runner;
}

function isolatedLarkCliEnv(home: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  scrubSessionTurnMarkerEnv(env);
  scrubCliIdentityEnv(env);
  // These overrides would silently redirect every personal HOME back to one
  // machine-wide config/store or inject the receiving Bot's identity. XDG
  // roots matter too: several CLI/runtime libraries prefer them over HOME.
  for (const key of [
    'LARKSUITE_CLI_CONFIG_DIR', 'LARKSUITE_CLI_DATA_DIR',
    'LARKSUITE_CLI_APP_ID', 'LARKSUITE_CLI_APP_SECRET',
    'LARKSUITE_CLI_USER_ACCESS_TOKEN', 'FEISHU_USER_ACCESS_TOKEN',
    'LARKSUITE_CLI_TENANT_ACCESS_TOKEN',
    'LARKSUITE_CLI_TENANT_ACCESS_TOKEN_SOURCE',
    'LARKSUITE_CLI_TOKEN_ONLY__',
    'LARKSUITE_CLI_PROFILE', 'LARKSUITE_CLI_DEFAULT_AS',
  ]) delete env[key];
  env.HOME = home;
  env.XDG_CONFIG_HOME = join(home, '.config');
  env.XDG_DATA_HOME = join(home, '.local', 'share');
  env.XDG_STATE_HOME = join(home, '.local', 'state');
  env.XDG_CACHE_HOME = join(home, '.cache');
  env.LARKSUITE_CLI_LOG_DIR = join(home, '.local', 'state', 'lark-cli', 'logs');
  env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1';
  env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER = '1';
  return env;
}

/** @internal test-only */
export function __isolatedLarkCliEnvForTest(home: string): NodeJS.ProcessEnv {
  return isolatedLarkCliEnv(home);
}

async function runAsUser(openId: string, args: string[]): Promise<LarkCliResult> {
  const home = larkCliHomeFor(openId);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (runnerOverride) return runnerOverride(args, home);
  return await new Promise<LarkCliResult>(resolve => {
    let child;
    try {
      child = spawn('lark-cli', args, {
        env: isolatedLarkCliEnv(home),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      stderr += '\n[lark-cli-auth] timed out';
      child.stdout.destroy();
      child.stderr.destroy();
      finish(false);
    }, LARK_CLI_TIMEOUT_MS);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => { stderr += `\n${error.message}`; finish(false); });
    child.on('close', code => finish(code === 0));
  });
}

const APP_SETUP_URL_RE = /https:\/\/(?:open\.feishu\.cn|open\.larksuite\.com)\/page\/cli\?[^\s<>'"]+/;

function extractAppSetupUrl(output: string): string | null {
  return output.match(APP_SETUP_URL_RE)?.[0] ?? null;
}

interface AppSetupProcess {
  child: Pick<ReturnType<typeof spawn>, 'kill'>;
  url: Promise<string | null>;
}
const appSetups = new Map<string, AppSetupProcess>();

// `--new` is intentionally absent: it skips lark-cli's browser-side mode
// selection and would create a fresh application every time a new sender HOME
// is initialized. `--force-init` only permits this isolated HOME to configure
// an app while running under an Agent host; it does not choose/create an app.
const APP_SETUP_ARGS = ['config', 'init', '--force-init'] as const;

/**
 * Start one blocking `config init` process and return its browser URL as soon
 * as it appears. The child stays alive after this function resolves and writes
 * the application selected in the browser into this sender's HOME.
 */
async function beginPersonalAppSetup(openId: string, brand: Brand): Promise<string | null> {
  const existing = appSetups.get(openId);
  if (existing) return existing.url;

  const home = larkCliHomeFor(openId);
  // Old Botmux versions copied a machine/shared issuer into this same path.
  // No marker means none of it is trusted: start from an actually empty HOME.
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });

  if (appSetupRunnerOverride) {
    const result = await appSetupRunnerOverride(home, APP_SETUP_ARGS);
    if (result.ok) markPersonalApp(home);
    return extractAppSetupUrl(`${result.stdout}\n${result.stderr}`);
  }

  let child: ReturnType<typeof spawn>;
  try {
    // The daemon may itself run under Bun, whose node-pty ReadStream can close
    // immediately after an initial EAGAIN. `script` supplies the same OS PTY
    // without routing its master fd through Bun's tty.ReadStream. Both Linux's
    // util-linux form and macOS/BSD's argv form are supported.
    const ptyCommand = `stty rows 30 cols 120; exec lark-cli ${APP_SETUP_ARGS.join(' ')}`;
    const scriptArgs = process.platform === 'linux'
      ? ['-qefc', ptyCommand, '/dev/null']
      : ['-q', '/dev/null', '/bin/sh', '-c', ptyCommand];
    child = spawn('script', scriptArgs, {
      cwd: home,
      env: isolatedLarkCliEnv(home),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    logger.warn(`[lark-cli-auth] could not start personal app setup: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  let resolveUrl!: (url: string | null) => void;
  let urlSettled = false;
  let output = '';
  let promptStep: 'language' | 'action' | 'platform' | 'waiting' = 'language';
  const terminal = new Terminal({ cols: 120, rows: 30, allowProposedApi: true });
  const terminalInput = terminal.onData(data => {
    try { child.stdin?.write(data); } catch { /* child already exited */ }
  });
  const url = new Promise<string | null>(resolve => { resolveUrl = resolve; });
  const settleUrl = (value: string | null) => {
    if (urlSettled) return;
    urlSettled = true;
    clearTimeout(urlTimer);
    resolveUrl(value);
  };
  const inspect = (chunk: unknown) => {
    const data = String(chunk);
    if (output.length < MAX_SETUP_OUTPUT_CHARS) {
      output += data.slice(0, MAX_SETUP_OUTPUT_CHARS - output.length);
    }
    const found = extractAppSetupUrl(output);
    if (found) settleUrl(found);
    // `config init` without --new deliberately opens lark-cli's native picker.
    // Botmux only answers its three deterministic preliminaries. The browser
    // page still owns the meaningful choice: reuse an existing application or
    // create one. Feeding output through xterm also answers terminal capability
    // queries emitted by the picker, which a plain pipe cannot do.
    terminal.write(data, () => {
      if (promptStep === 'language' && /Language\s*\/\s*语言/i.test(output)) {
        promptStep = 'action';
        child.stdin?.write('\r');
      } else if (promptStep === 'action' && /(?:Select action|选择操作)/i.test(output)) {
        promptStep = 'platform';
        child.stdin?.write('\r');
      } else if (promptStep === 'platform' && /(?:Select platform|选择平台)/i.test(output)) {
        promptStep = 'waiting';
        child.stdin?.write(brand === 'lark' ? '\x1b[B\r' : '\r');
      }
    });
  };
  const urlTimer = setTimeout(() => {
    settleUrl(null);
    try { child.kill(); } catch { /* best effort */ }
  }, APP_SETUP_URL_TIMEOUT_MS);
  urlTimer.unref();
  const hardTimer = setTimeout(() => {
    try { child.kill(); } catch { /* best effort */ }
  }, APP_SETUP_TIMEOUT_MS);
  hardTimer.unref();

  const entry: AppSetupProcess = { child, url };
  appSetups.set(openId, entry);
  child.stdout?.on('data', inspect);
  child.stderr?.on('data', inspect);
  child.on('error', error => {
    logger.warn(`[lark-cli-auth] personal app setup failed to start: ${error.message}`);
    settleUrl(null);
  });
  child.on('close', code => {
    clearTimeout(hardTimer);
    terminalInput.dispose();
    terminal.dispose();
    settleUrl(extractAppSetupUrl(output));
    if (appSetups.get(openId) === entry) appSetups.delete(openId);
    if (code === 0 && markPersonalApp(home)) {
      logger.info('[lark-cli-auth] personal lark-cli app setup completed');
    } else if (!hasPersonalLarkCliApp(openId)) {
      logger.warn(`[lark-cli-auth] personal app setup ended before completion (exit ${code ?? 'unknown'})`);
    }
  });

  return url;
}

function challengePath(openId: string): string {
  return join(larkCliHomeFor(openId), '.botmux-login-challenge');
}

export interface PendingLarkCliChallenge {
  deviceCode: string;
  authUrl?: string;
  scopes: string[];
  createdAt: number;
}

export function pendingLarkCliChallenge(openId: string): PendingLarkCliChallenge | null {
  try {
    const raw = JSON.parse(readFileSync(challengePath(openId), 'utf8')) as
      { deviceCode?: unknown; authUrl?: unknown; scopes?: unknown; createdAt?: unknown };
    if (typeof raw.deviceCode !== 'string' || typeof raw.createdAt !== 'number') return null;
    if (Date.now() - raw.createdAt > CHALLENGE_TTL_MS) return null;
    return {
      deviceCode: raw.deviceCode,
      ...(typeof raw.authUrl === 'string' ? { authUrl: raw.authUrl } : {}),
      scopes: Array.isArray(raw.scopes) && raw.scopes.every(scope => typeof scope === 'string')
        ? raw.scopes as string[]
        : [...LARK_CLI_DEVICE_SCOPES],
      createdAt: raw.createdAt,
    };
  } catch {
    return null;
  }
}

function saveChallenge(openId: string, deviceCode: string, authUrl: string, scopes: string[]): void {
  try {
    atomicWriteFileSync(
      challengePath(openId),
      JSON.stringify({ deviceCode, authUrl, scopes, createdAt: Date.now() }),
      { mode: 0o600 },
    );
  } catch (error) {
    logger.debug(`[lark-cli-auth] could not persist the login challenge: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function clearChallenge(openId: string): void {
  try { rmSync(challengePath(openId), { force: true }); }
  catch { /* already absent */ }
}

export interface LarkCliLoginChallenge {
  authUrl: string;
  /** First bind the app selected by the sender, then authorize through it. */
  stage: 'app-setup' | 'user-login';
  scopes?: string[];
}

/**
 * Start (or resume) the next required step for one sender.
 *
 * No selected app -> config-init link. Selected app ready -> user OAuth link. There is
 * deliberately no shared-app fallback between those states.
 */
export async function beginLarkCliLogin(
  openId: string,
  extraScopes: readonly string[] = [],
  brand: Brand = 'feishu',
): Promise<LarkCliLoginChallenge | null> {
  if (!hasPersonalLarkCliApp(openId)) {
    const authUrl = await beginPersonalAppSetup(openId, brand);
    return authUrl ? { authUrl, stage: 'app-setup' } : null;
  }

  const scopes = larkCliLoginScopes(extraScopes);
  const pending = pendingLarkCliChallenge(openId);
  if (pending?.authUrl && pending.scopes.length === scopes.length
    && pending.scopes.every(scope => scopes.includes(scope))) {
    return { authUrl: pending.authUrl, stage: 'user-login', scopes };
  }

  const { ok, stdout, stderr } = await runAsUser(openId, [
    'auth', 'login', '--no-wait', '--json', '--scope', scopes.join(' '),
  ]);
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(stdout) as Record<string, unknown>; }
  catch { parsed = null; }
  const authUrl = typeof parsed?.verification_url === 'string' ? parsed.verification_url : undefined;
  const deviceCode = typeof parsed?.device_code === 'string' ? parsed.device_code : undefined;
  if (!ok || !authUrl || !deviceCode) {
    logger.warn(`[lark-cli-auth] could not start a personal login: ${stderr.trim() || stdout.trim() || 'no output'}`);
    return null;
  }
  saveChallenge(openId, deviceCode, authUrl, scopes);
  return { authUrl, stage: 'user-login', scopes };
}

export type LarkCliLoginState = 'authorized' | 'pending' | 'failed';

/** Poll a user-login device code once. App setup is completed by its child. */
export async function completeLarkCliLogin(
  openId: string,
  deviceCode?: string,
): Promise<{ state: LarkCliLoginState; detail?: string }> {
  const code = deviceCode ?? pendingLarkCliChallenge(openId)?.deviceCode;
  if (!code) {
    return hasConfiguredAppToken(openId)
      ? { state: 'authorized' }
      : { state: 'failed', detail: 'no active user login — start again' };
  }
  const { ok, stdout, stderr } = await runAsUser(openId, [
    'auth', 'login', '--device-code', code, '--json',
  ]);
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(stdout) as Record<string, unknown>; }
  catch { parsed = null; }
  if (ok) {
    if (hasConfiguredAppToken(openId)) {
      clearChallenge(openId);
      return { state: 'authorized' };
    }
    return { state: 'pending' };
  }
  const raw = String((parsed?.error as Record<string, unknown> | undefined)?.message ?? stderr).trim();
  if (/pending|not yet|waiting/i.test(raw)) return { state: 'pending' };
  clearChallenge(openId);
  return { state: 'failed', detail: raw || undefined };
}

/** The acting HOME for this turn, only after both personal-app and user login. */
export function larkCliHomeForTurn(openId: string | undefined): string | null {
  if (!openId) return null;
  try { return hasLarkCliHome(openId) ? larkCliHomeFor(openId) : null; }
  catch { return null; }
}

/** Poll a pending user login once, then publish the HOME only if it is usable. */
export async function resolveLarkCliHomeForTurn(openId: string | undefined): Promise<string | null> {
  if (!openId) return null;
  try {
    if (!hasLarkCliHome(openId) && pendingLarkCliChallenge(openId)) {
      await completeLarkCliLogin(openId);
    }
    return hasLarkCliHome(openId) ? larkCliHomeFor(openId) : null;
  } catch {
    return hasLarkCliHome(openId) ? larkCliHomeFor(openId) : null;
  }
}

/**
 * Materialize the current sender's lark-cli HOME inside one session's existing
 * writable temp root.
 *
 * A sandbox cannot bind a different host directory for every turn after it has
 * started, and granting the shared `lark-cli-home/` parent would expose every
 * sender. The daemon therefore keeps the durable personal HOME outside the
 * sandbox and atomically replaces this session-local working copy before it
 * publishes the turn identity. lark-cli may refresh/write inside the copy for
 * the duration of the turn; another session never sees it.
 */
export async function materializeLarkCliHomeForSession(
  openId: string,
  sessionDataDir: string,
  sessionId: string,
): Promise<string | null> {
  const source = await resolveLarkCliHomeForTurn(openId);
  if (!source) return null;

  // Give lark-cli a chance to validate/refresh the durable source before the
  // snapshot. A transient verification failure does not discard an otherwise
  // usable stored login; the copied CLI still enforces its own token state.
  try { await runAsUser(openId, ['auth', 'status', '--json', '--verify']); }
  catch { /* best effort; copy the last known personal state */ }

  const root = sessionTempDir(sessionDataDir, sessionId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = join(root, 'lark-cli-home');
  const staging = join(root, `.lark-cli-home.next-${process.pid}-${Date.now()}`);
  const cacheRoot = join(source, '.cache');
  const stateRoot = join(source, '.local', 'state');
  try {
    rmSync(staging, { recursive: true, force: true });
    cpSync(source, staging, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: path => path !== cacheRoot && !path.startsWith(`${cacheRoot}/`)
        && path !== stateRoot && !path.startsWith(`${stateRoot}/`),
    });
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    return target;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    logger.warn(`[lark-cli-auth] could not materialize isolated session HOME: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
