/**
 * Who executes each goal node of a bot-executed run (design 2026-11-03 §6,
 * D3): the spec's user-named `assignee`, the Architect's roster of the chat's
 * eligible bots, and the Gate-2 "node → bot (CLI): reason" summary with every
 * named bot that is not honoured flagged. A run that will not be
 * bot-executed keeps today's Architect prompt and probes nothing.
 *
 * Real host commands + real architect runner; the architect worker, the
 * §6.1 probe and the bot names are fakes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cmdWorkflowHost,
  hostApproveSpec,
  hostNew,
  hostSpecFinalize,
  type ArchitectDeps,
  type WorkflowHostCommandDeps,
} from '../src/workflows/v3/host.js';
import { buildArchitectGoal, runArchitect, type RunArchitectInput } from '../src/workflows/v3/architect.js';
import { readGrillState, type RunChatBinding } from '../src/workflows/v3/grill-state.js';
import { GOAL_ENV, SPEC_SCHEMA_VERSION, type Manifest } from '../src/workflows/v3/contract.js';
import { SpecValidationError, validateSpec } from '../src/workflows/v3/spec.js';
import { readRunEnvelope } from '../src/workflows/v3/run-envelope.js';
import type { V3BotEligibilityProbe } from '../src/workflows/v3/node-executor-mode.js';

const bases: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const MAIN = 'cli_main';
// Secret-ish fields on purpose: none of them may reach the Architect.
const BOTS = [
  {
    larkAppId: MAIN, larkAppSecret: 'SECRET-main', name: 'main', cliId: 'claude-code', model: 'opus',
    workingDir: '/srv/private-main', wrapperCli: 'wrapper-private', sandboxPaths: { readWrite: ['/srv/sbx-rw'] },
  },
  { larkAppId: 'cli_doc', larkAppSecret: 'SECRET-doc', name: 'doc', cliId: 'claude-code', model: 'sonnet', workingDir: '/srv/private-doc' },
  { larkAppId: 'cli_test', larkAppSecret: 'SECRET-test', name: 'test', cliId: 'codex', workingDir: '/srv/private-test' },
  { larkAppId: 'cli_off', larkAppSecret: 'SECRET-off', name: 'off', cliId: 'seed', workingDir: '/srv/private-off' },
  { larkAppId: 'cli_pi', larkAppSecret: 'SECRET-pi', name: 'pi', cliId: 'pi', workingDir: '/srv/private-pi' },
] as any[];
const NAMES: Record<string, string> = {
  [MAIN]: '主Bot', cli_doc: '文档Bot', cli_test: '测试Bot', cli_off: '离线Bot', cli_pi: 'PiBot',
};
const nameOf = (appId: string) => NAMES[appId] ?? appId;

const GROUP_TOPIC: RunChatBinding = {
  larkAppId: MAIN, chatId: 'oc_group', chatType: 'group', rootMessageId: 'om_root', ownerOpenId: 'ou_owner',
};

const SKETCHES = [
  { sketchId: 'inspect', goal: 'inspect changes', input_needs: [], expected_outputs: ['changes.md'], acceptance: 'listed', risk_gate: false, unknowns: [] },
  { sketchId: 'write', goal: 'write report', input_needs: [], expected_outputs: ['r.md'], acceptance: 'has risks', risk_gate: false, unknowns: [], assignee: '文档Bot' },
  { sketchId: 'verify', goal: 'run tests', input_needs: [], expected_outputs: ['t.md'], acceptance: 'green', risk_gate: false, unknowns: [], assignee: '测试Bot' },
  { sketchId: 'extra', goal: 'extra', input_needs: [], expected_outputs: ['e.md'], acceptance: 'ok', risk_gate: false, unknowns: [], assignee: 'ghost' },
];

/** Fake membership: cli_test is not in the chat, cli_off's daemon is down. */
function fakeProbe() {
  const asked: string[] = [];
  const probe: V3BotEligibilityProbe = {
    isConfigured: (appId) => BOTS.some((bot) => bot.larkAppId === appId),
    isDaemonOnline: (appId) => { asked.push(`online:${appId}`); return appId !== 'cli_off'; },
    inChat: async (appId) => { asked.push(`inChat:${appId}`); return appId === 'cli_test' ? 'no' : 'yes'; },
    opensTopicSessions: async (appId) => { asked.push(`topics:${appId}`); return 'yes'; },
    ensureGrant: async (appId) => { asked.push(`grant:${appId}`); },
  };
  return { probe, asked };
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function product(outputDir: string, path: string, content: string): Manifest['files'][number] {
  writeFileSync(join(outputDir, path), content);
  return {
    name: path, path, kind: path.endsWith('.json') ? 'json' : 'markdown',
    bytes: Buffer.byteLength(content), sha256: hash(content),
    mime: path.endsWith('.json') ? 'application/json' : 'text/markdown',
  };
}

/** The real architect runner over a fake worker that writes `dagNodes` and
 *  `notes`, recording the goal it was given. */
function fakeArchitect(dagNodes: unknown[], notes: string) {
  const goals: string[] = [];
  const inputs: RunArchitectInput[] = [];
  const run: ArchitectDeps['runArchitect'] = async (input) => {
    inputs.push(input);
    return runArchitect({
      ...input,
      runNode: async (req) => {
        goals.push(req.node.goal);
        const files = [
          product(req.outputDir, 'dag.json', JSON.stringify({ schemaVersion: 2, runId: input.runId, nodes: dagNodes })),
          product(req.outputDir, 'architect-notes.md', notes),
        ];
        const manifestPath = req.env[GOAL_ENV.MANIFEST_PATH]!;
        writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, status: 'ok', summary: 'ok', files }));
        return { status: 'ok', manifestPath };
      },
    });
  };
  return { run, goals, inputs };
}

