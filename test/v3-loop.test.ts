/**
 * v3 structured loop — first cut (single-level, serial iterations, fresh
 * sessions).  See docs/design/2026-06-06-v3-structured-loop-design.md.
 *
 * Covers:
 *   - dag.ts: loop node shape + validateDag cross-checks (body DAG, exit.when
 *     vs resultSchema, feedback refs, output projection, expansion-namespace
 *     prefix guard)
 *   - journal/state: loop events folding (iteration lifecycle, decisions,
 *     grants) — added with task #18
 *   - orchestrator/runtime: expansion scheduling + exit evaluation — task #19
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  validateDag,
  loopInstanceId,
  isLoopNode,
  DagValidationError,
  MAX_LOOP_ITERATIONS,
  type V3LoopNode,
} from '../src/workflows/v3/dag.js';
import { decideNext, type V3LoopState, type V3RunState } from '../src/workflows/v3/orchestrator.js';
import { appendEvent, readJournal, type StoredEvent, type V3Event } from '../src/workflows/v3/journal.js';
import { materialize } from '../src/workflows/v3/state.js';
import { runWorkflow, matchLoopExitWhen, type V3RuntimeDeps } from '../src/workflows/v3/runtime.js';
import {
  requestV3Retry,
  requestV3LoopGrant,
  loopExhaustedInfoFor,
  reconcileV3PendingGates,
} from '../src/workflows/v3/daemon-run.js';
import { birthRun } from '../src/workflows/v3/grill-state.js';
import { projectRun } from '../src/workflows/v3/ops-projection.js';
import { readAndValidateManifest, ManifestValidationError } from '../src/workflows/v3/manifest.js';
import {
  GOAL_ENV,
  type BotSnapshot,
  type GoalInputs,
  type Manifest,
  type RunNode,
  type ValidateManifest,
} from '../src/workflows/v3/contract.js';

// ─── Fixtures ────────────────────────────────────────────────────────────

/** A canonical valid loop dag: prepare → fix(loop: code → test) → report. */
function loopDagRaw(): any {
  return {
    runId: 'run-loop',
    nodes: [
      { id: 'prepare', type: 'goal', goal: 'prepare the workspace' },
      {
        id: 'fix',
        type: 'loop',
        depends: ['prepare'],
        inputs: [{ from: 'prepare' }],
        maxIterations: 3,
        body: {
          nodes: [
            { id: 'code', type: 'goal', goal: 'fix the bug using previous test feedback' },
            {
              id: 'test',
              type: 'goal',
              goal: 'run the regression tests, write result.json',
              depends: ['code'],
              inputs: [{ from: 'code' }],
              resultSchema: {
                type: 'object',
                properties: { passed: { type: 'boolean' }, summary: { type: 'string' } },
                required: ['passed'],
              },
            },
          ],
        },
        exit: { node: 'test', when: { path: 'result.passed', equals: true } },
        feedback: ['test.result', 'test.files'],
        output: { from: 'code' },
      },
      { id: 'report', type: 'goal', goal: 'write the final report', depends: ['fix'], inputs: [{ from: 'fix' }] },
    ],
  };
}

function problemsOf(raw: unknown): string[] {
  try {
    validateDag(raw);
    return [];
  } catch (err) {
    if (err instanceof DagValidationError) return err.problems;
    throw err;
  }
}

// ─── dag.ts: shape + validation ──────────────────────────────────────────

