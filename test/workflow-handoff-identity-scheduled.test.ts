/**
 * 交接带发起人身份 never freezes a person who did not open the authorizing
 * turn (ADR dispatch-user-delegation §7: scheduled and other synthetic turns
 * carry no delegation). A scheduled task's turn authenticates as the task's
 * creator; running `/workflow run <saved>` or `approve-dag` in it must not make
 * that creator the run's initiator: the run is approved without an initiator
 * (design §10 principle), run.json records why, and its handoffs go out
 * unsigned (see workflow-handoff-identity.test.ts).
 *
 * Real components: the CLI process marker + persisted session rows +
 * schedules.json feeding the REAL current-turn provenance (`contextFromEnv`,
 * and approve-dag's default `chatBindingFromEnv` / `currentTurnIdFromEnv`),
 * Saved Workflow materialization and Gate-2 authorization.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { readProcessStartIdentity } from '../src/core/session-marker.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { contextFromEnv } from '../src/cli/saved-workflow.js';
import { createSavedWorkflow } from '../src/workflows/v3/library-store.js';
import { instantiatePublishedSavedWorkflow } from '../src/workflows/v3/library-service.js';
import { computeSavedWorkflowGateDigest, type SavedWorkflowRevisionDraft, type V3DagTemplate } from '../src/workflows/v3/library-schema.js';
import { frozenHandoffIdentity, loadAuthorizedV3Run } from '../src/workflows/v3/run-envelope.js';
import type { V3HandoffIdentityPolicy, V3NodeExecutorPolicy } from '../src/workflows/v3/node-executor-mode.js';
import { cmdWorkflowHost, hostApproveSpec, hostArchitect, hostNew, hostSpecFinalize, chatBindingFromEnv, type ArchitectDeps } from '../src/workflows/v3/host.js';
import { readGrillState } from '../src/workflows/v3/grill-state.js';
import { SPEC_SCHEMA_VERSION } from '../src/workflows/v3/contract.js';
import { v3SavedWorkflowMessageContext } from '../src/im/lark/v3-saved-workflow-handler.js';

const MAIN = 'cli_real';
const TASK_ID = 'abcdef12';
const SCHEDULED_TURN = `schedule:${TASK_ID}:12345678-1234-1234-1234-123456789abc`;
const HUMAN_TURN = 'om_owner_message';
const OWNER = 'ou_task_owner';
const BOTS = [
  { larkAppId: MAIN, name: 'main', cliId: 'claude-code', workingDir: '/tmp', triggerUserAuth: { enabled: true, tools: ['lark-cli', 'bytedcli'], fallback: 'none' } },
  { larkAppId: 'cli_doc', name: 'doc', cliId: 'claude-code', workingDir: '/tmp', triggerUserAuth: { enabled: true, tools: ['lark-cli', 'bytedcli'], fallback: 'none' } },
] as any[];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A session whose CLI process (`pid`) is running `turnId`: a scheduled task's
 *  turn (owned by OWNER) or OWNER's own message. */
function sessionTurn(turnId: string, pid: number) {
  const root = mkdtempSync(join(tmpdir(), 'wf-id-sched-'));
  dirs.push(root);
  const dataDir = join(root, 'sessions');
  mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
  writeFileSync(join(dataDir, '.botmux-cli-pids', String(pid)),
    JSON.stringify({ sessionId: 'sess-1', turnId, procStart: readProcessStartIdentity(pid)! }));
  seedPersistedSessionRows(dataDir, MAIN, { 'sess-1': {
    sessionId: 'sess-1', status: 'active', scope: 'thread', larkAppId: MAIN, chatId: 'oc_a', chatType: 'group',
    rootMessageId: 'om_root', ownerOpenId: 'ou_session_owner',
    // OWNER's own message is the live quote turn.
    ...(turnId === HUMAN_TURN ? { quoteTargetId: HUMAN_TURN, lastCallerOpenId: OWNER } : {}),
  } });
  const botDir = join(dirname(dataDir), 'bots', MAIN);
  mkdirSync(botDir, { recursive: true });
  writeFileSync(join(botDir, 'schedules.json'), JSON.stringify({ [TASK_ID]: {
    id: TASK_ID, name: 'nightly', chatId: 'oc_a', larkAppId: MAIN, ownerOpenId: OWNER, enabled: true,
  } }));
  return { root, dataDir };
}

