/**
 * 交接带发起人身份 at authorization (design 2026-11-03 §10.2 item 1, §15.5):
 * the Dashboard switch (default off, only `true` ever stored), Gate-2
 * `approve-dag` and Saved Workflow `/workflow run` freezing the initiator's
 * union_id and main-bot tools into run.json — or refusing the approval when
 * the initiator cannot be frozen — and doing nothing at all while it is off.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  cmdWorkflowHost,
  hostApproveSpec,
  hostArchitect,
  hostNew,
  hostSpecFinalize,
  type ArchitectDeps,
} from '../src/workflows/v3/host.js';
import { readGrillState, type RunChatBinding } from '../src/workflows/v3/grill-state.js';
import { SPEC_SCHEMA_VERSION } from '../src/workflows/v3/contract.js';
import { frozenHandoffIdentity, loadAuthorizedV3Run, readRunEnvelope } from '../src/workflows/v3/run-envelope.js';
import type { V3HandoffIdentityPolicy, V3InitiatorUnionLookup, V3NodeExecutorPolicy } from '../src/workflows/v3/node-executor-mode.js';
import {
  computeSavedWorkflowGateDigest,
  type SavedWorkflowRevisionDraft,
  type V3DagTemplate,
} from '../src/workflows/v3/library-schema.js';
import { createSavedWorkflow } from '../src/workflows/v3/library-store.js';
import { instantiatePublishedSavedWorkflow } from '../src/workflows/v3/library-service.js';
import {
  globalConfigPath,
  mergeGlobalConfig,
  readGlobalConfig,
  workflowHandoffIdentityEnabled,
} from '../src/global-config.js';
import { applySettingsWrite, type SettingsWriteApplierDeps } from '../src/dashboard/settings-write-applier.js';
import { liveV3NodeExecutorPolicy } from '../src/im/lark/v3-bot-eligibility.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const MAIN = 'cli_main';
const OWNER = 'ou_owner_in_main';
const BOTS = [
  { larkAppId: MAIN, name: 'main', cliId: 'claude-code', workingDir: '/tmp', triggerUserAuth: { enabled: true, tools: ['lark-cli', 'bytedcli'], fallback: 'none' } },
  { larkAppId: 'cli_doc', name: 'doc', cliId: 'claude-code', workingDir: '/tmp' },
] as any[];
const GROUP_TOPIC: RunChatBinding = { larkAppId: MAIN, chatId: 'oc_group', chatType: 'group', rootMessageId: 'om_root', ownerOpenId: OWNER };

/** Records what it was asked; answers `lookup` for the union_id. */
function identityPolicy(lookup: V3InitiatorUnionLookup | (() => never), tools: Array<'lark-cli' | 'bytedcli'> = ['lark-cli', 'bytedcli']) {
  const asked: Array<[string, string]> = [];
  const policy: V3HandoffIdentityPolicy = {
    lookupUnionId: async (appId, openId) => {
      asked.push([appId, openId]);
      return typeof lookup === 'function' ? lookup() : lookup;
    },
    // Only the main bot runs tools as its trigger user (as in BOTS).
    botTools: (appId) => (appId === MAIN ? tools : []),
  };
  return { policy, asked };
}

async function dagReadyRun(binding: RunChatBinding) {
  const base = mkdtempSync(join(tmpdir(), 'wf-id-approve-'));
  dirs.push(base);
  const { runDir, runId } = hostNew({ goal: 'g', baseDir: base, runId: 'r', chatBinding: binding });
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
    { id: 'inspect', type: 'goal', goal: 'inspect', depends: [], inputs: [] },
    { id: 'write', type: 'goal', goal: 'write', bot: 'cli_doc', depends: ['inspect'], inputs: [] },
  ] }));
  return { base, runDir };
}

