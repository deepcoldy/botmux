/**
 * Supported daemon-independent v3 workflow surface.
 *
 * Keep this module limited to schema, pure scheduling/control policy, and
 * host contracts. Node filesystem stores and Botmux/Lark adapters live behind
 * separate modules.
 */

export {
  DEFAULT_HUMAN_GATE_OPTIONS,
  DEFAULT_REVISIT_BUDGET_PER_PAIR,
  DEFAULT_REVISIT_BUDGET_PER_RUN,
  isGoalNode,
  isHostNode,
  isLoopNode,
  loopInstanceId,
  topologicalOrder,
  validateDag,
} from './dag.js';
export type {
  V3Dag,
  V3DependRef,
  V3EdgeWhen,
  V3GoalNode,
  V3HostNode,
  V3HumanGate,
  V3LoopExitWhen,
  V3LoopNode,
  V3Node,
  V3TriggerRule,
} from './dag.js';
export {
  decideNext,
  findSinks,
} from './orchestrator.js';
export type {
  V3Action,
  V3EdgeRunState,
  V3LoopRunState,
  V3NodeState,
  V3NodeStatus,
  V3RunState,
} from './orchestrator.js';
export {
  matchLoopExitWhen,
  revisitBudgetStatus,
} from './core-control.js';
export {
  canResolveGateWait,
  normalizeGateWaitInput,
  selectedResolution,
} from './gate-policy.js';
export type { NormalizedGatePolicy } from './gate-policy.js';
export type {
  AttemptLease,
  ExecutionContextSnapshot,
  GateResolution,
  GateResolutionRequest,
  GateResolver,
  HostExecutorPolicy,
  HostExecutorPolicyRequest,
} from './runtime-host-contract.js';
export type {
  StoredEvent,
  V3Event,
  V3LoopRef,
} from './event-contract.js';
