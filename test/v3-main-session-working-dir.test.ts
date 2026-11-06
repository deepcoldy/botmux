/**
 * The main bot's own main-topic nodes run IN the main session (design
 * 2026-11-03 §5.2 rule 2), and that session already runs in its own
 * directory when `/workflow` is sent. A frozen node working directory
 * (§15.4, `approve-dag --working-dir`) other than that one can never be
 * honoured for them — the runtime blocks the node with WORKING_DIR_REFUSED —
 * so every entry that would freeze such a combination refuses it up front:
 * Gate-2, a runtime flow edit, a blocked-card reassignment. An unknown main
 * session directory is not refused there (the runtime gate stays).
 *
 * Also: the placement refusals name bots by their display name.
 *
 * Real host commands, run-edit, daemon driver, blocked-card handler and
 * engine over temp run dirs; the Architect worker, probes, names and the
 * main-session lookup are fakes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runArchitect } from '../src/workflows/v3/architect.js';
import {
  cmdWorkflowHost,
  hostApproveSpec,
  hostNew,
  hostSpecFinalize,
  type ArchitectDeps,
  type WorkflowHostCommandDeps,
} from '../src/workflows/v3/host.js';
import { readGrillState, type RunChatBinding } from '../src/workflows/v3/grill-state.js';
import { GOAL_ENV, SPEC_SCHEMA_VERSION, type Manifest } from '../src/workflows/v3/contract.js';
import type { V3BotEligibilityProbe } from '../src/workflows/v3/node-executor-mode.js';
import { artifactRef, makeAdHocRunEnvelope, publishRunEnvelopeOnce, readRunEnvelope } from '../src/workflows/v3/run-envelope.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import { applyV3RunEdit } from '../src/workflows/v3/run-edit.js';
import { createV3GateRunner } from '../src/workflows/v3/daemon-run.js';
import {
  V3_BLOCKED_REASSIGN_ACTION,
  V3_BLOCKED_REASSIGN_FIELD,
  v3BlockedCardNonce,
  type V3ReassignActionValue,
} from '../src/im/lark/v3-blocked-card.js';
import { handleV3BlockedAction } from '../src/im/lark/v3-blocked-card-handler.js';
import { buildV3BlockedCardForRun, type V3BlockedReassignDeps } from '../src/im/lark/v3-blocked-reassign.js';
import { liveV3MainSessionWorkingDir } from '../src/im/lark/v3-bot-eligibility.js';
import { FakeExecutor } from './helpers/v3-external-harness.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

const MAIN = 'cli_main';
const NAMES: Record<string, string> = { [MAIN]: '主Bot', cli_x: '文档Bot' };
const nameOf = (id: string) => NAMES[id] ?? id;
const goal = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: 'goal', goal: `do ${id}`, depends: [], inputs: [], ...extra });

/** Two directories inside every bot's range: the main session's, and another. */
function workspace() {
  const root = tempDir('wf-main-session-dir-');
  const sessionDir = join(root, 'session');
  const otherDir = join(root, 'other');
  mkdirSync(sessionDir);
  mkdirSync(otherDir);
  return { root, sessionDir, otherDir };
}

// ─── Gate-2 ──────────────────────────────────────────────────────────────

const GROUP: RunChatBinding = { larkAppId: MAIN, chatId: 'oc_g', chatType: 'group', rootMessageId: 'om_root', ownerOpenId: 'ou_owner', sessionId: 's1' };
const okProbe: V3BotEligibilityProbe = {
  isConfigured: () => true, isDaemonOnline: () => true, inChat: async () => 'yes',
  opensTopicSessions: async () => 'yes', ensureGrant: async () => {},
};
const NOTES = '## Bot assignments\n- collect → cli_x: 整理\n- summary → cli_main: 汇总\n';

function product(outputDir: string, path: string, content: string): Manifest['files'][number] {
  writeFileSync(join(outputDir, path), content);
  return {
    name: path, path, kind: path.endsWith('.json') ? 'json' : 'markdown', bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'), mime: path.endsWith('.json') ? 'application/json' : 'text/markdown',
  };
}

