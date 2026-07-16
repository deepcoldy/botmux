/**
 * Frozen v2 identifier helper retained solely for archive projection/replay.
 * Its output is persisted in historical event logs, so changing these bytes
 * would make archived runs project differently after the v2 runtime removal.
 */
export function workActivityId(runId: string, nodeId: string): string {
  return `${runId}::work::${nodeId}`;
}
