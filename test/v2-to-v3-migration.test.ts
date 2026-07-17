import { describe, expect, it } from 'vitest';

import type { BotConfig } from '../src/bot-registry.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';
import { convertLegacyWorkflowDefinition } from '../src/workflows/migration/v2-to-v3.js';
import { buildSavedWorkflowRevision } from '../src/workflows/v3/library-schema.js';

const BOT: BotConfig = {
  larkAppId: 'cli_goal',
  larkAppSecret: 'secret',
  cliId: 'codex',
  workingDir: '/repo',
};

function baseDefinition(): WorkflowDefinition {
  return {
    workflowId: 'legacy-report',
    version: 1,
    params: {
      city: { type: 'string', required: true, description: 'target city' },
    },
    nodes: {
      research: {
        type: 'subagent',
        bot: BOT.larkAppId,
        prompt: 'Research ${params.city}',
        modelOverrides: { model: 'gpt-5' },
        outputSchema: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
        },
      },
      review: {
        type: 'subagent',
        bot: BOT.larkAppId,
        prompt: 'Review the completed research stage',
        depends: ['research'],
        humanGate: { stage: 'before', prompt: 'Approve review?', approvers: ['ou_reviewer'] },
      },
    },
  };
}

function codes(result: ReturnType<typeof convertLegacyWorkflowDefinition>): string[] {
  return result.issues.map((item) => item.code);
}

