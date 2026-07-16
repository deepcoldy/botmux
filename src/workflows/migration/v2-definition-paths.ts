import { join } from 'node:path';

/** Frozen v2 definition discovery order used only by the migration scanner. */
export function legacyWorkflowDefinitionSearchPaths(workflowId: string): string[] {
  const home = process.env.HOME;
  return [
    join(process.cwd(), 'workflows', `${workflowId}.workflow.json`),
    join(home ?? '', '.botmux', 'workflows', `${workflowId}.workflow.json`),
  ];
}