describe('validateDag loop nodes', () => {
  it('accepts a valid loop dag and normalizes it', () => {
    const dag = validateDag(loopDagRaw());
    const loop = dag.nodes.find((n) => n.id === 'fix')!;
    expect(isLoopNode(loop)).toBe(true);
    const l = loop as V3LoopNode;
    expect(l.maxIterations).toBe(3);
    expect(l.body.nodes.map((b) => b.id)).toEqual(['code', 'test']);
    expect(l.exit).toEqual({ node: 'test', when: { path: 'result.passed', equals: true } });
    expect(l.feedback).toEqual(['test.result', 'test.files']);
    expect(l.output).toEqual({ from: 'code' });
    expect(l.onExhausted).toBe('blocked');
    expect(l.sessionPolicy).toBe('fresh');
  });

  it('defaults output to the exit node and feedback to []', () => {
    const raw = loopDagRaw();
    delete raw.nodes[1].output;
    delete raw.nodes[1].feedback;
    const dag = validateDag(raw);
    const l = dag.nodes.find((n) => n.id === 'fix') as V3LoopNode;
    expect(l.output).toEqual({ from: 'test' });
    expect(l.feedback).toEqual([]);
  });

  it('requires maxIterations as a positive integer within the ceiling', () => {
    for (const bad of [undefined, 0, -1, 1.5, MAX_LOOP_ITERATIONS + 1]) {
      const raw = loopDagRaw();
      raw.nodes[1].maxIterations = bad;
      expect(problemsOf(raw).some((p) => p.includes('maxIterations'))).toBe(true);
    }
  });

  it('rejects nesting, host bodies, and gates inside the body', () => {
    const nested = loopDagRaw();
    nested.nodes[1].body.nodes[0] = { ...nested.nodes[1].body.nodes[0], type: 'loop' };
    expect(problemsOf(nested).some((p) => p.includes('only "goal" nodes are allowed'))).toBe(true);

    const gated = loopDagRaw();
    gated.nodes[1].body.nodes[0].humanGate = { prompt: 'ok?' };
    expect(problemsOf(gated).some((p) => p.includes('humanGate is not supported inside a loop body'))).toBe(true);
  });

  it('rejects loop-level timeoutSec / resultSchema / humanGate', () => {
    const raw = loopDagRaw();
    raw.nodes[1].timeoutSec = 600;
    raw.nodes[1].resultSchema = { type: 'object', properties: { x: { type: 'string' } } };
    raw.nodes[1].humanGate = { prompt: 'ok?' };
    const probs = problemsOf(raw);
    expect(probs.some((p) => p.includes('timeoutSec is not supported'))).toBe(true);
    expect(probs.some((p) => p.includes('resultSchema is not supported'))).toBe(true);
    expect(probs.some((p) => p.includes('humanGate is not supported'))).toBe(true);
  });

  it('rejects a cyclic body and unknown body refs', () => {
    const cyc = loopDagRaw();
    cyc.nodes[1].body.nodes[0].depends = ['test'];
    expect(problemsOf(cyc).some((p) => p.includes('cycle'))).toBe(true);

    const unk = loopDagRaw();
    unk.nodes[1].body.nodes[1].depends = ['code', 'ghost'];
    expect(problemsOf(unk).some((p) => p.includes('unknown body node "ghost"'))).toBe(true);
  });

  it('cross-checks exit.when against the exit node resultSchema', () => {
    // path must be result.<key>
    const badPath = loopDagRaw();
    badPath.nodes[1].exit.when = { path: 'passed', equals: true };
    expect(problemsOf(badPath).some((p) => p.includes('result.<key>'))).toBe(true);

    // key must be declared
    const undeclared = loopDagRaw();
    undeclared.nodes[1].exit.when = { path: 'result.ghost', equals: true };
    expect(problemsOf(undeclared).some((p) => p.includes('not declared'))).toBe(true);

    // key must be required
    const notRequired = loopDagRaw();
    notRequired.nodes[1].exit.when = { path: 'result.summary', equals: 'ok' };
    expect(problemsOf(notRequired).some((p) => p.includes('required'))).toBe(true);

    // exactly one operator
    const twoOps = loopDagRaw();
    twoOps.nodes[1].exit.when = { path: 'result.passed', equals: true, notEquals: false };
    expect(problemsOf(twoOps).some((p) => p.includes('exactly ONE operator'))).toBe(true);
    const zeroOps = loopDagRaw();
    zeroOps.nodes[1].exit.when = { path: 'result.passed' };
    expect(problemsOf(zeroOps).some((p) => p.includes('exactly ONE operator'))).toBe(true);

    // operator/type compatibility
    const gtOnBool = loopDagRaw();
    gtOnBool.nodes[1].exit.when = { path: 'result.passed', gt: 1 };
    expect(problemsOf(gtOnBool).some((p) => p.includes('requires "passed" to be a number'))).toBe(true);
    const typeMismatch = loopDagRaw();
    typeMismatch.nodes[1].exit.when = { path: 'result.passed', equals: 'yes' };
    expect(problemsOf(typeMismatch).some((p) => p.includes('must be a boolean'))).toBe(true);

    // numeric comparisons allowed on number fields
    const numeric = loopDagRaw();
    numeric.nodes[1].body.nodes[1].resultSchema = {
      type: 'object',
      properties: { score: { type: 'number' } },
      required: ['score'],
    };
    numeric.nodes[1].exit.when = { path: 'result.score', gte: 90 };
    numeric.nodes[1].feedback = []; // test.result feedback ok, keep minimal
    expect(problemsOf(numeric)).toEqual([]);

    // exit node must have a resultSchema at all
    const schemaless = loopDagRaw();
    delete schemaless.nodes[1].body.nodes[1].resultSchema;
    expect(problemsOf(schemaless).some((p) => p.includes('must declare a resultSchema'))).toBe(true);
  });

  it('validates feedback refs', () => {
    const badRef = loopDagRaw();
    badRef.nodes[1].feedback = ['ghost.result'];
    expect(problemsOf(badRef).some((p) => p.includes('feedback "ghost.result"'))).toBe(true);

    const resultOnSchemaless = loopDagRaw();
    resultOnSchemaless.nodes[1].feedback = ['code.result'];
    expect(problemsOf(resultOnSchemaless).some((p) => p.includes('requires body node "code" to declare a resultSchema'))).toBe(true);

    const filesOnSchemaless = loopDagRaw();
    filesOnSchemaless.nodes[1].feedback = ['code.files'];
    expect(problemsOf(filesOnSchemaless)).toEqual([]); // .files needs no schema
  });

  it('rejects output.from outside the body', () => {
    const raw = loopDagRaw();
    raw.nodes[1].output = { from: 'prepare' };
    expect(problemsOf(raw).some((p) => p.includes('output must be { from: <bodyId> }'))).toBe(true);
  });

  it('guards the expansion namespace prefix', () => {
    const raw = loopDagRaw();
    raw.nodes.push({ id: 'fix.i001.code', type: 'goal', goal: 'imposter' });
    expect(problemsOf(raw).some((p) => p.includes('expansion namespace'))).toBe(true);

    // Unrelated dotted ids stay legal.
    const dotted = loopDagRaw();
    dotted.nodes.push({ id: 'fixup.v2', type: 'goal', goal: 'fine' });
    expect(problemsOf(dotted)).toEqual([]);
  });

  it('keeps the loop node a normal vertex in the outer topology', () => {
    // Outer cycle through the loop node is still a cycle.
    const raw = loopDagRaw();
    raw.nodes[0].depends = ['report'];
    expect(problemsOf(raw).some((p) => p.includes('cycle'))).toBe(true);
  });

  it('loopInstanceId is zero-padded and dot-joined', () => {
    expect(loopInstanceId('fix', 1, 'code')).toBe('fix.i001.code');
    expect(loopInstanceId('fix', 12, 'test')).toBe('fix.i012.test');
  });
});

