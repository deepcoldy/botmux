import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventLog } from '../src/workflows/events/append.js';
import type { WorkflowEvent } from '../src/workflows/events/schema.js';
import { parseWorkflowDefinition } from '../src/workflows/definition.js';
import { createRun, type BotResolver } from '../src/workflows/run-init.js';
import { createWait } from '../src/workflows/wait.js';
import {
  handleWorkflowFanoutEvent,
  WorkflowEventWatcher,
} from '../src/workflows/fanout.js';

const RUN_ID = 'run-fanout-test-01';
const SHA = `sha256:${'f'.repeat(64)}`;
const sampleOutputRef = {
  outputHash: SHA,
  outputBytes: 12,
  outputSchemaVersion: 1,
};
const resolver: BotResolver = () => ({ cliId: 'codex', displayName: 'Codex Loopy' });

let baseDir: string;
let log: EventLog;

beforeEach(async () => {
  baseDir = mkdtempSync(join(tmpdir(), 'wf-fanout-'));
  log = new EventLog(RUN_ID, baseDir);
  await createRun(log, {
    def: parseWorkflowDefinition({
      workflowId: 'wf-fanout',
      version: 1,
      nodes: {
        gate: {
          type: 'subagent',
          bot: 'codex-loopy',
          prompt: 'do gated work',
          humanGate: { stage: 'before', prompt: 'approve?' },
        },
      },
    }),
    params: {},
    initiator: 'ou_user',
    botResolver: resolver,
    chatBinding: { chatId: 'oc_workflow_chat', larkAppId: 'app_workflow' },
  });
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

async function appendAttempt(activityId: string, attemptId: string, nodeId = 'gate') {
  return log.append({
    runId: RUN_ID,
    type: 'attemptCreated',
    actor: 'scheduler',
    payload: {
      nodeId,
      activityId,
      attemptId,
      attemptNumber: 1,
      inputRef: sampleOutputRef,
    },
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('WorkflowEventWatcher', () => {
  it('fs.watch dispatches a new waitCreated event once', async () => {
    await appendAttempt('gate-activity', 'gate-attempt');
    const seen: WorkflowEvent[] = [];
    const watcher = new WorkflowEventWatcher(RUN_ID, (event) => {
      seen.push(event);
    }, { runsDir: baseDir });
    await watcher.ready;

    await createWait(log, {
      activityId: 'gate-activity',
      attemptId: 'gate-attempt',
      nodeId: 'gate',
      waitKind: 'human-gate',
      prompt: 'approve?',
    });

    await waitFor(() => seen.length === 1);
    watcher.close();
    expect(seen.map((e) => e.type)).toEqual(['waitCreated']);
  });

  it('dispatches multiple appended events incrementally once each', async () => {
    const seen: WorkflowEvent[] = [];
    const watcher = new WorkflowEventWatcher(RUN_ID, (event) => {
      seen.push(event);
    }, { runsDir: baseDir });
    await watcher.ready;

    await appendAttempt('activity-1', 'attempt-1');
    await createWait(log, {
      activityId: 'activity-1',
      attemptId: 'attempt-1',
      nodeId: 'gate',
      waitKind: 'human-gate',
      prompt: 'approve?',
    });

    await waitFor(() => seen.length === 2);
    watcher.close();
    expect(seen.map((e) => e.type)).toEqual(['attemptCreated', 'waitCreated']);
    expect(new Set(seen.map((e) => e.eventId)).size).toBe(2);
  });

  it('does not advance cursor when event delivery fails, then retries the same event', async () => {
    await appendAttempt('gate-activity', 'gate-attempt');
    const seen: string[] = [];
    let fail = true;
    const errors: unknown[] = [];
    const watcher = new WorkflowEventWatcher(
      RUN_ID,
      (event) => {
        seen.push(event.eventId);
        if (fail) {
          fail = false;
          throw new Error('temporary delivery failure');
        }
      },
      { runsDir: baseDir, onError: (err) => errors.push(err), pollIntervalMs: 60_000 },
    );
    await watcher.ready;

    const waitEvent = await createWait(log, {
      activityId: 'gate-activity',
      attemptId: 'gate-attempt',
      nodeId: 'gate',
      waitKind: 'human-gate',
      prompt: 'approve?',
    });

    await waitFor(() => errors.length === 1);
    await watcher.drain();
    watcher.close();

    expect(seen).toEqual([waitEvent.eventId, waitEvent.eventId]);
  });

  it('polling fallback dispatches events even without another fs.watch edge', async () => {
    await appendAttempt('gate-activity', 'gate-attempt');
    const seen: WorkflowEvent[] = [];
    const watcher = new WorkflowEventWatcher(
      RUN_ID,
      (event) => {
        seen.push(event);
      },
      { runsDir: baseDir, pollIntervalMs: 20, useFsWatch: false },
    );
    await watcher.ready;

    await createWait(log, {
      activityId: 'gate-activity',
      attemptId: 'gate-attempt',
      nodeId: 'gate',
      waitKind: 'human-gate',
      prompt: 'approve?',
    });

    await waitFor(() => seen.some((event) => event.type === 'waitCreated'));
    watcher.close();
    expect(seen.filter((event) => event.type === 'waitCreated')).toHaveLength(1);
  });
});

describe('handleWorkflowFanoutEvent', () => {
  it('sends a workflow approval card to the bound chat on human-gate waitCreated', async () => {
    await appendAttempt('gate-activity', 'gate-attempt');
    const waitCreated = await createWait(log, {
      activityId: 'gate-activity',
      attemptId: 'gate-attempt',
      nodeId: 'gate',
      waitKind: 'human-gate',
      prompt: 'approve booking?',
    });
    const sendCard = vi.fn(async () => 'om_approval_card');

    const messageId = await handleWorkflowFanoutEvent(waitCreated, {
      runsDir: baseDir,
      sendCard,
    });

    expect(messageId).toBe('om_approval_card');
    expect(sendCard).toHaveBeenCalledTimes(1);
    expect(sendCard.mock.calls[0]?.[0]).toBe('app_workflow');
    expect(sendCard.mock.calls[0]?.[1]).toBe('oc_workflow_chat');
    expect(sendCard.mock.calls[0]?.[2]).toContain('wf_approve');
    expect(sendCard.mock.calls[0]?.[2]).toContain('approve booking?');
    expect(sendCard.mock.calls[0]?.[3]).toBe('interactive');
  });

  it('does not send cards for non-human waits', async () => {
    await appendAttempt('timer-activity', 'timer-attempt');
    const waitCreated = await createWait(log, {
      activityId: 'timer-activity',
      attemptId: 'timer-attempt',
      nodeId: 'gate',
      waitKind: 'time',
      deadlineAt: Date.now() + 60_000,
    });
    const sendCard = vi.fn(async () => 'om_should_not_send');

    const messageId = await handleWorkflowFanoutEvent(waitCreated, {
      runsDir: baseDir,
      sendCard,
    });

    expect(messageId).toBeUndefined();
    expect(sendCard).not.toHaveBeenCalled();
  });
});