const goal = (id: string, bot?: string) => ({ id, type: 'goal', goal: id, depends: [], inputs: [], ...(bot ? { bot } : {}) });
const DAG_NODES = [goal('inspect', MAIN), goal('write', 'cli_doc'), goal('verify', MAIN), goal('extra')];
const NOTES = [
  '# Notes',
  '- inspect → report: this line is outside the assignment section and must be ignored',
  '',
  '## Bot assignments',
  '- inspect → cli_main: 默认交给主 Bot',
  '- write → cli_doc: 用户点名文档Bot',
  '- verify → cli_main: 测试Bot 不在本群，改由主 Bot 跑',
  '- extra → cli_main: 点名的 ghost 不存在',
  '',
  '## Risks',
  '- none',
].join('\n');

function specApprovedRun(binding: RunChatBinding | undefined, sketches: unknown[] = SKETCHES) {
  const base = mkdtempSync(join(tmpdir(), 'wf-assign-'));
  bases.push(base);
  const { runDir, runId } = hostNew({ goal: 'g', baseDir: base, runId: 'r', ...(binding ? { chatBinding: binding } : {}) });
  writeFileSync(join(runDir, 'spec.md'), `# Spec\n\`\`\`json\n${JSON.stringify({
    schemaVersion: SPEC_SCHEMA_VERSION, runId, title: '代码风险报告', requirement: 'r', nodes: sketches,
  })}\n\`\`\`\n`);
  expect(hostSpecFinalize(runDir).ok).toBe(true);
  hostApproveSpec(runDir);
  return { base, runDir };
}

async function architect(base: string, opts: {
  switchMode: 'ephemeral' | 'bot';
  binding: RunChatBinding | undefined;
  dagNodes?: unknown[];
  notes?: string;
  multiTopic?: boolean;
}) {
  const worker = fakeArchitect(opts.dagNodes ?? DAG_NODES, opts.notes ?? NOTES);
  const { probe, asked } = fakeProbe();
  const probeFactory = vi.fn(() => probe);
  const nameFactory = vi.fn(() => nameOf);
  const roleFactory = vi.fn(() => (appId: string) => (appId === 'cli_doc' ? '写文档，\n擅长整理报告' : undefined));
  const deps: WorkflowHostCommandDeps = {
    loadBots: () => BOTS,
    resolveChatBinding: () => opts.binding,
    nodeExecutorSwitch: () => opts.switchMode,
    multiTopicEnabled: () => opts.multiTopic ?? true,
    botEligibilityProbe: probeFactory,
    botDisplayName: nameFactory,
    botRole: roleFactory,
    runArchitect: worker.run,
  };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await cmdWorkflowHost('architect', ['r', '--base-dir', base], deps);
    return {
      output: log.mock.calls.flat().join('\n'),
      errors: error.mock.calls.flat().join('\n'),
      worker, asked, probeFactory, nameFactory, roleFactory,
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
    process.exitCode = undefined;
  }
}

function rosterOf(goalText: string): Array<Record<string, unknown>> {
  return goalText.split('\n')
    .filter((line) => line.startsWith('  {'))
    .map((line) => JSON.parse(line.trim()) as Record<string, unknown>);
}

