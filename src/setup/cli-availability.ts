import { isAbsolute } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { locateOnPath, rawCliExecutable, resolveCommand, resolveCommandAsync } from '../adapters/cli/registry.js';
import { locateExecutable } from '../utils/executable.js';
import type { CliId } from '../adapters/cli/types.js';
import { parseWrapperCli } from './cli-selection.js';
import type { CliLaunchMode } from '../core/cli-launch-mode.js';

export interface CliAvailabilityInput {
  cliId: CliId;
  cliPathOverride?: string;
  wrapperCli?: string;
  cliLaunchMode?: CliLaunchMode;
}

export interface CliAvailability {
  available: boolean;
  /** Remote/API-backed agents intentionally have no local executable. */
  localExecutableRequired: boolean;
  /** Command the actual first local process (or nested runner dependency) needs. */
  command?: string;
  resolvedPath?: string;
  reason?: string;
  /** The launch failed only because an executable is not there (not found on
   *  PATH / at its configured path) — as opposed to a failed readiness check
   *  or an invalid launch configuration. */
  missingExecutable?: boolean;
}

export type CliAvailabilityStatus = 'available' | 'unavailable' | 'unknown';
export type CliAvailabilityProbe = CliAvailability & { status: CliAvailabilityStatus };

/** A shell-free PATH miss is only preliminary, including Forge doctor. */
export function preliminaryCliAvailability(input: CliAvailabilityInput): CliAvailabilityProbe {
  const result = checkCliAvailability(input, { shellFallback: false });
  return { ...result, status: result.available && input.cliLaunchMode !== 'forge-traex' ? 'available' : 'unknown' };
}

export function hasAgentLaunchConfigChanged(
  before: CliAvailabilityInput,
  after: CliAvailabilityInput,
): boolean {
  return (
    after.cliId !== before.cliId
    || (after.cliPathOverride ?? '') !== (before.cliPathOverride ?? '')
    || (after.wrapperCli ?? '') !== (before.wrapperCli ?? '')
    || (after.cliLaunchMode ?? '') !== (before.cliLaunchMode ?? '')
  );
}

/**
 * Return the executable that must exist before this agent can start.
 *
 * Most adapters spawn `resolvedBin` directly.  There are three important
 * exceptions which caused setup/runtime checks to report the wrong result:
 *
 * - wrapperCli replaces the adapter binary, so the wrapper's first token is
 *   the real executable (aiden/cjadk/ttadk/custom gateway);
 * - Codex App starts a bundled Node runner which then starts `codex`;
 * - Mir starts a bundled Node runner which then starts `mircli`.
 *
 * Mira and Riff are API-backed and therefore have no local CLI requirement.
 */
function requiredCommand(input: CliAvailabilityInput, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const wrapperBin = input.wrapperCli ? parseWrapperCli(input.wrapperCli)[0] : undefined;
  if (wrapperBin) return wrapperBin;

  if (input.cliId === 'riff' || input.cliId === 'mira') return undefined;
  if (input.cliId === 'mir') return input.cliPathOverride?.trim() || env.MIRCLI_BIN?.trim() || 'mircli';
  return rawCliExecutable(input.cliId, input.cliPathOverride);
}

function checkCommand(command: string | undefined, opts: { shellFallback?: boolean }): CliAvailability {
  if (!command) return { available: true, localExecutableRequired: false };

  const direct = locateOnPath(command);
  if (direct) {
    return { available: true, localExecutableRequired: true, command, resolvedPath: direct };
  }

  if (opts.shellFallback !== false) {
    const resolved = resolveCommand(command);
    const found = locateOnPath(resolved);
    if (found) {
      return { available: true, localExecutableRequired: true, command, resolvedPath: found };
    }
  }

  const probe = isAbsolute(command) ? `ls -l ${command}` : `command -v ${command}`;
  return {
    available: false,
    localExecutableRequired: true,
    command,
    reason: `找不到可执行文件「${command}」（自查：${probe}）`,
    missingExecutable: true,
  };
}

