/**
 * run.json initiator + second-confirmation record (design 2026-11-03
 * workflow-dashboard-orchestration §4.4 / §7.3, I11) and the flow summary
 * they pin.
 *
 *   - schema: both keys only on a bot-executed run, consistent with the
 *     identities already on the run, digest verified;
 *   - Feishu Gate-2 `approve-dag`: writes them only for a bot run; the
 *     confirmer only when a human message opened the approving turn;
 *     switch off ⇒ the authorization has exactly the pre-feature keys;
 *   - Feishu `/workflow run` (Saved Workflow): the initiator is the sender,
 *     bot runs only, union_id only when already resolved;
 *   - flow summary: a function of the confirmed facts, not of listing order,
 *     display names or hint wording.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  makeAdHocRunEnvelope,
  makeSavedDefinitionRunEnvelope,
  readRunEnvelope,
  RunEnvelopeValidationError,
  type Sha256Digest,
} from '../src/workflows/v3/run-envelope.js';
import {
  buildV3FlowSummary,
  canonicalV3FlowSummary,
  v3FlowSummarySha256,
  type V3FlowSummary,
} from '../src/workflows/v3/flow-summary.js';
import type { V3Gate2BotPlan } from '../src/workflows/v3/bot-assignment.js';
import { readProcessStartIdentity } from '../src/core/session-marker.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import type { V3Node } from '../src/workflows/v3/dag.js';
import type { V3HandoffIdentityPolicy, V3InitiatorUnionLookup, V3NodeExecutorPolicy } from '../src/workflows/v3/node-executor-mode.js';
import {
  computeSavedWorkflowGateDigest,
  type SavedWorkflowRevisionDraft,
  type V3DagTemplate,
} from '../src/workflows/v3/library-schema.js';
import { createSavedWorkflow } from '../src/workflows/v3/library-store.js';
import { instantiatePublishedSavedWorkflow } from '../src/workflows/v3/library-service.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const MAIN = 'cli_main';
const OWNER = 'ou_owner_in_main';
const BOTS = [
  { larkAppId: MAIN, name: 'main', cliId: 'claude-code', workingDir: '/tmp', triggerUserAuth: { enabled: true, tools: ['lark-cli'], fallback: 'none' } },
  { larkAppId: 'cli_doc', name: 'doc', cliId: 'codex', workingDir: '/tmp' },
] as any[];
const GROUP_TOPIC: RunChatBinding = { larkAppId: MAIN, chatId: 'oc_group', chatType: 'group', rootMessageId: 'om_root', ownerOpenId: OWNER };

const DAG_NODES: V3Node[] = [
  { id: 'inspect', type: 'goal', goal: 'inspect', depends: [], inputs: [] } as V3Node,
  { id: 'write', type: 'goal', goal: 'write', bot: 'cli_doc', depends: ['inspect'], inputs: [], humanGate: { approvers: 'initiator' } } as unknown as V3Node,
];

async function dagReadyRun(opts: { dagNodes?: unknown[]; specNodes?: unknown[]; binding?: RunChatBinding } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'wf-confirm-'));
  dirs.push(base);
  const { runDir, runId } = hostNew({ goal: 'g', baseDir: base, runId: 'r', chatBinding: opts.binding ?? GROUP_TOPIC });
  writeFileSync(join(runDir, 'spec.md'), `# Spec\n\`\`\`json\n${JSON.stringify({
    schemaVersion: SPEC_SCHEMA_VERSION, runId, title: 't', requirement: 'r',
    nodes: opts.specNodes ?? [{ sketchId: 'write', goal: 'write', input_needs: [], expected_outputs: ['r.md'], acceptance: 'ok', risk_gate: false, unknowns: [], assignee: 'main' }],
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
  const state = readGrillState(runDir)!;
  mkdirSync(dirname(state.dagPath!), { recursive: true });
  writeFileSync(state.dagPath!, JSON.stringify({ schemaVersion: 2, runId: 'r', nodes: opts.dagNodes ?? [
    { id: 'inspect', type: 'goal', goal: 'inspect', depends: [], inputs: [] },
    { id: 'write', type: 'goal', goal: 'write', bot: 'cli_doc', depends: ['inspect'], inputs: [] },
  ] }));
  writeFileSync(state.notesPath!, '## Bot assignments\n- write → cli_doc: 擅长写文档\n');
  return { base, runDir };
}

async function approve(base: string, opts: {
  nodeExecutor: 'ephemeral' | 'bot';
  handoffIdentity?: boolean;
  turnId?: string;
  caller?: RunChatBinding;
  /** The confirmer seam; 'live' = the production resolver over the seeded
   *  provenance (see seedTurn). Default: nobody. */
  confirmer?: (() => string | undefined) | 'live';
}) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const policy: V3HandoffIdentityPolicy = {
    lookupUnionId: async () => ({ status: 'resolved', unionId: 'on_owner' }),
    botTools: (appId) => (appId === MAIN ? ['lark-cli'] : []),
  };
  try {
    await cmdWorkflowHost('approve-dag', ['r', '--base-dir', base], {
      loadBots: () => BOTS,
      resolveChatBinding: () => opts.caller ?? GROUP_TOPIC,
      nodeExecutorSwitch: () => opts.nodeExecutor,
      multiTopicEnabled: () => true,
      botEligibilityProbe: () => ({
        isConfigured: () => true, isDaemonOnline: () => true, inChat: async () => 'yes',
        opensTopicSessions: async () => 'yes', ensureGrant: async () => {},
      }),
      botDisplayName: () => (appId) => `bot(${appId})`,
      handoffIdentitySwitch: () => opts.handoffIdentity === true,
      handoffIdentityPolicy: () => policy,
      resolveCurrentTurnId: () => opts.turnId ?? 'om_owner_approves',
      ...(opts.confirmer === 'live' ? {} : { resolveCurrentTurnConfirmer: opts.confirmer ?? (() => undefined) }),
    });
  } finally {
    log.mockRestore();
  }
}