function fakeArchitect(nodes: unknown[]): ArchitectDeps['runArchitect'] {
  return async (input) => runArchitect({
    ...input,
    runNode: async (req) => {
      const files = [
        product(req.outputDir, 'dag.json', JSON.stringify({ schemaVersion: 2, runId: input.runId, nodes })),
        product(req.outputDir, 'architect-notes.md', NOTES),
      ];
      const manifestPath = req.env[GOAL_ENV.MANIFEST_PATH]!;
      writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, status: 'ok', summary: 'ok', files }));
      return { status: 'ok', manifestPath };
    },
  });
}

/** A grill whose Architect produced `nodes` (dag_ready). */
async function dagReady(nodes: unknown[], bots: unknown[]) {
  const base = tempDir('wf-main-session-gate2-');
  const { runDir, runId } = hostNew({ goal: 'g', baseDir: base, runId: 'r', chatBinding: GROUP });
  writeFileSync(join(runDir, 'spec.md'), `# Spec\n\`\`\`json\n${JSON.stringify({
    schemaVersion: SPEC_SCHEMA_VERSION, runId, title: '周报', requirement: 'r',
    nodes: ['collect', 'summary'].map((sketchId) => ({ sketchId, goal: sketchId, input_needs: [], expected_outputs: ['o'], acceptance: 'ok', risk_gate: false, unknowns: [] })),
  })}\n\`\`\`\n`);
  expect(hostSpecFinalize(runDir).ok).toBe(true);
  hostApproveSpec(runDir);
  await host('architect', base, [], bots, { runArchitect: fakeArchitect(nodes) });
  return { base, runDir };
}

async function host(
  sub: 'architect' | 'approve-dag',
  base: string,
  args: string[],
  bots: unknown[],
  extra: Partial<WorkflowHostCommandDeps>,
) {
  const previousExitCode = process.exitCode;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await cmdWorkflowHost(sub, ['r', '--base-dir', base, ...args], {
      loadBots: () => bots as never,
      resolveChatBinding: () => GROUP,
      nodeExecutorSwitch: () => 'bot',
      multiTopicEnabled: () => true,
      botEligibilityProbe: () => okProbe,
      botDisplayName: () => nameOf,
      botRole: () => () => undefined,
      mainTopicAvailability: () => ({ available: true }),
      ...extra,
    });
    return log.mock.calls.flat().join('\n');
  } finally {
    log.mockRestore();
    error.mockRestore();
    process.exitCode = previousExitCode ?? 0;
  }
}

