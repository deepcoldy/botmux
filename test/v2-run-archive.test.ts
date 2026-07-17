import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runWorkflowRunArchiveCli } from '../src/cli/workflow-run-archive.js';
import { canonicalJsonStringify } from '../src/utils/canonical-json.js';
import { readRunSnapshot } from '../src/workflows/ops-projection.js';
import {
  V2RunArchiveError,
  commitV2RunArchive,
  planV2RunArchive,
  retireV2RunSource,
  verifyV2RunArchive,
} from '../src/workflows/migration/v2-run-archive.js';

const SHA = `sha256:${'b'.repeat(64)}`;
const OUTPUT_REF = { outputHash: SHA, outputBytes: 0, outputSchemaVersion: 1 };

describe('v2 workflow-run content-addressed archive', () => {
  let root: string;
  let runsDir: string;
  let archiveBaseDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-v2-run-archive-'));
    runsDir = join(root, 'workflow-runs');
    archiveBaseDir = join(root, 'archives');
    mkdirSync(runsDir, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function seedTerminal(
    status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded',
    runId = 'run-ok',
  ): string {
    const runDir = join(runsDir, runId);
    mkdirSync(join(runDir, 'blobs'), { recursive: true });
    // Deliberately seed byte fixtures without importing the retired v2
    // EventLog/runtime. The read-only projector remains the archive oracle.
    writeFileSync(join(runDir, 'workflow.json'), '{"legacyFixture":true}\n', 'utf-8');
    const created = {
      eventId: `${runId}-1`,
      runId,
      timestamp: 1,
      schemaVersion: 1,
      actor: 'scheduler',
      type: 'runCreated',
      payload: {
        workflowId: 'archive-demo',
        revisionId: 'rev-fixture',
        inputRef: OUTPUT_REF,
        initiator: 'ou_test',
      },
    };
    const terminal = status === 'succeeded'
      ? {
          eventId: `${runId}-2`, runId, timestamp: 2, schemaVersion: 1,
          actor: 'scheduler', type: 'runSucceeded', payload: { outputRef: OUTPUT_REF },
        }
      : status === 'failed'
        ? {
            eventId: `${runId}-2`, runId, timestamp: 2, schemaVersion: 1,
            actor: 'scheduler', type: 'runFailed',
            payload: { failedNodeId: 'work', rootCauseEventId: `${runId}-1` },
          }
        : {
            eventId: `${runId}-2`, runId, timestamp: 2, schemaVersion: 1,
            actor: 'scheduler', type: 'runCanceled',
            payload: { cancelOriginEventId: `${runId}-1` },
          };
    writeFileSync(
      join(runDir, 'events.ndjson'),
      `${JSON.stringify(created)}\n${JSON.stringify(terminal)}\n`,
      'utf-8',
    );
    return runDir;
  }

  function seedActive(runId = 'run-active'): string {
    const runDir = join(runsDir, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'events.ndjson'), `${JSON.stringify({
      eventId: `${runId}-1`,
      runId,
      timestamp: 1,
      schemaVersion: 1,
      actor: 'scheduler',
      type: 'runCreated',
      payload: {
        workflowId: 'archive-demo',
        revisionId: 'rev-fixture',
        inputRef: OUTPUT_REF,
        initiator: 'ou_test',
      },
    })}\n`, 'utf-8');
    return runDir;
  }

  function seedSucceededWithAbsoluteOutputPath(runId = 'run-absolute-output'): string {
    const runDir = join(runsDir, runId);
    const blobPath = join(runDir, 'blobs', 'result.json');
    const blob = '{"ok":true}\n';
    mkdirSync(join(runDir, 'blobs'), { recursive: true });
    writeFileSync(blobPath, blob, 'utf-8');
    writeFileSync(join(runDir, 'workflow.json'), '{"legacyFixture":true}\n', 'utf-8');
    const ref = {
      outputHash: `sha256:${'c'.repeat(64)}`,
      outputPath: blobPath,
      outputBytes: Buffer.byteLength(blob),
      outputSchemaVersion: 1,
      contentType: 'application/json',
    };
    const activityId = `${runId}::work::work`;
    const payloads = [
      {
        actor: 'scheduler', type: 'runCreated',
        payload: {
          workflowId: 'archive-demo', revisionId: 'rev-fixture',
          inputRef: ref, initiator: 'ou_test',
        },
      },
      {
        actor: 'scheduler', type: 'attemptCreated',
        payload: { nodeId: 'work', activityId, attemptId: 'att-1', attemptNumber: 1, inputRef: ref },
      },
      {
        actor: 'worker', type: 'activitySucceeded',
        payload: { activityId, attemptId: 'att-1', outputRef: ref },
      },
      {
        actor: 'scheduler', type: 'nodeSucceeded',
        payload: { nodeId: 'work', lastActivityId: activityId },
      },
      {
        actor: 'scheduler', type: 'runSucceeded', payload: { outputRef: ref },
      },
    ];
    writeFileSync(
      join(runDir, 'events.ndjson'),
      `${payloads.map((event, index) => JSON.stringify({
        eventId: `${runId}-${index + 1}`,
        runId,
        timestamp: index + 1,
        schemaVersion: 1,
        ...event,
      })).join('\n')}\n`,
      'utf-8',
    );
    return runDir;
  }

  it('copies every run and residual byte, stores projection parity, and verifies statically/source-aware', async () => {
    const runDir = seedTerminal();
    mkdirSync(join(runDir, 'empty-audit-dir'));
    const residual = join(runsDir, 'target');
    mkdirSync(join(residual, 'blobs'), { recursive: true });
    writeFileSync(join(residual, 'blobs', 'orphan'), 'historical residual', 'utf-8');

    const plan = await planV2RunArchive({ runsDir });
    expect(plan.runCount).toBe(1);
    expect(plan.residualCount).toBe(1);
    expect(plan.content.residuals[0]).toMatchObject({
      name: 'target',
      reason: 'directory-without-events',
      fileCount: 1,
    });
    expect(plan.content.payloadDirectories).toContain('runs/run-ok/raw/empty-audit-dir');

    const result = await commitV2RunArchive({
      runsDir,
      archiveBaseDir,
      now: new Date('2026-07-11T00:00:00.000Z'),
    });
    expect(result.reused).toBe(false);
    expect(result.verification).toMatchObject({ staticVerified: true, sourceVerified: true });
    expect(existsSync(join(result.archiveDir, 'COMMITTED'))).toBe(true);
    expect(readFileSync(join(result.archiveDir, 'residual', 'target', 'raw', 'blobs', 'orphan'), 'utf-8'))
      .toBe('historical residual');

    const archivedProjection = JSON.parse(
      readFileSync(join(result.archiveDir, 'runs', 'run-ok', 'projection.json'), 'utf-8'),
    );
    const liveProjection = await readRunSnapshot(runsDir, 'run-ok');
    expect(canonicalJsonStringify(archivedProjection)).toBe(canonicalJsonStringify(liveProjection));

    expect(lstatSync(result.archiveDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(result.archiveDir, 'manifest.json')).mode & 0o777).toBe(0o600);
    for (const file of result.manifest.content.payloadFiles) {
      expect(lstatSync(join(result.archiveDir, ...file.path.split('/'))).mode & 0o777).toBe(0o600);
    }
    await expect(verifyV2RunArchive({ archiveDir: result.archiveDir }))
      .resolves.toMatchObject({ staticVerified: true, sourceVerified: false });
  });

  it('is idempotent by content and repairs a crash after atomic publication but before COMMITTED', async () => {
    seedTerminal();
    await expect(commitV2RunArchive({
      runsDir,
      archiveBaseDir,
      onPhase(phase) {
        if (phase === 'after-publish') throw new Error('crash-after-publish');
      },
    })).rejects.toThrow('crash-after-publish');
    const published = readdirSync(archiveBaseDir).find((name) => name.startsWith('sha256-'));
    expect(published).toBeTruthy();
    expect(existsSync(join(archiveBaseDir, published!, 'COMMITTED'))).toBe(false);

    const recovered = await commitV2RunArchive({ runsDir, archiveBaseDir });
    expect(recovered.reused).toBe(true);
    expect(existsSync(join(recovered.archiveDir, 'COMMITTED'))).toBe(true);
    expect(readdirSync(archiveBaseDir).filter((name) => name.startsWith('.staging-'))).toEqual([]);

    const replay = await commitV2RunArchive({ runsDir, archiveBaseDir });
    expect(replay.reused).toBe(true);
    expect(replay.archiveDir).toBe(recovered.archiveDir);
  });

  for (const crashPhase of ['after-copy', 'after-manifest'] as const) {
    it(`cleans an owned staging transaction and rebuilds after ${crashPhase}`, async () => {
      seedTerminal();
      await expect(commitV2RunArchive({
        runsDir,
        archiveBaseDir,
        onPhase(phase) {
          if (phase === crashPhase) throw new Error(`crash:${crashPhase}`);
        },
      })).rejects.toThrow(`crash:${crashPhase}`);
      expect(readdirSync(archiveBaseDir).some((name) => name.startsWith('.staging-'))).toBe(true);
      const recovered = await commitV2RunArchive({ runsDir, archiveBaseDir });
      expect(recovered.reused).toBe(false);
      expect(readdirSync(archiveBaseDir).filter((name) => name.startsWith('.staging-'))).toEqual([]);
    });
  }

  it('fails closed when source changes between the copied and second capture', async () => {
    seedTerminal();
    const residual = join(runsDir, 'target');
    mkdirSync(residual);
    writeFileSync(join(residual, 'note'), 'before', 'utf-8');
    await expect(commitV2RunArchive({
      runsDir,
      archiveBaseDir,
      onPhase(phase) {
        if (phase === 'after-copy') writeFileSync(join(residual, 'note'), 'after', 'utf-8');
      },
    })).rejects.toMatchObject({ code: 'SOURCE_CHANGED_DURING_ARCHIVE' });
    expect(readdirSync(archiveBaseDir).some((name) => name.startsWith('sha256-'))).toBe(false);
  });

  it('rejects nonterminal and corrupt event-bearing directories instead of classifying them as residual', async () => {
    const active = seedActive();
    await expect(planV2RunArchive({ runsDir })).rejects.toMatchObject({ code: 'NONTERMINAL_RUN' });

    rmSync(active, { recursive: true, force: true });
    const corrupt = join(runsDir, 'run-corrupt');
    mkdirSync(corrupt);
    writeFileSync(join(corrupt, 'events.ndjson'), '{bad-json\n', 'utf-8');
    await expect(planV2RunArchive({ runsDir })).rejects.toMatchObject({ code: 'CORRUPT_EVENT_LOG' });
  });

  it('requires a physically complete NDJSON journal with no blank interior lines', async () => {
    const runDir = seedTerminal();
    const journal = join(runDir, 'events.ndjson');
    const complete = readFileSync(journal, 'utf-8');
    writeFileSync(journal, complete.slice(0, -1), 'utf-8');
    await expect(planV2RunArchive({ runsDir })).rejects.toMatchObject({ code: 'TORN_EVENT_LOG' });

    writeFileSync(journal, complete.replace('\n', '\n\n'), 'utf-8');
    await expect(planV2RunArchive({ runsDir })).rejects.toMatchObject({ code: 'CORRUPT_EVENT_LOG' });
  });

  it('rejects an archive path inside the source before creating or chmodding it', async () => {
    seedTerminal();
    const nestedArchive = join(runsDir, 'must-not-be-created');
    await expect(commitV2RunArchive({ runsDir, archiveBaseDir: nestedArchive }))
      .rejects.toMatchObject({ code: 'ARCHIVE_SOURCE_OVERLAP' });
    expect(existsSync(nestedArchive)).toBe(false);
  });

  it('never chmods a caller-owned existing archive base', async () => {
    seedTerminal();
    const callerOwned = join(root, 'caller-owned');
    mkdirSync(callerOwned, { mode: 0o755 });
    chmodSync(callerOwned, 0o755);
    await expect(commitV2RunArchive({ runsDir, archiveBaseDir: callerOwned }))
      .rejects.toMatchObject({ code: 'ARCHIVE_MODE_MISMATCH' });
    expect(lstatSync(callerOwned).mode & 0o777).toBe(0o755);
    expect(readdirSync(callerOwned)).toEqual([]);
  });

  it('archives historical missing optional paths and records warnings instead of fabricating them', async () => {
    const runDir = seedTerminal();
    rmSync(join(runDir, 'attempts'), { recursive: true, force: true });
    const plan = await planV2RunArchive({ runsDir });
    expect(plan.content.runs[0]?.missingOptional).toEqual(['chat-binding.json', 'attempts']);
    expect(plan.content.runs[0]?.presence).toMatchObject({
      chatBindingJson: false,
      attemptsDir: false,
    });
  });

  it('accepts every authoritative v2 terminal verdict', async () => {
    seedTerminal('succeeded', 'run-succeeded');
    seedTerminal('failed', 'run-failed');
    seedTerminal('cancelled', 'run-cancelled');

    const plan = await planV2RunArchive({ runsDir });
    expect(Object.fromEntries(plan.content.runs.map((run) => [run.runId, run.verdict.status])))
      .toEqual({
        'run-cancelled': 'cancelled',
        'run-failed': 'failed',
        'run-succeeded': 'succeeded',
      });
  });

  it('rejects source symlinks, hardlinks, and special topology before publishing', async () => {
    const runDir = seedTerminal();
    symlinkSync(join(runDir, 'workflow.json'), join(runDir, 'alias.json'));
    await expect(planV2RunArchive({ runsDir })).rejects.toMatchObject({ code: 'SOURCE_SYMLINK' });

    unlinkIfExists(join(runDir, 'alias.json'));
    linkSync(join(runDir, 'workflow.json'), join(runDir, 'hardlink.json'));
    await expect(planV2RunArchive({ runsDir })).rejects.toMatchObject({ code: 'SOURCE_HARDLINK' });
  });

  it('detects payload, manifest, topology, and source tampering', async () => {
    seedTerminal();
    const result = await commitV2RunArchive({ runsDir, archiveBaseDir });
    const rawWorkflow = join(result.archiveDir, 'runs', 'run-ok', 'raw', 'workflow.json');
    chmodSync(rawWorkflow, 0o600);
    writeFileSync(rawWorkflow, '{}', { mode: 0o600 });
    await expect(verifyV2RunArchive({ archiveDir: result.archiveDir }))
      .rejects.toMatchObject({ code: 'ARCHIVE_FILE_HASH_MISMATCH' });

    rmSync(result.archiveDir, { recursive: true, force: true });
    const rebuilt = await commitV2RunArchive({ runsDir, archiveBaseDir });
    writeFileSync(join(runsDir, 'run-ok', 'workflow.json'), '{}', 'utf-8');
    await expect(verifyV2RunArchive({
      archiveDir: rebuilt.archiveDir,
      sourceRunsDir: runsDir,
    })).rejects.toBeInstanceOf(V2RunArchiveError);
  });

  it('requires daemon-stop acknowledgement, quarantines atomically, and replays idempotently', async () => {
    seedTerminal();
    const archived = await commitV2RunArchive({ runsDir, archiveBaseDir });
    await expect(retireV2RunSource({
      runsDir,
      archiveBaseDir,
      archiveDir: archived.archiveDir,
      daemonStoppedAcknowledged: false,
    })).rejects.toMatchObject({ code: 'DAEMON_STOP_ACK_REQUIRED' });
    expect(existsSync(runsDir)).toBe(true);

    const retired = await retireV2RunSource({
      runsDir,
      archiveBaseDir,
      archiveDir: archived.archiveDir,
      daemonStoppedAcknowledged: true,
      now: new Date('2026-07-11T01:00:00.000Z'),
    });
    expect(retired).toMatchObject({ status: 'retired' });
    if (retired.status === 'nothing_to_retire') throw new Error('expected retirement');
    expect(existsSync(runsDir)).toBe(false);
    expect(existsSync(retired.quarantineDir)).toBe(true);
    expect(lstatSync(retired.quarantineDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(retired.receiptPath).mode & 0o777).toBe(0o600);
    expect(retired.receipt).toMatchObject({
      archiveId: archived.manifest.archiveId,
      sourceRunsDir: runsDir,
      quarantineDir: retired.quarantineDir,
      retiredAt: '2026-07-11T01:00:00.000Z',
    });

    const replay = await retireV2RunSource({
      runsDir,
      archiveBaseDir,
      archiveDir: archived.archiveDir,
      daemonStoppedAcknowledged: true,
    });
    expect(replay).toMatchObject({
      status: 'already_retired',
      quarantineDir: retired.quarantineDir,
      receiptPath: retired.receiptPath,
    });
    const staticReport = await runWorkflowRunArchiveCli({
      mode: 'verify',
      json: true,
      runsDir,
      archiveBaseDir,
      archiveRef: archived.archiveDir,
      daemonStoppedAcknowledged: false,
    });
    expect(staticReport).toMatchObject({
      mode: 'verify',
      archiveId: archived.manifest.archiveId,
      staticVerified: true,
      sourceVerified: false,
    });
  });

  it('fails closed when the source mutates between the two retirement verifications', async () => {
    const runDir = seedTerminal();
    const archived = await commitV2RunArchive({ runsDir, archiveBaseDir });
    await expect(retireV2RunSource({
      runsDir,
      archiveBaseDir,
      archiveDir: archived.archiveDir,
      daemonStoppedAcknowledged: true,
      onPhase(phase) {
        if (phase === 'after-first-source-verification') {
          writeFileSync(join(runDir, 'workflow.json'), '{"changed":true}\n', 'utf-8');
        }
      },
    })).rejects.toMatchObject({ code: 'ARCHIVE_SOURCE_CHANGED' });
    expect(existsSync(runsDir)).toBe(true);
    expect(readdirSync(root).some((name) => name.startsWith('.workflow-runs.retired-'))).toBe(false);
  });

  it('recovers crashes before rename, after rename, and after receipt publication', async () => {
    for (const crashPhase of [
      'before-source-rename',
      'after-source-rename',
      'after-retirement-receipt',
    ] as const) {
      const caseRoot = join(root, crashPhase);
      const caseRuns = join(caseRoot, 'workflow-runs');
      const caseArchives = join(caseRoot, 'archives');
      mkdirSync(caseRuns, { recursive: true });
      const previousRuns = runsDir;
      runsDir = caseRuns;
      seedTerminal();
      runsDir = previousRuns;
      const archived = await commitV2RunArchive({ runsDir: caseRuns, archiveBaseDir: caseArchives });
      await expect(retireV2RunSource({
        runsDir: caseRuns,
        archiveBaseDir: caseArchives,
        archiveDir: archived.archiveDir,
        daemonStoppedAcknowledged: true,
        onPhase(phase) {
          if (phase === crashPhase) throw new Error(`crash:${crashPhase}`);
        },
      })).rejects.toThrow(`crash:${crashPhase}`);
      const recovered = await retireV2RunSource({
        runsDir: caseRuns,
        archiveBaseDir: caseArchives,
        archiveDir: archived.archiveDir,
        daemonStoppedAcknowledged: true,
      });
      expect(recovered.status).toBe(crashPhase === 'after-retirement-receipt' ? 'already_retired' : 'retired');
      expect(existsSync(caseRuns)).toBe(false);
    }
  });

  it('retires absolute OutputRef paths and recovers after rename without replaying relocated projections', async () => {
    seedSucceededWithAbsoluteOutputPath();
    const archived = await commitV2RunArchive({ runsDir, archiveBaseDir });
    const projection = JSON.parse(readFileSync(
      join(archived.archiveDir, 'runs', 'run-absolute-output', 'projection.json'),
      'utf-8',
    ));
    expect(projection.attemptIO['att-1'].input.value).toEqual({ ok: true });

    await expect(retireV2RunSource({
      runsDir,
      archiveBaseDir,
      archiveDir: archived.archiveDir,
      daemonStoppedAcknowledged: true,
      onPhase(phase) {
        if (phase === 'after-source-rename') throw new Error('crash-after-absolute-rename');
      },
    })).rejects.toThrow('crash-after-absolute-rename');

    const recovered = await retireV2RunSource({
      runsDir,
      archiveBaseDir,
      archiveDir: archived.archiveDir,
      daemonStoppedAcknowledged: true,
    });
    expect(recovered).toMatchObject({ status: 'retired' });
  });

  it('post-rename raw verification rejects old-writer appends and extra/missing/changed entries', async () => {
    const mutations = [
      {
        name: 'old-writer-append',
        mutate(quarantine: string) {
          writeFileSync(
            join(quarantine, 'run-ok', 'events.ndjson'),
            '{"late":"append"}\n',
            { flag: 'a' },
          );
        },
      },
      {
        name: 'extra-directory',
        mutate(quarantine: string) { mkdirSync(join(quarantine, 'run-ok', 'late-dir')); },
      },
      {
        name: 'missing-file',
        mutate(quarantine: string) { rmSync(join(quarantine, 'run-ok', 'workflow.json')); },
      },
      {
        name: 'changed-file',
        mutate(quarantine: string) {
          writeFileSync(join(quarantine, 'run-ok', 'workflow.json'), '{"late":true}\n', 'utf-8');
        },
      },
    ];
    for (const mutation of mutations) {
      const caseRoot = join(root, mutation.name);
      const caseRuns = join(caseRoot, 'workflow-runs');
      const caseArchives = join(caseRoot, 'archives');
      mkdirSync(caseRuns, { recursive: true });
      const previousRuns = runsDir;
      runsDir = caseRuns;
      seedTerminal();
      runsDir = previousRuns;
      const archived = await commitV2RunArchive({ runsDir: caseRuns, archiveBaseDir: caseArchives });
      await expect(retireV2RunSource({
        runsDir: caseRuns,
        archiveBaseDir: caseArchives,
        archiveDir: archived.archiveDir,
        daemonStoppedAcknowledged: true,
        onPhase(phase) {
          if (phase !== 'after-source-rename') return;
          const quarantine = readdirSync(caseRoot)
            .find((name) => name.startsWith('.workflow-runs.retired-'));
          if (!quarantine) throw new Error('missing quarantine in test seam');
          mutation.mutate(join(caseRoot, quarantine));
        },
      })).rejects.toMatchObject({ code: 'ARCHIVE_SOURCE_CHANGED' });
    }
  });

  it('archives, verifies, and retires a residual-only nonempty source', async () => {
    const residual = join(runsDir, 'target', 'blobs');
    mkdirSync(residual, { recursive: true });
    writeFileSync(join(residual, 'orphan'), 'residual-only', 'utf-8');
    const plan = await planV2RunArchive({ runsDir });
    expect(plan).toMatchObject({ runCount: 0, residualCount: 1 });
    const archived = await commitV2RunArchive({ runsDir, archiveBaseDir });
    expect(archived.verification).toMatchObject({ staticVerified: true, sourceVerified: true });
    const retired = await retireV2RunSource({
      runsDir,
      archiveBaseDir,
      archiveDir: archived.archiveDir,
      daemonStoppedAcknowledged: true,
    });
    expect(retired).toMatchObject({ status: 'retired' });
  });

  it('returns a zero-write no-op for a missing or truly empty fresh-install source', async () => {
    const missingArchive = join(archiveBaseDir, `sha256-${'a'.repeat(64)}`);
    const empty = await retireV2RunSource({
      runsDir,
      archiveBaseDir,
      archiveDir: missingArchive,
      daemonStoppedAcknowledged: false,
    });
    expect(empty).toMatchObject({ status: 'nothing_to_retire' });
    expect(existsSync(archiveBaseDir)).toBe(false);

    rmSync(runsDir, { recursive: true, force: true });
    const missing = await retireV2RunSource({
      runsDir,
      archiveBaseDir,
      archiveDir: missingArchive,
      daemonStoppedAcknowledged: false,
    });
    expect(missing).toMatchObject({ status: 'nothing_to_retire' });
    expect(existsSync(archiveBaseDir)).toBe(false);
  });

  it('fails closed on unsafe quarantine and receipt filesystem entries', async () => {
    seedTerminal();
    const archived = await commitV2RunArchive({ runsDir, archiveBaseDir });
    const hex = archived.manifest.archiveId.slice('sha256:'.length);
    const quarantine = join(root, `.workflow-runs.retired-${hex}`);
    symlinkSync(runsDir, quarantine);
    await expect(retireV2RunSource({
      runsDir,
      archiveBaseDir,
      archiveDir: archived.archiveDir,
      daemonStoppedAcknowledged: true,
    })).rejects.toMatchObject({ code: 'RETIREMENT_QUARANTINE_UNSAFE' });
    rmSync(quarantine, { force: true });

    const receipt = join(archiveBaseDir, `v2-run-retirement-${hex}.json`);
    linkSync(join(runsDir, 'run-ok', 'workflow.json'), receipt);
    await expect(retireV2RunSource({
      runsDir,
      archiveBaseDir,
      archiveDir: archived.archiveDir,
      daemonStoppedAcknowledged: true,
    })).rejects.toMatchObject({ code: 'RETIREMENT_RECEIPT_UNSAFE' });
  });
});

function unlinkIfExists(path: string): void {
  try { rmSync(path); } catch { /* absent */ }
}
