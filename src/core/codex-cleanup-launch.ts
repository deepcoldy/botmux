import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** Snapshot the native executable from this launch, before a temporary alias
 * disappears. codex-app launches Node; its native executable is in --codex-bin.
 * Never resolve PATH again when the native thread ID is published later. */
export function freezeCodexCleanupLaunch(
  cliId: string, bin: string, args: readonly string[], codexHome: string,
): { codexBin: string; codexHome: string } | undefined {
  const index = args.indexOf('--codex-bin');
  const native = cliId === 'codex' ? bin : cliId === 'codex-app' && index >= 0 ? args[index + 1] : undefined;
  if (!native) return undefined;
  if (!isAbsolute(native) || !isAbsolute(codexHome)) throw new Error('Codex cleanup launch paths must be absolute');
  return { codexBin: realpathSync(native), codexHome };
}
