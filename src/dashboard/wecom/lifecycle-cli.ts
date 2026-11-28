/**
 * The Dashboard's only way to start, stop or restart a WeCom connection: run
 * `botmux wecom <action> <configId> --json` and read its one-line JSON result
 * (cli/wecom/fleet-lifecycle.ts). That command records the desired state and
 * hands the fleet supervisor an op under the fleet mutation lock, then waits
 * for its answer outside the lock — the Dashboard neither spawns gateways nor
 * signals processes itself.
 *
 * The child is not detached and the Dashboard does not kill it when it goes
 * away: the supervisor stops a member by signalling that one pid, so a
 * Dashboard stopped by `botmux restart` leaves the command to finish what it
 * started (its result is then simply not read).
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { globalInstallUpdateCwd } from '../../core/maintenance.js';
import { resolveCliSpawn } from '../../core/self-spawn.js';
import { redactChildEnv } from '../../utils/child-env.js';
import { isWecomDesiredStopReason, type WecomDesiredStopReason } from '../../im/wecom/config/fleet-desired-state.js';
import type { WecomConnectionAction } from '../../im/wecom/contract/dashboard-dto.js';
import { WECOM_LIFECYCLE_MAX_MS, WECOM_START_SETTLE_MS } from '../../im/wecom/contract/lifecycle-budgets.js';

/** What one `botmux wecom <action> --json` run came back with. */
export interface WecomLifecycleOutcome {
  ok: boolean;
  /** On success: started, already-online, stopped, already-stopped, restarted. */
  state?: string;
  /**
   * On failure: the command's own reason (fleet_down, timeout, gateway_exited, …),
   * or, when no result could be read: cli_unavailable (could not be run),
   * cli_timeout (killed after WECOM_LIFECYCLE_CLI_TIMEOUT_MS), cli_failed (exited
   * without a result), cli_output_invalid (exited 0 without a result).
   */
  reason?: string;
  message: string;
  desired?: 'running' | 'stopped';
  stopReason?: WecomDesiredStopReason;
}

/**
 * What a command may spend beyond its own bound and its settle window: its
 * process starting up and exiting, a desired-state write waiting for that
 * file's lock (at most 5 s), the first one-second try for the fleet lock, and
 * the last poll of each wait.
 */
const COMMAND_SLACK_MS = 15_000;

/**
 * How long the Dashboard lets one command run before it kills it. The command
 * bounds itself: every wait for the fleet lock, for the supervisor's answer and
 * for a gateway to go is cut to fit WECOM_LIFECYCLE_MAX_MS; after it, only the
 * settle window following a confirmed start (WECOM_START_SETTLE_MS) and
 * COMMAND_SLACK_MS remain. Killing it earlier could leave its op in the queue
 * for the supervisor to carry out after the Dashboard has shown a failure.
 */
export const WECOM_LIFECYCLE_CLI_TIMEOUT_MS = WECOM_LIFECYCLE_MAX_MS + WECOM_START_SETTLE_MS + COMMAND_SLACK_MS;

const MAX_OUTPUT = 64 * 1024;
const MAX_MESSAGE = 2_000;
const CODE = /^[a-z][a-z_-]{0,63}$/;

function clip(text: string): string {
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text;
}