function forgeDoctorAvailable(forge: CliAvailability): CliAvailability {
  try {
    execFileSync(forge.resolvedPath ?? forge.command ?? 'forge', ['doctor'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return forge;
  } catch (err: any) {
    const detail = String(err?.stderr ?? err?.stdout ?? err?.message ?? err).trim();
    return {
      ...forge,
      available: false,
      reason: `forge doctor 检查失败${detail ? `：${detail.slice(0, 500)}` : ''}`,
    };
  }
}

/**
 * Check launch availability with the same shell-aware resolution used by the
 * worker.  The fast PATH check avoids shell startup in the common case; the
 * fallback still finds nvm/fnm/rc-only installs and the macOS ChatGPT/Codex
 * desktop app binary.
 */
export function checkCliAvailability(
  input: CliAvailabilityInput,
  opts: { shellFallback?: boolean } = {},
): CliAvailability {
  if (input.cliLaunchMode === 'forge-traex') {
    if (input.cliId !== 'traex') {
      return {
        available: false,
        localExecutableRequired: true,
        reason: 'Forge x TraeX 只能用于 cliId "traex"',
      };
    }
    const traex = checkCommand(requiredCommand({ cliId: 'traex' }), opts);
    if (!traex.available) return traex;
    const forge = checkCommand('forge', opts);
    if (!forge.available) return forge;
    return opts.shellFallback === false ? forge : forgeDoctorAvailable(forge);
  }

  let command: string | undefined;
  try {
    command = requiredCommand(input);
  } catch (err) {
    return {
      available: false,
      localExecutableRequired: true,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  return checkCommand(command, opts);
}

/** Complete, nonblocking selected-Agent probe. Never executes the CLI itself,
 * except the existing Forge doctor readiness check. */
export async function checkCliAvailabilityAsync(
  input: CliAvailabilityInput,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; shellFallback?: boolean } = {},
): Promise<CliAvailabilityProbe> {
  const env = opts.env ?? process.env;
  const check = async (command: string | undefined): Promise<CliAvailabilityProbe> => {
    if (!command) return { available: true, localExecutableRequired: false, status: 'available' };
    let found = locateExecutable(command, env);
    let inconclusive = false;
    if (!found && opts.shellFallback !== false) {
      const resolved = await resolveCommandAsync(command, { env, timeoutMs: opts.timeoutMs });
      found = locateExecutable(resolved.resolved, env);
      inconclusive = resolved.inconclusive;
    }
    return found
      ? { available: true, localExecutableRequired: true, command, resolvedPath: found, status: 'available' }
      : {
          available: false, localExecutableRequired: true, command,
          status: inconclusive ? 'unknown' : 'unavailable',
          reason: inconclusive ? 'CLI 检测未完成，请稍后重试' : `找不到可执行文件「${command}」`,
          ...(inconclusive ? {} : { missingExecutable: true }),
        };
  };
  try {
    if (input.cliLaunchMode !== 'forge-traex') return await check(requiredCommand(input, env));
    if (input.cliId !== 'traex') {
      return { available: false, localExecutableRequired: true, status: 'unavailable', reason: 'Forge x TraeX 只能用于 cliId "traex"' };
    }
    const traex = await check(requiredCommand({ cliId: 'traex' }, env));
    if (!traex.available) return traex;
    const forge = await check('forge');
    if (!forge.available) return forge;
    try {
      await promisify(execFile)(forge.resolvedPath!, ['doctor'], {
        env, timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
      });
      return forge;
    } catch (err: any) {
      return { ...forge, available: false, status: err?.killed ? 'unknown' : 'unavailable', reason: 'forge doctor 检查失败' };
    }
  } catch {
    return { available: false, localExecutableRequired: true, status: 'unknown', reason: 'CLI 检测未完成，请稍后重试' };
  }
}

function unavailableMessage(result: CliAvailability, input: CliAvailabilityInput, displayName?: string): string | undefined {
  if (result.available) return undefined;
  const name = displayName?.trim() || input.cliId;
  return `无法启动 ${name}：${result.reason ?? '本地启动依赖不可用'}。请先在运行 botmux daemon 的这台机器上安装或修正 PATH / CLI 路径。`;
}

/**
 * How long a launch waits for a missing CLI executable to come back before it
 * looks again. A global reinstall (Claude Code's auto-update) leaves the
 * command absent for about 2.5 s; one look 3 s later sees it back.
 */
export const MISSING_CLI_EXECUTABLE_RETRY_MS = 3_000;

export interface MissingCliExecutableRetryDeps {
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const sleepMs = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const waitLine = (command: string) =>
  `找不到可执行文件「${command}」，${MISSING_CLI_EXECUTABLE_RETRY_MS / 1000}s 后重新解析路径再试一次（CLI 可能正在重装）`;

/**
 * The adapter a launch goes on with, given the one just built for it: when one
 * of the launch's executables is missing right now — the CLI may be
 * mid-reinstall — wait once and build it again, so everything it resolves and
 * caches (its binary, a runner's second-stage path) is resolved as things are
 * after the wait.
 *
 * Costs nothing extra when everything is there: a PATH lookup, or for a CLI
 * the adapter launches directly its resolved path, which every launch resolves
 * anyway (the adapter memoises `resolvedBin`, so an install only a login shell
 * can find is not probed a second time). An invalid launch configuration is
 * not waited for: the launch check reports it.
 */
export async function createAdapterAfterMissingCliWait<A extends { readonly resolvedBin: string }>(
  input: CliAvailabilityInput,
  adapter: A,
  create: () => A,
  deps: MissingCliExecutableRetryDeps,
): Promise<{ adapter: A; waited: boolean }> {
  let commands: string[];
  try {
    commands = input.cliLaunchMode === 'forge-traex'
      ? (input.cliId === 'traex' ? [requiredCommand({ cliId: 'traex' })!, 'forge'] : [])
      : [requiredCommand(input)].filter((command): command is string => !!command);
  } catch {
    return { adapter, waited: false };
  }
  const ownBin = rawCliExecutable(input.cliId, input.cliPathOverride);
  const missing = commands.find(command => {
    if (locateOnPath(command)) return false;
    if (command === ownBin && !input.wrapperCli) {
      // The adapter's binary, unless the adapter launches a bundled runner
      // (process.execPath) or nothing local ('') instead of the command.
      const bin = adapter.resolvedBin;
      if (bin && bin !== process.execPath) return !locateOnPath(bin);
    }
    return checkCommand(command, {}).missingExecutable === true;
  });
  if (!missing) return { adapter, waited: false };
  deps.log(waitLine(missing));
  await (deps.sleep ?? sleepMs)(MISSING_CLI_EXECUTABLE_RETRY_MS);
  return { adapter: create(), waited: true };
}

/**
 * The launch check before a spawn: why the launch cannot start, if it cannot. When the only
 * problem is a missing executable, wait once and look again before giving up —
 * unless this launch already waited (`alreadyWaited`, from
 * `createAdapterAfterMissingCliWait`): a launch waits at most once. Any other reason
 * (a failed `forge doctor`, an invalid launch configuration) fails at once, as
 * does an executable still missing after the wait — with the same message as
 * without the retry.
 */
export async function cliUnavailableMessageAfterRetry(
  input: CliAvailabilityInput,
  displayName: string | undefined,
  deps: MissingCliExecutableRetryDeps & { alreadyWaited: boolean },
): Promise<string | undefined> {
  let result = checkCliAvailability(input);
  let waited = deps.alreadyWaited;
  if (!result.available && result.missingExecutable && !waited) {
    deps.log(waitLine(result.command ?? input.cliId));
    await (deps.sleep ?? sleepMs)(MISSING_CLI_EXECUTABLE_RETRY_MS);
    result = checkCliAvailability(input);
    waited = true;
  }
  if (waited) {
    deps.log(result.available
      ? `重试成功：可执行文件已找到${result.resolvedPath ? `（${result.resolvedPath}）` : ''}，继续启动`
      : `重试后仍无法启动：${result.reason ?? '本地启动依赖不可用'}`);
  }
  return unavailableMessage(result, input, displayName);
}

/**
 * 本机为什么起不了这个 Agent 的任何新会话：只在启动要用的可执行文件确实不存在、
 * 且像启动检查那样等一次再看仍不存在时返回原因，否则 undefined。
 *
 * 判定必须比启动检查宽：返回原因就意味着本机每次启动都会失败。登录 shell 探测
 * 超时或出错只算「未知」；forge doctor 失败、启动配置非法也不算缺可执行文件，
 * 留给每次启动的检查去报。
 */
export async function missingCliExecutableAfterRetry(
  input: CliAvailabilityInput,
  deps: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<string | undefined> {
  const missing = async (): Promise<string | undefined> => {
    if (!checkCliAvailability(input, { shellFallback: false }).missingExecutable) return undefined;
    const probe = await checkCliAvailabilityAsync(input);
    return probe.missingExecutable ? probe.reason : undefined;
  };
  if (!await missing()) return undefined;
  await (deps.sleep ?? sleepMs)(MISSING_CLI_EXECUTABLE_RETRY_MS);
  return missing();
}
