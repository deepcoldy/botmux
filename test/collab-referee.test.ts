import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openCollabBoard } from '../src/collab/board.js';
import { runReferee, STALL_THRESHOLD } from '../src/collab/referee.js';
import type { CollabEventDraft } from '../src/collab/contract.js';

const RUN = 'run-ref-1';

function d(p: Partial<CollabEventDraft> & Pick<CollabEventDraft, 'type' | 'payload'>): CollabEventDraft {
  return { runId: RUN, actor: 'control-plane', affectedPaths: [], ...p } as CollabEventDraft;
}

async function seed(board: ReturnType<typeof openCollabBoard>, command: string) {
  await board.append(d({
    type: 'RunCreated', idempotencyKey: 'rc', topicId: 't1', affectedPaths: ['goal', 'budget', 'status'],
    payload: {
      goal: 'make it pass', budgetLimit: 100000, budgetUnit: 'tokens', controlTopicId: 't1',
      acceptanceCriteria: { command, doneWhen: 'exitZero', progressMetric: { name: 'failing', pattern: 'FAILING=(\\d+)' } },
    },
  }));
  await board.append(d({ type: 'TaskCreated', idempotencyKey: 'tc', taskId: 'task-1', affectedPaths: ['task'], payload: { taskId: 'task-1', title: 'fix', spec: 'do it' } }));
}

