import { writeSync } from 'node:fs';
import { formatRejectionReason } from './daemon-rejection-guard.js';

/** An uncaught exception may have interrupted arbitrary state changes. Never resume the daemon. */
export function installDaemonFatalErrorGuard(): void {
  process.prependOnceListener('uncaughtException', error => {
    try {
      // Supervisor stderr may be a pipe; an async write can be lost at exit.
      writeSync(2, `[FATAL] uncaughtException in daemon; exiting for supervisor recovery\n${formatRejectionReason(error)}\n`);
    } finally {
      process.exit(1);
    }
  });
}
