/**
 * "节点交给群里的 Bot 执行" at authorization time (design 2026-11-03 §6.3,
 * D1, P4): Gate-2 `approve-dag` and Saved Workflow materialization freeze
 * `nodeExecutor: "bot"` into run.json only when the experimental switch is on
 * AND the run lives in a group chat topic with multi-topic orchestration on;
 * otherwise they keep today's ephemeral execution and say why. A bot run is
 * refused (nothing published) when a node's bot fails §6.1 items 1–4.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { frozenNodeWorkingDir, readRunEnvelope } from '../src/workflows/v3/run-envelope.js';
import type { V3BotEligibilityProbe } from '../src/workflows/v3/node-executor-mode.js';
import { checkV3BotExecutorEligibility } from '../src/workflows/v3/node-executor-mode.js';
import { createWorkflowWorkingDirOperatorWiring, type WorkflowWorkingDirOperatorIo } from '../src/core/workflow-working-dir-operator.js';

const bases: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const MAIN = 'cli_main';
const BOTS = [
  { larkAppId: MAIN, name: 'main', cliId: 'claude-code', workingDir: '/tmp' },
  { larkAppId: 'cli_doc', name: 'doc', cliId: 'claude-code', workingDir: '/tmp' },
  { larkAppId: 'cli_test', name: 'test', cliId: 'codex', workingDir: '/tmp' },
] as any[];

const GROUP_TOPIC: RunChatBinding = {
  larkAppId: MAIN, chatId: 'oc_group', chatType: 'group', rootMessageId: 'om_root', ownerOpenId: 'ou_owner',
};

const NODES = [
  { id: 'inspect', type: 'goal', goal: 'inspect changes', depends: [], inputs: [] },
  { id: 'write', type: 'goal', goal: 'write report', bot: 'cli_doc', depends: ['inspect'], inputs: [] },
  { id: 'verify', type: 'goal', goal: 'run tests', bot: 'cli_test', depends: ['inspect'], inputs: [] },
];

async function dagReadyRun(binding: RunChatBinding | undefined, nodes: unknown[] = NODES) {
  const base = mkdtempSync(join(tmpdir(), 'wf-approve-'));
  bases.push(base);
  const { runDir, runId } = hostNew({ goal: 'g', baseDir: base, runId: 'r', ...(binding ? { chatBinding: binding } : {}) });
  writeFileSync(join(runDir, 'spec.md'), `# Spec\n\`\`\`json\n${JSON.stringify({
    schemaVersion: SPEC_SCHEMA_VERSION,
    runId,
    title: '代码风险报告',
    requirement: 'r',
    nodes: [{ sketchId: 'write', goal: 'write', input_needs: [], expected_outputs: ['r.md'], acceptance: 'has risks', risk_gate: false, unknowns: [] }],
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
  writeFileSync(dagPath, JSON.stringify({ schemaVersion: 2, runId: 'r', nodes }));
  return { base, runDir };
}

/** A probe that records what it was asked and answers from a table. */
function tableProbe(table: Partial<Record<string, { offline?: boolean; notInChat?: boolean; grantError?: string; unknown?: boolean; foldsTopics?: boolean }>>) {
  const asked: string[] = [];
  const probe: V3BotEligibilityProbe = {
    isConfigured: (appId) => BOTS.some((bot) => bot.larkAppId === appId),
    isDaemonOnline: (appId) => { asked.push(`online:${appId}`); return !table[appId]?.offline; },
    inChat: async (appId) => {
      asked.push(`inChat:${appId}`);
      if (table[appId]?.unknown) return { unknown: 'api timeout' };
      return table[appId]?.notInChat ? 'no' : 'yes';
    },
    opensTopicSessions: async (appId) => {
      asked.push(`topics:${appId}`);
      return table[appId]?.foldsTopics ? 'no' : 'yes';
    },
    ensureGrant: async (appId) => {
      asked.push(`grant:${appId}`);
      if (table[appId]?.grantError) throw new Error(table[appId]!.grantError);
    },
  };
  return { probe, asked };
}