async function approve(base: string, binding: RunChatBinding, opts: {
  nodeExecutor: 'ephemeral' | 'bot';
  handoffIdentity: boolean;
  policy?: V3HandoffIdentityPolicy;
  /** The approving turn (default: the owner's own message). */
  turnId?: string;
}) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const policyFactory = vi.fn(() => opts.policy ?? identityPolicy({ status: 'resolved', unionId: 'on_owner' }).policy);
  try {
    let error: unknown;
    await cmdWorkflowHost('approve-dag', ['r', '--base-dir', base], {
      loadBots: () => BOTS,
      resolveChatBinding: () => binding,
      nodeExecutorSwitch: () => opts.nodeExecutor,
      multiTopicEnabled: () => true,
      botEligibilityProbe: () => ({
        isConfigured: () => true, isDaemonOnline: () => true, inChat: async () => 'yes',
        opensTopicSessions: async () => 'yes', ensureGrant: async () => {},
      }),
      botDisplayName: () => (appId) => `bot(${appId})`,
      handoffIdentitySwitch: () => opts.handoffIdentity,
      handoffIdentityPolicy: policyFactory,
      resolveCurrentTurnId: () => opts.turnId ?? 'om_owner_approves',
    }).catch((err: unknown) => { error = err; });
    return { output: log.mock.calls.flat().join('\n'), policyFactory, error };
  } finally {
    log.mockRestore();
  }
}

function envelopeOf(runDir: string) {
  const read = readRunEnvelope(runDir);
  if (read.kind !== 'ok') throw new Error(`envelope ${read.kind}`);
  return read.envelope;
}

describe('Gate-2 approve-dag', () => {
  it('switch off: nothing frozen, no lookup, run.json identical to the pre-feature shape', async () => {
    const { base, runDir } = await dagReadyRun(GROUP_TOPIC);
    const off = await approve(base, GROUP_TOPIC, { nodeExecutor: 'bot', handoffIdentity: false });
    expect(off.error).toBeUndefined();
    expect(off.policyFactory).not.toHaveBeenCalled();
    expect(envelopeOf(runDir).authorization).not.toHaveProperty('handoffIdentity');
    expect(off.output).not.toContain('交接带发起人身份');
  });

  it('switch on: freezes the approver\'s union_id (looked up through the main app) and the main bot\'s tools', async () => {
    const { base, runDir } = await dagReadyRun(GROUP_TOPIC);
    const { policy, asked } = identityPolicy({ status: 'resolved', unionId: 'on_owner' }, ['lark-cli']);
    const on = await approve(base, GROUP_TOPIC, { nodeExecutor: 'bot', handoffIdentity: true, policy });
    expect(on.error).toBeUndefined();
    expect(asked).toEqual([[MAIN, OWNER]]);
    const envelope = envelopeOf(runDir);
    expect(envelope.authorization).toMatchObject({ authorizedByOpenId: OWNER, handoffIdentity: { unionId: 'on_owner', tools: ['lark-cli'] } });
    expect(frozenHandoffIdentity(envelope)).toEqual({ openId: OWNER, unionId: 'on_owner', tools: ['lark-cli'] });
    expect(on.output).toContain('交接带发起人身份：开');
    // A replayed approval never re-decides it.
    const replay = await approve(base, GROUP_TOPIC, { nodeExecutor: 'bot', handoffIdentity: false });
    expect(replay.error).toBeUndefined();
    expect(frozenHandoffIdentity(envelopeOf(runDir))).toEqual({ openId: OWNER, unionId: 'on_owner', tools: ['lark-cli'] });
  });

  it.each([
    ['a scheduled task', 'schedule:abcdef12:12345678-1234-1234-1234-123456789abc'],
    ['a synthetic trigger', 'trg_0123456789'],
    ['a workflow event wake-up', 'workflow-event:r:7'],
    ['no authenticated turn', undefined],
  ])('approval in %s turn is approved without the initiator (no lookup), and says so', async (_label, turnId) => {
    const { base, runDir } = await dagReadyRun(GROUP_TOPIC);
    const { policy, asked } = identityPolicy({ status: 'resolved', unionId: 'on_owner' });
    const approved = await approve(base, GROUP_TOPIC, { nodeExecutor: 'bot', handoffIdentity: true, policy, turnId: turnId ?? '' });
    expect(approved.error).toBeUndefined();
    expect(asked).toEqual([]);
    const envelope = envelopeOf(runDir);
    expect(envelope).toMatchObject({ nodeExecutor: 'bot', authorization: { handoffIdentity: { unavailable: 'not_human_turn' } } });
    expect(frozenHandoffIdentity(envelope)).toBeUndefined();
    // Names the node whose bot will ask for authorization later.
    const line = approved.output.split('\n').find((text) => text.includes('不带发起人身份')) ?? '';
    expect(line).toMatch(/这个 run 不带发起人身份：这次批准不是发起人本人.*inspect → bot\(cli_main\)/);
    expect(line).not.toContain('cli_doc');
  });

  it('without the bot executor the identity switch has nothing to freeze', async () => {
    const { base, runDir } = await dagReadyRun(GROUP_TOPIC);
    const run = await approve(base, GROUP_TOPIC, { nodeExecutor: 'ephemeral', handoffIdentity: true });
    expect(run.error).toBeUndefined();
    expect(run.policyFactory).not.toHaveBeenCalled();
    expect(envelopeOf(runDir)).not.toHaveProperty('nodeExecutor');
    expect(envelopeOf(runDir).authorization).not.toHaveProperty('handoffIdentity');
  });

  it.each([
    ['a definitive miss', { status: 'unavailable' } as V3InitiatorUnionLookup, '通讯录权限'],
    ['a transient failure', { status: 'retryable', error: 'timeout' } as V3InitiatorUnionLookup, '查询发起人的跨应用身份失败'],
  ])('%s still approves, without the initiator, saying why', async (_label, lookup, text) => {
    const { base, runDir } = await dagReadyRun(GROUP_TOPIC);
    const { policy } = identityPolicy(lookup);
    const approved = await approve(base, GROUP_TOPIC, { nodeExecutor: 'bot', handoffIdentity: true, policy });
    expect(approved.error).toBeUndefined();
    expect(envelopeOf(runDir).authorization).toMatchObject({
      handoffIdentity: { unavailable: lookup.status === 'unavailable' ? 'lookup_unavailable' : 'lookup_failed' },
    });
    expect(approved.output).toContain(text);
  });

  it('nothing to say when no node bot runs a tool as its trigger user', async () => {
    const { base, runDir } = await dagReadyRun(GROUP_TOPIC);
    const { policy } = identityPolicy({ status: 'resolved', unionId: 'on_owner' }, []);
    const approved = await approve(base, GROUP_TOPIC, { nodeExecutor: 'bot', handoffIdentity: true, policy });
    expect(approved.error).toBeUndefined();
    expect(envelopeOf(runDir).authorization).toMatchObject({ handoffIdentity: { unavailable: 'no_tools' } });
    expect(approved.output).not.toContain('发起人身份');
  });
});

