/**
 * Per-bot Codex `config.toml` / `AGENTS.md` under an isolated CODEX_HOME.
 *
 * The worker seeds `<BOT_HOME>/codex/config.toml` from the host
 * `~/.codex/config.toml` ONCE (the per-bot copy may carry customizations
 * afterwards), so later host edits never reach the bot; `AGENTS.md` is seeded at
 * the same first provisioning. The Dashboard shows the path and offers an
 * explicit "re-sync from host" that backs the current copies up first. Both only
 * matter for NEW sessions: a running Codex already read them.
 */
import { closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { botHomePath } from '../adapters/cli/read-isolation.js';
import { botConfigSandboxMode } from '../adapters/cli/sandbox-mode.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { provisionCodexAuth, secureCodexHome, type CodexAuthSyncMode } from './codex-auth-sync.js';

export const CODEX_CONFIG_FILE = 'config.toml';
export const CODEX_AGENTS_FILE = 'AGENTS.md';

/** The host Codex config every isolated bot is seeded from. */
export function hostCodexConfigPath(home: string = homedir()): string {
  return join(home, '.codex', CODEX_CONFIG_FILE);
}

/** The host Codex global instructions an isolated bot is seeded from. */
export function hostCodexAgentsPath(home: string = homedir()): string {
  return join(home, '.codex', CODEX_AGENTS_FILE);
}

/** `<dirname(SESSION_DATA_DIR)>/bots/<appId>` — the worker's BOT_HOME derivation. */
export function botHomeForSessionDataDir(sessionDataDir: string, appId: string): string {
  return botHomePath(dirname(sessionDataDir), appId);
}

/** The per-bot copy the worker seeds and isolated Codex reads (CODEX_HOME=<BOT_HOME>/codex). */
export function isolatedCodexConfigPath(sessionDataDir: string, appId: string): string {
  return join(botHomeForSessionDataDir(sessionDataDir, appId), 'codex', CODEX_CONFIG_FILE);
}

/** The per-bot AGENTS.md isolated Codex reads as its global instructions. */
export function isolatedCodexAgentsPath(sessionDataDir: string, appId: string): string {
  return join(botHomeForSessionDataDir(sessionDataDir, appId), 'codex', CODEX_AGENTS_FILE);
}

/**
 * Provision a bot's isolated CODEX_HOME for a cold spawn: auth per policy, then
 * seed from the host `~/.codex`. config.toml is copied only while the bot has
 * none. AGENTS.md is copied at the same first provisioning only (this call
 * created the codex dir, or seeded its config.toml) and never over an existing
 * entry, so a bot provisioned before AGENTS.md seeding existed keeps exactly
 * what it had; the Dashboard re-sync is the explicit way to pull it later.
 */
export function seedIsolatedCodexHome(opts: {
  botHome: string;
  mode?: CodexAuthSyncMode;
  log(message: string): void;
  hostHome?: string;
}): string {
  const firstProvision = !existsSync(join(opts.botHome, 'codex'));
  const codexHome = provisionCodexAuth({
    botHome: opts.botHome,
    mode: opts.mode,
    log: opts.log,
    ...(opts.hostHome ? { globalCodexHome: join(opts.hostHome, '.codex') } : {}),
  });
  const cfgDst = join(codexHome, CODEX_CONFIG_FILE);
  const cfgSrc = hostCodexConfigPath(opts.hostHome);
  const seedConfig = !existsSync(cfgDst) && existsSync(cfgSrc);
  if (seedConfig) copyFileSync(cfgSrc, cfgDst);
  if (firstProvision || seedConfig) seedIsolatedCodexAgents(codexHome, hostCodexAgentsPath(opts.hostHome), opts.log);
  return codexHome;
}

function seedIsolatedCodexAgents(codexHome: string, hostPath: string, log: (message: string) => void): void {
  const host = readHostFile(hostPath);
  if (host === null) return;
  if (host === 'not_file') {
    log(`[codex-config] WARN host ${hostPath} is not a regular file; AGENTS.md not seeded`);
    return;
  }
  const target = join(codexHome, CODEX_AGENTS_FILE);
  try {
    lstatSync(target);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  atomicWriteFileSync(target, host, { mode: 0o600, followTargetSymlink: false });
  log(`[codex-config] seeded ${target} from ${hostPath}`);
}

/** The host file is the operator's own (often a dotfiles symlink): following it is fine. */
function readHostFile(path: string): Buffer | null | 'not_file' {
  try {
    return readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'EISDIR') return 'not_file';
    throw error;
  }
}

/**
 * Whether a NEW session of this bot runs a LOCAL Codex that reads the per-bot
 * CODEX_HOME (`<BOT_HOME>/codex/config.toml`) — the file the Dashboard path and
 * "re-sync" button act on. The answer must match the worker's
 * `willRedirectCliData` for codex, or the UI shows a path nothing reads and
 * reports a false "synced":
 *
 *   - codex only, never through a wrapper CLI;
 *   - codex is a LOCAL CLI. `resolvePairedSpawnBackendType` (run before every
 *     spawn, worker-pool.ts) maps a local CLI whose configured backend is a
 *     REMOTE id (riff / mojo / remote-runner) back onto the daemon default (or
 *     pty), so such a bot still runs a local Codex and the BOT_HOME redirect
 *     still happens. The configured `backendType` therefore does NOT change the
 *     answer and is deliberately not an input here;
 *   - the mere PRESENCE of a `codexInstancePool` (normalized object, including
 *     `enabled: false`) routes every new non-external session to an instance
 *     binding (`source: 'default'` / `'pool'`); the worker's `legacyHomePolicy`
 *     is then false and each instance owns its own CODEX_HOME, so the BOT_HOME
 *     copy is never read. `enabled: false` only stops RANDOM selection, not the
 *     default-instance binding. External/adopt sessions spawn no CLI, so hiding
 *     the section when a pool exists is the safe direction (no false success);
 *   - oncall (or legacy readIsolation) / `codexAuthSync: isolated`; never under
 *     scratch (it reads the native ~/.codex).
 *
 * The machine-wide BOTMUX_SANDBOX override is not part of bot config and is not
 * modelled here (consistent with the rest of the Dashboard sandbox display).
 */
export function botUsesIsolatedCodexHome(cfg: {
  cliId?: string;
  sandbox?: unknown;
  readIsolation?: boolean;
  codexAuthSync?: string;
  wrapperCli?: string;
  /** Normalized codex instance pool; ANY present pool (even enabled:false) wins. */
  codexInstancePool?: unknown;
}): boolean {
  if (cfg.cliId !== 'codex' || cfg.wrapperCli) return false;
  if (cfg.codexInstancePool) return false;
  let mode;
  try { mode = botConfigSandboxMode(cfg); } catch { return false; }
  if (mode === 'scratch') return false;
  return mode === 'oncall' || cfg.codexAuthSync === 'isolated';
}

export type CodexConfigResyncResult =
  | {
    ok: true;
    path: string;
    backupPath: string | null;
    /** Per-bot AGENTS.md replaced from the host; null when the host has none (the bot's copy is left alone). */
    agentsPath: string | null;
    agentsBackupPath: string | null;
  }
  | { ok: false; error: 'host_config_missing' | 'host_config_not_file' | 'target_not_regular_file' };

/** Read a regular file without following a leaf symlink; null when absent. */
function readRegularFileNoFollow(path: string): Buffer | null | 'not_regular' {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP' || code === 'EISDIR') return 'not_regular';
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) return 'not_regular';
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** `config.toml.bak-<UTC timestamp>`, filesystem-safe (no `:`). */
export function codexConfigBackupName(now: Date, file: string = CODEX_CONFIG_FILE): string {
  return `${file}.bak-${now.toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * Replace the bot's isolated config.toml with the host copy, and its AGENTS.md
 * too when the host has one. Each existing per-bot file is backed up to
 * `<name>.bak-<timestamp>` first; every file lands 0600. The bot home is
 * bot-writable, so the codex dir is resolved through {@link secureCodexHome}
 * (rejects planted symlinks), leaves are never followed, and both targets are
 * checked before anything is written.
 */
export function resyncIsolatedCodexConfig(opts: {
  botHome: string;
  hostConfigPath?: string;
  hostAgentsPath?: string;
  now?: Date;
}): CodexConfigResyncResult {
  const host = readHostFile(opts.hostConfigPath ?? hostCodexConfigPath());
  if (host === null) return { ok: false, error: 'host_config_missing' };
  if (host === 'not_file') return { ok: false, error: 'host_config_not_file' };
  const hostAgents = readHostFile(opts.hostAgentsPath ?? hostCodexAgentsPath());
  const codexHome = secureCodexHome(opts.botHome);
  const target = join(codexHome, CODEX_CONFIG_FILE);
  const current = readRegularFileNoFollow(target);
  if (current === 'not_regular') return { ok: false, error: 'target_not_regular_file' };
  const agentsTarget = join(codexHome, CODEX_AGENTS_FILE);
  const agentsCurrent = Buffer.isBuffer(hostAgents) ? readRegularFileNoFollow(agentsTarget) : null;
  if (agentsCurrent === 'not_regular') return { ok: false, error: 'target_not_regular_file' };
  const now = opts.now ?? new Date();
  const replace = (path: string, file: string, body: Buffer, existing: Buffer | null): string | null => {
    let backupPath: string | null = null;
    if (existing !== null) {
      backupPath = join(codexHome, codexConfigBackupName(now, file));
      atomicWriteFileSync(backupPath, existing, { mode: 0o600, followTargetSymlink: false });
    }
    atomicWriteFileSync(path, body, { mode: 0o600, followTargetSymlink: false });
    return backupPath;
  };
  const backupPath = replace(target, CODEX_CONFIG_FILE, host, current);
  if (!Buffer.isBuffer(hostAgents)) return { ok: true, path: target, backupPath, agentsPath: null, agentsBackupPath: null };
  const agentsBackupPath = replace(agentsTarget, CODEX_AGENTS_FILE, hostAgents, agentsCurrent);
  return { ok: true, path: target, backupPath, agentsPath: agentsTarget, agentsBackupPath };
}
