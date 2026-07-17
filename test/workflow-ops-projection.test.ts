/** Frozen v2 read-only projection coverage retained for archive verification. */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  eventSeqFromId,
  extractEventContext,
  isValidRunId,
  listRuns,
  readEventWindow,
  readRunSnapshot,
  scrubSnapshotForUnauthed,
  type RunSnapshotDTO,
} from '../src/workflows/ops-projection.js';
import { canonicalJsonStringify } from '../src/workflows/definition.js';
import {
  FrozenV2EventLog,
  type FrozenV2EventDraft,
} from './helpers/frozen-v2-event-log.js';

const SHA = `sha256:${'a'.repeat(64)}`;
const DEF = {
  schemaVersion: '0.2',
  workflowId: 'frozen-projection',
  version: 1,
  nodes: { only: { type: 'subagent', bot: 'b', prompt: 'hi' } },
};

let root: string;
let runsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'v2-projection-'));
  runsDir = join(root, 'workflow-runs');
  mkdirSync(runsDir, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function seedRun(input: {
  runId: string;
  terminal?: 'succeeded' | 'failed';
  timestamp?: number;
  binding?: boolean;
}): Promise<FrozenV2EventLog> {
  const { runId } = input;
  const log = new FrozenV2EventLog(runId, runsDir);
  const activityId = `${runId}::work::only`;
  const attemptId = `${activityId}::att-1`;
  const outputPath = join(log.blobDir, 'output.json');
  const outputRef = {
    outputHash: SHA,
    outputPath,
    outputBytes: 12,
    outputSchemaVersion: 1,
    contentType: 'application/json',
  };
  writeFileSync(outputPath, '{"ok":true}\n', 'utf-8');
  writeFileSync(join(log.runDir, 'workflow.json'), canonicalJsonStringify(DEF), 'utf-8');
  if (input.binding) {
    writeFileSync(
      join(log.runDir, 'chat-binding.json'),
      JSON.stringify({ chatId: 'oc_archive', larkAppId: 'cli_archive' }),
      'utf-8',
    );
  }
  const base = input.timestamp ?? 1_700_000_000_000;
  const append = (draft: Omit<FrozenV2EventDraft, 'runId' | 'timestamp'>, offset: number) =>
    log.append({ ...draft, runId, timestamp: base + offset } as FrozenV2EventDraft);
  await append({
    type: 'runCreated',
    actor: 'scheduler',
    payload: {
      workflowId: DEF.workflowId,
      revisionId: `sha256:${'b'.repeat(64)}`,
      inputRef: outputRef,
      initiator: 'archive-test',
    },
  }, 1);
  await append({ type: 'runStarted', actor: 'scheduler', payload: {} }, 2);
  await append({
    type: 'attemptCreated',
    actor: 'scheduler',
    payload: { nodeId: 'only', activityId, attemptId, attemptNumber: 1, inputRef: outputRef },
  }, 3);
  await append({
    type: 'activityRunning',
    actor: 'worker',
    payload: { activityId, attemptId, leaseId: 'lease-1' },
  }, 4);
  if (input.terminal === 'succeeded') {
    await append({
      type: 'activitySucceeded',
      actor: 'worker',
      payload: { activityId, attemptId, outputRef, externalRefs: {} },
    }, 5);
    await append({
      type: 'nodeSucceeded',
      actor: 'scheduler',
      payload: { nodeId: 'only', lastActivityId: activityId },
    }, 6);
    await append({ type: 'runSucceeded', actor: 'scheduler', payload: { outputRef } }, 7);
  } else if (input.terminal === 'failed') {
    await append({
      type: 'activityFailed',
      actor: 'worker',
      payload: {
        activityId,
        attemptId,
        error: { errorCode: 'WorkerCrashed', errorClass: 'fatal', errorMessage: 'gone' },
      },
    }, 5);
    await append({
      type: 'nodeFailed',
      actor: 'scheduler',
      payload: { nodeId: 'only', lastActivityId: activityId, errorClass: 'fatal' },
    }, 6);
    await append({
      type: 'runFailed',
      actor: 'scheduler',
      payload: { failedNodeId: 'only', rootCauseEventId: `${runId}-5` },
    }, 7);
  }
  return log;
}

describe('frozen v2 run listing', () => {
  it('never creates a missing directory and rejects unsafe ids', async () => {
    const missing = join(root, 'missing');
    expect(await listRuns(missing)).toEqual([]);
    expect(existsSync(missing)).toBe(false);
    expect(isValidRunId('safe-run_1')).toBe(true);
    expect(isValidRunId('../escape')).toBe(false);
    expect(isValidRunId('.hidden')).toBe(false);
  });

  it('hides terminal runs by default and includes verified binding on demand', async () => {
    await seedRun({ runId: 'active', timestamp: 100, binding: true });
    await seedRun({ runId: 'done', terminal: 'succeeded', timestamp: 200 });
    expect((await listRuns(runsDir)).map((row) => row.runId)).toEqual(['active']);
    const rows = await listRuns(runsDir, { all: true, includeBinding: true });
    expect(rows.map((row) => row.runId)).toEqual(['done', 'active']);
    expect(rows.find((row) => row.runId === 'active')).toMatchObject({
      chatId: 'oc_archive',
      larkAppId: 'cli_archive',
      status: 'running',
    });
  });

  it('projects a bounded failure summary and skips corrupt logs', async () => {
    await seedRun({ runId: 'failed', terminal: 'failed' });
    const corrupt = join(runsDir, 'corrupt');
    mkdirSync(corrupt);
    writeFileSync(join(corrupt, 'events.ndjson'), '{bad json\n');
    const rows = await listRuns(runsDir, { all: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: 'failed',
      status: 'failed',
      failedNodeId: 'only',
      errorCode: 'WorkerCrashed',
      errorClass: 'fatal',
      errorMessage: 'gone',
    });
  });
});

describe('frozen v2 snapshot and event window', () => {
  it('replays terminal state, nodes, attempts and output previews from immutable bytes', async () => {
    await seedRun({ runId: 'snapshot', terminal: 'succeeded', binding: true });
    const snapshot = await readRunSnapshot(runsDir, 'snapshot');
    expect(snapshot).not.toBeNull();
    expect(snapshot).toMatchObject({
      runId: 'snapshot',
      run: { status: 'succeeded', workflowId: DEF.workflowId },
      lastSeq: 7,
      chatBinding: { chatId: 'oc_archive', larkAppId: 'cli_archive' },
    });
    expect(snapshot?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'only', status: 'succeeded' }),
    ]));
    expect(snapshot?.activities[0]).toMatchObject({ status: 'succeeded', ownerNodeId: 'only' });
    expect(Object.values(snapshot?.attemptIO ?? {})[0]?.output?.value).toEqual({ ok: true });
  });

  it('paginates only parsed archive events and returns null for missing/unsafe ids', async () => {
    await seedRun({ runId: 'window', terminal: 'succeeded' });
    const tail = await readEventWindow(runsDir, 'window', { tail: 2 });
    expect(tail).toMatchObject({ oldestSeq: 6, newestSeq: 7, totalCount: 7, hasOlder: true });
    const after = await readEventWindow(runsDir, 'window', { afterSeq: 3, limit: 2 });
    expect(after?.events.map((event) => event.eventId)).toEqual(['window-4', 'window-5']);
    expect(await readEventWindow(runsDir, '../window')).toBeNull();
    expect(await readRunSnapshot(runsDir, 'missing')).toBeNull();
  });
});