describe('v2 -> v3 Saved Workflow conversion', () => {
  it('maps the supported goal/params/model/gate/schema subset into a valid revision', () => {
    const result = convertLegacyWorkflowDefinition({ definition: baseDefinition(), bots: [BOT] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issues).toEqual([]);
    expect(result.revision.inputs).toEqual({
      city: { type: 'string', required: true, description: 'target city' },
    });
    expect(result.revision.specStatus).toBe('stale');
    expect(result.revision.dagTemplate.nodes).toMatchObject([
      {
        id: 'research',
        type: 'goal',
        goal: 'Research ${params.city}',
        bot: 'cli_goal',
        depends: [],
        inputs: [],
        override: { model: 'gpt-5' },
        resultSchema: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
        },
      },
      {
        id: 'review',
        type: 'goal',
        depends: [{ from: 'research' }],
        humanGate: {
          prompt: 'Approve review?',
          options: ['approve', 'reject'],
          approveOptions: ['approve'],
          approvers: ['ou_reviewer'],
        },
      },
    ]);
    expect(() => buildSavedWorkflowRevision({
      ...result.revision,
      workflowId: `wf_${'a'.repeat(32)}`,
      humanVersion: 1,
      createdAt: '2026-07-11T00:00:00.000Z',
      createdBy: { openId: 'ou_owner', larkAppId: 'cli_owner' },
    })).not.toThrow();
  });

  it('fails loudly for output/whole-field/nested parameter bindings', () => {
    const output = baseDefinition();
    (output.nodes.research as any).prompt = 'Use ${upstream.output.value}';
    expect(codes(convertLegacyWorkflowDefinition({ definition: output, bots: [BOT] })))
      .toContain('OUTPUT_BINDING_UNSUPPORTED');

    const whole = baseDefinition();
    (whole.nodes.research as any).prompt = { $ref: 'params.city' };
    expect(codes(convertLegacyWorkflowDefinition({ definition: whole, bots: [BOT] })))
      .toContain('WHOLE_FIELD_REF_UNSUPPORTED');

    const nested = baseDefinition();
    nested.params!.city = { type: 'object', required: true };
    (nested.nodes.research as any).prompt = 'Use ${params.city.name}';
    expect(codes(convertLegacyWorkflowDefinition({ definition: nested, bots: [BOT] })))
      .toContain('NESTED_PARAM_BINDING_UNSUPPORTED');
  });

  it('covers decision loops and capability fields with stable fail-loud codes', () => {
    const def = baseDefinition();
    (def.nodes.research as any).workingDir = '/tmp/other';
    (def.nodes.research as any).toolPolicy = { allow: ['Read'] };
    (def.nodes.research as any).modelOverrides.reasoningEffort = 'high';
    def.defaults = { maxConcurrency: 1 };
    expect(codes(convertLegacyWorkflowDefinition({ definition: def, bots: [BOT] })))
      .toEqual(expect.arrayContaining([
        'NODE_WORKING_DIR_UNSUPPORTED',
        'TOOL_POLICY_UNSUPPORTED',
        'REASONING_EFFORT_UNSUPPORTED',
        'MAX_CONCURRENCY_UNSUPPORTED',
      ]));

    const loop: WorkflowDefinition = {
      workflowId: 'loop',
      version: 1,
      nodes: {
        work: { type: 'subagent', bot: BOT.larkAppId, prompt: 'work' },
        decide: {
          type: 'decision',
          depends: ['work'],
          humanGate: { stage: 'before', prompt: 'continue?' },
        },
        cycle: {
          type: 'loop',
          maxIterations: 2,
          body: ['work', 'decide'],
          terminate: { node: 'decide', via: 'humanGate' },
          output: { from: 'work' },
        },
      },
    };
    expect(codes(convertLegacyWorkflowDefinition({ definition: loop, bots: [BOT] })))
      .toContain('DECISION_LOOP_UNSUPPORTED');
  });

  it('requires exact larkAppId, v3 CLI allowlist, and bypass permission', () => {
    const byName = baseDefinition();
    (byName.nodes.research as any).bot = 'goal-name';
    (byName.nodes.review as any).bot = 'goal-name';
    expect(codes(convertLegacyWorkflowDefinition({
      definition: byName,
      bots: [{ ...BOT, name: 'goal-name' }],
    }))).toContain('BOT_SELECTOR_NOT_STABLE');

    expect(codes(convertLegacyWorkflowDefinition({
      definition: baseDefinition(),
      bots: [{ ...BOT, cliId: 'gemini' }],
    }))).toContain('CLI_NOT_SUPPORTED');

    expect(codes(convertLegacyWorkflowDefinition({
      definition: baseDefinition(),
      bots: [{ ...BOT, disableCliBypass: true }],
    }))).toContain('BOT_PERMISSION_UNSUPPORTED');
  });

  it('makes inert v2 goal timeouts explicit and drops inert host timeouts', () => {
    const goals = baseDefinition();
    goals.defaults = { timeoutMs: 5_000 };
    (goals.nodes.research as any).timeoutMs = 3_000;
    const convertedGoals = convertLegacyWorkflowDefinition({ definition: goals, bots: [BOT] });
    expect(codes(convertedGoals)).toEqual(expect.arrayContaining([
      'DEFAULT_TIMEOUT_BECOMES_EFFECTIVE',
      'NODE_TIMEOUT_BECOMES_EFFECTIVE',
    ]));
    expect(convertedGoals.ok).toBe(true);
    if (convertedGoals.ok) {
      expect(convertedGoals.revision.dagTemplate.nodes).toMatchObject([
        { id: 'research', timeoutSec: 3 },
        { id: 'review', timeoutSec: 5 },
      ]);
    }

    const host: WorkflowDefinition = {
      workflowId: 'legacy-host-timeout',
      version: 1,
      nodes: {
        send: {
          type: 'hostExecutor',
          executor: 'feishu-send',
          input: { larkAppId: 'cli_sender', chatId: 'oc_target', content: 'hello' },
          humanGate: { stage: 'before', prompt: 'Send?' },
          timeoutMs: 5_000,
        },
      },
    };
    const convertedHost = convertLegacyWorkflowDefinition({
      definition: host,
      bots: [],
      target: {
        owner: { openId: 'ou_owner', larkAppId: 'cli_sender' },
        scope: { kind: 'chat', chatId: 'oc_target' },
        chatType: 'group',
      },
    });
    expect(codes(convertedHost)).toContain('INERT_HOST_TIMEOUT_DROPPED');
    expect(convertedHost.ok).toBe(true);
    if (convertedHost.ok) {
      expect(convertedHost.revision.dagTemplate.nodes[0]).not.toHaveProperty('timeoutSec');
    }
  });

  it('losslessly rewrites an exact chat-scoped feishu-send target to authenticated context', () => {
    const def: WorkflowDefinition = {
      workflowId: 'legacy-send',
      version: 1,
      nodes: {
        send: {
          type: 'hostExecutor',
          executor: 'feishu-send',
          input: {
            larkAppId: 'cli_sender',
            chatId: 'oc_target',
            content: 'hello',
          },
          humanGate: { stage: 'before', prompt: 'Send hello?' },
        },
      },
    };
    const result = convertLegacyWorkflowDefinition({
      definition: def,
      bots: [],
      target: {
        owner: { openId: 'ou_owner', larkAppId: 'cli_sender' },
        scope: { kind: 'chat', chatId: 'oc_target' },
        chatType: 'group',
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revision.dagTemplate.nodes[0]).toMatchObject({
      type: 'host',
      executor: 'feishu-send',
      input: {
        larkAppId: { $ref: 'context.larkAppId' },
        chatId: { $ref: 'context.chatId' },
        content: 'hello',
      },
    });
    expect(() => buildSavedWorkflowRevision({
      ...result.revision,
      workflowId: `wf_${'b'.repeat(32)}`,
      humanVersion: 1,
      createdAt: '2026-07-11T00:00:00.000Z',
      createdBy: { openId: 'ou_owner', larkAppId: 'cli_sender' },
    })).not.toThrow();
  });

  it('rejects global/mismatched/fixed-root host migrations and reports explicit warnings', () => {
    const send: WorkflowDefinition = {
      workflowId: 'legacy-send',
      version: 1,
      defaults: {
        retryPolicy: { maxAttempts: 1, backoff: 'fixed', baseMs: 100 },
        maxOutputBytes: 1000,
      },
      nodes: {
        send: {
          type: 'hostExecutor',
          executor: 'feishu-reply',
          input: { larkAppId: 'cli_sender', rootMessageId: 'om_fixed', content: 'hello' },
          humanGate: { stage: 'before', prompt: 'Reply?', onTimeout: 'fail' },
        },
      },
    };
    const result = convertLegacyWorkflowDefinition({ definition: send, bots: [] });
    expect(codes(result)).toEqual(expect.arrayContaining([
      'HOST_CHAT_SCOPE_REQUIRED',
      'FIXED_REPLY_TARGET_UNSUPPORTED',
      'INERT_RETRY_POLICY_DROPPED',
      'MAX_OUTPUT_BYTES_DROPPED',
      'INERT_GATE_TIMEOUT_DROPPED',
    ]));
  });
});
