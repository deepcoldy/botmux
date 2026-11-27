/**
 * The worker messages a native gateway's progress projection is built from:
 * the pool's real goal_update / thinking_update branches (via the pool message
 * harness) feeding the real projection. Card rendering is out of scope here,
 * so the Lark goal card is kept hidden.
 */
import { describe, expect, it } from 'vitest';

import { projectCoreOnlyProgress, rememberCoreOnlyGoal } from '../src/core/core-only-progress.js';
import { goalStatusCardOrigin } from '../src/core/goal-status-card.js';
import type { NativeGoalState } from '../src/services/native-goal-state.js';
import { loadWorkerPoolMessageHandlers } from './helpers/worker-pool-message-harness.js';

const TURN = 'turn';

function apiOnlyTurn() {
  return {
    larkAppId: 'local_bot', chatId: 'http_async_fixture', workerGeneration: 2,
    session: { sessionId: 'session' },
    initConfig: { apiOnly: true },
    asyncTriggerResults: new Map([[TURN, { status: 'pending' }]]),
    activeInteractiveTurn: { turnId: TURN },
  } as any;
}

describe('worker progress captured for a native gateway', () => {
  it('a goal update during the turn becomes part of that turn\'s progress', () => {
    const ds = apiOnlyTurn();
    const handle = loadWorkerPoolMessageHandlers(['goal_update'], {
      ds, worker: { send() {} }, ownsWorkerSession: () => true, rememberCoreOnlyGoal,
      sessionAnchorId: () => 'anchor', goalCardOwns: () => false, isDocNativeSession: () => false,
      managedAuxUiSuppressed: () => false, isSubstituteTurn: () => false, isTriggerFinalSuppressed: () => false,
      goalStatusCardOrigin, fallbackTurnId: (_ds: unknown, turnId: string) => turnId,
      sessionStore: { updateSession() {} }, goalCardCanDisplay: () => false, goalStatusCard: undefined,
    });
    const goal: NativeGoalState = { goalId: 'g1', objective: 'ship it', status: 'active', createdAt: 1, updatedAt: 2, timeUsedSeconds: 3 };
    handle({ type: 'goal_update', turnId: TURN, goal });
    expect(projectCoreOnlyProgress(ds, TURN)?.goal).toEqual(goal);
  });

  it('reasoning is shown for the generation that produced it and never after the worker is replaced', () => {
    const ds = apiOnlyTurn();
    const handle = loadWorkerPoolMessageHandlers(['thinking_update'], {
      ds, ownsLifecycleMutation: () => true, replyCardModeFor: () => 'unified', managedAuxUiSuppressed: () => true,
    });
    const entries = [{ type: 'thinking', text: 'reasoning' }];
    handle({ type: 'thinking_update', turnId: TURN, entries });
    expect(projectCoreOnlyProgress(ds, TURN)?.entries).toEqual(entries);
    ds.workerGeneration = 3;
    expect(projectCoreOnlyProgress(ds, TURN)?.entries).toEqual([]);
  });
});