describe('referee', () => {
  let baseDir: string;
  let cwd: string;
  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'collab-ref-'));
    cwd = mkdtempSync(join(tmpdir(), 'collab-cwd-'));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('runs the command itself: fail→progress→pass closes the run with provenance', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    // a "test" command that reads a counter file and prints FAILING=<n>, exit nonzero unless 0
    const flag = join(cwd, 'failing.txt');
    const cmd = `n=$(cat ${flag} 2>/dev/null || echo 5); echo "FAILING=$n"; [ "$n" -eq 0 ]`;
    await seed(board, cmd);

    // each evaluation is preceded by a worker turn finishing (the causal trigger)
    let turn = 0;
    const workerTurn = () =>
      board.append(d({ type: 'WorkerTurnFinished', actor: 'worker', idempotencyKey: `wtf${turn++}`, affectedPaths: ['worker'], workerId: 'w1', payload: { workerId: 'w1', reason: 'yielded' } }));

    writeFileSync(flag, '5');
    let r = await runReferee(board, { cwd }); // first eval, gate is open
    expect(r.verdict).toBe('progressing'); // first measurement, baseline 5
    expect(r.metricValue).toBe(5);

    await workerTurn();
    writeFileSync(flag, '2');
    r = await runReferee(board, { cwd });
    expect(r.verdict).toBe('progressing'); // 2 < 5
    expect(r.metricValue).toBe(2);

    await workerTurn();
    writeFileSync(flag, '3');
    r = await runReferee(board, { cwd });
    expect(r.verdict).toBe('regressed'); // 3 > 2

    await workerTurn();
    writeFileSync(flag, '0');
    r = await runReferee(board, { cwd });
    expect(r.verdict).toBe('done'); // exit 0

    const snap = await board.snapshot();
    expect(snap.status).toBe('succeeded');
    expect(snap.task?.status).toBe('done');
    expect(snap.progressLog).toHaveLength(4);
    // the 'done' verdict carries real provenance: the command actually ran, exit 0
    const last = snap.progressLog[snap.progressLog.length - 1];
    expect(last.verdict).toBe('done');
  });

  it('self-gates: a heartbeat with no new work since the last verdict is a no-op', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    const flag = join(cwd, 'failing.txt');
    const cmd = `n=$(cat ${flag} 2>/dev/null || echo 5); echo "FAILING=$n"; [ "$n" -eq 0 ]`;
    await seed(board, cmd);
    writeFileSync(flag, '3');

    const r1 = await runReferee(board, { cwd });
    expect(r1.verdict).toBe('progressing');
    // no new WorkerTurnFinished / ArtifactRecorded / Goal change → nothing to judge
    const r2 = await runReferee(board, { cwd });
    expect(r2.verdict).toBe('no-op');
    expect((await board.snapshot()).progressLog).toHaveLength(1); // only one verdict recorded
  });

  it('criteria swap re-arms the gate and the referee judges by the NEW command', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    const flag = join(cwd, 'failing.txt');
    const cmdV1 = `n=$(cat ${flag} 2>/dev/null || echo 5); echo "FAILING=$n"; [ "$n" -eq 0 ]`;
    await seed(board, cmdV1);
    writeFileSync(flag, '2');

    const r1 = await runReferee(board, { cwd });
    expect(r1.verdict).toBe('progressing'); // v1 command: 2 failing, gate now closed

    // /criteria control verb lands: swap the acceptance command mid-run.
    // No WorkerTurnFinished/Artifact in between — the swap ALONE must re-arm.
    const cmdV2 = `echo "ok v2"; true`;
    await board.append(d({
      type: 'AcceptanceCriteriaChanged', actor: 'human', idempotencyKey: 'acc1',
      affectedPaths: ['acceptanceCriteria'],
      payload: { acceptanceCriteria: { command: cmdV2, doneWhen: 'exitZero' } },
    }));
    expect((await board.snapshot()).acceptanceCriteria?.command).toBe(cmdV2);

    const r2 = await runReferee(board, { cwd });
    expect(r2.verdict).toBe('done'); // judged by v2 (v1 would still fail: flag=2)
    expect(r2.exitCode).toBe(0);
    const snap = await board.snapshot();
    expect(snap.status).toBe('succeeded');
    // provenance proves the NEW command is what actually ran
    expect(snap.progressLog[snap.progressLog.length - 1].verdict).toBe('done');
  });

  it('binary criteria: consecutive failures escalate to a stall at the threshold edge, done clears it', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    // binary acceptance (no progressMetric): pass ⇔ ok.txt exists
    const flag = join(cwd, 'ok.txt');
    await board.append(d({
      type: 'RunCreated', idempotencyKey: 'rc', topicId: 't1', affectedPaths: ['goal', 'budget', 'status'],
      payload: {
        goal: 'make it pass', budgetLimit: 100000, budgetUnit: 'tokens', controlTopicId: 't1',
        acceptanceCriteria: { command: `test -f ${flag}`, doneWhen: 'exitZero' },
      },
    }));
    await board.append(d({ type: 'TaskCreated', idempotencyKey: 'tc', taskId: 'task-1', affectedPaths: ['task'], payload: { taskId: 'task-1', title: 'fix', spec: 'do it' } }));
    expect((await board.snapshot()).controlTopicId).toBe('t1');

    let turn = 0;
    const workerTurn = () =>
      board.append(d({ type: 'WorkerTurnFinished', actor: 'worker', idempotencyKey: `wtf${turn++}`, affectedPaths: ['worker'], workerId: 'w1', payload: { workerId: 'w1', reason: 'yielded' } }));

    // failing binary eval = direction unknown, streak counts from 1
    let r = await runReferee(board, { cwd });
    expect(r.verdict).toBe('stuck');
    expect(r.stalled).toBe(false);
    let snap = await board.snapshot();
    expect(snap.progressLog.at(-1)).toMatchObject({ direction: 'unknown', streak: 1 });
    expect(snap.stall).toBeNull();

    await workerTurn();
    r = await runReferee(board, { cwd });
    expect(r.stalled).toBe(false); // streak 2, below threshold

    await workerTurn();
    r = await runReferee(board, { cwd }); // streak 3 = the edge
    expect(r.stalled).toBe(true);
    snap = await board.snapshot();
    expect(snap.stall).toMatchObject({ streak: STALL_THRESHOLD, threshold: STALL_THRESHOLD });
    const raises = (await board.history()).filter((e) => e.type === 'ProgressStallRaised');
    expect(raises).toHaveLength(1);

    await workerTurn();
    r = await runReferee(board, { cwd }); // streak 4: stall persists, no new edge
    expect(r.stalled).toBe(false);
    snap = await board.snapshot();
    expect(snap.stall).toMatchObject({ streak: STALL_THRESHOLD });
    expect(snap.progressLog.at(-1)).toMatchObject({ direction: 'unknown', streak: 4 });

    // completion resolves the stall
    await workerTurn();
    writeFileSync(flag, '');
    r = await runReferee(board, { cwd });
    expect(r.verdict).toBe('done');
    snap = await board.snapshot();
    expect(snap.status).toBe('succeeded');
    expect(snap.stall).toBeNull();
    expect(snap.progressLog.at(-1)).toMatchObject({ direction: 'improved', streak: 0 });
  });

  it('metric improvement clears the stall and a fresh stall after recovery re-raises', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    const flag = join(cwd, 'failing.txt');
    const cmd = `n=$(cat ${flag} 2>/dev/null || echo 5); echo "FAILING=$n"; [ "$n" -eq 0 ]`;
    await seed(board, cmd);

    let turn = 0;
    const workerTurn = () =>
      board.append(d({ type: 'WorkerTurnFinished', actor: 'worker', idempotencyKey: `wtf${turn++}`, affectedPaths: ['worker'], workerId: 'w1', payload: { workerId: 'w1', reason: 'yielded' } }));
    const evalOnce = async () => { await workerTurn(); return runReferee(board, { cwd }); };

    // first measurement = baseline = improved, streak 0
    writeFileSync(flag, '5');
    let r = await runReferee(board, { cwd });
    expect((await board.snapshot()).progressLog.at(-1)).toMatchObject({ direction: 'improved', streak: 0 });

    // three flat evals → stall raised
    for (let i = 0; i < STALL_THRESHOLD; i++) r = await evalOnce();
    expect(r.stalled).toBe(true);
    expect((await board.snapshot()).stall).not.toBeNull();

    // improvement clears stall and resets streak
    writeFileSync(flag, '2');
    r = await evalOnce();
    expect(r.verdict).toBe('progressing');
    let snap = await board.snapshot();
    expect(snap.stall).toBeNull();
    expect(snap.progressLog.at(-1)).toMatchObject({ direction: 'improved', streak: 0 });

    // a NEW stall after recovery raises again (distinct event, not deduped)
    for (let i = 0; i < STALL_THRESHOLD; i++) r = await evalOnce();
    expect(r.stalled).toBe(true);
    const raises = (await board.history()).filter((e) => e.type === 'ProgressStallRaised');
    expect(raises).toHaveLength(2);
  });

  it('pre-P2 RefereeEvaluated events (no completion/progress) replay fine and streak restarts', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    const flag = join(cwd, 'ok.txt');
    await board.append(d({
      type: 'RunCreated', idempotencyKey: 'rc', topicId: 't1', affectedPaths: ['goal', 'budget', 'status'],
      payload: {
        goal: 'g', budgetLimit: 100000, budgetUnit: 'tokens', controlTopicId: 't1',
        acceptanceCriteria: { command: `test -f ${flag}`, doneWhen: 'exitZero' },
      },
    }));
    await board.append(d({ type: 'TaskCreated', idempotencyKey: 'tc', taskId: 'task-1', affectedPaths: ['task'], payload: { taskId: 'task-1', title: 't', spec: 's' } }));
    // an old-shape verdict, as a pre-P2 daemon would have written it
    await board.append(d({
      type: 'RefereeEvaluated', actor: 'referee', idempotencyKey: 'old1', affectedPaths: ['progressLog'], taskId: 'task-1',
      payload: { taskId: 'task-1', verdict: 'stuck', provenance: { command: 'x', exitCode: 1 } },
    }));
    const snap = await board.snapshot();
    expect(snap.progressLog).toHaveLength(1);
    expect(snap.progressLog[0].direction).toBeUndefined();
    expect(snap.stall).toBeNull();

    // next (new-code) eval treats the unknown prior streak as 0 → restarts at 1
    await board.append(d({ type: 'WorkerTurnFinished', actor: 'worker', idempotencyKey: 'wtf-old', affectedPaths: ['worker'], workerId: 'w1', payload: { workerId: 'w1', reason: 'yielded' } }));
    const r = await runReferee(board, { cwd });
    expect(r.verdict).toBe('stuck');
    expect((await board.snapshot()).progressLog.at(-1)).toMatchObject({ direction: 'unknown', streak: 1 });
  });

  it('budget exhausted outranks evaluation and stops the run', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    await board.append(d({ type: 'RunCreated', idempotencyKey: 'rc', topicId: 't1', affectedPaths: ['budget'], payload: { goal: 'g', budgetLimit: 100, budgetUnit: 'tokens', controlTopicId: 't1', acceptanceCriteria: { command: 'true', doneWhen: 'exitZero' } } }));
    await board.append(d({ type: 'TaskCreated', idempotencyKey: 'tc', taskId: 'task-1', affectedPaths: ['task'], payload: { taskId: 'task-1', title: 't', spec: 's' } }));
    await board.append(d({ type: 'BudgetExhausted', actor: 'system', idempotencyKey: 'be', budgetDelta: -100, affectedPaths: ['budget'], payload: { limit: 100, spent: 100 } }));

    const r = await runReferee(board, { cwd });
    expect(r.verdict).toBe('budget-exhausted');
    expect((await board.snapshot()).status).toBe('failed'); // budget-exhausted maps to failed
  });
});