// ─── matchLoopExitWhen ───────────────────────────────────────────────────

describe('matchLoopExitWhen', () => {
  it('covers every operator', () => {
    expect(matchLoopExitWhen({ path: 'result.passed', equals: true }, true)).toBe(true);
    expect(matchLoopExitWhen({ path: 'result.passed', equals: true }, false)).toBe(false);
    expect(matchLoopExitWhen({ path: 'result.state', notEquals: 'failing' }, 'green')).toBe(true);
    expect(matchLoopExitWhen({ path: 'result.score', gte: 90 }, 90)).toBe(true);
    expect(matchLoopExitWhen({ path: 'result.score', gt: 90 }, 90)).toBe(false);
    expect(matchLoopExitWhen({ path: 'result.score', lt: 5 }, 4)).toBe(true);
    expect(matchLoopExitWhen({ path: 'result.score', lte: 5 }, 6)).toBe(false);
    // tampered type → not matching (safe: continue/exhaust, never false-exit)
    expect(matchLoopExitWhen({ path: 'result.score', gte: 90 }, 'high' as unknown)).toBe(false);
  });
});

// ─── state: loop event folding ───────────────────────────────────────────

function ev(e: V3Event): StoredEvent {
  return { ts: 0, ...e };
}

describe('materialize loop events', () => {
  it('folds the iteration lifecycle', () => {
    const snap = materialize([
      ev({ type: 'runStarted', runId: 'r' }),
      ev({ type: 'loopStarted', loopId: 'fix' }),
    ]);
    expect(snap.nodes.get('fix')?.status).toBe('running');
    expect(snap.loops.get('fix')).toMatchObject({ iteration: 0, decided: false, granted: 0 });

    const snap2 = materialize([
      ev({ type: 'loopStarted', loopId: 'fix' }),
      ev({ type: 'loopIterationStarted', loopId: 'fix', iteration: 1 }),
      ev({ type: 'loopIterationDecision', loopId: 'fix', iteration: 1, decision: 'continue' }),
    ]);
    expect(snap2.loops.get('fix')).toMatchObject({ iteration: 1, decided: true, lastDecision: 'continue' });

    const snap3 = materialize([
      ev({ type: 'loopStarted', loopId: 'fix' }),
      ev({ type: 'loopIterationStarted', loopId: 'fix', iteration: 1 }),
      ev({ type: 'loopIterationDecision', loopId: 'fix', iteration: 1, decision: 'continue' }),
      ev({ type: 'loopIterationStarted', loopId: 'fix', iteration: 2 }),
    ]);
    expect(snap3.loops.get('fix')).toMatchObject({ iteration: 2, decided: false });
  });

  it('exhausted blocks the loop node; a grant re-opens it (replay-correct)', () => {
    const base: StoredEvent[] = [
      ev({ type: 'loopStarted', loopId: 'fix' }),
      ev({ type: 'loopIterationStarted', loopId: 'fix', iteration: 1 }),
      ev({ type: 'loopIterationDecision', loopId: 'fix', iteration: 1, decision: 'exhausted' }),
      ev({ type: 'runBlocked', blockedNodeId: 'fix' }),
    ];
    const blocked = materialize(base);
    expect(blocked.runStatus).toBe('blocked');
    expect(blocked.blockedNodeId).toBe('fix');
    expect(blocked.nodes.get('fix')?.status).toBe('blocked');

    const granted = materialize([...base, ev({ type: 'loopIterationGranted', loopId: 'fix', fromIteration: 1 })]);
    expect(granted.runStatus).toBe('running');
    expect(granted.blockedNodeId).toBeUndefined();
    expect(granted.nodes.get('fix')?.status).toBe('running');
    expect(granted.loops.get('fix')).toMatchObject({ granted: 1, pendingGrant: true, lastDecision: 'exhausted' });

    // The next iterationStarted consumes the grant.
    const consumed = materialize([
      ...base,
      ev({ type: 'loopIterationGranted', loopId: 'fix', fromIteration: 1 }),
      ev({ type: 'loopIterationStarted', loopId: 'fix', iteration: 2 }),
    ]);
    expect(consumed.loops.get('fix')).toMatchObject({ iteration: 2, decided: false, granted: 1, pendingGrant: false });
  });
});

