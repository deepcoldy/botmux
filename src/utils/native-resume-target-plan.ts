import type { NativeResumeTarget } from '../services/native-resume-target.js';
import { sandboxBoolValue, type SandboxMode } from '../adapters/cli/sandbox-mode.js';

/** Conservative opt-in boundary. Other CLI families, shared/adopted processes,
 * remote runners and isolated namespaces keep their existing restart contract. */
export function nativeResumeTargetAllowed(
  cfg: { cliId?: string; cliSessionId?: string; backendType?: string; adoptMode?: boolean;
    existingAppServerEndpoint?: string; wrapperCli?: string; workflowNodeSession?: boolean;
    readIsolation?: boolean; sandbox?: boolean | SandboxMode; traexAutoModel?: { enabled?: boolean } },
  request: NativeResumeTarget,
  state: { ready: boolean; busy: boolean; isolated: boolean; nativeSessionId?: string },
): boolean {
  return cfg.cliId === 'traex' && ['pty', 'tmux'].includes(cfg.backendType ?? '')
    && !cfg.adoptMode && !cfg.existingAppServerEndpoint && !cfg.wrapperCli && !cfg.workflowNodeSession
    && !cfg.readIsolation && !sandboxBoolValue(cfg.sandbox) && !state.isolated && !cfg.traexAutoModel?.enabled
    && cfg.cliSessionId === request.sourceId && state.nativeSessionId === request.sourceId
    && state.ready && !state.busy;
}