describe('frozen v2 projection helpers', () => {
  it('keeps event sequence and error context extraction stable', () => {
    expect(eventSeqFromId('run-with-dashes-42')).toBe(42);
    expect(eventSeqFromId('bad')).toBe(0);
    expect(extractEventContext({
      nodeId: 'n1',
      activityId: 'a1',
      error: { errorCode: 'WorkerCrashed' },
    })).toEqual({ nodeId: 'n1', activityId: 'a1', errorCode: 'WorkerCrashed' });
  });

  it('scrubs terminal bytes and absolute paths without mutating the source', () => {
    const source = {
      runId: 'r',
      run: { runId: 'r', status: 'running' },
      lastSeq: 1,
      nodes: [],
      activities: [],
      dangling: { activities: [], effectAttempted: [], waits: [], cancels: [] },
      outputs: {},
      attemptIO: {
        a1: {
          log: { text: 'secret', outputBytes: 6 },
          terminal: {
            sessionId: 's1', webPort: 1, status: 'closed', logPath: '/secret/path',
            startedAt: 1, updatedAt: 2, closedAt: 2,
          },
        },
      },
      updatedAt: 1,
    } as RunSnapshotDTO;
    const scrubbed = scrubSnapshotForUnauthed(source);
    expect(scrubbed.attemptIO.a1?.log).toEqual({ outputBytes: 6, redacted: true });
    expect(scrubbed.attemptIO.a1?.terminal?.logPath).toBeUndefined();
    expect(source.attemptIO.a1?.log?.text).toBe('secret');
  });
});