function envelopeOf(runDir: string) {
  const read = readRunEnvelope(runDir);
  if (read.kind !== 'ok') throw new Error(`envelope ${read.kind}`);
  return read.envelope;
}

describe('Gate-2 approve-dag records initiator and confirmation', () => {
  it('bot run, human turn: initiator (feishu), confirmer, time and the summary of what was frozen', async () => {
    const { base, runDir } = await dagReadyRun();
    await approve(base, { nodeExecutor: 'bot', confirmer: () => OWNER });
    const auth = envelopeOf(runDir).authorization as any;
    expect(auth.initiator).toEqual({ openId: OWNER, source: 'feishu' });
    expect(auth.flowConfirmation).toMatchObject({ confirmedByOpenId: OWNER, confirmedAt: auth.authorizedAt });
    expect(auth.flowConfirmation.flowSummary).toEqual({
      version: 1,
      nodes: [
        { nodeId: 'inspect', larkAppId: MAIN, cli: 'claude-code' },
        { nodeId: 'write', larkAppId: 'cli_doc', cli: 'codex', reason: '擅长写文档', missedAssignee: 'main' },
      ],
      unplacedAssignees: [],
      sideEffects: [],
      gateDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(auth.flowConfirmation.flowSummarySha256).toBe(v3FlowSummarySha256(auth.flowConfirmation.flowSummary));
  });

  it('with 交接带发起人身份 on, the initiator carries the union_id already resolved for it', async () => {
    const { base, runDir } = await dagReadyRun();
    await approve(base, { nodeExecutor: 'bot', handoffIdentity: true });
    expect((envelopeOf(runDir).authorization as any).initiator).toEqual({ openId: OWNER, unionId: 'on_owner', source: 'feishu' });
  });

  it.each<[string, () => string | undefined]>([
    ['the turn is unknown', () => undefined],
    ['resolving the turn throws', () => { throw new Error('当前命令已脱离 botmux CLI 进程树'); }],
    ['the turn names someone other than the initiator', () => 'ou_someone_else'],
  ])('when %s: approved, no confirmer written (not guessed)', async (_label, confirmer) => {
    const { base, runDir } = await dagReadyRun();
    await approve(base, { nodeExecutor: 'bot', confirmer });
    const auth = envelopeOf(runDir).authorization as any;
    expect(readGrillState(runDir)!.status).toBe('dag_approved');
    expect(auth.flowConfirmation).toBeDefined();
    expect(auth.flowConfirmation).not.toHaveProperty('confirmedByOpenId');
    expect(auth.initiator).toEqual({ openId: OWNER, source: 'feishu' });
  });

  it('long ids the DAG/spec allow (loop `<loop>.<body>`, sketch ids) are still approved in bot mode', async () => {
    const loop = 'L'.repeat(130);
    const body = 'b'.repeat(130);
    const sketch = 's'.repeat(300);
    const sketchOf = (sketchId: string, extra: Record<string, unknown> = {}) => ({
      sketchId, goal: sketchId, input_needs: [], expected_outputs: ['r.md'], acceptance: 'ok', risk_gate: false, unknowns: [], ...extra,
    });
    const { base, runDir } = await dagReadyRun({
      specNodes: [sketchOf(body), sketchOf(sketch, { assignee: 'ghost' })],
      dagNodes: [{
        id: loop, type: 'loop', depends: [], inputs: [], bot: 'cli_doc', maxIterations: 2,
        exit: { node: body, when: { path: 'result.ok', equals: true } }, output: { from: body },
        body: { nodes: [{ id: body, type: 'goal', goal: 'x', depends: [], inputs: [], resultSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }] },
      }],
    });
    await approve(base, { nodeExecutor: 'bot', confirmer: () => OWNER });
    expect(readGrillState(runDir)!.status).toBe('dag_approved');
    const summary = (envelopeOf(runDir).authorization as any).flowConfirmation.flowSummary;
    expect(summary.nodes.map((node: { nodeId: string }) => node.nodeId)).toEqual([`${loop}.${body}`]);
    expect(summary.unplacedAssignees).toEqual([{ kind: 'unresolved', sketchId: sketch, assignee: 'ghost' }]);
  });

  it('a bot run with no authenticated initiator (no ou_ owner on the binding) is approved without either record', async () => {
    const ownerless: RunChatBinding = { larkAppId: MAIN, chatId: 'oc_group', chatType: 'group', rootMessageId: 'om_root' };
    const { base, runDir } = await dagReadyRun({ binding: ownerless });
    await approve(base, { nodeExecutor: 'bot', caller: ownerless, confirmer: () => OWNER });
    expect(readGrillState(runDir)!.status).toBe('dag_approved');
    const envelope = envelopeOf(runDir);
    expect(envelope).toMatchObject({ nodeExecutor: 'bot' });
    expect(envelope.authorization).not.toHaveProperty('initiator');
    expect(envelope.authorization).not.toHaveProperty('flowConfirmation');
  });

  it('switch off: the authorization has exactly the pre-feature keys', async () => {
    const { base, runDir } = await dagReadyRun();
    await approve(base, { nodeExecutor: 'ephemeral' });
    const envelope = envelopeOf(runDir);
    expect(envelope).not.toHaveProperty('nodeExecutor');
    expect(Object.keys(envelope.authorization).sort())
      .toEqual(['authorizedAt', 'authorizedByOpenId', 'dagSha256', 'kind', 'specSha256']);
    expect(readFileSync(join(runDir, 'run.json'), 'utf-8')).not.toMatch(/initiator|flowConfirmation/);
  });
});

/**
 * The production confirmer resolver over a real process marker and a real
 * persisted session: who opened the approving turn decides.
 */
describe('Gate-2 confirmer from the real turn provenance', () => {
  const PEER_BOT = 'ou_peer_bot_in_main';

  function seedTurn(dataDir: string, turnId: string, session: Record<string, unknown>): void {
    mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
    const procStart = readProcessStartIdentity(process.ppid);
    if (!procStart) throw new Error('cannot read the parent process start identity');
    writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.ppid)), JSON.stringify({ sessionId: 'sess', turnId, procStart }));
    seedPersistedSessionRows(dataDir, MAIN, {
      sess: { sessionId: 'sess', status: 'active', scope: 'thread', larkAppId: MAIN, chatId: 'oc_group', chatType: 'group', rootMessageId: 'om_root', ...session },
    });
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
    vi.stubEnv('BOTMUX_SESSION_ID', 'sess');
  }

  async function approveAs(owner: string, turnId: string, session: Record<string, unknown>) {
    const binding: RunChatBinding = { ...GROUP_TOPIC, sessionId: 'sess', ownerOpenId: owner };
    const { base, runDir } = await dagReadyRun({ binding });
    const dataDir = join(base, 'data');
    seedTurn(dataDir, turnId, session);
    await approve(base, { nodeExecutor: 'bot', caller: binding, confirmer: 'live' });
    return envelopeOf(runDir).authorization as any;
  }

  it('a human message: the sender is recorded as confirmer', async () => {
    const auth = await approveAs('ou_alice', 'om_alice_msg', {
      lastCallerOpenId: 'ou_alice', quoteTargetId: 'om_alice_msg', quoteTargetSenderOpenId: 'ou_alice', quoteTargetSenderIsBot: false,
    });
    expect(auth.flowConfirmation.confirmedByOpenId).toBe('ou_alice');
  });

  it('a human message proven by the per-turn registry after the quote chain moved on', async () => {
    const auth = await approveAs('ou_alice', 'om_alice_msg', {
      lastCallerOpenId: 'ou_bob', quoteTargetId: 'om_bob_later', quoteTargetSenderOpenId: 'ou_bob', quoteTargetSenderIsBot: false,
      replyTargets: { om_alice_msg: { senderOpenId: 'ou_alice', participants: [{ openId: 'ou_alice', isBot: false }] } },
    });
    expect(auth.flowConfirmation.confirmedByOpenId).toBe('ou_alice');
  });

  it.each([
    ['a peer bot\'s message (om_ turn, sender is a bot)', {
      lastCallerOpenId: PEER_BOT, quoteTargetId: 'om_bot_msg', quoteTargetSenderOpenId: PEER_BOT, quoteTargetSenderIsBot: true,
      replyTargets: { om_bot_msg: { senderOpenId: PEER_BOT, participants: [{ openId: PEER_BOT, isBot: true }] } },
    }],
    ['a message whose sender kind was never recorded', {
      lastCallerOpenId: PEER_BOT, quoteTargetId: 'om_bot_msg',
    }],
  ])('%s: approved, no confirmer', async (_label, session) => {
    const auth = await approveAs(PEER_BOT, 'om_bot_msg', session);
    expect(auth.initiator).toEqual({ openId: PEER_BOT, source: 'feishu' });
    expect(auth.flowConfirmation).not.toHaveProperty('confirmedByOpenId');
  });

  it('quote sender kind unknown but the per-turn registry proves the caller human: recorded', async () => {
    const auth = await approveAs('ou_alice', 'om_alice_msg', {
      lastCallerOpenId: 'ou_alice', quoteTargetId: 'om_alice_msg', quoteTargetSenderOpenId: 'ou_alice',
      replyTargets: { om_alice_msg: { senderOpenId: 'ou_alice', participants: [{ openId: 'ou_alice', isBot: false }] } },
    });
    expect(auth.flowConfirmation.confirmedByOpenId).toBe('ou_alice');
  });

  it.each([
    // The quote slot moved to another sender (e.g. a later message) while the
    // caller slot still names the initiator: the human proof is about someone else.
    ['the quote sender is somebody else than the caller', {
      lastCallerOpenId: 'ou_alice', quoteTargetId: 'om_alice_msg', quoteTargetSenderOpenId: 'ou_bob', quoteTargetSenderIsBot: false,
    }],
    ['the quote sender kind was never recorded', {
      lastCallerOpenId: 'ou_alice', quoteTargetId: 'om_alice_msg', quoteTargetSenderOpenId: 'ou_alice',
    }],
    ['the quote says human but the per-turn registry lists the caller as a bot', {
      lastCallerOpenId: 'ou_alice', quoteTargetId: 'om_alice_msg', quoteTargetSenderOpenId: 'ou_alice', quoteTargetSenderIsBot: false,
      replyTargets: { om_alice_msg: { senderOpenId: 'ou_alice', participants: [{ openId: 'ou_alice', isBot: true }] } },
    }],
    ['the quote says human but the per-turn registry leaves the caller\'s kind open', {
      lastCallerOpenId: 'ou_alice', quoteTargetId: 'om_alice_msg', quoteTargetSenderOpenId: 'ou_alice', quoteTargetSenderIsBot: false,
      replyTargets: { om_alice_msg: { senderOpenId: 'ou_alice', participants: [{ openId: 'ou_alice' }] } },
    }],
  ])('%s: approved, no confirmer', async (_label, session) => {
    const auth = await approveAs('ou_alice', 'om_alice_msg', session);
    expect(auth.initiator).toEqual({ openId: 'ou_alice', source: 'feishu' });
    expect(auth.flowConfirmation).not.toHaveProperty('confirmedByOpenId');
  });

  it('a synthetic turn id with a human-looking quote chain: no confirmer', async () => {
    const auth = await approveAs('ou_alice', 'trg_0123456789', {
      lastCallerOpenId: 'ou_alice', quoteTargetId: 'trg_0123456789', quoteTargetSenderOpenId: 'ou_alice', quoteTargetSenderIsBot: false,
    });
    expect(auth.flowConfirmation).not.toHaveProperty('confirmedByOpenId');
  });
});