describe('spec: the user-named assignee', () => {
  const base = { schemaVersion: SPEC_SCHEMA_VERSION, runId: 'r', title: 't', requirement: 'q' };

  it('is kept (trimmed) when named and absent from the normalized node otherwise', () => {
    const spec = validateSpec({ ...base, nodes: [{ ...SKETCHES[0] }, { ...SKETCHES[1], assignee: '  文档Bot ' }] });
    expect(spec.nodes[1]!.assignee).toBe('文档Bot');
    expect(Object.keys(spec.nodes[0]!)).not.toContain('assignee');
  });

  it.each([[''], ['   '], [42], ['x'.repeat(129)]])('rejects an unusable assignee %j', (assignee) => {
    expect(() => validateSpec({ ...base, nodes: [{ ...SKETCHES[0], assignee }] })).toThrow(SpecValidationError);
  });
});

describe('architect: a run that will not be bot-executed', () => {
  it.each([
    ['switch off', 'ephemeral' as const, GROUP_TOPIC, true],
    ['switch on, private chat', 'bot' as const, { ...GROUP_TOPIC, chatType: 'p2p' as const }, true],
    ['switch on, multi-topic off', 'bot' as const, GROUP_TOPIC, false],
  ])('%s: today\'s prompt, no roster, nothing probed', async (_label, switchMode, binding, multiTopic) => {
    const { base, runDir } = specApprovedRun(binding as RunChatBinding);
    const result = await architect(base, { switchMode, binding: binding as RunChatBinding, multiTopic, dagNodes: [goal('inspect')], notes: '# Notes' });
    const state = readGrillState(runDir)!;
    expect(state.status).toBe('dag_ready');
    expect(result.worker.inputs[0]!.botAssignment).toBeUndefined();
    expect(result.worker.goals).toEqual([buildArchitectGoal(state.specPath, state.specJsonPath)]);
    expect(result.probeFactory).not.toHaveBeenCalled();
    expect(result.roleFactory).not.toHaveBeenCalled();
    expect(result.asked).toEqual([]);
  });
});

describe('architect: a bot-executed run', () => {
  it('gets a roster of the chat\'s eligible bots with no secrets, paths or sandbox config', async () => {
    const { base } = specApprovedRun(GROUP_TOPIC);
    const result = await architect(base, { switchMode: 'bot', binding: GROUP_TOPIC });
    const goalText = result.worker.goals[0]!;
    const roster = rosterOf(goalText);
    expect(roster.map((bot) => bot.larkAppId)).toEqual([MAIN, 'cli_doc']);
    expect(roster[0]).toMatchObject({ name: '主Bot', cli: 'claude-code', model: 'opus', main: true });
    expect(roster[1]).toEqual({ larkAppId: 'cli_doc', name: '文档Bot', cli: 'claude-code', model: 'sonnet', role: '写文档， 擅长整理报告' });
    for (const bot of roster) {
      for (const key of Object.keys(bot)) expect(['larkAppId', 'name', 'cli', 'model', 'role', 'main']).toContain(key);
    }
    for (const leaked of ['SECRET-', '/srv/', 'wrapper-private']) expect(goalText).not.toContain(leaked);
    // Listing candidates writes no chat grant (approve-dag grants the bots it uses).
    expect(result.asked.filter((entry) => entry.startsWith('grant:'))).toEqual([]);
  });

  it('binds a resolvable assignee and tells the Architect why the others cannot be honoured', async () => {
    const { base } = specApprovedRun(GROUP_TOPIC);
    const result = await architect(base, { switchMode: 'bot', binding: GROUP_TOPIC });
    const lines = result.worker.goals[0]!.split('\n');
    expect(lines).toContain('  - sketch "write" → cli_doc (the user named "文档Bot")');
    const verify = lines.find((line) => line.includes('sketch "verify"'))!;
    expect(verify).toContain('cli_test');
    expect(verify).not.toMatch(/→ cli_test/);
    expect(lines.find((line) => line.includes('sketch "extra"'))).toBeDefined();
    expect(lines.some((line) => line.includes('sketch "inspect"'))).toBe(false);
    expect(result.worker.inputs[0]!.botAssignment!.assignees.map((entry) => [entry.sketchId, entry.target.kind, entry.unavailable !== undefined]))
      .toEqual([['write', 'bot', false], ['verify', 'bot', true], ['extra', 'unknown', false]]);
  });

  it('sends a dag that uses a bot outside the roster back to spec_approved', async () => {
    const { base, runDir } = specApprovedRun(GROUP_TOPIC);
    const result = await architect(base, {
      switchMode: 'bot', binding: GROUP_TOPIC, dagNodes: [goal('inspect', 'cli_test'), goal('write', 'cli_doc')],
    });
    const state = readGrillState(runDir)!;
    expect(state.status).toBe('spec_approved');
    expect(state.problems?.join('\n')).toMatch(/inspect.*cli_test/);
    expect(result.errors).toMatch(/cli_test/);
  });

  it('Gate-2 preview: node → bot (CLI): reason, and every named bot not honoured is flagged', async () => {
    const { base } = specApprovedRun(GROUP_TOPIC);
    const { output } = await architect(base, { switchMode: 'bot', binding: GROUP_TOPIC });
    const lines = output.split('\n');
    expect(lines).toContain('- inspect → 主Bot（claude-code，主 Bot 自己）：默认交给主 Bot');
    expect(lines).toContain('- write → 文档Bot（claude-code）：用户点名文档Bot');
    const verify = lines.find((line) => line.includes('verify →'))!;
    expect(verify.startsWith('- ⚠️ ')).toBe(true);
    expect(verify).toContain('点名「测试Bot」未满足');
    expect(verify).toContain('不在本群');
    const extra = lines.filter((line) => line.includes('extra'));
    expect(extra.some((line) => line.startsWith('- ⚠️ extra') && line.includes('点名「ghost」'))).toBe(true);
    expect(lines.find((line) => line.startsWith('- write'))).not.toContain('⚠️');
    expect(lines.some((line) => line.startsWith('⚠️ 有 2 处点名'))).toBe(true);
  });
});

