/**
 * Workflow node sessions (design 2026-11-03 §4.2): a bot's ordinary session
 * that its daemon opened (or re-used) for a verified workflow handoff. It is
 * executing one node, never deciding whether to start a workflow, so it gets
 * neither the routing discovery hint nor the workflow skill family — the
 * handoff message itself carries everything the node needs.
 *
 * The daemon persists the marker on the session and hands it to the worker,
 * which exports it to its own process (where CLI system prompts are built) and
 * to the CLI child (where `botmux skill show` runs). Ephemeral goal workers and
 * the Architect are a different kind of workflow sub-session with their own
 * markers (`BOTMUX_V3_GOAL` / `BOTMUX_WORKFLOW`); this one deliberately keeps
 * `botmux send` / `botmux ask` working, which those markers forbid.
 */
export const WORKFLOW_NODE_SESSION_ENV = 'BOTMUX_WORKFLOW_NODE_SESSION';
// Process boundaries: SESSION_TURN_MARKER_ENV_KEYS scrubs it (daemon /
// supervisor / dashboard boot), BOTMUX_INJECTED_ENV_KEYS carries it into
// tmux / zellij panes (utils/child-env.ts).

export function isWorkflowNodeSessionEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env[WORKFLOW_NODE_SESSION_ENV] === '1';
}