// ─── orchestrator: loop scheduling ───────────────────────────────────────

describe('decideNext loop scheduling', () => {
  const dag = validateDag(loopDagRaw());
  const ls = (over: Partial<V3LoopState>): Map<string, V3LoopState> =>
    new Map([['fix', { iteration: 0, decided: false, granted: 0, pendingGrant: false, ...over }]]);
  const st = (entries: Record<string, string>): V3RunState =>
    new Map(Object.entries(entries).map(([k, v]) => [k, { status: v as never }]));

  it('gates startLoop on outer deps', () => {
    expect(decideNext(dag, st({}))).toEqual([{ kind: 'dispatchWork', nodeId: 'prepare', instanceId: 'prepare#001' }]);
    const actions = decideNext(dag, st({ prepare: 'done' }));
    expect(actions).toEqual([{ kind: 'startLoop', loopId: 'fix' }]);
  });

  it('walks iteration 0 → body dispatch → evaluate', () => {
    expect(decideNext(dag, st({ prepare: 'done', fix: 'running' }), ls({})))
      .toEqual([{ kind: 'startLoopIteration', loopId: 'fix', iteration: 1 }]);

    const i1 = ls({ iteration: 1 });
    expect(decideNext(dag, st({ prepare: 'done', fix: 'running' }), i1)).toEqual([
      { kind: 'dispatchWork', nodeId: 'fix.i001.code', loop: { loopId: 'fix', iteration: 1, bodyNodeId: 'code' } },
    ]);
    expect(decideNext(dag, st({ prepare: 'done', fix: 'running', 'fix.i001.code': 'done' }), i1)).toEqual([
      { kind: 'dispatchWork', nodeId: 'fix.i001.test', loop: { loopId: 'fix', iteration: 1, bodyNodeId: 'test' } },
    ]);
    expect(
      decideNext(dag, st({ prepare: 'done', fix: 'running', 'fix.i001.code': 'done', 'fix.i001.test': 'done' }), i1),
    ).toEqual([{ kind: 'evaluateLoopIteration', loopId: 'fix', iteration: 1 }]);
  });

  it('routes decisions: continue → next iteration, exit → completeLoop', () => {
    expect(
      decideNext(dag, st({ prepare: 'done', fix: 'running' }), ls({ iteration: 1, decided: true, lastDecision: 'continue' })),
    ).toEqual([{ kind: 'startLoopIteration', loopId: 'fix', iteration: 2 }]);
    expect(
      decideNext(dag, st({ prepare: 'done', fix: 'running' }), ls({ iteration: 2, decided: true, lastDecision: 'exit' })),
    ).toEqual([{ kind: 'completeLoop', loopId: 'fix', iteration: 2 }]);
  });

  it('exhausted blocks; a pending grant re-opens one round', () => {
    expect(
      decideNext(dag, st({ prepare: 'done', fix: 'blocked' }), ls({ iteration: 3, decided: true, lastDecision: 'exhausted' })),
    ).toEqual([{ kind: 'completeRunBlocked', blockedNodeId: 'fix' }]);
    expect(
      decideNext(
        dag,
        st({ prepare: 'done', fix: 'running' }),
        ls({ iteration: 3, decided: true, lastDecision: 'exhausted', granted: 1, pendingGrant: true }),
      ),
    ).toEqual([{ kind: 'startLoopIteration', loopId: 'fix', iteration: 4 }]);
  });

  it('sweeps failed/blocked body instances of the current iteration', () => {
    expect(
      decideNext(dag, st({ prepare: 'done', fix: 'running', 'fix.i001.code': 'failed' }), ls({ iteration: 1 })),
    ).toEqual([{ kind: 'completeRunFailed', failedNodeId: 'fix.i001.code' }]);
    expect(
      decideNext(dag, st({ prepare: 'done', fix: 'running', 'fix.i001.code': 'done', 'fix.i001.test': 'blocked' }), ls({ iteration: 1 })),
    ).toEqual([{ kind: 'completeRunBlocked', blockedNodeId: 'fix.i001.test' }]);
  });

  it('a sealed loop (nodeSucceeded on the loop id) unblocks downstream', () => {
    const actions = decideNext(
      dag,
      st({ prepare: 'done', fix: 'done' }),
      ls({ iteration: 2, decided: true, lastDecision: 'exit' }),
    );
    expect(actions).toEqual([{ kind: 'dispatchWork', nodeId: 'report', instanceId: 'report#001' }]);
  });
});

