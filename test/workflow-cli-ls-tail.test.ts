/**
 * O1 — `botmux workflow ls` / `tail` smoke tests via subprocess.
 *
 * These exercise the CLI end-to-end (parsing flags, printing tables,
 * incremental file watch).  We use `execFileSync` so the CLI integration
 * is the thing under test — replicating the runtime ctx wiring inline
 * would just test the unit, not the operator-facing surface.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { EventLog } from '../src/workflows/events/append.js';
import { createRun } from '../src/workflows/run-init.js';
import { parseWorkflowDefinition } from '../src/workflows/definition.js';
import { runLoop } from '../src/workflows/loop.js';
import type { WorkerSpawnFn } from '../src/workflows/runtime.js';

const CLI_PATH = join(__dirname, '..', 'dist', 'cli.js');

let runsDir: string;
let tempDir: string;
let oldCwd: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wf-ls-'));
  runsDir = join(tempDir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  oldCwd = process.cwd();
  process.chdir(tempDir);
});

afterEach(() => {
  process.chdir(oldCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      env: { ...process.env, BOTMUX_WORKFLOW_RUNS_DIR: runsDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    return {
      stdout: (err as { stdout?: string }).stdout ?? '',
      stderr: (err as { stderr?: string }).stderr ?? '',
      status: (err as { status?: number }).status ?? 1,
    };
  }
}

const HELLO_DEF = parseWorkflowDefinition({
  workflowId: 'ls-hello',
  version: 1,
  nodes: {
    only: { type: 'subagent', bot: 'b', prompt: 'hi' },
  },
});

const successSpawn: WorkerSpawnFn = async (input) => ({
  kind: 'success',
  output: { ok: true },
  session: {
    sessionId: `s-${input.activityId}`,
    botName: input.botName,
    startedAt: 1,
    endedAt: 2,
  },
});

async function seedActiveRun(runId: string): Promise<EventLog> {
  const log = new EventLog(runId, runsDir);
  await createRun(log, {
    def: HELLO_DEF,
    params: {},
    initiator: 'test',
    botResolver: () => ({}),
  });
  return log;
}

async function seedTerminalRun(runId: string): Promise<void> {
  const log = await seedActiveRun(runId);
  await runLoop({
    log,
    def: HELLO_DEF,
    spawnSubagent: successSpawn,
  });
}

// ─── ls ──────────────────────────────────────────────────────────────────

describe('botmux workflow ls', () => {
  it('returns an empty placeholder when no runs match', async () => {
    const out = runCli(['workflow', 'ls']);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('(no runs match)');
  });

  it('lists active runs by default and hides terminal ones', async () => {
    await seedActiveRun('run-active');
    await seedTerminalRun('run-done');

    const def = runCli(['workflow', 'ls']);
    expect(def.status).toBe(0);
    expect(def.stdout).toContain('run-active');
    expect(def.stdout).not.toContain('run-done');
    // Header columns present
    expect(def.stdout).toMatch(/RUN_ID\s+WORKFLOW\s+STATUS\s+LAST_SEQ\s+dEf\/dAct\/dWait\s+UPDATED/);
  });

  it('--all surfaces terminal runs too', async () => {
    await seedActiveRun('run-active');
    await seedTerminalRun('run-done');

    const out = runCli(['workflow', 'ls', '--all']);
    expect(out.stdout).toContain('run-active');
    expect(out.stdout).toContain('run-done');
  });

  it('--status filters by comma-separated set', async () => {
    await seedActiveRun('run-active');
    await seedTerminalRun('run-done');

    const onlyDone = runCli(['workflow', 'ls', '--status', 'succeeded']);
    expect(onlyDone.stdout).toContain('run-done');
    expect(onlyDone.stdout).not.toContain('run-active');

    const both = runCli(['workflow', 'ls', '--status', 'succeeded,running']);
    expect(both.stdout).toContain('run-active');
    expect(both.stdout).toContain('run-done');
  });

  it('--wide adds FAILED_NODE/CHAT_ID/LARK_APP columns', async () => {
    await seedActiveRun('run-active');
    const out = runCli(['workflow', 'ls', '--wide']);
    expect(out.stdout).toMatch(/FAILED_NODE\s+CHAT_ID\s+LARK_APP/);
  });

  it('--json emits one JSON object per line', async () => {
    await seedActiveRun('run-active');
    const out = runCli(['workflow', 'ls', '--json']);
    expect(out.status).toBe(0);
    const lines = out.stdout.trim().split('\n');
    expect(lines.length).toBe(1);
    const row = JSON.parse(lines[0]!);
    expect(row.runId).toBe('run-active');
    expect(row.workflowId).toBe('ls-hello');
    expect(row.status).toBe('running');
    expect(typeof row.lastSeq).toBe('number');
    expect(typeof row.updatedAt).toBe('number');
  });

  // Regression: replay's `waitsOpen` clears when the wait's activity
  // reaches any terminal (succeeded/failed/timedOut/cancelled).  ls
  // surfaces `snap.danglingWaits` raw — if replay ever stops clearing,
  // dWait over-counts on cancelled runs and operators see misleading
  // numbers.  Sister coverage lives in test/workflow-events-replay.test.ts.
  it('dWait does NOT count waits whose activity is already terminal (cancelled-run regression)', async () => {
    const log = await seedActiveRun('run-gate');
    const gateActivityId = 'run-gate::gate::approve';
    const gateAttemptId = `${gateActivityId}::att-1`;

    // Hand-roll the gate state: attemptCreated + waitCreated +
    // cancelRequested + activityCanceled.  This mirrors what
    // cmdWorkflowCancel produces on an awaiting humanGate run; we drive
    // it directly to keep the test independent of the cancel CLI.
    await log.append({
      runId: 'run-gate',
      type: 'attemptCreated',
      actor: 'scheduler',
      payload: {
        nodeId: 'approve',
        activityId: gateActivityId,
        attemptId: gateAttemptId,
        attemptNumber: 1,
        inputRef: {
          outputHash: 'sha256:' + 'a'.repeat(64),
          outputBytes: 2,
          outputSchemaVersion: 1,
        },
      },
    });
    await log.append({
      runId: 'run-gate',
      type: 'waitCreated',
      actor: 'scheduler',
      payload: {
        activityId: gateActivityId,
        nodeId: 'approve',
        waitKind: 'human-gate',
        prompt: 'ok?',
      },
    });
    const cancelEv = await log.append({
      runId: 'run-gate',
      type: 'cancelRequested',
      actor: 'human',
      payload: {
        target: { kind: 'run', runId: 'run-gate' },
        reason: 'test',
        by: 'test',
      },
    });
    await log.append({
      runId: 'run-gate',
      type: 'activityCanceled',
      actor: 'scheduler',
      payload: {
        activityId: gateActivityId,
        attemptId: gateAttemptId,
        cancelOriginEventId: cancelEv.eventId,
      },
    });

    // Workflow is `ls-hello` with a single subagent node; humanGate
    // isn't declared there.  We're injecting the gate activity directly
    // because the test only cares about replay's waitsOpen behavior.

    const out = runCli(['workflow', 'ls', '--all', '--json']);
    expect(out.status).toBe(0);
    const row = JSON.parse(out.stdout.trim().split('\n')[0]!);
    expect(row.dWait).toBe(0);
  });
});

// ─── tail ─────────────────────────────────────────────────────────────────

describe('botmux workflow tail', () => {
  it('prints history events from --from (default 1) and exits without --follow', async () => {
    await seedTerminalRun('run-tail');
    const out = runCli(['workflow', 'tail', 'run-tail']);
    expect(out.status).toBe(0);
    // Each line should match: <seq>  <type>  ...
    const lines = out.stdout.trim().split('\n');
    expect(lines.length).toBeGreaterThan(2);
    // First line is runCreated, includes seq 1
    expect(lines[0]!).toMatch(/^\s*1\s+runCreated/);
    // No process hang — execFileSync returning success means we exited.
  });

  it('--from skips events with smaller seq', async () => {
    await seedTerminalRun('run-tail');
    const out = runCli(['workflow', 'tail', 'run-tail', '--from', '3']);
    expect(out.status).toBe(0);
    const lines = out.stdout.trim().split('\n');
    // seq < 3 are gone; first line should have seq >= 3
    const firstSeq = Number(lines[0]!.trim().split(/\s+/)[0]);
    expect(firstSeq).toBeGreaterThanOrEqual(3);
  });

  it('--json emits raw event JSON per line', async () => {
    await seedTerminalRun('run-tail');
    const out = runCli(['workflow', 'tail', 'run-tail', '--json']);
    const lines = out.stdout.trim().split('\n');
    const first = JSON.parse(lines[0]!);
    expect(first.runId).toBe('run-tail');
    expect(first.eventId).toMatch(/^run-tail-\d+$/);
  });

  it('--follow streams events appended after history is printed', async () => {
    const log = await seedActiveRun('run-follow');
    const initialEvents = await log.readAll();
    const initialCount = initialEvents.length;

    // Spawn tail --follow as a child; capture stdout incrementally.
    const child = spawn('node', [CLI_PATH, 'workflow', 'tail', 'run-follow', '--follow'], {
      env: { ...process.env, BOTMUX_WORKFLOW_RUNS_DIR: runsDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf-8');
    });

    // Wait for the history dump (every initial event one line).
    let waited = 0;
    while (buf.split('\n').filter((l) => l.trim()).length < initialCount && waited < 4000) {
      await delay(100);
      waited += 100;
    }
    expect(buf.split('\n').filter((l) => l.trim()).length).toBeGreaterThanOrEqual(initialCount);

    // Append a fresh event — tail --follow must surface it within ~1s.
    await log.append({
      runId: 'run-follow',
      type: 'runFailed',
      actor: 'scheduler',
      payload: {
        failedNodeId: 'only',
        rootCauseEventId: initialEvents[0]!.eventId,
      },
    });

    waited = 0;
    while (!buf.includes('runFailed') && waited < 4000) {
      await delay(100);
      waited += 100;
    }
    expect(buf).toContain('runFailed');

    child.kill('SIGINT');
    await new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
    });
  }, 15000);
});