describe('run.json schema', () => {
  const sha = (c: string) => `sha256:${c.repeat(64)}` as Sha256Digest;
  const adHocArtifacts = {
    dag: { path: 'dag.json' as const, sha256: sha('a') },
    spec: { path: 'spec.json' as const, sha256: sha('b') },
    botSnapshots: { path: 'bots.snapshot.json' as const, sha256: sha('c') },
  };
  const summary = buildV3FlowSummary({ dagNodes: DAG_NODES, plan: { rows: [], unplaced: [], flagged: 0 } });
  const confirmation = {
    confirmedByOpenId: OWNER,
    confirmedAt: '2026-11-05T01:00:00.000Z',
    flowSummary: summary,
    flowSummarySha256: v3FlowSummarySha256(summary),
  };
  const adHoc = (over: Record<string, unknown>) => () => makeAdHocRunEnvelope({
    runId: 'r', createdAt: '2026-11-05T00:00:00.000Z', authorizedAt: '2026-11-05T01:00:00.000Z',
    authorizedByOpenId: OWNER, artifacts: adHocArtifacts, ...over,
  } as any);
  const problems = (build: () => unknown): string[] => {
    try { build(); return []; } catch (err) {
      if (err instanceof RunEnvelopeValidationError) return err.problems;
      throw err;
    }
  };

  it('accepts both keys on a bot run', () => {
    expect(problems(adHoc({
      nodeExecutor: 'bot',
      initiator: { openId: OWNER, unionId: 'on_owner', source: 'dashboard-platform' },
      flowConfirmation: confirmation,
    }))).toEqual([]);
  });


  it.each([
    ['initiator', { initiator: { openId: OWNER, source: 'feishu' } }],
    ['flowConfirmation', { flowConfirmation: confirmation }],
  ])('rejects %s on a run that is not bot-executed', (key, over) => {
    expect(problems(adHoc(over))).toContain(`authorization.${key}: requires nodeExecutor "bot"`);
  });

  it('rejects an initiator on a run that authenticated nobody', () => {
    expect(problems(adHoc({ nodeExecutor: 'bot', authorizedByOpenId: undefined, initiator: { openId: 'ou_mallory', source: 'dashboard-platform' } })))
      .toEqual([expect.stringContaining('authorization.initiator.openId: must match the authenticated initiator')]);
  });

  it('rejects a confirmer who is not the initiator, and a confirmation without an initiator', () => {
    const initiator = { openId: OWNER, source: 'feishu' };
    expect(problems(adHoc({ nodeExecutor: 'bot', initiator, flowConfirmation: { ...confirmation, confirmedByOpenId: 'ou_mallory' } })))
      .toEqual(['authorization.flowConfirmation.confirmedByOpenId: must match authorization.initiator.openId (only the initiator confirms the flow)']);
    const { confirmedByOpenId: _drop, ...anonymous } = confirmation;
    expect(problems(adHoc({ nodeExecutor: 'bot', flowConfirmation: anonymous })))
      .toEqual(['authorization.flowConfirmation: requires authorization.initiator']);
    expect(problems(adHoc({ nodeExecutor: 'bot', initiator, flowConfirmation: anonymous }))).toEqual([]);
  });

  it('rejects a union_id on a dashboard-local initiator', () => {
    expect(problems(adHoc({ nodeExecutor: 'bot', initiator: { openId: OWNER, unionId: 'on_owner', source: 'dashboard-local' } })))
      .toEqual(['authorization.initiator.unionId: must be absent for a dashboard-local initiator (a local token login names no person)']);
  });

  it('rejects an initiator who is not the run\'s authenticated initiator', () => {
    expect(problems(adHoc({ nodeExecutor: 'bot', initiator: { openId: 'ou_someone_else', source: 'feishu' } })))
      .toEqual([expect.stringContaining('authorization.initiator.openId: must match the authenticated initiator')]);
  });

  it('rejects an initiator union_id that contradicts the frozen handoff identity', () => {
    expect(problems(adHoc({
      nodeExecutor: 'bot',
      handoffIdentity: { unionId: 'on_owner', tools: ['lark-cli'] },
      initiator: { openId: OWNER, unionId: 'on_other', source: 'feishu' },
    }))).toEqual(['authorization.initiator.unionId: must match authorization.handoffIdentity.unionId']);
  });

  it('rejects a confirmation whose digest is not that of its summary', () => {
    expect(problems(adHoc({ nodeExecutor: 'bot', initiator: { openId: OWNER, source: 'feishu' }, flowConfirmation: { ...confirmation, flowSummarySha256: sha('d') } })))
      .toEqual(['authorization.flowConfirmation.flowSummarySha256: must be the sha256 of the canonical flowSummary']);
  });

  it('rejects an unknown source and an app-foreign identifier', () => {
    expect(problems(adHoc({ nodeExecutor: 'bot', initiator: { openId: OWNER, source: 'dashboard' } })).length).toBeGreaterThan(0);
    expect(problems(adHoc({ nodeExecutor: 'bot', initiator: { openId: 'on_owner', source: 'feishu' } })).length).toBeGreaterThan(0);
  });

  it('a saved-definition run takes an initiator only when bot-executed', () => {
    const saved = (over: Record<string, unknown>) => () => makeSavedDefinitionRunEnvelope({
      runId: 'r', createdAt: '2026-11-05T00:00:00.000Z', authorizedAt: '2026-11-05T01:00:00.000Z',
      workflowId: 'wf_x', revisionId: 'rev', humanVersion: 1,
      chatBinding: { larkAppId: MAIN, chatId: 'oc', ownerOpenId: OWNER },
      artifacts: {
        ...adHocArtifacts,
        resolvedParams: { path: 'params.resolved.json', sha256: sha('e') },
        definitionSnapshot: { path: 'definition.snapshot.json', sha256: sha('f') },
      },
      ...over,
    } as any);
    expect(problems(saved({ initiator: { openId: OWNER, source: 'dashboard-local' } })))
      .toContain('authorization.initiator: requires nodeExecutor "bot"');
    expect(problems(saved({ nodeExecutor: 'bot', initiator: { openId: OWNER, source: 'dashboard-local' } }))).toEqual([]);
    expect(problems(saved({
      nodeExecutor: 'bot', chatBinding: { larkAppId: MAIN, chatId: 'oc' }, initiator: { openId: OWNER, source: 'feishu' },
    }))).toEqual([expect.stringContaining('authorization.initiator.openId: must match the authenticated initiator')]);
  });
});

