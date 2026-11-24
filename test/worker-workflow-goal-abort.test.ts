import { describe, expect, it } from 'vitest';
import { ClaudeGoalAbortWatch, type TranscriptEvent } from '../src/services/claude-transcript.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import type { WorkerToDaemon } from '../src/types.js';

// bridgeIngest hands every drained Claude record to maybeFailWorkflowOnGoalAbort;
// a workflow worker turns a cleared goal into an `error`, which the v3 pool
// treats as an immediate node failure.

const cleared = {
  type: 'system', subtype: 'informational',
  content: 'Goal cleared after an unrecoverable error (model unavailable): "Read $BOTMUX_GOAL_PATH…".',
} as TranscriptEvent;

function harness(opts: { workflow: boolean; finalOutputSent?: boolean }) {
  const messages: WorkerToDaemon[] = [];
  const scope = {
    isWorkflowWorker: () => opts.workflow,
    workflowFinalOutputSent: opts.finalOutputSent === true,
    workflowGoalAbortWatch: new ClaudeGoalAbortWatch(),
    log: () => {},
    send: (event: WorkerToDaemon) => messages.push(event),
  };
  const ingest = loadWorkerFunction<(events: readonly TranscriptEvent[]) => void>('maybeFailWorkflowOnGoalAbort', scope);
  return { messages, ingest };
}

describe('workflow worker on a cleared Claude goal', () => {
  it('reports a worker error once so the node fails now', () => {
    const { messages, ingest } = harness({ workflow: true });
    ingest([cleared]);
    ingest([cleared]);
    expect(messages).toEqual([{ type: 'error', message: (cleared as any).content, goalAborted: true }]);
  });

  it('leaves ordinary chat sessions alone', () => {
    const { messages, ingest } = harness({ workflow: false });
    ingest([cleared]);
    expect(messages).toEqual([]);
  });

  it('does not fail a node whose final output was already delivered', () => {
    const { messages, ingest } = harness({ workflow: true, finalOutputSent: true });
    ingest([cleared]);
    expect(messages).toEqual([]);
  });
});
