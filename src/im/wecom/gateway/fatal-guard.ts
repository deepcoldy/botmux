import { writeSync } from 'node:fs';

/**
 * Last resort for a gateway run: an uncaught exception or an unhandled promise
 * rejection would otherwise end the process at once, skipping the shutdown that
 * stops the managed core. The core then lives on as an orphan holding the core
 * port. The guard stops the core first, then exits with the code `exitCode`
 * gives at that moment: a plain failure (1), so a supervisor restarts the
 * gateway — unless the run had already settled on a reason retrying cannot fix
 * (it was replaced, say, and the error came while it shut down), which keeps
 * its no-restart code and its desired-state record.
 *
 * The process never resumes normal work after a fatal error: a second error
 * while the core is being stopped is ignored, and the process exits once the
 * core is stopped or `deadlineMs` has passed, whichever comes first.
 */
export interface WecomGatewayFatalGuardOptions {
  /** Stop the managed core (no-op when none was started yet). */
  stopCore: () => Promise<void>;
  deadlineMs: number;
  /** The exit code, asked once the core is stopped (or the deadline passed); default 1. */
  exitCode?: () => number;
  /** Test seam; production exits the process. */
  exit?: (code: number) => void;
  /** Test seam; production listens on `process`. */
  events?: Pick<NodeJS.EventEmitter, 'on' | 'off'>;
}

function describeFatal(error: unknown): string {
  if (!(error instanceof Error)) {
    return '非 Error 值';
  }
  // Never print messages that may carry configuration values or credentials.
  const message = /secret|token|https?:/i.test(error.message) ? '（消息已隐去）' : error.message;
  const frames = (error.stack ?? '').split('\n').filter(line => /^\s+at\s/.test(line)).slice(0, 8);
  return [`${error.name}: ${message}`, ...frames].join('\n');
}

/** Returns a function that removes the guard. */
export function installWecomGatewayFatalGuard(options: WecomGatewayFatalGuardOptions): () => void {
  let fired = false;
  let exited = false;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const events = options.events ?? process;
  const finish = () => {
    if (exited) {
      return;
    }
    exited = true;
    let code = 1;
    try {
      code = options.exitCode?.() ?? 1;
    } catch {
      /* still exit: a plain failure */
    }
    exit(code);
  };
  const onFatal = (kind: string, error: unknown) => {
    if (fired) {
      return;
    }
    fired = true;
    try {
      writeSync(2, `[wecom] 网关内部错误（${kind}），停止 core 后退出\n${describeFatal(error)}\n`);
    } catch {
      /* stderr gone: still stop the core */
    }
    const deadline = setTimeout(finish, options.deadlineMs);
    void options.stopCore()
      .catch(() => {})
      .finally(() => {
        clearTimeout(deadline);
        finish();
      });
  };
  const onException = (error: Error) => onFatal('uncaughtException', error);
  const onRejection = (reason: unknown) => onFatal('unhandledRejection', reason);
  events.on('uncaughtException', onException);
  events.on('unhandledRejection', onRejection);
  return () => {
    events.off('uncaughtException', onException);
    events.off('unhandledRejection', onRejection);
  };
}