function identityPolicy() {
  const asked: Array<[string, string]> = [];
  const policy: V3HandoffIdentityPolicy = {
    lookupUnionId: async (app, openId) => { asked.push([app, openId]); return { status: 'resolved', unionId: 'on_task_owner' }; },
    botTools: () => ['lark-cli', 'bytedcli'],
  };
  return { policy, asked };
}

describe('Saved Workflow run from a scheduled turn', () => {
  async function savedRun(turnId: string) {
    const { root, dataDir } = sessionTurn(turnId, process.pid);
    const context = contextFromEnv({ SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: 'sess-1' } as any, process.pid);
    expect(context.actor).toEqual({ larkAppId: MAIN, openId: OWNER });
    const dagTemplate: V3DagTemplate = { schemaVersion: 2, nodes: [
      { id: 'write', type: 'goal', goal: 'write', bot: 'cli_doc', depends: [], inputs: [], humanGate: null },
    ] };
    const revision = {
      inputs: {}, contextRefs: [],
      specTemplate: { schemaVersion: 1, title: '周报', requirement: 'weekly', nodes: [{ sketchId: 'write', goal: 'write', input_needs: [], expected_outputs: ['r.md'], acceptance: 'ok', risk_gate: false, unknowns: [] }] },
      specStatus: 'current', dagTemplate,
      safety: { gateDigest: computeSavedWorkflowGateDigest(dagTemplate), sideEffects: [] },
    } as unknown as SavedWorkflowRevisionDraft;
    const created = await createSavedWorkflow(join(root, 'data'), {
      displayName: '周报', owner: { openId: OWNER, larkAppId: MAIN }, scope: { kind: 'chat', chatId: 'oc_a' },
      revision, publish: true, workflowId: 'wf_1234567890abcdef1234567890abcdef',
    });
    const { policy: handoffIdentity, asked } = identityPolicy();
    const policy: V3NodeExecutorPolicy = {
      switchMode: 'bot', multiTopicEnabled: true,
      probe: () => ({ isConfigured: () => true, isDaemonOnline: () => true, inChat: async () => 'yes', opensTopicSessions: async () => 'yes', ensureGrant: async () => {} }),
      nameOf: (a) => a,
      handoffIdentity,
    };
    const run = instantiatePublishedSavedWorkflow({
      dataDir: join(root, 'data'), ref: created.metadata.workflowId, bots: BOTS, baseDir: join(root, 'runs'),
      context, nodeExecutorPolicy: policy,
    });
    return { run, asked };
  }

  it('is approved, but the task creator is never frozen as initiator', async () => {
    const { run, asked } = await savedRun(SCHEDULED_TURN);
    const materialized = await run;
    expect(asked).toEqual([]);
    const envelope = loadAuthorizedV3Run(materialized.runDir).envelope;
    expect(frozenHandoffIdentity(envelope)).toBeUndefined();
    expect(envelope.authorization).toMatchObject({ handoffIdentity: { unavailable: 'not_human_turn' } });
    expect(materialized.executorNote).toMatch(/这个 run 不带发起人身份.*write → cli_doc/);
  });

  it('the same person\'s own message does freeze them', async () => {
    const { run, asked } = await savedRun(HUMAN_TURN);
    const materialized = await run;
    expect(asked).toEqual([[MAIN, OWNER]]);
    expect(frozenHandoffIdentity(loadAuthorizedV3Run(materialized.runDir).envelope)).toMatchObject({ openId: OWNER, unionId: 'on_task_owner' });
  });
});

describe('/workflow run received as a Lark message', () => {
  const base = { initiatorOpenId: OWNER, larkAppId: MAIN, chatId: 'oc_a', chatType: 'group' as const, runRootMessageId: 'om_root' };
  it('only a person\'s own message may freeze them', () => {
    expect(v3SavedWorkflowMessageContext({ ...base, messageId: 'om_msg', botSender: false })).toMatchObject({ humanTurn: true, actor: { openId: OWNER } });
    expect(v3SavedWorkflowMessageContext({ ...base, messageId: 'om_msg', botSender: true }).humanTurn).toBe(false);
  });
});

