import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  EventLog,
  INLINE_PAYLOAD_MAX_BYTES,
  type EventDraft,
  type WorkflowEvent,
} from '../src/workflows/events/append.js';

const RUN_ID = 'run-test-01HZZ8X1Z7C0KZ7K1Z2WZ3V4Q5';
const SHA = 'sha256:' + 'a'.repeat(64);

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'wf-eventlog-'));
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function smallDraft(type: WorkflowEvent['type'] = 'runStarted', extra: Partial<EventDraft> = {}): EventDraft {
  return {
    runId: RUN_ID,
    type,
    actor: 'scheduler',
    payload: {},
    ...extra,
  } as EventDraft;
}

describe('EventLog construction', () => {
  it('creates runDir and blobDir on construct', () => {
    const log = new EventLog(RUN_ID, baseDir);
    expect(existsSync(log.runDir)).toBe(true);
    expect(existsSync(log.blobDir)).toBe(true);
  });

  it('rejects empty runId/baseDir', () => {
    expect(() => new EventLog('', baseDir)).toThrow();
    expect(() => new EventLog(RUN_ID, '')).toThrow();
  });

  it('starts with seq=0 for new run', async () => {
    const log = new EventLog(RUN_ID, baseDir);
    expect(await log.currentSeq()).toBe(0);
  });
});

describe('EventLog.append — seq assignment', () => {
  it('first append gets seq=1, eventId=<runId>-1', async () => {
    const log = new EventLog(RUN_ID, baseDir);
    const e = await log.append(smallDraft('runStarted'));
    expect(e.eventId).toBe(`${RUN_ID}-1`);
    expect(e.schemaVersion).toBe(1);
    expect(e.runId).toBe(RUN_ID);
    expect(e.type).toBe('runStarted');
  });

  it('appends 3 events with monotonic seq 1,2,3', async () => {
    const log = new EventLog(RUN_ID, baseDir);
    const a = await log.append(smallDraft('runStarted'));
    const b = await log.append(
      smallDraft('nodeWaiting', {
        payload: { nodeId: 'n1', waitReason: 'human gate' },
      } as Partial<EventDraft>),
    );
    const c = await log.append(smallDraft('runStarted'));
    expect([a.eventId, b.eventId, c.eventId]).toEqual([
      `${RUN_ID}-1`,
      `${RUN_ID}-2`,
      `${RUN_ID}-3`,
    ]);
  });

  it('fills timestamp from Date.now() when omitted', async () => {
    const log = new EventLog(RUN_ID, baseDir);
    const before = Date.now();
    const e = await log.append(smallDraft('runStarted'));
    const after = Date.now();
    expect(e.timestamp).toBeGreaterThanOrEqual(before);
    expect(e.timestamp).toBeLessThanOrEqual(after);
  });

  it('honors caller-provided timestamp', async () => {
    const log = new EventLog(RUN_ID, baseDir);
    const ts = 1779999999000;
    const e = await log.append(smallDraft('runStarted', { timestamp: ts }));
    expect(e.timestamp).toBe(ts);
  });
});