describe('Saved Workflow /workflow run', () => {
  function revision(): SavedWorkflowRevisionDraft {
    const dagTemplate: V3DagTemplate = { schemaVersion: 2, nodes: [
      { id: 'write', type: 'goal', goal: 'write', bot: 'cli_doc', depends: [], inputs: [], humanGate: null },
    ] };
    return {
      inputs: {}, contextRefs: [],
      specTemplate: { schemaVersion: 1, title: '周报', requirement: 'weekly', nodes: [{ sketchId: 'write', goal: 'write', input_needs: [], expected_outputs: ['r.md'], acceptance: 'ok', risk_gate: false, unknowns: [] }] },
      specStatus: 'current', dagTemplate,
      safety: { gateDigest: computeSavedWorkflowGateDigest(dagTemplate), sideEffects: [] },
    };
  }
  const SENDER = { openId: 'ou_sender_in_main', larkAppId: MAIN };
  let root: string;
  let workflowId: string;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'wf-id-saved-'));
    dirs.push(root);
    const created = await createSavedWorkflow(join(root, 'data'), {
      displayName: '周报', owner: { openId: 'ou_author', larkAppId: MAIN }, scope: { kind: 'chat', chatId: 'oc_a' },
      revision: revision(), publish: true, workflowId: 'wf_1234567890abcdef1234567890abcdef',
    });
    workflowId = created.metadata.workflowId;
  });
  const executorPolicy = (handoffIdentity?: V3HandoffIdentityPolicy): V3NodeExecutorPolicy => ({
    switchMode: 'bot', multiTopicEnabled: true,
    probe: () => ({ isConfigured: () => true, isDaemonOnline: () => true, inChat: async () => 'yes', opensTopicSessions: async () => 'yes', ensureGrant: async () => {} }),
    nameOf: (appId) => appId,
    ...(handoffIdentity ? { handoffIdentity } : {}),
  });
  const instantiate = (policy: V3NodeExecutorPolicy) => instantiatePublishedSavedWorkflow({
    dataDir: join(root, 'data'), ref: workflowId, bots: BOTS, baseDir: join(root, 'runs'),
    context: { actor: SENDER, chatId: 'oc_a', chatType: 'group', rootMessageId: 'om_root', sessionId: 's', humanTurn: true },
    nodeExecutorPolicy: policy,
  });

  it('the initiator is the sender of /workflow run (chatBinding.ownerOpenId)', async () => {
    const { policy, asked } = identityPolicy({ status: 'resolved', unionId: 'on_sender' }, ['bytedcli']);
    const run = await instantiate(executorPolicy(policy));
    expect(asked).toEqual([[MAIN, SENDER.openId]]);
    expect(frozenHandoffIdentity(loadAuthorizedV3Run(run.runDir).envelope))
      .toEqual({ openId: SENDER.openId, unionId: 'on_sender', tools: ['bytedcli'] });
    expect(run.executorNote).toContain('交接带发起人身份：开');
  });

  it('switch off: nothing frozen', async () => {
    const run = await instantiate(executorPolicy());
    expect(frozenHandoffIdentity(loadAuthorizedV3Run(run.runDir).envelope)).toBeUndefined();
  });

  it('an unresolvable initiator still materializes the run, recording why it carries none', async () => {
    const { policy } = identityPolicy({ status: 'unavailable' });
    const run = await instantiate(executorPolicy(policy));
    const envelope = loadAuthorizedV3Run(run.runDir).envelope;
    expect(envelope.authorization).toMatchObject({ handoffIdentity: { unavailable: 'lookup_unavailable' } });
    expect(frozenHandoffIdentity(envelope)).toBeUndefined();
    // The only node's bot runs no tool as its trigger user: nothing to say.
    expect(run.executorNote ?? '').not.toContain('发起人身份');
  });
});