describe('Gate-2: a working dir for the main bot\'s own main-topic node', () => {
  const OWN_MAIN = [goal('collect', { bot: 'cli_x' }), goal('summary', { bot: MAIN, placement: 'main', depends: ['collect'] })];
  const botsIn = (root: string) => [
    { larkAppId: MAIN, larkAppSecret: 's', name: 'main', cliId: 'claude-code', workingDir: root },
    { larkAppId: 'cli_x', larkAppSecret: 's', name: 'x', cliId: 'claude-code', workingDir: root },
  ];

  it('other than the main session\'s is refused, naming the main session\'s directory; nothing is published', async () => {
    const { root, sessionDir, otherDir } = workspace();
    const { base, runDir } = await dagReady(OWN_MAIN, botsIn(root));
    const approve = host('approve-dag', base, ['--working-dir', otherDir], botsIn(root), { mainSessionWorkingDir: () => sessionDir });
    await expect(approve).rejects.toThrow(sessionDir);
    await expect(approve).rejects.toThrow(/summary/);
    expect(readRunEnvelope(runDir).kind).toBe('missing');
  });

  it('the main session\'s own directory (compared after resolving links) is approved and frozen', async () => {
    const { root, sessionDir } = workspace();
    const link = join(root, 'link-to-session');
    symlinkSync(sessionDir, link);
    const { base, runDir } = await dagReady(OWN_MAIN, botsIn(root));
    await host('approve-dag', base, ['--working-dir', sessionDir], botsIn(root), { mainSessionWorkingDir: () => link });
    expect(readRunEnvelope(runDir)).toMatchObject({ kind: 'ok', envelope: { nodeExecutor: 'bot', nodeWorkingDir: sessionDir } });
  });

  it.each([
    ['the main session\'s directory is unknown (the runtime gate decides)', OWN_MAIN, () => undefined],
    ['the node opens its own topic', [goal('collect', { bot: 'cli_x' }), goal('summary', { bot: MAIN, depends: ['collect'] })], undefined],
    ['another bot runs the main-topic node', [goal('collect', { bot: MAIN }), goal('summary', { bot: 'cli_x', placement: 'main', depends: ['collect'] })], undefined],
  ])('is not refused when %s', async (_label, nodes, lookup) => {
    const { root, sessionDir, otherDir } = workspace();
    const { base, runDir } = await dagReady(nodes, botsIn(root));
    await host('approve-dag', base, ['--working-dir', otherDir], botsIn(root), {
      mainSessionWorkingDir: lookup ?? (() => sessionDir),
    });
    expect(readRunEnvelope(runDir)).toMatchObject({ kind: 'ok', envelope: { nodeWorkingDir: otherDir } });
  });

  it('without --working-dir the main session is not even consulted', async () => {
    const { root } = workspace();
    const { base, runDir } = await dagReady(OWN_MAIN, botsIn(root));
    const lookup = vi.fn(() => '/nowhere');
    await host('approve-dag', base, [], botsIn(root), { mainSessionWorkingDir: lookup });
    expect(lookup).not.toHaveBeenCalled();
    expect(readRunEnvelope(runDir)).toMatchObject({ kind: 'ok', envelope: { nodeExecutor: 'bot' } });
  });

  describe('read from the main session\'s persisted row (real session store)', () => {
    /** The main session `s1` (GROUP.sessionId) persisted as `row`. */
    function persistedMainSession(row: Record<string, unknown>): string {
      const dataDir = tempDir('wf-main-session-store-');
      seedPersistedSessionRows(dataDir, MAIN, {
        s1: { sessionId: 's1', chatId: 'oc_g', rootMessageId: 'om_root', scope: 'thread', title: 's1', status: 'active', createdAt: '2026-11-06T00:00:00.000Z', ...row },
      });
      return dataDir;
    }
    const liveLookup = (dataDir: string): WorkflowHostCommandDeps['mainSessionWorkingDir'] =>
      (binding, bots) => liveV3MainSessionWorkingDir(binding, bots, dataDir);

    it('a session that never pinned its directory runs in the main bot\'s default: another dir is refused', async () => {
      const { root, sessionDir, otherDir } = workspace();
      const bots = botsIn(root).map((bot) => (bot.larkAppId === MAIN ? { ...bot, defaultWorkingDir: sessionDir } : bot));
      const { base, runDir } = await dagReady(OWN_MAIN, bots);
      const dataDir = persistedMainSession({});
      await expect(host('approve-dag', base, ['--working-dir', otherDir], bots, { mainSessionWorkingDir: liveLookup(dataDir) }))
        .rejects.toThrow(sessionDir);
      expect(readRunEnvelope(runDir).kind).toBe('missing');
    });

    it('a pinned session decides by its own directory', async () => {
      const { root, sessionDir, otherDir } = workspace();
      const { base, runDir } = await dagReady(OWN_MAIN, botsIn(root));
      const dataDir = persistedMainSession({ workingDir: sessionDir });
      await expect(host('approve-dag', base, ['--working-dir', otherDir], botsIn(root), { mainSessionWorkingDir: liveLookup(dataDir) }))
        .rejects.toThrow(sessionDir);
      expect(readRunEnvelope(runDir).kind).toBe('missing');
    });

    it('a closed main session takes no part (the node would start a new session in the frozen dir)', async () => {
      const { root, sessionDir, otherDir } = workspace();
      const { base, runDir } = await dagReady(OWN_MAIN, botsIn(root));
      const dataDir = persistedMainSession({ workingDir: sessionDir, status: 'closed' });
      await host('approve-dag', base, ['--working-dir', otherDir], botsIn(root), { mainSessionWorkingDir: liveLookup(dataDir) });
      expect(readRunEnvelope(runDir)).toMatchObject({ kind: 'ok', envelope: { nodeWorkingDir: otherDir } });
    });
  });

  it('a placement refusal names the bot by its display name', async () => {
    const { root } = workspace();
    const parallel = [goal('collect', { bot: 'cli_x', placement: 'main' }), goal('summary', { bot: 'cli_x', placement: 'main' })];
    const { base } = await dagReady([goal('collect', { bot: 'cli_x' }), goal('summary', { bot: MAIN, depends: ['collect'] })], botsIn(root));
    // A dag that reached dag_ready some other way (the Architect would have refused it).
    writeFileSync(readGrillState(join(base, 'r'))!.dagPath!, JSON.stringify({ schemaVersion: 2, runId: 'r', nodes: parallel }));
    await expect(host('approve-dag', base, [], botsIn(root), {})).rejects.toThrow(NAMES.cli_x!);
  });
});

