/**
 * Harness for 交接带发起人身份 (design 2026-11-03 §10): a REAL authorized run
 * (run.json + digest-pinned artifacts) driven by the real runtime, the main
 * bot's real WorkflowNodeDaemon (its executor, identity plan and signing), and
 * each target bot's real identity-check route reached over a fake host IPC.
 * Lark, the per-app contact directory and chat membership are fakes, so a
 * test can say exactly who each app sees as whom.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkflowNodeDaemon, type WorkflowNodeDaemonDeps } from '../../src/core/workflow-node-daemon.js';
import {
  WORKFLOW_HANDOFF_IDENTITY_CHECK_ROUTE,
  checkWorkflowHandoffIdentityTarget,
  type WorkflowHandoffIdentityCheckRequest,
} from '../../src/core/workflow-handoff-identity.js';
import { parseTriggerUserAuthConfig, type TriggerUserAuthConfig } from '../../src/services/trigger-user-auth.js';
import {
  artifactRef,
  makeAdHocRunEnvelope,
  publishRunEnvelopeOnce,
  type V3HandoffIdentityRecord,
  type V3HandoffIdentityTool,
} from '../../src/workflows/v3/run-envelope.js';
import { SPEC_SCHEMA_VERSION, type BotSnapshot } from '../../src/workflows/v3/contract.js';
import type { V3SelfTurnRequest } from '../../src/im/lark/v3-bot-handoff-executor.js';
import { BotRun, snapshotFor, trackTempDir } from './v3-external-harness.js';
import { CHAT, FakeLark, MAIN, SECRET } from './workflow-handoff-harness.js';

export { CHAT, MAIN, SECRET };

/** The initiator as the MAIN bot's app sees them (app-scoped). */
export const INITIATOR_MAIN_OU = 'ou_alice_in_main';
export const INITIATOR_UNION = 'on_alice';
/** The same person as each target app sees them (what a lookup returns). */
export const INITIATOR_OU_IN: Record<string, string> = {
  cli_a: 'ou_alice_in_a', cli_b: 'ou_alice_in_b', cli_c: 'ou_alice_in_c', [MAIN]: INITIATOR_MAIN_OU,
};

export const BINDING = {
  larkAppId: MAIN,
  chatId: CHAT,
  chatType: 'group' as const,
  rootMessageId: 'om_main_topic',
  ownerOpenId: INITIATOR_MAIN_OU,
};

export function policy(tools: V3HandoffIdentityTool[] | null): TriggerUserAuthConfig | undefined {
  return tools === null ? undefined : parseTriggerUserAuthConfig({ enabled: true, tools }) ?? undefined;
}

/**
 * Publish run.json for `run` the way Gate-2 does (ad-hoc, `nodeExecutor:
 * "bot"`, the initiator as approver), with the snapshot of every selector the
 * DAG uses. `identity: null` = authorized while the identity switch was off.
 */