describe('flow summary', () => {
  const plan = (over: Partial<V3Gate2BotPlan> = {}): V3Gate2BotPlan => ({
    rows: [
      { nodeId: 'inspect', larkAppId: MAIN, name: 'main', cli: 'claude-code', main: true },
      { nodeId: 'write', larkAppId: 'cli_doc', name: 'doc', cli: 'codex', main: false, reason: '擅长写文档', missedAssignee: { assignee: 'main', why: '不在群里' } },
    ],
    unplaced: [
      { kind: 'unresolved', sketchId: 'b', assignee: 'ghost', why: '不是本机配置的 Bot' },
      { kind: 'no-node', sketchId: 'a', assignee: 'doc', larkAppId: 'cli_doc' },
    ],
    flagged: 3,
    ...over,
  });
  const hostNode = { id: 'notify', type: 'host', executor: 'feishu-send', depends: ['write'], inputs: [] } as unknown as V3Node;
  const digest = (p: V3Gate2BotPlan, nodes: V3Node[] = DAG_NODES): string => v3FlowSummarySha256(buildV3FlowSummary({ dagNodes: nodes, plan: p }));

  it('does not depend on listing order', () => {
    const base = plan();
    const shuffled = plan({ rows: [...base.rows].reverse(), unplaced: [...base.unplaced].reverse() });
    expect(digest(shuffled)).toBe(digest(base));
    expect(digest(base, [hostNode, ...DAG_NODES])).toBe(digest(base, [...DAG_NODES, hostNode]));
  });

  it('does not depend on display names or hint wording', () => {
    const base = plan();
    const renamed = plan({
      rows: base.rows.map((row) => ({ ...row, name: `${row.name}-renamed`, ...(row.missedAssignee ? { missedAssignee: { assignee: row.missedAssignee.assignee, why: '换了说法' } } : {}) })),
      unplaced: base.unplaced.map((entry) => (entry.kind === 'unresolved' ? { ...entry, why: '换了说法' } : entry)),
    });
    expect(digest(renamed)).toBe(digest(base));
  });

  it.each<[string, () => string]>([
    ['the executing bot', () => digest(plan({ rows: plan().rows.map((row) => (row.nodeId === 'write' ? { ...row, larkAppId: MAIN } : row)) }))],
    ['the CLI', () => digest(plan({ rows: plan().rows.map((row) => (row.nodeId === 'write' ? { ...row, cli: 'claude-code' } : row)) }))],
    ['the reason', () => digest(plan({ rows: plan().rows.map((row) => (row.nodeId === 'write' ? { ...row, reason: '别的理由' } : row)) }))],
    ['a ⚠️', () => digest(plan({ rows: plan().rows.map(({ missedAssignee: _drop, ...row }) => row) }))],
    ['an outward action', () => digest(plan(), [...DAG_NODES, hostNode])],
    ['a human gate', () => digest(plan(), DAG_NODES.map(({ humanGate: _drop, ...node }) => node as V3Node))],
  ])('changes with %s', (_label, changed) => {
    expect(changed()).not.toBe(digest(plan()));
  });

  it('the canonical bytes are the hashed bytes, stable under re-normalization', () => {
    const summary: V3FlowSummary = buildV3FlowSummary({ dagNodes: DAG_NODES, plan: plan() });
    const again = buildV3FlowSummary({ dagNodes: DAG_NODES, plan: plan({ rows: [...plan().rows].reverse() }) });
    expect(canonicalV3FlowSummary(again)).toBe(canonicalV3FlowSummary(summary));
    expect(summary.sideEffects).toEqual([]);
    expect(buildV3FlowSummary({ dagNodes: [...DAG_NODES, hostNode], plan: plan() }).sideEffects)
      .toEqual([{ nodeId: 'notify', kind: 'feishu-send' }]);
  });
});