async function approve(runDir: string, base: string, opts: {
  switchMode: 'ephemeral' | 'bot';
  multiTopic?: boolean;
  binding?: RunChatBinding;
  probe?: V3BotEligibilityProbe;
}) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const probeFactory = vi.fn(() => opts.probe ?? tableProbe({}).probe);
  try {
    await cmdWorkflowHost('approve-dag', ['r', '--base-dir', base], {
      loadBots: () => BOTS,
      resolveChatBinding: () => opts.binding,
      nodeExecutorSwitch: () => opts.switchMode,
      multiTopicEnabled: () => opts.multiTopic ?? true,
      botEligibilityProbe: probeFactory,
      botDisplayName: () => (appId) => `bot(${appId})`,
    });
    return { output: log.mock.calls.flat().join('\n'), probeFactory, envelope: readRunEnvelope(runDir) };
  } finally {
    log.mockRestore();
  }
}

function frozenExecutor(envelope: ReturnType<typeof readRunEnvelope>): string | undefined {
  if (envelope.kind !== 'ok') throw new Error(`envelope ${envelope.kind}`);
  return 'nodeExecutor' in envelope.envelope ? envelope.envelope.nodeExecutor : undefined;
}

describe('approve-dag freezes the node executor', () => {
  it('switch off: no executor field, no probe, no extra summary', async () => {
    const { base, runDir } = await dagReadyRun(GROUP_TOPIC);
    const off = await approve(runDir, base, { switchMode: 'ephemeral', binding: GROUP_TOPIC });
    expect(frozenExecutor(off.envelope)).toBeUndefined();
    expect(off.probeFactory).not.toHaveBeenCalled();
    expect(JSON.parse(off.output.slice(0, off.output.indexOf('}') + 1))).not.toHaveProperty('nodeExecutor');
  });

  it('switch on in a group topic: freezes "bot" and lists node → executing bot', async () => {
    const { base, runDir } = await dagReadyRun(GROUP_TOPIC);
    const on = await approve(runDir, base, { switchMode: 'bot', binding: GROUP_TOPIC });
    expect(frozenExecutor(on.envelope)).toBe('bot');
    // A node without its own bot is executed by the bot the run was born in.
    for (const [node, appId] of [['inspect', MAIN], ['write', 'cli_doc'], ['verify', 'cli_test']]) {
      expect(on.output).toMatch(new RegExp(`${node} → bot\\(${appId}\\)`));
    }
    expect(readGrillState(runDir)!.status).toBe('dag_approved');
  });

  it.each([
    ['private chat', { ...GROUP_TOPIC, chatType: 'p2p' as const }, true],
    ['no thread root', { ...GROUP_TOPIC, rootMessageId: undefined }, true],
    ['multi-topic off', GROUP_TOPIC, false],
  ])('switch on but %s: stays ephemeral and explains why', async (_label, binding, multiTopic) => {
    const { base, runDir } = await dagReadyRun(binding as RunChatBinding);
    const result = await approve(runDir, base, { switchMode: 'bot', binding: binding as RunChatBinding, multiTopic });
    expect(frozenExecutor(result.envelope)).toBeUndefined();
    expect(result.probeFactory).not.toHaveBeenCalled();
    // Something beyond the ordinary approval reply is said.
    const plain = await dagReadyRun(binding as RunChatBinding);
    const baseline = await approve(plain.runDir, plain.base, { switchMode: 'ephemeral', binding: binding as RunChatBinding, multiTopic });
    expect(result.output.length).toBeGreaterThan(baseline.output.length);
  });

  it('refuses approval with one reason per ineligible node and publishes nothing', async () => {
    const { base, runDir } = await dagReadyRun(GROUP_TOPIC);
    const { probe } = tableProbe({ cli_doc: { notInChat: true }, cli_test: { offline: true } });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let error: unknown;
    try {
      await cmdWorkflowHost('approve-dag', ['r', '--base-dir', base], {
        loadBots: () => BOTS,
        resolveChatBinding: () => GROUP_TOPIC,
        nodeExecutorSwitch: () => 'bot',
        multiTopicEnabled: () => true,
        botEligibilityProbe: () => probe,
        botDisplayName: () => (appId) => `bot(${appId})`,
      });
    } catch (err) {
      error = err;
    } finally {
      log.mockRestore();
    }
    const message = error instanceof Error ? error.message : '';
    expect(message).toMatch(/write → bot\(cli_doc\)/);
    expect(message).toMatch(/verify → bot\(cli_test\)/);
    // The main bot's own node is never a refusal reason.
    expect(message).not.toMatch(/inspect →/);
    expect(readRunEnvelope(runDir).kind).toBe('missing');
    expect(readGrillState(runDir)!.status).toBe('dag_ready');
  });

  it('a replay of an approved bot run keeps the frozen executor without re-deciding', async () => {
    const { base, runDir } = await dagReadyRun(GROUP_TOPIC);
    await approve(runDir, base, { switchMode: 'bot', binding: GROUP_TOPIC });
    const replay = await approve(runDir, base, { switchMode: 'ephemeral', binding: GROUP_TOPIC });
    expect(frozenExecutor(replay.envelope)).toBe('bot');
    expect(replay.probeFactory).not.toHaveBeenCalled();
  });
});

