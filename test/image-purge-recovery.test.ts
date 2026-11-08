/**
 * The decisions behind the failure card's "purge tiny images and continue":
 * when a click is declined before anything restarts, how a purge after the CLI
 * was killed is classified, and which outcomes deliver the continuation.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  holdPurgeClickRollback,
  PURGE_CONTINUATION_WITHHELD,
  PURGE_IMAGES_NOT_APPLIED,
  planPurgeRequest,
  purgeOutcomeNotice,
  runPurgeMaintenance,
  takePurgeClickRollback,
  unpurgedNoticeKey,
  type PurgeRequestInput,
} from '../src/services/image-purge-recovery.js';
import type { PurgeReport } from '../src/services/transcript-image-purge.js';

const TARGET = { jsonlPath: '/data/projects/x/s.jsonl', sessionId: 's' };

function report(overrides: Partial<PurgeReport> = {}): PurgeReport {
  return {
    files: [],
    removed: 0,
    imageBlocks: 0,
    unmeasurable: [],
    skippedSourceTypes: [],
    failedFiles: [],
    outOfScopeFiles: [],
    ...overrides,
  };
}

const REMOVABLE = report({ files: [{ file: TARGET.jsonlPath, removed: 1 }], removed: 1, imageBlocks: 1 });

function input(overrides: Partial<PurgeRequestInput> = {}): PurgeRequestInput {
  return {
    cliId: 'claude-code',
    localOwnedSession: true,
    target: TARGET,
    restartInProgress: false,
    childPid: 4242,
    sandboxMode: 'off',
    platform: 'linux',
    scan: () => REMOVABLE,
    ...overrides,
  };
}

describe('planPurgeRequest', () => {
  it('proceeds for a local Claude Code session with something to remove', () => {
    expect(planPurgeRequest(input())).toEqual({
      kind: 'proceed',
      target: TARGET,
      preserveScratchTree: false,
      report: REMOVABLE,
    });
  });

  it.each([
    ['another CLI', { cliId: 'codex' }, 'worker.purge_images_unsupported'],
    ['an adopted or remote session', { localOwnedSession: false }, 'worker.purge_images_unsupported'],
    ['no resumable transcript', { target: undefined }, 'worker.purge_images_unsupported'],
    ['a restart already running', { restartInProgress: true }, 'worker.purge_images_busy'],
    ['a macOS scratch sandbox', { sandboxMode: 'scratch', platform: 'darwin' as const }, 'worker.purge_images_sandbox_unsupported'],
    ['no CLI pid', { childPid: undefined }, 'worker.purge_images_exit_unproven'],
    ['a zero CLI pid', { childPid: 0 }, 'worker.purge_images_exit_unproven'],
  ])('declines %s without scanning', (_label, overrides, noticeKey) => {
    const scan = vi.fn(() => REMOVABLE);
    const plan = planPurgeRequest(input({ ...overrides, scan }));
    expect(plan).toMatchObject({ kind: 'decline', noticeKey });
    expect(scan).not.toHaveBeenCalled();
  });

  it('keeps the Linux scratch tree for the respawn', () => {
    expect(planPurgeRequest(input({ sandboxMode: 'scratch' }))).toMatchObject({
      kind: 'proceed',
      preserveScratchTree: true,
    });
  });

  it('restarts normally under the oncall sandbox, whose transcript lives on the host', () => {
    expect(planPurgeRequest(input({ sandboxMode: 'oncall', platform: 'darwin' }))).toMatchObject({
      kind: 'proceed',
      preserveScratchTree: false,
    });
  });

  it('declines with the scan explanation when nothing is removable', () => {
    const plan = planPurgeRequest(input({ scan: () => report({ imageBlocks: 2 }) }));
    expect(plan).toMatchObject({ kind: 'decline', noticeKey: 'worker.purge_images_not_found' });
  });
});

describe('unpurgedNoticeKey', () => {
  it('explains the most actionable cause first', () => {
    const failed = { failedFiles: [{ file: 'a', reason: 'EACCES' }] };
    const unmeasurable = { unmeasurable: [{ file: 'a', fileIndex: 0 }] };
    const url = { skippedSourceTypes: ['url'] };
    expect(unpurgedNoticeKey(report({ ...failed, ...unmeasurable, ...url }))).toBe('worker.purge_images_failed');
    expect(unpurgedNoticeKey(report({ ...unmeasurable, ...url, imageBlocks: 2 }))).toBe('worker.purge_images_unmeasurable');
    expect(unpurgedNoticeKey(report({ ...url, imageBlocks: 1 }))).toBe('worker.purge_images_unsupported_source');
    expect(unpurgedNoticeKey(report())).toBe('worker.purge_images_no_images');
    expect(unpurgedNoticeKey(report({ imageBlocks: 3 }))).toBe('worker.purge_images_not_found');
  });
});

describe('runPurgeMaintenance', () => {
  it('never purges while the old CLI may still be writing', async () => {
    const purge = vi.fn(() => REMOVABLE);
    const outcome = await runPurgeMaintenance({
      waitForQuiescence: () => Promise.reject(new Error('process 4242 did not exit')),
      purge,
    });
    expect(outcome).toEqual({ kind: 'not_quiescent', detail: 'process 4242 did not exit' });
    expect(purge).not.toHaveBeenCalled();
  });

  it('turns a throwing purge into an outcome', async () => {
    await expect(runPurgeMaintenance({
      waitForQuiescence: async () => {},
      purge: () => { throw new Error('EIO'); },
    })).resolves.toEqual({ kind: 'failed', detail: 'EIO' });
  });

  it('classifies the purge report', async () => {
    const run = (r: PurgeReport) => runPurgeMaintenance({ waitForQuiescence: async () => {}, purge: () => r });
    await expect(run(REMOVABLE)).resolves.toEqual({ kind: 'purged', report: REMOVABLE });
    await expect(run(report({ failedFiles: [{ file: 'a', reason: 'transcript changed while purging' }] })))
      .resolves.toMatchObject({ kind: 'failed' });
    await expect(run(report({ imageBlocks: 1 }))).resolves.toMatchObject({ kind: 'nothing_removed' });
  });

  it.each([
    ['an unmeasurable image', { unmeasurable: [{ file: TARGET.jsonlPath, fileIndex: 0 }] }],
    ['a non-embedded image', { skippedSourceTypes: ['url'] }],
    ['a file it could not handle', { failedFiles: [{ file: 'agent.jsonl', reason: 'EACCES' }] }],
  ])('calls a purge that left %s behind partial', async (_label, leftover) => {
    const partial = report({ ...REMOVABLE, imageBlocks: 2, ...leftover });
    await expect(runPurgeMaintenance({ waitForQuiescence: async () => {}, purge: () => partial }))
      .resolves.toEqual({ kind: 'partial', report: partial });
  });
});

describe('purgeOutcomeNotice', () => {
  const PARTIAL = report({ ...REMOVABLE, imageBlocks: 2, unmeasurable: [{ file: TARGET.jsonlPath, fileIndex: 0 }] });

  it('delivers the continuation only after a complete purge and a running replacement', () => {
    expect(purgeOutcomeNotice({ kind: 'purged', report: REMOVABLE }, 'spawned')).toEqual({
      key: 'worker.purge_images_done',
      params: { files: '1', removed: '1' },
      deliverContinuation: true,
    });
  });

  it.each([
    ['a partial purge', { kind: 'partial' as const, report: PARTIAL }, 'spawned' as const, 'worker.purge_images_partial'],
    ['a failed respawn', { kind: 'purged' as const, report: REMOVABLE }, 'failed' as const, 'worker.purge_images_restart_failed'],
    ['a failed respawn after a partial purge', { kind: 'partial' as const, report: PARTIAL }, 'failed' as const, 'worker.purge_images_restart_failed'],
    ['a superseded respawn', { kind: 'purged' as const, report: REMOVABLE }, 'superseded' as const, 'worker.purge_images_superseded'],
  ])('withholds the continuation after %s that changed the transcript', (_label, outcome, respawn, key) => {
    expect(purgeOutcomeNotice(outcome, respawn)).toEqual({
      key,
      params: { files: '1', removed: '1' },
      deliverContinuation: false,
      rejectReason: PURGE_CONTINUATION_WITHHELD,
    });
  });

  it.each([
    [{ kind: 'nothing_removed' as const, report: report({ imageBlocks: 1 }) }, 'worker.purge_images_not_found'],
    [{ kind: 'not_quiescent' as const, detail: 'timeout' }, 'worker.purge_images_exit_unproven'],
    [{ kind: 'failed' as const, detail: 'EIO' }, 'worker.purge_images_failed'],
  ])('reports an untouched transcript as not applied (%#)', (outcome, key) => {
    for (const respawn of ['spawned', 'failed', 'superseded'] as const) {
      expect(purgeOutcomeNotice(outcome, respawn)).toEqual({
        key,
        deliverContinuation: false,
        rejectReason: PURGE_IMAGES_NOT_APPLIED,
      });
    }
  });

  it('stays silent when the restart died before maintenance ran', () => {
    expect(purgeOutcomeNotice(undefined, 'failed')).toEqual({
      deliverContinuation: false,
      rejectReason: PURGE_IMAGES_NOT_APPLIED,
    });
  });
});

describe('purge click rollback holder', () => {
  const receipt = { turnId: 'om_failed', previousRetryCount: 0, stampedAt: '2026-08-21T10:00:05.000Z' };

  it('hands the rollback back once, only for the held continuation turn', () => {
    const owner = {};
    const rollback = { receipt, restoreTurnState: () => {} };
    holdPurgeClickRollback(owner, 'retry-1', rollback);
    expect(takePurgeClickRollback(owner, 'retry-other')).toBeUndefined();
    expect(takePurgeClickRollback({}, 'retry-1')).toBeUndefined();
    expect(takePurgeClickRollback(owner, 'retry-1')).toBe(rollback);
    expect(takePurgeClickRollback(owner, 'retry-1')).toBeUndefined();
  });

  it('keeps an earlier click held when a later click on the same session is taken first', () => {
    const owner = {};
    const first = { receipt, restoreTurnState: () => {} };
    const second = { restoreTurnState: () => {} };
    holdPurgeClickRollback(owner, 'retry-1', first);
    holdPurgeClickRollback(owner, 'retry-2', second);
    expect(takePurgeClickRollback(owner, 'retry-2')).toBe(second);
    expect(takePurgeClickRollback(owner, 'retry-1')).toBe(first);
  });

  it('drops the oldest held clicks beyond a small bound', () => {
    const owner = {};
    for (let i = 0; i < 20; i++) holdPurgeClickRollback(owner, `retry-${i}`, { restoreTurnState: () => {} });
    expect(takePurgeClickRollback(owner, 'retry-0')).toBeUndefined();
    expect(takePurgeClickRollback(owner, 'retry-19')).toBeDefined();
  });
});
