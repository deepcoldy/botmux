import type { DaemonToWorker } from '../../types.js';

type WorkerInit = Extract<DaemonToWorker, { type: 'init' }>;

export type WorkflowSandboxPolicySource = {
  sandbox?: boolean;
  sandboxHidePaths?: string[];
  sandboxReadonlyPaths?: string[];
  sandboxNetwork?: boolean;
};

export type WorkflowSandboxInitFields = Pick<
  WorkerInit,
  'sandbox' | 'sandboxHidePaths' | 'sandboxReadonlyPaths' | 'sandboxNetwork'
>;

export function workflowSandboxInitFields(
  policy: WorkflowSandboxPolicySource | undefined,
): WorkflowSandboxInitFields {
  return {
    sandbox: policy?.sandbox === true,
    sandboxHidePaths: [...(policy?.sandboxHidePaths ?? [])],
    sandboxReadonlyPaths: [...(policy?.sandboxReadonlyPaths ?? [])],
    sandboxNetwork: policy?.sandboxNetwork !== false,
  };
}
