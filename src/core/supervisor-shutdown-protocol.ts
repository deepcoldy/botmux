import { PM2_GRACEFUL_EXIT_CODE } from '../pm2-graceful-exit.js';

/**
 * PM2 normalizes signal-only child exits to code 0 (`code || 0`) before it
 * evaluates `stop_exit_codes`. Zero therefore cannot prove that the daemon
 * completed its shutdown protocol: SIGKILL/OOM may look identical. Only the
 * successful end of a supervised daemon.shutdown() exits with this reserved
 * non-zero code; foreground launches keep the conventional zero exit.
 */
export const DAEMON_GRACEFUL_EXIT_CODE = PM2_GRACEFUL_EXIT_CODE;
