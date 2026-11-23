/**
 * Wiring test for the daemon-side editable-suggestion staleness guard.
 *
 * The pure helper editableSuggestionIsCurrent has its own unit tests, but those
 * cannot prove that worker-pool's `prompt_suggestion` branch actually invokes
 * it. Here the real case clause is extracted from worker-pool.ts and run against
 * the real helper + real noteNextStepSuggestion state machine, so deleting the
 * production call turns these assertions red.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadWorkerPoolMessageHandlers } from './helpers/worker-pool-message-harness.js';
import {
  editableSuggestionIsCurrent,
  nextStepIdle,
  noteNextStepCard,
  noteNextStepSuggestion,
  noteNextStepTurnStarted,
  type NextStepIo,
} from '../src/core/next-step-suggestion.js';
import { NEXT_STEP_ELEMENT_ID } from '../src/im/lark/next-step-card.js';
import type { DaemonSession } from '../src/core/types.js';

const TURN = 'om_turn_1';

/** A sent legacy reply card: body, hr, chrome row with the footer inside. */
const LEGACY_CARD = JSON.stringify({ schema: '2.0', body: { elements: [
  { tag: 'markdown', content: 'answer' },
  { tag: 'hr' },
  { tag: 'column_set', element_id: 'botmux_reply_actions', columns: [{ tag: 'column', elements: [
    { tag: 'markdown', element_id: 'botmux_reply_footer', content: 'signature' },
  ] }] },
] } });

function makeDs(): any {
  return {
    session: { sessionId: 'sess-wiring', status: 'active' },
    larkAppId: 'app_wiring',
    chatId: 'oc_chat',
    currentTurnId: TURN,
    lastTurnTerminalTurnId: TURN,
    lastTurnTerminalStatus: 'completed',
    lastTurnTerminalDispatchAttempt: 2,
  };
}

function makeIo() {
  const insert = vi.fn();
  const io: NextStepIo = {
    enabled: () => true,
    locale: () => 'zh',
    issue: () => ({ payload: 'payload-x', sig: 'sig-x' }),
    readCard: async () => LEGACY_CARD,
    cardId: async () => 'card_1',
    insert,
    replace: vi.fn(),
    remove: vi.fn(),
    now: () => Date.now(),
    warn: vi.fn(),
    info: vi.fn(),
  };
  return { io, insert };
}

function handlerFor(ds: any, io: NextStepIo) {
  const scope: Record<string, unknown> = {
    ds,
    // Real production modules: the extracted clause must resolve to these.
    editableSuggestionIsCurrent,
    noteNextStepSuggestion,
    nextStepIo: io,
    ownsLifecycleMutation: () => true,
    managedAuxUiSuppressed: () => false,
    logger: { info() {}, warn() {} },
    t: 'wiring-test',
  };
  return loadWorkerPoolMessageHandlers(['prompt_suggestion'], scope);
}

describe('worker-pool prompt_suggestion editable guard wiring', () => {
  it('places an editable suggestion whose turn and dispatch attempt match the terminal', async () => {
    const ds = makeDs();
    const { io, insert } = makeIo();
    noteNextStepTurnStarted(ds, TURN, io);
    noteNextStepCard(ds, TURN, { kind: 'legacy', messageId: 'om_answer' }, io, 2);
    handlerFor(ds, io)({ type: 'prompt_suggestion', text: '查 CI 结果', turnId: TURN, dispatchAttempt: 2, editable: true });
    await nextStepIdle(ds);
    expect(insert).toHaveBeenCalledTimes(1);
    const element = insert.mock.calls[0][4] as Record<string, unknown>;
    expect(element.element_id).toBe(NEXT_STEP_ELEMENT_ID);
  });

  it('drops an editable suggestion from a superseded dispatch attempt without touching the state machine', async () => {
    const ds = makeDs();
    const { io, insert } = makeIo();
    noteNextStepTurnStarted(ds, TURN, io);
    noteNextStepCard(ds, TURN, { kind: 'legacy', messageId: 'om_answer' }, io, 2);
    handlerFor(ds, io)({ type: 'prompt_suggestion', text: '旧尝试的建议', turnId: TURN, dispatchAttempt: 1, editable: true });
    await nextStepIdle(ds);
    // The branch must break before noteNextStepSuggestion runs: no card write and
    // no "ignored by state machine" info line either.
    expect(insert).not.toHaveBeenCalled();
    expect(io.info).not.toHaveBeenCalled();
  });

  it('drops an editable suggestion belonging to an older turn', async () => {
    const ds = makeDs();
    ds.currentTurnId = 'om_turn_2';
    ds.lastTurnTerminalTurnId = 'om_turn_2';
    const { io, insert } = makeIo();
    handlerFor(ds, io)({ type: 'prompt_suggestion', text: '旧轮建议', turnId: TURN, dispatchAttempt: 2, editable: true });
    await nextStepIdle(ds);
    expect(insert).not.toHaveBeenCalled();
    expect(io.info).not.toHaveBeenCalled();
  });

  it('still routes non-editable CLI-native suggestions past the editable guard', async () => {
    const ds = makeDs();
    ds.currentTurnId = 'om_turn_2';
    const { io, insert } = makeIo();
    // No editable flag: the guard must not run, and the state machine itself
    // rejects the stale turn (observable via its ignored-info line). This proves
    // the production guard is scoped to editable suggestions only.
    handlerFor(ds, io)({ type: 'prompt_suggestion', text: '原生建议', turnId: TURN, dispatchAttempt: 2 });
    await nextStepIdle(ds);
    expect(insert).not.toHaveBeenCalled();
    expect(io.info).toHaveBeenCalledTimes(1);
  });
});
