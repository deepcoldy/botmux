import type { Session } from '../types.js';

/** Fork and clean recovery must carry the same recorded launch decisions.
 * Native conversation/pane IDs, routing and caller authority are not launch
 * configuration; each lifecycle entry sets those explicitly. */
export function inheritSessionLaunchConfiguration(source: Session, target: Session): void {
  if (source.modelPin) target.modelPin = structuredClone(source.modelPin);
  const fields = [
    'cliId', 'cliInstanceBinding', 'cliRuntime', 'cliPathOverride', 'cliConfigDir',
    'wrapperCli', 'cliLaunchMode', 'agentFrozen', 'cliLaunchSnapshot', 'backendType',
    'codexProfile', 'codexProfileHome', 'model', 'modelBackendVariant', 'reasoningEffort', 'serviceTier', 'quotaFallback',
    'sandbox', 'sandboxPaths', 'sandboxScratch', 'sandboxHidePaths',
    'sandboxReadonlyPaths', 'sandboxNetwork', 'sandboxNetworkPolicy', 'sandboxWithholdBotSecret', 'autoWorktreeFallbackDir',
    // 个人助理模式的归属是启动决定的一部分（cwd / CLI 数据目录 / 沙盒子树都跟着它）。
    'assistantOwnerOpenId',
  ] as const satisfies readonly (keyof Session)[];
  Object.assign(target, structuredClone(Object.fromEntries(fields.map(key => [key, source[key]]))));
}
