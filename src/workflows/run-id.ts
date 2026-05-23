import { randomUUID } from 'node:crypto';

export function mintWorkflowRunId(workflowId: string, nowMs = Date.now()): string {
  const safeWorkflowId = workflowId.replace(/[^A-Za-z0-9_.-]/g, '_');
  const ts = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  return `${safeWorkflowId}-${ts}-${randomUUID().slice(0, 8)}`;
}
