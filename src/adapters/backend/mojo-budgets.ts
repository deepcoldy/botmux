/**
 * Shared adapter/daemon budgets for an explicit Mojo close.
 *
 * This is deliberately a dependency-free module: worker-pool tests mock the
 * Mojo backend as a process boundary, but both sides still need one source of
 * truth for the nested timeout relationship.
 */
export const MOJO_CLI_TIMEOUT_MS = 60_000;
export const MOJO_DESTROY_SETTLE_MS = 8_000;
export const MOJO_EXPLICIT_CLOSE_RESULT_TIMEOUT_MS = 75_000;
export const MOJO_EXPLICIT_CLOSE_HEADROOM_MS =
  MOJO_EXPLICIT_CLOSE_RESULT_TIMEOUT_MS - MOJO_CLI_TIMEOUT_MS - MOJO_DESTROY_SETTLE_MS;