/** Read the result line of a finished run. Never throws. */
export function parseWecomLifecycleOutput(run: { stdout: string; stderr: string; code: number | null }): WecomLifecycleOutcome {
  const lines = run.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  let parsed: Record<string, unknown> | undefined;
  try {
    const value = JSON.parse(lines.at(-1) ?? '');
    if (value && typeof value === 'object' && !Array.isArray(value)
      && typeof value.ok === 'boolean' && typeof value.message === 'string') {
      parsed = value;
    }
  } catch {
    // Not a result line; handled below.
  }
  if (!parsed) {
    if (run.code === 0) {
      return { ok: false, reason: 'cli_output_invalid', message: 'botmux wecom 没有输出可识别的结果。' };
    }
    const detail = run.stderr.trim().split('\n').slice(-5).join('\n');
    return { ok: false, reason: 'cli_failed', message: clip(detail || `botmux wecom 以退出码 ${run.code ?? '未知'} 结束，没有给出结果。`) };
  }
  const outcome: WecomLifecycleOutcome = { ok: parsed.ok === true, message: clip(parsed.message as string) };
  if (outcome.ok && typeof parsed.state === 'string' && CODE.test(parsed.state)) {
    outcome.state = parsed.state;
  }
  if (!outcome.ok) {
    outcome.reason = typeof parsed.reason === 'string' && CODE.test(parsed.reason) ? parsed.reason : 'cli_failed';
  }
  if (parsed.desired === 'running' || parsed.desired === 'stopped') {
    outcome.desired = parsed.desired;
  }
  if (isWecomDesiredStopReason(parsed.stopReason)) {
    outcome.stopReason = parsed.stopReason;
  }
  return outcome;
}

/** What a caller may learn about one run while it is under way. */
export interface WecomLifecycleHooks {
  /**
   * The command's pid, right after it was spawned (synchronously, before the
   * returned promise settles). The onboarding wizard keeps it so that, should
   * this Dashboard go away, the next one can wait for the command to finish.
   */
  onSpawn?: (pid: number) => void;
}

export interface WecomLifecycleCliDeps extends WecomLifecycleHooks {
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** This build's CLI entry (ignored by resolveCliSpawn in the standalone binary, which re-executes itself). */
function cliEntry(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli.js');
}

/** Run `botmux wecom <action> <configId> --json`. The caller validated `configId` against the registry. */
export function runWecomLifecycleCli(
  action: WecomConnectionAction,
  configId: string,
  deps: WecomLifecycleCliDeps = {},
): Promise<WecomLifecycleOutcome> {
  return new Promise(done => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: WecomLifecycleOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      done(outcome);
    };
    let child: ChildProcess;
    try {
      const { command, args } = resolveCliSpawn(cliEntry(), ['wecom', action, configId, '--json']);
      child = (deps.spawn ?? spawn)(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Same rule as every other host child of the Dashboard (managed-spawn.ts):
        // never the Dashboard's H5 credentials.
        env: redactChildEnv(deps.env ?? process.env),
        cwd: globalInstallUpdateCwd(),
      });
    } catch (error) {
      finish({ ok: false, reason: 'cli_unavailable', message: clip(error instanceof Error ? error.message : String(error)) });
      return;
    }
    if (typeof child.pid === 'number') {
      deps.onSpawn?.(child.pid);
    }
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      finish({ ok: false, reason: 'cli_timeout', message: `botmux wecom ${action} 在 ${Math.round((deps.timeoutMs ?? WECOM_LIFECYCLE_CLI_TIMEOUT_MS) / 1000)} 秒内没有结束。` });
    }, deps.timeoutMs ?? WECOM_LIFECYCLE_CLI_TIMEOUT_MS);
    timer.unref?.();
    // A multi-byte character split across two chunks is decoded whole.
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    child.stdout?.on('data', chunk => {
      stdout = (stdout + (typeof chunk === 'string' ? chunk : stdoutDecoder.write(chunk))).slice(-MAX_OUTPUT);
    });
    child.stderr?.on('data', chunk => {
      stderr = (stderr + (typeof chunk === 'string' ? chunk : stderrDecoder.write(chunk))).slice(-MAX_OUTPUT);
    });
    child.once('error', error => {
      finish({ ok: false, reason: 'cli_unavailable', message: clip(error.message) });
    });
    child.once('close', code => {
      stdout = (stdout + stdoutDecoder.end()).slice(-MAX_OUTPUT);
      stderr = (stderr + stderrDecoder.end()).slice(-MAX_OUTPUT);
      finish(parseWecomLifecycleOutput({ stdout, stderr, code }));
    });
  });
}
