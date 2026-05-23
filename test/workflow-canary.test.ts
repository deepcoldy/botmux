/**
 * Canary multi-step workflow — validates that the first real composition
 * path survives end-to-end:
 *
 *   subagent output blob → humanGate.prompt binding → wait re-entry →
 *   subagent prompt binding → hostExecutor input binding → effect sidecar.
 *
 * Feishu is mocked by design.  Real sends require an explicit test chat.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkflowDefinition } from '../src/workflows/definition.js';
import { loadEffectInputSidecar } from '../src/workflows/effect-input.js';
import { EventLog } from '../src/workflows/events/append.js';
import { runLoop } from '../src/workflows/loop.js';
import { gateActivityId, workActivityId } from '../src/workflows/orchestrator.js';
import { createRun } from '../src/workflows/run-init.js';
import type { WorkerSpawnFn } from '../src/workflows/runtime.js';
import { resolveWait } from '../src/workflows/wait.js';

const FIXTURE_PATH = join(__dirname, '..', 'workflows', 'canary-multistep.workflow.json');
const RUN_ID = 'canary-multistep-test-01';

let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'wf-canary-runs-'));
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
  vi.doUnmock('../src/im/lark/client.js');
  vi.resetModules();
});

describe('canary-multistep workflow', () => {
  it('passes output bindings across gate re-entry and feishu-send input', async () => {
    vi.resetModules();
    const sendMessage = vi.fn(async () => 'om_canary_123');
    vi.doMock('../src/im/lark/client.js', () => ({
      sendMessage,
      MessageWithdrawnError: class MessageWithdrawnError extends Error {},
    }));

    const { createDefaultHostExecutorRegistry } = await import(
      '../src/workflows/hostExecutors/registry.js'
    );

    const raw = await fs.readFile(FIXTURE_PATH, 'utf-8');
    const def = parseWorkflowDefinition(JSON.parse(raw));
    expect(def.workflowId).toBe('canary-multistep');

    const spawnCalls: Array<{ nodeId: string; prompt: string }> = [];
    const spawnSubagent: WorkerSpawnFn = async (input) => {
      spawnCalls.push({ nodeId: input.nodeId, prompt: input.prompt });
      if (input.nodeId === 'draft') {
        expect(input.prompt).toContain('Create a short canary message');
        return {
          kind: 'success',
          output: {
            preview: 'Preview: Canary message ready for approval',
            text: 'Canary message body',
          },
          session: session(input),
        };
      }
      if (input.nodeId === 'confirm') {
        expect(input.prompt).toBe('Canary message body');
        return {
          kind: 'success',
          output: {
            approvedText: `${input.prompt} [approved]`,
          },
          session: session(input),
        };
      }
      throw new Error(`unexpected subagent node ${input.nodeId}`);
    };

    const log = new EventLog(RUN_ID, runsDir);
    await createRun(log, {
      def,
      params: {},
      initiator: 'canary-test',
      botResolver: () => ({}),
    });

    const ctx = {
      log,
      def,
      spawnSubagent,
      hostExecutors: createDefaultHostExecutorRegistry(),
    };

    const first = await runLoop(ctx, { maxTicks: 50 });
    expect(first.reason).toBe('awaiting-wait');
    expect(first.lastSnapshot.run.status).toBe('running');
    expect(spawnCalls).toEqual([
      {
        nodeId: 'draft',
        prompt: 'Create a short canary message. Return JSON: {"preview": string, "text": string}.',
      },
    ]);

    const gateActId = gateActivityId(RUN_ID, 'confirm');
    const gateAct = first.lastSnapshot.activities.get(gateActId);
    if (!gateAct?.currentAttemptId) throw new Error('confirm gate attempt missing');

    const beforeApprovalEvents = await log.readAll();
    const waitCreated = beforeApprovalEvents.find((e) => e.type === 'waitCreated') as
      | { payload: { prompt: string } }
      | undefined;
    expect(waitCreated?.payload.prompt).toBe('Preview: Canary message ready for approval');
    expect(beforeApprovalEvents.map((e) => e.type)).toEqual([
      'runCreated',
      'runStarted',
      'attemptCreated',
      'activityRunning',
      'activitySucceeded',
      'nodeSucceeded',
      'attemptCreated',
      'waitCreated',
    ]);

    await resolveWait(log, {
      activityId: gateActId,
      attemptId: gateAct.currentAttemptId,
      resolution: 'approved',
      by: 'ou_canary_reviewer',
      comment: 'ship it',
    });

    const second = await runLoop(ctx, { maxTicks: 50 });
    expect(second.reason).toBe('terminal');
    expect(second.lastSnapshot.run.status).toBe('succeeded');
    expect(spawnCalls).toEqual([
      {
        nodeId: 'draft',
        prompt: 'Create a short canary message. Return JSON: {"preview": string, "text": string}.',
      },
      { nodeId: 'confirm', prompt: 'Canary message body' },
    ]);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const callArgs = sendMessage.mock.calls[0];
    expect(callArgs).toEqual([
      'cli_canary_PLACEHOLDER',
      'oc_canary_PLACEHOLDER',
      'Canary message body [approved]',
      'text',
      expect.stringMatching(/^wf_[0-9a-f]+$/),
    ]);

    const sendActId = workActivityId(RUN_ID, 'send');
    const sendAct = second.lastSnapshot.activities.get(sendActId);
    if (!sendAct?.currentAttemptId) throw new Error('send attempt missing');
    await expect(
      loadEffectInputSidecar(log, sendActId, sendAct.currentAttemptId),
    ).resolves.toEqual({
      larkAppId: 'cli_canary_PLACEHOLDER',
      chatId: 'oc_canary_PLACEHOLDER',
      content: 'Canary message body [approved]',
      msgType: 'text',
    });

    const events = await log.readAll();
    expect(events.map((e) => e.type)).toEqual([
      'runCreated',
      'runStarted',
      'attemptCreated',
      'activityRunning',
      'activitySucceeded',
      'nodeSucceeded',
      'attemptCreated',
      'waitCreated',
      'waitResolved',
      'activitySucceeded',
      'attemptCreated',
      'activityRunning',
      'activitySucceeded',
      'nodeSucceeded',
      'attemptCreated',
      'effectAttempted',
      'activitySucceeded',
      'nodeSucceeded',
      'runSucceeded',
    ]);

    const succeeded = events.filter((e) => e.type === 'activitySucceeded').at(-1) as
      | { payload: { outputRef: { outputPath: string }; externalRefs?: { messageId: string } } }
      | undefined;
    expect(succeeded?.payload.externalRefs?.messageId).toBe('om_canary_123');
    const sendBlob = JSON.parse(
      await fs.readFile(succeeded!.payload.outputRef.outputPath, 'utf-8'),
    );
    expect(sendBlob).toEqual({
      output: { messageId: 'om_canary_123' },
      externalRefs: { messageId: 'om_canary_123' },
    });
  });
});

function session(input: Parameters<WorkerSpawnFn>[0]) {
  return {
    sessionId: `sess-${input.nodeId}`,
    botName: input.botName,
    startedAt: 1,
    endedAt: 2,
  };
}
