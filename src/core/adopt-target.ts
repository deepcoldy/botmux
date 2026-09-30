import type { AdoptableSession } from './session-discovery.js';
import type { ZellijAdoptableSession } from './zellij-adopt-discovery.js';
import type { OrcaAdoptableSession } from './orca-adopt-discovery.js';
import type { DaemonSession } from './types.js';

export type LiveAdoptTarget = AdoptableSession | ZellijAdoptableSession | OrcaAdoptableSession;

export function isOrcaAdoptTarget(target: LiveAdoptTarget): target is OrcaAdoptableSession {
  return 'source' in target && target.source === 'orca';
}
export function isZellijAdoptTarget(target: LiveAdoptTarget): target is ZellijAdoptableSession {
  return 'zellijPaneId' in target;
}

export function adoptedFromForTarget(
  target: LiveAdoptTarget,
): NonNullable<DaemonSession['adoptedFrom']> {
  if (isOrcaAdoptTarget(target)) {
    return {
      source: 'orca',
      orcaTerminalHandle: target.orcaTerminalHandle,
      orcaPtyId: target.orcaPtyId,
      orcaIncarnationId: target.orcaIncarnationId,
      orcaExecutionHostId: target.orcaExecutionHostId,
      orcaWorktreeId: target.orcaWorktreeId,
      orcaAgentIdentity: target.orcaAgentIdentity,
      originalCliPid: target.cliPid,
      sessionId: target.sessionId,
      cliId: target.cliId,
      cwd: target.cwd,
      paneCols: target.paneCols,
      paneRows: target.paneRows,
      orcaPaneSizeVerified: target.paneSizeVerified,
    };
  }
  if (isZellijAdoptTarget(target)) {
    return {
      source: 'zellij',
      zellijSession: target.zellijSession,
      zellijPaneId: target.zellijPaneId,
      originalCliPid: target.cliPid,
      sessionId: target.sessionId,
      cliId: target.cliId,
      cwd: target.cwd,
      paneCols: target.paneCols,
      paneRows: target.paneRows,
    };
  }
  return {
    source: target.source,
    tmuxTarget: target.tmuxTarget,
    herdrSessionName: target.herdrSessionName,
    herdrTarget: target.herdrTarget,
    herdrPaneId: target.herdrPaneId,
    herdrAgentName: target.herdrAgentName,
    herdrTerminalId: target.herdrTerminalId,
    originalCliPid: target.cliPid,
    sessionId: target.sessionId,
    cliId: target.cliId,
    cwd: target.cwd,
    paneCols: target.paneCols,
    paneRows: target.paneRows,
  };
}
