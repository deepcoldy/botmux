import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventLog } from '../src/workflows/events/append.js';
import { replay } from '../src/workflows/events/replay.js';
import {
  parseWorkflowDefinition,
  computeRevisionId,
  type WorkflowDefinition,
} from '../src/workflows/definition.js';
import {
  createRun,
  type BotResolver,
  type BotSnapshot,
} from '../src/workflows/run-init.js';

function smallDef(): WorkflowDefinition {
  return parseWorkflowDefinition({
    workflowId: 'wf-init-test',
    version: 1,
    params: {
      who: { type: 'string', required: true },
    },
    nodes: {
      greet: {
        type: 'subagent',
        bot: 'claude-loopy',
        prompt: 'hello {{params.who}}',
      },
      followUp: {
        type: 'subagent',
        bot: 'codex-loopy',
        depends: ['greet'],
        prompt: 'follow up on {{greet.output}}',
      },
    },
  });
}

function fakeResolver(map: Record<string, BotSnapshot>): BotResolver {
  return (name) => map[name];
}

let baseDir: string;
const RUN_ID = 'run-init-test-01';

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'wf-runinit-'));
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('createRun', () => {
  it('writes runCreated + runStarted with bot snapshots and input blob', async () => {
    const def = smallDef();
    const log = new EventLog(RUN_ID, baseDir);
    const resolver = fakeResolver({
      'claude-loopy': {
        larkAppId: 'cli_claude',
        cliId: 'claude-code',
        displayName: 'Claude Loopy',
        workingDir: '/tmp/claude',
      },
      'codex-loopy': {
        larkAppId: 'cli_codex',
        cliId: 'codex',
        displayName: 'Codex Loopy',
        workingDir: '/tmp/codex',
      },
    });

    const result = await createRun(log, {
      def,
      params: { who: 'world' },
      initiator: 'ou_user',
      botResolver: resolver,
    });

    expect(result.runCreatedEvent.type).toBe('runCreated');
    expect(result.runStartedEvent.type).toBe('runStarted');

    const p = result.runCreatedEvent.payload;
    if ('ref' in p) throw new Error('expected inline payload');
    expect(p.workflowId).toBe('wf-init-test');
    expect(p.revisionId).toBe(computeRevisionId(def));
    expect(p.initiator).toBe('ou_user');
    expect(p.botSnapshots).toEqual({
      'claude-loopy': {
        larkAppId: 'cli_claude',
        cliId: 'claude-code',
        displayName: 'Claude Loopy',
        workingDir: '/tmp/claude',
      },
      'codex-loopy': {
        larkAppId: 'cli_codex',
        cliId: 'codex',
        displayName: 'Codex Loopy',
        workingDir: '/tmp/codex',
      },
    });

    // input blob exists and content matches
    expect(p.inputRef.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(p.inputRef.outputPath).toBeDefined();
    expect(existsSync(p.inputRef.outputPath!)).toBe(true);
    const blob = readFileSync(p.inputRef.outputPath!, 'utf-8');
    expect(JSON.parse(blob)).toEqual({ who: 'world' });
  });

  it('only snapshots subagent bots (hostExecutor nodes ignored)', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-mixed',
      version: 1,
      nodes: {
        sub: { type: 'subagent', bot: 'claude-loopy', prompt: 'x' },
        host: {
          type: 'hostExecutor',
          executor: 'feishu-send',
          input: { msg: 'hi' },
          depends: ['sub'],
        },
      },
    });
    const log = new EventLog(RUN_ID, baseDir);
    const resolver = fakeResolver({
      'claude-loopy': { cliId: 'claude-code', displayName: 'Claude' },
    });

    const { runCreatedEvent } = await createRun(log, {
      def,
      params: {},
      initiator: 'tester',
      botResolver: resolver,
    });

    const p = runCreatedEvent.payload;
    if ('ref' in p) throw new Error('expected inline payload');
    expect(Object.keys(p.botSnapshots ?? {})).toEqual(['claude-loopy']);
  });

  it('throws when a subagent bot is not registered', async () => {
    const def = smallDef();
    const log = new EventLog(RUN_ID, baseDir);
    const resolver = fakeResolver({
      'claude-loopy': { displayName: 'Claude' },
      // codex-loopy intentionally missing
    });
    await expect(
      createRun(log, {
        def,
        params: {},
        initiator: 'tester',
        botResolver: resolver,
      }),
    ).rejects.toThrow(/codex-loopy.*not found/);
  });

  it('replay sees both events with proper run.input', async () => {
    const def = smallDef();
    const log = new EventLog(RUN_ID, baseDir);
    const resolver = fakeResolver({
      'claude-loopy': { displayName: 'Claude' },
      'codex-loopy': { displayName: 'Codex' },
    });

    await createRun(log, {
      def,
      params: { who: 'replay' },
      initiator: 'tester',
      botResolver: resolver,
    });

    const events = await log.readAll();
    const snap = replay(events);
    expect(events.map((e) => e.type)).toEqual(['runCreated', 'runStarted']);
    expect(snap.run.status).toBe('running');
    expect(snap.run.input?.outputHash).toMatch(/^sha256:/);
  });

  it('input blob is content-addressed (idempotent on identical params)', async () => {
    const def = smallDef();
    const resolver = fakeResolver({
      'claude-loopy': {},
      'codex-loopy': {},
    });
    const log1 = new EventLog('run-a', baseDir);
    const log2 = new EventLog('run-b', baseDir);

    const r1 = await createRun(log1, {
      def,
      params: { who: 'same' },
      initiator: 't',
      botResolver: resolver,
    });
    const r2 = await createRun(log2, {
      def,
      params: { who: 'same' },
      initiator: 't',
      botResolver: resolver,
    });

    const p1 = r1.runCreatedEvent.payload;
    const p2 = r2.runCreatedEvent.payload;
    if ('ref' in p1 || 'ref' in p2) throw new Error('expected inline');
    expect(p1.inputRef.outputHash).toBe(p2.inputRef.outputHash);
  });
});
