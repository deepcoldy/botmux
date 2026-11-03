/**
 * Saved Workflow runs and the experimental node executor (design 2026-11-03
 * §6.3, §15.2): materialization freezes `nodeExecutor: "bot"` only with a
 * policy that resolves to bot, refuses (materializing nothing) when a node's
 * bot is ineligible, and is byte-for-byte today's path without a policy.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeSavedWorkflowGateDigest,
  type SavedWorkflowOwner,
  type SavedWorkflowRevisionDraft,
  type V3DagTemplate,
} from '../src/workflows/v3/library-schema.js';
import { createSavedWorkflow } from '../src/workflows/v3/library-store.js';
import { instantiatePublishedSavedWorkflow } from '../src/workflows/v3/library-service.js';
import { loadAuthorizedV3Run } from '../src/workflows/v3/run-envelope.js';
import type { V3NodeExecutorPolicy } from '../src/workflows/v3/node-executor-mode.js';
import { executeV3SavedWorkflowCommand, defaultV3SavedWorkflowExecutionServices } from '../src/im/lark/v3-saved-workflow-handler.js';

const OWNER: SavedWorkflowOwner = { openId: 'ou_owner', larkAppId: 'cli_main' };

function revision(): SavedWorkflowRevisionDraft {
  const dagTemplate: V3DagTemplate = {
    schemaVersion: 2,
    nodes: [
      { id: 'collect', type: 'goal', goal: 'collect', bot: 'cli_main', depends: [], inputs: [], humanGate: null },
      { id: 'write', type: 'goal', goal: 'write', bot: 'cli_doc', depends: ['collect'], inputs: [], humanGate: null },
    ],
  };
  return {
    inputs: {},
    contextRefs: [],
    specTemplate: {
      schemaVersion: 1,
      title: '周报',
      requirement: 'weekly report',
      nodes: [{ sketchId: 'write', goal: 'write', input_needs: [], expected_outputs: ['r.md'], acceptance: 'ok', risk_gate: false, unknowns: [] }],
    },
    specStatus: 'current',
    dagTemplate,
    safety: { gateDigest: computeSavedWorkflowGateDigest(dagTemplate), sideEffects: [] },
  };
}

const BOTS = [
  { larkAppId: 'cli_main', larkAppSecret: 's', cliId: 'claude-code', workingDir: '/live' },
  { larkAppId: 'cli_doc', larkAppSecret: 's', cliId: 'claude-code', workingDir: '/live' },
] as any[];

function context(chatType: 'group' | 'p2p' = 'group') {
  return { actor: OWNER, chatId: 'oc_a', chatType, rootMessageId: 'om_root', sessionId: 'session-1' };
}

function policy(overrides: Partial<V3NodeExecutorPolicy> = {}, notInChat: string[] = []): V3NodeExecutorPolicy {
  return {
    switchMode: 'bot',
    multiTopicEnabled: true,
    probe: () => ({
      isConfigured: () => true,
      isDaemonOnline: () => true,
      inChat: async (appId) => (notInChat.includes(appId) ? 'no' : 'yes'),
      opensTopicSessions: async () => 'yes',
      ensureGrant: async () => {},
    }),
    nameOf: (appId) => `bot(${appId})`,
    ...overrides,
  };
}

let root: string;
let dataDir: string;
let runsDir: string;
let workflowId: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'wf-saved-exec-'));
  dataDir = join(root, 'data');
  runsDir = join(root, 'runs');
  const created = await createSavedWorkflow(dataDir, {
    displayName: '周报',
    owner: OWNER,
    scope: { kind: 'chat', chatId: 'oc_a' },
    revision: revision(),
    publish: true,
    workflowId: 'wf_1234567890abcdef1234567890abcdef',
  });
  workflowId = created.metadata.workflowId;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function instantiate(extra: Record<string, unknown> = {}, ctx = context()) {
  return instantiatePublishedSavedWorkflow({
    dataDir, ref: workflowId, context: ctx, bots: BOTS, baseDir: runsDir, ...extra,
  });
}

function frozen(runDir: string): string | undefined {
  const envelope = loadAuthorizedV3Run(runDir).envelope;
  return 'nodeExecutor' in envelope ? envelope.nodeExecutor : undefined;
}

describe('Saved Workflow materialization — node executor', () => {
  it('without a policy the run is materialized exactly as before (no executor field)', async () => {
    const run = await instantiate();
    expect(frozen(run.runDir)).toBeUndefined();
    expect(run.executorNote).toBeUndefined();
  });

  it('a bot policy freezes "bot" and reports node → executing bot', async () => {
    const run = await instantiate({ nodeExecutorPolicy: policy() });
    expect(frozen(run.runDir)).toBe('bot');
    expect(run.executorNote).toMatch(/collect → bot\(cli_main\)/);
    expect(run.executorNote).toMatch(/write → bot\(cli_doc\)/);
  });

  it('an ineligible node bot refuses before anything is materialized', async () => {
    await expect(instantiate({ nodeExecutorPolicy: policy({}, ['cli_doc']) }))
      .rejects.toMatchObject({ code: 'executor_ineligible', message: expect.stringMatching(/write → bot\(cli_doc\)/) });
    expect(existsSync(runsDir) ? readdirSync(runsDir).filter((name) => !name.startsWith('.')) : []).toEqual([]);
  });

  it('P2-4: a revision with a directory output is refused before anything is materialized', async () => {
    const draft = revision();
    (draft.dagTemplate.nodes[1] as any).outputs = { site: { path: 'site', kind: 'directory' } };
    draft.safety.gateDigest = computeSavedWorkflowGateDigest(draft.dagTemplate);
    const created = await createSavedWorkflow(dataDir, {
      displayName: '站点', owner: OWNER, scope: { kind: 'chat', chatId: 'oc_a' }, revision: draft, publish: true,
      workflowId: 'wf_2234567890abcdef1234567890abcdef',
    });
    await expect(instantiatePublishedSavedWorkflow({
      dataDir, ref: created.metadata.workflowId, context: context(), bots: BOTS, baseDir: runsDir, nodeExecutorPolicy: policy(),
    })).rejects.toMatchObject({ code: 'executor_ineligible', message: expect.stringContaining('site') });
    expect(existsSync(runsDir) ? readdirSync(runsDir).filter((name) => !name.startsWith('.')) : []).toEqual([]);
  });

  it('a private chat keeps the ephemeral executor and explains why', async () => {
    const probe = vi.fn();
    const run = await instantiate({ nodeExecutorPolicy: policy({ probe }) }, context('p2p'));
    expect(frozen(run.runDir)).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
    expect(run.executorNote).toBeTruthy();
  });

  it('the IM handler passes the policy and appends the executor note to its reply', async () => {
    const started = vi.fn();
    const deps = {
      ...defaultV3SavedWorkflowExecutionServices,
      loadBots: () => BOTS,
      persistStartIntent: () => {},
      driveDetached: started,
      cancelAndDrive: () => {},
    };
    const command = { kind: 'run' as const, ref: workflowId, rawParams: {} };
    const plain = await executeV3SavedWorkflowCommand({ command, dataDir, baseDir: runsDir, context: context() }, deps);
    const withBots = await executeV3SavedWorkflowCommand(
      { command, dataDir, baseDir: runsDir, context: context() },
      { ...deps, nodeExecutorPolicy: () => policy() },
    );
    expect(plain.effect).toBe('run_started');
    expect(withBots.effect).toBe('run_started');
    expect(withBots.message).toMatch(/write → bot\(cli_doc\)/);
    expect(plain.message).not.toMatch(/→ bot\(/);
  });
});