describe('Saved Workflow /workflow run records the sender as initiator', () => {
  const SENDER = { openId: 'ou_sender_in_main', larkAppId: MAIN };
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
  let root: string;
  let workflowId: string;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'wf-saved-initiator-'));
    dirs.push(root);
    const created = await createSavedWorkflow(join(root, 'data'), {
      displayName: '周报', owner: { openId: 'ou_author', larkAppId: MAIN }, scope: { kind: 'chat', chatId: 'oc_a' },
      revision: revision(), publish: true, workflowId: 'wf_1234567890abcdef1234567890abcdef',
    });
    workflowId = created.metadata.workflowId;
  });
  function identityPolicy(lookup: V3InitiatorUnionLookup) {
    const asked: Array<[string, string]> = [];
    const policy: V3HandoffIdentityPolicy = {
      lookupUnionId: async (appId, openId) => { asked.push([appId, openId]); return lookup; },
      botTools: (appId) => (appId === MAIN ? ['lark-cli'] : []),
    };
    return { policy, asked };
  }
  const executorPolicy = (handoffIdentity?: V3HandoffIdentityPolicy): V3NodeExecutorPolicy => ({
    switchMode: 'bot', multiTopicEnabled: true,
    probe: () => ({ isConfigured: () => true, isDaemonOnline: () => true, inChat: async () => 'yes', opensTopicSessions: async () => 'yes', ensureGrant: async () => {} }),
    nameOf: (appId) => appId,
    ...(handoffIdentity ? { handoffIdentity } : {}),
  });
  const instantiate = (opts: { policy?: V3NodeExecutorPolicy; chatType?: 'group' | 'p2p'; baseDir?: string } = {}) => instantiatePublishedSavedWorkflow({
    dataDir: join(root, 'data'), ref: workflowId, bots: BOTS, baseDir: opts.baseDir ?? join(root, 'runs'),
    runId: 'saved-run', now: new Date('2026-11-05T02:00:00.000Z'),
    context: { actor: SENDER, chatId: 'oc_a', chatType: opts.chatType ?? 'group', rootMessageId: 'om_root', sessionId: 's', humanTurn: true },
    ...(opts.policy ? { nodeExecutorPolicy: opts.policy } : {}),
  });

  it('bot run: initiator = the sender, source feishu, and no lookup of its own', async () => {
    const run = await instantiate({ policy: executorPolicy() });
    expect(run.envelope).toMatchObject({ nodeExecutor: 'bot', chatBinding: { ownerOpenId: SENDER.openId } });
    expect((run.envelope.authorization as any).initiator).toEqual({ openId: SENDER.openId, source: 'feishu' });
    expect(readRunEnvelope(run.runDir).kind).toBe('ok');
  });

  it('with 交接带发起人身份 on, reuses the union_id that lookup already resolved', async () => {
    const { policy, asked } = identityPolicy({ status: 'resolved', unionId: 'on_sender' });
    const run = await instantiate({ policy: executorPolicy(policy) });
    expect(asked).toEqual([[MAIN, SENDER.openId]]);
    expect((run.envelope.authorization as any).initiator).toEqual({ openId: SENDER.openId, unionId: 'on_sender', source: 'feishu' });
  });

  it('a union_id the lookup could not resolve is left out, not looked up again', async () => {
    const { policy, asked } = identityPolicy({ status: 'unavailable' });
    const run = await instantiate({ policy: executorPolicy(policy) });
    expect(asked).toHaveLength(1);
    expect((run.envelope.authorization as any).initiator).toEqual({ openId: SENDER.openId, source: 'feishu' });
  });

  it.each([
    ['the switch is off', {}],
    ['the switch is on but the run stays ephemeral (private chat)', { policy: executorPolicy(), chatType: 'p2p' as const }],
  ])('no initiator when %s: run.json has exactly the pre-feature keys', async (_label, opts) => {
    const run = await instantiate(opts);
    expect(run.envelope).not.toHaveProperty('nodeExecutor');
    expect(Object.keys(run.envelope.authorization).sort()).toEqual(
      ['authorizedAt', 'dagSha256', 'definitionSnapshotSha256', 'kind', 'revisionId', 'specSha256', 'workflowId'],
    );
    expect(readFileSync(join(run.runDir, 'run.json'), 'utf-8')).not.toMatch(/initiator/);
  });
});