describe('Gate-2 approve-dag from a scheduled turn (default current-turn provenance)', () => {
  /** A grill born in, and approved from, the turn `turnId` of OWNER's session;
   *  approve-dag reads the turn through its defaults (this process's parent
   *  is the "CLI" the marker names). */
  async function approveIn(turnId: string) {
    const { root, dataDir } = sessionTurn(turnId, process.ppid);
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
    vi.stubEnv('BOTMUX_SESSION_ID', 'sess-1');
    const binding = chatBindingFromEnv();
    expect(binding).toMatchObject({ larkAppId: MAIN, chatId: 'oc_a', ownerOpenId: OWNER });
    const base = join(root, 'runs');
    const { runDir, runId } = hostNew({ goal: 'g', baseDir: base, runId: 'r', chatBinding: binding! });
    writeFileSync(join(runDir, 'spec.md'), `# Spec\n\`\`\`json\n${JSON.stringify({
      schemaVersion: SPEC_SCHEMA_VERSION, runId, title: 't', requirement: 'r',
      nodes: [{ sketchId: 'write', goal: 'write', input_needs: [], expected_outputs: ['r.md'], acceptance: 'ok', risk_gate: false, unknowns: [] }],
    })}\n\`\`\`\n`);
    hostSpecFinalize(runDir);
    hostApproveSpec(runDir);
    const architect: ArchitectDeps = {
      runArchitect: async (input) => ({
        status: 'ok',
        dagPath: join(input.runDir, 'architect/attempts/001/work/dag.json'),
        notesPath: join(input.runDir, 'architect/attempts/001/work/architect-notes.md'),
        manifestPath: join(input.runDir, 'architect/attempts/001/manifest.json'),
      }),
      loadDag: () => ({ schemaVersion: 2, runId: 'r', nodes: [] }),
      botSnapshot: { larkAppId: MAIN, cliId: 'claude-code', workingDir: '/tmp' },
      resolveLarkAppSecret: () => undefined,
    };
    await hostArchitect(runDir, architect);
    const dagPath = readGrillState(runDir)!.dagPath!;
    mkdirSync(dirname(dagPath), { recursive: true });
    writeFileSync(dagPath, JSON.stringify({ schemaVersion: 2, runId: 'r', nodes: [
      { id: 'write', type: 'goal', goal: 'write', bot: 'cli_doc', depends: [], inputs: [] },
    ] }));
    const { policy, asked } = identityPolicy();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let error: unknown;
    await cmdWorkflowHost('approve-dag', ['r', '--base-dir', base], {
      loadBots: () => BOTS,
      nodeExecutorSwitch: () => 'bot',
      multiTopicEnabled: () => true,
      botEligibilityProbe: () => ({
        isConfigured: () => true, isDaemonOnline: () => true, inChat: async () => 'yes',
        opensTopicSessions: async () => 'yes', ensureGrant: async () => {},
      }),
      botDisplayName: () => (appId) => appId,
      handoffIdentitySwitch: () => true,
      handoffIdentityPolicy: () => policy,
    }).catch((err: unknown) => { error = err; });
    return { runDir, asked, error };
  }

  it('is approved without the initiator: run.json holds no identity, only why', async () => {
    const { runDir, asked, error } = await approveIn(SCHEDULED_TURN);
    expect(error).toBeUndefined();
    expect(asked).toEqual([]);
    const envelope = loadAuthorizedV3Run(runDir).envelope;
    expect(frozenHandoffIdentity(envelope)).toBeUndefined();
    expect(envelope.authorization).toMatchObject({ handoffIdentity: { unavailable: 'not_human_turn' } });
  });

  it('the initiator\'s own message approves and freezes them', async () => {
    const { runDir, asked, error } = await approveIn(HUMAN_TURN);
    expect(error).toBeUndefined();
    expect(asked).toEqual([[MAIN, OWNER]]);
    expect(frozenHandoffIdentity(loadAuthorizedV3Run(runDir).envelope)).toMatchObject({ openId: OWNER, unionId: 'on_task_owner' });
  });
});