// ─── Runtime edits and reassignment ──────────────────────────────────────

/** An authorized bot-executed run frozen with `nodeWorkingDir`, journal started. */
function seedRun(nodes: unknown[], workingDir: string | undefined) {
  const base = tempDir('wf-main-session-run-');
  const runId = 'r';
  const runDir = join(base, runId);
  mkdirSync(runDir, { recursive: true });
  const write = (name: string, value: unknown) => writeFileSync(join(runDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write('dag.json', { schemaVersion: 2, runId, nodes });
  write('spec.json', {
    schemaVersion: 1, runId, title: '周报', requirement: 'r',
    nodes: [{ sketchId: 'a', goal: 'g', input_needs: [], expected_outputs: ['o'], acceptance: 'ok', risk_gate: false, unknowns: [] }],
  });
  write('bots.snapshot.json', {
    '': { larkAppId: MAIN, cliId: 'claude-code', workingDir: '/w' },
    [MAIN]: { larkAppId: MAIN, cliId: 'claude-code', workingDir: '/w' },
    cli_x: { larkAppId: 'cli_x', cliId: 'claude-code', workingDir: '/w' },
  });
  publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
    runId, createdAt: '2026-11-06T00:00:00.000Z', authorizedAt: '2026-11-06T00:01:00.000Z',
    authorizedByOpenId: 'ou_owner', chatBinding: GROUP,
    artifacts: { dag: artifactRef(runDir, 'dag.json'), spec: artifactRef(runDir, 'spec.json'), botSnapshots: artifactRef(runDir, 'bots.snapshot.json') },
    nodeExecutor: 'bot',
    ...(workingDir !== undefined ? { nodeWorkingDir: workingDir } : {}),
  }));
  appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId, nodeExecutor: 'bot' });
  return { base, runId, runDir };
}

