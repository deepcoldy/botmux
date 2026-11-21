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

/** A cold resume (`traex resume <id>`, fork) paints the same provisional
 * shortcut-only composer as a fresh start before its thread can submit:
 * recorded on 0.216.0 with a stale model catalog and a slow network, the
 * resumed TUI held that frame for 30s, reported OSC idle on it, accepted the
 * paste and dropped every Enter. Only an adopted pane, an RPC viewer or a
 * reattached live pane is already past that window. */
export function shouldFenceTraexStartupInput(scope: {
  cliId?: string;
  programStatusEnabled: boolean;
  adoptMode?: boolean;
  remoteViewer?: boolean;
  persistentReattach?: boolean;
}): boolean {
  return scope.cliId === 'traex' && scope.programStatusEnabled
    && !scope.adoptMode && !scope.remoteViewer && !scope.persistentReattach;
}

/** A visible shortcut-only composer precedes native thread initialization.
 * Screen silence and the adapter's broad readyPattern cannot prove that Enter
 * can submit yet. Use the verified launch's idle, or a resolved native footer.
 * This is startup input evidence, not a turn terminal or a replay permission. */
export function traexStartupInputReady(evidence: TraexStartupInputEvidence): boolean {
  if (evidence.blockingOwner) return false;
  if (evidence.nativeState === 'blocked' || evidence.nativeState === 'error'
    || evidence.nativeState === 'clear') return false;
  // A native idle stands in for a footer this predicate cannot resolve, but
  // not for the provisional shortcut-only composer: 0.214.1 and 0.216.0 both
  // report idle on it while the model catalog fetch stalls, and an Enter
  // there is dropped (the draft stays parked after the footer resolves).
  if (evidence.webInputUnchanged
    && (evidence.nativeState === 'idle' || evidence.nativeState === 'done')
    && traexRestoredComposerReady(evidence.screen, { nativeIdleReported: true, requireThreadReady: true })
    && startupIdleReportScreenAdmits(evidence.screen, evidence.readyPattern)) return true;
  // MCP startup may report working AFTER the native thread is initialized;
  // its resolved empty composer still accepts queued input. Do not turn that
  // healthy type-ahead path into an idle-only deadlock.
  return traexRestoredComposerReady(evidence.screen, { requireThreadReady: true });
}
