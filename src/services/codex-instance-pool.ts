import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { BotConfig } from '../bot-registry.js';
import type { Session } from '../types.js';
import { resolveCliRuntime, snapshotCliRuntime, runtimePathOverride } from '../adapters/cli/runtime.js';

export type SessionCreationSource = 'ordinary-feishu' | 'schedule' | 'http' | 'workflow' | 'other' | 'fork' | 'external';
export interface CodexInstanceConfig { id: string; codexHome: string; enabled?: boolean; weight?: number }
export interface CodexInstancePool {
  enabled: boolean;
  defaultInstanceId: string;
  scope: 'ordinary-feishu';
  strategy: 'random';
  instances: CodexInstanceConfig[];
}
export interface SessionCliInstanceBindingV1 {
  version: 1;
  source: 'pool' | 'legacy' | 'default';
  instanceId: string | null;
  cliId: 'codex';
  codexHome: string;
  authMode: 'isolated' | 'shared' | 'global';
}

function invalid(detail: string): never { throw new Error(`codexInstancePool: ${detail}`); }
function pathSyntax(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || path !== path.trim()
      || /[\0\r\n$~]/.test(path) || path.split(sep).includes('..')) invalid('codexHome must be an explicit absolute path');
}
function overlap(a: string, b: string): boolean {
  const r = relative(a, b);
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
}

/** Shared by config loading, config writers, management, and admission. No filesystem writes. */
export function normalizeCodexInstancePool(raw: unknown, bot: Partial<BotConfig>): CodexInstancePool | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('expected an object');
  const p = raw as CodexInstancePool;
  if (process.platform === 'win32' || bot.cliId !== 'codex' || bot.backendType !== 'tmux'
      || bot.wrapperCli || bot.sandbox || bot.readIsolation || bot.existingAppServer
      || (bot.env && Object.keys(bot.env).length)) invalid('requires local Codex + tmux, without wrapper, env, sandbox, readIsolation or external app server');
  if (typeof p.enabled !== 'boolean' || p.scope !== 'ordinary-feishu' || p.strategy !== 'random') invalid('enabled, scope=ordinary-feishu and strategy=random are required');
  if (!Array.isArray(p.instances) || !p.instances.length) invalid('instances must not be empty');
  const ids = new Set<string>();
  const paths: string[] = [];
  let total = 0;
  for (const entry of p.instances) {
    if (!entry || typeof entry.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.id) || ids.has(entry.id)) invalid('instance IDs must be unique safe identifiers');
    ids.add(entry.id);
    pathSyntax(entry.codexHome);
    let path = resolve(entry.codexHome);
    try { path = realpathSync(path); } catch { /* management may initialize it later */ }
    if (paths.some(other => overlap(path, other) || overlap(other, path))) invalid('instance homes must be distinct and non-nested');
    paths.push(path);
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') invalid(`instance ${entry.id}: enabled must be boolean`);
    const weight = entry.weight === undefined ? 1 : entry.weight;
    if (!Number.isSafeInteger(weight) || weight <= 0) invalid(`instance ${entry.id}: weight must be a positive safe integer`);
    total += weight;
    if (!Number.isSafeInteger(total)) invalid('total weight exceeds safe integer range');
  }
  if (!ids.has(p.defaultInstanceId)) invalid('defaultInstanceId must reference an instance');
  return { enabled: p.enabled, defaultInstanceId: p.defaultInstanceId, scope: p.scope, strategy: p.strategy,
    instances: p.instances.map(i => ({ id: i.id, codexHome: i.codexHome, enabled: i.enabled ?? true, weight: i.weight ?? 1 })) };
}