describe('EventLog.append — concurrent appends serialize', () => {
  it('parallel append calls produce contiguous monotonic seq, no collision', async () => {
    const log = new EventLog(RUN_ID, baseDir);
    const N = 20;
    const promises = Array.from({ length: N }, (_, i) =>
      log.append(
        smallDraft('nodeWaiting', {
          payload: { nodeId: `n${i}`, waitReason: 'parallel' },
        } as Partial<EventDraft>),
      ),
    );
    const results = await Promise.all(promises);
    const seqs = results.map((e) => parseInt(e.eventId.split('-').pop()!, 10)).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });

  it('two EventLog instances for the same runId share a mutex — no seq collision', async () => {
    // Codex round 4 fix: instance-local mutex would let two parallel
    // EventLog instances both load seq=0, both assign seq=1 to their first
    // append, and both write `runId-1` lines.  The module-level mutex map
    // closes that hole.
    const logA = new EventLog(RUN_ID, baseDir);
    const logB = new EventLog(RUN_ID, baseDir);
    const N = 10;
    const promises = [
      ...Array.from({ length: N }, () =>
        logA.append(
          smallDraft('nodeWaiting', { payload: { nodeId: 'A', waitReason: 'r' } } as Partial<EventDraft>),
        ),
      ),
      ...Array.from({ length: N }, () =>
        logB.append(
          smallDraft('nodeWaiting', { payload: { nodeId: 'B', waitReason: 'r' } } as Partial<EventDraft>),
        ),
      ),
    ];
    const results = await Promise.all(promises);
    const seqs = results.map((e) => parseInt(e.eventId.split('-').pop()!, 10)).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 2 * N }, (_, i) => i + 1));
    // Final on-disk file should have 20 lines, all unique eventIds.
    const events = await logA.readAll();
    const ids = events.map((e) => e.eventId);
    expect(ids).toHaveLength(2 * N);
    expect(new Set(ids).size).toBe(2 * N);
  });
});

describe('EventLog.append — inline payload size cap (codex round 4: no auto-spill)', () => {
  it('small payload stays inline, no payloadHash', async () => {
    const log = new EventLog(RUN_ID, baseDir);
    const e = await log.append(
      smallDraft('nodeWaiting', {
        payload: { nodeId: 'n1', waitReason: 'small' },
      } as Partial<EventDraft>),
    );
    expect(e.payloadHash).toBeUndefined();
    expect('ref' in (e.payload as object)).toBe(false);
  });

  it('payload > INLINE_PAYLOAD_MAX_BYTES THROWS — caller must use OutputRef-shaped fields', async () => {
    const log = new EventLog(RUN_ID, baseDir);
    const fatString = 'x'.repeat(INLINE_PAYLOAD_MAX_BYTES + 100);
    await expect(
      log.append(
        smallDraft('nodeWaiting', {
          payload: { nodeId: fatString, waitReason: 'large' },
        } as Partial<EventDraft>),
      ),
    ).rejects.toThrow(/inline payload .* exceeds INLINE_PAYLOAD_MAX_BYTES/);
  });

  it('caller-provided PayloadRef is accepted (own-blob path, with payloadHash)', async () => {
    const log = new EventLog(RUN_ID, baseDir);
    // Caller wrote their own blob and supplies ref + hash.  This codepath
    // is permitted by the schema for custom-dashboard projections; the v0
    // runtime doesn't exercise it but we keep the door open.
    const blobPath = join(log.blobDir, 'caller-blob');
    writeFileSync(blobPath, JSON.stringify({ x: 1 }), 'utf-8');
    const hash = 'sha256:' + createHash('sha256').update('{"x":1}', 'utf-8').digest('hex');
    const e = await log.append({
      runId: RUN_ID,
      type: 'runStarted',
      actor: 'scheduler',
      payload: { ref: blobPath, bytes: 8, schemaVersion: 1 },
      payloadHash: hash,
    } as EventDraft);
    expect(e.payloadHash).toBe(hash);
    expect((e.payload as any).ref).toBe(blobPath);
  });
});

describe('EventLog.append — post-parse invariants run on write', () => {
  it('rejects waitCreated drafts that violate the prompt/promptRef invariant', async () => {
    // Producer 自己写出 prompt+promptRef 并存的 draft 也要被 invariant 在 append
    // 时拦下，不能只靠 parseEvent 单元层。
    const log = new EventLog(RUN_ID, baseDir);
    await expect(
      log.append({
        runId: RUN_ID,
        type: 'waitCreated',
        actor: 'scheduler',
        payload: {
          activityId: 'a1',
          nodeId: 'n',
          waitKind: 'human-gate',
          prompt: 'small',
          promptRef: {
            outputHash: SHA,
            outputPath: join(baseDir, 'fake-blob'),
            outputBytes: 5000,
            outputSchemaVersion: 1,
            contentType: 'text/plain',
          },
          promptPreview: 'preview',
        },
      } as EventDraft),
    ).rejects.toThrow(/mutually exclusive/);
  });
});

