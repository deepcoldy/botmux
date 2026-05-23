import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventLog, type EventDraft } from '../src/workflows/events/append.js';
import { reportWorkerLost } from '../src/workflows/system.js';

const RUN_ID = 'run-system-test-01';
const SHA = 'sha256:' + 'a'.repeat(64);
const sampleOutputRef = {
  outputHash: SHA,
  outputBytes: 16,
  outputSchemaVersion: 1,
};

let baseDir: string;
let log: EventLog;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'wf-system-'));
  log = new EventLog(RUN_ID, baseDir);
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

async function bootstrap(): Promise<void> {
  await log.append({
    runId: RUN_ID,
    type: 'runCreated',
    actor: 'scheduler',
    payload: {
      workflowId: 'wf-demo',
      revisionId: 'rev-001',
      inputRef: sampleOutputRef,
      initiator: 'tester',
    },
  } as EventDraft);
}

describe('system — reportWorkerLost', () => {
  it('writes workerLost with workerId + lostActivityIds', async () => {
    await bootstrap();
    const e = await reportWorkerLost(log, {
      workerId: 'w-1',
      lostActivityIds: ['a-1', 'a-2'],
    });
    expect(e.type).toBe('workerLost');
    expect(e.actor).toBe('system');
    const p = e.payload as { workerId: string; lostActivityIds: string[] };
    expect(p.workerId).toBe('w-1');
    expect(p.lostActivityIds).toEqual(['a-1', 'a-2']);
  });

  it('rejects empty lostActivityIds (runtime should not call for idle workers)', async () => {
    await bootstrap();
    await expect(
      reportWorkerLost(log, { workerId: 'w-1', lostActivityIds: [] }),
    ).rejects.toThrow(/lostActivityIds is empty/);
  });

  it('appended event is replayable without state mutation (audit-only)', async () => {
    await bootstrap();
    const { replay } = await import('../src/workflows/events/replay.js');
    await reportWorkerLost(log, {
      workerId: 'w-1',
      lostActivityIds: ['a-1'],
    });
    // Replay should not throw and should not project new state.
    const snap = replay(await log.readAll());
    expect(snap.activities.size).toBe(0); // workerLost references but doesn't create activities
  });
});