/** Strict read-only preflight. Error text never contains credential contents. */
export function validateCodexInstanceHome(path: string, options: { requireAuth?: boolean } = {}): string {
  pathSyntax(path);
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)
        || (process.getuid && stat.uid !== process.getuid())) invalid('home must be an owned private directory (0700)');
    const canonical = realpathSync(path);
    for (const name of ['auth.json', 'config.toml']) {
      const file = join(canonical, name);
      let s;
      try { s = lstatSync(file); }
      catch (error) {
        if (name === 'auth.json' && options.requireAuth === false && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || (s.mode & 0o077)
          || (process.getuid && s.uid !== process.getuid())) invalid(`${name} must be an owned private regular file (0600)`);
    }
    const config = readFileSync(join(canonical, 'config.toml'), 'utf8');
    // The setting belongs to TOML's root table. Requiring the explicit root
    // setting avoids shared OS keychain credentials and implicit fallback.
    const root = config.split(/^\s*\[/m, 1)[0];
    if (!/^\s*cli_auth_credentials_store\s*=\s*["']file["']\s*(?:#.*)?$/m.test(root)) invalid('config.toml must set root cli_auth_credentials_store = "file"');
    if (options.requireAuth !== false) {
      const auth = JSON.parse(readFileSync(join(canonical, 'auth.json'), 'utf8')) as { tokens?: { access_token?: unknown }; OPENAI_API_KEY?: unknown };
      const nonemptyString = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
      if (!auth || (!nonemptyString(auth.tokens?.access_token) && !nonemptyString(auth.OPENAI_API_KEY))) invalid('auth.json has no credential structure');
    }
    return canonical;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('codexInstancePool:')) throw error;
    invalid('home/config/credential is missing, unreadable or malformed');
  }
}

export function selectWeightedCodexInstance<T extends { weight?: number }>(instances: readonly T[], rng = Math.random): T {
  if (!instances.length) invalid('no eligible random instances');
  const total = instances.reduce((sum, i) => sum + (i.weight ?? 1), 0);
  if (!Number.isSafeInteger(total) || total <= 0 || instances.some(i => !Number.isSafeInteger(i.weight ?? 1) || (i.weight ?? 1) <= 0)) invalid('invalid weights');
  const random = rng();
  if (!Number.isFinite(random) || random < 0 || random >= 1) invalid('RNG must return a number in [0,1)');
  let target = random * total;
  for (const entry of instances) {
    target -= entry.weight ?? 1;
    if (target < 0) return entry;
  }
  return instances[instances.length - 1]!;
}

const configuredBots = new Map<string, BotConfig>();
export function registerCodexInstanceBot(bot: BotConfig): void {
  normalizeCodexInstancePool(bot.codexInstancePool, bot);
  configuredBots.set(bot.larkAppId, bot);
}
export function configuredCodexInstanceBot(appId?: string): BotConfig | undefined { return appId ? configuredBots.get(appId) : undefined; }
export function clearCodexInstanceBots(): void { configuredBots.clear(); }

export function validateCodexInstanceRoster(bots: readonly Partial<BotConfig>[]): void {
  const homes: Array<{ appId?: string; path: string }> = [];
  for (const bot of bots) {
    const pool = normalizeCodexInstancePool(bot.codexInstancePool, bot);
    for (const instance of pool?.instances ?? []) {
      let path = resolve(instance.codexHome);
      try { path = realpathSync(path); } catch { /* explicit init can follow */ }
      if (homes.some(other => other.appId !== bot.larkAppId && (overlap(path, other.path) || overlap(other.path, path)))) invalid('different bots must not share or nest instance homes');
      homes.push({ appId: bot.larkAppId, path });
    }
  }
}

/** Called synchronously while the daemon owns the routing-key creation lock. */
export function newSessionCodexInstanceState(bot: BotConfig, source: SessionCreationSource, rng = Math.random): Partial<Session> {
  const pool = normalizeCodexInstancePool(bot.codexInstancePool, bot);
  if (!pool || source === 'external') return {};
  const random = pool.enabled && source === 'ordinary-feishu';
  const candidates = random ? pool.instances.filter(i => i.enabled !== false) : pool.instances.filter(i => i.id === pool.defaultInstanceId);
  const ready: Array<CodexInstanceConfig & { canonical: string }> = [];
  const failures: string[] = [];
  for (const entry of candidates) {
    try { ready.push({ ...entry, canonical: validateCodexInstanceHome(entry.codexHome) }); }
    catch { failures.push(entry.id); }
  }
  if (!ready.length) invalid(`no eligible ${random ? 'random' : 'default'} instance; failed IDs: ${failures.join(', ') || '(none enabled)'}`);
  if (ready.some((a, n) => ready.slice(n + 1).some(b => overlap(a.canonical, b.canonical) || overlap(b.canonical, a.canonical)))) invalid('canonical homes overlap');
  const chosen = random ? selectWeightedCodexInstance(ready, rng) : ready[0]!;
  const runtime = resolveCliRuntime({ cliId: 'codex', cliRuntime: bot.cliRuntime, cliPathOverride: bot.cliPathOverride, context: 'Codex instance runtime' });
  return {
    cliInstanceBinding: { version: 1, source: random ? 'pool' : 'default', instanceId: chosen.id, cliId: 'codex', codexHome: chosen.canonical, authMode: 'isolated' },
    creationSource: source, cliId: 'codex', cliRuntime: snapshotCliRuntime(runtime), cliPathOverride: runtimePathOverride(runtime),
    agentFrozen: true, reasoningEffort: bot.reasoningEffort, backendType: 'tmux', sandbox: false, larkAppId: bot.larkAppId,
  };
}

export function legacyCodexInstanceBinding(session: Session, bot: BotConfig, botHome: string): SessionCliInstanceBindingV1 | undefined {
  if (session.cliInstanceBinding || session.creationSource === 'external' || session.cliLaunchSnapshot || session.adoptedFrom || (session.cliId ?? bot.cliId) !== 'codex') return undefined;
  if (session.wrapperCli || bot.wrapperCli || bot.env?.CODEX_HOME) invalid(`legacy session ${session.sessionId}: home is ambiguous`);
  const isolated = bot.codexAuthSync === 'isolated' || session.sandbox === true;
  const home = isolated ? join(botHome, 'codex') : join(homedir(), '.codex');
  return { version: 1, source: 'legacy', instanceId: null, cliId: 'codex', codexHome: home,
    authMode: isolated ? (bot.codexAuthSync === 'isolated' ? 'isolated' : 'shared') : 'global' };
}

/** Merge this LAST, after all configurable environment sources. Never mutates the parent. */
export function codexInstanceEnv(env: NodeJS.ProcessEnv, binding?: SessionCliInstanceBindingV1): NodeJS.ProcessEnv {
  if (!binding) return { ...env };
  if (binding.version !== 1 || binding.cliId !== 'codex') invalid('unsupported binding');
  const home = binding.source === 'legacy' ? binding.codexHome : validateCodexInstanceHome(binding.codexHome);
  if (binding.source !== 'legacy' && home !== binding.codexHome) invalid('frozen instance home no longer resolves to its original directory');
  pathSyntax(home);
  const result: NodeJS.ProcessEnv = { ...env, CODEX_HOME: home };
  if (binding.source !== 'legacy') {
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete result[key];
  }
  return result;
}

export function applyCodexInstanceEnv(env: NodeJS.ProcessEnv, binding?: SessionCliInstanceBindingV1): void {
  if (!binding) return;
  const effective = codexInstanceEnv(env, binding);
  if (binding.source !== 'legacy') {
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete env[key];
  }
  Object.assign(env, effective);
}

export function codexInstanceIdentity(binding: SessionCliInstanceBindingV1, runtime: unknown): string {
  return createHash('sha256').update(JSON.stringify({ binding, runtime })).digest('hex');
}
