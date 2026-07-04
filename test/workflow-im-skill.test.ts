import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { handleCardAction } from '../src/im/lark/card-handler.js';
import {
  coerceWorkflowParams,
  executeWorkflowCommand,
  parseWorkflowCommand,
  parseWorkflowGrillTrigger,
  buildWorkflowGrillPrompt,
} from '../src/im/lark/workflow-slash-command.js';
import {
  WORKFLOW_APPROVE_ACTION,
  WORKFLOW_CANCEL_ACTION,
  WORKFLOW_COMMENT_FIELD,
  workflowApprovalCardNonce,
} from '../src/im/lark/workflow-cards.js';
import { EventLog } from '../src/workflows/events/append.js';
import { replay } from '../src/workflows/events/replay.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';
import { createRun } from '../src/workflows/run-init.js';
import type { WorkflowRuntimeContext } from '../src/workflows/runtime.js';
import { requestCancel } from '../src/workflows/cancel.js';
import { guardWorkflowRunCancelChatScope } from '../src/workflows/cancel-run.js';

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

describe('/template (v2 模板) command parsing', () => {
  it('parses /template run with key=value params', () => {
    expect(parseWorkflowCommand('/template run hello name=SF date=2026-05-19')).toEqual({
      kind: 'run',
      workflowId: 'hello',
      rawParams: { name: 'SF', date: '2026-05-19' },
    });
  });

  it('parses /template cancel with run id', () => {
    expect(parseWorkflowCommand('/template cancel hello-20260520-abcd1234')).toEqual({
      kind: 'cancel',
      runId: 'hello-20260520-abcd1234',
    });
  });

  it('rejects non key=value params', () => {
    expect(parseWorkflowCommand('/template run hello name')).toMatchObject({
      kind: 'invalid',
      error: expect.stringContaining('key=value'),
    });
  });

  it('rejects malformed cancel commands', () => {
    expect(parseWorkflowCommand('/template cancel')).toMatchObject({
      kind: 'invalid',
      error: expect.stringContaining('runId'),
    });
    expect(parseWorkflowCommand('/template cancel hello extra')).toMatchObject({
      kind: 'invalid',
      error: expect.stringContaining('只接受 runId'),
    });
    expect(parseWorkflowCommand('/template cancel ../escape')).toMatchObject({
      kind: 'invalid',
      error: expect.stringContaining('runId 只能包含'),
    });
  });
});

describe('/workflow run|cancel legacy（软降级：仍解析为 v2，与 /template 同构）', () => {
  it('legacy /workflow run still parses as v2 run (改名提示由 daemon 从原始 content 判定)', () => {
    expect(parseWorkflowCommand('/workflow run hello name=SF')).toEqual({
      kind: 'run',
      workflowId: 'hello',
      rawParams: { name: 'SF' },
    });
  });

  it('legacy /workflow cancel still parses as v2 cancel', () => {
    expect(parseWorkflowCommand('/workflow cancel hello-20260520-abcd1234')).toEqual({
      kind: 'cancel',
      runId: 'hello-20260520-abcd1234',
    });
  });
});

describe('parseWorkflowGrillTrigger（/workflow 即兴 grill 入口）', () => {
  it('parses /workflow new <goal>', () => {
    expect(parseWorkflowGrillTrigger('/workflow new 调研三家竞品出对比报告')).toEqual({
      kind: 'goal',
      goal: '调研三家竞品出对比报告',
    });
  });

  it('parses bare /workflow <goal> (无 new 前缀)', () => {
    expect(parseWorkflowGrillTrigger('/workflow 把日志拉下来分析再出图')).toEqual({
      kind: 'goal',
      goal: '把日志拉下来分析再出图',
    });
  });

  it('returns usage for bare /workflow and /workflow new with no goal', () => {
    expect(parseWorkflowGrillTrigger('/workflow')).toEqual({ kind: 'usage' });
    expect(parseWorkflowGrillTrigger('/workflow   ')).toEqual({ kind: 'usage' });
    expect(parseWorkflowGrillTrigger('/workflow new')).toEqual({ kind: 'usage' });
    expect(parseWorkflowGrillTrigger('/workflow new   ')).toEqual({ kind: 'usage' });
  });

  it('does NOT swallow legacy run/cancel (那是 v2，返回 null)', () => {
    expect(parseWorkflowGrillTrigger('/workflow run hello name=SF')).toBeNull();
    expect(parseWorkflowGrillTrigger('/workflow cancel hello-x')).toBeNull();
  });

  it('returns null for non-/workflow and word-boundary mismatches', () => {
    expect(parseWorkflowGrillTrigger('/template run hello')).toBeNull();
    expect(parseWorkflowGrillTrigger('/workflowfoo bar')).toBeNull();
    expect(parseWorkflowGrillTrigger('帮我做个 workflow')).toBeNull();
  });

  it('buildWorkflowGrillPrompt embeds the goal and nudges the skill', () => {
    const prompt = buildWorkflowGrillPrompt('调研三家竞品');
    expect(prompt).toContain('botmux-workflow');
    expect(prompt).toContain('调研三家竞品');
  });
});

