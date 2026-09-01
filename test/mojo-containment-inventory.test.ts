/**
 * The device-isolation inventory must not lose an unproven containment handle.
 *
 * A handle exists precisely because nothing proved a credentialed turn subtree
 * gone, and it deliberately outlives both the worker generation and the session
 * row. An explicit `/close` deletes the row, so without folding the handle store
 * into the inventory the last evidence of a live credentialed subtree disappears
 * and credential activation is granted around it -- the same class of hole the
 * launcher-env residual path already closes for its own ledger.
 *
 * Run:  TMPDIR=/tmp pnpm vitest run test/mojo-containment-inventory.test.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ config: { env: {} } }),
}));

import { readBootId, recordContainmentHandle, type WeakContainmentHandle } from '../src/core/mojo-containment.js';
import {
  appendResidualContainmentSessions,
  buildDeviceIsolationInventory,
  resetDeviceIsolationDaemonForTest,
  setDeviceIsolationDaemonDependenciesForTest,
  type DeviceIsolationRuntimeSession,
} from '../src/core/device-isolation-daemon.js';

let dir: string;
let previousDataDir: string | undefined;

// Handles must be minted from the CURRENT boot: the boot reconciliation runs
// before the first inventory build and RELEASES handles whose recorded boot id
// provably predates this boot (that is its whole point), so a made-up bootId
// never reaches the classifier on Linux any more. On hosts with no readable
// boot id (Darwin) the reconcile fails closed and the fallback is retained —
// the fixture blocks on every platform either way.
const fixtureBootId = readBootId() ?? 'boot-fixture';

function weakHandle(sessionId: string): WeakContainmentHandle {
  return {
    kind: 'tree-identity',
    sessionId,
    generation: 1,
    rootPid: 4242,
    bootId: fixtureBootId,
    startTime: 999,
    nonce: 'nonce-1',
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mojo-containment-inv-'));
  previousDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dir;
});

afterEach(() => {
  resetDeviceIsolationDaemonForTest();
  if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previousDataDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('containment handles are re-admitted into the inventory', () => {
  it('re-admits a session whose row is gone', () => {
    // The residual case: /close removed the row, the handle is all that is left.
    const merged = appendResidualContainmentSessions([], ['sid-orphan']);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      sessionId: 'sid-orphan',
      containmentResidual: true,
      frozenBackend: 'mojo',
      remoteExecutionProven: false,
      workerPresent: false,
    });
  });

  it('does not duplicate a session that still has a row', () => {
    const live: DeviceIsolationRuntimeSession[] = [
      { sessionId: 'sid-live', adopted: false, frozenBackend: 'mojo' },
    ];

    const merged = appendResidualContainmentSessions(live, ['sid-live']);

    expect(merged).toHaveLength(1);
    // Keeps its own classification rather than being flattened into a residual.
    expect(merged[0].containmentResidual).toBeUndefined();
  });

  it('adds nothing when no handle is outstanding', () => {
    expect(appendResidualContainmentSessions([], [])).toEqual([]);
  });

  it('reads the REAL handle store when no ids are passed', () => {
    // The default argument is what wires the store into the inventory; passing ids
    // explicitly (as the cases above do) would never catch a missing read.
    recordContainmentHandle(weakHandle('sid-rowless'));

    const merged = appendResidualContainmentSessions([]);

    expect(merged.map(s => s.sessionId)).toContain('sid-rowless');
    expect(merged.find(s => s.sessionId === 'sid-rowless')?.containmentResidual).toBe(true);
  });

  it('BLOCKS a row that still exists but owns an unproven handle', () => {
    // The row is present, so the residual append skips it BY DESIGN; the
    // classifier itself has to consult the handle store, or a live row walks
    // straight past into a clearable disposition.
    recordContainmentHandle(weakHandle('sid-has-row'));
    setDeviceIsolationDaemonDependenciesForTest({
      listSessions: () => [{
        sessionId: 'sid-has-row',
        adopted: false,
        frozenBackend: 'riff',
        workerPresent: false,
        // A remote-proven riff row: without the handle check this is exactly the
        // shape that reaches `safe_remote` / `quiescent`.
        remoteExecutionProven: true,
      }],
    });

    const inventory = buildDeviceIsolationInventory();

    const entry = inventory.entries.find(e => e.sessionId === 'sid-has-row');
    expect(entry?.disposition).toBe('blocked');
    expect(entry?.blocker).toBe('mojo_containment_unproven');
  });

  it('BLOCKS a row whose handle store cannot be read', () => {
    // Per-session fail-closed. A corrupt store is the exact state in which an
    // unproven subtree would silently stop blocking, so "cannot read" must count
    // as "a handle may exist".
    writeFileSync(join(dir, 'mojo-containment-handles.json'), '{not json');
    setDeviceIsolationDaemonDependenciesForTest({
      listSessions: () => [{
        sessionId: 'sid-corrupt-store',
        adopted: false,
        frozenBackend: 'riff',
        workerPresent: false,
        remoteExecutionProven: true,
      }],
    });

    const inventory = buildDeviceIsolationInventory();

    const entry = inventory.entries.find(e => e.sessionId === 'sid-corrupt-store');
    expect(entry?.disposition).toBe('blocked');
    expect(entry?.blocker).toBe('mojo_containment_unproven');
  });

  it('folds the handle store into the real inventory build', () => {
    // Guards the WIRING, not just the helper: with no listSessions override the
    // inventory must still surface a rowless handle.
    recordContainmentHandle(weakHandle('sid-wired'));

    const inventory = buildDeviceIsolationInventory();

    const entry = inventory.entries.find(e => e.sessionId === 'sid-wired');
    expect(entry?.disposition).toBe('blocked');
    expect(entry?.blocker).toBe('mojo_containment_unproven');
  });

  it('refuses the whole inventory when the handle store is unreadable', () => {
    // "Cannot read" is not "nothing there": answering none here would clear every
    // blocker precisely when the evidence is unavailable.
    writeFileSync(join(dir, 'mojo-containment-handles.json'), '{not json');

    expect(() => appendResidualContainmentSessions([])).toThrow(/unreadable/);
  });
});
