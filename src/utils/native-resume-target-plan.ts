import type { NativeResumeTarget } from '../services/native-resume-target.js';
import { sandboxBoolValue, type SandboxMode } from '../adapters/cli/sandbox-mode.js';

/** Conservative opt-in boundary. Other CLI families, shared/adopted processes,
 * remote runners and isolated namespaces keep their existing restart contract. */
type NativeResumeScope = { cliId?: string; cliSessionId?: string; backendType?: string; adoptMode?: boolean;
    existingAppServerEndpoint?: string; wrapperCli?: string; workflowNodeSession?: boolean;
    readIsolation?: boolean; sandbox?: boolean | SandboxMode; traexAutoModel?: { enabled?: boolean } };

function managedLocalScope(cfg: NativeResumeScope, isolated: boolean): boolean {
  return ['pty', 'tmux'].includes(cfg.backendType ?? '')
    && !cfg.adoptMode && !cfg.existingAppServerEndpoint && !cfg.wrapperCli && !cfg.workflowNodeSession
    && !cfg.readIsolation && !sandboxBoolValue(cfg.sandbox) && !isolated && !cfg.traexAutoModel?.enabled;
}
export function nativeResumeTargetSupported(cfg: NativeResumeScope, isolated: boolean): boolean {
  return cfg.cliId === 'traex' && managedLocalScope(cfg, isolated);
}
export function sameIdRuntimeRestartSupported(cfg: NativeResumeScope, isolated: boolean): boolean {
  return cfg.cliId === 'codex' && cfg.backendType === 'tmux' && managedLocalScope(cfg, isolated);
}

export function nativeResumeTargetAllowed(
  cfg: NativeResumeScope,
  request: NativeResumeTarget,
  state: { ready: boolean; busy: boolean; isolated: boolean; nativeSessionId?: string },
): boolean {
  return nativeResumeTargetSupported(cfg, state.isolated)
    && cfg.cliSessionId === request.sourceId && state.nativeSessionId === request.sourceId
    && state.ready && !state.busy;
}
