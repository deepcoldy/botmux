import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import {
  inspectAutostart,
  launchProgram,
  type AutostartOpts,
  type AutostartState,
} from '../autostart.js';

const execFileAsync = promisify(execFile);
const AUTOSTART_TIMEOUT_MS = 15_000;

export type DashboardAutostartErrorCode =
  | 'command_failed'
  | 'command_timeout'
  | 'operation_in_progress'
  | 'unsupported_platform';

export class DashboardAutostartError extends Error {
  constructor(public readonly code: DashboardAutostartErrorCode, message: string) {
    super(message);
    this.name = 'DashboardAutostartError';
  }
}

export interface DashboardAutostartController {
  getState(): Promise<AutostartState>;
  setEnabled(enabled: boolean): Promise<AutostartState>;
}

type InspectAutostart = () => AutostartState | Promise<AutostartState>;
type RunAutostart = (enabled: boolean) => Promise<void>;

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as Record<string, unknown>;
  return value.code === 'ETIMEDOUT' || value.killed === true;
}

/**
 * Run `botmux autostart enable|disable` as a child process.
 *
 * GOES THROUGH `launchProgram`, which is the same helper the unit/plist writers
 * use, because this had the identical `__dirname` bug: a hardcoded
 * `[process.execPath, join(pkgRoot,'dist','cli.js'), 'autostart', …]`. Inside the
 * compiled binary `process.execPath` IS the botmux binary and there is no
 * `dist/cli.js` on disk (pkgRoot resolves into the virtual `/$bunfs/`), so the
 * bogus path was parsed as an unknown subcommand: the binary printed help and
 * exited 0. The controller then re-read an unchanged state and reported
 * `command_failed`, leaving the Dashboard's autostart toggle permanently dead in
 * the shipped build. Node still runs `node <pkgRoot>/dist/cli.js autostart …`.
 */
function defaultRunner(opts: AutostartOpts): RunAutostart {
  return async enabled => {
    const [command, ...programArgs] = launchProgram(opts);
    try {
      await execFileAsync(
        command,
        [...programArgs, 'autostart', enabled ? 'enable' : 'disable'],
        {
          cwd: homedir(),
          encoding: 'utf8',
          timeout: AUTOSTART_TIMEOUT_MS,
          windowsHide: true,
        },
      );
    } catch (error) {
      throw new DashboardAutostartError(
        isTimeoutError(error) ? 'command_timeout' : 'command_failed',
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}

export function createDashboardAutostartController(input: {
  opts: AutostartOpts;
  inspect?: InspectAutostart;
  run?: RunAutostart;
}): DashboardAutostartController {
  const inspect = input.inspect ?? inspectAutostart;
  const run = input.run ?? defaultRunner(input.opts);
  let busy = false;

  return {
    async getState() {
      return inspect();
    },

    async setEnabled(enabled) {
      if (busy) {
        throw new DashboardAutostartError(
          'operation_in_progress',
          '另一个开机自启操作仍在进行',
        );
      }
      busy = true;
      try {
        const before = await inspect();
        if (!before.supported) {
          throw new DashboardAutostartError(
            'unsupported_platform',
            '当前平台不支持开机自启',
          );
        }
        if (before.enabled === enabled) return before;

        await run(enabled);
        const after = await inspect();
        if (after.enabled !== enabled) {
          throw new DashboardAutostartError(
            'command_failed',
            '开机自启状态未更新',
          );
        }
        return after;
      } finally {
        busy = false;
      }
    },
  };
}

export function parseAutostartWrite(
  value: unknown,
): { ok: true; enabled: boolean } | { ok: false } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || typeof body.enabled !== 'boolean') {
    return { ok: false };
  }
  return { ok: true, enabled: body.enabled };
}

export function dashboardAutostartErrorStatus(error: DashboardAutostartError): number {
  if (error.code === 'operation_in_progress') return 409;
  if (error.code === 'unsupported_platform') return 501;
  if (error.code === 'command_timeout') return 504;
  return 500;
}