describe('a runtime edit that makes a node the main bot\'s own main-topic node', () => {
  const edit = (base: string, ops: unknown[], mainSessionDir: string | undefined) => applyV3RunEdit({
    baseDir: base, runId: 'r', patch: { ops }, baseRevision: 1,
    caller: { openId: 'ou_owner', origin: 'human' },
    resolveNewBotSnapshot: () => { throw new Error('no new bots'); },
    mainTopic: { available: true },
    nameOf,
    ...(mainSessionDir !== undefined ? { mainSessionDir } : {}),
  });

  it.each([
    ['moved into the main topic', [goal('a', { bot: 'cli_x' }), goal('b', { bot: MAIN, depends: ['a'] })],
      [{ op: 'updateNode', nodeId: 'b', set: { placement: 'main' } }]],
    ['moved to the main bot', [goal('a', { bot: 'cli_x' }), goal('b', { bot: 'cli_x', placement: 'main', depends: ['a'] })],
      [{ op: 'reassign', nodeId: 'b', bot: MAIN }]],
    ['added as one', [goal('a', { bot: 'cli_x' })],
      [{ op: 'addNode', node: goal('c', { placement: 'main', depends: ['a'] }) }]],
  ])('is refused when %s and the frozen dir is not the main session\'s', (_label, nodes, ops) => {
    const { sessionDir, otherDir } = workspace();
    const { base, runDir } = seedRun(nodes, otherDir);
    const before = readJournal(join(runDir, 'journal.ndjson')).length;
    const refused = edit(base, ops, sessionDir);
    expect(refused).toMatchObject({ kind: 'invalid', problems: [expect.stringContaining(sessionDir)] });
    expect(readJournal(join(runDir, 'journal.ndjson'))).toHaveLength(before);
  });

  it.each([
    ['the frozen dir is the main session\'s', (dirs: ReturnType<typeof workspace>) => ({ frozen: dirs.sessionDir, session: dirs.sessionDir })],
    ['the main session\'s directory is unknown', (dirs: ReturnType<typeof workspace>) => ({ frozen: dirs.otherDir, session: undefined })],
    ['the run froze no dir', (dirs: ReturnType<typeof workspace>) => ({ frozen: undefined, session: dirs.sessionDir })],
  ])('is applied when %s', (_label, pick) => {
    const ws = workspace();
    const { frozen, session } = pick(ws);
    const { base } = seedRun([goal('a', { bot: 'cli_x' }), goal('b', { bot: MAIN, depends: ['a'] })], frozen);
    expect(edit(base, [{ op: 'updateNode', nodeId: 'b', set: { placement: 'main' } }], session)).toMatchObject({ kind: 'applied' });
  });

  it('is refused when a later edit moves a node back to the main bot after an earlier one moved it away', () => {
    const { sessionDir, otherDir } = workspace();
    const { base, runDir } = seedRun([goal('a', { bot: 'cli_x' }), goal('b', { bot: MAIN, placement: 'main', depends: ['a'] })], otherDir);
    const away = edit(base, [{ op: 'reassign', nodeId: 'b', bot: 'cli_x' }], sessionDir);
    expect(away).toMatchObject({ kind: 'applied' });
    const back = applyV3RunEdit({
      baseDir: base, runId: 'r', patch: { ops: [{ op: 'reassign', nodeId: 'b', bot: MAIN }] }, baseRevision: (away as { revision: number }).revision,
      caller: { openId: 'ou_owner', origin: 'human' },
      resolveNewBotSnapshot: () => { throw new Error('no new bots'); },
      mainTopic: { available: true }, nameOf, mainSessionDir: sessionDir,
    });
    expect(back).toMatchObject({ kind: 'invalid', problems: [expect.stringContaining(sessionDir)] });
    expect(readJournal(join(runDir, 'journal.ndjson')).filter((event) => event.type === 'dagRevised')).toHaveLength(1);
  });

  it('does not re-judge a node that already was one when something else changes', () => {
    const { sessionDir, otherDir } = workspace();
    const { base } = seedRun([goal('a', { bot: 'cli_x' }), goal('b', { bot: MAIN, placement: 'main', depends: ['a'] })], otherDir);
    expect(edit(base, [{ op: 'updateNode', nodeId: 'a', set: { goal: 'changed' } }], sessionDir)).toMatchObject({ kind: 'applied' });
  });

  it('a rule-1 refusal names the bot by its display name', () => {
    const { base } = seedRun([goal('a', { bot: 'cli_x', placement: 'main' })], undefined);
    const refused = edit(base, [{ op: 'addNode', node: goal('c', { bot: 'cli_x', placement: 'main' }) }], undefined);
    expect(refused).toMatchObject({ kind: 'invalid', problems: [expect.stringContaining(NAMES.cli_x!)] });
  });
});

