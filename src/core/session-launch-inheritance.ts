import type { Session } from '../types.js';

/** Fork and clean recovery must carry the same recorded launch decisions.
 * Native conversation/pane IDs, routing and caller authority are not launch
 * configuration; each lifecycle entry sets those explicitly. */
export function inheritSessionLaunchConfiguration(source: Session, target: Session): void {
  const fields = [
    'cliId', 'cliInstanceBinding', 'cliRuntime', 'cliPathOverride', 'cliConfigDir',
    'wrapperCli', 'cliLaunchMode', 'agentFrozen', 'cliLaunchSnapshot', 'backendType',
    'model', 'modelBackendVariant', 'reasoningEffort', 'serviceTier',
    'sandbox', 'sandboxPaths', 'sandboxScratch', 'sandboxHidePaths',
    'sandboxReadonlyPaths', 'sandboxNetwork', 'sandboxNetworkPolicy', 'autoWorktreeFallbackDir',
  ] as const satisfies readonly (keyof Session)[];
  Object.assign(target, structuredClone(Object.fromEntries(fields.map(key => [key, source[key]]))));
}