describe('approve-dag refusals added by review (P2-3 / P2-4)', () => {
  async function refusal(nodes: unknown[], probe: V3BotEligibilityProbe, extraArgs: string[] = []) {
    const { base, runDir } = await dagReadyRun(GROUP_TOPIC, nodes);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await cmdWorkflowHost('approve-dag', ['r', '--base-dir', base, ...extraArgs], {
        loadBots: () => BOTS,
        resolveChatBinding: () => GROUP_TOPIC,
        nodeExecutorSwitch: () => 'bot',
        multiTopicEnabled: () => true,
        botEligibilityProbe: () => probe,
        botDisplayName: () => (appId) => `bot(${appId})`,
      });
      return { error: undefined as unknown, runDir };
    } catch (error) {
      return { error, runDir };
    } finally {
      log.mockRestore();
    }
  }

  it('P2-3: a normal-group bot that folds topic replies into one session is refused (§6.1 item 7)', async () => {
    const { probe } = tableProbe({ cli_doc: { foldsTopics: true } });
    const { error, runDir } = await refusal(NODES, probe);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/write → bot\(cli_doc\)/);
    expect((error as Error).message).not.toMatch(/verify →/);
    expect(readRunEnvelope(runDir).kind).toBe('missing');
  });

  it('P2-4: a node with a directory output is refused, whoever executes it', async () => {
    const nodes = [
      { id: 'inspect', type: 'goal', goal: 'inspect', depends: [], inputs: [], outputs: { tree: { path: 'tree', kind: 'directory' } } },
      { id: 'write', type: 'goal', goal: 'write', bot: 'cli_doc', depends: ['inspect'], inputs: [] },
    ];
    const { error, runDir } = await refusal(nodes, tableProbe({}).probe);
    expect((error as Error).message).toMatch(/inspect → bot\(cli_main\)/);
    expect((error as Error).message).toContain('tree');
    expect(readRunEnvelope(runDir).kind).toBe('missing');
  });
});

