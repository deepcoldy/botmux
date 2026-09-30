import { lstatSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { resolveCommandReal } from '../adapters/cli/registry.js';

export interface CodexUpgradeCommandOptions {
  cliPathOverride?: string;
  cliRuntime?: { source: string };
  wrapperCli?: string;
}

/** Select the installed official release without letting an older PATH entry
 * mask the managed current pointer. Explicit runtime selections keep their
 * existing resolver; this never downloads or changes an installation. */
export function resolveCodexUpgradeCommand(options: CodexUpgradeCommandOptions = {}): string {
  if (options.cliPathOverride !== undefined
      || (options.cliRuntime && options.cliRuntime.source !== 'official')) {
    return resolveCommandReal(options.cliPathOverride ?? 'codex');
  }

  // Installation belongs to the host user, not a bot's redirected CODEX_HOME.
  const home = homedir();
  const standalone = join(home, '.codex', 'packages', 'standalone');
  const current = join(standalone, 'current');
  try {
    lstatSync(current);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolveCommandReal('codex');
    throw new Error('Cannot inspect the managed Codex current installation', { cause: error });
  }

  try {
    const target = realpathSync(join(current, 'bin', 'codex'));
    const entry = realpathSync(join(home, '.local', 'bin', 'codex'));
    if (entry !== target) throw new Error('The user Codex entry does not point to managed current');
    const releasePath = relative(realpathSync(join(standalone, 'releases')), target).split(sep);
    if (releasePath.length !== 3 || !releasePath[0] || releasePath[0] === '..'
        || releasePath[1] !== 'bin' || releasePath[2] !== 'codex'
        || !statSync(target).isFile()) {
      throw new Error('Managed current is not a releases/<release>/bin/codex executable');
    }
    return resolveCommandReal(target);
  } catch (error) {
    throw new Error(`Cannot select the managed Codex upgrade target: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
