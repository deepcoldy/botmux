import { isAbsolute } from 'node:path';
import { locateOnPath, rawCliExecutable, resolveCommand } from '../adapters/cli/registry.js';
import type { CliId } from '../adapters/cli/types.js';
import { parseWrapperCli } from './cli-selection.js';

export interface CliAvailabilityInput {
  cliId: CliId;
  cliPathOverride?: string;
  wrapperCli?: string;
}

export interface CliAvailability {
  available: boolean;
  /** Remote/API-backed agents intentionally have no local executable. */
  localExecutableRequired: boolean;
  /** Command the actual first local process (or nested runner dependency) needs. */
  command?: string;
  resolvedPath?: string;
  reason?: string;
}

export function hasAgentLaunchConfigChanged(
  before: CliAvailabilityInput,
  after: CliAvailabilityInput,
): boolean {
  return (
    after.cliId !== before.cliId
    || (after.cliPathOverride ?? '') !== (before.cliPathOverride ?? '')
    || (after.wrapperCli ?? '') !== (before.wrapperCli ?? '')
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
function requiredCommand(input: CliAvailabilityInput): string | undefined {
  const wrapperBin = input.wrapperCli ? parseWrapperCli(input.wrapperCli)[0] : undefined;
  if (wrapperBin) return wrapperBin;

  if (input.cliId === 'riff' || input.cliId === 'mira') return undefined;
  if (input.cliId === 'mir') return input.cliPathOverride?.trim() || process.env.MIRCLI_BIN?.trim() || 'mircli';
  return rawCliExecutable(input.cliId, input.cliPathOverride);
}

/**
 * Check launch availability with the same shell-aware resolution used by the
 * worker.  The fast PATH check avoids shell startup in the common case; the
 * fallback still finds nvm/fnm/rc-only installs and the macOS Codex.app binary.
 */
export function checkCliAvailability(
  input: CliAvailabilityInput,
  opts: { shellFallback?: boolean } = {},
): CliAvailability {
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
  };
}

export function cliUnavailableMessage(input: CliAvailabilityInput, displayName?: string): string | undefined {
  const result = checkCliAvailability(input);
  if (result.available) return undefined;
  const name = displayName?.trim() || input.cliId;
  return `无法启动 ${name}：${result.reason ?? '本地启动依赖不可用'}。请先在运行 botmux daemon 的这台机器上安装或修正 PATH / CLI 路径。`;
}
