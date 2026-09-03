/**
 * Device-isolation inventory must fail CLOSED for mojo.
 *
 * Two independent fail-open holes are pinned here, both behavioural (no source
 * string assertions): revert either production change and a case below goes red.
 *
 * 1. An unreadable session store must refuse the isolation proof, not silently
 *    behave like "no sessions exist".
 * 2. An active mojo row must be surfaced even when pid/cliSessionId are absent,
 *    because MojoBackend.runTurn spawns a credentialed local child every turn.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/session-store.js', () => ({
  // The compatible reader swallows failures and yields nothing. Production must
  // NOT use it here: if it does, the corrupt store below reads as an empty world.
  listSessions: () => new Map(),
  // bun links named exports across the WHOLE transitive graph, so every binding any
  // module on it imports from session-store must exist here — even ones this test
  // never touches. Enumerated from src rather than discovered one error at a time:
  //   grep -rhoE "import \{[^}]*\} from '[^']*session-store\.js'" src/
  // Omitting any one fails the file at LINK time, before a single test runs (which
  // is why this file reported 0 executed rather than a normal failure).
  countActiveSessionsOnDisk: () => 0,
  loadAllSessionsSnapshot: () => new Map(),
  mutateSessionRowOffline: () => {},
  occupancyLeaseIsActive: () => false,
  readOccupancyLease: () => undefined,
  readSessionRowCopiesAcrossStores: () => [],
  listSessionsStrict: () => {
    const err = new Error('session store unreadable');
    err.name = 'SessionStoreUnavailableError';
    throw err;
  },
}));

// Keep the runtime side empty so the store read is the only source of truth.
vi.mock('../src/core/worker-pool.js', () => ({
  // `killWorker` MUST be listed even though no assertion touches it: the module
  // under test (`device-isolation-daemon.ts`) does
  // `import { killWorker, listActiveSessions } from './worker-pool.js'`, and bun
  // links named exports for real — omitting it fails the whole file with
  // "Export named 'killWorker' not found". A spy rather than a bare no-op so a
  // future test can assert on it, and so an unexpected call is observable rather
  // than silently swallowed. (vitest never checked this, which is why the gap sat
  // here unnoticed.)
  killWorker: vi.fn(),
  listActiveSessions: () => [],
  quarantinedLauncherEnvKeys: () => [],
  rememberAppliedUnprovableEnvKeys: () => {},
  startNewGenerationEnvLedger: () => {},
  // device-isolation-daemon imports this name. Bun's mock is the whole module,
  // so omitting it is a SyntaxError at import time (vitest is more lenient).
  killWorker: () => {},
}));

const daemon = await import('../src/core/device-isolation-daemon.js');

describe('mojo device-isolation inventory fails closed', () => {
  it('refuses to build an inventory when the session store cannot be read', () => {
    // Non-strict read would return an empty Map and let the inventory report a
    // clean host, which is how a corrupt store used to erase every blocker.
    expect(() => daemon.buildDeviceIsolationInventory()).toThrow();
  });

  it('keeps an active mojo row in the inventory without pid or cliSessionId', () => {
    const merged = daemon.mergePersistedDeviceIsolationSessions([], [{
      sessionId: 'mojo-no-pid',
      status: 'active',
      backendType: 'mojo',
      // Deliberately absent: pid, cliSessionId, persistentBackendTarget,
      // adoptedFrom. mojo is not a local multiplexer, so none of the legacy
      // durable-evidence clauses matched and the row was dropped outright.
    } as never]);

    expect(merged.map(entry => entry.sessionId)).toContain('mojo-no-pid');
  });
});
