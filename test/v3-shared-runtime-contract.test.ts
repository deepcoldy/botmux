import { describe, expect, it } from 'vitest';

import {
  decideNext,
  matchLoopExitWhen,
  normalizeGateWaitInput,
  revisitBudgetStatus,
  selectedResolution,
  validateDag,
  type StoredEvent,
  type V3EdgeRunState,
  type V3RunState,
} from '../src/workflows/v3/shared-runtime.js';

function goal(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'goal', goal: `do ${id}`, depends: [], inputs: [], ...extra };
}

describe('v3 shared runtime contract', () => {
  it('validates and schedules a conditional branch without a daemon adapter', () => {
    const dag = validateDag({
      runId: 'shared-conditional',
      nodes: [
        goal('decide', {
          resultSchema: {
            type: 'object',
            properties: { decision: { type: 'string', enum: ['ship', 'stop'] } },
            required: ['decision'],
          },
        }),
        goal('ship', {
          depends: [{ from: 'decide', when: { path: 'result.decision', equals: 'ship' } }],
        }),
      ],
    });
    const state: V3RunState = new Map([['decide', { status: 'done' }]]);

    expect(decideNext(dag, state)).toEqual([
      { kind: 'resolveEdge', from: 'decide', to: 'ship' },
    ]);

    const edges: V3EdgeRunState = new Map([
      ['decide->ship', { active: true, sourceAttemptId: 'decide/attempts/001' }],
    ]);
    expect(decideNext(dag, state, new Map(), edges)).toEqual([
      { kind: 'dispatchWork', nodeId: 'ship', instanceId: 'ship#001' },
    ]);
  });

  it('validates a structured loop and evaluates its exit predicate purely', () => {
    const dag = validateDag({
      runId: 'shared-loop',
      nodes: [{
        id: 'repair',
        type: 'loop',
        maxIterations: 3,
        body: {
          nodes: [
            goal('code'),
            goal('test', {
              depends: ['code'],
              inputs: [{ from: 'code' }],
              resultSchema: {
                type: 'object',
                properties: { passed: { type: 'boolean' } },
                required: ['passed'],
              },
            }),
          ],
        },
        exit: { node: 'test', when: { path: 'result.passed', equals: true } },
        output: { from: 'code' },
      }],
    });

    expect(decideNext(dag, new Map())).toEqual([{ kind: 'startLoop', loopId: 'repair' }]);
    expect(matchLoopExitWhen({ path: 'result.passed', equals: true }, true)).toBe(true);
    expect(matchLoopExitWhen({ path: 'result.passed', equals: true }, false)).toBe(false);
  });

  it('enforces revisit budgets and accepts a scoped grant', () => {
    const events: StoredEvent[] = [{
      type: 'nodeRevisitRequested',
      nodeId: 'review',
      instanceId: 'review#001',
      attemptId: 'review#001/attempts/001',
      toNodeId: 'build',
      ts: 1,
    }];

    expect(revisitBudgetStatus(events, 'review', 'build')).toMatchObject({
      ok: false,
      tier: 'pair',
    });
    expect(revisitBudgetStatus([
      ...events,
      {
        type: 'revisitBudgetGranted',
        sourceNodeId: 'review',
        toNodeId: 'build',
        by: 'human',
        ts: 2,
      },
    ], 'review', 'build')).toEqual({ ok: true });
  });

  it('normalizes and schedules a host-independent human gate', () => {
    const dag = validateDag({
      runId: 'shared-gate',
      nodes: [goal('deploy', {
        humanGate: {
          prompt: 'Deploy?',
          options: ['yes', 'no'],
          approveOptions: ['yes'],
          approvers: ['alice'],
        },
      })],
    });
    const gate = normalizeGateWaitInput(dag.nodes[0]!.humanGate!);

    expect(gate).toEqual({
      prompt: 'Deploy?',
      options: ['yes', 'no'],
      approveOptions: ['yes'],
      approvers: ['alice'],
    });
    expect(selectedResolution(gate, 'yes')).toBe('approved');
    expect(selectedResolution(gate, 'no')).toBe('rejected');
    expect(decideNext(dag, new Map())).toEqual([
      { kind: 'dispatchGate', nodeId: 'deploy', instanceId: 'deploy#001' },
    ]);
  });
});
