/**
 * Unit tests for `src/workflows/ops-projection.ts` — the shared module
 * backing `botmux workflow ls/tail` and the dashboard read-only API.
 *
 * Side-effect contract under test: no `mkdir` on read paths.  We assert
 * this by seeding events.ndjson without `chat-binding.json` and
 * verifying that calls to `readRunSnapshot` / `readEventWindow` for
 * unknown runIds DO NOT create directories.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  eventSeqFromId,
  extractEventContext,
  isValidRunId,
  listRuns,
  readEventWindow,
  readRunSnapshot,
  scrubSnapshotForUnauthed,
} from '../src/workflows/ops-projection.js';
import { EventLog } from '../src/workflows/events/append.js';
import { parseWorkflowDefinition } from '../src/workflows/definition.js';
import { createRun } from '../src/workflows/run-init.js';
import { runLoop } from '../src/workflows/loop.js';
import {
  loopGateActivityId,
  workActivityId,
} from '../src/workflows/orchestrator.js';
import { resolveWait } from '../src/workflows/wait.js';
import type { WorkerSpawnFn } from '../src/workflows/runtime.js';

let runsDir: string;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ops-proj-'));
  runsDir = join(tmp, 'runs');
  mkdirSync(runsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const HELLO_DEF = parseWorkflowDefinition({
  workflowId: 'proj-hello',
  version: 1,
  nodes: { only: { type: 'subagent', bot: 'b', prompt: 'hi' } },
});

const okSpawn: WorkerSpawnFn = async (input) => ({
  kind: 'success',
  output: { ok: true },
  session: {
    sessionId: `s-${input.activityId}`,
    botName: input.botName,
    startedAt: 1,
    endedAt: 2,
  },
});

async function seedActive(runId: string): Promise<EventLog> {
  const log = new EventLog(runId, runsDir);
  await createRun(log, {
    def: HELLO_DEF,
    params: {},
    initiator: 'test',
    botResolver: () => ({}),
  });
  return log;
}

async function seedSucceeded(runId: string): Promise<void> {
  const log = await seedActive(runId);
  await runLoop({ log, def: HELLO_DEF, spawnSubagent: okSpawn });
}

// ─── isValidRunId ───────────────────────────────────────────────────────────

describe('isValidRunId', () => {
  it('accepts UUIDs and slug-shaped ids', () => {
    expect(isValidRunId('run-abc-123')).toBe(true);
    expect(isValidRunId('o1-canary-1748000000')).toBe(true);
    expect(isValidRunId('A_B.c-9')).toBe(true);
  });
  it('rejects path traversal and separators', () => {
    expect(isValidRunId('..')).toBe(false);
    expect(isValidRunId('../etc')).toBe(false);
    expect(isValidRunId('foo/bar')).toBe(false);
    expect(isValidRunId('foo\\bar')).toBe(false);
    expect(isValidRunId('')).toBe(false);
    expect(isValidRunId('.hidden')).toBe(false);
  });
  it('rejects overly long ids', () => {
    expect(isValidRunId('a'.repeat(129))).toBe(false);
    expect(isValidRunId('a'.repeat(128))).toBe(true);
  });
});

// ─── listRuns ───────────────────────────────────────────────────────────────

describe('listRuns', () => {
  it('returns [] when runsDir does not exist (no throw, no mkdir)', async () => {
    const missing = join(tmp, 'no-such');
    const rows = await listRuns(missing);
    expect(rows).toEqual([]);
    expect(existsSync(missing)).toBe(false);
  });

  it('default hides terminal runs', async () => {
    await seedActive('r-active');
    await seedSucceeded('r-done');
    const rows = await listRuns(runsDir);
    expect(rows.map((r) => r.runId)).toEqual(['r-active']);
  });

  it('all=true surfaces terminal runs too', async () => {
    await seedActive('r-active');
    await seedSucceeded('r-done');
    const rows = await listRuns(runsDir, { all: true });
    expect(new Set(rows.map((r) => r.runId))).toEqual(new Set(['r-active', 'r-done']));
  });

  it('statuses filter wins over all flag', async () => {
    await seedActive('r-active');
    await seedSucceeded('r-done');
    const rows = await listRuns(runsDir, { statuses: new Set(['succeeded']) });
    expect(rows.map((r) => r.runId)).toEqual(['r-done']);
  });

  it('sorts by updatedAt desc', async () => {
    await seedActive('r-older');
    // Give the second run a strictly-later log line.
    await new Promise((r) => setTimeout(r, 10));
    await seedActive('r-newer');
    const rows = await listRuns(runsDir);
    expect(rows.map((r) => r.runId)).toEqual(['r-newer', 'r-older']);
  });

  it('skips runs with corrupt event log', async () => {
    await seedActive('r-ok');
    const badDir = join(runsDir, 'r-bad');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'events.ndjson'), '{not json\n', 'utf-8');
    const rows = await listRuns(runsDir);
    expect(rows.map((r) => r.runId)).toEqual(['r-ok']);
  });

  it('skips disallowed dir names (path traversal guard)', async () => {
    // `..foo` starts with `.` → rejected by isValidRunId.
    mkdirSync(join(runsDir, '..foo'), { recursive: true });
    await seedActive('r-good');
    const rows = await listRuns(runsDir);
    expect(rows.map((r) => r.runId)).toEqual(['r-good']);
  });

  it('includeBinding pulls chatId/larkAppId when present', async () => {
    await seedActive('r-with-binding');
    writeFileSync(
      join(runsDir, 'r-with-binding', 'chat-binding.json'),
      JSON.stringify({ chatId: 'chat-1', larkAppId: 'app-1' }),
      'utf-8',
    );
    const [row] = await listRuns(runsDir, { includeBinding: true });
    expect(row?.chatId).toBe('chat-1');
    expect(row?.larkAppId).toBe('app-1');
  });

  it('includeBinding=false leaves chatId/larkAppId undefined', async () => {
    await seedActive('r-no-binding');
    writeFileSync(
      join(runsDir, 'r-no-binding', 'chat-binding.json'),
      JSON.stringify({ chatId: 'chat-1', larkAppId: 'app-1' }),
      'utf-8',
    );
    const [row] = await listRuns(runsDir);
    expect(row?.chatId).toBeUndefined();
    expect(row?.larkAppId).toBeUndefined();
  });

  it('projects failed run error summary for dashboard run list', async () => {
    const failingSpawn: WorkerSpawnFn = async () => ({
      kind: 'failure',
      errorCode: 'InputValidationFailed',
      errorClass: 'userFault',
      errorMessage: 'city must be provided before planning can start',
    });
    const log = await seedActive('r-failed-row');
    await runLoop({ log, def: HELLO_DEF, spawnSubagent: failingSpawn });

    const [row] = await listRuns(runsDir, { all: true });
    expect(row?.runId).toBe('r-failed-row');
    expect(row?.status).toBe('failed');
    expect(row?.errorCode).toBe('InputValidationFailed');
    expect(row?.errorClass).toBe('userFault');
    expect(row?.errorMessage).toContain('city must be provided');
  });
});

// ─── readRunSnapshot ────────────────────────────────────────────────────────

describe('readRunSnapshot', () => {
  it('returns null for unknown runId (no mkdir side effect)', async () => {
    const fake = 'never-existed';
    const snap = await readRunSnapshot(runsDir, fake);
    expect(snap).toBeNull();
    expect(existsSync(join(runsDir, fake))).toBe(false);
  });

  it('returns null for path-traversal runId', async () => {
    expect(await readRunSnapshot(runsDir, '..')).toBeNull();
    expect(await readRunSnapshot(runsDir, '../../etc/passwd')).toBeNull();
  });

  it('returns full snapshot for a healthy run', async () => {
    await seedActive('r-snap');
    const snap = await readRunSnapshot(runsDir, 'r-snap');
    expect(snap).not.toBeNull();
    expect(snap!.runId).toBe('r-snap');
    expect(snap!.run.workflowId).toBe('proj-hello');
    expect(typeof snap!.lastSeq).toBe('number');
    expect(Array.isArray(snap!.nodes)).toBe(true);
    expect(Array.isArray(snap!.activities)).toBe(true);
    expect(snap!.dangling).toEqual({
      activities: expect.any(Array),
      effectAttempted: expect.any(Array),
      waits: expect.any(Array),
      cancels: expect.any(Array),
    });
  });

  it('includes readable input/output previews for attempts', async () => {
    await seedSucceeded('r-io');
    const activityId = workActivityId('r-io', 'only');
    const attemptId = 'r-io::work::only::att-1';
    const attemptDir = join(runsDir, 'r-io', 'attempts', activityId, attemptId);
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(
      join(attemptDir, 'terminal.log'),
      '[2026-05-20T00:00:00.000Z] stdout running step\n',
      'utf-8',
    );
    writeFileSync(
      join(attemptDir, 'terminal.json'),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: 'wf-r-io-only',
        cliSessionId: 'native-cli-session-io',
        webPort: 32123,
        status: 'live',
        larkAppId: 'cli_x',
        botName: 'bot-x',
        cliId: 'claude-code',
        workingDir: '/repo',
        logPath: join(attemptDir, 'terminal.log'),
        startedAt: 100,
        updatedAt: 200,
      }),
      'utf-8',
    );
    const snap = await readRunSnapshot(runsDir, 'r-io');

    expect(snap?.attemptIO[attemptId]?.input?.value).toEqual({
      kind: 'subagent',
      bot: 'b',
      prompt: 'hi',
    });
    expect(snap?.attemptIO[attemptId]?.resolvedInput?.value).toEqual({
      kind: 'subagent',
      bot: 'b',
      prompt: 'hi',
    });
    expect(snap?.attemptIO[attemptId]?.output?.value).toEqual({ ok: true });
    expect(snap?.attemptIO[attemptId]?.log?.text).toContain('stdout running step');
    expect(snap?.attemptIO[attemptId]?.terminal).toEqual({
      sessionId: 'wf-r-io-only',
      cliSessionId: 'native-cli-session-io',
      webPort: 32123,
      status: 'live',
      larkAppId: 'cli_x',
      botName: 'bot-x',
      cliId: 'claude-code',
      workingDir: '/repo',
      logPath: join(attemptDir, 'terminal.log'),
      startedAt: 100,
      updatedAt: 200,
      closedAt: undefined,
      hasPtyLog: false,
    });
  });

  it('projects hasPtyLog=true when a non-empty pty.log sits alongside the sidecar', async () => {
    await seedSucceeded('r-pty');
    const activityId = workActivityId('r-pty', 'only');
    const attemptId = 'r-pty::work::only::att-1';
    const attemptDir = join(runsDir, 'r-pty', 'attempts', activityId, attemptId);
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(
      join(attemptDir, 'terminal.json'),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: 'wf-r-pty-only',
        webPort: 32124,
        status: 'closed',
        cliId: 'aiden',
        startedAt: 100,
        updatedAt: 200,
      }),
      'utf-8',
    );
    // Raw PTY bytes — projection must report hasPtyLog=true so the dashboard
    // defaults the replay viewer to the cinema mode.
    writeFileSync(join(attemptDir, 'pty.log'), '\x1b[32mhello\x1b[0m\r\n', 'utf-8');
    const snap = await readRunSnapshot(runsDir, 'r-pty');
    expect(snap?.attemptIO[attemptId]?.terminal?.hasPtyLog).toBe(true);
  });

  it('projects hasPtyLog=false when pty.log is missing or empty', async () => {
    await seedSucceeded('r-nopty');
    const activityId = workActivityId('r-nopty', 'only');
    const attemptId = 'r-nopty::work::only::att-1';
    const attemptDir = join(runsDir, 'r-nopty', 'attempts', activityId, attemptId);
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(
      join(attemptDir, 'terminal.json'),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: 'wf-r-nopty-only',
        webPort: 32125,
        status: 'closed',
        cliId: 'aiden',
        startedAt: 100,
        updatedAt: 200,
      }),
      'utf-8',
    );
    // Empty pty.log → projection treats as absent so the toggle stays diag-only.
    writeFileSync(join(attemptDir, 'pty.log'), '', 'utf-8');
    const snap = await readRunSnapshot(runsDir, 'r-nopty');
    expect(snap?.attemptIO[attemptId]?.terminal?.hasPtyLog).toBe(false);
  });

  it('shows interpolated prompt in resolved input preview', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'proj-template',
      version: 1,
      params: { city: { type: 'string', required: true } },
      nodes: {
        weather: { type: 'subagent', bot: 'b', prompt: '查 ${params.city} 天气' },
      },
    });
    const log = new EventLog('r-template', runsDir);
    await createRun(log, {
      def,
      params: { city: '上海' },
      initiator: 'test',
      botResolver: () => ({}),
    });
    await runLoop({ log, def, spawnSubagent: okSpawn });

    const snap = await readRunSnapshot(runsDir, 'r-template');
    const attemptId = 'r-template::work::weather::att-1';

    expect(snap?.attemptIO[attemptId]?.input?.value).toMatchObject({
      prompt: '查 ${params.city} 天气',
    });
    expect(snap?.attemptIO[attemptId]?.resolvedInput?.value).toMatchObject({
      prompt: '查 上海 天气',
    });
  });

  it('surfaces waitPrompt BlobPreview when waitCreated has promptRef', async () => {
    // v0.1.3: dispatchGate spills large humanGate prompts to a blob. The
    // dashboard Node I/O view must surface the full text via the same
    // BlobPreview 64KiB ladder used for input/output blobs.
    const RUN = 'r-wait-prompt';
    const blobDir = join(runsDir, RUN, 'blobs');
    mkdirSync(blobDir, { recursive: true });
    const fullPrompt = '出行规划完整 markdown\n' + 'x'.repeat(2000);
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(fullPrompt, 'utf-8').digest('hex');
    const blobPath = join(blobDir, hash);
    writeFileSync(blobPath, fullPrompt, 'utf-8');

    const log = new EventLog(RUN, runsDir);
    await createRun(log, {
      def: HELLO_DEF,
      params: {},
      initiator: 'test',
      botResolver: () => ({}),
    });
    // Hand-craft attemptCreated + waitCreated with promptRef
    const activityId = workActivityId(RUN, 'only');
    const attemptId = `${RUN}::gate::only::att-1`;
    await log.append({
      runId: RUN,
      type: 'attemptCreated',
      actor: 'scheduler',
      payload: {
        nodeId: 'only',
        activityId,
        attemptId,
        attemptNumber: 1,
        inputRef: {
          outputHash: 'sha256:' + 'a'.repeat(64),
          outputBytes: 8,
          outputSchemaVersion: 1,
        },
      },
    });
    await log.append({
      runId: RUN,
      type: 'waitCreated',
      actor: 'scheduler',
      payload: {
        activityId,
        nodeId: 'only',
        waitKind: 'human-gate',
        promptRef: {
          outputHash: `sha256:${hash}`,
          outputPath: blobPath,
          outputBytes: Buffer.byteLength(fullPrompt, 'utf-8'),
          outputSchemaVersion: 1,
          contentType: 'text/plain',
        },
        promptPreview: '出行规划完整 markdown…',
      },
    });

    const snap = await readRunSnapshot(runsDir, RUN);
    const waitPrompt = snap?.attemptIO[attemptId]?.waitPrompt;
    expect(waitPrompt).toBeDefined();
    expect(waitPrompt!.text ?? '').toContain('出行规划完整 markdown');
    expect(waitPrompt!.outputBytes).toBe(Buffer.byteLength(fullPrompt, 'utf-8'));
    expect(waitPrompt!.contentType).toBe('text/plain');
  });

  it('returns the tail when terminal.log exceeds the 64KiB cap', async () => {
    await seedSucceeded('r-tail-log');
    const activityId = workActivityId('r-tail-log', 'only');
    const attemptId = 'r-tail-log::work::only::att-1';
    const attemptDir = join(runsDir, 'r-tail-log', 'attempts', activityId, attemptId);
    mkdirSync(attemptDir, { recursive: true });
    // Write head sentinel + filler + tail sentinel, total > 64KiB.
    // Both sentinels are distinct strings; if the preview is a head-window
    // (the buggy past behavior) tail sentinel won't appear and head will.
    const HEAD = 'HEAD_SENTINEL_DO_NOT_SHOW';
    const TAIL = 'TAIL_SENTINEL_MUST_SHOW';
    const filler = 'x'.repeat(70 * 1024); // 70KiB filler so head+filler+tail > 64KiB
    writeFileSync(
      join(attemptDir, 'terminal.log'),
      `${HEAD}\n${filler}\n${TAIL}\n`,
      'utf-8',
    );

    const snap = await readRunSnapshot(runsDir, 'r-tail-log');
    const log = snap?.attemptIO[attemptId]?.log;
    expect(log).toBeDefined();
    expect(log!.truncated).toBe(true);
    expect(log!.outputBytes).toBeGreaterThan(64 * 1024);
    expect(log!.text).toContain(TAIL);
    expect(log!.text).not.toContain(HEAD);
  });

  it('scrubSnapshotForUnauthed strips io.log.text + io.terminal.logPath; keeps metadata', async () => {
    // Same seeding as the input/output preview test — gives us a snapshot
    // with both a non-empty `io.log` and a populated `io.terminal.logPath`.
    await seedSucceeded('r-scrub');
    const activityId = workActivityId('r-scrub', 'only');
    const attemptId = 'r-scrub::work::only::att-1';
    const attemptDir = join(runsDir, 'r-scrub', 'attempts', activityId, attemptId);
    mkdirSync(attemptDir, { recursive: true });
    const SECRET_LINE = 'AWS_SECRET=AKIAFAKE_should_not_leak';
    writeFileSync(
      join(attemptDir, 'terminal.log'),
      `[2026-05-25T00:00:00.000Z] stderr ${SECRET_LINE}\n`,
      'utf-8',
    );
    writeFileSync(
      join(attemptDir, 'terminal.json'),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: 'wf-r-scrub-only',
        webPort: 32200,
        status: 'closed',
        cliId: 'claude-code',
        logPath: join(attemptDir, 'terminal.log'),
        startedAt: 100,
        updatedAt: 200,
      }),
      'utf-8',
    );

    const full = await readRunSnapshot(runsDir, 'r-scrub');
    expect(full).not.toBeNull();
    // Authed view still gets the full log + logPath — the function only
    // changes the view served to unauth'd public-read callers.
    expect(full!.attemptIO[attemptId]?.log?.text).toContain(SECRET_LINE);
    expect(full!.attemptIO[attemptId]?.terminal?.logPath).toBe(
      join(attemptDir, 'terminal.log'),
    );

    const scrubbed = scrubSnapshotForUnauthed(full!);
    const scrubbedLog = scrubbed.attemptIO[attemptId]?.log;
    expect(scrubbedLog).toBeDefined();
    expect(scrubbedLog!.text).toBeUndefined();
    expect(scrubbedLog!.value).toBeUndefined();
    expect(scrubbedLog!.redacted).toBe(true);
    // Metadata stays so the dashboard can render a "log available after
    // login (N bytes)" placeholder rather than pretending the blob doesn't
    // exist.
    expect(scrubbedLog!.outputBytes).toBeGreaterThan(0);

    // Sibling blobs (input/output/resolvedInput/waitPrompt) are workflow
    // products, not raw process bytes — they stay public, same as before.
    expect(scrubbed.attemptIO[attemptId]?.input?.value).toBeDefined();
    expect(scrubbed.attemptIO[attemptId]?.output?.value).toBeDefined();

    const scrubbedTerm = scrubbed.attemptIO[attemptId]?.terminal;
    expect(scrubbedTerm).toBeDefined();
    expect(scrubbedTerm!.logPath).toBeUndefined();
    // Sidecar status / port / sessionId stay — they're needed for the
    // dashboard to know whether the live terminal stream exists.  The raw
    // bytes themselves are already cookie-gated at /terminal-log/raw.
    expect(scrubbedTerm!.sessionId).toBe('wf-r-scrub-only');
    expect(scrubbedTerm!.status).toBe('closed');
    expect(scrubbedTerm!.webPort).toBe(32200);

    // Input snapshot must not have been mutated.
    expect(full!.attemptIO[attemptId]?.log?.text).toContain(SECRET_LINE);
    expect(full!.attemptIO[attemptId]?.terminal?.logPath).toBe(
      join(attemptDir, 'terminal.log'),
    );
  });

  it('scrubSnapshotForUnauthed is a no-op when attemptIO carries no log/terminal', async () => {
    await seedSucceeded('r-scrub-empty');
    const snap = await readRunSnapshot(runsDir, 'r-scrub-empty');
    expect(snap).not.toBeNull();
    const scrubbed = scrubSnapshotForUnauthed(snap!);
    // Same top-level shape; attemptIO keys identical.
    expect(Object.keys(scrubbed.attemptIO).sort()).toEqual(
      Object.keys(snap!.attemptIO).sort(),
    );
    for (const [aid, io] of Object.entries(scrubbed.attemptIO)) {
      // No log seeded → no log key after scrub either (we don't synthesize).
      expect(io.log).toBeUndefined();
      // input/output stay byte-equal with the source.
      expect(io.input?.value).toEqual(snap!.attemptIO[aid]?.input?.value);
      expect(io.output?.value).toEqual(snap!.attemptIO[aid]?.output?.value);
    }
  });

  it('preserves activityFailed errorMessage in attempt error', async () => {
    const failingSpawn: WorkerSpawnFn = async () => ({
      kind: 'failure',
      errorCode: 'InputBindingFailed',
      errorClass: 'userFault',
      errorMessage: 'humanGate.prompt is too large after binding (4950 bytes; max 4096)',
    });
    const log = new EventLog('r-failed-msg', runsDir);
    await createRun(log, {
      def: HELLO_DEF,
      params: {},
      initiator: 'test',
      botResolver: () => ({}),
    });
    await runLoop({ log, def: HELLO_DEF, spawnSubagent: failingSpawn });

    const snap = await readRunSnapshot(runsDir, 'r-failed-msg');
    const activity = snap?.activities.find((a) => a.ownerNodeId === 'only');
    const attempt = activity?.attempts[activity.attempts.length - 1];
    expect(attempt?.error?.errorCode).toBe('InputBindingFailed');
    expect(attempt?.error?.errorClass).toBe('userFault');
    expect(attempt?.error?.errorMessage).toContain('humanGate.prompt is too large');
  });

  it('inlines chatBinding when present', async () => {
    await seedActive('r-binded');
    writeFileSync(
      join(runsDir, 'r-binded', 'chat-binding.json'),
      JSON.stringify({ chatId: 'c-x', larkAppId: 'app-x' }),
      'utf-8',
    );
    const snap = await readRunSnapshot(runsDir, 'r-binded');
    expect(snap?.chatBinding).toEqual({ chatId: 'c-x', larkAppId: 'app-x' });
  });

  it('returns null on corrupt event log', async () => {
    const dir = join(runsDir, 'r-corrupt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events.ndjson'), 'not-json\n', 'utf-8');
    expect(await readRunSnapshot(runsDir, 'r-corrupt')).toBeNull();
  });
});

// ─── readEventWindow ────────────────────────────────────────────────────────

describe('readEventWindow', () => {
  it('returns null for unknown runId', async () => {
    expect(await readEventWindow(runsDir, 'no-run', {})).toBeNull();
  });

  it('default tail returns last 100 events (or fewer)', async () => {
    await seedSucceeded('r-tail');
    const w = await readEventWindow(runsDir, 'r-tail', {});
    expect(w).not.toBeNull();
    expect(w!.events.length).toBeGreaterThan(0);
    expect(w!.events.length).toBeLessThanOrEqual(100);
    expect(w!.totalCount).toBe(w!.events.length);
    expect(w!.hasNewer).toBe(false);
  });

  it('tail=N clips correctly', async () => {
    await seedSucceeded('r-tail-n');
    const w = await readEventWindow(runsDir, 'r-tail-n', { tail: 2 });
    expect(w!.events.length).toBe(2);
    // last two events of the run
    expect(w!.hasOlder).toBe(true);
    expect(w!.hasNewer).toBe(false);
  });

  it('afterSeq=K returns only events with seq > K', async () => {
    await seedSucceeded('r-after');
    const fullWindow = await readEventWindow(runsDir, 'r-after', {});
    const total = fullWindow!.totalCount;
    expect(total).toBeGreaterThan(2);

    // Pick seq of the second-to-last event.
    const k = eventSeqFromId(fullWindow!.events[total - 2]!.eventId);
    const w = await readEventWindow(runsDir, 'r-after', { afterSeq: k });
    expect(w!.events.length).toBe(1);
    expect(w!.events[0]!.eventId).toBe(fullWindow!.events[total - 1]!.eventId);
    expect(w!.hasOlder).toBe(true);
    expect(w!.hasNewer).toBe(false);
  });

  it('afterSeq beyond last → empty slice, hasNewer=false', async () => {
    await seedSucceeded('r-after-end');
    const full = await readEventWindow(runsDir, 'r-after-end', {});
    const lastSeq = eventSeqFromId(full!.events[full!.events.length - 1]!.eventId);
    const w = await readEventWindow(runsDir, 'r-after-end', { afterSeq: lastSeq });
    expect(w!.events.length).toBe(0);
    expect(w!.hasNewer).toBe(false);
    expect(w!.hasOlder).toBe(true);
  });

  it('beforeSeq=K returns events with seq < K (ascending)', async () => {
    await seedSucceeded('r-before');
    const full = await readEventWindow(runsDir, 'r-before', {});
    // beforeSeq = 3 → seqs [1, 2]
    const w = await readEventWindow(runsDir, 'r-before', { beforeSeq: 3 });
    expect(w!.events.length).toBe(2);
    expect(eventSeqFromId(w!.events[0]!.eventId)).toBe(1);
    expect(eventSeqFromId(w!.events[1]!.eventId)).toBe(2);
    expect(w!.hasOlder).toBe(false);
    expect(w!.hasNewer).toBe(true);
    // Sanity: full has more than 2 events so we proved beforeSeq window was a slice.
    expect(full!.totalCount).toBeGreaterThan(2);
  });

  it('beforeSeq with limit clamps to limit', async () => {
    await seedSucceeded('r-before-lim');
    const full = await readEventWindow(runsDir, 'r-before-lim', {});
    const total = full!.totalCount;
    const w = await readEventWindow(runsDir, 'r-before-lim', {
      beforeSeq: total + 1,
      limit: 2,
    });
    expect(w!.events.length).toBe(2);
    expect(w!.hasOlder).toBe(total > 2);
    expect(w!.hasNewer).toBe(false);
  });

  it('empty event log returns zero counts', async () => {
    const dir = join(runsDir, 'r-empty');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events.ndjson'), '', 'utf-8');
    const w = await readEventWindow(runsDir, 'r-empty', {});
    expect(w).not.toBeNull();
    expect(w!.events).toEqual([]);
    expect(w!.totalCount).toBe(0);
    expect(w!.hasOlder).toBe(false);
    expect(w!.hasNewer).toBe(false);
  });

  it('events are returned in seq-ascending order', async () => {
    await seedSucceeded('r-order');
    const w = await readEventWindow(runsDir, 'r-order', { tail: 5 });
    const seqs = w!.events.map((e) => eventSeqFromId(e.eventId));
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(seqs).toEqual(sorted);
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

describe('eventSeqFromId', () => {
  it('extracts trailing seq', () => {
    expect(eventSeqFromId('run-abc-1')).toBe(1);
    expect(eventSeqFromId('foo-bar-42')).toBe(42);
  });
  it('returns 0 for malformed ids', () => {
    expect(eventSeqFromId('no-dash')).toBe(0);
    expect(eventSeqFromId('run-')).toBe(0);
    expect(eventSeqFromId('run-abc')).toBe(0);
  });
});

describe('extractEventContext', () => {
  it('pulls nodeId/activityId/errorCode from payload', () => {
    expect(
      extractEventContext({ nodeId: 'n1', activityId: 'a1', error: { errorCode: 'TimedOut' } }),
    ).toEqual({ nodeId: 'n1', activityId: 'a1', errorCode: 'TimedOut' });
  });
  it('failedNodeId promotes to nodeId', () => {
    expect(extractEventContext({ failedNodeId: 'n9' })).toEqual({ nodeId: 'n9' });
  });
  it('returns empty for ref-payloads / nullish', () => {
    expect(extractEventContext({ ref: 'b1', bytes: 10, schemaVersion: 1 })).toEqual({});
    expect(extractEventContext(null)).toEqual({});
    expect(extractEventContext(undefined)).toEqual({});
  });
});

// ─── readRunSnapshot — v0.2 loop projection (Step 4) ───────────────────────
//
// Loop blocks are projected into `RunSnapshotDTO.loops` as a JSON-safe
// record keyed by loopId.  The field is OPTIONAL (omitted for workflows
// that don't use loops) so older dashboards staying forward-compatible.

const LOOP_DEF = parseWorkflowDefinition({
  workflowId: 'proj-loop',
  version: 1,
  nodes: {
    implement: { type: 'subagent', bot: 'b', prompt: 'x' },
    reviewDecision: {
      type: 'decision',
      depends: ['implement'],
      humanGate: { stage: 'before', prompt: 'ok?' },
    },
    'review-loop': {
      type: 'loop',
      maxIterations: 2,
      body: ['implement', 'reviewDecision'],
      terminate: { node: 'reviewDecision', via: 'humanGate' },
      output: { from: 'implement' },
    },
  },
});

describe('readRunSnapshot — loop projection', () => {
  it('omits `loops` field for runs without any loop block', async () => {
    await seedSucceeded('r-no-loops');
    const snap = await readRunSnapshot(runsDir, 'r-no-loops');
    expect(snap).not.toBeNull();
    expect(snap!.loops).toBeUndefined();
  });

  it('includes `loops` record once a loop has started', async () => {
    const log = new EventLog('r-loop-running', runsDir);
    await createRun(log, {
      def: LOOP_DEF,
      params: {},
      initiator: 'test',
      botResolver: () => ({}),
    });
    const ctx = { log, def: LOOP_DEF, spawnSubagent: okSpawn };
    await runLoop(ctx);

    const snap = await readRunSnapshot(runsDir, 'r-loop-running');
    expect(snap).not.toBeNull();
    expect(snap!.loops).toBeDefined();
    const loop = snap!.loops!['review-loop'];
    expect(loop).toBeDefined();
    expect(loop.loopId).toBe('review-loop');
    expect(loop.status).toBe('running');
    expect(loop.iteration).toBe(1);
    expect(loop.maxIterations).toBe(2);
    expect(loop.iterations).toHaveLength(1);
    expect(loop.iterations[0]?.iteration).toBe(1);
    expect(loop.iterations[0]?.status).toBe('running');
  });

  it('iteration audit anchors survive the projection round-trip', async () => {
    const log = new EventLog('r-loop-anchors', runsDir);
    await createRun(log, {
      def: LOOP_DEF,
      params: {},
      initiator: 'test',
      botResolver: () => ({}),
    });
    const ctx = { log, def: LOOP_DEF, spawnSubagent: okSpawn };
    await runLoop(ctx);
    const decisionId = loopGateActivityId('r-loop-anchors', 'review-loop', 1, 'reviewDecision');
    // Need to read the current snapshot to grab the gate attempt id.
    let snap = await readRunSnapshot(runsDir, 'r-loop-anchors');
    const decAct = snap!.activities.find((a) => a.activityId === decisionId);
    await resolveWait(
      log,
      {
        activityId: decisionId,
        attemptId: decAct!.currentAttemptId!,
        resolution: 'rejected',
        by: 'ou_reviewer',
        comment: 'try again',
      },
      { def: LOOP_DEF },
    );
    await runLoop(ctx);

    snap = await readRunSnapshot(runsDir, 'r-loop-anchors');
    const loop = snap!.loops!['review-loop'];
    expect(loop.iteration).toBe(2);
    expect(loop.iterations).toHaveLength(2);
    const it1 = loop.iterations[0]!;
    expect(it1.status).toBe('rejected');
    expect(it1.decisionActivityId).toBe(decisionId);
    expect(it1.waitResolvedEventId).toMatch(/-\d+$/);
    expect(it1.decisionBy).toBe('ou_reviewer');
    expect(it1.decisionComment).toBe('try again');
  });

  it('terminal loop carries output projection ref + errorCode/errorClass', async () => {
    const log = new EventLog('r-loop-fail', runsDir);
    await createRun(log, {
      def: LOOP_DEF,
      params: {},
      initiator: 'test',
      botResolver: () => ({}),
    });
    const ctx = { log, def: LOOP_DEF, spawnSubagent: okSpawn };
    // Reject twice → max-iterations-exceeded.
    for (let iter = 1; iter <= 2; iter++) {
      await runLoop(ctx);
      const snap = await readRunSnapshot(runsDir, 'r-loop-fail');
      const decisionId = loopGateActivityId('r-loop-fail', 'review-loop', iter, 'reviewDecision');
      const decAct = snap!.activities.find((a) => a.activityId === decisionId);
      await resolveWait(
        log,
        {
          activityId: decisionId,
          attemptId: decAct!.currentAttemptId!,
          resolution: 'rejected',
          by: 'r',
        },
        { def: LOOP_DEF },
      );
    }
    await runLoop(ctx);

    const snap = await readRunSnapshot(runsDir, 'r-loop-fail');
    const loop = snap!.loops!['review-loop'];
    expect(loop.status).toBe('failed');
    expect(loop.errorCode).toBe('LoopMaxIterationsExceeded');
    expect(loop.errorClass).toBe('userFault');
  });
});
