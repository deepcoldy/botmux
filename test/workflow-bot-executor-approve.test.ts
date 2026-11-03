/**
 * "节点交给群里的 Bot 执行" at authorization time (design 2026-11-03 §6.3,
 * D1, P4): Gate-2 `approve-dag` and Saved Workflow materialization freeze
 * `nodeExecutor: "bot"` into run.json only when the experimental switch is on
 * AND the run lives in a group chat topic with multi-topic orchestration on;
 * otherwise they keep today's ephemeral execution and say why. A bot run is
 * refused (nothing published) when a node's bot fails §6.1 items 1–4.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { readRunEnvelope } from '../src/workflows/v3/run-envelope.js';
import type { V3BotEligibilityProbe } from '../src/workflows/v3/node-executor-mode.js';
import { checkV3BotExecutorEligibility } from '../src/workflows/v3/node-executor-mode.js';

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
  writeFileSync(dagPath, JSON.stringify({ runId: 'r', nodes }));
  return { base, runDir };
}

/** A probe that records what it was asked and answers from a table. */
function tableProbe(table: Partial<Record<string, { offline?: boolean; notInChat?: boolean; grantError?: string; unknown?: boolean }>>) {
  const asked: string[] = [];
  const probe: V3BotEligibilityProbe = {
    isConfigured: (appId) => BOTS.some((bot) => bot.larkAppId === appId),
    isDaemonOnline: (appId) => { asked.push(`online:${appId}`); return !table[appId]?.offline; },
    inChat: async (appId) => {
      asked.push(`inChat:${appId}`);
      if (table[appId]?.unknown) return { unknown: 'api timeout' };
      return table[appId]?.notInChat ? 'no' : 'yes';
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
    expect(asked.filter((entry) => entry.endsWith(':cli_doc'))).toEqual(['online:cli_doc', 'inChat:cli_doc', 'grant:cli_doc']);
    expect(asked.some((entry) => entry.endsWith(`:${MAIN}`))).toBe(false);
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
