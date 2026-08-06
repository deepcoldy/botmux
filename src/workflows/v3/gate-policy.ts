import {
  DEFAULT_HUMAN_GATE_OPTIONS,
  type V3HumanGate,
} from './dag.js';

export interface NormalizedGatePolicy {
  prompt: string;
  options: string[];
  approveOptions: string[];
  approvers: string[];
}

/** Normalize authored gate defaults without requiring a persistence adapter. */
export function normalizeGateWaitInput(gate: V3HumanGate): NormalizedGatePolicy {
  const options = gate.options ?? [...DEFAULT_HUMAN_GATE_OPTIONS];
  return {
    prompt: gate.prompt,
    options,
    approveOptions: gate.approveOptions ?? (options.includes('approve') ? ['approve'] : [options[0]!]),
    approvers: gate.approvers ?? [],
  };
}

export function selectedResolution(
  wait: Pick<NormalizedGatePolicy, 'options' | 'approveOptions'>,
  selected: string,
): 'approved' | 'rejected' | undefined {
  if (!wait.options.includes(selected)) return undefined;
  return wait.approveOptions.includes(selected) ? 'approved' : 'rejected';
}

export function canResolveGateWait(
  wait: Pick<NormalizedGatePolicy, 'approvers'>,
  by: string | undefined,
): boolean {
  return wait.approvers.length === 0 || (!!by && wait.approvers.includes(by));
}
