import { spawn, type ChildProcess } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { logger } from '../utils/logger.js';

export const SCHEDULE_PRECONDITION_DEFAULT_TIMEOUT_MS = 30_000;
export const SCHEDULE_PRECONDITION_DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
export const SCHEDULE_PRECONDITION_DEFAULT_MAX_PROMPT_BYTES = 64 * 1024;

export type SchedulePreconditionResult =
  | { decision: 'pass'; additionalPrompt?: string }
  | { decision: 'skip' };

export type SchedulePreconditionErrorCode =
  | 'spawn_failed'
  | 'timed_out'
  | 'output_limit_exceeded'
  | 'invalid_prompt_encoding'
  | 'non_zero_exit';

export class SchedulePreconditionError extends Error {
  constructor(
    readonly code: SchedulePreconditionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SchedulePreconditionError';
  }
}

export interface SchedulePreconditionRunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxPromptBytes?: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function terminateProcessGroup(child: ChildProcess): void {
  const pid = child.pid;
  let groupError: unknown;
  if (pid !== undefined) {
    try {
      // The child is spawned as its own process group. Killing the group also
      // cleans up ordinary subprocesses created by the condition script.
      process.kill(-pid, 'SIGKILL');
      return;
    } catch (error) {
      // The group may already be gone. Fall back to the direct child below.
      groupError = error;
    }
  }
  try {
    child.kill('SIGKILL');
  } catch (directError) {
    const directCode = directError && typeof directError === 'object' && 'code' in directError
      ? String((directError as NodeJS.ErrnoException).code)
      : undefined;
    const groupCode = groupError && typeof groupError === 'object' && 'code' in groupError
      ? String((groupError as NodeJS.ErrnoException).code)
      : undefined;
    if (directCode !== 'ESRCH' || (groupCode !== undefined && groupCode !== 'ESRCH')) {
      logger.warn(
        `[scheduler] Could not terminate Bash precondition process${pid ? ` ${pid}` : ''}: `
        + `${directError instanceof Error ? directError.message : String(directError)}`,
      );
    }
  }
}

function spawnBash(script: string, workingDir: string) {
  return spawn('/bin/bash', ['-c', script], {
    cwd: workingDir,
    detached: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
}

/**
 * Run one scheduled-task Bash precondition on the scheduler host.
 *
 * The script is passed as a single argv item to `/bin/bash -c`; no command
 * string is assembled by Botmux. Only a clean exit whose trimmed stdout is the
 * exact string `1` passes. A passing script may write a per-run prompt to file
 * descriptor 3. A clean exit with any other stdout is a normal skip;
 * operational failures reject so callers can record an actionable error.
 */
export function runSchedulePrecondition(
  script: string,
  workingDir: string,
  options: SchedulePreconditionRunOptions = {},
): Promise<SchedulePreconditionResult> {
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? SCHEDULE_PRECONDITION_DEFAULT_TIMEOUT_MS,
    'timeoutMs',
  );
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes ?? SCHEDULE_PRECONDITION_DEFAULT_MAX_OUTPUT_BYTES,
    'maxOutputBytes',
  );
  const maxPromptBytes = positiveInteger(
    options.maxPromptBytes ?? SCHEDULE_PRECONDITION_DEFAULT_MAX_PROMPT_BYTES,
    'maxPromptBytes',
  );

  return new Promise<SchedulePreconditionResult>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const promptOutput: Buffer[] = [];
    let outputBytes = 0;
    let promptBytes = 0;
    let terminalError: SchedulePreconditionError | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    let child: ReturnType<typeof spawnBash>;
    try {
      child = spawnBash(script, workingDir);
    } catch (cause) {
      reject(new SchedulePreconditionError(
        'spawn_failed',
        'Scheduled task precondition could not start /bin/bash',
        { cause },
      ));
      return;
    }

    const finishReject = (error: SchedulePreconditionError): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };

    const abort = (error: SchedulePreconditionError): void => {
      if (terminalError || settled) return;
      terminalError = error;
      terminateProcessGroup(child);
      finishReject(error);
    };

    const collect = (target: Buffer[] | undefined, chunk: Buffer | string): void => {
      if (terminalError || settled) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      if (target && remaining > 0) target.push(data.subarray(0, remaining));
      outputBytes += data.length;
      if (outputBytes > maxOutputBytes) {
        abort(new SchedulePreconditionError(
          'output_limit_exceeded',
          `Scheduled task precondition exceeded the ${maxOutputBytes}-byte output limit; reduce stdout/stderr output`,
        ));
      }
    };

    const collectPrompt = (chunk: Buffer | string): void => {
      if (terminalError || settled) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxPromptBytes - promptBytes);
      if (remaining > 0) promptOutput.push(data.subarray(0, remaining));
      promptBytes += data.length;
      if (promptBytes > maxPromptBytes) {
        abort(new SchedulePreconditionError(
          'output_limit_exceeded',
          `Scheduled task precondition exceeded the ${maxPromptBytes}-byte prompt output limit; reduce file descriptor 3 output`,
        ));
      }
    };

    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    const promptStream = child.stdio[3];
    if (!stdoutStream || !stderrStream || !promptStream) {
      terminateProcessGroup(child);
      finishReject(new SchedulePreconditionError(
        'spawn_failed',
        'Scheduled task precondition could not initialize Bash output pipes',
      ));
      return;
    }

    stdoutStream.on('data', chunk => collect(stdout, chunk));
    // stderr contributes to the resource limit but is deliberately not copied
    // into the persisted scheduler error: schedule rows can be shown on a
    // public read-only dashboard, and condition diagnostics may contain secrets.
    stderrStream.on('data', chunk => collect(undefined, chunk));
    promptStream.on('data', collectPrompt);

    child.once('error', (cause: Error) => {
      terminateProcessGroup(child);
      finishReject(new SchedulePreconditionError(
        'spawn_failed',
        'Scheduled task precondition could not start /bin/bash',
        { cause },
      ));
    });

    // If Bash exits while an ordinary background child still holds an output
    // pipe open, Node's `close` event would otherwise wait for that child.
    // Reap the remaining process group before evaluating the captured result.
    child.once('exit', () => terminateProcessGroup(child));

    child.once('close', (exitCode, signal) => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      if (terminalError) {
        finishReject(terminalError);
        return;
      }
      if (exitCode !== 0) {
        const exitDescription = exitCode === null
          ? `signal ${signal ?? 'unknown'}`
          : `exit code ${exitCode}`;
        finishReject(new SchedulePreconditionError(
          'non_zero_exit',
          `Scheduled task precondition failed with ${exitDescription}`,
        ));
        return;
      }

      if (Buffer.concat(stdout).toString('utf8').trim() !== '1') {
        settled = true;
        resolve({ decision: 'skip' });
        return;
      }

      let additionalPrompt: string;
      try {
        additionalPrompt = new TextDecoder('utf-8', { fatal: true })
          .decode(Buffer.concat(promptOutput));
      } catch {
        finishReject(new SchedulePreconditionError(
          'invalid_prompt_encoding',
          'Scheduled task precondition prompt output must be valid UTF-8',
        ));
        return;
      }

      settled = true;
      resolve(additionalPrompt.length > 0
        ? { decision: 'pass', additionalPrompt }
        : { decision: 'pass' });
    });

    timer = setTimeout(() => {
      abort(new SchedulePreconditionError(
        'timed_out',
        `Scheduled task precondition timed out after ${timeoutMs}ms; shorten the script`,
      ));
    }, timeoutMs);
  });
}