// ─── runtime: end-to-end loop runs (stub workers, real manifest validator) ──

const validateManifest: ValidateManifest = async (manifestPath, outputDir) => {
  try {
    const manifest = await readAndValidateManifest(manifestPath, outputDir);
    return { ok: true, manifest };
  } catch (e) {
    return { ok: false, problems: e instanceof ManifestValidationError ? e.problems : [String(e)] };
  }
};

const resolveBotSnapshot = (): BotSnapshot => ({
  larkAppId: 'cli_test',
  cliId: 'claude-code',
  workingDir: '/tmp',
});

function fileEntry(outputDir: string, name: string, content: string, kind: 'markdown' | 'json'): Manifest['files'][number] {
  writeFileSync(join(outputDir, name), content);
  return {
    name,
    path: name,
    kind,
    bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
    mime: kind === 'json' ? 'application/json' : 'text/markdown',
  };
}

function okResult(req: Parameters<RunNode>[0], files: Manifest['files']): { status: 'ok'; manifestPath: string } {
  const manifestPath = req.env[GOAL_ENV.MANIFEST_PATH]!;
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, status: 'ok', summary: `done ${req.node.id}`, files }));
  return { status: 'ok', manifestPath };
}

function readInputs(req: Parameters<RunNode>[0]): GoalInputs {
  return JSON.parse(readFileSync(req.inputsPath, 'utf-8')) as GoalInputs;
}