describe('workflow param coercion', () => {
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
      'cancelled via /template cancel',
      { expectedChatId: 'oc_chat', by: 'ou_user' },
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

  it('returns a cross-chat error when cancel runtime hook rejects chat ownership', async () => {
    const result = await executeWorkflowCommand(
      {
        content: '/workflow cancel other-chat-run',
        chatId: 'oc_chat_a',
        larkAppId: 'cli_codex',
        initiator: 'ou_user',
      },
      {
        cancelWorkflowRunFn: async (_runId, _reason, opts) => {
          expect(opts).toEqual({ expectedChatId: 'oc_chat_a', by: 'ou_user' });
          return {
            ok: false,
            error: 'wrong_chat',
            status: 'running',
          };
        },
      },
    );

    expect(result).toMatchObject({
      handled: true,
      ok: false,
      error: 'this run belongs to a different chat',
    });
  });

  it('does not write cancel intent when IM cancel comes from a different chat', async () => {
    const runId = 'cross-chat-run';
    const log = new EventLog(runId, baseDir);
    await createRun(log, {
      def,
      params: { name: 'alice' },
      initiator: 'ou_owner',
      botResolver: () => ({}),
      chatBinding: { chatId: 'oc_chat_a', larkAppId: 'cli_codex' },
    });

    const result = await executeWorkflowCommand(
      {
        content: `/workflow cancel ${runId}`,
        chatId: 'oc_chat_b',
        larkAppId: 'cli_codex',
        initiator: 'ou_user',
      },
      {
        cancelWorkflowRunFn: async (rid, reason, opts) => {
          const scope = await guardWorkflowRunCancelChatScope(baseDir, rid, opts?.expectedChatId ?? '');
          if (!scope.ok) return scope;
          const cancel = await requestCancel(
            log,
            {
              target: { kind: 'run', runId: rid },
              reason,
              by: opts?.by ?? 'unknown',
            },
            'human',
          );
          const snap = replay(await log.readAll());
          return {
            ok: true,
            runId: rid,
            status: snap.run.status,
            alreadyTerminal: false,
            cancelEventId: cancel.eventId,
            lastSeq: snap.lastSeq,
          };
        },
      },
    );

    expect(result).toMatchObject({
      handled: true,
      ok: false,
      error: 'this run belongs to a different chat',
    });
    expect(replay(await log.readAll()).cancelledRunIntent).toBeUndefined();
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

  it('triggers workflowApprovalResolved after a non-duplicate approval-card cancel click', async () => {
    const runId = 'workflow-hello-test';
    const cardNonce = workflowApprovalCardNonce(runId, 'gate-confirm', 'gate-confirm::att-1');
    const workflowApprovalResolved = vi.fn();

    await handleCardAction(
      {
        operator: { open_id: 'ou_approver' },
        action: {
          value: {
            action: WORKFLOW_CANCEL_ACTION,
            run_id: runId,
            activity_id: 'gate-confirm',
            attempt_id: 'gate-confirm::att-1',
            card_nonce: cardNonce,
          },
          form_value: { [WORKFLOW_COMMENT_FIELD]: 'stop' },
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
          requestCancelFn: vi.fn(async () => ({
            runId,
            eventId: `${runId}-7`,
            schemaVersion: 1,
            type: 'cancelRequested',
            timestamp: 1,
            actor: 'human',
            payload: {
              target: { kind: 'run', runId },
              reason: 'cancelled from approval card: stop',
              by: 'ou_approver',
            },
          })) as any,
        },
      },
    );

    expect(workflowApprovalResolved).toHaveBeenCalledWith(runId);
  });
});