describe('a blocked-card reassignment to the main bot', () => {
  const probe: V3BotEligibilityProbe = okProbe;

  async function blockedNode(frozen: string, mainSessionDir: string | undefined, placement: 'main' | 'topic' = 'main') {
    const { base, runId } = seedRun([goal('w', { bot: 'cli_x', ...(placement === 'main' ? { placement } : {}) })], frozen);
    const executor = new FakeExecutor();
    executor.onDispatch = (req) => (req.attemptNumber === 1
      ? { kind: 'rejected', code: 'BOT_OFFLINE' }
      : { kind: 'sent', handoffMessageId: `om_${req.attemptId}` });
    const deps: V3BlockedReassignDeps = { probe: () => probe, nameOf, mainSessionDir: () => mainSessionDir };
    const cards: string[] = [];
    const runner = createV3GateRunner({
      baseDir: base,
      loadBots: () => [],
      makeRunNode: () => async () => { throw new Error('bot mode never spawns a worker'); },
      externalExecutor: executor,
      now: () => 10_000,
      postCard: async () => {},
      postBlockedCard: async (_binding, info, id) => {
        cards.push(await buildV3BlockedCardForRun({ runDir: join(base, id), runId: id, info, reassign: deps }));
      },
      scheduleWake: () => {},
    });
    await runner.drive(runId);
    expect(cards).toHaveLength(1);
    const form = (JSON.parse(cards[0]!).elements as any[]).find((element) => element.tag === 'form');
    const options: string[] = (form?.elements.find((element: any) => element.tag === 'select_static')?.options ?? [])
      .map((option: any) => option.value);
    // With nobody to offer the card has no form; a stale or forged click
    // carries the same value a form would.
    const blocked = readJournal(join(base, runId, 'journal.ndjson')).find((event) => event.type === 'nodeBlocked')!;
    const attemptId = (blocked as { attemptId: string }).attemptId;
    const value: V3ReassignActionValue = form?.elements.find((element: any) => element.tag === 'button').value
      ?? { action: V3_BLOCKED_REASSIGN_ACTION, runId, nodeId: 'w', attemptId, nonce: v3BlockedCardNonce(runId, 'w', attemptId) };
    const click = () => handleV3BlockedAction(
      value, 'ou_owner', { baseDir: base, driveRun: () => {}, canResolve: () => true, reassign: deps },
      { [V3_BLOCKED_REASSIGN_FIELD]: MAIN }, MAIN,
    ) as Promise<any>;
    return { card: cards[0]!, options, click, reassigned: () => readJournal(join(base, runId, 'journal.ndjson')).filter((event) => event.type === 'nodeReassigned') };
  }

  it('is not offered, and a click is refused, when the frozen dir is not the main session\'s', async () => {
    const { sessionDir, otherDir } = workspace();
    const run = await blockedNode(otherDir, sessionDir);
    expect(run.options).not.toContain(MAIN);
    const out = await run.click();
    expect(out.toast).toMatchObject({ type: 'warning', content: expect.stringContaining(sessionDir) });
    expect(run.reassigned()).toEqual([]);
  });

  it('a node-topic node still goes to the main bot when the dirs differ (only main-topic nodes run in the main session)', async () => {
    const { sessionDir, otherDir } = workspace();
    const run = await blockedNode(otherDir, sessionDir, 'topic');
    expect(run.options).toContain(MAIN);
    await run.click();
    expect(run.reassigned()).toEqual([expect.objectContaining({ nodeId: 'w', to: MAIN })]);
  });

  it('goes through when the frozen dir is the main session\'s', async () => {
    const { sessionDir } = workspace();
    const run = await blockedNode(sessionDir, sessionDir);
    expect(run.options).toContain(MAIN);
    await run.click();
    expect(run.reassigned()).toEqual([expect.objectContaining({ nodeId: 'w', to: MAIN })]);
  });
});