export function authorizeRun(run: BotRun, opts: {
  identity: V3HandoffIdentityRecord | null;
  selectors?: string[];
  chatBinding?: typeof BINDING;
  /** Gate-2 `--working-dir` (design §15.4). */
  nodeWorkingDir?: string;
}): Map<string, BotSnapshot> {
  const runDir = run.runDir;
  mkdirSync(runDir, { recursive: true });
  const selectors = opts.selectors ?? ['cli_a'];
  const snapshots = new Map(selectors.map((selector) => [selector, snapshotFor(selector || undefined)]));
  writeFileSync(join(runDir, 'dag.json'), `${JSON.stringify(run.dag, null, 2)}\n`);
  writeFileSync(join(runDir, 'spec.json'), `${JSON.stringify({
    schemaVersion: SPEC_SCHEMA_VERSION,
    runId: run.dag.runId,
    title: '代码风险报告',
    requirement: 'r',
    nodes: [{ sketchId: 'write', goal: 'write', input_needs: [], expected_outputs: ['r.md'], acceptance: 'has risks', risk_gate: false, unknowns: [] }],
  }, null, 2)}\n`);
  writeFileSync(join(runDir, 'bots.snapshot.json'), `${JSON.stringify(Object.fromEntries(snapshots), null, 2)}\n`);
  const binding = opts.chatBinding ?? BINDING;
  publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
    runId: run.dag.runId,
    createdAt: '2026-11-03T08:00:00.000Z',
    authorizedAt: '2026-11-03T08:01:00.000Z',
    chatBinding: binding,
    authorizedByOpenId: binding.ownerOpenId,
    nodeExecutor: 'bot',
    ...(opts.nodeWorkingDir ? { nodeWorkingDir: opts.nodeWorkingDir } : {}),
    ...(opts.identity ? { handoffIdentity: opts.identity } : {}),
    artifacts: {
      dag: artifactRef(runDir, 'dag.json'),
      spec: artifactRef(runDir, 'spec.json'),
      botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
    },
  }));
  return snapshots;
}

export interface IdentityWorld {
  dataDir: string;
  lark: FakeLark;
  /** larkAppId → its `triggerUserAuth` (undefined = none). */
  policies: Map<string, TriggerUserAuthConfig | undefined>;
  /** larkAppId → open_ids in the chat, as that app sees them. */
  members: Map<string, Set<string>>;
  /** Apps whose contact lookup is down (the check is unavailable). */
  directoryDown: Set<string>;
  /** Every identity-check request a target daemon received over IPC. */
  identityChecks: Array<{ target: string; body: WorkflowHandoffIdentityCheckRequest }>;
  selfTurns: Array<V3SelfTurnRequest & { prepareTurnIdentity?: unknown }>;
  main: ReturnType<typeof createWorkflowNodeDaemon>;
  /** Every bot's daemon wiring, by app id (`main` is MAIN's). */
  daemons: Map<string, ReturnType<typeof createWorkflowNodeDaemon>>;
  /** The per-turn identity preparation the daemons were given. */
  prepareTurnIdentity: (ds: unknown, turnId: string) => Promise<void>;
}

/** The pre-handoff check a bot's daemon runs (mirrors daemon.ts's
 *  workflowHandoffIdentityCheck over this world's directory and members). */
function targetCheck(world: IdentityWorld, appId: string) {
  return (request: WorkflowHandoffIdentityCheckRequest) => checkWorkflowHandoffIdentityTarget({
    policy: world.policies.get(appId),
    offeredTools: request.tools,
    targetUser: async () => {
      if (world.directoryDown.has(appId)) throw new Error('contact lookup unavailable');
      const openId = request.unionId === INITIATOR_UNION ? INITIATOR_OU_IN[appId] : undefined;
      return openId && world.members.get(appId)?.has(openId) ? openId : undefined;
    },
  });
}

