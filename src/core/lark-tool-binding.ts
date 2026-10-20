import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { larkTransportEnabled } from './types.js';
import { isRemoteBackendId } from './remote-cli-ids.js';
import { normalizeBrand, type Brand } from '../im/lark/lark-hosts.js';
import { findRealToolBinary, installLoginShellPathShim, sessionIdentityDataDir, sessionIdentityBinDir } from './cli-identity.js';
import { resolveEntrySpawn } from './self-spawn.js';
import { clearLarkToolDelegations } from './lark-tool-delegation.js';

export const LARK_TOOL_BINDING_FILE = 'lark-tool-binding.json';
export const LARK_TOOL_ROUTE = 'lark-tool-identity';
export interface LarkToolBinding {
  version: 2;
  sessionId: string;
  appId: string;
  brand: Brand;
  defaultAs: 'bot' | 'user';
  ipcPort?: number;
  accessKey: string;
  realBinary: string;
  configDir: string;
  dataDir: string;
}

export function larkToolBindingPath(dataDir: string, sessionId: string): string {
  return join(sessionIdentityDataDir(dataDir, sessionId), LARK_TOOL_BINDING_FILE);
}

/** Materialize the root before deriving paths used in the sandbox namespace. */
export function resolveLarkToolDataDir(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return realpathSync(dataDir);
}

export function readLarkToolBinding(path: string): LarkToolBinding {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384
    || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) {
    throw new Error('lark_tool_binding_untrusted');
  }
  const value = JSON.parse(readFileSync(path, 'utf8')) as LarkToolBinding;
  if (value.version !== 2 || !/^cli_[A-Za-z0-9_-]+$/.test(value.appId)
    || !/^[A-Za-z0-9._-]{1,200}$/.test(value.sessionId) || /^\.+$/.test(value.sessionId)
    || !['feishu', 'lark'].includes(value.brand) || !['bot', 'user'].includes(value.defaultAs)
    || !/^[a-f0-9]{64}$/.test(value.accessKey)
    || ![value.realBinary, value.configDir, value.dataDir].every(v => typeof v === 'string' && v.startsWith('/') && !/[\x00-\x1f]/.test(v))) {
    throw new Error('lark_tool_binding_invalid');
  }
  return value;
}

/** Sessions adopt the lark-cli binding unless explicitly disabled (larkToolBinding === false).
 * Old/adopt/remote/workflow sessions do not use it.
 * Note: _dataDir, resume, forkSession are preserved for caller signature compatibility. */
export function usesLarkToolBinding(config: {
  sessionId: string; larkAppId: string; chatId: string; apiOnly?: boolean;
  resume?: boolean; forkSession?: boolean; adoptMode?: boolean; existingAppServerEndpoint?: string;
  backendType: import('../adapters/backend/types.js').BackendType;
  larkToolBinding?: boolean;
}, _dataDir?: string, workflow = false): boolean {
  if (workflow || config.adoptMode || config.existingAppServerEndpoint
    || isRemoteBackendId(config.backendType) || !larkTransportEnabled(config)) return false;
  return config.larkToolBinding !== false;
}

/** Clean up managed lark-cli binding files and wrappers when binding is disabled. */
export function cleanupLarkToolBinding(dataDir: string, sessionId: string): void {
  try {
    const rootDir = resolveLarkToolDataDir(dataDir);
    rmSync(larkToolBindingPath(rootDir, sessionId), { force: true });
    rmSync(join(sessionIdentityDataDir(rootDir, sessionId), 'lark-config'), { recursive: true, force: true });
    clearLarkToolDelegations(dataDir, sessionId);
    clearLarkToolDelegations(rootDir, sessionId);
    const binDir = sessionIdentityBinDir(rootDir, sessionId);
    const wrapperPath = join(binDir, 'lark-cli');
    try {
      const content = readFileSync(wrapperPath, 'utf8');
      if (content.startsWith('#!/bin/sh') && content.includes('# botmux managed lark-cli')) {
        rmSync(wrapperPath, { force: true });
      }
    } catch {
      // wrapper doesn't exist or can't be read
    }
  } catch {
    // best-effort cleanup
  }
}

/** Returns whether a session has larkToolBinding enabled (default true) and its binding file is present. */
export function isLarkToolBound(
  botConfig: { larkToolBinding?: boolean } | undefined,
  dataDir: string,
  sessionId: string,
): boolean {
  return botConfig?.larkToolBinding !== false && hasLarkToolBinding(dataDir, sessionId);
}

