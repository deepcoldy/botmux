import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  triggerWorkflowRun,
  type TriggerDeps,
} from '../src/workflows/trigger-run.js';
import { parseWorkflowDefinition, type WorkflowDefinition } from '../src/workflows/definition.js';
import { EventLog } from '../src/workflows/events/append.js';
import { replay } from '../src/workflows/events/replay.js';
import type { WorkflowRuntimeContext, WorkerSpawnFn } from '../src/workflows/runtime.js';

const DEF = parseWorkflowDefinition({
  workflowId: 'trigger-demo',
  version: 1,
  params: {
    name: { type: 'string', required: true },
    count: { type: 'number' },
  },
  nodes: {
    approve: {
      type: 'subagent',
      bot: 'cli_owner',
      prompt: 'do',
      humanGate: { stage: 'before', prompt: 'ok?' },
    },
  },
});

let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'wf-trigger-run-'));
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

function makeDeps(overrides: Partial<TriggerDeps> = {}): TriggerDeps {
  const spawnSubagent: WorkerSpawnFn = async () => {
    throw new Error('spawn should not be reached for before humanGate');
  };
  const attached: Array<{ runId: string; ctx: WorkflowRuntimeContext }> = [];
  const drives: string[] = [];
  return {
    spawnSubagent,
    botResolver: () => ({ larkAppId: 'cli_owner', cliId: 'claude', displayName: 'owner' }),
    makeRuntimeContext: (log, def, spawn) => ({
      log,
      def,
      spawnSubagent: spawn,
    }),
    attachRuntime: (runId, ctx) => {
      attached.push({ runId, ctx });
      return {};
    },
    driveRun: (runId) => {
      drives.push(runId);
    },
    loadWorkflowDefinition: async (id: string) => {
      if (id !== DEF.workflowId) {
        throw new Error(`Workflow '${id}' not found. Looked in:\n- /nope`);
      }
      return DEF;
    },
    makeRunId: () => 'trigger-demo:test-run',
    makeEventLog: (runId) => new EventLog(runId, runsDir),
    ...overrides,
  };
}

describe('triggerWorkflowRun', () => {
  it('creates a pending run, attaches runtime ctx, and fires drive once', async () => {
    let attachedRunId = '';
    let driveCount = 0;
    const result = await triggerWorkflowRun(
      {
        workflowId: 'trigger-demo',
        rawParams: {
          name: { kind: 'json', value: 'alice' },
          count: { kind: 'json', value: 3 },
        },
        chatBinding: { chatId: 'oc_chat', larkAppId: 'cli_owner' },
        initiator: 'dashboard',
      },
      makeDeps({
        attachRuntime: (runId) => {
          attachedRunId = runId;
          return {};
        },
        driveRun: () => {
          driveCount += 1;
        },
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      runId: 'trigger-demo:test-run',
      workflowId: 'trigger-demo',
      // status reflects the post-runStarted snapshot, which is 'running' even
      // before the loop fires (drive is fire-and-forget).
      status: 'running',
    });
    expect(attachedRunId).toBe('trigger-demo:test-run');
    expect(driveCount).toBe(1);
    if (!result.ok) throw new Error('expected ok');
    const log = new EventLog(result.runId, runsDir);
    const events = await log.readAll();
    expect(events.map((e) => e.type)).toEqual(['runCreated', 'runStarted']);
    const snap = replay(events);
    expect(snap.lastSeq).toBe(result.lastSeq);
  });

  it('returns invalid_params with structured issues array', async () => {
    const result = await triggerWorkflowRun(
      {
        workflowId: 'trigger-demo',
        rawParams: {
          count: { kind: 'json', value: 'not a number' },
          ghost: { kind: 'json', value: 'oops' },
        },
        chatBinding: { chatId: 'oc_chat', larkAppId: 'cli_owner' },
        initiator: 'dashboard',
      },
      makeDeps(),
    );
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toBe('invalid_params');
    if (result.error !== 'invalid_params') return;
    const codes = result.issues.map((i) => i.code).sort();
    expect(codes).toContain('missing_required');
    expect(codes).toContain('type_mismatch');
    expect(codes).toContain('unknown_param');
    // All issues should carry the param name on the `path` array.
    for (const issue of result.issues) {
      expect(issue.path.length).toBe(1);
      expect(typeof issue.path[0]).toBe('string');
    }
  });

  it('returns unknown_workflow when loader signals not-found', async () => {
    const result = await triggerWorkflowRun(
      {
        workflowId: 'missing-def',
        rawParams: {},
        chatBinding: { chatId: 'oc_chat', larkAppId: 'cli_owner' },
        initiator: 'dashboard',
      },
      makeDeps(),
    );
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toBe('unknown_workflow');
  });

  it('returns load_definition_failed when loader throws non-not-found error', async () => {
    const result = await triggerWorkflowRun(
      {
        workflowId: 'trigger-demo',
        rawParams: { name: { kind: 'json', value: 'a' } },
        chatBinding: { chatId: 'oc_chat', larkAppId: 'cli_owner' },
        initiator: 'dashboard',
      },
      makeDeps({
        loadWorkflowDefinition: async () => {
          throw new Error('disk corruption');
        },
      }),
    );
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toBe('load_definition_failed');
  });

  it('writes the chatBinding sidecar in the run dir', async () => {
    const result = await triggerWorkflowRun(
      {
        workflowId: 'trigger-demo',
        rawParams: { name: { kind: 'json', value: 'alice' } },
        chatBinding: { chatId: 'oc_chat', larkAppId: 'cli_owner' },
        initiator: 'dashboard',
      },
      makeDeps(),
    );
    if (!result.ok) throw new Error('expected ok');
    const { readFileSync } = await import('node:fs');
    const bindingPath = join(runsDir, result.runId, 'chat-binding.json');
    const binding = JSON.parse(readFileSync(bindingPath, 'utf-8'));
    expect(binding).toEqual({ chatId: 'oc_chat', larkAppId: 'cli_owner' });
  });
});

void DEF satisfies WorkflowDefinition;