describe('EventLog.readAll', () => {
  it('returns [] for empty log', async () => {
    const log = new EventLog(RUN_ID, baseDir);
    expect(await log.readAll()).toEqual([]);
  });

  it('returns events in append order', async () => {
    const log = new EventLog(RUN_ID, baseDir);
    await log.append(smallDraft('runStarted'));
    await log.append(
      smallDraft('nodeWaiting', {
        payload: { nodeId: 'n1', waitReason: 'r' },
      } as Partial<EventDraft>),
    );
    await log.append(smallDraft('runStarted'));
    const events = await log.readAll();
    expect(events.map((e) => e.eventId)).toEqual([
      `${RUN_ID}-1`,
      `${RUN_ID}-2`,
      `${RUN_ID}-3`,
    ]);
  });

  it('throws on corrupt JSON line', async () => {
    const log = new EventLog(RUN_ID, baseDir);
    await log.append(smallDraft('runStarted'));
    // Hand-corrupt the file
    await fs.appendFile(log.eventsFile, '{not json}\n', 'utf-8');
    await expect(log.readAll()).rejects.toThrow(/corrupt event at line 2/);
  });

  it('throws on schema-invalid line (e.g. unknown type)', async () => {
    const log = new EventLog(RUN_ID, baseDir);
    await log.append(smallDraft('runStarted'));
    const fake = {
      eventId: `${RUN_ID}-2`,
      runId: RUN_ID,
      timestamp: Date.now(),
      type: 'bogus',
      schemaVersion: 1,
      actor: 'scheduler',
      payload: {},
    };
    await fs.appendFile(log.eventsFile, JSON.stringify(fake) + '\n', 'utf-8');
    await expect(log.readAll()).rejects.toThrow(/corrupt event at line 2/);
  });
});

describe('EventLog seq recovery on restart', () => {
  it('new EventLog instance picks up max seq from existing log', async () => {
    const first = new EventLog(RUN_ID, baseDir);
    await first.append(smallDraft('runStarted'));
    await first.append(smallDraft('runStarted'));
    await first.append(smallDraft('runStarted'));

    const second = new EventLog(RUN_ID, baseDir);
    expect(await second.currentSeq()).toBe(3);
    const e = await second.append(smallDraft('runStarted'));
    expect(e.eventId).toBe(`${RUN_ID}-4`);
  });
});

describe('EventLog.readBlob', () => {
  it('reads back a caller-written blob and content matches', async () => {
    const log = new EventLog(RUN_ID, baseDir);
    // No auto-spill anymore (codex round 4): the caller writes its own
    // blob.  Read-back path is still useful for resume/replay that needs
    // to materialize OutputRef-shaped business data.
    const content = JSON.stringify({ hello: 'world' });
    const blobPath = join(log.blobDir, 'manual-blob');
    writeFileSync(blobPath, content, 'utf-8');
    const blob = await log.readBlob(blobPath);
    expect(blob.toString('utf-8')).toBe(content);
  });
});

describe('EventLog NDJSON line format', () => {
  it('each event is a single line, exactly one trailing newline', async () => {
    const log = new EventLog(RUN_ID, baseDir);
    await log.append(smallDraft('runStarted'));
    await log.append(smallDraft('runStarted'));
    const raw = readFileSync(log.eventsFile, 'utf-8');
    const lines = raw.split('\n');
    // 2 events + trailing empty string from final newline
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(JSON.parse(lines[0]).type).toBe('runStarted');
    expect(JSON.parse(lines[1]).type).toBe('runStarted');
  });
});
