import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { handleCardAction } from '../src/im/lark/card-handler.js';
import {
  coerceWorkflowParams,
  executeWorkflowCommand,
  parseWorkflowCommand,
} from '../src/im/lark/workflow-slash-command.js';
import {
  WORKFLOW_APPROVE_ACTION,
  WORKFLOW_COMMENT_FIELD,
  workflowApprovalCardNonce,
} from '../src/im/lark/workflow-cards.js';
import { EventLog } from '../src/workflows/events/append.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';
import type { WorkflowRuntimeContext } from '../src/workflows/runtime.js';

const def: WorkflowDefinition = {
  workflowId: 'hello',
  version: 1,
  params: {
    name: { type: 'string', required: true },
    retries: { type: 'number' },
    dryRun: { type: 'boolean', default: false },
  },
  nodes: {
    greet: {
      type: 'subagent',
      bot: 'claude-loopy',
      prompt: 'hello {{params.name}}',
    },
  },
};

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'wf-im-skill-'));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('/workflow command parsing', () => {
  it('parses /workflow run with key=value params', () => {
    expect(parseWorkflowCommand('/workflow run hello name=SF date=2026-05-19')).toEqual({
      kind: 'run',
      workflowId: 'hello',
      rawParams: { name: 'SF', date: '2026-05-19' },
    });
  });

  it('parses /workflow cancel with run id', () => {
    expect(parseWorkflowCommand('/workflow cancel hello-20260520-abcd1234')).toEqual({
      kind: 'cancel',
      runId: 'hello-20260520-abcd1234',
    });
  });

  it('rejects non key=value params', () => {
    expect(parseWorkflowCommand('/workflow run hello name')).toMatchObject({
      kind: 'invalid',
      error: expect.stringContaining('key=value'),
    });
  });

  it('rejects malformed cancel commands', () => {
    expect(parseWorkflowCommand('/workflow cancel')).toMatchObject({
      kind: 'invalid',
      error: expect.stringContaining('runId'),
    });
    expect(parseWorkflowCommand('/workflow cancel hello extra')).toMatchObject({
      kind: 'invalid',
      error: expect.stringContaining('只接受 runId'),
    });
    expect(parseWorkflowCommand('/workflow cancel ../escape')).toMatchObject({
      kind: 'invalid',
      error: expect.stringContaining('runId 只能包含'),
    });
  });

  it('coerces simple workflow params and rejects missing required values', () => {
    expect(coerceWorkflowParams(def, { name: 'alice', retries: '2', dryRun: 'true' })).toEqual({
      name: 'alice',
      retries: 2,
      dryRun: true,
    });

    expect(() => coerceWorkflowParams(def, {})).toThrow('缺少必填参数');
  });
});