export function identityWorld(overrides: Partial<WorkflowNodeDaemonDeps> = {}, opts: { dataDir?: string; clock?: { t: number } } = {}): IdentityWorld {
  const dataDir = opts.dataDir ?? trackTempDir(mkdtempSync(join(tmpdir(), 'wf-identity-data-')));
  const world = {
    dataDir,
    lark: new FakeLark(),
    policies: new Map<string, TriggerUserAuthConfig | undefined>([
      [MAIN, policy(['lark-cli', 'bytedcli'])],
      ['cli_a', policy(['lark-cli', 'bytedcli'])],
      ['cli_b', policy(null)],
      ['cli_c', policy(null)],
    ]),
    members: new Map<string, Set<string>>([
      [MAIN, new Set([INITIATOR_OU_IN[MAIN]!])],
      ['cli_a', new Set([INITIATOR_OU_IN.cli_a!])],
      ['cli_b', new Set([INITIATOR_OU_IN.cli_b!])],
      ['cli_c', new Set([INITIATOR_OU_IN.cli_c!])],
    ]),
    directoryDown: new Set<string>(),
    identityChecks: [],
    selfTurns: [],
    prepareTurnIdentity: async () => {},
  } as unknown as IdentityWorld;
  const ports = new Map([[MAIN, 4100], ['cli_a', 4101], ['cli_b', 4102], ['cli_c', 4103]]);
  const targets = new Map([...ports].map(([appId, port]) => [port, appId]));
  const routes = new Map<string, ReturnType<typeof createWorkflowNodeDaemon>>();
  const daemonFor = (self: string): ReturnType<typeof createWorkflowNodeDaemon> => createWorkflowNodeDaemon({
    selfLarkAppId: () => self,
    dataDir: () => dataDir,
    baseDir: () => tmpdir(),
    sendCard: world.lark.sendCard,
    replyCard: (root, card, uuid) => world.lark.replyCard(root, card, uuid),
    patchCard: world.lark.patchCard,
    resolveBotInChat: async (_chatId, target) => ({ ok: true, openId: `ou_bot_${target}` }),
    targetOpensTopicSessions: async () => 'yes',
    daemonPort: (appId) => ports.get(appId),
    hostSecret: () => 'host-ipc-secret',
    bindingSecret: () => SECRET,
    postDaemon: async (port, path, body) => {
      await new Promise((resolve) => setImmediate(resolve)); // a real hop yields
      const target = targets.get(port)!;
      if (path !== WORKFLOW_HANDOFF_IDENTITY_CHECK_ROUTE) return { status: 404, body: { ok: false, error: 'not_found' } };
      world.identityChecks.push({ target, body: body as WorkflowHandoffIdentityCheckRequest });
      return routes.get(target)!.identityCheckRoute(JSON.parse(JSON.stringify(body)));
    },
    ensureGrant: async () => {},
    loadSessions: () => [],
    isProcessAlive: () => true,
    activeSessions: () => [],
    updateSession: () => {},
    getSessionWorkingDir: (ds) => ds.workingDir ?? ds.session.workingDir ?? '',
    findNodeSession: () => undefined,
    interruptTurn: () => true,
    proveBotSender: async () => true,
    deliverSelfTurn: async (input) => {
      world.selfTurns.push(input as IdentityWorld['selfTurns'][number]);
      return { sessionId: `self-${input.handoffMessageId}` };
    },
    attachmentsDir: (appId, messageId) => join(dataDir, 'attachments', appId, messageId),
    loadRun: () => undefined,
    botWorkingDirConfig: () => ({}),
    daemonAppliesNodeWorkingDir: () => true,
    drive: () => {},
    botName: (appId) => `bot(${appId})`,
    warn: () => {},
    prepareTurnIdentity: world.prepareTurnIdentity,
    // The engine's fake clock; an in-call wait just advances it.
    ...(opts.clock ? {
      now: () => opts.clock!.t,
      // Yields to the event loop, so a retry loop that never ends fails on
      // the test timeout instead of starving it.
      sleep: async (ms: number) => { opts.clock!.t += ms; await new Promise((resolve) => setImmediate(resolve)); },
    } : {}),
    handoffIdentity: {
      botTools: (appId) => {
        const p = world.policies.get(appId);
        return p?.enabled ? [...p.tools] : [];
      },
      checkSelf: (request) => targetCheck(world, self)(request),
    },
    ...(self === MAIN ? overrides : {}),
  });
  for (const appId of ports.keys()) routes.set(appId, daemonFor(appId));
  world.main = routes.get(MAIN)!;
  world.daemons = routes;
  return world;
}

/** Drive `run` with the main bot's real executor. */
export function driveWith(run: BotRun, world: IdentityWorld, snapshots: Map<string, BotSnapshot>) {
  return run.drive(world.main.executor, {
    opts: { chatBinding: BINDING, authorizedArtifacts: true, frozenBotSnapshots: snapshots },
  });
}