describe('runWorkflow loop integration', () => {
  it('repairs until passed: 2 iterations, feedback threads through, output projects code', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-loop-ok-'));
    try {
      const feedbackSeen: Record<string, string[]> = {};
      let reportInputs: string[] = [];
      const runNode: RunNode = async (req) => {
        const id = req.node.id;
        if (id === 'prepare') return okResult(req, [fileEntry(req.outputDir, 'prep.md', 'PREP', 'markdown')]);
        if (id === 'report') {
          reportInputs = readInputs(req).inputs
            .filter((i) => i.from === 'fix')
            .map((i) => readFileSync(i.path, 'utf-8'));
          return okResult(req, [fileEntry(req.outputDir, 'report.md', 'REPORT', 'markdown')]);
        }
        // body instances — branch on the structured suffix we control in tests
        const iter = id.includes('.i001.') ? 1 : 2;
        if (id.endsWith('.code')) {
          feedbackSeen[id] = readInputs(req).inputs.filter((i) => i.from === 'previous.test').map((i) => i.name);
          return okResult(req, [fileEntry(req.outputDir, 'fix.md', `FIX-ITER-${iter}`, 'markdown')]);
        }
        // test instance: iteration 1 fails, iteration 2 passes
        const passed = iter >= 2;
        return okResult(req, [
          fileEntry(req.outputDir, 'result.json', JSON.stringify({ passed, summary: `iter ${iter}` }), 'json'),
          fileEntry(req.outputDir, 'test-report.md', `TEST-REPORT-${iter}`, 'markdown'),
        ]);
      };

      const deps: V3RuntimeDeps = { runNode, validateManifest, resolveBotSnapshot };
      const outcome = await runWorkflow(validateDag(loopDagRaw()), deps, { baseDir: base });
      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      if (outcome.reason !== 'terminal') throw new Error('unreachable');

      const events = readJournal(join(outcome.runDir, 'journal.ndjson'));
      // Loop lifecycle in order.
      const loopEvents = events
        .filter((e) => e.type.startsWith('loop'))
        .map((e) => `${e.type}:${(e as { iteration?: number }).iteration ?? ''}${(e as { decision?: string }).decision ?? ''}`);
      expect(loopEvents).toEqual([
        'loopStarted:',
        'loopIterationStarted:1',
        'loopIterationDecision:1continue',
        'loopIterationStarted:2',
        'loopIterationDecision:2exit',
      ]);
      // Dispatches carry the structured loop ref (id stays opaque).
      const dispatched = events.find(
        (e) => e.type === 'nodeDispatched' && e.nodeId === 'fix.i001.code',
      ) as StoredEvent & { type: 'nodeDispatched' };
      expect(dispatched.loop).toEqual({ loopId: 'fix', iteration: 1, bodyNodeId: 'code' });
      // The loop is sealed by a nodeSucceeded on the LOOP id with the OUTPUT
      // node's manifest (code, not test).
      const seal = events.find(
        (e) => e.type === 'nodeSucceeded' && e.nodeId === 'fix',
      ) as StoredEvent & { type: 'nodeSucceeded' };
      expect(seal.manifestPath).toContain('fix.i002.code');
      // Iteration-2 code received previous.test feedback (result + files,
      // deduped), iteration-1 code received none.
      expect(feedbackSeen[loopInstanceId('fix', 1, 'code')]).toEqual([]);
      expect(feedbackSeen[loopInstanceId('fix', 2, 'code')].sort()).toEqual(['result.json', 'test-report.md']);
      // Downstream report read the FINAL code product through from:'fix'.
      expect(reportInputs).toEqual(['FIX-ITER-2']);
      // Instance goal.txt carries the loop context section.
      const goal2 = readFileSync(join(outcome.runDir, 'fix.i002.code', 'attempts', '001', 'goal.txt'), 'utf-8');
      expect(goal2).toContain('## Loop context');
      expect(goal2).toContain('iteration 2 of at most 3');
      expect(goal2).toContain('previous.<node>');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('exhausts → blocked, a grant event resumes one more round to success', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-loop-grant-'));
    try {
      const raw = loopDagRaw();
      raw.nodes[1].maxIterations = 1;
      const dag = validateDag(raw);
      const runNode: RunNode = async (req) => {
        const id = req.node.id;
        if (id === 'prepare') return okResult(req, [fileEntry(req.outputDir, 'prep.md', 'PREP', 'markdown')]);
        if (id === 'report') return okResult(req, [fileEntry(req.outputDir, 'report.md', 'REPORT', 'markdown')]);
        if (id.endsWith('.code')) return okResult(req, [fileEntry(req.outputDir, 'fix.md', 'FIX', 'markdown')]);
        const passed = id.includes('.i002.'); // iteration 1 fails, granted round passes
        return okResult(req, [
          fileEntry(req.outputDir, 'result.json', JSON.stringify({ passed }), 'json'),
        ]);
      };
      const deps: V3RuntimeDeps = { runNode, validateManifest, resolveBotSnapshot };

      const first = await runWorkflow(dag, deps, { baseDir: base });
      expect(first).toMatchObject({ reason: 'terminal', runStatus: 'blocked', blockedNodeId: 'fix' });

      const journalPath = join(base, dag.runId, 'journal.ndjson');
      const decision = readJournal(journalPath).find((e) => e.type === 'loopIterationDecision');
      expect(decision).toMatchObject({ decision: 'exhausted' });

      // A human grants one extra round (journal event — replay-correct).
      appendEvent(journalPath, { type: 'loopIterationGranted', loopId: 'fix', fromIteration: 1, by: 'tester' });

      const second = await runWorkflow(dag, deps, { baseDir: base });
      expect(second).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      const loopSeq = readJournal(journalPath)
        .filter((e) => e.type === 'loopIterationStarted')
        .map((e) => (e as { iteration: number }).iteration);
      expect(loopSeq).toEqual([1, 2]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('a body instance blocked by resultSchema retries via the EXISTING retry path', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-loop-retry-'));
    try {
      const dag = validateDag(loopDagRaw());
      const runNode: RunNode = async (req) => {
        const id = req.node.id;
        if (id === 'prepare') return okResult(req, [fileEntry(req.outputDir, 'prep.md', 'PREP', 'markdown')]);
        if (id === 'report') return okResult(req, [fileEntry(req.outputDir, 'report.md', 'REPORT', 'markdown')]);
        if (id.endsWith('.code')) return okResult(req, [fileEntry(req.outputDir, 'fix.md', 'FIX', 'markdown')]);
        // test instance: attempt 001 violates the schema (string passed),
        // attempt 002 is valid and passing.
        const good = req.attemptId.endsWith('/002');
        const result = good ? { passed: true } : { passed: 'nope' };
        return okResult(req, [
          fileEntry(req.outputDir, 'result.json', JSON.stringify(result), 'json'),
        ]);
      };
      const deps: V3RuntimeDeps = { runNode, validateManifest, resolveBotSnapshot };

      const first = await runWorkflow(dag, deps, { baseDir: base });
      expect(first).toMatchObject({
        reason: 'terminal',
        runStatus: 'blocked',
        blockedNodeId: 'fix.i001.test',
      });
      const journalPath = join(base, dag.runId, 'journal.ndjson');
      const blockedEv = readJournal(journalPath).find((e) => e.type === 'nodeBlocked');
      expect(blockedEv).toMatchObject({ nodeId: 'fix.i001.test', errorClass: 'resultInvalid' });

      // The slice-1 retry entrypoint works UNCHANGED on a loop instance.
      const retry = requestV3Retry(base, dag.runId, {});
      expect(retry).toMatchObject({ kind: 'requested', nodeId: 'fix.i001.test', nextAttemptId: 'fix.i001.test/attempts/002' });

      const second = await runWorkflow(dag, deps, { baseDir: base });
      expect(second).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ─── daemon-run: grant entrypoint + retry guard + reconcile ──────────────

describe('requestV3LoopGrant + retry loop guard', () => {
  /** Seed an exhausted-blocked loop journal (no worker dirs needed). */
  function seedExhausted(base: string, runId: string, withBinding = true): string {
    const { runDir } = birthRun({
      goal: 'g', baseDir: base, runId,
      ...(withBinding
        ? { chatBinding: { larkAppId: 'cli_test', chatId: 'oc_chat', rootMessageId: 'om_root' } }
        : {}),
    });
    const journalPath = join(runDir, 'journal.ndjson');
    appendEvent(journalPath, { type: 'runStarted', runId });
    appendEvent(journalPath, { type: 'loopStarted', loopId: 'fix' });
    appendEvent(journalPath, { type: 'loopIterationStarted', loopId: 'fix', iteration: 1 });
    appendEvent(journalPath, {
      type: 'loopIterationDecision', loopId: 'fix', iteration: 1,
      decision: 'exhausted', detail: 'result.passed=false (iteration 1/1)',
    });
    appendEvent(journalPath, { type: 'runBlocked', blockedNodeId: 'fix' });
    return runDir;
  }

  it('grants once, idempotent on repeat, stale on wrong iteration', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-grant-'));
    try {
      const runId = 'grant-core-260606-0001';
      seedExhausted(base, runId);

      // No-arg target resolution via the run's blocked pointer.
      const first = requestV3LoopGrant(base, runId, { by: 'ou_x' });
      expect(first).toEqual({ kind: 'granted', loopId: 'fix', fromIteration: 1, nextIteration: 2 });

      // Unconsumed grant → already-granted, NOT a second append.
      expect(requestV3LoopGrant(base, runId, {})).toEqual({ kind: 'already-granted', loopId: 'fix' });

      // expectedIteration freshness gate.
      expect(requestV3LoopGrant(base, runId, { expectedIteration: 99 })).toEqual({
        kind: 'stale-run', reason: 'stale-iteration',
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects non-exhausted loops and missing runs', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-grant-'));
    try {
      expect(requestV3LoopGrant(base, 'ghost-run-260606-0000', {})).toEqual({
        kind: 'stale-run', reason: 'missing',
      });
      const runId = 'grant-core-260606-0002';
      const runDir = seedExhausted(base, runId);
      // Consume the exhaustion with a grant + new iteration → no longer grantable.
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'loopIterationGranted', loopId: 'fix', fromIteration: 1 });
      appendEvent(journalPath, { type: 'loopIterationStarted', loopId: 'fix', iteration: 2 });
      expect(requestV3LoopGrant(base, runId, { loopId: 'fix' })).toEqual({
        kind: 'stale-run', reason: 'not-exhausted',
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('requestV3Retry refuses a loop id loudly (grant is the right verb)', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-grant-'));
    try {
      const runId = 'grant-core-260606-0003';
      seedExhausted(base, runId);
      // Both the implicit (blockedNodeId) and explicit target forms.
      expect(requestV3Retry(base, runId, {})).toEqual({ kind: 'stale-run', reason: 'loop-node' });
      expect(requestV3Retry(base, runId, { nodeId: 'fix' })).toEqual({ kind: 'stale-run', reason: 'loop-node' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('loopExhaustedInfoFor folds the card content from the journal', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-grant-'));
    try {
      const runId = 'grant-core-260606-0004';
      const runDir = seedExhausted(base, runId);
      const events = readJournal(join(runDir, 'journal.ndjson'));
      expect(loopExhaustedInfoFor(events, 'fix')).toEqual({
        loopId: 'fix', iteration: 1, granted: 0, detail: 'result.passed=false (iteration 1/1)',
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('projection: loop node + instances carry structured loop fields, no abs paths, no decision detail', async () => {
    // Reuse the real runtime to produce a genuine loop run dir, then project it.
    const base = mkdtempSync(join(tmpdir(), 'v3-loop-proj-'));
    try {
      const dag = validateDag(loopDagRaw());
      const runNode: RunNode = async (req) => {
        const id = req.node.id;
        if (id === 'prepare') return okResult(req, [fileEntry(req.outputDir, 'prep.md', 'PREP', 'markdown')]);
        if (id === 'report') return okResult(req, [fileEntry(req.outputDir, 'report.md', 'REPORT', 'markdown')]);
        if (id.endsWith('.code')) return okResult(req, [fileEntry(req.outputDir, 'fix.md', 'FIX', 'markdown')]);
        const passed = id.includes('.i002.');
        return okResult(req, [fileEntry(req.outputDir, 'result.json', JSON.stringify({ passed }), 'json')]);
      };
      const outcome = await runWorkflow(dag, { runNode, validateManifest, resolveBotSnapshot }, { baseDir: base });
      if (outcome.reason !== 'terminal') throw new Error('unreachable');

      const view = projectRun(dag.runId, outcome.runDir);
      const loopNode = view.nodes.find((n) => n.id === 'fix')!;
      expect(loopNode.isLoop).toBe(true);
      expect(loopNode.status).toBe('done');
      expect(loopNode.loopState).toMatchObject({ iteration: 2, maxIterations: 3, granted: 0, lastDecision: 'exit' });
      // Per-round verdict history (enum only) — the dashboard timeline's data.
      expect(loopNode.loopState!.decisions).toEqual([
        { iteration: 1, decision: 'continue' },
        { iteration: 2, decision: 'exit' },
      ]);
      // Body template shape — the timeline mini-dag's skeleton.
      expect(loopNode.loopState!.bodyTemplate).toEqual([
        { id: 'code', depends: [] },
        { id: 'test', depends: ['code'] },
      ]);

      const inst = view.nodes.find((n) => n.id === 'fix.i001.test')!;
      expect(inst.loop).toEqual({ loopId: 'fix', iteration: 1, bodyNodeId: 'test' });
      expect(inst.status).toBe('done');
      // Instances carry their REAL intra-round edges (template deps mapped to
      // same-round sibling instance ids) + the template goal.
      expect(inst.depends).toEqual(['fix.i001.code']);
      expect(view.nodes.find((n) => n.id === 'fix.i002.test')!.depends).toEqual(['fix.i002.code']);
      expect(view.nodes.find((n) => n.id === 'fix.i001.code')!.depends).toEqual([]);

      // Public-read invariants: no absolute runDir paths, no free-text
      // decision detail (it can quote agent-written result strings).
      const json = JSON.stringify(view);
      expect(json).not.toContain(outcome.runDir);
      expect(json).not.toContain('result.passed=');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('coldAttach reconcile reposts a grant card (not a retry card) for an exhausted loop', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-grant-'));
    try {
      const runId = 'grant-core-260606-0005';
      seedExhausted(base, runId);
      const recs = reconcileV3PendingGates(base);
      expect(recs).toHaveLength(1);
      expect(recs[0]!.repostLoopGrant).toMatchObject({ loopId: 'fix', iteration: 1 });
      expect(recs[0]!.repostBlocked).toBeUndefined();
      expect(recs[0]!.resume).toBe(false);

      // Owner filter still applies.
      expect(reconcileV3PendingGates(base, 'cli_other')).toHaveLength(0);
      expect(reconcileV3PendingGates(base, 'cli_test')).toHaveLength(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('coldAttach resumes loop-control crash windows (codex review blocker)', () => {
    // A loop node is 'running' in PURE CONTROL states with no worker behind
    // it — a crash right after these appends (before the next tick derives the
    // follow-up) must yield resume:true, not "phantom running, leave alone".
    const base = mkdtempSync(join(tmpdir(), 'v3-grant-'));
    try {
      const seedControl = (runId: string, extra: V3Event[]): void => {
        const { runDir } = birthRun({
          goal: 'g', baseDir: base, runId,
          chatBinding: { larkAppId: 'cli_test', chatId: 'oc_chat', rootMessageId: 'om_root' },
        });
        const journalPath = join(runDir, 'journal.ndjson');
        appendEvent(journalPath, { type: 'runStarted', runId });
        for (const e of extra) appendEvent(journalPath, e);
      };

      // (1) crash right after loopStarted.
      seedControl('cw-started-260606-0001', [{ type: 'loopStarted', loopId: 'fix' }]);
      // (2) crash right after a continue-decision (body of iteration 1 done).
      seedControl('cw-continue-260606-0002', [
        { type: 'loopStarted', loopId: 'fix' },
        { type: 'loopIterationStarted', loopId: 'fix', iteration: 1 },
        { type: 'nodeDispatched', nodeId: 'fix.i001.code', attemptId: 'fix.i001.code/attempts/001', loop: { loopId: 'fix', iteration: 1, bodyNodeId: 'code' } },
        { type: 'nodeSucceeded', nodeId: 'fix.i001.code', attemptId: 'fix.i001.code/attempts/001', manifestPath: '/x/m.json' },
        { type: 'loopIterationDecision', loopId: 'fix', iteration: 1, decision: 'continue' },
      ]);
      // (3) crash right after a grant click (the most reproducible window).
      seedControl('cw-granted-260606-0003', [
        { type: 'loopStarted', loopId: 'fix' },
        { type: 'loopIterationStarted', loopId: 'fix', iteration: 1 },
        { type: 'loopIterationDecision', loopId: 'fix', iteration: 1, decision: 'exhausted' },
        { type: 'runBlocked', blockedNodeId: 'fix' },
        { type: 'loopIterationGranted', loopId: 'fix', fromIteration: 1 },
      ]);
      // (4) NEGATIVE: a body instance genuinely in flight is real running —
      // that run stays in the fencing-backlog bucket (no resume record).
      seedControl('cw-inflight-260606-0004', [
        { type: 'loopStarted', loopId: 'fix' },
        { type: 'loopIterationStarted', loopId: 'fix', iteration: 1 },
        { type: 'nodeDispatched', nodeId: 'fix.i001.code', attemptId: 'fix.i001.code/attempts/001', loop: { loopId: 'fix', iteration: 1, bodyNodeId: 'code' } },
      ]);

      const recs = reconcileV3PendingGates(base);
      const byId = new Map(recs.map((r) => [r.runId, r]));
      expect(byId.get('cw-started-260606-0001')).toMatchObject({ resume: true });
      expect(byId.get('cw-continue-260606-0002')).toMatchObject({ resume: true });
      expect(byId.get('cw-granted-260606-0003')).toMatchObject({ resume: true });
      expect(byId.has('cw-inflight-260606-0004')).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
