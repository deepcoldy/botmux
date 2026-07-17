import type { DesktopRuntimeState } from '../shared/types.js';
import type { RunResult } from './runtime-service.js';

export type AutoStartLaunchResult = 'started' | 'skipped' | 'failed';

export interface AutoStartRuntime {
  getState(): Promise<DesktopRuntimeState>;
  start(): Promise<RunResult>;
}

export interface AutoStartMonitor {
  refresh(): Promise<void>;
}

export function shouldAutoStartCliRuntime(state: DesktopRuntimeState): boolean {
  // Only a stopped, selected CLI runtime is safe to start automatically.
  // Setup, degraded, and handoff states need user-visible recovery instead.
  const cliSource = state.runtimeSource === 'global-cli';
  return state.status === 'stopped' && state.runtimeManaged && cliSource;
}

export async function autoStartCliRuntimeOnLaunch(args: {
  runtime: AutoStartRuntime;
  monitor?: AutoStartMonitor;
  warn?: (message: string) => void;
}): Promise<AutoStartLaunchResult> {
  try {
    const state = await args.runtime.getState();
    if (!shouldAutoStartCliRuntime(state)) return 'skipped';

    const result = await args.runtime.start();
    await refreshAfterLaunchAction(args.monitor, args.warn);
    if (result.code !== 0) {
      args.warn?.(`CLI auto-start failed: ${formatRunResult(result)}`);
      return 'failed';
    }
    return 'started';
  } catch (error) {
    args.warn?.(`CLI auto-start failed: ${error instanceof Error ? error.message : String(error)}`);
    return 'failed';
  }
}

async function refreshAfterLaunchAction(
  monitor: AutoStartMonitor | undefined,
  warn: ((message: string) => void) | undefined,
): Promise<void> {
  try {
    await monitor?.refresh();
  } catch (error) {
    warn?.(`CLI state refresh after auto-start failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function formatRunResult(result: RunResult): string {
  const message = result.stderr.trim() || result.stdout.trim();
  return message || `exit code ${result.code}`;
}
