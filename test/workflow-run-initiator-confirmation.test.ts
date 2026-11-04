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
 *   - flow summary: a function of the confirmed facts, not of listing order,
 *     display names or hint wording.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import type { V3Node } from '../src/workflows/v3/dag.js';
import type { V3HandoffIdentityPolicy } from '../src/workflows/v3/node-executor-mode.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
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

async function dagReadyRun() {
  const base = mkdtempSync(join(tmpdir(), 'wf-confirm-'));
  dirs.push(base);
  const { runDir, runId } = hostNew({ goal: 'g', baseDir: base, runId: 'r', chatBinding: GROUP_TOPIC });
  writeFileSync(join(runDir, 'spec.md'), `# Spec\n\`\`\`json\n${JSON.stringify({
    schemaVersion: SPEC_SCHEMA_VERSION, runId, title: 't', requirement: 'r',
    nodes: [{ sketchId: 'write', goal: 'write', input_needs: [], expected_outputs: ['r.md'], acceptance: 'ok', risk_gate: false, unknowns: [], assignee: 'main' }],
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
  writeFileSync(state.dagPath!, JSON.stringify({ schemaVersion: 2, runId: 'r', nodes: [
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
    await approve(base, { nodeExecutor: 'bot' });
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

  it.each([
    ['a scheduled task', 'schedule:abcdef12:12345678-1234-1234-1234-123456789abc'],
    ['a workflow event wake-up', 'workflow-event:r:7'],
    ['no authenticated turn', ''],
  ])('approval in %s: no confirmer is written (not guessed)', async (_label, turnId) => {
    const { base, runDir } = await dagReadyRun();
    await approve(base, { nodeExecutor: 'bot', turnId });
    const auth = envelopeOf(runDir).authorization as any;
    expect(auth.flowConfirmation).toBeDefined();
    expect(auth.flowConfirmation).not.toHaveProperty('confirmedByOpenId');
    expect(auth.initiator).toEqual({ openId: OWNER, source: 'feishu' });
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
    expect(problems(adHoc({ nodeExecutor: 'bot', flowConfirmation: { ...confirmation, flowSummarySha256: sha('d') } })))
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
