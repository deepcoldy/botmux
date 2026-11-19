/**
 * Real-store persistence guarantees behind the HTTP terminal settlement paths
 * (PR #3575). A mocked store cannot prove that the strict API actually throws
 * on a disk failure while the best-effort one swallows it — this drives the
 * production async-trigger-store against a real temp dataDir and induces a real
 * write failure (session file replaced by a directory → EISDIR), then checks
 * what an uncleanly restarted daemon would resolve through the real resolver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { get dataDir() { return tempDir; } },
    daemon: { backendType: 'pty', cliId: 'claude-code' },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import * as store from '../src/services/async-trigger-store.js';
import { resolveAsyncTriggerState } from '../src/services/async-trigger-state.js';

const SID = 'sid-strict-persist';
const TRIGGER = 'trg-strict';
const OWNER = 'app_test';

function triggerFilePath(): string {
  return join(tempDir, 'async-triggers', `${SID}.json`);
}

/** Turn the session file into a directory so every write inside fails. */
function induceDiskFailure(): void {
  const fp = triggerFilePath();
  renameSync(fp, `${fp}.bak`);
  mkdirSync(fp);
}

/** Restore the original (still-pending) file, mimicking disk recovery. */
function restoreDisk(): void {
  const fp = triggerFilePath();
  rmSync(fp, { recursive: true, force: true });
  renameSync(`${fp}.bak`, fp);
}

function resolveAfterRestart(storedStatus: 'open' | 'closed') {
  const persisted = store.lookup(SID, TRIGGER)!;
  return resolveAsyncTriggerState({
    sessionId: SID,
    liveActive: false, // all in-memory maps lost with the old daemon
    chatId: 'http_async_fixture',
    persisted: { triggerId: TRIGGER, result: persisted.result },
    storedStatus,
  });
}

describe('async trigger strict persistence under real disk failure', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'async-store-strict-'));
    store.recordPending(SID, TRIGGER, Date.now(), OWNER);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('best-effort recordCompleted swallows the write failure and leaves durable pending', () => {
    induceDiskFailure();
    // The trap that motivated recordCompletedStrict: no throw, no signal.
    expect(() => store.recordCompleted(SID, TRIGGER, '', Date.now(), OWNER)).not.toThrow();
    restoreDisk();

    expect(store.lookup(SID, TRIGGER)?.result.status).toBe('pending');
    // An unclean restart against the still-open row resolves the stranded shape.
    expect(resolveAfterRestart('open').state).toBe('running');
  });

  it('recordCompletedStrict throws on the real write failure so callers can fail-close', () => {
    induceDiskFailure();
    expect(() => store.recordCompletedStrict(SID, TRIGGER, '', Date.now(), OWNER))
      .toThrow(/EISDIR|EACCES|ENOSPC|ENOENT/);
    restoreDisk();

    // The failed strict write must not have mutated the durable record.
    expect(store.lookup(SID, TRIGGER)?.result.status).toBe('pending');
  });

  it('a fail-closed session row makes the restarted resolver return failed despite durable pending', () => {
    // Same stranded durable state as above, but the daemon fail-closed the row
    // (closeSession persists status=closed): the closed-branch is the
    // observable terminal that replaces the lost in-memory projection.
    const resolution = resolveAfterRestart('closed');
    expect(resolution.state).toBe('failed');
    expect(resolution.errorCode).toBe('no_output');
  });

  it('a successful strict completion survives an unclean restart as completed', () => {
    const at = Date.now();
    expect(store.recordCompletedStrict(SID, TRIGGER, 'answer over http', at, OWNER)).toBe('completed');

    const restarted = resolveAfterRestart('open');
    expect(restarted.state).toBe('completed');
    expect(restarted.output).toMatchObject({ content: 'answer over http' });
    // The stamp-releasing decision is backed by real durable terminality.
    expect(store.lookup(SID, TRIGGER)?.result.status).toBe('completed');
  });

  it('recordCompletedStrict returns terminal without overwriting an earlier interrupt/failure', () => {
    store.recordInterruptedStrict(SID, TRIGGER, Date.now(), OWNER);
    const outcome = store.recordCompletedStrict(SID, TRIGGER, 'late answer', Date.now(), OWNER);
    expect(outcome).toBe('terminal');
    expect(store.lookup(SID, TRIGGER)?.result.status).toBe('interrupted');
  });
});