describe('approve-dag --working-dir in bot mode (design §15.4)', () => {
  /** Real directories: main and doc may work under `repos`, test only under `lab`. */
  function dirs() {
    const root = mkdtempSync(join(tmpdir(), 'wf-approve-dir-'));
    bases.push(root);
    const repos = join(root, 'repos');
    const project = join(repos, 'project');
    const lab = join(root, 'lab');
    mkdirSync(project, { recursive: true });
    mkdirSync(lab, { recursive: true });
    const bots = [
      { larkAppId: MAIN, name: 'main', cliId: 'claude-code', defaultWorkingDir: repos },
      { larkAppId: 'cli_doc', name: 'doc', cliId: 'claude-code', workingDirs: [repos] },
      { larkAppId: 'cli_test', name: 'test', cliId: 'codex', workingDir: lab },
    ] as any[];
    return { root, repos, project, lab, bots };
  }

  /** `operates`: whether the initiator may operate each bot, as that bot's
   *  daemon would answer (default: no one operates anything). */
  type Operate = 'yes' | 'no' | { unknown: string };
  async function approveWithDir(dir: string, bots: any[], opts: {
    switchMode?: 'bot' | 'ephemeral';
    nodes?: unknown[];
    operates?: Record<string, Operate>;
    /** Replaces the table: answers each question itself. */
    answer?: (target: { nodeId: string; larkAppId: string }) => Promise<Operate>;
  } = {}) {
    const { base, runDir } = await dagReadyRun(GROUP_TOPIC, opts.nodes);
    const probeFactory = vi.fn(() => tableProbe({}).probe);
    const asked: string[] = [];
    const operatorFor: Array<{ runId: string; binding: RunChatBinding }> = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let error: unknown;
    try {
      await cmdWorkflowHost('approve-dag', ['r', '--base-dir', base, '--working-dir', dir], {
        loadBots: () => bots,
        resolveChatBinding: () => GROUP_TOPIC,
        nodeExecutorSwitch: () => opts.switchMode ?? 'bot',
        multiTopicEnabled: () => true,
        botEligibilityProbe: probeFactory,
        botDisplayName: () => (appId) => `bot(${appId})`,
        workingDirOperator: (run) => {
          operatorFor.push(run);
          return async (target) => {
            asked.push(target.larkAppId);
            return opts.answer ? opts.answer(target) : opts.operates?.[target.larkAppId] ?? 'no';
          };
        },
      });
    } catch (err) {
      error = err;
    }
    const output = log.mock.calls.flat().join('\n');
    log.mockRestore();
    return { error, output, runDir, probeFactory, asked, operatorFor, envelope: readRunEnvelope(runDir) };
  }

  const snapshotDirs = (runDir: string) => Object.values(
    JSON.parse(readFileSync(join(runDir, 'bots.snapshot.json'), 'utf-8')) as Record<string, { workingDir: string }>,
  ).map((snapshot) => snapshot.workingDir);

  it('a directory inside every executing bot\'s range is frozen like an ephemeral run, and marked for the bots to apply', async () => {
    const d = dirs();
    const nodes = NODES.filter((node) => node.id !== 'verify');
    const result = await approveWithDir(`${d.project}/`, d.bots, { nodes });
    expect(result.error).toBeUndefined();
    expect(frozenExecutor(result.envelope)).toBe('bot');
    if (result.envelope.kind !== 'ok') throw new Error('no envelope');
    const real = realpathSync(d.project);
    expect(frozenNodeWorkingDir(result.envelope.envelope)).toBe(real);
    expect(snapshotDirs(result.runDir)).toEqual([real, real]);
    expect(result.output).toContain(real);
    expect(readGrillState(result.runDir)!.status).toBe('dag_approved');
  });

  it('a symlink is frozen as the directory it points to, so retargeting the link later moves nothing', async () => {
    const d = dirs();
    const link = join(d.root, 'outside-link');
    symlinkSync(d.project, link);
    const nodes = NODES.filter((node) => node.id !== 'verify');
    const result = await approveWithDir(link, d.bots, { nodes });
    expect(result.error).toBeUndefined();
    if (result.envelope.kind !== 'ok') throw new Error('no envelope');
    const real = realpathSync(d.project);
    expect(frozenNodeWorkingDir(result.envelope.envelope)).toBe(real);
    expect(snapshotDirs(result.runDir)).toEqual([real, real]);
    // The link is pointed somewhere else afterwards: the frozen value is not the link.
    rmSync(link);
    symlinkSync(d.lab, link);
    const reread = readRunEnvelope(result.runDir);
    if (reread.kind !== 'ok') throw new Error('no envelope');
    expect(frozenNodeWorkingDir(reread.envelope)).toBe(real);
  });

  it('a node whose bot does not allow the directory refuses the approval, names node → bot, probes nothing and publishes nothing', async () => {
    const d = dirs();
    const result = await approveWithDir(d.project, d.bots);
    expect(result.error).toBeInstanceOf(Error);
    const message = (result.error as Error).message;
    expect(message).toMatch(/verify → bot\(cli_test\)：指定的工作目录不在它配置的目录范围内/);
    expect(message).not.toMatch(/inspect →|write →/);
    expect(message).toContain(realpathSync(d.project));
    expect(result.probeFactory).not.toHaveBeenCalled();
    expect(result.envelope.kind).toBe('missing');
    expect(readGrillState(result.runDir)!.status).toBe('dag_ready');
  });

  it('the main bot\'s own nodes are checked too, and a bot without any directory cannot be given one', async () => {
    const d = dirs();
    const noDirs = await approveWithDir(d.lab, [{ ...d.bots[0], defaultWorkingDir: d.lab }, { ...d.bots[1], workingDirs: undefined }, d.bots[2]]);
    const message = (noDirs.error as Error).message;
    expect(message).toMatch(/write → bot\(cli_doc\)：它没有配置目录范围/);
    expect(message).not.toMatch(/inspect →|verify →/);
    const mainOutside = await approveWithDir(d.project, [{ ...d.bots[0], defaultWorkingDir: d.lab }, d.bots[1], { ...d.bots[2], workingDir: d.repos }]);
    expect((mainOutside.error as Error).message).toMatch(/inspect → bot\(cli_main\)：指定的工作目录不在/);
    expect((mainOutside.error as Error).message).not.toMatch(/write →|verify →/);
  });

  it('a directory that does not exist is refused before anything else', async () => {
    const d = dirs();
    const result = await approveWithDir(join(d.repos, 'missing'), d.bots);
    // Said as what it is, not as a range problem of some bot.
    expect((result.error as Error).message).toMatch(/--working-dir.*(目录不存在|does not exist)/);
    expect((result.error as Error).message).not.toMatch(/→/);
    expect(result.probeFactory).not.toHaveBeenCalled();
    expect(result.envelope.kind).toBe('missing');
  });

  it('a bot the initiator may operate (their own) takes any existing directory, outside its range too', async () => {
    const d = dirs();
    // cli_test may only work under lab; the initiator operates it.
    const result = await approveWithDir(d.project, d.bots, { operates: { cli_test: 'yes' } });
    expect(result.error).toBeUndefined();
    if (result.envelope.kind !== 'ok') throw new Error('no envelope');
    const real = realpathSync(d.project);
    expect(frozenNodeWorkingDir(result.envelope.envelope)).toBe(real);
    expect(snapshotDirs(result.runDir)).toEqual([real, real, real]);
    // Only the bot whose range refuses it is asked, about the run's own initiator.
    expect(result.asked).toEqual(['cli_test']);
    expect(result.operatorFor).toEqual([{ runId: 'r', binding: GROUP_TOPIC }]);
  });

  it('a colleague\'s bot (the initiator may not operate it) keeps the range: outside it the approval is refused as before', async () => {
    const d = dirs();
    const result = await approveWithDir(d.project, d.bots, { operates: { [MAIN]: 'yes', cli_doc: 'yes', cli_test: 'no' } });
    expect((result.error as Error).message).toMatch(/verify → bot\(cli_test\)：指定的工作目录不在它配置的目录范围内/);
    expect((result.error as Error).message).not.toMatch(/inspect →|write →/);
    expect(result.probeFactory).not.toHaveBeenCalled();
    expect(result.envelope.kind).toBe('missing');
  });

  it('a colleague\'s bot takes a directory inside its range without being asked; the main bot\'s own nodes follow the same rule', async () => {
    const d = dirs();
    // lab: in cli_test's range only; main and doc are operated by the initiator.
    const result = await approveWithDir(d.lab, d.bots, { operates: { [MAIN]: 'yes', cli_doc: 'yes' } });
    expect(result.error).toBeUndefined();
    if (result.envelope.kind !== 'ok') throw new Error('no envelope');
    expect(frozenNodeWorkingDir(result.envelope.envelope)).toBe(realpathSync(d.lab));
    expect(result.asked.sort()).toEqual(['cli_doc', MAIN].sort());
    // The main bot is not exempt: not operating it, its range decides.
    const mainNot = await approveWithDir(d.lab, d.bots, { operates: { cli_doc: 'yes' } });
    expect((mainNot.error as Error).message).toMatch(/inspect → bot\(cli_main\)：指定的工作目录不在/);
    expect((mainNot.error as Error).message).not.toMatch(/write →|verify →/);
  });

  it('an answer that could not be confirmed refuses outside the range, saying so and why — not "add it to the range" alone', async () => {
    const d = dirs();
    const result = await approveWithDir(d.project, d.bots, { operates: { cli_test: { unknown: '暂时查不到发起人是否还在群里' } } });
    const message = (result.error as Error).message;
    expect(message).toMatch(/verify → bot\(cli_test\)：暂时无法确认发起人能否操作它.*（暂时查不到发起人是否还在群里）/);
    expect(message).not.toMatch(/verify → bot\(cli_test\)：指定的工作目录不在它配置的目录范围内/);
    expect(result.envelope.kind).toBe('missing');
    // A thrown question is the same unknown.
    const thrown = await approveWithDir(d.project, d.bots, { answer: async (target) => {
      if (target.larkAppId === 'cli_test') throw new Error('ipc down');
      return 'no';
    } });
    expect((thrown.error as Error).message).toMatch(/verify → bot\(cli_test\)：暂时无法确认发起人能否操作它/);
  });

  it('the main bot\'s own node, its app definitively unable to see the initiator\'s union_id: the range refusal it gave before; a lookup that only failed is "could not confirm"', async () => {
    const d = dirs();
    // lab: outside the main bot's range; her union_id alone would let her through.
    const viaMainApp = (union: WorkflowWorkingDirOperatorIo['resolveUnionIdFromOpenId']) => {
      const wiring = createWorkflowWorkingDirOperatorWiring({
        resolveTargetAppOpenId: async () => ({ status: 'definitive' }),
        resolveUnionIdFromOpenId: union,
        listChatMemberOpenIds: async () => ['ou_owner'],
        canRunDaemonCommand: (_appId, _chatId, _openId, unionId) => unionId === 'on_owner',
        selfLarkAppId: () => MAIN,
      });
      return async (target: { larkAppId: string }): Promise<Operate> => target.larkAppId === MAIN
        ? wiring.initiatorOperates({ larkAppId: MAIN, chatId: GROUP_TOPIC.chatId, initiator: { sourceLarkAppId: MAIN, openId: 'ou_owner' } })
        : 'yes';
    };
    const invisible = await approveWithDir(d.lab, d.bots, { answer: viaMainApp(async () => ({ status: 'unavailable' })) });
    expect((invisible.error as Error).message).toContain('inspect → bot(cli_main)：指定的工作目录不在它配置的目录范围内（默认工作目录 / 仓库目录）');
    expect((invisible.error as Error).message).not.toMatch(/暂时无法确认/);
    expect(invisible.envelope.kind).toBe('missing');
    const failing = await approveWithDir(d.lab, d.bots, { answer: viaMainApp(async () => ({ status: 'retryable', error: '503' })) });
    expect((failing.error as Error).message).toMatch(/inspect → bot\(cli_main\)：暂时无法确认发起人能否操作它/);
    const found = await approveWithDir(d.lab, d.bots, { answer: viaMainApp(async () => ({ status: 'resolved', unionId: 'on_owner' })) });
    expect(found.error).toBeUndefined();
  });

  it('every bot that needs asking is asked at the same time, and the refusal keeps node order', async () => {
    const d = dirs();
    // root: outside every bot's range, so all three are asked.
    const pending = new Map<string, (answer: Operate) => void>();
    let askedBeforeAnyAnswer = 0;
    const answers: Record<string, Operate> = { [MAIN]: 'no', cli_doc: { unknown: 'timeout' }, cli_test: 'no' };
    const result = await approveWithDir(d.root, d.bots, { answer: (target) => new Promise<Operate>((resolve) => {
      pending.set(target.larkAppId, resolve);
      if (pending.size === 3) {
        askedBeforeAnyAnswer = pending.size;
        // Answer in reverse order: the message must still list nodes in order.
        for (const appId of ['cli_test', 'cli_doc', MAIN]) pending.get(appId)!(answers[appId]!);
      }
    }) });
    expect(askedBeforeAnyAnswer).toBe(3);
    const lines = (result.error as Error).message.split('\n').filter((line) => line.startsWith('- '));
    expect(lines.map((line) => line.slice(2, line.indexOf(' →')))).toEqual(['inspect', 'write', 'verify']);
  });

  it('a directory that does not exist is refused even for bots the initiator operates, without asking', async () => {
    const d = dirs();
    const result = await approveWithDir(join(d.lab, 'missing'), d.bots, { operates: { [MAIN]: 'yes', cli_doc: 'yes', cli_test: 'yes' } });
    expect((result.error as Error).message).toMatch(/--working-dir.*(目录不存在|does not exist)/);
    expect(result.asked).toEqual([]);
    expect(result.envelope.kind).toBe('missing');
  });

  it('with the switch off the flag behaves as before: the raw value goes into the snapshots, run.json has no marker, no range check', async () => {
    const d = dirs();
    const result = await approveWithDir('/srv/task', d.bots, { switchMode: 'ephemeral' });
    expect(result.error).toBeUndefined();
    expect(frozenExecutor(result.envelope)).toBeUndefined();
    if (result.envelope.kind !== 'ok') throw new Error('no envelope');
    expect(frozenNodeWorkingDir(result.envelope.envelope)).toBeUndefined();
    expect(JSON.parse(readFileSync(join(result.runDir, 'run.json'), 'utf-8'))).not.toHaveProperty('nodeWorkingDir');
    expect(new Set(snapshotDirs(result.runDir))).toEqual(new Set(['/srv/task']));
  });
});

