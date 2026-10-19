import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'smol-toml';
import type { BotConfig } from '../bot-registry.js';
import { botInjectedEnv, buildSessionChildEnv } from '../core/env-policy.js';

export type ProfileStatus = 'ok' | 'empty' | 'unreadable' | 'unsupported' | 'scan_failed';
export interface CodexProfileCatalog {
  status: ProfileStatus;
  version?: string;
  source?: string;
  format?: 'files' | 'legacy';
  candidates: Array<{ name: string; available: boolean; error?: string }>;
  error?: string;
}
export class CodexProfileError extends Error {
  constructor(public readonly code: string) { super(`Codex profile: ${code}`); }
}
const fail = (code: string): never => { throw new CodexProfileError(code); };
export function normalizeCodexProfile(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(raw)) fail('invalid_name');
  return raw as string;
}
export type ProfileLaunch = Pick<Partial<BotConfig>, 'cliId' | 'wrapperCli' | 'cliLaunchMode' | 'cliPathOverride' | 'env' | 'envPolicy' | 'sandbox' | 'readIsolation' | 'codexAuthSync' | 'codexInstancePool' | 'existingAppServer' | 'startupCommands' | 'backendType' | 'serviceTier' | 'codexRpcInput'> & { cliRuntime?: { executable: string } };
/** Do not probe launchers or borrow the Dashboard process's configuration. Called in the bound daemon. */
export function assertCodexProfileLaunch(cfg: ProfileLaunch): void {
  if (!['linux', 'darwin'].includes(process.platform) || cfg.cliId !== 'codex' || cfg.wrapperCli || cfg.cliLaunchMode || (cfg.cliPathOverride && !cfg.cliRuntime)
      || cfg.existingAppServer || cfg.startupCommands?.length || cfg.env?.PATH
      || cfg.codexInstancePool?.enabled || cfg.codexAuthSync === 'isolated'
      || cfg.readIsolation || (cfg.sandbox && cfg.sandbox !== 'off') || process.env.BOTMUX_SANDBOX === '1'
      || (cfg.backendType && !['pty', 'tmux'].includes(cfg.backendType))) fail('unsupported_launch');
  if (cfg.codexRpcInput && cfg.backendType === 'tmux') fail('unsupported_rpc');
  if (cfg.serviceTier && cfg.serviceTier !== 'default') fail('unsupported_service_tier');
}
export function codexProfileEnvironment(cfg: ProfileLaunch): NodeJS.ProcessEnv {
  return { ...buildSessionChildEnv(process.env, cfg.envPolicy), ...botInjectedEnv(cfg.env, cfg.envPolicy) };
}
export function resolveCodexProfileHome(cfg: ProfileLaunch): string {
  const env = codexProfileEnvironment(cfg);
  const pool = cfg.codexInstancePool;
  const instanceHome = pool?.instances.find(i => i.id === pool.defaultInstanceId)?.codexHome;
  if (pool && !instanceHome) fail('instance_unavailable');
  const raw = instanceHome || env.CODEX_HOME?.trim() || join(env.HOME || homedir(), '.codex');
  if (!isAbsolute(raw)) fail('home_must_be_absolute');
  return resolve(raw);
}
function executable(cfg: ProfileLaunch, env: NodeJS.ProcessEnv): string {
  const command = cfg.cliRuntime?.executable || 'codex';
  if (isAbsolute(command)) return command;
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const path = join(dir, command);
    try { if (lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) return path; } catch { /* next */ }
  }
  return fail('binary_unavailable');
}
async function capability(cfg: ProfileLaunch, home: string) {
  const env = { ...codexProfileEnvironment(cfg), CODEX_HOME: home };
  const bin = executable(cfg, env);
  const run = promisify(execFile);
  try {
    const opts = { env, timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true };
    const { stdout } = await run(bin, ['--version'], opts);
    const match = /^codex-cli (\d+)\.(\d+)\.(\d+)\s*$/.exec(stdout.trim());
    if (!match) return fail('version_unknown');
    const { stdout: help } = await run(bin, ['--help'], opts);
    if (!help.includes('--profile')) return fail('parameter_unsupported');
    const version = `${match[1]}.${match[2]}.${match[3]}`;
    const format = +match[1] > 0 || +match[2] >= 134 ? 'files' as const : 'legacy' as const;
    return { version, format };
  } catch (error) {
    if (error instanceof CodexProfileError) throw error;
    return fail('capability_unconfirmed');
  }
}
const MAX_FILE_BYTES = 256 * 1024;
/** No symlinks, no devices/FIFOs, bounded reads, and never expose parser error snippets. */
function readToml(home: string, name: string): Record<string, unknown> {
  if (realpathSync(home) !== home) fail('home_changed');
  const directory = lstatSync(home);
  const file = join(home, name);
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('unsafe_file');
  if (before.size > MAX_FILE_BYTES) fail('file_too_large');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > MAX_FILE_BYTES) fail('file_changed');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = readSync(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size > MAX_FILE_BYTES) fail('file_too_large');
    const after = lstatSync(file);
    const directoryAfter = lstatSync(home);
    if (fstatSync(fd).mtimeMs !== stat.mtimeMs || after.ino !== stat.ino || after.dev !== stat.dev
        || after.size !== stat.size || after.ctimeMs !== stat.ctimeMs) fail('file_changed');
    if (directoryAfter.ino !== directory.ino || directoryAfter.dev !== directory.dev
        || realpathSync(home) !== home) fail('home_changed');
    try { return parse(buffer.subarray(0, size).toString('utf8')); } catch { return fail('invalid_toml'); }
  } finally { closeSync(fd); }
}
function safeHome(home: string): string {
  const stat = lstatSync(home);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_home');
  return realpathSync(home);
}
function errorCode(error: unknown): string {
  if (error instanceof CodexProfileError) return error.code;
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' ? 'not_found' : code === 'EACCES' || code === 'EPERM' ? 'unreadable' : 'scan_failed';
}
export async function scanCodexProfiles(cfg: ProfileLaunch, frozenHome?: string): Promise<CodexProfileCatalog> {
  const result: CodexProfileCatalog = { status: 'scan_failed', candidates: [] };
  try {
    assertCodexProfileLaunch(cfg);
    const home = frozenHome ?? resolveCodexProfileHome(cfg);
    if (!isAbsolute(home)) fail('home_must_be_absolute');
    result.source = home;
    Object.assign(result, await capability(cfg, home));
    const canonical = safeHome(home);
    if (result.format === 'legacy') {
      const profiles = readToml(canonical, 'config.toml').profiles;
      if (profiles && typeof profiles === 'object' && !Array.isArray(profiles)) {
        const names = Object.keys(profiles);
        if (names.length > 128) fail('too_many_profiles');
        for (const name of names) {
          try { if (!normalizeCodexProfile(name)) continue; } catch { continue; }
          const value = (profiles as Record<string, unknown>)[name];
          result.candidates.push({ name, available: !!value && typeof value === 'object' && !Array.isArray(value) });
        }
      }
    } else {
      const dir = await opendir(canonical);
      let count = 0;
      for await (const entry of dir) {
        if (++count > 1024) fail('directory_limit');
        if (!entry.name.endsWith('.config.toml')) continue;
        const name = entry.name.slice(0, -'.config.toml'.length);
        try { if (!normalizeCodexProfile(name)) continue; } catch { continue; }
        if (!name) continue;
        if (result.candidates.length >= 128) fail('too_many_profiles');
        try { readToml(canonical, entry.name); result.candidates.push({ name, available: true }); }
        catch (error) { result.candidates.push({ name, available: false, error: errorCode(error) }); }
      }
    }
    result.candidates.sort((a, b) => a.name.localeCompare(b.name));
    result.status = result.candidates.length ? 'ok' : 'empty';
  } catch (error) {
    result.error = errorCode(error);
    result.status = result.error === 'unreadable' ? 'unreadable'
      : /unsupported|unconfirmed|unknown|binary_unavailable/.test(result.error) ? 'unsupported' : 'scan_failed';
    result.candidates = [];
  }
  return result;
}
export async function validateCodexProfile(cfg: ProfileLaunch, name: string, frozenHome?: string): Promise<string> {
  normalizeCodexProfile(name);
  const result = await scanCodexProfiles(cfg, frozenHome);
  if (!['ok', 'empty'].includes(result.status)) fail(result.error ?? result.status);
  const candidate = result.candidates.find(p => p.name === name);
  if (!candidate) return fail('not_found');
  if (!candidate.available) fail(candidate.error ?? 'invalid_profile');
  return result.source!;
}