describe('approve-dag summary of a bot-executed run', () => {
  async function approve(base: string, probe: V3BotEligibilityProbe) {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await cmdWorkflowHost('approve-dag', ['r', '--base-dir', base], {
        loadBots: () => BOTS,
        resolveChatBinding: () => GROUP_TOPIC,
        nodeExecutorSwitch: () => 'bot',
        multiTopicEnabled: () => true,
        botEligibilityProbe: () => probe,
        botDisplayName: () => nameOf,
      });
      return log.mock.calls.flat().join('\n');
    } finally {
      log.mockRestore();
    }
  }

  it('lists node → bot (CLI): reason and flags the named bots that are not honoured', async () => {
    const { base, runDir } = specApprovedRun(GROUP_TOPIC);
    await architect(base, { switchMode: 'bot', binding: GROUP_TOPIC });
    const output = await approve(base, fakeProbe().probe);
    expect(readRunEnvelope(runDir)).toMatchObject({ kind: 'ok', envelope: { nodeExecutor: 'bot' } });
    const lines = output.split('\n');
    expect(lines).toContain('- write → 文档Bot（claude-code）：用户点名文档Bot');
    expect(lines.find((line) => line.includes('verify →'))).toMatch(/^- ⚠️ verify → 主Bot.*点名「测试Bot」未满足/);
    expect(lines.some((line) => line.startsWith('- ⚠️ extra') && line.includes('不是本机配置的 Bot'))).toBe(true);
  });

  it('a reason written for another bot than the frozen one is not shown', async () => {
    const { base } = specApprovedRun(GROUP_TOPIC, [SKETCHES[0]]);
    await architect(base, {
      switchMode: 'bot', binding: GROUP_TOPIC, dagNodes: [goal('inspect', 'cli_doc')],
      notes: '## Bot assignments\n- inspect → cli_main: 主 Bot 最合适',
    });
    const lines = (await approve(base, fakeProbe().probe)).split('\n');
    expect(lines).toContain('- inspect → 文档Bot（claude-code）');
  });

  it('still refuses an ineligible executing bot (the #2710 check) before anything is published', async () => {
    const { base, runDir } = specApprovedRun(GROUP_TOPIC, [SKETCHES[0]]);
    await architect(base, { switchMode: 'bot', binding: GROUP_TOPIC, dagNodes: [goal('inspect', 'cli_doc')], notes: '# n' });
    const { probe } = fakeProbe();
    const refusing = { ...probe, inChat: async () => 'no' as const };
    await expect(approve(base, refusing)).rejects.toThrow(/inspect → 文档Bot/);
    expect(readRunEnvelope(runDir).kind).toBe('missing');
  });
});

describe('spec.json of a run that names nobody', () => {
  it('serializes without an assignee key', () => {
    const { runDir } = specApprovedRun(undefined, [SKETCHES[0]]);
    const raw = JSON.parse(readFileSync(readGrillState(runDir)!.specJsonPath, 'utf-8'));
    expect(Object.keys(raw.nodes[0])).not.toContain('assignee');
  });
});