describe('Dashboard switch workflow.handoffIdentity', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wf-id-switch-'));
    dirs.push(home);
    vi.stubEnv('BOTMUX_GLOBAL_CONFIG_FILE', join(home, 'config.json'));
  });
  const deps = () => ({ readGlobalConfig, mergeGlobalConfig, resolveDashboardSettings: () => ({}) as any }) as unknown as SettingsWriteApplierDeps;
  const onDisk = () => (existsSync(globalConfigPath()) ? JSON.parse(readFileSync(globalConfigPath(), 'utf-8')) : {});

  it('defaults off; only true is stored, off removes the key; siblings are untouched', async () => {
    expect(workflowHandoffIdentityEnabled()).toBe(false);
    await applySettingsWrite({ workflow: { nodeExecutor: 'bot' } }, deps());
    expect(await applySettingsWrite({ workflow: { handoffIdentity: true } }, deps())).toMatchObject({ ok: true });
    expect(onDisk()).toEqual({ workflow: { nodeExecutor: 'bot', handoffIdentity: true } });
    expect(workflowHandoffIdentityEnabled()).toBe(true);
    await applySettingsWrite({ workflow: { handoffIdentity: false } }, deps());
    expect(onDisk()).toEqual({ workflow: { nodeExecutor: 'bot' } });
    expect(workflowHandoffIdentityEnabled()).toBe(false);
  });

  it('rejects a non-boolean without writing; a hand-edited non-true value reads as off', async () => {
    expect(await applySettingsWrite({ workflow: { handoffIdentity: 'yes' } }, deps()))
      .toEqual({ ok: false, error: 'invalid_workflow_handoffIdentity' });
    expect(onDisk()).toEqual({});
    mergeGlobalConfig({ workflow: { handoffIdentity: 'yes' as any } });
    expect(workflowHandoffIdentityEnabled()).toBe(false);
  });

  it('the live executor policy carries the identity seams only while the switch is on', () => {
    mergeGlobalConfig({ workflow: { nodeExecutor: 'bot' } });
    expect(liveV3NodeExecutorPolicy(BOTS)).not.toHaveProperty('handoffIdentity');
    mergeGlobalConfig({ workflow: { nodeExecutor: 'bot', handoffIdentity: true } });
    const policy = liveV3NodeExecutorPolicy(BOTS)!;
    expect(policy.handoffIdentity!.botTools(MAIN)).toEqual(['lark-cli', 'bytedcli']);
    expect(policy.handoffIdentity!.botTools('cli_doc')).toEqual([]);
  });
});