describe('executeWorkflowCommand', () => {
  it('creates a run, attaches watcher, and drives the loop', async () => {
    const attachWorkflowEventWatcher = vi.fn((_runId: string, _ctx: WorkflowRuntimeContext) => ({
      ready: Promise.resolve(),
    }));
    const runLoopFn = vi.fn(async () => ({
      reason: 'awaiting-wait' as const,
      ticks: 1,
      lastSnapshot: {} as any,
    }));
    const onRunCreated = vi.fn();

    const result = await executeWorkflowCommand(
      {
        content: '/workflow run hello name=alice dryRun=true',
        chatId: 'oc_chat',
        larkAppId: 'cli_codex',
        initiator: 'ou_user',
      },
      {
        loadWorkflowDefinitionFn: async () => def,
        makeRunId: () => 'workflow-hello-test',
        makeEventLog: (runId) => new EventLog(runId, baseDir),
        botResolver: () => ({ larkAppId: 'cli_claude', cliId: 'claude-code', displayName: 'Claude' }),
        attachWorkflowEventWatcher,
        runLoopFn,
        onRunCreated,
      },
    );

    expect(result).toMatchObject({
      handled: true,
      ok: true,
      command: 'run',
      runId: 'workflow-hello-test',
    });
    expect(attachWorkflowEventWatcher).toHaveBeenCalledTimes(1);
    expect(onRunCreated.mock.invocationCallOrder[0]).toBeLessThan(runLoopFn.mock.invocationCallOrder[0]!);
    expect(runLoopFn).toHaveBeenCalledTimes(1);
  });

  it('returns a user-facing error when workflow loading fails', async () => {
    const result = await executeWorkflowCommand(
      {
        content: '/workflow run missing name=alice',
        chatId: 'oc_chat',
        larkAppId: 'cli_codex',
        initiator: 'ou_user',
      },
      {
        loadWorkflowDefinitionFn: async () => {
          throw new Error("Workflow 'missing' not found");
        },
      },
    );

    expect(result).toMatchObject({
      handled: true,
      ok: false,
      error: expect.stringContaining("Workflow 'missing' not found"),
    });
  });

  it('cancels a run through the daemon runtime hook', async () => {
    const cancelWorkflowRunFn = vi.fn(async () => ({
      ok: true as const,
      runId: 'hello-20260520-abcd1234',
      status: 'running',
      alreadyTerminal: false,
      pending: true,
      cancelEventId: 'hello-20260520-abcd1234-7',
      lastSeq: 7,
    }));

    const result = await executeWorkflowCommand(
      {
        content: '/workflow cancel hello-20260520-abcd1234',
        chatId: 'oc_chat',
        larkAppId: 'cli_codex',
        initiator: 'ou_user',
      },
      { cancelWorkflowRunFn },
    );

    expect(cancelWorkflowRunFn).toHaveBeenCalledWith(
      'hello-20260520-abcd1234',
      'cancelled via /workflow cancel',
    );
    expect(result).toEqual({
      handled: true,
      ok: true,
      command: 'cancel',
      runId: 'hello-20260520-abcd1234',
      status: 'running',
      alreadyTerminal: false,
      pending: true,
      cancelEventId: 'hello-20260520-abcd1234-7',
      lastSeq: 7,
    });
  });

  it('returns a user-facing error when cancel runtime hook rejects the run', async () => {
    const result = await executeWorkflowCommand(
      {
        content: '/workflow cancel missing-run',
        chatId: 'oc_chat',
        larkAppId: 'cli_codex',
        initiator: 'ou_user',
      },
      {
        cancelWorkflowRunFn: async () => ({
          ok: false,
          error: 'workflow_not_attached',
          status: 'running',
        }),
      },
    );

    expect(result).toMatchObject({
      handled: true,
      ok: false,
      error: 'workflow_not_attached',
    });
  });
});

describe('workflow approval card re-entry hook', () => {
  it('triggers workflowApprovalResolved after a non-duplicate approval click', async () => {
    const runId = 'workflow-hello-test';
    const cardNonce = workflowApprovalCardNonce(runId, 'gate-confirm', 'gate-confirm::att-1');
    const workflowApprovalResolved = vi.fn();

    await handleCardAction(
      {
        operator: { open_id: 'ou_approver' },
        action: {
          value: {
            action: WORKFLOW_APPROVE_ACTION,
            run_id: runId,
            activity_id: 'gate-confirm',
            attempt_id: 'gate-confirm::att-1',
            card_nonce: cardNonce,
          },
          form_value: { [WORKFLOW_COMMENT_FIELD]: 'ok' },
        },
        context: { open_message_id: 'om_card' },
      },
      {
        activeSessions: new Map(),
        sessionReply: vi.fn(),
        lastRepoScan: new Map(),
        workflowApprovalResolved,
        workflowApprovalDeps: {
          runsDir: baseDir,
          loadFrozenCardsFn: () => new Map(),
          saveFrozenCardsFn: () => undefined,
          resolveWaitFn: vi.fn(async () => ({
            resolutionEvent: { type: 'waitResolved' },
            terminalEvent: { type: 'activitySucceeded' },
          })) as any,
        },
      },
    );

    expect(workflowApprovalResolved).toHaveBeenCalledWith(runId);
  });
});
