import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'smol-toml';
import type { BotConfig } from '../bot-registry.js';
import { botInjectedEnv, buildSessionChildEnv } from '../core/env-policy.js';
import { envSandboxMode } from '../adapters/cli/sandbox-mode.js';

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
export type CodexProfileCapability = { version: string; format: 'files' | 'legacy' };
/**
 * 配置层门控：结论只由 bots.json 条目自身的字段决定，不读任何 process.env、
 * 平台或其它进程/机器事实。配置解析与每个 bots.json 持久化写入面共用它，
 * 因此同一份配置文件在任何启动环境下的解析结果完全一致，不会因 env 不同
 * 而让整份 bots.json 加载失败。
 */
export function assertCodexProfileConfig(cfg: ProfileLaunch): void {
  if (cfg.cliId !== 'codex' || cfg.wrapperCli || cfg.cliLaunchMode || (cfg.cliPathOverride && !cfg.cliRuntime)
      || cfg.existingAppServer || cfg.startupCommands?.length || cfg.env?.PATH
      || cfg.codexInstancePool?.enabled || cfg.codexAuthSync === 'isolated'
      || cfg.readIsolation || (cfg.sandbox && cfg.sandbox !== 'off')
      || (cfg.backendType && !['pty', 'tmux'].includes(cfg.backendType))) fail('unsupported_launch');
  if (cfg.codexRpcInput && cfg.backendType === 'tmux') fail('unsupported_rpc');
  if (cfg.serviceTier && cfg.serviceTier !== 'default') fail('unsupported_service_tier');
}
/**
 * 运行时门控：配置层通过后，再按「这台机器、这个进程」的事实拒绝——平台
 * 支持情况与机器级强制沙箱开关（BOTMUX_SANDBOX 的 1/oncall/scratch 三个
 * 激活值，非法值由 envSandboxMode 自身 fail-closed 抛错）。只在真实扫描、
 * 保存探测和 worker 启动路径调用，绝不用于配置解析。
 */
export function assertCodexProfileRuntime(cfg: ProfileLaunch): void {
  assertCodexProfileConfig(cfg);
  if (!['linux', 'darwin'].includes(process.platform)) fail('unsupported_launch');
  if (envSandboxMode(process.env.BOTMUX_SANDBOX) !== 'off') fail('unsupported_launch');
}
/**
 * Loader-level content gate reusable by every bots.json WRITE surface without
 * pulling the whole registry parser (which would couple the low-level config
 * primitive to the giant bot-registry module and break under partial mocks).
 * Only entries this write creates or changes are checked — an unchanged legacy
 * entry must never block an edit to another bot (same semantics as
 * assertChangedBotConfigInvariants). It mirrors exactly the two calls
 * parseBotConfigsFromText runs for this field (name normalization + config
 * launch assertion), so a profile entry that passes here parses there too.
 */
export function assertChangedBotsCodexProfile(previous: any[], next: any[]): void {
  for (let index = 0; index < next.length; index++) {
    const entry = next[index] as (ProfileLaunch & { codexProfile?: unknown; larkAppId?: string });
    const previousEntry = entry?.larkAppId
      ? previous.find(candidate => candidate?.larkAppId === entry.larkAppId)
      : previous[index];
    if (previousEntry !== undefined && JSON.stringify(previousEntry) === JSON.stringify(entry)) continue;
    const codexProfile = normalizeCodexProfile(entry?.codexProfile);
    if (codexProfile) assertCodexProfileConfig(entry);
  }
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
/**
 * Probe the target CLI's version/--profile support once. The result is tied to
 * a frozen home, so callers that validate twice in one launch (worker: early
 * gate + final child-env gate) can reuse it; the on-disk profile files are
 * still re-read on every scan, so a deletion between the two checks is caught.
 */
export async function probeCodexProfileCapability(cfg: ProfileLaunch, frozenHome?: string): Promise<{ home: string; capability: CodexProfileCapability }> {
  assertCodexProfileRuntime(cfg);
  const home = frozenHome ?? resolveCodexProfileHome(cfg);
  if (!isAbsolute(home)) fail('home_must_be_absolute');
  return { home, capability: await capability(cfg, home) };
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
/**
 * @param pre Probed capability/home from {@link probeCodexProfileCapability}.
 * Reusing it skips the --version/--help execs (a worker launch validates twice);
 * every call still re-reads the profile files, so a mid-launch deletion fails.
 */
export async function scanCodexProfiles(
  cfg: ProfileLaunch,
  frozenHome?: string,
  pre?: { home: string; capability: CodexProfileCapability },
): Promise<CodexProfileCatalog> {
  const result: CodexProfileCatalog = { status: 'scan_failed', candidates: [] };
  try {
    assertCodexProfileRuntime(cfg);
    const home = pre?.home ?? frozenHome ?? resolveCodexProfileHome(cfg);
    if (!isAbsolute(home)) fail('home_must_be_absolute');
    result.source = home;
    Object.assign(result, pre?.capability ?? await capability(cfg, home));
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
export async function validateCodexProfile(
  cfg: ProfileLaunch,
  name: string,
  frozenHome?: string,
  pre?: { home: string; capability: CodexProfileCapability },
): Promise<string> {
  normalizeCodexProfile(name);
  const result = await scanCodexProfiles(cfg, frozenHome, pre);
  if (!['ok', 'empty'].includes(result.status)) fail(result.error ?? result.status);
  const candidate = result.candidates.find(p => p.name === name);
  if (!candidate) return fail('not_found');
  if (!candidate.available) fail(candidate.error ?? 'invalid_profile');
  return result.source!;
}
