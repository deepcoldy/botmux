/**
 * Workflow sub-sessions are the processes a workflow itself starts to do one
 * step: today the ephemeral v3 goal worker and the Architect, both forked by
 * `v3/ephemeral-pool.ts` with `BOTMUX_V3_GOAL=1` and `BOTMUX_WORKFLOW=1` (their
 * CLI children inherit both). Such a session is executing a node, never
 * deciding whether to start a workflow, so it must not be offered the
 * workflow discovery hint or the orchestration skill — only what the node needs
 * (design: docs/design/2026-11-03-workflow-bot-handoff.md §4.2).
 */
export function isWorkflowSubagentEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env.BOTMUX_V3_GOAL === '1' || env.BOTMUX_WORKFLOW === '1';
}
