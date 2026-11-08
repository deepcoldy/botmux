/**
 * The one classification of "is this session executing a workflow node, and
 * which kind" (design 2026-11-03 §4.2). Everything that differs between an
 * ordinary session and a node session reads it: the routing discovery hint,
 * the built-in skill catalog / `botmux skill list` / `botmux skill show`, and
 * which copy of the native plugin dir the CLI loads.
 *
 * - `ordinary`: a bot's ordinary session. It may become a workflow's main bot,
 *   so it gets the discovery hint and can read the main-bot workflow skills
 *   on demand.
 * - `legacyNodeWorker`: a process a workflow itself starts to do one step —
 *   the ephemeral v3 goal worker and the Architect, forked by
 *   `v3/ephemeral-pool.ts` with `BOTMUX_V3_GOAL=1` and `BOTMUX_WORKFLOW=1`
 *   (their CLI children inherit both). Its only workflow skill is
 *   `botmux-goal-ask`, the ask-a-human protocol of that runtime.
 * - `botNode`: a bot's own session executing a handed-off node (the daemon
 *   marks the session; the worker exports `BOTMUX_WORKFLOW_NODE_SESSION=1` to
 *   itself and the CLI). It asks in the group and submits with `botmux
 *   report`, so it gets no workflow skill at all.
 *
 * Neither node kind starts workflows or hands its work to other bots.
 * `botNode` wins if both markers are present (the stricter set).
 *
 * Process boundaries for the bot-node marker: SESSION_TURN_MARKER_ENV_KEYS
 * scrubs it at daemon / supervisor / dashboard boot, BOTMUX_INJECTED_ENV_KEYS
 * carries it into tmux / zellij panes (utils/child-env.ts).
 */
export const WORKFLOW_NODE_SESSION_ENV = 'BOTMUX_WORKFLOW_NODE_SESSION';

export type WorkflowSessionKind = 'ordinary' | 'legacyNodeWorker' | 'botNode';

export function workflowSessionKind(env: Record<string, string | undefined> = process.env): WorkflowSessionKind {
  if (env[WORKFLOW_NODE_SESSION_ENV] === '1') return 'botNode';
  if (env.BOTMUX_V3_GOAL === '1' || env.BOTMUX_WORKFLOW === '1') return 'legacyNodeWorker';
  return 'ordinary';
}

export interface WorkflowSessionPolicy {
  /** The routing line offering to start a workflow (and `workflow` in the
   *  injection-off help pointer). */
  discoveryHint: boolean;
  /** Which on-demand workflow skills `botmux skill show` resolves (while the
   *  machine-wide workflow switch is on). */
  workflowSkills: 'mainBot' | 'goalAsk' | 'none';
  /** botmux-orchestrate / botmux-handoff: dispatching work to other bots. */
  multiBotDispatchSkills: boolean;
  /** Load the node-session copy of the shared native plugin dir. */
  nodePluginDir: boolean;
}

const POLICY: Record<WorkflowSessionKind, WorkflowSessionPolicy> = {
  ordinary: { discoveryHint: true, workflowSkills: 'mainBot', multiBotDispatchSkills: true, nodePluginDir: false },
  legacyNodeWorker: { discoveryHint: false, workflowSkills: 'goalAsk', multiBotDispatchSkills: false, nodePluginDir: true },
  botNode: { discoveryHint: false, workflowSkills: 'none', multiBotDispatchSkills: false, nodePluginDir: true },
};

export function workflowSessionPolicy(kind: WorkflowSessionKind): WorkflowSessionPolicy {
  return POLICY[kind];
}
