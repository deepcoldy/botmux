import { traexRestoredComposerReady } from '../adapters/cli/traex-footer.js';
import { startupIdleReportScreenAdmits } from './program-status-gate.js';
import type { ProgramStatusEvent } from '../utils/program-status-parser.js';

export interface TraexStartupInputEvidence {
  screen: string;
  readyPattern: RegExp | undefined;
  nativeState?: ProgramStatusEvent['state'];
  /** Web input invalidates the empty-composer inference behind an idle. */
  webInputUnchanged: boolean;
  blockingOwner: boolean;
}

export function shouldFenceTraexStartupInput(scope: {
  cliId?: string;
  programStatusEnabled: boolean;
  resume?: boolean;
  adoptMode?: boolean;
  remoteViewer?: boolean;
  persistentReattach?: boolean;
}): boolean {
  return scope.cliId === 'traex' && scope.programStatusEnabled
    && !scope.resume && !scope.adoptMode && !scope.remoteViewer && !scope.persistentReattach;
}

/** A visible shortcut-only composer precedes native thread initialization.
 * Screen silence and the adapter's broad readyPattern cannot prove that Enter
 * can submit yet. Use the verified launch's idle, or a resolved native footer.
 * This is startup input evidence, not a turn terminal or a replay permission. */
export function traexStartupInputReady(evidence: TraexStartupInputEvidence): boolean {
  if (evidence.blockingOwner) return false;
  if (evidence.nativeState === 'blocked' || evidence.nativeState === 'error'
    || evidence.nativeState === 'clear') return false;
  if (evidence.webInputUnchanged
    && (evidence.nativeState === 'idle' || evidence.nativeState === 'done')
    && traexRestoredComposerReady(evidence.screen, { nativeIdleReported: true })
    && startupIdleReportScreenAdmits(evidence.screen, evidence.readyPattern)) return true;
  // MCP startup may report working AFTER the native thread is initialized;
  // its resolved empty composer still accepts queued input. Do not turn that
  // healthy type-ahead path into an idle-only deadlock.
  return traexRestoredComposerReady(evidence.screen, { requireThreadReady: true });
}
