import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkflowDefinition } from '../src/workflows/definition.js';
import { EventLog } from '../src/workflows/events/append.js';
import { scanColdWorkflowRuns } from '../src/workflows/cold-scan.js';
import { createRun } from '../src/workflows/run-init.js';
import { runLoop } from '../src/workflows/loop.js';
import type { WorkerSpawnFn } from '../src/workflows/runtime.js';

let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'wf-cold-scan-'));
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

const def = parseWorkflowDefinition({
  workflowId: 'cold-scan-demo',
  version: 1,
  nodes: {
    only: { type: 'subagent', bot: 'b', prompt: 'x' },
  },
});

const successSpawn: WorkerSpawnFn = async (input) => ({
  kind: 'success',
  output: { ok: true },
  session: {
    sessionId: `s-${input.activityId}`,
    botName: input.botName,
    startedAt: 1,
    endedAt: 2,
  },
});

describe('scanColdWorkflowRuns', () => {
  it('returns non-terminal runs owned by this daemon larkAppId', async () => {
    const log = new EventLog('run-active', runsDir);
    await createRun(log, {
      def,
      params: {},
      initiator: 'test',
      botResolver: () => ({}),
      chatBinding: { chatId: 'oc_a', larkAppId: 'cli_owner' },
    });

    const runs = await scanColdWorkflowRuns({
      runsDir,
      ownerLarkAppId: 'cli_owner',
    });

    expect(runs.map((r) => r.runId)).toEqual(['run-active']);
    expect(runs[0]!.def.workflowId).toBe('cold-scan-demo');
    expect(runs[0]!.binding.chatId).toBe('oc_a');
    expect(runs[0]!.snapshot.run.status).toBe('running');
  });

  it('skips terminal, CLI-only, and other-daemon runs', async () => {
    const terminal = new EventLog('run-terminal', runsDir);
    await createRun(terminal, {
      def,
      params: {},
      initiator: 'test',
      botResolver: () => ({}),
      chatBinding: { chatId: 'oc_done', larkAppId: 'cli_owner' },
    });
    await runLoop({
      log: terminal,
      def,
      spawnSubagent: successSpawn,
    });

    const cliOnly = new EventLog('run-cli-only', runsDir);
    await createRun(cliOnly, {
      def,
      params: {},
      initiator: 'test',
      botResolver: () => ({}),
    });

    const otherOwner = new EventLog('run-other-owner', runsDir);
    await createRun(otherOwner, {
      def,
      params: {},
      initiator: 'test',
      botResolver: () => ({}),
      chatBinding: { chatId: 'oc_other', larkAppId: 'cli_other' },
    });

    const skipped: Array<{ runId: string; reason: string }> = [];
    const runs = await scanColdWorkflowRuns({
      runsDir,
      ownerLarkAppId: 'cli_owner',
      onSkip: (runId, reason) => skipped.push({ runId, reason }),
    });

    expect(runs).toEqual([]);
    expect(skipped).toEqual(
      expect.arrayContaining([
        { runId: 'run-terminal', reason: 'terminal-succeeded' },
        { runId: 'run-cli-only', reason: 'missing-or-invalid-chat-binding' },
        { runId: 'run-other-owner', reason: 'owned-by-another-lark-app' },
      ]),
    );
  });
});