describe('§6.1 eligibility (items 1–4)', () => {
  it('checks each distinct non-main bot once and reports every affected node', async () => {
    const { probe, asked } = tableProbe({ cli_doc: { grantError: 'receiver daemon offline' } });
    const result = await checkV3BotExecutorEligibility({
      orchestratorAppId: MAIN,
      targets: [
        { nodeId: 'a', larkAppId: 'cli_doc' },
        { nodeId: 'b', larkAppId: 'cli_doc' },
        { nodeId: 'c', larkAppId: MAIN },
        { nodeId: 'd', larkAppId: 'cli_ghost' },
      ],
      probe,
    });
    expect(result).toEqual({
      ok: false,
      problems: [
        { nodeId: 'a', larkAppId: 'cli_doc', code: 'COLLABORATION_DENIED', detail: 'receiver daemon offline' },
        { nodeId: 'b', larkAppId: 'cli_doc', code: 'COLLABORATION_DENIED', detail: 'receiver daemon offline' },
        { nodeId: 'd', larkAppId: 'cli_ghost', code: 'BOT_NOT_CONFIGURED' },
      ],
    });
    expect(asked.filter((entry) => entry.endsWith(':cli_doc'))).toEqual(['online:cli_doc', 'inChat:cli_doc', 'topics:cli_doc', 'grant:cli_doc']);
    expect(asked.some((entry) => entry.endsWith(`:${MAIN}`))).toBe(false);
  });

  it('P2-3: a bot that folds topic replies is told apart from an undeterminable chat mode', async () => {
    const folding = tableProbe({ cli_doc: { foldsTopics: true } }).probe;
    expect(await checkV3BotExecutorEligibility({ orchestratorAppId: MAIN, targets: [{ nodeId: 'a', larkAppId: 'cli_doc' }], probe: folding }))
      .toEqual({ ok: false, problems: [{ nodeId: 'a', larkAppId: 'cli_doc', code: 'NO_TOPIC_SESSION' }] });
    const unknown = { ...folding, opensTopicSessions: async () => ({ unknown: 'chat api down' }) };
    expect(await checkV3BotExecutorEligibility({ orchestratorAppId: MAIN, targets: [{ nodeId: 'a', larkAppId: 'cli_doc' }], probe: unknown }))
      .toEqual({ ok: false, problems: [{ nodeId: 'a', larkAppId: 'cli_doc', code: 'TOPIC_SESSION_UNKNOWN', detail: 'chat api down' }] });
  });

  it('an unknown membership answer refuses (never assumed present)', async () => {
    const { probe, asked } = tableProbe({ cli_doc: { unknown: true } });
    const result = await checkV3BotExecutorEligibility({
      orchestratorAppId: MAIN, targets: [{ nodeId: 'a', larkAppId: 'cli_doc' }], probe,
    });
    expect(result).toMatchObject({ ok: false, problems: [{ code: 'MEMBERSHIP_UNKNOWN' }] });
    expect(asked).not.toContain('grant:cli_doc');
  });
});
