/**
 * Worker → core contract for the limit a native gateway shows: a limit the
 * worker read from a CLI's structured transcript signal must reach the core as
 * a limit of that turn's progress. Only then does the gateway show the limit
 * notice and hand the turn to quota fallback.
 *
 * Each emitter is the real worker function, cut out with the worker harness
 * (src/worker.ts is an entry script with side effects and cannot be imported).
 * What it sends is handed unchanged to the real core-side recorder and
 * projection, so renaming a field on either side alone turns this red.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { projectCoreOnlyProgress, rememberCoreOnlyLimit } from '../src/core/core-only-progress.js';
import { apiErrorMessageText, isTranscriptRateLimitEvent, type TranscriptEvent } from '../src/services/claude-transcript.js';
import { drainCodexRollout, isCodexRateLimitEvent, type CodexBridgeEvent } from '../src/services/codex-transcript.js';
import { structuredCodexLimitState, structuredRateLimitState } from '../src/utils/cli-usage-limit.js';

const TURN = 'turn-1';
const ATTEMPT = 1;
const GENERATION = 2;

/** Worker globals both emitters read; `send` captures what crosses IPC. */
function emitterScope(sent: unknown[]): Record<string, unknown> {
  return {
    emittedRateLimitUuids: new Set<string>(),
    usageLimitTracker: { noteStructuredLimit() {} },
    currentUsageLimitSnapshot: () => 'limited screen',
    backgroundWaitPayload: () => ({}),
    send: (message: unknown) => { sent.push(message); },
    currentBotmuxTurnId: TURN,
    currentBotmuxDispatchAttempt: ATTEMPT,
    log: () => {},
  };
}

/**
 * The core side of one worker `screen_update` for a pending API-only HTTP turn:
 * record the limit against the turn the message names (the daemon has already
 * proven it is the admitted execution), take its usage limit as the session's
 * current one, then read the turn's progress as the gateway does.
 */
function progressAfterCoreReceives(message: any) {
  const session: any = {
    initConfig: { apiOnly: true },
    workerGeneration: GENERATION,
    asyncTriggerResults: new Map([[TURN, { status: 'pending' }]]),
    activeInteractiveTurn: { turnId: TURN },
    turnDispatchAttemptHighWater: { turnId: TURN, dispatchAttempt: ATTEMPT },
  };
  rememberCoreOnlyLimit(session, message, message.turnId, GENERATION);
  session.usageLimit = message.usageLimit;
  return projectCoreOnlyProgress(session, TURN);
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('a structured limit the worker emits is a limit of the turn on the core', () => {
  it('Claude transcript rate-limit record', () => {
    const sent: unknown[] = [];
    const emit = loadWorkerFunction<(events: readonly TranscriptEvent[]) => void>('maybeEmitStructuredRateLimit', {
      ...emitterScope(sent),
      isTranscriptRateLimitEvent,
      apiErrorMessageText,
      structuredRateLimitState,
    });
    const rateLimited: TranscriptEvent = {
      type: 'assistant', uuid: 'claude-rate-limit', isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429,
      message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: 429 rate_limit_error' }] },
    };

    emit([rateLimited]);

    expect(sent).toHaveLength(1);
    expect(progressAfterCoreReceives(sent[0])?.limit).toMatchObject({ kind: 'rate' });
  });

  it('Codex rollout usage-limit terminal', () => {
    const root = mkdtempSync(join(tmpdir(), 'structured-limit-contract-'));
    roots.push(root);
    const rollout = join(root, 'rollout.jsonl');
    writeFileSync(rollout, `${JSON.stringify({
      timestamp: '2026-10-13T20:24:04.521Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete', turn_id: 'codex-turn', last_agent_message: null,
        error: { message: 'You’ve hit your usage limit.', codex_error_info: 'usage_limit_exceeded' },
      },
    })}\n`);
    const events: CodexBridgeEvent[] = drainCodexRollout(rollout, 0).events;
    const sent: unknown[] = [];
    const emit = loadWorkerFunction<(events: readonly CodexBridgeEvent[]) => void>('maybeEmitCodexStructuredRateLimit', {
      ...emitterScope(sent),
      isCodexRateLimitEvent,
      structuredCodexLimitState,
    });

    emit(events);

    expect(sent).toHaveLength(1);
    expect(progressAfterCoreReceives(sent[0])?.limit).toMatchObject({ kind: 'usage' });
  });
});
