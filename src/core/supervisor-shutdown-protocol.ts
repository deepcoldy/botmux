/**
 * Descriptor capability required before a supervisor may signal a live daemon.
 * Bump this exact value whenever shutdown safety depends on a protocol that an
 * already-running older daemon does not implement.
 */
export const SUPERVISOR_SHUTDOWN_PROTOCOL = 'riff-fleet-prepare-persist-commit-exit42-v2' as const;

/**
 * PM2 normalizes signal-only child exits to code 0 (`code || 0`) before it
 * evaluates `stop_exit_codes`. Zero therefore cannot prove that the daemon
 * completed the protocol above: SIGKILL/OOM may look identical. Only the
 * successful end of daemon.shutdown() exits with this reserved non-zero code.
 */
export const DAEMON_GRACEFUL_EXIT_CODE = 42 as const;

export type SupervisorShutdownProtocol = typeof SUPERVISOR_SHUTDOWN_PROTOCOL;