/** Bind only this session's tool. No global profile, account or user token is read. */
export function prepareLarkToolEnv(input: {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  sessionId: string;
  appId: string;
  brand?: Brand;
  defaultAs?: 'bot' | 'user';
  effectivePath?: string;
  runner?: { command: string; args: string[] };
}): LarkToolBinding {
  const rootDir = resolveLarkToolDataDir(input.dataDir);
  const binDir = sessionIdentityBinDir(rootDir, input.sessionId);
  const dataDir = sessionIdentityDataDir(rootDir, input.sessionId);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const configDir = join(dataDir, 'lark-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(configDir, 'data'), { recursive: true, mode: 0o700 });
  const realBinary = findRealToolBinary('lark-cli', input.effectivePath ?? input.env.PATH, [binDir]);
  const bindingPath = larkToolBindingPath(rootDir, input.sessionId);
  let prior: LarkToolBinding | undefined;
  try { prior = readLarkToolBinding(bindingPath); } catch { /* first binding */ }
  const binding: LarkToolBinding = {
    version: 2, sessionId: input.sessionId, appId: input.appId,
    brand: normalizeBrand(input.brand), defaultAs: input.defaultAs ?? 'bot',
    ipcPort: Number(input.env.BOTMUX_DAEMON_IPC_PORT) || undefined,
    accessKey: prior?.appId === input.appId && prior.brand === normalizeBrand(input.brand)
      ? prior.accessKey : randomBytes(32).toString('hex'),
    // Install a refusing entry even if the CLI is absent: a later PATH change
    // must not expose a newly installed, unbound machine CLI.
    realBinary: realBinary ? realpathSync(realBinary) : '/__botmux_lark_cli_not_installed__',
    configDir, dataDir: rootDir,
  };
  atomicWriteFileSync(bindingPath, JSON.stringify(binding), { mode: 0o600 });
  // New sessions use this entry instead of the legacy trigger-user wrapper.
  rmSync(join(dataDir, 'lark-cli.env'), { force: true });
  atomicWriteFileSync(join(configDir, 'config.json'), JSON.stringify({
    apps: [{ appId: binding.appId, brand: binding.brand, users: [] }],
  }), { mode: 0o600 });
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const sourceExecArgs = process.execArgv.map((arg, index, args) =>
    args[index - 1] === '--import' && arg === 'tsx' ? createRequire(import.meta.url).resolve('tsx') : arg);
  const runner = input.runner ?? (moduleDir.endsWith('/src/core')
    ? { command: process.execPath, args: [...sourceExecArgs, resolve(moduleDir, '../lark-tool-runner.ts')] }
    : resolveEntrySpawn('lark-tool-runner', resolve(moduleDir, '..')));
  const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
  atomicWriteFileSync(join(binDir, 'lark-cli'), [
    '#!/bin/sh', '# botmux managed lark-cli — application and caller are host-bound.',
    `exec ${[runner.command, ...runner.args, '--binding', bindingPath, '--'].map(quote).join(' ')} "$@"`, '',
  ].join('\n'), { mode: 0o755 });
  const { zdotdir, bashEnv } = installLoginShellPathShim(binDir);
  input.env.PATH = [binDir, ...(input.env.PATH ?? '').split(':').filter(p => p !== binDir)].join(':');
  input.env.BOTMUX_IDENTITY_BIN = binDir;
  input.env.ZDOTDIR = zdotdir;
  input.env.BASH_ENV = bashEnv;
  input.env.SESSION_DATA_DIR = rootDir;
  input.env.BOTMUX_SESSION_ID = input.sessionId;
  input.env.BOTMUX_LARK_TOOL_BINDING = bindingPath;
  return binding;
}

export function hasLarkToolBinding(dataDir: string, sessionId: string): boolean {
  try { return readLarkToolBinding(larkToolBindingPath(dataDir, sessionId)).sessionId === sessionId; }
  catch { return false; }
}

export function larkToolPrompt(appId: string, locale?: string): string {
  return locale === 'en'
    ? `lark-cli uses application ${appId} by default and calls default to this bot. For personal resources or a bot permission denial, use --as user with the current user's authorization to this same application. To use a different application or profile, specify --profile <profile>. If needed, run botmux auth request --scope "<required scopes>" --json. Do not repeat writes whose result is uncertain.`
    : `lark-cli 固定使用当前机器人的应用 ${appId} 作为默认，默认以 bot 身份调用。需要个人资源或 bot 无权时，可用 --as user 使用当前用户对同一应用的授权；若需使用其他应用或 profile，可显式指定 --profile <profile>。缺授权时运行 botmux auth request --scope "<所需权限>" --json。不要重复执行结果尚不确定的写操作。`;
}

export function larkToolPromptFromEnv(
  locale?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = env.BOTMUX_LARK_TOOL_BINDING;
  if (!path) return '';
  try { return larkToolPrompt(readLarkToolBinding(path).appId, locale); }
  catch { return ''; }
}

export { parseLarkToolInvocation } from './lark-tool-command.js';

export function larkToolPassthroughEnv(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited };
  env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1';
  env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER = '1';
  return env;
}

export function larkToolChildEnv(
  inherited: NodeJS.ProcessEnv, binding: LarkToolBinding,
  identity?: { mode: 'bot' | 'user'; credential: string },
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (key.startsWith('LARKSUITE_CLI_') || key.startsWith('LARK_CLI_')
      || key.startsWith('LARK_APP_') || key === 'FEISHU_USER_ACCESS_TOKEN') delete env[key];
  }
  env.LARKSUITE_CLI_CONFIG_DIR = binding.configDir;
  env.LARKSUITE_CLI_DATA_DIR = join(binding.configDir, 'data');
  env.LARKSUITE_CLI_APP_ID = binding.appId;
  env.LARKSUITE_CLI_BRAND = binding.brand;
  env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1';
  env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER = '1';
  if (identity?.mode === 'bot') env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN = identity.credential;
  if (identity?.mode === 'user') env.LARKSUITE_CLI_USER_ACCESS_TOKEN = identity.credential;
  return env;
}
