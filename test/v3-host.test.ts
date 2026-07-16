import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  hostNew,
  hostSpecFinalize,
  hostApproveSpec,
  hostArchitect,
  hostApproveDag,
  authorizeAdHocRun,
  hostReviseSpec,
  hostReviseDag,
  cmdWorkflowHost,
  chatBindingFromEnv,
  resolveArchitectBotSnapshot,
  HostGuardError,
  type ArchitectDeps,
} from '../src/workflows/v3/host.js';
import { readGrillState, transition } from '../src/workflows/v3/grill-state.js';
import { SPEC_SCHEMA_VERSION, type BotSnapshot } from '../src/workflows/v3/contract.js';
import { DagValidationError } from '../src/workflows/v3/dag.js';
import { loadAuthorizedV3Run, readRunEnvelope } from '../src/workflows/v3/run-envelope.js';
import { readProcessStartIdentity } from '../src/core/session-marker.js';

function base(): string {
  return mkdtempSync(join(tmpdir(), 'v3-host-'));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for child-process test condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function runTsChild(script: string): {
  exited: () => boolean;
  result: Promise<{ created: boolean; authorizedAt: string }>;
} {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let didExit = false;
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = new Promise<{ created: boolean; authorizedAt: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      didExit = true;
      if (code !== 0) {
        reject(new Error(`authorization child exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as { created: boolean; authorizedAt: string });
      } catch (err) {
        reject(new Error(`authorization child returned invalid JSON: ${stdout}\n${stderr}\n${String(err)}`));
      }
    });
  });
  return { exited: () => didExit, result };
}

function writeSpecMd(specPath: string, runId: string, title: string): void {
  const spec = {
    schemaVersion: SPEC_SCHEMA_VERSION,
    runId,
    title,
    requirement: '调研竞品出报告',
    nodes: [
      { sketchId: 'research', goal: '调研 X/Y/Z', input_needs: [], expected_outputs: ['facts.md'], acceptance: '含定价', risk_gate: false, unknowns: [] },
    ],
  };
  writeFileSync(specPath, `# Spec\n\n## 草图\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n`, 'utf-8');
}

function writeValidSpecMd(specPath: string, runId: string): void {
  writeSpecMd(specPath, runId, 'demo');
}

const DUMMY_BOT: BotSnapshot = { larkAppId: 'cli_x', cliId: 'claude-code', workingDir: '/tmp' };

describe('host — architect/default bot selection', () => {
  it('pins the invoking chat bot instead of bots.json[0] and accepts Traex/Relay', () => {
    const b = base();
    try {
      const { runDir } = hostNew({
        goal: 'g',
        baseDir: b,
        runId: 'r',
        chatBinding: {
          larkAppId: 'cli_bound',
          chatId: 'oc_1',
          rootMessageId: 'om_1',
          ownerOpenId: 'ou_1',
        },
      });
      const bots = [
        { larkAppId: 'cli_first', name: 'first', cliId: 'gemini', workingDir: '/first' },
        { larkAppId: 'cli_bound', name: 'bound', cliId: 'traex', workingDir: '/bound' },
        { larkAppId: 'cli_relay', name: 'relay', cliId: 'relay', workingDir: '/relay' },
      ] as any;
      expect(resolveArchitectBotSnapshot(runDir, bots)).toMatchObject({
        larkAppId: 'cli_bound',
        cliId: 'traex',
        workingDir: '/bound',
      });
      expect(resolveArchitectBotSnapshot(runDir, bots, 'relay')).toMatchObject({
        larkAppId: 'cli_relay',
        cliId: 'relay',
      });
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('fails fast for an explicitly selected unsupported or restricted bot', () => {
    const b = base();
    try {
      const { runDir } = hostNew({ goal: 'g', baseDir: b, runId: 'r' });
      const bots = [
        { larkAppId: 'cli_gemini', name: 'gemini', cliId: 'gemini', workingDir: '/g' },
        { larkAppId: 'cli_restricted', name: 'restricted', cliId: 'codex', workingDir: '/r', disableCliBypass: true },
      ] as any;
      expect(() => resolveArchitectBotSnapshot(runDir, bots, 'gemini'))
        .toThrow(/unsupported CLI.*supported:/);
      expect(() => resolveArchitectBotSnapshot(runDir, bots, 'restricted'))
        .toThrow(/requires CLI bypass permissions/);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
});

/** ArchitectDeps that always synthesize a valid dag (loadDag never throws). */
function okArchitectDeps(): ArchitectDeps {
  return {
    runArchitect: async (input) => ({
      status: 'ok',
      dagPath: join(input.runDir, 'architect/attempts/001/work/dag.json'),
      notesPath: join(input.runDir, 'architect/attempts/001/work/architect-notes.md'),
      manifestPath: join(input.runDir, 'architect/attempts/001/manifest.json'),
    }),
    loadDag: () => ({ runId: 'r', nodes: [] }),
    botSnapshot: DUMMY_BOT,
    resolveLarkAppSecret: () => undefined,
  };
}

/** Drive a run to spec_approved (so architect tests can start there). */
function toApprovedSpec(baseDir: string): { runDir: string; runId: string } {
  const { runDir, runId } = hostNew({ goal: 'g', baseDir, runId: 'r' });
  writeValidSpecMd(join(runDir, 'spec.md'), runId);
  hostSpecFinalize(runDir);
  hostApproveSpec(runDir);
  return { runDir, runId };
}

/** Drive a run all the way to dag_ready (so revise/approve-dag tests can start there). */
async function toDagReady(baseDir: string): Promise<{ runDir: string; runId: string }> {
  const r = toApprovedSpec(baseDir);
  await hostArchitect(r.runDir, okArchitectDeps());
  return r;
}

/** Publish the immutable Gate-2 envelope while deliberately leaving grill
 * state at dag_ready, i.e. the exact approve-dag crash window. */
function authorizeDagReadyRun(runDir: string, now = new Date('2026-07-10T08:00:00.000Z')): void {
  const state = readGrillState(runDir)!;
  if (state.status !== 'dag_ready' || !state.dagPath) throw new Error('test run is not dag_ready');
  mkdirSync(dirname(state.dagPath), { recursive: true });
  writeFileSync(state.dagPath, JSON.stringify({
    runId: state.runId,
    nodes: [{ id: 'work', type: 'goal', goal: 'do work', depends: [], inputs: [] }],
  }));
  authorizeAdHocRun(
    runDir,
    [{ larkAppId: 'cli_x', cliId: 'claude-code', workingDir: '/tmp' } as any],
    now,
  );
  expect(readGrillState(runDir)!.status).toBe('dag_ready');
}

describe('host — new / spec-finalize / approve-spec', () => {
  it('new 建 run；spec-finalize 校验通过 → spec_ready + 写 spec.json', () => {
    const b = base();
    try {
      const { runDir, runId } = hostNew({ goal: 'g', baseDir: b, runId: 'r' });
      expect(readGrillState(runDir)!.status).toBe('grilling');
      writeValidSpecMd(join(runDir, 'spec.md'), runId);
      const out = hostSpecFinalize(runDir);
      expect(out.ok).toBe(true);
      expect(out.state!.status).toBe('spec_ready');
      expect(existsSync(join(runDir, 'spec.json'))).toBe(true);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('spec-finalize：spec.md 非法 → {ok:false, problems}，状态留 grilling（阻断 handoff）', () => {
    const b = base();
    try {
      const { runDir } = hostNew({ goal: 'g', baseDir: b, runId: 'r' });
      writeFileSync(join(runDir, 'spec.md'), '# Spec\n没有 json 块', 'utf-8');
      const out = hostSpecFinalize(runDir);
      expect(out.ok).toBe(false);
      expect(out.problems!.length).toBeGreaterThan(0);
      expect(readGrillState(runDir)!.status).toBe('grilling');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('approve-spec 只能从 spec_ready', () => {
    const b = base();
    try {
      const { runDir } = hostNew({ goal: 'g', baseDir: b, runId: 'r' });
      expect(() => hostApproveSpec(runDir)).toThrow(HostGuardError);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('host — architect（codex 3 断言）', () => {
  it('断言1：非 spec_approved 跑 architect → HostGuardError', async () => {
    const b = base();
    try {
      const { runDir } = hostNew({ goal: 'g', baseDir: b, runId: 'r' });
      const deps: ArchitectDeps = {
        runArchitect: async () => { throw new Error('不该被调用'); },
        loadDag: () => ({}),
        botSnapshot: DUMMY_BOT,
        resolveLarkAppSecret: () => undefined,
      };
      await expect(hostArchitect(runDir, deps)).rejects.toThrow(HostGuardError);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('成功：runArchitect ok + loadDag ok → dag_ready 且记录 dagPath/notesPath/manifestPath（断言3）', async () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      const deps: ArchitectDeps = {
        runArchitect: async (input) => ({
          status: 'ok',
          dagPath: join(input.runDir, 'architect/attempts/001/work/dag.json'),
          notesPath: join(input.runDir, 'architect/attempts/001/work/architect-notes.md'),
          manifestPath: join(input.runDir, 'architect/attempts/001/manifest.json'),
        }),
        loadDag: () => ({ runId: 'r', nodes: [] }), // 校验通过（不抛）
        botSnapshot: DUMMY_BOT,
        resolveLarkAppSecret: () => undefined,
      };
      const out = await hostArchitect(runDir, deps);
      expect(out.ok).toBe(true);
      expect(out.state.status).toBe('dag_ready');
      expect(out.state.dagPath).toContain('dag.json');
      expect(out.state.notesPath).toContain('architect-notes.md');
      expect(out.state.architectManifestPath).toContain('manifest.json');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('断言2a：runArchitect fail → 退回 spec_approved + 记 problems，不进 dag_ready', async () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      const deps: ArchitectDeps = {
        runArchitect: async () => ({ status: 'fail', manifestPath: 'm', problems: ['architect 崩了'] }),
        loadDag: () => { throw new Error('不该到这'); },
        botSnapshot: DUMMY_BOT,
        resolveLarkAppSecret: () => undefined,
      };
      const out = await hostArchitect(runDir, deps);
      expect(out.ok).toBe(false);
      expect(out.state.status).toBe('spec_approved');
      expect(out.state.problems).toEqual(['architect 崩了']);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('runArchitect throw → 退回 spec_approved + 记 problems，不卡 architect_running', async () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      const deps: ArchitectDeps = {
        runArchitect: async () => { throw new Error('worker spawn failed'); },
        loadDag: () => { throw new Error('不该到这'); },
        botSnapshot: DUMMY_BOT,
        resolveLarkAppSecret: () => undefined,
      };
      const out = await hostArchitect(runDir, deps);
      expect(out.ok).toBe(false);
      expect(out.state.status).toBe('spec_approved');
      expect(out.state.problems).toEqual(['worker spawn failed']);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('runArchitect ok 但缺 notesPath → 退回 spec_approved', async () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      const deps: ArchitectDeps = {
        runArchitect: async (input) => ({
          status: 'ok',
          dagPath: join(input.runDir, 'architect/attempts/001/work/dag.json'),
          manifestPath: join(input.runDir, 'architect/attempts/001/manifest.json'),
        }),
        loadDag: () => { throw new Error('不该到这'); },
        botSnapshot: DUMMY_BOT,
        resolveLarkAppSecret: () => undefined,
      };
      const out = await hostArchitect(runDir, deps);
      expect(out.ok).toBe(false);
      expect(out.state.status).toBe('spec_approved');
      expect(out.state.problems).toContain('architect 未产出 architect-notes.md');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('断言2b：dagPath 出来了但 host validateDag 失败 → 退回 spec_approved + 记 validation problems', async () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      const deps: ArchitectDeps = {
        runArchitect: async (input) => ({
          status: 'ok',
          dagPath: join(input.runDir, 'dag.json'),
          notesPath: join(input.runDir, 'notes.md'),
          manifestPath: join(input.runDir, 'manifest.json'),
        }),
        loadDag: () => { throw new DagValidationError(['node "x" depends on unknown node "y"']); },
        botSnapshot: DUMMY_BOT,
        resolveLarkAppSecret: () => undefined,
      };
      const out = await hostArchitect(runDir, deps);
      expect(out.ok).toBe(false);
      expect(out.state.status).toBe('spec_approved');
      expect(out.state.problems).toContain('node "x" depends on unknown node "y"');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('并发 architect 共享 run 级 async transaction：attempt001 只启动一个 worker，竞争调用明确 busy', async () => {
    const b = base();
    let releaseWorker: () => void = () => {};
    let first: Promise<Awaited<ReturnType<typeof hostArchitect>>> | undefined;
    try {
      const { runDir } = toApprovedSpec(b);
      const workerGate = new Promise<void>((resolve) => { releaseWorker = resolve; });
      const runArchitect = vi.fn(async (input: Parameters<ArchitectDeps['runArchitect']>[0]) => {
        await workerGate;
        return {
          status: 'ok' as const,
          dagPath: join(input.runDir, 'architect/attempts/001/work/dag.json'),
          notesPath: join(input.runDir, 'architect/attempts/001/work/architect-notes.md'),
          manifestPath: join(input.runDir, 'architect/attempts/001/manifest.json'),
        };
      });
      const deps: ArchitectDeps = {
        ...okArchitectDeps(),
        runArchitect,
      };

      first = hostArchitect(runDir, deps);
      await waitUntil(() => runArchitect.mock.calls.length === 1);
      expect(readGrillState(runDir)!.status).toBe('architect_running');

      // The second call cannot enter runArchitect (and therefore cannot rm -rf
      // the shared attempt001) while the first process/call owns the file lock.
      await expect(hostArchitect(runDir, deps)).rejects.toThrow(/another workflow host mutation|\u53e6一个 workflow host mutation/);
      expect(runArchitect).toHaveBeenCalledTimes(1);
      expect(readGrillState(runDir)!.status).toBe('architect_running');

      releaseWorker();
      const out = await first;
      first = undefined;
      expect(out.ok).toBe(true);
      expect(out.state.status).toBe('dag_ready');
      expect(readGrillState(runDir)!.status).toBe('dag_ready');
      expect(runArchitect).toHaveBeenCalledTimes(1);
    } finally {
      releaseWorker();
      await first?.catch(() => undefined);
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('host — approve-dag（gate-2）', () => {
  it('run.json 已授权的 dag_ready → dag_approved，回 canonical dagPath', async () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      const deps: ArchitectDeps = {
        runArchitect: async (input) => ({
          status: 'ok',
          dagPath: join(input.runDir, 'dag.json'),
          notesPath: join(input.runDir, 'notes.md'),
          manifestPath: join(input.runDir, 'manifest.json'),
        }),
        loadDag: () => ({}),
        botSnapshot: DUMMY_BOT,
        resolveLarkAppSecret: () => undefined,
      };
      await hostArchitect(runDir, deps);
      authorizeDagReadyRun(runDir);
      const { state, dagPath } = hostApproveDag(runDir);
      expect(state.status).toBe('dag_approved');
      expect(dagPath).toBe(join(runDir, 'dag.json'));
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('非 dag_ready 时 approve-dag → HostGuardError', () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      expect(() => hostApproveDag(runDir)).toThrow(HostGuardError);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('CLI 提示走 daemon start 入口，不再建议 standalone v3 run', async () => {
    const b = base();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { runDir } = await toDagReady(b);
      const dagPath = readGrillState(runDir)!.dagPath!;
      mkdirSync(dirname(dagPath), { recursive: true });
      writeFileSync(dagPath, JSON.stringify({
        runId: 'r',
        nodes: [{ id: 'work', type: 'goal', goal: 'do work', depends: [], inputs: [] }],
      }));
      await cmdWorkflowHost('approve-dag', ['r', '--base-dir', b], {
        loadBots: () => [{ larkAppId: 'cli_x', cliId: 'claude-code', workingDir: '/tmp' } as any],
        resolveChatBinding: () => undefined,
      });
      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('botmux workflow start r');
      expect(output).not.toContain('botmux v3 run');
      expect(readRunEnvelope(runDir)).toMatchObject({ kind: 'ok' });

      // A lost-response CLI replay after dag_approved verifies the frozen
      // envelope and does not consult a now-missing/drifted bots.json.
      await expect(cmdWorkflowHost('approve-dag', ['r', '--base-dir', b], {
        loadBots: () => { throw new Error('must not load live bots on replay'); },
        resolveChatBinding: () => undefined,
      })).resolves.toBeUndefined();
      expect(readGrillState(runDir)!.status).toBe('dag_approved');
    } finally {
      log.mockRestore();
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('Gate-2 先固化 artifact + run.json，再允许转 dag_approved；重复准备幂等', async () => {
    const b = base();
    try {
      const { runDir } = await toDagReady(b);
      const dagPath = readGrillState(runDir)!.dagPath!;
      mkdirSync(dirname(dagPath), { recursive: true });
      writeFileSync(dagPath, JSON.stringify({
        runId: 'r',
        nodes: [{ id: 'work', type: 'goal', goal: 'do work', depends: [], inputs: [] }],
      }));
      const bots = [{ larkAppId: 'cli_x', cliId: 'claude-code', workingDir: '/tmp' } as any];
      const first = authorizeAdHocRun(runDir, bots, new Date('2026-07-10T08:00:00.000Z'));
      expect(first.publication.created).toBe(true);
      expect(readGrillState(runDir)!.status).toBe('dag_ready');
      expect(loadAuthorizedV3Run(runDir).botSnapshots).toMatchObject({
        '': { larkAppId: 'cli_x', cliId: 'claude-code' },
      });

      const second = authorizeAdHocRun(runDir, [], new Date('2026-07-10T09:00:00.000Z'));
      expect(second.publication.created).toBe(false);
      expect(second.envelope).toEqual(first.envelope);
      expect(hostApproveDag(runDir).state.status).toBe('dag_approved');

      // Lost-response replay after the state transition must still verify and
      // reuse the exact Gate-2 envelope, even if live bot config has drifted.
      const third = authorizeAdHocRun(runDir, [], new Date('2026-07-10T10:00:00.000Z'));
      expect(third.publication.created).toBe(false);
      expect(third.envelope).toEqual(first.envelope);
      expect(hostApproveDag(runDir).state.status).toBe('dag_approved');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('Gate-2 commit 后若崩在 dag_ready，所有改稿/重编排 fail-closed，replay 只完成 dag_approved transition', async () => {
    const b = base();
    try {
      const { runDir, runId } = await toDagReady(b);
      authorizeDagReadyRun(runDir);
      const committedState = readGrillState(runDir)!;
      const committedDag = readFileSync(join(runDir, 'dag.json'), 'utf-8');
      const committedSpec = readFileSync(join(runDir, 'spec.json'), 'utf-8');
      const runArchitect = vi.fn(okArchitectDeps().runArchitect);

      // Even a newly edited narrative cannot make finalize overwrite the
      // digest-pinned canonical spec after the Gate-2 commit marker exists.
      writeSpecMd(join(runDir, 'spec.md'), runId, '不应被固化的新版');
      expect(() => hostSpecFinalize(runDir)).toThrow(/run\.json 已发布/);
      expect(() => hostApproveSpec(runDir)).toThrow(/run\.json 已发布/);
      expect(() => hostReviseSpec(runDir)).toThrow(/run\.json 已发布/);
      expect(() => hostReviseDag(runDir)).toThrow(/run\.json 已发布/);
      await expect(hostArchitect(runDir, {
        ...okArchitectDeps(),
        runArchitect,
      })).rejects.toThrow(/run\.json 已发布/);

      expect(runArchitect).not.toHaveBeenCalled();
      expect(readGrillState(runDir)).toEqual(committedState);
      expect(readFileSync(join(runDir, 'dag.json'), 'utf-8')).toBe(committedDag);
      expect(readFileSync(join(runDir, 'spec.json'), 'utf-8')).toBe(committedSpec);
      expect(loadAuthorizedV3Run(runDir, { allowedSources: ['ad_hoc'] }).dag.runId).toBe(runId);

      // approve-dag replay recognizes the existing commit and only finishes
      // the durable conversation-state transition.
      expect(hostApproveDag(runDir).state.status).toBe('dag_approved');
      expect(hostApproveDag(runDir).state.status).toBe('dag_approved');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('Gate-2 把省略 bot 的节点钉到 grill 出生 bot，而不是 bots.json[0]', async () => {
    const b = base();
    try {
      const binding = {
        larkAppId: 'cli_bound',
        chatId: 'oc_1',
        rootMessageId: 'om_1',
        ownerOpenId: 'ou_1',
      };
      const { runDir, runId } = hostNew({ goal: 'g', baseDir: b, runId: 'r', chatBinding: binding });
      writeValidSpecMd(join(runDir, 'spec.md'), runId);
      hostSpecFinalize(runDir);
      hostApproveSpec(runDir);
      await hostArchitect(runDir, okArchitectDeps());
      const dagPath = readGrillState(runDir)!.dagPath!;
      mkdirSync(dirname(dagPath), { recursive: true });
      writeFileSync(dagPath, JSON.stringify({
        runId: 'r',
        nodes: [{ id: 'work', type: 'goal', goal: 'do work', depends: [], inputs: [] }],
      }));
      authorizeAdHocRun(runDir, [
        { larkAppId: 'cli_first', cliId: 'claude-code', workingDir: '/first' },
        { larkAppId: 'cli_bound', cliId: 'traex', workingDir: '/bound' },
      ] as any);
      expect(loadAuthorizedV3Run(runDir).botSnapshots).toMatchObject({
        '': { larkAppId: 'cli_bound', cliId: 'traex', workingDir: '/bound' },
      });
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('并发 Gate-2 授权在同一 run.json 锁内串行，只发布一份可验证 envelope', { timeout: 20_000 }, async () => {
    const b = base();
    try {
      const { runDir } = await toDagReady(b);
      const dagPath = readGrillState(runDir)!.dagPath!;
      mkdirSync(dirname(dagPath), { recursive: true });
      writeFileSync(dagPath, JSON.stringify({
        runId: 'r',
        nodes: [{ id: 'work', type: 'goal', goal: 'do work', depends: [], inputs: [] }],
      }));

      // Hold the exact advisory lock before starting both processes. This is a
      // deterministic assertion that neither process can perform artifact
      // writes merely because run.json itself is still absent.
      const lockPath = join(runDir, 'run.json.lock');
      writeFileSync(lockPath, String(process.pid));
      const hostUrl = pathToFileURL(join(process.cwd(), 'src/workflows/v3/host.ts')).href;
      const bots = [{ larkAppId: 'cli_x', cliId: 'claude-code', workingDir: '/tmp' }];
      const children = ['2026-07-10T08:00:00.000Z', '2026-07-10T09:00:00.000Z'].map((authorizedAt, i) => {
        const readyPath = join(b, `child-${i}.ready`);
        return {
          readyPath,
          child: runTsChild(`
            import { writeFileSync } from 'node:fs';
            import { authorizeAdHocRun } from ${JSON.stringify(hostUrl)};
            writeFileSync(${JSON.stringify(readyPath)}, 'ready');
            const result = authorizeAdHocRun(
              ${JSON.stringify(runDir)},
              ${JSON.stringify(bots)},
              new Date(${JSON.stringify(authorizedAt)}),
            );
            process.stdout.write(JSON.stringify({
              created: result.publication.created,
              authorizedAt: result.envelope.authorization.authorizedAt,
            }));
          `),
        };
      });

      await waitUntil(() => children.every(({ readyPath }) => existsSync(readyPath)));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(children.every(({ child }) => !child.exited())).toBe(true);
      expect(existsSync(join(runDir, 'run.json'))).toBe(false);

      unlinkSync(lockPath);
      const results = await Promise.all(children.map(({ child }) => child.result));
      expect(results.map((result) => result.created).sort()).toEqual([false, true]);
      expect(new Set(results.map((result) => result.authorizedAt)).size).toBe(1);
      expect(loadAuthorizedV3Run(runDir, { allowedSources: ['ad_hoc'] }).dag.runId).toBe('r');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('host — spec-finalize 状态守卫（先 guard 后写）', () => {
  it('spec_ready 可原地重定稿（Gate-1 改稿自环），spec.json 更新成新内容', () => {
    const b = base();
    try {
      const { runDir, runId } = hostNew({ goal: 'g', baseDir: b, runId: 'r' });
      writeSpecMd(join(runDir, 'spec.md'), runId, '初稿');
      expect(hostSpecFinalize(runDir).state!.status).toBe('spec_ready');
      // 用户在 Gate-1 改需求 → 改 spec.md 重新 finalize
      writeSpecMd(join(runDir, 'spec.md'), runId, '改后');
      const out = hostSpecFinalize(runDir);
      expect(out.ok).toBe(true);
      expect(out.state!.status).toBe('spec_ready');
      expect(readFileSync(join(runDir, 'spec.json'), 'utf-8')).toContain('改后');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('spec_approved 状态下 finalize 被拒，且 spec.json 不被覆盖（先 guard 后写）', () => {
    const b = base();
    try {
      const { runDir, runId } = toApprovedSpec(b); // spec.json 此刻 title=demo
      const before = readFileSync(join(runDir, 'spec.json'), 'utf-8');
      // 若 finalize 误执行，会把 spec.json 覆盖成新 title
      writeSpecMd(join(runDir, 'spec.md'), runId, '不该被写入');
      expect(() => hostSpecFinalize(runDir)).toThrow(HostGuardError);
      expect(readFileSync(join(runDir, 'spec.json'), 'utf-8')).toBe(before);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('host — architect 崩溃恢复', () => {
  it('上次 architect 写了 architect_running 后崩溃 → 重跑 architect 能恢复到 dag_ready（不卡死）', async () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      // 模拟中断：状态停在 architect_running（进程在 await 中被 kill）
      transition(runDir, 'architect_running');
      expect(readGrillState(runDir)!.status).toBe('architect_running');
      const out = await hostArchitect(runDir, okArchitectDeps());
      expect(out.ok).toBe(true);
      expect(out.state.status).toBe('dag_ready');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('host — 改稿（revise-spec / revise-dag）', () => {
  it('revise-spec：dag_ready → grilling，并清掉 stale 的 dag 产物', async () => {
    const b = base();
    try {
      const { runDir } = await toDagReady(b);
      expect(readGrillState(runDir)!.dagPath).toBeDefined();
      const state = hostReviseSpec(runDir);
      expect(state.status).toBe('grilling');
      expect(state.dagPath).toBeUndefined();
      expect(state.notesPath).toBeUndefined();
      expect(state.architectManifestPath).toBeUndefined();
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('revise-spec 在 grilling（无可退）/ dag_approved（已交 runtime）被拒', async () => {
    const b = base();
    const b2 = base();
    try {
      const { runDir } = hostNew({ goal: 'g', baseDir: b, runId: 'r' });
      expect(() => hostReviseSpec(runDir)).toThrow(HostGuardError); // grilling
      const { runDir: rd2 } = await toDagReady(b2);
      authorizeDagReadyRun(rd2);
      hostApproveDag(rd2);
      expect(() => hostReviseSpec(rd2)).toThrow(HostGuardError); // dag_approved
    } finally {
      rmSync(b, { recursive: true, force: true });
      rmSync(b2, { recursive: true, force: true });
    }
  });

  it('revise-dag：dag_ready → spec_approved，清掉 dag 产物，可重跑 architect 重编', async () => {
    const b = base();
    try {
      const { runDir } = await toDagReady(b);
      const state = hostReviseDag(runDir);
      expect(state.status).toBe('spec_approved');
      expect(state.dagPath).toBeUndefined();
      // 需求不变，重跑 architect 应再次成功
      const out = await hostArchitect(runDir, okArchitectDeps());
      expect(out.ok).toBe(true);
      expect(out.state.status).toBe('dag_ready');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('revise-dag 在非 dag_ready 被拒', () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b); // spec_approved
      expect(() => hostReviseDag(runDir)).toThrow(HostGuardError);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('host — CLI runId 越界守卫', () => {
  it('非法 runId（路径穿越）在 dispatch 入口被拒', async () => {
    const b = base();
    try {
      await expect(cmdWorkflowHost('approve-spec', ['../escape', '--base-dir', b])).rejects.toThrow(/非法 runId/);
      await expect(cmdWorkflowHost('revise-spec', ['a/b', '--base-dir', b])).rejects.toThrow(/非法 runId/);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('host — 非 new 变更命令 caller 归属守卫', () => {
  const boundCaller = {
    larkAppId: 'cli_real',
    chatId: 'oc_real',
    rootMessageId: 'om_real',
    sessionId: 'sess-1',
    ownerOpenId: 'ou_caller_b',
  };

  it('caller/chat/bot 全匹配才允许 finalize', async () => {
    const b = base();
    try {
      const { runDir, state } = hostNew({ goal: 'demo', baseDir: b, runId: 'r', chatBinding: boundCaller });
      writeValidSpecMd(state.specPath, 'r');
      await expect(cmdWorkflowHost('spec-finalize', ['r', '--base-dir', b], {
        resolveChatBinding: () => ({ ...boundCaller }),
      })).resolves.toBeUndefined();
      expect(readGrillState(runDir)?.status).toBe('spec_ready');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it.each([
    ['caller', { ...boundCaller, ownerOpenId: 'ou_owner_a' }],
    ['chat', { ...boundCaller, chatId: 'oc_other' }],
    ['bot', { ...boundCaller, larkAppId: 'cli_other' }],
  ])('%s 不匹配时在写 spec.json 前 fail closed', async (_field, current) => {
    const b = base();
    try {
      const { runDir, state } = hostNew({ goal: 'demo', baseDir: b, runId: 'r', chatBinding: boundCaller });
      writeValidSpecMd(state.specPath, 'r');
      await expect(cmdWorkflowHost('spec-finalize', ['r', '--base-dir', b], {
        resolveChatBinding: () => current,
      })).rejects.toThrow(/不匹配/);
      expect(readGrillState(runDir)?.status).toBe('grilling');
      expect(existsSync(join(runDir, 'spec.json'))).toBe(false);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('standalone dev 的 unbound run 继续可用', async () => {
    const b = base();
    try {
      const { state } = hostNew({ goal: 'demo', baseDir: b, runId: 'r' });
      writeValidSpecMd(state.specPath, 'r');
      await expect(cmdWorkflowHost('spec-finalize', ['r', '--base-dir', b], {
        resolveChatBinding: () => undefined,
      })).resolves.toBeUndefined();
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('authenticated chat caller 不能接管 standalone unbound run', async () => {
    const b = base();
    try {
      const { runDir, state } = hostNew({ goal: 'demo', baseDir: b, runId: 'r' });
      writeValidSpecMd(state.specPath, 'r');
      await expect(cmdWorkflowHost('spec-finalize', ['r', '--base-dir', b], {
        resolveChatBinding: () => ({ ...boundCaller }),
      })).rejects.toThrow(/standalone\/dev run.*不能从 botmux chat turn 修改/);
      expect(readGrillState(runDir)?.status).toBe('grilling');
      expect(existsSync(join(runDir, 'spec.json'))).toBe(false);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('host — chatBindingFromEnv（grill 出生落话题绑定）', () => {
  it('in-session → 用 fresh turn + 磁盘 lastCaller，静态 owner/env 路由均不可信', () => {
    const dataDir = base();
    try {
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      const procStart = readProcessStartIdentity(process.pid);
      if (!procStart) throw new Error('test process start identity unavailable');
      writeFileSync(
        join(dataDir, '.botmux-cli-pids', String(process.pid)),
        JSON.stringify({ sessionId: 'sess-1', turnId: 'turn-current', procStart }),
      );
      writeFileSync(join(dataDir, 'sessions-cli_real.json'), JSON.stringify({
        'sess-1': {
          sessionId: 'sess-1', status: 'active', scope: 'thread',
          larkAppId: 'cli_real', chatId: 'oc_real', rootMessageId: 'om_real',
          ownerOpenId: 'ou_owner_a', lastCallerOpenId: 'ou_caller_b', quoteTargetId: 'turn-current',
        },
      }));

      expect(chatBindingFromEnv({
        SESSION_DATA_DIR: dataDir,
        BOTMUX_LARK_APP_ID: 'cli_stale',
        BOTMUX_CHAT_ID: 'oc_stale',
        BOTMUX_ROOT_MESSAGE_ID: 'om_stale',
        BOTMUX_SESSION_ID: 'sess-1',
        BOTMUX_OWNER_OPEN_ID: 'ou_owner_a',
      } as NodeJS.ProcessEnv, process.pid)).toEqual({
        larkAppId: 'cli_real', chatId: 'oc_real', rootMessageId: 'om_real',
        sessionId: 'sess-1', ownerOpenId: 'ou_caller_b',
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('standalone/dev → 保留最小 binding，但绝不把静态 BOTMUX_OWNER 当 caller', () => {
    expect(chatBindingFromEnv({
      BOTMUX_LARK_APP_ID: 'cli_abc', BOTMUX_CHAT_ID: 'oc_chat', BOTMUX_OWNER_OPEN_ID: 'ou_static',
    } as NodeJS.ProcessEnv, process.pid)).toEqual({ larkAppId: 'cli_abc', chatId: 'oc_chat' });
  });

  it('stale/detached in-session command → fail closed', () => {
    const dataDir = base();
    try {
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      const procStart = readProcessStartIdentity(process.pid);
      if (!procStart) throw new Error('test process start identity unavailable');
      writeFileSync(
        join(dataDir, '.botmux-cli-pids', String(process.pid)),
        JSON.stringify({ sessionId: 'sess-1', turnId: 'turn-old', procStart }),
      );
      writeFileSync(join(dataDir, 'sessions-cli_real.json'), JSON.stringify({
        'sess-1': {
          sessionId: 'sess-1', status: 'active', scope: 'thread',
          larkAppId: 'cli_real', chatId: 'oc_real', rootMessageId: 'om_real',
          lastCallerOpenId: 'ou_caller_b', quoteTargetId: 'turn-new',
        },
      }));
      expect(() => chatBindingFromEnv({
        SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: 'sess-1', BOTMUX_OWNER_OPEN_ID: 'ou_owner_a',
      } as NodeJS.ProcessEnv, process.pid)).toThrow(/turn-old.*turn-new/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('缺 larkAppId 或 chatId（CLI/dev，非 worker）→ undefined', () => {
    expect(chatBindingFromEnv({ BOTMUX_CHAT_ID: 'oc_chat' } as NodeJS.ProcessEnv, process.pid)).toBeUndefined();
    expect(chatBindingFromEnv({ BOTMUX_LARK_APP_ID: 'cli_abc' } as NodeJS.ProcessEnv, process.pid)).toBeUndefined();
    expect(chatBindingFromEnv({} as NodeJS.ProcessEnv, process.pid)).toBeUndefined();
  });
});
