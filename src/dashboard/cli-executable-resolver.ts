import { isAbsolute } from 'node:path';
import { isExecutablePathReference, resolveCommandAsync } from '../adapters/cli/registry.js';
import { selectCodexRuntimeUpdateTargets, type ConfiguredCliRuntime } from '../core/cli-runtime-update.js';

/** Per-request de-duplication. Login-shell PATH discovery must never run
 * synchronously on the shared Dashboard HTTP event loop.
 */
export function createDashboardExecutableResolver(
  env: NodeJS.ProcessEnv = process.env,
  probe: typeof resolveCommandAsync = resolveCommandAsync,
): (command: string) => Promise<string> {
  const pending = new Map<string, Promise<string>>();
  return rawCommand => {
    const command = rawCommand.trim();
    if (!command) return Promise.reject(new Error('cli_executable_unresolved'));
    // Legacy cliPathOverride accepts relative launchers. Direct path references
    // are already in their final form, so adapters' lazy resolveCommand is also
    // a no-probe operation for them.
    if (isExecutablePathReference(command)) return Promise.resolve(command);
    let result = pending.get(command);
    if (!result) {
      result = probe(command, { env }).then(value => {
        // An unresolved bare name would make a synchronous adapter repeat the
        // login-shell lookup and reintroduce the event-loop stall.
        if (!isAbsolute(value.resolved)) throw new Error('cli_executable_unresolved');
        return value.resolved;
      });
      pending.set(command, result);
    }
    return result;
  };
}

export async function resolveDashboardRuntimeUpdateTargets(
  configs: ConfiguredCliRuntime[],
  resolve: (command: string) => Promise<string> = createDashboardExecutableResolver(),
) {
  const commandOf = (override?: string | null) => override?.trim() || 'codex';
  const commands = new Set(configs.filter(bot => bot.cliId === 'codex' || bot.cliId === 'codex-app')
    .map(bot => commandOf(bot.cliRuntime?.executable ?? bot.cliPathOverride)));
  const resolved = new Map<string, string>();
  await Promise.all([...commands].map(async command => {
    try { resolved.set(command, await resolve(command)); } catch { /* unavailable target stays hidden */ }
  }));
  return selectCodexRuntimeUpdateTargets(configs, override => {
    const path = resolved.get(commandOf(override));
    if (!path) throw new Error('cli_executable_unresolved');
    return path;
  });
}
